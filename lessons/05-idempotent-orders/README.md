# 05 — Tạo đơn có idempotency

Client có thể mất response dù server đã ghi đơn. Nếu client gửi lại một POST
thông thường, server có thể tạo thêm đơn. Bài này bổ sung **Idempotency-Key**:
client chọn một khóa cho một ý định tạo đơn và giữ nguyên khóa khi gửi lại.
Orders lưu khóa, fingerprint và response thành công cùng đơn trong SQLite.

Cần Node **24.12+ thuộc nhánh 24**, hiểu HTTP/JSON và transaction ở bài 03.
Đây là ví dụ gốc, chạy độc lập với các bài trước, không cần Docker, tài khoản,
dịch vụ cloud hoặc thư viện runtime ngoài Node. Dependency phát triển được pin
ở gốc repo; nếu chưa có, dùng `npm ci --ignore-scripts` trong môi trường cho phép.

## Ranh giới và luồng xử lý

```text
Client -- POST /orders + Idempotency-Key --> Orders process
                                             |       |
                           HTTP GET product --+       +-- SQLite riêng của Orders
                                  |                      orders + replays
                             Catalog process
```

Catalog sở hữu giá và cung cấp `GET /products/pencil`. Orders chỉ nhận JSON qua
HTTP, kiểm tra runtime rồi chụp snapshot; không đọc database hay import dữ liệu
Catalog. Catalog ở bài này dùng dữ liệu mẫu trong process, không có file DB.
Hai process chỉ dùng lại plumbing HTTP ở `lib/http.mts`, không phụ thuộc bài 03/04.

1. Orders kiểm tra header, JSON và input, rồi chuẩn hóa productId bằng `trim()`.
2. Fingerprint SHA-256 lấy từ `JSON.stringify([productId, quantity])` theo thứ tự
   cố định; thứ tự thuộc tính trong JSON đầu vào không ảnh hưởng kết quả.
3. Nếu SQLite đã có khóa: cùng fingerprint trả lại **201 và đúng chuỗi JSON đã
   lưu**; khác fingerprint trả 409. Nhánh replay không gọi Catalog.
4. Nếu khóa đang xử lý trong process: cùng fingerprint cùng chờ một Promise;
   khác fingerprint nhận 409 ngay, không phải chờ Catalog.
5. Khóa mới gọi Catalog bằng GET với deadline. Sau khi nhận snapshot hợp lệ,
   Orders chạy transaction đồng bộ: `BEGIN IMMEDIATE`, kiểm tra lại khóa, ghi
   `orders` và `replays`, `COMMIT`. Không giữ transaction qua bất kỳ `await` nào.

Không cache lỗi vào SQLite. HTTP error hay lỗi transaction giải phóng Promise
trong `finally`; lần gửi sau có thể thử lại. Thành công mới giữ khóa lâu dài.
Trong lúc Promise chưa kết thúc, input khác vẫn bị 409; sau một lần thất bại
không tạo record, khóa chưa thuộc về input nào nên có thể dùng lại.

## Hợp đồng chính xác

| Thành phần | Quy tắc |
|---|---|
| Route Orders | `POST /orders`, `content-type: application/json`; GET trả 405/Allow |
| Idempotency-Key | Đúng một header, 1..128 ký tự `[A-Za-z0-9:_-]`, phân biệt hoa thường |
| productId | Chuỗi sau trim dài 1..64, chỉ `[a-z0-9-]` |
| quantity | Số nguyên an toàn 1..100; không ép chuỗi thành số |
| Trường đầu vào | Chỉ productId và quantity; từ chối trường lạ |
| Body request | Tối đa 8192 byte; JSON hỏng 400, media type sai 415, quá lớn 413 |
| Response mới/replay | 201, cùng id, product snapshot, quantity và totalCents; cùng body từng byte |
| Khóa cũ, input khác | 409 `idempotency_conflict`, kể cả đang xử lý trong cùng process |
| Catalog | `GET /products/pencil` trả id, name, priceCents; sản phẩm khác 404 |
| Health | `GET /health`, 200 liveness, không kiểm tra Catalog |

Header lặp bị từ chối dựa trên `headersDistinct`, kể cả cùng giá trị. HTTP parser
của Node có thể loại bỏ whitespace bao quanh giá trị header trên wire; hợp đồng
áp dụng lên giá trị đã được parser HTTP nhận. Không nhận danh sách khóa nối bằng
comma. Chuẩn hóa input chỉ trim productId, không đổi chữ hoa hoặc gộp số lượng.
Ví dụ `{"quantity":2,"productId":" pencil "}` cùng fingerprint với
`{"productId":"pencil","quantity":2}`, nhưng quantity 3 là ý định khác.
Giả định hash SHA-256 không va chạm trong phạm vi bài học.

