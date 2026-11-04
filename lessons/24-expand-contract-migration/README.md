# 24 — Thay đổi schema bằng Expand, Migrate và Contract

Catalog đổi cột `legacy_name` thành `display_name`, nhưng HTTP vẫn nhận và trả
`{id, name}`: tên hiển thị của một mặt hàng. Ví dụ sản phẩm 1 từ “Trà sen” thành
“Trà sen mùa thu”; đây là đổi cách lưu trữ, không đổi ý nghĩa nghiệp vụ hay đổi đơn vị.
Bài học dùng SQLite thật, không giả lập kho dữ liệu bằng Map.

## Điều kiện và ranh giới sở hữu

Cần Node.js **24.12+ trong nhánh 24**, npm và các development dependency đã cài ở root.
Runtime chỉ dùng built-in Node. Chạy lệnh từ root repository. Không cần mạng,
container, khóa API hoặc dịch vụ bên ngoài để chạy chương trình mẫu cục bộ.

`old.mts` và `new.mts` là hai executable đại diện cho hai phiên bản/replica **của cùng
Catalog**, cùng dùng một file SQLite do Catalog sở hữu. `control.mts` là tiến trình
điều khiển migration của chính chủ sở hữu đó. Không phải ba business service có quyền
sở hữu độc lập chia sẻ database. Orders, Search hoặc business service khác chỉ được
gọi HTTP Catalog; không được mở file này. File phải nằm trên ổ đĩa cục bộ cùng máy,
không phải database phân tán hay file dùng chung qua network filesystem.

```text
client ──HTTP──> old Catalog ──┐
client ──HTTP──> new Catalog ──┼── Catalog SQLite: products, migration, admissions
operator ─HTTP─> control ─────┘
```

Baseline “old” ở đây đã có giao thức admission/retirement và đọc metadata phase.
Không thể dùng một binary tùy ý từ trước khi có giao thức này rồi kỳ vọng nó tuân
thủ barrier. Ba entrypoint dùng chung thư viện sở hữu dữ liệu `store.mts`, nhưng
old chỉ đọc/ghi tên qua schema cũ; new chọn schema theo phase. Đây là rollout
phiên bản tương thích có chuẩn bị, không phải ngăn một tiến trình độc hại mở SQLite.
Quyền filesystem và quy trình phát hành vẫn phải ngăn code khác ghi SQL trực tiếp.

## Chạy thử bằng ba tiến trình

Mở ba terminal, dùng **cùng đường dẫn tuyệt đối**. Ví dụ file nằm dưới `/tmp` để
source có thể read-only. Chỉ dùng file mới cho lần thử đầu; không xóa database của
một lần chạy chưa xử lý xong.

```sh
CATALOG_DB=/tmp/catalog-lesson24.sqlite PORT=43241 node lessons/24-expand-contract-migration/old.mts
CATALOG_DB=/tmp/catalog-lesson24.sqlite PORT=43242 node lessons/24-expand-contract-migration/new.mts
CATALOG_DB=/tmp/catalog-lesson24.sqlite PORT=43243 node lessons/24-expand-contract-migration/control.mts
```

Cấu hình: `CATALOG_DB` bắt buộc; `PORT` là số nguyên 0..65535 (0 để OS cấp cổng),
`HOST` mặc định `127.0.0.1`; port mặc định 3024 nên chạy nhiều tiến trình phải chọn
port riêng. Mỗi tiến trình in một dòng JSON chứa port khi sẵn sàng. SIGTERM/SIGINT
đóng listener, cắt kết nối còn lại sau 1 giây, rồi đóng database khi server đóng.
Không đọc cấu hình, mở SQLite, đăng ký signal hay tạo listener khi import module.

Từ terminal thứ tư:

```sh
curl --max-time 5 -sS -H 'content-type: application/json' -d '{"id":1,"name":"Trà sen"}' http://127.0.0.1:43241/products
curl --max-time 5 -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:43243/expand
curl --max-time 5 -sS http://127.0.0.1:43242/products/1
curl --max-time 5 -sS -H 'content-type: application/json' -d '{"size":2}' http://127.0.0.1:43243/batch
curl --max-time 5 -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:43243/retire
curl --max-time 5 -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:43243/contract
curl --max-time 5 -sS http://127.0.0.1:43242/products/1
```

