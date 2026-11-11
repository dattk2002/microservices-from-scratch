# 55 — SLO, error budget và cảnh báo burn rate qua nhiều cửa sổ

Bài này dùng hai tiến trình Node.js độc lập và SQLite để trả **quyết định** từ các bucket tổng hợp giả lập. Không đo availability tự động, không thu thập lịch sử từng request, không chứa dữ liệu người dùng. Không gửi tin nhắn, page on-call, chặn triển khai hay kết nối hệ thống giám sát thật.

## Kiến thức và chuẩn bị

Cần Node.js 24.12+ (Node 24), npm và kiến thức HTTP/JSON, SQLite, timeout. Chạy từ thư mục gốc repository; các package phát triển đã được pin ở gốc. Runtime chỉ dùng built-in Node.

- **SLI** là chỉ báo đo được, chẳng hạn tỷ lệ request hợp lệ thành công. Phải xác định rõ request nào thuộc mẫu số và lỗi nào vào tử số.
- **SLO** là mục tiêu cho SLI trong một khoảng thời gian, ở đây thành công 99% = 9900 basis points.
- **SLA** là thỏa thuận dịch vụ có thể kèm nghĩa vụ hoặc bồi hoàn. Một SLO nội bộ không tự trở thành SLA.

Error budget theo request ở đây là 1% tổng request, không phải số phút downtime. Ví dụ 1000 request cho phép 10 lỗi ở mức mục tiêu. Burn 6x nghĩa là tỷ lệ lỗi 6%; nó mô tả tốc độ tiêu hao ngân sách, không phải số trang cảnh báo.

## Kiến trúc và chạy thử

```text
POST /buckets --> collector --> SQLite (12 slot bất biến)
POST /evaluate --> evaluator -- GET /buckets một lần --> collector
                  | validate toàn bộ snapshot, tính cửa sổ
                  +--> alert / ok / insufficient_data
```

Terminal A:

```bash
DB_PATH=/tmp/lesson55.sqlite HOST=127.0.0.1 PORT=5551 node lessons/55-slo-burn-rate/collector.mts
```

Terminal B:

```bash
COLLECTOR_ORIGIN=http://127.0.0.1:5551 HOST=127.0.0.1 PORT=5552 DEADLINE_MS=500 node lessons/55-slo-burn-rate/evaluator.mts
```

Mỗi server in một dòng JSON `{service,port}` khi sẵn sàng. `PORT=0` chọn cổng ephemeral; lấy cổng collector từ dòng đó để cấu hình evaluator. Import module không đọc cấu hình, mở DB, nghe mạng hoặc đăng ký signal. `DB_PATH` mặc định `buckets.sqlite`; dùng đường dẫn riêng cho mỗi lần thực hành. Dừng collector bằng Ctrl-C rồi chạy lại cùng DB_PATH để thấy dữ liệu còn nguyên. Không chạy hai collector cùng ghi một DB: mô hình bài học có một writer.

Terminal C, tạo sáu phút lỗi kéo dài:

```bash
for slot in 0 1 2 3 4 5; do
  curl -sS -H 'content-type: application/json' -d "{\"slot\":$slot,\"total\":100,\"bad\":6}" http://127.0.0.1:5551/buckets
  echo
done
curl -sS -H 'content-type: application/json' -d '{"end":6}' http://127.0.0.1:5552/evaluate
```

Kết quả `alert`: fast short và long đều burn 6x, slow đều vượt 3x. Ghi tiếp slot 6 với `total:100,bad:0`, rồi đánh giá `end:7`. Fast hết firing vì short đã hồi phục, long vẫn nhớ 12 lỗi; slow vẫn firing tại short đúng 3x. Ghi các slot 7..11 với 100 request và 0 lỗi rồi đánh giá `end:12`: `ok`. Không cần đợi đồng hồ thật. Slot là chỉ số phút logic của bộ dữ liệu hữu hạn; hết 12 slot thì dùng DB_PATH mới, không sửa lịch sử cũ.

## Hợp đồng collector

`POST /buckets` nhận đúng `{slot,total,bad}`: số nguyên an toàn, slot 0..11, total 0..1000, bad 0..total. Lần đầu 201; replay cùng record 200; cùng slot khác nội dung 409 và không đổi bất kỳ record nào. `GET /buckets` trả `{buckets:[...]}` tăng nghiêm ngặt theo slot. Primary key và CHECK SQLite giới hạn tối đa 12 record; không có bảng event hay quyết định đánh giá. Aggregate tồn tại qua restart, nhưng SQLite này không cung cấp HA hoặc replication.

Public POST chỉ nhận JSON object đúng trường/kiểu; null, array, boolean, string thay số, thiếu/thừa trường hoặc ngoài miền là 400. JSON hỏng 400, content type sai 415, request body quá 8192 byte 413. Đường dẫn/phương thức không hỗ trợ trả 404. Lỗi xung đột 409 không được coi là retry thành công. Request tối đa hợp lệ kể cả escape tất cả tên trường dạng `\uXXXX` nhỏ hơn 8192 byte.

## Hợp đồng evaluator và phép tính

`POST /evaluate` nhận đúng `{end}` với end nguyên an toàn 6..12. Không nhận URL từ caller. `COLLECTOR_ORIGIN` là origin HTTP(S) cố định, không credential/path/query/fragment; `DEADLINE_MS` 20..5000, mặc định 500. Cấu hình sai khiến startup thất bại. Chỉ bind loopback cho demo; bài không xây auth hay cơ chế chống flood cho dịch vụ Internet.

