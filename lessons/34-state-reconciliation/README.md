# 34 — Reconciliation và sửa read model khi mất thông báo

Bài 15 truyền thay đổi sang read model trong luồng bình thường. Bài này bổ sung
**pull anti-entropy**: thông báo có thể mất nhưng nguồn sự thật vẫn giữ trạng thái
hiện tại để một vòng đối soát sửa projection. Ví dụ danh mục thiết bị: thiết bị
`pump_7` đổi tên rồi bị xóa trong khi màn hình tìm kiếm bỏ lỡ hai thông báo.
Không cần phát lại toàn bộ lịch sử để màn hình biết thiết bị đã bị xóa.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (nhánh 24), đã cài development dependencies ở root. Hiểu HTTP,
SQLite, CQRS và khác biệt giữa giao dịch cục bộ với giao dịch phân tán. Không dùng
package runtime, credential, Docker hay API ngoài trong các chương trình này.

Từ root, mở ba terminal; mỗi database thuộc đúng một tiến trình:

```sh
HOST=127.0.0.1 PORT=3431 DB_PATH=/tmp/reconciliation-projection.sqlite TEACHING_CONTROLS=1 node lessons/34-state-reconciliation/projection.mts
HOST=127.0.0.1 PORT=3432 DB_PATH=/tmp/reconciliation-owner.sqlite PROJECTION_ORIGIN=http://127.0.0.1:3431 TEACHING_CONTROLS=1 node lessons/34-state-reconciliation/owner.mts
HOST=127.0.0.1 PORT=3433 OWNER_ORIGIN=http://127.0.0.1:3432 PROJECTION_ORIGIN=http://127.0.0.1:3431 node lessons/34-state-reconciliation/reconciler.mts
```

Có thể đặt `PORT=0`; stdout in một dòng JSON `{service,port}` cho harness tìm cổng.
`HOST` mặc định loopback; giữ loopback cho bài học. Origin bắt buộc là HTTP
`127.0.0.1` không path, credentials, query hay dấu `/` cuối. Chúng được đọc duy
nhất khi main chạy. Import các entrypoint không mở DB, đăng ký signal hay listen.
Upstream dùng `redirect: 'error'`: snapshot và apply không đi theo 307/308 sang
origin khác; URL cố định không có nghĩa an toàn nếu vẫn tự theo redirect.
`DB_PATH` mặc định `owner.sqlite` hoặc `projection.sqlite` trong thư mục chạy;
chọn đường dẫn rõ ràng để tránh nhầm DB giữa các buổi thực hành.

```sh
curl -s http://127.0.0.1:3432/change -H 'content-type: application/json' -d '{"id":"pump_7","value":"Bơm tầng một"}'
curl -s http://127.0.0.1:3432/change -H 'content-type: application/json' -d '{"id":"pump_7","value":null,"drop":true}'
curl -s http://127.0.0.1:3431/states
curl -s http://127.0.0.1:3433/run -H 'content-type: application/json' -d '{}'
curl -s http://127.0.0.1:3431/states
```

Trước `/run`, projection còn tên cũ. Sau đó nó chứa `{id:"pump_7",version:2,value:null}`.
Chạy lại `/run` trả `duplicate`; gửi `/apply` phiên bản 1 trả `stale`.

## Kiến trúc và hợp đồng

```text
Client -> owner SQLite --best effort /apply--> projection SQLite -> người đọc
                  |                                  ^
                  +-- GET /states --> reconciler -----+ POST /apply
                                        ^
                                     POST /run {}
```

Owner là **desired state**, projection là **current state**. Một SELECT đồng bộ
đọc toàn bộ tối đa 16 danh tính tạo snapshot nguyên tử trong owner; không có
phân trang hoặc transaction kéo dài qua HTTP. Owner có thể tiếp tục thay đổi sau
snapshot, nên một vòng có thể đã cũ khi kết thúc. Vòng sau bắt kịp; notification
mới hơn luôn thắng snapshot cũ.

- `POST owner/change`: `{id,value,drop?}`. ID ASCII `[a-zA-Z0-9_-]`, dài 1–64;
  value là string tối đa 256 UTF-16 code units hoặc `null` (tombstone). Owner tự
  tăng version nguyên dương safe integer, kể cả sau xóa/restart. Hết miền version
  bị từ chối. Commit SQLite trước khi thử thông báo; HTTP 200 trả `{state,notification}`.
  `notification` là `applied|duplicate|stale|conflict|failed|dropped`.
- `GET /states` ở owner/projection: mảng trạng thái có cả tombstone, sắp theo ID.
- `POST projection/apply`: `{id,version,value}`; version lớn hơn mới ghi. Version
  bằng và payload bằng trả `duplicate`; bằng nhưng khác trả `conflict`; nhỏ hơn
  trả `stale`. Các kết quả này đều HTTP 200, không tăng version cục bộ.
- `POST reconciler/run`: chỉ `{}`; không cho client chọn URL. Đọc đúng một snapshot,
  validate toàn bộ (kể cả ID trùng) trước ghi. Tối đa 16 yêu cầu apply, concurrency
  đúng 1, không retry ẩn. `{results:[{id,result}],complete}` cho biết từng kết quả;
  `complete:false` khi có `failed` hoặc `conflict`. HTTP 200 không có nghĩa mọi
  bản ghi đã sửa. `stale` nghĩa projection đã mới hơn snapshot.
