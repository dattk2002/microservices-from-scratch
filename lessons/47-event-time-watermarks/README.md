# 47 — Event-time, cửa sổ tumbling và watermark từ nhiều partition

Bài học tạo hai tiến trình Node.js: aggregator sở hữu SQLite; reader lấy một snapshot đầy đủ qua HTTP rồi kiểm tra hợp đồng trước khi công bố. Không dùng đồng hồ thực để đóng cửa sổ, không cần broker, credentials hay thư viện runtime. Cần Node **24.12+ thuộc dòng 24**, npm và các gói phát triển đã cài ở root. Nên đọc bài 05 (idempotency), 15 (read model) và 37 (partition ordering).

## Ba loại thời gian

**Event-time** là thời điểm nghiệp vụ do producer ghi vào sự kiện. **Ingestion time** là lúc hệ thống tiếp nhận; **processing time** là lúc handler xử lý. Một phép đo tại mốc 9 có thể đến sau phép đo tại mốc 10. Gom theo thời gian xử lý sẽ đổi kết quả khi replay hoặc mạng chậm; bài này gom theo `time` của sự kiện.

Miền thời gian hữu hạn 0..99 chia thành mười cửa sổ tumbling không chồng lấn: `[0,10)`, `[10,20)`, …, `[90,100)`. Mốc 9 thuộc cửa sổ đầu, mốc 10 thuộc cửa sổ thứ hai. `value` là số đo nguyên 1..100; mỗi cửa sổ giữ `count` và `sum`.

Watermark là tuyên bố tiến độ logic của producer, không phải timestamp lớn nhất từng nhận. Hai partition cố định `a`, `b` bắt đầu tại 0. Watermark toàn cục là `min(a,b)`. Khi `a=30`, `b=9`, toàn cục vẫn là 9: cửa sổ đầu chưa đóng. Khi `b=10`, cửa sổ đầu đóng đúng tại end=10. Partition im lặng giữ nguyên watermark và **chặn tiến độ**, dù thời gian thực trôi qua bao lâu. Không có tự động phát hiện idle.

Producer phải phối hợp watermark với mọi sự kiện đang truyền, retry, hoặc chờ trong hàng đợi. Nếu tuyên bố tiến độ quá sớm, hệ thống có thể từ chối dữ liệu hợp lệ đến sau. Tiến độ dè dặt tăng độ đầy đủ nhưng làm kết quả cuối đến chậm; tiến độ mạnh tay giảm độ trễ nhưng tăng nguy cơ thiếu dữ liệu.

## Chính sách đóng cửa sổ chính xác

Sự kiện mới bị từ chối nếu **end của cửa sổ <= watermark toàn cục**. Không so trực tiếp `event.time < watermark` để từ chối. Ví dụ toàn cục=9 vẫn nhận sự kiện time=0 vì end=10 chưa đóng. Khi toàn cục=10, sự kiện mới time=9 bị 409. Cửa sổ chưa từng có dữ liệu cũng chịu quy tắc này. Không tạo cửa sổ rỗng; không sửa kết quả sau đóng, không có allowed lateness hay correction.

Receipt là dữ liệu bất biến `{id,partition,time,value,start,end}`. Retry cùng id và cùng payload trả nguyên receipt ban đầu, kể cả sau khi đóng cửa sổ hoặc đạt capacity. Đổi một trường cùng id nhận 409. Kiểm tra replay diễn ra trước kiểm tra late/capacity. Không lưu `count`/`sum` đang thay đổi vào receipt.

## Chạy từ repository root

Terminal thứ nhất (chọn thư mục dữ liệu có quyền ghi):

```bash
DB_PATH=/tmp/lesson47.sqlite HOST=127.0.0.1 PORT=4740 node lessons/47-event-time-watermarks/aggregator.mts
```

Terminal thứ hai:

```bash
AGGREGATOR_ORIGIN=http://127.0.0.1:4740 HOST=127.0.0.1 PORT=4741 node lessons/47-event-time-watermarks/reader.mts
```

