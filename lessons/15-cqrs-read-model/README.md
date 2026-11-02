# 15 — CQRS và read model nhất quán cuối cùng

CQRS tách đường ghi nghiệp vụ khỏi đường đọc. Bài này có hai **tiến trình Node độc lập**:
Orders nhận command; Query sở hữu một projection phục vụ màn hình tóm tắt đơn trà.
Sau khi Orders trả thành công, Query vẫn có thể trả 404 hoặc phiên bản cũ.
Một lần đồng bộ hoàn tất mới tạo ra barrier có thể quan sát được.

## Điều kiện và ranh giới

Cần Node.js **24.12+**, npm và development dependencies đã cài từ lockfile ở root.
Runtime chỉ dùng built-ins (`node:sqlite`, HTTP, crypto); TypeScript chạy trực tiếp
bằng type stripping, không cần build hay package runtime. SQLite có thể in cảnh báo
experimental tùy bản Node. Đọc trước khái niệm transaction, optimistic concurrency,
outbox và deadline sẽ giúp hiểu bài, nhưng không cần chạy hay import bài trước.

Không thanh toán thật, không cloud, không credential. Các endpoint chỉ là giao thức
lab tin cậy trên loopback; chưa có xác thực. Không cho client không tin cậy ghi vào
`Query /events`: endpoint này dành cho phát lại và khảo sát hợp đồng sự kiện.

## Kiến trúc và quyền sở hữu

```text
client -- POST /orders --> Orders process -- transaction --> orders.sqlite
                            orders + durable events
                                      ^
                                      | GET /events?after=N (HTTP, 700 ms)
                                      |
client -- POST /sync ----> Query process -- transaction --> query.sqlite
client -- GET /state --->                  summaries + inbox + progress
```

Hai service nhận **DB_PATH khác nhau**. Chỉ Orders mở `orders.sqlite`; chỉ Query mở
`query.sqlite`. Query không đọc file của Orders, không join chéo database. Hai
service dùng module định nghĩa schema chung trong chính bài này, không dùng chung
kết nối hoặc instance store. `lib/http.mts` chỉ cung cấp HTTP và giới hạn body;
`test/support.mts` chỉ hỗ trợ khởi chạy/thu hồi child process.

Orders là source of truth: bảng `orders` lưu trạng thái nghiệp vụ hiện tại.
Mỗi command hợp lệ thay đổi bảng này và thêm event vào durable log trong cùng
`BEGIN IMMEDIATE … COMMIT`. Nếu ghi event lỗi thì thay đổi đơn cũng rollback.
Log là kênh chuyển thay đổi, không phải cơ chế dựng lại state nghiệp vụ: đây là
**CQRS có transactional event log, không phải event sourcing**. CQRS không bắt buộc
hai database; bài chọn tách database để thấy ranh giới ownership rõ hơn.

Query lưu `summaries` gồm version, quantity, status và thời gian sự kiện nguồn.
`progress` chứa checkpoint và hai giá trị đã tính trước: số đơn, tổng số lượng.
Cập nhật từ quantity 3 sang 5 cộng **2**, không cộng 5. Đọc tổng không scan toàn bộ
Orders hoặc phát lại event; Orders không cần cung cấp endpoint tổng hợp tương tự.
Inbox, summary, số tổng và checkpoint được commit trong **một transaction mỗi event**.
Index status là điểm mở rộng cho danh sách theo trạng thái, không phải endpoint đã triển khai.

## Chạy bằng lệnh native

Từ root repository, trong môi trường phát triển cho phép HTTP loopback:

```sh
mkdir -p /tmp/cqrs-15-demo
DB_PATH=/tmp/cqrs-15-demo/orders.sqlite PORT=4151 node lessons/15-cqrs-read-model/orders.mts
```

Terminal thứ hai:

```sh
DB_PATH=/tmp/cqrs-15-demo/query.sqlite ORDERS_URL=http://127.0.0.1:4151 PORT=4152 node lessons/15-cqrs-read-model/query.mts
```

Terminal thứ ba, dùng một thư mục demo mới để kết quả ban đầu giống ví dụ:

