# 46 — Timer lưu bền, đến hạn, hủy và khôi phục giao nhận không chắc chắn

Một yêu cầu “cộng 7 khi đến giây 101” phải sống lâu hơn tiến trình nhận nó.
`setTimeout` chỉ giữ callback trong bộ nhớ; khởi động lại làm mất callback. Bài này
lưu **mốc Unix tuyệt đối và trạng thái** vào SQLite, rồi quét bằng một HTTP request
chủ động. Không gửi lời nhắc, tin nhắn, thanh toán hay gọi tích hợp bên ngoài.

## Chuẩn bị và chạy

Cần Node.js **24.12+ (<25)** có `node:sqlite`, npm và các gói phát triển đã cài
ở gốc repository. Runtime chỉ dùng built-in. Chạy từ gốc repository, hai terminal:

```sh
DB_PATH=/tmp/lesson46-receiver.sqlite HOST=127.0.0.1 PORT=4647 \
  TEACHING_CONTROLS=1 node lessons/46-durable-timers/receiver.mts
```

```sh
DB_PATH=/tmp/lesson46-scheduler.sqlite RECEIVER_ORIGIN=http://127.0.0.1:4647 \
  HOST=127.0.0.1 PORT=4646 TEACHING_CONTROLS=1 TEACHING_EPOCH_SECONDS=100 \
  node lessons/46-durable-timers/scheduler.mts
```

Mỗi service phải dùng **DB_PATH riêng**, không chia sẻ file. Thư mục cha phải tồn
tại. Giữ file để thử restart; dùng tên mới để bắt đầu một ví dụ sạch. `PORT=0` được
hỗ trợ: dòng JSON `{service,port}` trên stdout báo cổng thực cho fixture/Playground.
`HOST` mặc định `127.0.0.1`. Cổng mặc định scheduler 4646, receiver 4647.

```sh
curl -s http://127.0.0.1:4646/timers -H 'content-type: application/json' \
  -d '{"id":"lot-7","dueAt":101,"value":7}'
curl -s http://127.0.0.1:4646/dispatch -H 'content-type: application/json' -d '{}'
# {"dispatched":false}: hiện tại vẫn là 100
curl -s http://127.0.0.1:4646/teaching/advance -H 'content-type: application/json' -d '{"seconds":1}'
curl -s http://127.0.0.1:4647/teaching/failure -H 'content-type: application/json' -d '{"afterCommit":true}'
curl -s http://127.0.0.1:4646/dispatch -H 'content-type: application/json' -d '{}'
# uncertain, attempts=1; receiver đã cộng 7 nhưng trả 503
curl -s http://127.0.0.1:4646/dispatch -H 'content-type: application/json' -d '{}'
# delivered, attempts=2; receipt trùng được ack, total vẫn là 7
curl -s http://127.0.0.1:4647/state
```

Dừng scheduler trước giây đến hạn, khởi động lại với cùng DB và epoch: timer vẫn
pending. Không có lời gọi tự phát khi restart. Gọi `advance` rồi `dispatch` để
quan sát chuyển trạng thái. Offset dạy học nằm trong RAM và reset khi restart;
DB không lưu offset. Muốn tiếp tục đúng mốc mô phỏng, truyền epoch mới tường minh.

## Hợp đồng và giới hạn

Mọi POST dùng `Content-Type: application/json`. Primitive sai kiểu, `null`, array,
boolean ở top-level trả **400**; không ép string thành số/boolean. JSON hỏng 400,
media type sai 415, body quá **8192 byte** trả 413. Đường dẫn/phương thức không có
route trả 404. Lỗi trạng thái, danh tính hoặc dung lượng trả 409.

| Scheduler | Kết quả |
| --- | --- |
| `POST /timers {id,dueAt,value}` | 200 timer; tạo mới pending, attempts=0. Replay đúng toàn bộ metadata trả trạng thái hiện tại; đổi dueAt/value 409. |
| `GET /timers/:id` | 200 timer hoặc 404. |
| `GET /state` | `{now,busy,timers}`; tối đa 16 timer, sắp dueAt rồi id theo thứ tự ASCII của SQLite. |
| `POST /dispatch {}` | Chọn duy nhất timer đủ hạn cũ nhất; trả `{dispatched:true,id,dueAt,value,state,attempts}`. Không có việc trả `{dispatched:false}`. Dispatch đang hoạt động trả 409. |
| `POST /timers/:id/cancel {}` | 200 cancelled nếu pending chưa từng thử hoặc đã cancelled; chưa có id 404; đã thử/delivered/exhausted 409. |
| `POST /teaching/advance {seconds}` | Chỉ khi controls bật: số nguyên 1..60, tổng offset không quá 3600; lỗi 400. |