Parser Catalog yêu cầu id đúng sản phẩm, name không rỗng sau trim và dài tối đa
200 ký tự, giá cent nguyên an toàn không âm. Giá tối đa
`floor(Number.MAX_SAFE_INTEGER / 100)` bảo đảm phép nhân với mọi quantity hợp lệ
vẫn an toàn. Trường Catalog bổ sung được bỏ qua. JSON qua mạng có kiểu `unknown`;
TypeScript không thay thế kiểm tra runtime. Đơn mẫu 2 bút chì có tổng 250 cent,
quy ước USD, không có thanh toán, giữ hàng hay tác dụng phụ tại Catalog.

## Chạy thử và khởi động lại

Từ gốc repo, mở hai terminal:

```sh
# Terminal A: Catalog, port 4501
node lessons/05-idempotent-orders/catalog.mts
```

```sh
# Terminal B: Orders, port 4502; tự tạo thư mục cha của DB
ORDERS_DB=/tmp/lesson05-orders.sqlite CATALOG_URL=http://127.0.0.1:4501 \
  node lessons/05-idempotent-orders/orders.mts
```

```sh
curl -i http://127.0.0.1:4502/orders \
  -H 'content-type: application/json' -H 'Idempotency-Key: checkout-001' \
  -d '{"productId":"pencil","quantity":2}'
# Chạy lại cùng lệnh: vẫn 201, cùng id và body.

curl -i http://127.0.0.1:4502/orders \
  -H 'content-type: application/json' -H 'Idempotency-Key: checkout-001' \
  -d '{"productId":"pencil","quantity":3}'
# 409: một khóa không đại diện cho hai ý định khác nhau.
```

Dừng Orders bằng Ctrl+C, chạy lại đúng lệnh Terminal B với **cùng ORDERS_DB**.
Dừng cả Catalog, gửi lại request đầu: vẫn 201 từ SQLite. Một khóa mới khi Catalog
đã dừng nhận 503. Khởi động lại Catalog rồi thử lại khóa mới đó: có thể thành công.
Muốn tạo đơn độc lập dù input giống nhau, client dùng khóa mới.

| Biến môi trường | Mặc định và giới hạn |
|---|---|
| HOST | 127.0.0.1; giữ loopback khi học |
| PORT | Catalog 4501, Orders 4502; 0..65535; 0 chọn port tạm và log port JSON |
| CATALOG_URL | http://127.0.0.1:4501; HTTP origin không credentials/path/query/hash |
| CATALOG_TIMEOUT_MS | 1000; số nguyên 1..10000, bao gồm header và toàn body |
| ORDERS_DB | ./data/lesson05-orders.sqlite; riêng Orders, giữ nguyên qua restart |

Client học tập chưa có authentication; namespace khóa là toàn bộ DB. Ứng dụng có
nhiều khách hàng phải xác thực và gắn khóa với danh tính/tenant, endpoint, phiên
bản hợp đồng. Không dùng nguyên namespace toàn cục này cho nhiều người dùng.

## Atomicity, process và khôi phục

`orders(id PRIMARY KEY, snapshot)` giữ đơn; `replays(key PRIMARY KEY,
fingerprint, order_id UNIQUE REFERENCES orders(id), status, body)` giữ response.
Status có CHECK = 201, các chuỗi snapshot/body có CHECK JSON hợp lệ. Foreign keys
được bật cho từng connection. Schema tạo trong transaction, `user_version=1`;
phiên bản DB khác 0/1 làm service từ chối khởi động. Đây là khởi tạo phiên bản 1,
không phải hệ thống migration tổng quát hay kiểm tra toàn vẹn file bị chỉnh tay.

Map Promise chỉ thuộc **một process**, tối đa 1024 khóa đang hoạt động; vượt số đó
trả 503 `orders_busy`. Nó không phải distributed lock. Hai Orders process cùng
một DB có thể cùng gọi Catalog trước khi có record. `BEGIN IMMEDIATE` giành quyền
ghi, kiểm tra lại khóa bên trong transaction, cùng PRIMARY KEY là hàng rào bền:
cùng input nhận record thắng cuộc; khác input thì một 201, một 409. Chỉ có một
đơn mới được commit cho một khóa. SQLite chờ khóa tối đa 1000ms; lỗi lock hoặc
I/O không dự kiến trả 500, client có thể gửi lại cùng khóa. Cách chia sẻ file ở
đây chỉ minh họa các process của **cùng dịch vụ Orders trên một máy**, tuyệt đối
không chia sẻ DB giữa Orders và Catalog hay coi đây là kiến trúc nhiều node.

| Điểm thất bại | Trạng thái và hành động |
|---|---|
| Catalog lỗi/timeout | Chưa có transaction; không đơn/record bền; thử lại cùng khóa |
| Crash trước transaction | Có thể đã đọc Catalog; thử lại sẽ đọc lại |
| Ghi đơn được nhưng ghi replay lỗi | ROLLBACK cả hai; không có đơn mồ côi |
| Crash trong transaction | SQLite recovery giữ trạng thái commit trước đó hoặc cả transaction thành công |
| Commit xong nhưng response mất/client ngắt kết nối | Gửi lại cùng khóa để lấy response đã lưu |
| Crash sau commit, restart | Lookup SQLite phát lại response; không đọc giá hiện tại từ Catalog |

