# 11 — Transactional outbox và giao nhận ít nhất một lần

## Mục tiêu và điều kiện

Cần Node.js **24.12+ (nhánh 24)**, npm và kiến thức về HTTP, SQLite,
idempotency, retry ở các bài trước. Runtime chỉ dùng thư viện chuẩn, bao gồm
`node:sqlite` (có thể in cảnh báo experimental). TypeScript chạy trực tiếp bằng
Node với cú pháp erasable; không cần build. Chạy các lệnh từ gốc repository;
các công cụ phát triển đã được pin tại `package-lock.json`.

Ví dụ gốc: cửa hàng trà nhận đơn `tea-order-17`, số lượng 3. Dịch vụ đơn hàng
phải lưu đơn và yêu cầu cộng số lượng vào sổ thống kê của dịch vụ nhận hàng.
Không dùng thanh toán thật hay gọi dịch vụ bên ngoài.

## Kiến trúc và quyền sở hữu

```text
client --POST /orders--> producer process --HTTP POST /events--> consumer process
                         producer.sqlite                      consumer.sqlite
                         orders + outbox                      inbox + inventory
                         transaction A                        transaction B
```

`service.mts` là một entrypoint với hai ROLE. Hai tiến trình không đọc chung cơ
sở dữ liệu. Mỗi tiến trình sở hữu một tệp SQLite riêng; dùng cùng lớp `Store`
để giảm mã minh họa, vì thế mỗi tệp có cả các bảng không dùng ở role đó.
`lib/http.mts` cung cấp parser, phản hồi lỗi và listener;
`test/support.mts` khởi động tiến trình con và đợi cổng ephemeral được báo sẵn sàng.
Bài không phụ thuộc mã nguồn của bài trước.

Producer chạy `BEGIN IMMEDIATE`, ghi `orders` và `outbox`, rồi `COMMIT`.
Nếu ghi outbox lỗi, đơn hàng cũng rollback. Không có bước “commit đơn xong mới
insert sự kiện”. HTTP 201 chỉ xác nhận transaction cục bộ đã commit, chưa xác
nhận consumer đã xử lý.

Relay chọn một bản ghi chưa gửi có `next_at <= Date.now()`, gửi envelope
`{"id":"tea-order-17","quantity":3}`, rồi đánh dấu `sent=1` sau HTTP 200.
Mỗi lần chỉ một request đang chạy. Consumer kiểm tra ID trong `inbox`, ghi dấu
ID và cộng `inventory.total` trong **cùng transaction**. Trùng ID và cùng quantity
trả 200 mà không cộng lại; cùng ID khác quantity trả 409.
ID đơn cũng là ID sự kiện vì ví dụ chỉ có một loại sự kiện trên mỗi đơn.

## Chạy hai dịch vụ

Tạo thư mục dữ liệu bên ngoài mã nguồn; mỗi terminal dùng cùng giá trị tuyệt đối
cho thư mục này. Không để hai role dùng cùng DB_PATH.

```sh
mkdir -p /tmp/lesson11-demo
ROLE=consumer DB_PATH=/tmp/lesson11-demo/consumer.sqlite PORT=4112 node lessons/11-transactional-outbox/service.mts
```

Terminal khác:

```sh
ROLE=producer DB_PATH=/tmp/lesson11-demo/producer.sqlite PORT=4111 CONSUMER_URL=http://127.0.0.1:4112 node lessons/11-transactional-outbox/service.mts
```

Terminal thứ ba, trong môi trường cho phép loopback:

```sh
curl -i -H 'content-type: application/json' -d '{"id":"tea-order-17","quantity":3}' http://127.0.0.1:4111/orders
curl http://127.0.0.1:4111/state
curl http://127.0.0.1:4112/state
```

Cuối cùng producer có `orders:1,pending:0,total:0`, consumer có
`orders:0,pending:0,total:3`. Gửi lại đơn giống hệt sẽ trả 200 với `duplicate:true`.
Ctrl-C dừng dịch vụ. Giữ nguyên các tệp SQLite rồi chạy lại để phục hồi.
Để thử outage, dừng consumer, tạo đơn mới, quan sát pending tăng, sau đó chạy
consumer lại ở cùng cổng và cùng tệp.

## Cấu hình và hợp đồng HTTP

| Biến | Giá trị và ràng buộc |
| --- | --- |
| ROLE | `producer` mặc định, hoặc `consumer` |
| DB_PATH | Bắt buộc, đường dẫn tệp riêng của dịch vụ; thư mục cha phải tồn tại |
| HOST | `127.0.0.1` mặc định; ví dụ/test chỉ dùng loopback |
| PORT | 4111 cho producer, 4112 cho consumer; 0 chọn cổng ephemeral; 0..65535 |
| CONSUMER_URL | Producer mặc định `http://127.0.0.1:4112`; chỉ HTTP 127.0.0.1, không credentials; relay luôn dùng đường dẫn `/events` |

| Route | Kết quả |
| --- | --- |
| Producer `POST /orders` | 201 cho đơn mới, 200 cho replay giống hệt |
| Consumer `POST /events` | 200 sau commit, kể cả duplicate |
| Cả hai `GET /state` | 200, `{orders,pending,total}` cục bộ, phục vụ quan sát demo |

Body là object JSON: `id` gồm 1..80 chữ ASCII, chữ số hoặc dấu gạch ngang;
`quantity` là số nguyên an toàn 1..1000. Field thừa bị bỏ qua. Sai nội dung trả
400; media type không phải application/json trả 415; body quá 8192 byte trả
413. Trùng ID khác quantity trả 409. Sai method trả 405 kèm Allow; route lạ
trả 404. Lỗi nội bộ trả 500 không lộ SQL. Lỗi có dạng
`{error:{code,message}}`; thành công ghi có dạng `{id,duplicate}`.
Không hỗ trợ query string trên các route demo.