```sh
curl -i -H 'content-type: application/json' -d '{"id":"tea-17","expectedVersion":0,"quantity":3,"status":"open"}' http://127.0.0.1:4151/orders
curl -i http://127.0.0.1:4152/orders/tea-17
curl -i -X POST http://127.0.0.1:4152/sync
curl -s http://127.0.0.1:4152/orders/tea-17
curl -i -H 'content-type: application/json' -d '{"id":"tea-17","expectedVersion":1,"quantity":5,"status":"shipped"}' http://127.0.0.1:4151/orders
curl -s http://127.0.0.1:4152/orders/tea-17
curl -i -X POST http://127.0.0.1:4152/sync
curl -s http://127.0.0.1:4152/state
```

Kết quả: create trả 201/version 1/sequence 1; Query đầu tiên trả 404. Sau sync,
Query thấy quantity 3. Command thứ hai trả 200/version 2; trước sync tiếp theo,
Query vẫn thấy 3; sau sync tổng là 5 với một đơn. Dừng cả hai bằng Ctrl-C rồi chạy
lại với cùng từng DB_PATH để quan sát state và checkpoint còn nguyên.

Đây là **pull theo yêu cầu**, không có background timer. Ngừng gọi `/sync` nghĩa là
pause propagation; một phản hồi `/sync` thành công là barrier. Mỗi lần kéo tối đa
10 event; gọi tiếp cho đến `fetched: 0`. Khi writer dừng và nguồn hoạt động trở lại,
việc tiếp tục gọi sync sẽ hội tụ sau hữu hạn trang. Không gọi sync thì không có
cam kết hội tụ theo thời gian. Một hệ thống thực có thể dùng worker gọi định kỳ,
backoff có jitter và cảnh báo lag; bài không giả lập một scheduler ẩn.

Cấu hình:

| Biến | Orders | Query |
| --- | --- | --- |
| `DB_PATH` | Bắt buộc, file riêng của writer | Bắt buộc, file riêng của projection |
| `PORT` | Mặc định 4151; 0 chọn ephemeral | Mặc định 4152; 0 chọn ephemeral |
| `HOST` | Mặc định 127.0.0.1 | Mặc định 127.0.0.1 |
| `ORDERS_URL` | Không dùng | Mặc định http://127.0.0.1:4151, chỉ nhận HTTP 127.0.0.1, không user/password |

Không trỏ hai DB_PATH vào cùng file. Không thay nguồn sang một database Orders mới
rỗng khi giữ checkpoint cũ: stream identity chưa được triển khai. Các file schema
của bài dành cho database mới, không có migration tự động.

## Hợp đồng HTTP và sự kiện

Tất cả response là JSON, `cache-control: no-store`. Route không tồn tại trả 404;
sai method trả 405 với `Allow`; lỗi ngoài dự kiến trả 500 và không lộ SQL.

| Endpoint | Hợp đồng |
| --- | --- |
| Orders `POST /orders` | `{id, expectedVersion, quantity, status}`; tạo khi expectedVersion=0; cập nhật cần đúng version hiện tại. 201 khi tạo, 200 khi cập nhật, 409 `version_conflict` nếu không khớp |
| Orders `GET /orders/:id` | State chính thức; 404 nếu không có |
| Orders `GET /events?after=N` | Mảng event theo seq tăng dần, tối đa 10, `N` là safe integer không âm; không xóa event sau đọc |
| Query `POST /sync` | Kéo một trang từ checkpoint hiện tại; 200 kèm fetched và freshness; không cần request body; 409 `sync_busy` nếu đang có sync khác |
| Query `GET /orders/:id` | `{summary,freshness}`; 404 `not_projected` có thể là chưa lan truyền hoặc không tồn tại |
| Query `GET /state` | `{checkpoint,appliedAt,orderCount,totalQuantity}` |
| Query `POST /events` | Áp dụng/phát lại một envelope; 200 `{result:"applied"}` hoặc `{result:"duplicate"}`; 409 nếu vi phạm thứ tự/identity |

ID dùng 1..80 chữ ASCII, số hoặc dấu `-`; quantity là số nguyên 1..1000;
status là `open` hoặc `shipped`. Bài cho phép sửa quantity/status theo expectedVersion,
không mô hình hóa đầy đủ vòng đời đơn hàng. Input sai trả 400; POST JSON cho orders/events
cần `application/json` (415 nếu sai), tối đa 8192 bytes (413 nếu vượt).
Command không có idempotency key: nếu mất response, đọc Orders để hòa giải trước
khi quyết định gửi command mới; retry cùng expectedVersion sẽ nhận 409 sau commit.