- Lỗi snapshot/dependency trả 502 trước khi sửa gì; lỗi từng apply giữ tiến độ
  trước đó và tiếp tục báo kết quả. Chạy lại toàn bộ là cách retry. `/run` đang
  chạy thì vòng thứ hai trả 409; không có hàng đợi không giới hạn.

Body request dùng helper chung giới hạn 8192 byte, sai JSON/schema trả 400,
sai content type 415, quá byte 413, đủ 16 danh tính thì danh tính thứ 17 trả 409.
Một record lớn nhất gồm ID 64 byte, value có thể escape thành 256×6=1536 byte,
version tối đa 16 chữ số và envelope nhỏ hơn 100 byte: dưới 1800 byte. Snapshot
16 record dưới 28800 byte; reply reader giới hạn 30000 byte kể cả whitespace,
đếm byte streaming trước JSON.parse. Mỗi upstream request 700 ms, cả vòng 4000 ms;
server giới hạn request/header 5000 ms. Response luôn runtime-parse trước sử dụng;
không ép kiểu boolean/array/object thành enum hay ID.

## Xóa, conflict và giới hạn tính đúng đắn

Tombstone giữ version để thông báo cũ không hồi sinh dữ liệu. Bài này giữ tombstone
**suốt đời file DB**, nhưng chỉ nhận tối đa 16 ID kể cả các ID đã xóa. Không tự
quên tombstone để giải phóng slot. Đây là chính sách retention hữu hạn theo sức
chứa, không phải GC production. Muốn thu hồi cần một giao thức watermark/epoch
và bằng chứng mọi replica đã vượt version cũ; xóa DB thủ công phá bảo đảm này.
Owner cho phép chủ động tái tạo cùng ID bằng version mới hơn tombstone.

Hai payload cùng version là dữ liệu mâu thuẫn, không phải mất thông báo.
Reconciler báo `conflict` và giữ projection để người vận hành điều tra nguồn ghi,
sao lưu và chính sách sửa nghiệp vụ. Không đoán bằng timestamp hoặc ghi đè im lặng.
Projection chỉ nên nhận ghi từ owner/reconciler trong mạng tin cậy; bài local này
không triển khai auth. Có thể tạo conflict quan sát được bằng `/apply` với ID mới,
version 1, payload khác, rồi tạo cùng ID ở owner. Đây cũng minh họa hậu quả producer
không được kiểm soát. Không dùng các endpoint công khai trên Internet.

`TEACHING_CONTROLS=1` chỉ dành cho demo local: owner nhận `drop:true` để bỏ đúng
notification mà vẫn commit; projection nhận `POST /teaching/fail {"id":"c"}`
để một ID trả 503, và `{ "id": null }` để bỏ lỗi. Khi tắt cờ, drop bị từ chối và
route fail không tồn tại. Tạo ID `b`,`c` với drop, bật lỗi `c`, chạy `/run`: `b`
đã durable dù `c` thất bại. Bỏ lỗi rồi chạy lại: `b` duplicate, `c` applied.
Tắt owner rồi chạy `/run` nhận 502; bật lại cùng DB giữ nguyên version/xóa.

Không có transaction xuyên owner/projection: chết giữa vòng để lại tiến độ một
phần. SQLite bảo vệ mỗi apply cục bộ; mất file/ổ đĩa không được mô phỏng. Snapshot
chỉ sửa trạng thái có trong owner, không tự xóa ID lạ trong projection. Dữ liệu
ngoài miền tối đa 16 ID cần thiết kế khác. Một run có thể chờ dependency đến deadline;
không có scheduler nền. Cron hoặc scheduler ngoài chọn tần suất theo repair lag,
chi phí và cảnh báo conflict; tránh chạy chồng. Thời gian phát hiện gồm thời gian
chờ vòng tiếp theo cộng thời gian thực hiện, không có SLA tức thời.

Reconciliation không thay outbox: outbox giữ ý định phát sự kiện sau transaction
và phục vụ consumer cần mọi sự kiện (email, audit, thanh toán). Snapshot chỉ giữ
trạng thái cuối, mất các chuyển tiếp trung gian, nên không tái tạo side effect.

## Kiểm tra

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/34-state-reconciliation/test/lesson.test.mts
node --test --test-timeout=15000 lessons/34-state-reconciliation/test/lesson.test.mts
npm run check
make test
```

Worker không mạng chỉ chạy typecheck/unit; controller chạy HTTP trong Docker cô
lập. HTTP tests dùng các child độc lập, loopback ephemeral, deadline, tmpdir và
finally cleanup; không listen ở test module top level. Import test dùng cấu hình
cố ý sai và yêu cầu child thoát 0, stdout/stderr rỗng. Bộ test bao gồm bỏ update,
xóa, retry không ghi lặp, conflict, partial progress, restart, mất dependency,
maximal escaping và payload quá byte nhưng JSON/schema vẫn hợp lệ. Test redirect
307/308 xác nhận snapshot không đọc origin đích hoặc ghi durable, và cả owner
lẫn reconciler không chuyển apply payload sang projection ở origin đích.

## Bài tập

1. Đặt lịch 30 giây rồi tính repair lag lớn nhất khi một vòng mất 4 giây.
2. Thiết kế metric tuổi lần đối soát thành công, số conflict và số failed; phân
   biệt trạng thái mới hơn snapshot với lỗi nghiệp vụ.
3. Đề xuất điều kiện GC tombstone cho replica offline một tuần; nêu trường hợp
   không thể bảo đảm nếu không có epoch hoặc watermark.

Tham khảo: [Kubernetes controller và desired/current state](https://kubernetes.io/docs/concepts/architecture/controller/),
[Azure materialized view pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view).