`DB_PATH` bắt buộc; không đổi file khi muốn kiểm chứng restart. Reader mặc định upstream `http://127.0.0.1:4740`; origin phải là HTTP, không credentials, path phụ, query hay fragment. `HOST` mặc định loopback. `PORT=0` được hỗ trợ: mỗi tiến trình in một dòng JSON `{service,port}` sau khi bind. Các biến cấu hình chỉ đọc trong `main`; import không mở SQLite, đọc cấu hình, nghe cổng hay đăng ký signal. SIGTERM/SIGINT đóng server; aggregator đóng database khi server đóng.

Ví dụ dữ liệu gốc cho cảm biến ở hai partition:

```bash
curl -s http://127.0.0.1:4740/events -H 'content-type: application/json' -d '{"id":"probe-9","partition":"a","time":9,"value":7}'
curl -s http://127.0.0.1:4740/events -H 'content-type: application/json' -d '{"id":"probe-10","partition":"b","time":10,"value":2}'
curl -s http://127.0.0.1:4740/watermarks -H 'content-type: application/json' -d '{"partition":"a","time":20}'
curl -s http://127.0.0.1:4741/windows
curl -s http://127.0.0.1:4740/watermarks -H 'content-type: application/json' -d '{"partition":"b","time":9}'
curl -s http://127.0.0.1:4740/events -H 'content-type: application/json' -d '{"id":"delayed-0","partition":"a","time":0,"value":5}'
curl -s http://127.0.0.1:4740/watermarks -H 'content-type: application/json' -d '{"partition":"b","time":10}'
curl -s http://127.0.0.1:4741/windows
```

Kết quả cuối có global=10, `[0,10)` count=2 sum=12 finalized=true; `[10,20)` count=1 sum=2 finalized=false. Gửi id mới time=9 nhận 409; gửi lại nguyên `probe-9` nhận receipt cũ. Dừng và chạy lại aggregator với cùng DB_PATH để kiểm chứng độ bền.

## Hợp đồng HTTP

| Route | Thành công | Kiểm tra và lỗi |
| --- | --- | --- |
| `POST /events` | 200 receipt | `id` chuỗi URL-safe `[A-Za-z0-9_-]`, 1..32 ký tự; partition chuỗi chính xác a/b; time nguyên 0..99; value nguyên 1..100. 409 khi id xung đột, cửa sổ đã đóng hoặc hết receipt. |
| `POST /watermarks` | 200 snapshot | partition a/b; time nguyên 0..100. Giảm so với chính partition đó nhận 409; cùng giá trị thành công, không tác dụng thêm. |
| `GET /state` | 200 snapshot | `{partitions:{a,b},global,receipts,windows}`; windows tăng dần theo start. |
| `GET /windows` trên reader | 200 `{global,windows}` | Một lần đọc upstream `/state`; lỗi status, schema, JSON, quá byte, redirect hoặc deadline nhận 502, không trả kết quả từng phần. |

Mỗi window có `{start,end,count,sum,finalized}`. JSON POST phải là object, không null, array hay boolean; trường sai primitive trả 400 trước khi dùng enum. Trường dư không tham gia nghiệp vụ. JSON hỏng 400, sai content-type 415, body trên **8192 byte** 413. Route/method không được khai báo trả 404. Dạng lỗi `{error:{code,message}}`.

Reader không nhận URL từ caller; query ở `/windows` cũng không hợp lệ. Fetch dùng `redirect:'error'` ngay cả khi Location trỏ cùng origin. Deadline **700 ms** bao trùm cả nhận body; response bị chặn ở 8192 byte trước parse. Reader kiểm tra đủ a/b, miền integer, global=min, tối đa 16 receipt, tối đa 10 cửa sổ, start duy nhất có thứ tự và chia hết cho 10, end=start+10, count 1..16, count<=sum<=100*count, tổng count=receipts và finalized chính xác theo end/global. Một window sai làm toàn snapshot thất bại.

Ngân sách byte không suy ra từ JSON compact: id dài nhất có thể dùng 32 escape `\u005f`, tốn 192 byte. Với tất cả key/chuỗi của request được escape sáu byte mỗi ký tự, request hợp lệ đầy đủ vẫn dưới 512 byte. Snapshot mười window với mọi key/partition escape, số nguyên lớn nhất và cờ boolean vẫn dưới 4096 byte; 8192 có dư địa. Whitespace và trường dư vẫn tính vào giới hạn. Test gửi id dài escape và snapshot escape; fixture oversized dùng JSON/schema hợp lệ với thêm whitespace, để thực sự kiểm chứng byte gate.