Với một sản phẩm, batch size 2 chuyển thẳng sang `ready`. Nếu có nhiều hơn,
lặp `/batch` tới khi `/status` trả `phase: "ready"`. Dừng các terminal bằng Ctrl-C.
Sau contract, khởi động lại new với cùng file vẫn đọc và ghi bình thường; old
trả 409, kể cả `/status`, thay vì cố đọc cột đã mất.

## Hợp đồng HTTP

Tất cả request body dùng `content-type: application/json`, tối đa 8192 byte.
ID là số nguyên an toàn dương; name có 1..100 ký tự JavaScript, không chỉ khoảng
trắng. Không trim tên khi lưu. Không có delete/re-key, nên cursor ID luôn ổn định.
POST `/products` là upsert; không cung cấp idempotency key hay chống lost update
nghiệp vụ giữa hai người dùng cùng sửa sản phẩm. Thứ tự áp dụng transaction quyết
định giá trị cuối; trigger chỉ ngăn sai lệch giữa hai cách biểu diễn của một tên.

| Tiến trình | Đường dẫn | Kết quả |
| --- | --- | --- |
| old/new | `POST /products` body `{id,name}` | 200 sau khi ghi hoàn tất |
| old/new | `GET /products/:id` | 200 `{id,name}`, 404 nếu chưa có |
| old | `POST /admit` body `{id,name}` | 202 `{ticket}`: chỉ nhận lệnh bền vững, chưa áp dụng |
| old | `POST /complete` body `{ticket}` | 200 `{id}` sau áp dụng hoặc nhận lại receipt |
| tất cả | `GET /status` | 200 `{phase,cursor,retired,pending}`; old sau contract: 409 |
| control | `POST /expand` body `{}` | thêm cột và trigger, chuyển sang expanded |
| control | `POST /batch` body `{size}` | xử lý 1..100 hàng, trả status mới |
| control | `POST /retire` body `{}` | chỉ khi ready; đóng admission và drain pending |
| control | `POST /contract` body `{}` | chỉ khi ready, đã retire, không pending, dữ liệu khớp |

Sai input trả 400; media type sai 415; body quá lớn 413; phase sai, old retired,
queue đủ 32 lệnh hoặc ticket không tồn tại trả 409 `migration_conflict`. Route không
có trả 404, control dùng phương thức khác POST trả 405. Các lỗi SQLite/ngoài dự
kiến trả 500 chung; lock timeout có thể gây 500. Không retry write mù quáng sau lỗi
mạng vì chưa biết nó đã commit hay chưa. `/complete` có receipt nên có thể gửi lại
cùng ticket trong cửa sổ tương thích. `/admit` và POST `/products` không có cam kết
exactly-once qua retry HTTP. Control không có auth: chỉ là công cụ loopback cho
bài học, không được đưa lên public network.

## Expand: đặt cơ chế đồng bộ trước backfill

State machine bền vững: `original → expanded → ready → contracted`. Cờ `retired`
chỉ chuyển từ 0 sang 1 qua retirement transaction; không có endpoint bật lại.
Expand dùng một `BEGIN IMMEDIATE`: thêm cột nullable `display_name`, tạo hai
trigger `AFTER INSERT` và `AFTER UPDATE OF legacy_name`, rồi đổi phase. Ghi mới
và ghi cũ trước contract đều cập nhật `legacy_name`; SQLite tự điền `display_name`
trong **cùng transaction**. New đọc `COALESCE(display_name,legacy_name)` trước khi
backfill xong. Original chưa có cột mới thì new dùng cột cũ.

Vì trigger được cài trước khi nhả writer lock, không có khoảng trống giữa expand
và bắt đầu đồng bộ. Nếu old sửa một hàng đã đi qua cursor, trigger sửa cột mới.
Nếu old sửa hàng chưa đi qua cursor, batch đọc giá trị hiện tại dưới writer lock.
New cũng dùng đường ghi tương thích này tới contract; old đọc được ghi từ new.
Đây là atomicity trong **một SQLite**, không phải distributed dual-write atomicity.