Process không hủy công việc chung khi một client ngắt kết nối: client khác có thể
đang chờ cùng khóa và đơn vẫn có thể commit. Deadline upstream giới hạn công việc
đó; đây không phải bài truyền cancellation xuyên tầng. Không có durable pending
record nên không cần quét các khóa pending bị bỏ dở. Tuy nhiên nếu mất/corrupt DB,
ổ đĩa không bảo đảm durability hoặc người vận hành xóa record, guarantee không còn.
Cần backup/recovery và vận hành thực tế trước khi triển khai sản phẩm.

Không có TTL hay tác vụ dọn khóa: record tồn tại đến khi DB bị quản lý bên ngoài,
dung lượng tăng theo số đơn. Thêm retention phải định nghĩa thời gian client còn
được phép retry; xóa khóa quá sớm có thể tạo đơn mới khi request cũ xuất hiện.
Bài không có GET đơn, transaction phân tán, retry tự động hoặc deployment.

**Không phải exactly-once networking.** Request và GET Catalog có thể lặp; mất
kết nối không chứng minh server chưa làm gì. Guarantee là tối đa một thay đổi
đơn đã commit cho mỗi khóa còn lưu, và phát lại response thành công tương ứng.
Catalog GET ở đây chỉ đọc. Nếu đổi sang thao tác Payment/Inventory có tác dụng
phụ, atomicity của SQLite Orders không bao trùm dịch vụ kia: cần idempotency ở
dịch vụ đích, outbox/saga và quy trình khôi phục riêng.

## Giới hạn HTTP và kiểm thử

Upstream chỉ chấp nhận status 200; Catalog 404 thành 422 `unknown_product`, status
khác thành 502 `catalog_bad_status`. Body Catalog phải JSON, tối đa 8192 byte, đọc
stream trong cùng deadline; sai cấu trúc/media type/JSON/quá lớn thành 502
`catalog_invalid_response`. Redirect bị từ chối, lỗi kết nối thành 503
`catalog_unavailable`, hết hạn thành 504 `catalog_timeout`. Các lỗi khác dùng 500
`internal_error`, không gửi stack trace. Route lạ 404; method sai 405/Allow.
HTTP server đặt request/header timeout 5 giây theo helper chung; đó không phải
giới hạn số kết nối đồng thời hay chính sách chống abuse đầy đủ.

```sh
npm run typecheck
node --test --test-name-pattern=unit: lessons/05-idempotent-orders/test/lesson.test.mts
# Cần môi trường cho phép mở loopback socket:
node --test --test-timeout=15000 lessons/05-idempotent-orders/test/lesson.test.mts
# Kiểm tra toàn repo do coordinator thực hiện:
npm run check
make test
```

Unit test đã được viết trước parser, quan sát assertion thất bại rồi mới thay
stub. Integration khởi động child process riêng, port 0, SQLite trong thư mục tạm,
HTTP thật và cleanup SIGTERM/SIGKILL dự phòng. Fixture riêng trong `test/` có cổng
barrier: giữ Catalog chưa trả kết quả để kiểm tra conflict đang in-flight; hai
Orders process đều phải đến barrier trước khi cho transaction đua nhau. Không
có endpoint kiểm thử trong Catalog/Orders thật, không dùng sleep để suy đoán race.

Các case gồm 12 request cùng khóa/cùng body, payload đổi trong khi đang xử lý,
conflict sau commit, normalize/replay, hai process cùng DB với input giống/khác,
restart khi Catalog tắt, input/header/media type/JSON/body lớn, upstream lỗi status,
sai kiểu/body lớn/JSON hỏng/media type sai, deadline trước header và giữa body,
rollback do SQLite trigger từ chối ghi replay rồi retry thành công. Test gọi cả
Catalog gốc và Orders gốc để tránh chỉ kiểm chứng fixture. Trigger chỉ được test
tạo trong DB tạm, không có hook phá lỗi trong production code.

## Tự luyện

1. Thiết kế namespace khóa theo tenant đã xác thực và thêm test không lộ response
   giữa hai tenant có cùng chuỗi khóa.
2. Đề xuất retention 24 giờ: response retry sau giờ thứ 25 phải có hợp đồng gì?
3. Thêm `GET /orders/:id` từ snapshot; chứng minh Catalog ngừng vẫn đọc được đơn.
4. Thay GET Catalog bằng giữ hàng có tác dụng phụ. Vẽ điểm crash cần khôi phục
   và giải thích vì sao transaction hiện tại chưa đủ.
5. Giới hạn số waiter cho mỗi khóa và tổng request; xác định status/backpressure
   mà không làm hỏng replay các đơn đã hoàn thành.

Nguồn đọc thêm: [RFC 9110 — idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)
giải thích ngữ nghĩa HTTP; POST này có hợp đồng ứng dụng bổ sung.
[Node.js 24 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html)
mô tả DatabaseSync/StatementSync và prepared statement.
[SQLite transactions](https://www.sqlite.org/lang_transaction.html) giải thích
BEGIN IMMEDIATE và một writer; [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
giải thích recovery và các giả định storage. Bài không sao chép prose nguồn.
