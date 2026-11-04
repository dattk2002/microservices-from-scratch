# 25 — Event sourcing, replay và snapshot có thể dựng lại

## Mục tiêu và điều kiện

Cần Node.js **24.12+ (nhánh 24)**, npm và các development dependencies đã được
cài ở root. Runtime chỉ dùng built-ins, bao gồm `node:sqlite`. Nên học bài 03
(service sở hữu dữ liệu), 11 (outbox), 15 (CQRS) và 22 (optimistic concurrency).
Không có thanh toán thật, tài khoản, cloud hay API bên ngoài.

Ví dụ: một giỏ trà lưu **ý định đã được chấp nhận**: tạo giỏ, thêm trà, bớt trà,
checkout. Không lưu mỗi trạng thái hiện tại rồi ghi đè. Event stream mới là nguồn
sự thật; trạng thái là kết quả reducer thuần, không gọi HTTP hay gửi thanh toán.
Command chưa được chấp nhận không phải event. `added` có nghĩa tăng lượng một lần,
không phải đặt lượng tuyệt đối.

```text
client --POST command + expectedVersion--> owner process --> SQLite riêng
                                              |
reader process --GET events?after=N&limit=4----+
      |          không nhận đường dẫn DB
      +--validate + replay --> GET /carts/cart

SQLite: events (authoritative, append-only)
        snapshots (derived, bỏ đi được)
```

Owner và reader là hai OS process độc lập. Reader không import Store, không mở
SQLite, không chia sẻ file trạng thái; chỉ dùng HTTP có deadline. Reader không
lưu projection lâu dài: mỗi GET dựng lại một phiên bản lịch sử. Việc restart cả
hai không làm mất lịch sử nếu giữ file owner.

## Chạy native

Từ root repository, terminal thứ nhất (chọn đường dẫn DB thuộc quyền ghi):

```sh
CART_DB=/tmp/lesson25-cart.sqlite PORT=3025 node lessons/25-event-sourcing/owner.mts
```

Terminal thứ hai:

```sh
OWNER_URL=http://127.0.0.1:3025 PORT=3026 node lessons/25-event-sourcing/reader.mts
```

`HOST` mặc định `127.0.0.1`; `PORT` trong 0..65535, giá trị 0 chọn ephemeral port.
Mỗi process in một dòng JSON `{service,port}` khi sẵn sàng. `CART_DB` bắt buộc,
`:memory:` phù hợp unit test nhưng không bền qua restart. `OWNER_URL` bắt buộc là
origin HTTP `127.0.0.1`, không credentials/path/query/fragment; không theo redirect.
Các biến chỉ được đọc trong `main`; import không mở DB, đăng ký signal hay listen.
SIGINT/SIGTERM đóng listener, chặn keep-alive kéo dài bằng cleanup của shared serve;
owner đóng SQLite khi server đóng. SQLite sync nên phù hợp workload nhỏ có giới hạn.

Ví dụ HTTP (chỉ chạy trên máy/controller cho phép loopback):

```sh
curl -i http://127.0.0.1:3025/carts/cart/commands \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":0,"command":{"type":"create"}}'
curl -i http://127.0.0.1:3025/carts/cart/commands \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":1,"command":{"type":"add","item":"tea","quantity":2}}'
curl http://127.0.0.1:3026/carts/cart
curl -X POST http://127.0.0.1:3025/carts/cart/snapshot
curl http://127.0.0.1:3025/carts/cart/events?after=0\&limit=4
```

Kết quả state sau hai command:
`{"version":2,"items":{"tea":2},"checkedOut":false}`.
Thử `remove` với quantity 1 ở expectedVersion 2, rồi `checkout` ở version 3.
Checkout chỉ đóng giỏ, không thực hiện giao dịch tài chính.

## Hợp đồng

| Process / route | Method | Thành công |
| --- | --- | --- |
| owner `/carts/:id/commands` | POST | 201, state mới |
| owner `/carts/:id/events?after=0&limit=16` | GET | 200, `{version,events}` tăng dần, seq > after |
| owner `/carts/:id/state` | GET | 200, state replay hoặc snapshot được kiểm tra |
| owner `/carts/:id/snapshot` | POST, không cần body | 200, state đã dùng để dựng snapshot |
| reader `/carts/:id` | GET | 200, state dựng từ events qua HTTP |

Command envelope có đúng hai field `expectedVersion`, `command`. Command có đúng
`{type:"create"}`, `{type:"checkout"}`, hoặc `{type:"add"|"remove",item,quantity}`.
Event schema 1 có đúng `schema,seq,type`; `added/removed` có thêm `item,quantity`.
Không bỏ qua field lạ. Event seq bắt đầu từ 1, liên tiếp, không trùng. Unknown
schema/type, seq sai, invariant sai đều bị từ chối trước khi dùng state.