Một lần evaluate fetch đúng một full snapshot, không cache. Toàn bộ snapshot phải đúng schema, tối đa 12 record, slot tăng nghiêm ngặt và không trùng; record ngoài cửa sổ cũng phải hợp lệ. Redirect bị từ chối bằng `redirect:'error'`. Một deadline bao phủ fetch header và đọc toàn bộ body. Giới hạn body upstream 4096 byte: tên `buckets` escape tốn 44 byte có dấu nháy; một record tối đa khoảng 123 byte khi escape tên trường, 12 record dưới 1600 byte. Có dư cho khoảng trắng; JSON có khoảng trắng tùy ý không có độ dài tối đa toán học, nên wire contract vẫn có trần 4096. Body sai JSON/schema, quá trần, status khác 200, mất kết nối hoặc chậm đều trả 502, không có partial/stale report.

Cửa sổ w chọn đúng slot `[end-w,end)` và **cộng bad, total trước**. Ví dụ 900 request không lỗi cộng 100 request có 10 lỗi: 10/1000 = 1%, burn 1x; trung bình 0% và 10% thành 5% là sai vì trọng số khác nhau.

Readiness theo thứ tự:

| Điều kiện | readiness | burnMilli |
|---|---|---|
| Thiếu bất kỳ slot cần có | missing | null |
| Đủ slot, tổng total = 0 | no_traffic | null |
| Đủ slot, total 1..99 | low_traffic | null |
| Đủ slot, total >= 100 | ready | floor(100000 × bad / total) |

Một window trả `{start,end,total,bad,readiness,burnMilli}`. Tổng ở cửa sổ missing vẫn là tổng các bucket có mặt, nhưng không đủ để quyết định healthy. burnMilli = 1000 nghĩa là burn 1x. Giới hạn số giúp phép nhân nguyên chính xác trong Number; không dùng burnMilli đã làm tròn để quyết định firing.

| Pair | short | long | threshold |
|---|---|---|---|
| fast | 1 phút | 3 phút | 6x |
| slow | 2 phút | 6 phút | 3x |

Pair trả `{threshold,short,long,firing}`. Chỉ firing khi **cả hai** window ready và cả hai thỏa `100*bad >= threshold*total`; bằng ngưỡng cũng firing. Spike chỉ làm short vượt ngưỡng không đủ. Short hồi phục có thể clear pair ngay khi long vẫn nhớ lỗi.

Response 200 là `{end,sloBasisPoints:9900,fast,slow,decision}`. Ưu tiên `alert` nếu bất kỳ pair firing, dù pair khác thiếu dữ liệu. Nếu không firing, chỉ `ok` khi cả bốn window ready; còn lại `insufficient_data`. Không có traffic không chứng minh healthy. Ít request khiến một lỗi tạo tỷ lệ lớn, vì vậy ngưỡng volume tối thiểu cần cân nhắc với độ trễ phát hiện, mức quan trọng và lượng traffic của dịch vụ thật.

**Các cửa sổ phút nén và ngưỡng 6x/3x này là giá trị giảng dạy tự chọn, không phải khuyến nghị production của Google.** Không thể suy ra ngân sách tháng đã tiêu hết hoặc thời gian còn lại từ 12 slot này. Bucket cố định giả định một nguồn đáng tin cung cấp tổng hợp chính xác; không xử lý late correction, event-time, sampling bias hay chống giả mạo dữ liệu. `bad` là lỗi theo định nghĩa của người tạo input, không tự động đồng nghĩa HTTP 5xx.

## Kiểm thử

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/55-slo-burn-rate/test/lesson.test.mts
node --test --test-timeout=15000 lessons/55-slo-burn-rate/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite in-memory và số liệu tính tay. RED đầu tiên là weighted ratio thực sự sai (`0 !== 1000`), không phải lỗi import. Test import chạy child với cấu hình cố tình sai và yêu cầu thoát 0, stdout/stderr trống.

Integration tự tạo collector/evaluator và hai upstream fixture độc lập trên loopback ephemeral. DB nằm trong `node:os tmpdir()`, tương thích source read-only; finally dừng cả tiến trình nếu startup bước tiếp theo thất bại rồi xóa DB. Fixture test-only có control giới hạn để tái sử dụng cho nhiều lỗi, không phải endpoint của ứng dụng. Destination redirect là origin riêng có thể truy cập, và counter được kiểm tra trước reset. Snapshot lớn nhất escape chỉ STRING token, giữ nguyên số. Fixture quá byte vẫn parse đúng và hợp lệ schema, chỉ thêm whitespace; nếu bỏ byte gate thì nó sẽ trả report và test phải fail.

Worker không chạy integration trong sandbox không có mạng; controller chạy HTTP trong Docker cô lập. Không nâng timeout hoặc cần credential. Các lệnh full check ở trên dành cho môi trường có loopback phù hợp.

## Bài tập

1. Tính tay tại end 6: slot 0..4 có 100 request/0 lỗi, slot 5 có 100/6. Vì sao fast không firing dù short đúng 6x?
2. Cho đủ sáu slot nhưng một slot total 0. So sánh với xóa slot đó; khi nào long vẫn ready?
3. Thiết kế mục tiêu cho dịch vụ ít request: tăng cửa sổ có lợi và hại gì? Vì sao không biến low_traffic thành ok?
4. Nếu muốn sửa aggregate muộn, hãy mô tả version/snapshot consistency cần thêm trước khi thay đổi hợp đồng bất biến.

Đọc thêm: [Google SRE Workbook — Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/). Đối chiếu cửa sổ, volume và yêu cầu phản ứng thực tế trước khi chọn chính sách production.