Listener đặt request/header timeout 5 giây. Relay có deadline 500ms cho mỗi
lần gửi, bao gồm đọc body; không theo redirect. Mọi lỗi mạng, timeout hoặc
status khác 200 đều giữ sự kiện và retry. Delay lần đầu 100ms, sau đó
200/400/800/1600ms, trần 2000ms, cộng nhịp polling 25ms. `attempts` và
`next_at` lưu bền vững; restart không reset backoff. Busy timeout SQLite 1 giây;
WAL và synchronous FULL cho commit cục bộ. Không giữ transaction trong lúc
đợi mạng. SIGTERM/SIGINT hủy request relay; helper đóng listener và cưỡng bức
đóng kết nối HTTP còn lại sau 1 giây. Kill đột ngột không chạy cleanup, nên
phục hồi dựa vào SQLite và pending chứ không dựa vào signal handler.

## Cửa sổ lỗi và giới hạn

* Chết trước commit: không có đơn lẫn sự kiện; client có thể thử lại cùng ID.
* Chết sau commit trước gửi: pending còn trong tệp, relay đọc lại khi restart.
* Consumer commit xong nhưng mất phản hồi, hoặc producer chết trước ghi sent:
  sự kiện được gửi lại. Inbox bền vững ngăn cộng lại, kể cả consumer restart.
* Consumer ngừng hoạt động: đơn vẫn được nhận, outbox tăng. Khi consumer hồi
  phục và retry thành công, pending giảm. Test quan sát attempts để chứng minh
  đã có lần gửi thất bại, thay vì suy luận từ sleep cố định.
* HTTP 409/400 cũng retry mãi: đây là poison event. Demo chưa có dead letter,
  cảnh báo hay giới hạn backlog. Cần thêm vận hành trước khi dùng thực tế.

Đây là **HTTP transport tự định nghĩa**, không phải Kafka, không có broker,
consumer group hay offset. Không có exactly-once delivery: một envelope có thể
đến nhiều lần. Chỉ hiệu ứng SQLite của consumer này được bảo vệ bằng inbox;
email, gọi API khác hoặc tác vụ ngoài transaction vẫn cần cơ chế riêng.
Giao nhận ít nhất một lần phụ thuộc dịch vụ cuối cùng phục hồi, dữ liệu còn
nguyên, và retry tiếp tục. Không hứa giao được khi máy hoặc tệp mất vĩnh viễn.

Một relay trên mỗi producer DB là giả định: nhiều relay cần claim/lease và
fencing, không chỉ thêm tiến trình. Pending được chọn theo thứ tự tạo trong
những sự kiện đã tới hạn, nên retry có thể làm đảo thứ tự xử lý. Không có
ordering theo aggregate. Chưa có jitter, authentication, TLS, schema version,
retention hay giới hạn tổng thống kê. SQLite đồng bộ chặn event loop, hợp cho
bài học nhỏ, cần đo tải trước khi mở rộng. Không xóa inbox tùy tiện vì replay cũ
sẽ tạo hiệu ứng lần nữa; không xóa tệp WAL khi dịch vụ đang chạy.

## Kiểm thử và xác minh

```sh
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/11-transactional-outbox/test/lesson.test.mts
npm run check
make test
git diff --check
```

Worker không có network chỉ chạy typecheck và unit. HTTP integration được
controller chạy sau trong Docker cô lập, có loopback riêng; không chạy Docker
hay yêu cầu mở mạng từ worker. Trong sandbox không có `/tmp` ghi được, unit
có thể dùng `NODE_DISABLE_COMPILE_CACHE=1 TMPDIR="$PWD/lessons/11-transactional-outbox" npm run test:unit`;
thư mục tạm được cleanup sau test, không đưa SQLite vào artifact.

Unit kiểm tra backoff có trần, rollback đơn khi insert outbox thất bại bằng
SQLite trigger, reopen dữ liệu và eligibility theo thời điểm, cùng dedup/conflict
ở consumer. Test HTTP dùng tiến trình con riêng, PORT=0 khi khởi tạo và tệp
SQLite tạm riêng. Sau outage, kill producer bằng SIGKILL, giữ nguyên tệp rồi
khởi động lại. Để tái hiện cửa sổ commit/ack một cách xác định, test gửi chính
envelope còn pending tới consumer trong lúc producer đã chết, rồi cho relay
restart gửi lặp. Đây là mô phỏng cửa sổ ack bị mất, không giả vờ đã ngắt mạng
đúng thời điểm. Consumer cũng restart để chứng minh inbox tồn tại bền vững.
Mọi request/poll/test có deadline và cleanup dừng tiến trình trước khi xóa tệp.

## Bài tập

1. Thêm unit test trigger làm UPDATE inventory lỗi: inbox cũng phải rollback.
2. Thiết kế dead letter cho lỗi hợp đồng lâu dài; phân biệt lỗi retry được và
   lỗi cần người vận hành, vẫn giữ bằng chứng sự kiện gốc.
3. Bổ sung jitter có nguồn ngẫu nhiên inject được và test khoảng thời gian.
4. Với một đơn phát nhiều sự kiện, thiết kế ID/version và ordering theo đơn;
   nêu lý do inbox hiện tại chưa đủ để đảm bảo thứ tự.

## Nguồn tham khảo

* [Transactional outbox — Microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
* [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
* [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