`id` gồm ASCII `A-Z a-z 0-9 _ -`, dài 1..32; `dueAt` là số nguyên an toàn Unix
**giây**, 0..2147483647; `value` nguyên 1..100. Không dùng mili giây. Timer kết thúc
vẫn chiếm chỗ trong giới hạn 16: xóa chúng sẽ làm replay đổi nghĩa. GET không tự
chọn hay thử lại công việc. Timer tương lai không chặn timer khác đã đến hạn.

| Receiver | Kết quả |
| --- | --- |
| `POST /fire {id,value}` | 200 `{id,duplicate,total}`; commit receipt mới và hiệu ứng cộng value trong cùng transaction. Replay cùng id/value không cộng lại; đổi value 409. |
| `GET /state` | `{receipts,total}`, tối đa 16 receipt sắp theo id; total 0..1600. |
| `POST /teaching/failure {afterCommit}` | Chỉ khi controls bật, boolean thật. Khi true, receipt **mới** vẫn commit nhưng trả 503; receipt trùng luôn được ack bình thường. |

`TEACHING_CONTROLS` chỉ được bỏ trống hoặc đặt `1`. Các route dạy học trả 404 khi
không bật. Chúng chỉ dành cho thực hành local, không có xác thực. Scheduler dùng
thời gian Unix thật mặc định. `TEACHING_EPOCH_SECONDS` nguyên 0..2147483647 chỉ hợp
lệ khi controls bật; cấu hình cố định âm thầm ở chế độ bình thường bị từ chối lúc
startup. Cấu hình môi trường sai làm startup thất bại, khác với lỗi HTTP 400.

`RECEIVER_ORIGIN` bắt buộc, là origin HTTP(S) không credentials, query, fragment hay
path; đích cố định `/fire`. `redirect:'error'` cấm chuyển tiếp payload qua redirect.
`DELIVERY_TIMEOUT_MS` nguyên 50..2000, mặc định 500, bao phủ kết nối, headers và toàn
bộ body. Ack tối đa **1024 byte**; phải là object có đúng id đang gửi, duplicate
boolean, total nguyên từ value đang gửi đến 1600. Không lưu delivered trước khi
runtime validation hoàn tất. Ack thừa whitespace hợp lệ vượt ngân sách vẫn bị
loại; fixture oversized dùng JSON/schema/id đúng để kiểm tra riêng byte gate.

Ngân sách nhận tính cả escaping: 32 ký tự id viết bằng `\uXXXX` chiếm 192 byte;
body tạo timer với key thường và số cực đại là 232 byte. Ngay cả escape mọi chữ
trong key `id/dueAt/value` vẫn dưới 300 byte; 8192 dư cho representation JSON hợp
lệ nhưng hữu hạn. Ack có id escape tối đa 192 byte và key escape vẫn dưới 400
byte, nhỏ hơn 1024. Whitespace tùy ý không có quyền làm body vô hạn. Test gửi id
32 ký tự escape, dueAt cực đại và value=100 qua HTTP thật.

## Kiến trúc và cửa sổ lỗi

```text
caller → scheduler → SQLite timers (dueAt, state, attempts)
           │ POST /dispatch, commit attempt trước I/O
           └── POST /fire → receiver → SQLite receipts (id, value)
                                  receipt + total, cùng transaction
```

`pending → uncertain → delivered`; thất bại giữ uncertain đến lần thử thứ tư rồi
`exhausted`. `pending` chưa thử có nhánh `cancelled`. Selection, admission và cancel
là thao tác đồng bộ trên cùng event loop và transaction `BEGIN IMMEDIATE`, không
có `await` ở giữa. Parsing body diễn ra trước; thứ tự quyết định là thứ tự hoàn
tất parsing, không phải thứ tự TCP tới. Sau khi dispatch đặt busy và commit attempt,
cancel nhìn thấy uncertain và không được hứa hủy một hiệu ứng có thể đang chạy.
Chỉ một dispatch toàn cục **trong một scheduler process**; không chạy nhiều replica
trên cùng DB. SQLite WAL và synchronous FULL bảo vệ commit theo bảo đảm của storage.

1. Chết trước commit attempt: timer chưa bị chọn, lần quét sau vẫn thử được.
2. Chết sau commit attempt nhưng trước send: uncertain dù receiver có thể chưa nhận.
3. Receiver commit rồi mất/error reply: uncertain dù total đã tăng.
4. Ack hợp lệ nhưng scheduler chết trước commit delivered: retry có thể lặp request,
   receiver dedup không lặp hiệu ứng.