Một envelope nguồn có dạng:

```json
{"seq":1,"eventId":"e58fc591-cccb-47ad-881a-4f334ab50720","orderId":"tea-17","version":1,"quantity":3,"status":"open","occurredAt":1793592000000}
```

- `eventId`: UUID sinh một lần trong transaction nguồn; khi truyền lại phải giữ nguyên.
- `seq`: vị trí toàn cục của **một** stream Orders, dùng làm HTTP cursor/checkpoint.
- `version`: tăng đúng 1 cho từng order; order mới bắt đầu ở 1.
- quantity/status là snapshot kết quả của command; occurredAt là epoch milliseconds
  ở nguồn. Snapshot không cho phép bỏ qua event thiếu trong giao thức bài này.

Query chuẩn hóa envelope rồi so payload của các trường giao thức, không phụ thuộc
thứ tự key JSON; trường ngoài giao thức bị bỏ qua. Hợp đồng kiểm tra theo thứ tự:

1. Cùng eventId hoặc seq đã thấy và payload chuẩn hóa giống hoàn toàn: **duplicate**,
   trả 200, không đổi tổng/checkpoint/appliedAt.
2. Identity đã thấy nhưng payload khác (kể cả occurredAt), hoặc seq/eventId trỏ
   hai bản ghi khác nhau: 409 `event_conflict`.
3. Envelope chưa thấy có seq <= checkpoint: 409 `stale_sequence` (phòng thủ; với
   inbox đầy đủ, seq cũ thường rơi vào duplicate/conflict trước).
4. seq > checkpoint+1: 409 `sequence_gap`; giữ nguyên checkpoint.
5. Đúng seq kế tiếp nhưng version <= version hiện tại: 409 `stale_version`;
   version > current+1: 409 `version_gap`. Order mới cũng phải bắt đầu ở version 1.
6. Chỉ khi cả hai thứ tự liên tục: cập nhật projection, delta tổng, inbox và checkpoint.

**Chiến lược gap:** dừng ở event lỗi, không acknowledge hay nhảy cursor. Gọi lại
`/sync` sẽ yêu cầu nguồn từ checkpoint đã commit. Event thiếu còn trong log sẽ
được đọc lại đúng thứ tự. Nếu log bị sửa/xóa hoặc một poison event tồn tại, retry
không tự chữa được: cần điều tra nguồn và khôi phục log, hoặc xây projection mới
bằng replay toàn bộ vào file Query mới khi đã kiểm soát ingestion. Không tự bỏ
qua dữ liệu và không tự xóa inbox. Nếu một trang đã commit các event trước event
lỗi, những commit đó được giữ; response lỗi không có nghĩa cả trang rollback.

## Freshness, deadline và khôi phục

`checkpoint` là prefix nguồn đã áp dụng, không phải thời gian hay độ trễ ước lượng.
`appliedAt` là giờ local khi áp dụng event mới gần nhất, ban đầu null;
`summary.sourceAt` là giờ nguồn của version đơn đó. Đồng hồ có thể lệch và một nguồn
im lặng không đồng nghĩa projection mới nhất. Không có source head trong `/state`,
vì thế metadata không chứng minh lag bằng 0. Có thể so sequence từ command response
với checkpoint để biết đã áp dụng command đó trong stream tin cậy này.

CQRS **không bảo đảm read-your-writes tức thì**. UI có thể hiển thị “đang đồng bộ”,
đọc kết quả command, hoặc đợi checkpoint đạt token sequence với deadline rồi báo
pending. Không chờ vô hạn và không quảng cáo một 404 projection là đơn chắc chắn
không tồn tại.

Một sync chỉ có một fetch, timeout 700 ms bao gồm đọc response body, không theo redirect,
nhận tối đa 8192 bytes và 10 event. Nguồn không kết nối được, timeout, status khác
200, JSON lỗi hoặc trang quá lớn trả 503 `source_unavailable`; không thay checkpoint
trong pha fetch. Envelope sai kiểu trả 400; lỗi gap/conflict trả 409. SQLite busy
chờ tối đa 500 ms; HTTP server dùng request/header timeout 5 giây từ helper chung.
Các deadline này không phải hard realtime nếu event loop hoặc ổ đĩa bị treo.
Không retry tự động trong một request; caller quyết định thử lại có giới hạn.