Cart ID là 1..40 ký tự ASCII chữ/số/dấu `-`. Item là chữ thường đầu tiên, tiếp
0..29 chữ thường/số/`-`. Quantity là số nguyên an toàn 1..99, lượng mỗi item tối đa
99, tối đa 20 item khác nhau. Remove không được âm hoặc dùng item chưa có. Không
checkout giỏ rỗng; không sửa/tạo lại giỏ đã tạo hoặc đã checkout. Tối đa 100 giỏ
trong DB, 128 events mỗi stream, không có API xóa giỏ để lách giới hạn. Giới hạn là
chủ ý sư phạm, không phải giải pháp lưu trữ thương mại.

- 400: envelope/ID/integer/page/command sai; 415: content type sai; 413: body >8 KiB.
- 404: route hoặc state/snapshot chưa tồn tại. History chưa có trả version 0,
  events rỗng; reader diễn giải thành 404.
- 405: method sai, có header Allow.
- 409 `version_conflict`: expected version khác lịch sử; `cart_limit`: hết quota.
- 422 `invalid_history`: event hoặc ý định vi phạm invariant domain; sai số nguyên
  được báo 400 ngay cả khi kiểm tra một event.
- 502 ở reader: upstream lỗi, timeout, JSON/schema/sequence/page không hợp lệ;
  không trả projection một phần. 503 nếu hơn 8 reconstruction đang chạy.
- 500 cho lỗi nội bộ không dự kiến, bao gồm lỗi SQLite không được phân loại.

Owner có deadline tuyệt đối 1.5 giây mỗi handler; hết hạn ngắt kết nối (không bảo
đảm JSON lỗi). Body được shared helper giới hạn 8 KiB; SQLite busy timeout 200ms.
Reducer/SQL đồng bộ không bị timer ngắt giữa chừng; giới hạn số giỏ/events chặn
khối lượng công việc. Đây không phải hard realtime deadline. Reader có deadline
**toàn bộ reconstruction 1.2 giây**, mỗi response <=8 KiB, 4 events/page, <=32
pages. Owner cho limit 1..16. Shared server còn giới hạn header/request 5 giây.
Response thử nghiệm dùng timeout 3 hoặc 5 giây; child startup/stop có giới hạn.

## Atomic append và retry

`BEGIN IMMEDIATE` lấy quyền ghi SQLite trước khi đọc version, replay, quyết định
và INSERT. UNIQUE `(cart,seq)` cộng transaction bảo đảm hai lệnh cùng expected
version không cùng commit. Invariant hoặc conflict làm rollback. Trigger từ chối
UPDATE/DELETE trên events; snapshot nằm bảng khác. DB administrator vẫn có thể
đổi schema hoặc file: append-only ở đây là contract ứng dụng, không phải chống giả
mạo hay kho audit bất khả xâm phạm.

Không có command ID/dedup ledger. **Không blind retry.** Nếu mất response sau
commit, cùng request với version cũ sẽ conflict. Client đọc lại history/state,
đối chiếu ý định với người dùng trước khi tạo command mới. Không tự thay version
rồi gửi lại: có thể thêm hàng hai lần. Không tuyên bố exactly-once delivery hay
transaction xuyên nhiều aggregate. Một transaction chỉ sửa stream của một giỏ.

Reader cố định target bằng version của page đầu. Nếu owner nhận thêm command khi
đang phân trang, reader kiểm tra page đầy đủ nhưng chỉ dựng tới target ban đầu;
GET sau thấy version mới. Append-only làm prefix này ổn định; upstream bị thay
DB giữa pages không có generation ID nên đây là giả định vận hành cần giữ.

## Snapshot, replay và evolution

`POST snapshot` lưu state dẫn xuất theo cart. Khi đọc, owner parse candidate,
kiểm tra version và **replay prefix rồi so sánh toàn bộ state** trước khi dùng nó
làm điểm bắt đầu cho suffix. JSON hỏng, sai state/version đều fallback full replay.
Xóa bảng snapshots (chỉ bởi quản trị viên lúc owner dừng) không đổi kết quả.
Reader chủ ý không tải snapshot, luôn tự validate/replay events.

Cách kiểm tra bảo thủ này không tiết kiệm chi phí replay prefix; bài học minh họa
điểm đặt snapshot và fallback mà không giả vờ checksum là bằng chứng state đúng.
Một accelerator hiệu quả hơn cần snapshot đáng tin do owner tạo, gắn stream
identity, prefix/version và reducer version, kiểm tra schema/checksum; bỏ snapshot
khi đổi reducer/upcaster. Checksum tự khai báo không chống kẻ có thể sửa cả state
lẫn checksum. Nếu không tin snapshot thì xác minh bằng lịch sử, như ở đây, sẽ
đánh đổi lợi ích tăng tốc. Không dùng snapshot làm nguồn để sửa lịch sử.