5. Chết trong lần thứ tư: DB vẫn uncertain/attempts=4 cho tới explicit dispatch kế
   tiếp đánh dấu exhausted; không bao giờ gửi lần thứ năm. GET giữ nguyên dữ liệu.

Không có polling, timer nền hay retry tự động. Mỗi request dispatch tối đa một
outbound attempt; restart chỉ mở DB. Lịch sử bounded bằng tối đa 16 identity và
một bộ đếm 0..4, không lưu log vô hạn. Receipt và hàng tổng `receiver_total` được lưu bền cùng
transaction; replay chỉ đọc tổng, không cập nhật lại. Giới hạn retry có thể bỏ sót hiệu ứng chưa chạy
và cũng có thể exhausted dù hiệu ứng đã chạy; cần đối soát trước quyết định vận
hành tiếp theo. Không được tạo id mới chỉ để né exhausted vì sẽ bỏ bảo vệ dedup.

## Đồng hồ, đánh đổi và phạm vi

Timestamp bền sống qua restart, nhưng không làm đồng hồ chính xác. Đồng hồ nhảy
về trước làm nhiều timer đủ hạn cùng lúc; nhảy lùi trì hoãn chúng. Skew giữa máy
đặt lịch và scheduler làm sai ý nghĩa deadline; đồng bộ thời gian và định nghĩa
nguồn thời gian là trách nhiệm hệ thống. Kiểm tra `dueAt <= now` ngăn gửi sớm theo
**clock scheduler**, không hứa đúng giây vật lý. Scanner chủ động còn có độ trễ
bằng thời gian chờ operator gọi dispatch. Timer đến hạn lâu nhất bị ưu tiên kể cả
uncertain nên nó có thể trì hoãn timer sau tối đa phần ngân sách retry còn lại.

Đây là mô hình attempt **at-least-once trong ngân sách hữu hạn**, với hiệu ứng dedup
bền tại receiver. Không có exactly-once transport; không đảm bảo eventual delivery
khi hết retry hay không có scanner. Hủy chỉ khả thi trước attempt đầu. Bài học
không triển khai workflow engine Temporal sản xuất: thiếu durable workflow history,
worker fleet, replication, recovery orchestration và đồng hồ logic phân tán.

Mọi cấu hình, mở DB, listener và signal handler đều ở `main()`/`serve()` bên trong
guard `import.meta.main`. Import module với cấu hình cố ý sai vẫn im lặng thành
công, không chỉ “startup lỗi”. Fixture lỗi đặt ở `test/upstream.mts`, không đi vào
service. Không thêm dependency hoặc sửa Playground.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/46-durable-timers/test/lesson.test.mts
node --test --test-timeout=15000 lessons/46-durable-timers/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite `:memory:` và injected clock, kiểm tra ranh giới giây, thứ tự,
hủy, replay, uncertainty sau mở lại domain và exhaustion. HTTP test dùng tiến
trình Node độc lập, cổng loopback ephemeral, DB trong `node:os.tmpdir()` nên source
có thể read-only. Fixture upstream tái sử dụng qua nhiều mode, reset counter từng
case. Barrier `started` chứng minh request đang đến upstream trước khi thử busy
và cancel; không suy luận concurrency chỉ từ thời gian trôi. Slow reply đã có
headers và JSON nhưng không kết thúc stream, kiểm tra deadline toàn body. Redirect
trỏ sang process khác và counter đích phải bằng 0. `finally` dừng tiến trình và xóa
DB kể cả assertion thất bại. Worker không có mạng chỉ chạy typecheck và unit;
controller chạy HTTP/full suite trong môi trường loopback cách ly.

## Bài tập

- Tại sao xóa receipt sau delivered làm replay không còn an toàn? Viết một chuỗi
  crash/retry minh họa trước khi nghĩ tới chính sách dọn dữ liệu.
- Nếu receiver trả total=7 nhưng scheduler không nhận được reply, hãy liệt kê hai
  thế giới scheduler không phân biệt được. Vì sao cancel không giải quyết được?
- Thiết kế quy trình đối soát exhausted mà không đổi id và không giả định receiver
  đã thất bại. Cần thêm hợp đồng read nào, và ai có quyền dùng nó?
- Khi triển khai scanner nhiều replica, transaction và cờ busy trong RAM còn thiếu
  gì? So sánh lease/fencing và một worker duy nhất; đừng chỉ tăng số process.

Tham khảo chính thức: [Temporal design patterns](https://docs.temporal.io/design-patterns),
[Temporal tasks](https://docs.temporal.io/tasks),
[Node SQLite](https://nodejs.org/api/sqlite.html). Đọc để so sánh durable execution,
không suy ra rằng scanner nhỏ này có cùng bảo đảm.