## Ranh giới transaction và kiến trúc

```text
producer a,b --> aggregator --> SQLite (progress, windows, receipts)
                                  ^
reader -- GET /state -------------|
caller <-- GET /windows -- reader
```

Aggregator là chủ duy nhất của file SQLite. `BEGIN IMMEDIATE` bao quanh kiểm tra replay, chính sách late/capacity, upsert count/sum và insert receipt. Bất kỳ lỗi nào rollback toàn bộ, không nhận receipt mà thiếu tổng hợp hoặc ngược lại. Transaction watermark cập nhật tiến độ và finalize mọi cửa sổ hiện có có end<=global cùng lúc. SQLite WAL + synchronous FULL lưu cả ranh giới cửa sổ, cờ và receipt qua restart. Một tiến trình writer thực hiện thao tác đồng bộ, không có await bên trong transaction.

Giới hạn **16 receipt, 10 cửa sổ**, không eviction, không retention job. Window thứ 11 không thể xuất hiện vì miền thời gian chỉ có mười start hợp lệ. Receipt thứ 17 trả 409, trạng thái không đổi. Giữ dedup phải bao phủ toàn bộ khoảng replay: xóa receipt sớm cho phép cùng sự kiện được tính hai lần trong cửa sổ mở, hoặc mất khả năng replay thành công sau đóng. Muốn sản xuất thật cần thiết kế retention, checkpoint, khôi phục và backpressure cùng nhau.

Đây là mô hình giảng dạy hữu hạn, không tương thích Apache Flink; không có distributed checkpoint, đổi partition, xác thực, nhiều writer, watermark generation tự động, event eviction hoặc late correction. Producer và caller trong demo được tin cậy. Không dùng exposure Internet cho server này. Không có teaching-control route trong ứng dụng; `test/upstream.mts` là fixture riêng, chỉ chạy khi `TEACHING_CONTROLS=1`, dành cho kiểm thử cục bộ.

## Kiểm thử

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/47-event-time-watermarks/test/lesson.test.mts
node --test --test-timeout=15000 lessons/47-event-time-watermarks/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite `:memory:` và tiến độ logic, không sleep. Test HTTP chạy các child process độc lập, cổng loopback ephemeral, deadline từng request; file SQLite đặt trong `node:os.tmpdir()` và xóa trong finally, dùng được khi source chỉ đọc. Fixture upstream dùng chung với control kiểm tra schema nghiêm ngặt và reset counter mỗi case; counter chứng minh mỗi request đọc một lần và redirect target ở một tiến trình/origin khác không bị gọi. Slow fixture gửi JSON hợp lệ nhưng giữ stream mở để kiểm chứng deadline body. Test import chạy child với cấu hình cố ý hỏng và yêu cầu exit thành công, stdout/stderr rỗng.

Worker không có network chỉ chạy typecheck/unit; controller phải chạy kiểm thử HTTP và các kiểm tra đầy đủ trong môi trường cách ly. Không suy ra HTTP pass từ unit pass.

## Bài tập

1. Dự đoán cửa sổ mở khi a=100, b=19; thử time=10, time=9 rồi b=20. Giải thích bằng end thay vì timestamp.
2. Producer b ngừng gửi nhưng vẫn còn một retry trong hàng đợi: điều gì sai nếu tự nâng watermark theo đồng hồ máy?
3. Thiết kế receipt retention hữu hạn mà vẫn có hợp đồng replay rõ ràng. Caller cần biết điều gì khi receipt hết hạn?
4. Nếu thêm correction sau đóng, reader và downstream phải đổi hợp đồng thế nào để phân biệt kết quả cuối với bản sửa?

Nguồn chính thức để đối chiếu khái niệm: [Apache Flink — Time and Watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/). Bài này dùng quy tắc đóng cửa sổ đã mô tả riêng, không sao chép toàn bộ semantics của Flink.