Replay thuần, deterministic, không clock/random/network/checkout side effect.
Đừng gọi payment, email hoặc webhook trong reducer: replay sau restart sẽ gọi lại.
Chi phí đọc hiện tại O(n) events/giỏ, reader thêm O(ceil(n/4)) request tuần tự;
owner mỗi append cũng replay O(n). Giới hạn 128 làm chi phí rõ ràng. Snapshot không
phải compaction: giữ nguyên lịch sử. Lịch sử tăng vô hạn cần chính sách riêng.

Schema hiện tại chỉ nhận `schema:1`. Không âm thầm coi v2 như v1. Khi thêm event
version, viết upcaster thuần có test từ dữ liệu cũ sang biểu diễn canonical trước
reducer, xác định rõ defaults/ý nghĩa cũ. Đừng sửa event đã ghi để hợp thức hóa
model mới; thay đổi business meaning có thể cần event bù. Unknown version vẫn
fail closed cho tới khi có migration/upcaster được kiểm chứng. Đổi reducer cần
invalidate/rebuild snapshot; kiểm tra prefix cũng phát hiện candidate không còn
khớp. Lỗi/corruption trong stream authoritative phải báo lỗi, không fallback qua
snapshot để che giấu.

## So sánh và giới hạn

Bài 11 outbox giải quyết ghi trạng thái và ý định publish atomically; bảng trạng
thái vẫn có thể là nguồn sự thật. Ở đây lịch sử event chính là nguồn dựng giỏ,
không có broker/outbox hay bảo đảm giao hàng. Bài 15 CQRS tách mô hình đọc/ghi;
CQRS không bắt buộc event sourcing và event sourcing không bắt buộc reader riêng.
Hai process ở bài này giúp chứng minh quyền sở hữu lịch sử qua HTTP.

CRUD thường đơn giản hơn khi chỉ cần trạng thái mới nhất, ít yêu cầu audit/time
travel và schema thường xuyên thay đổi. Event sourcing tăng chi phí schema,
privacy/xóa dữ liệu, debug lịch sử, replay và vận hành. Không có auth, phân trang
toàn bộ danh sách giỏ, multi-writer deployment, backup/restore protocol hay payment.
Không dùng trực tiếp làm giỏ hàng production.

## Kiểm thử và bằng chứng

Từ root:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/25-event-sourcing/test/lesson.test.mts
# Controller/máy cho phép private loopback:
node --test --test-timeout=15000 lessons/25-event-sourcing/test/lesson.test.mts
# Full repository, do controller chạy:
npm run check
make test
git diff --check
```

Đã quan sát assertion RED trước implementation: replay trả `null` khác state kỳ
vọng, không tính lỗi import/spawn là RED. Unit dùng SQLite `:memory:`; kiểm tra
replay thuần, invariant, schema/seq, rollback, append conflict, trigger, quota,
snapshot bị hỏng và import im lặng trong child với config cố tình sai. Test import
đòi exit 0 và stdout/stderr rỗng, không chấp nhận failed startup.

Integration khởi chạy owner/reader thật với loopback ephemeral ports, gửi hai
command cùng expected version đồng thời và đòi đúng một 201/một 409. Không dùng
sleep để tạo race: tính đúng phải độc lập với thứ tự scheduler. Lịch sử 9 events
buộc reader lấy nhiều page; test so sánh state, restart, xóa snapshot và replay.
Fixture owner độc lập trả schema sai, seq sai, thiếu page, response quá lớn hoặc
treo. Các fixture schema/seq có version, route, envelope và event creation hợp lệ
ở mọi mặt khác, nên 502 kiểm chứng đúng lỗi chủ đích. Cleanup dùng finally lồng
nhau; DB fixture nằm trong `node:os.tmpdir()`, không ghi source khi chạy Docker.

Worker không chạy HTTP integration vì sandbox không cho mạng. Kết quả unit và
kiểm tra tĩnh được báo riêng; controller cần chạy integration trước khi duyệt.

## Bài tập

1. Thêm `rename` với event schema mới và upcaster thuần; chứng minh fixture v1 vẫn
   dựng đúng và snapshot cũ bị vô hiệu khi thay semantics.
2. Thiết kế command ID ledger trong cùng transaction, chỉ rõ duplicate payload
   khác nhau phải bị xử lý thế nào; kiểm tra mất response sau commit.
3. Thêm stream generation ID để reader phát hiện owner đổi DB giữa hai page.
4. Đo số events replay với/không snapshot đã được xác thực bằng một trust model
   cụ thể; giải thích trường hợp checksum không bảo vệ được bạn.

## Nguồn tham khảo

- [Microsoft — Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Node.js SQLite](https://nodejs.org/api/sqlite.html)