## Migrate: giới hạn công việc và resume

Mỗi batch lấy tối đa 100 ID `> cursor`, theo thứ tự tăng. UPDATE từng hàng và lưu
cursor/phase nằm cùng transaction. Ít hơn size hàng nghĩa là hết dữ liệu hiện có,
chuyển `ready`; đúng size thì cần thêm batch để xác nhận EOF. Ghi thêm sau EOF
vẫn được trigger điền, nên không cần đẩy cursor theo mỗi insert.

Một transaction bị lỗi trước commit rollback cả hàng và cursor. Retry batch dùng
cursor đã commit cuối cùng, không bỏ sót ID. Dừng/restart control không mất tiến
độ vì không có cursor trong RAM hay background loop. `interrupt: true` là fault
injection của bài học: `/batch` làm thay đổi hàng/cursor rồi ném lỗi ngay trước
commit, trả 500. Chỉ dùng trong test/thử nghiệm; gọi lại với `{size:1}` để resume.
Một crash OS thực sự dựa vào cơ chế journal/recovery của SQLite; test kiểm tra
rollback trước commit và restart sau các batch đã commit, không mô phỏng power loss.

## Retirement là barrier được thực thi

Không có `allowContract: true` do người dùng tự khai. Mọi ghi old phải qua admission
transaction trước: ghi payload vào `admissions` và kiểm tra gate dưới cùng writer
lock. Giới hạn 32 pending giữ cho drain có tối đa 32 lệnh. `/admit` và `/complete`
tách hai bước để quan sát deterministic barrier trong test; POST `/products`
bình thường gọi cả hai bước. 202 không phải xác nhận ghi sản phẩm đã thành công.

Retirement lấy writer lock, kiểm tra ready, khóa gate, áp dụng toàn bộ payload đã
nhận theo ticket, rồi đánh dấu done và commit cùng lúc. Nếu admission đi trước,
lệnh đó được drain; nếu retirement đi trước, admission bị từ chối. Một request cũ
đã được nhận nhưng tiến trình chết vẫn được drain bởi control. Không cần chờ một
process đã chết tự báo “đã nghỉ”. Nếu complete đua với retire, SQLite tuần tự hóa
hai transaction; receipt done ngăn áp dụng lần hai. Replay receipt không ghi đè
một cập nhật mới hơn. Một read cũng dùng transaction ngắn để pin schema và phase.

Sau retirement, old vẫn đọc và lấy receipt trước contract nhưng không nhận ghi
mới. Sau contract, mọi hoạt động old fail closed. Gate vẫn tồn tại sau restart;
khởi động old lần nữa không khôi phục quyền ghi. Những lệnh đã admitted trước
retirement có thể áp dụng sau một new write tới cùng ID: đó là thứ tự hoàn thành
ghi, không phải mất đồng bộ schema. Ứng dụng cần version/ETag nếu muốn phát hiện
xung đột nghiệp vụ như vậy.

## Contract, khóa và rollback

Control sở hữu migration; hai control cùng chạy vẫn bị SQLite serialize, và guard
phase kiểm tra trong transaction ngăn thực hiện DDL hai lần. Contract kiểm tra
ready, retired, pending=0 và đối chiếu tất cả hàng trước khi drop trigger, drop
`legacy_name`, đổi phase và commit. DDL lỗi sẽ rollback cả phase và schema.