- Orders chết trước commit: không có cả state lẫn event mới. Sau commit nhưng
  trước response: cả hai còn trên file; đọc state để hòa giải command.
- Query chết trước commit event: transaction rollback khi mở lại; checkpoint cũ
  yêu cầu phát lại. Test chèn trigger lỗi sau cập nhật summary/inbox để kiểm tra rollback.
- Query chết sau commit nhưng trước response: retry/replay thấy durable inbox,
  trả duplicate, không đếm hai lần. Integration test kill sau commit đã quan sát
  rồi phát lại envelope để mô phỏng delivery lặp sau restart; không tuyên bố đã
  chặn được chính xác cửa sổ mất response trong kernel.
- Nguồn downtime: Query vẫn đọc được snapshot cũ; sync trả lỗi hữu hạn. Sau restart
  producer đọc cùng file, query tiếp tục từ cursor durable. Không cần chia sẻ file.

Đổi lại, bài giữ log và inbox vô hạn, một SQLite writer mỗi service, một stream
và thứ tự toàn cục có thể gây head-of-line blocking giữa các order. Production cần
retention/rebuild protocol, stream epoch, giám sát lag, auth, schema evolution và
partitioning thích hợp. Không gọi delivery này là exactly-once toàn hệ thống;
hiệu ứng projection được chống trùng bằng transaction trong database consumer.

## Kiểm tra và bằng chứng

Chạy từ root:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern='unit:' lessons/15-cqrs-read-model/test/lesson.test.mts
```

Unit tests dùng SQLite in-memory để kiểm tra duplicate/conflict/gap, optimistic
version và rollback của hai transaction khi trigger SQLite cố tình thất bại.
Test đầu tiên được chạy với stub, quan sát assertion `not-implemented` khác
`applied` trước khi triển khai. Tùy sandbox, runner tách process có thể chỉ hiển thị
kết quả theo file; lệnh isolation=none giúp thấy từng assertion.

Trong môi trường controller cho phép private loopback và temporary files:

```sh
node --test --test-timeout=15000 --test-name-pattern='integration:' lessons/15-cqrs-read-model/test/lesson.test.mts
npm run check
make test
git diff --check
```

Integration tests tạo child process thật với `PORT=0`, hai file database tạm,
fetch có timeout và cleanup trong `t.after`. Không mở listener ở module top level.
Barrier là phản hồi command/sync và child exit, không phải một lần sleep đoán thời gian.
Các trường hợp gồm stale read khi chưa sync, hội tụ, duplicate/conflict/out-of-order,
SIGKILL cả writer/reader, phục hồi cursor và tổng không tăng trùng, nguồn downtime,
phân trang 10+2. Một integration test riêng mở lại file để kiểm tra durable inbox.

Worker sandbox không có HTTP network; **integration tests chưa được chạy ở đây**.
Không suy luận unit tests hay typecheck chứng minh HTTP flow đã qua. Controller
chịu trách nhiệm chạy các lệnh tích hợp và kiểm tra đầy đủ ở môi trường cách ly.

## Bài tập

1. Thêm source head vào response nguồn. Phân biệt lag theo sequence với tuổi của
   một order không được cập nhật lâu ngày; tránh dùng clock skew để kết luận lag.
2. Thiết kế worker tự pull có pause/resume barrier và backoff, rồi kiểm tra deadline
   khi nguồn giữ kết nối nhưng không trả body. Giữ cleanup chắc chắn khi SIGTERM.
3. Thêm danh sách đơn shipped dùng index status; so sánh chi phí projection với
   việc thêm truy vấn tổng hợp trực tiếp vào writer.
4. Thiết kế stream epoch và rebuild khi đổi database nguồn. Vì sao xóa inbox
   nhưng giữ tổng/checkpoint có thể làm mất tính đúng đắn?

## Tài liệu gốc

- [Microservices.io — CQRS](https://microservices.io/patterns/data/cqrs.html):
  tách mô hình đọc/ghi và chi phí đồng bộ giữa hai phía.
- [Microsoft Azure Architecture — CQRS pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs):
  trường hợp áp dụng, độ phức tạp và quan hệ tùy chọn với event sourcing.
- [Node.js SQLite](https://nodejs.org/api/sqlite.html): DatabaseSync và transaction SQL.
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html): cơ sở để hiểu
  crash consistency; không thay thế giả định ổ đĩa và cấu hình durability.