SQLite chỉ cho một writer. `BEGIN IMMEDIATE` giữ lock suốt batch/drain/DDL;
`busy_timeout=1000` giới hạn thời gian **chờ lock**, không giới hạn thời gian thực
thi DDL. Bài dùng rollback journal mặc định. Cả read cũng lấy writer reservation
để đơn giản hóa đồng bộ phase/schema; throughput đọc bị hạn chế có chủ ý.
ALTER/DROP COLUMN và truy vấn đối chiếu có thể quét bảng và giữ khóa lâu theo kích
thước dữ liệu. Batch giới hạn số hàng, drain giới hạn số lệnh; **không có hard
wall-clock bound cho contract**. Hãy dành maintenance window trên database nhỏ,
đo trước thời gian DDL/đối chiếu, dừng nhận tải khi cần và hoãn cleanup nếu vượt
ngân sách vận hành. Không hứa production zero downtime hay SLA migration từ mẫu
này. Nhiều node/máy cần một thiết kế coordination khác.

Rollback binary về old chỉ được hỗ trợ trong original/expanded/ready **trước
retirement**: cột cũ vẫn là nguồn ghi tương thích, không cần đảo DDL. Sau retirement,
old không còn ghi; bài không cung cấp reopen gate. Sau contract mất cột cũ và
trigger, cleanup không đảo ngược bằng một cú rollback binary. Muốn phục hồi phải
có kế hoạch migration mới hoặc restore backup đã kiểm chứng (và xử lý dữ liệu
phát sinh sau backup). Các receipt đã hoàn thành hiện giữ vô hạn để đơn giản hóa
replay; production phải có retention/protocol riêng, không tùy tiện xóa ticket.

## Kiểm chứng

Chạy native từ root với dependency sẵn có:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/24-expand-contract-migration/test/lesson.test.mts
node --test --test-timeout=30000 --test-name-pattern=integration: lessons/24-expand-contract-migration/test/lesson.test.mts
```

Unit dùng SQLite `:memory:`: guard phase, batch bounds, rollback giữa transaction,
ghi old trước/sau cursor, queue full, retirement drain, replay receipt và fail
closed. Test import chạy child với PORT/HOST/đường dẫn database sai, yêu cầu exit
thành công và stdout/stderr rỗng. Việc import thành công không chỉ là startup lỗi.

Integration dùng ba tiến trình riêng, HTTP thật, port loopback ephemeral và file
trong `node:os.tmpdir()` để chạy cả khi source read-only. Admission receipt là
barrier xác định, không dùng sleep đoán lịch. Test còn gửi old write và batch
đồng thời, restart control với cursor cũ, kiểm tra guard contract trước/sau ready,
kill old sau admission rồi retirement drain, restart new sau contract và old
fail closed. Mỗi request có deadline 5 giây; startup/stop có deadline và `finally`
dọn child/database. Các fixture thất bại vẫn có JSON, ID và name hợp lệ.

Worker không có quyền chạy network nên chỉ chạy typecheck và unit/focused unit;
lệnh integration bên trên dành cho controller trong Docker network cô lập. Không
suy ra HTTP integration đã pass từ unit. Các lệnh toàn repository `npm run check`
và `make test` cũng thuộc bước kiểm tra của controller vì chúng chạy HTTP tests.

## Bài tập

1. Chèn một hàng ID thấp hơn cursor trong expanded rồi chứng minh trigger vẫn
   bảo toàn dữ liệu; giải thích vì sao thuật toán không cần quét lại ID đó.
2. Thay đổi giới hạn batch/queue và đo thời gian giữ writer lock trên database
   thử nghiệm lớn; phân biệt lock wait timeout với thời gian thực thi.
3. Thiết kế retention cho receipt mà không làm retry ticket cũ tạo ghi lặp.
4. Đề xuất rollout cho baseline chưa biết admission barrier: cần giai đoạn nâng
   cấp nào trước expand, và bằng chứng nào cho phép loại writer cũ thật sự?

## Tham khảo

- Martin Fowler, [Parallel Change](https://martinfowler.com/bliki/ParallelChange.html):
  tách mở rộng giao diện, chuyển đổi sử dụng và thu hẹp tương thích.
- Node.js 24, [SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html):
  `DatabaseSync`, prepared statements và giới hạn API đồng bộ.
- SQLite, [ALTER TABLE](https://www.sqlite.org/lang_altertable.html) và
  [transactions](https://www.sqlite.org/lang_transaction.html): DDL, khóa và
  các điều kiện commit/rollback.
