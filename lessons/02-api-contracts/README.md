# 02 — Hợp đồng API và tương thích phiên bản

Bài này tiếp nối ranh giới Catalog/Orders: Catalog có thể triển khai phiên bản mới
mà Orders đang dùng v1 vẫn chạy. Cần Node **24.12+ thuộc nhánh 24**, kiến thức HTTP,
JSON và bài 01. Runtime chỉ dùng built-in; TypeScript chạy trực tiếp bằng Node,
không cần biên dịch hay dịch vụ bên ngoài. Các gói phát triển đã pin ở gốc repo.

## Kiến trúc và hợp đồng

```text
Client -- POST /orders --> Orders (process B)
                              |
                              +-- GET /v1/products/pencil --> Catalog (process A)
                                  unknown JSON -> parser -> V1Product
Client mới ---------------------- GET /v2/products/pencil --> Catalog
```

Catalog sở hữu giá; Orders không import dữ liệu Catalog. Orders chỉ import parser
thuần của chính bài học và tạo snapshot từ các trường đã kiểm tra. Hai entrypoint
chạy độc lập; không cần khởi động bài 01. Chúng dùng lại tiện ích HTTP và test của
repo để tránh lặp plumbing, không dùng trạng thái hay service của bài trước.

| Route | Phản hồi thành công |
|---|---|
| Catalog GET /v1/products/pencil | 200, `{"id":"pencil","name":"Bút chì","priceCents":125}` |
| Catalog GET /v2/products/pencil | 200, `{"id":"pencil","name":"Bút chì","price":{"amountCents":125,"currency":"USD"}}` |
| Orders POST /orders | 201, `id` UUID, `product` snapshot v1, `quantity`, `totalCents` |
| Cả hai /health | 200, `{"status":"ok"}`; liveness, không kiểm tra dependency |

POST nhận đúng `{"productId":"pencil","quantity":2}`. Identifier dài 1..64,
chỉ chữ thường ASCII, số và dấu `-`; quantity nguyên 1..100. Không nhận giá hoặc
trường bổ sung từ client. Ví dụ trên trả tổng **250 cent USD**, không có thanh toán.
Orders không lưu đơn, không có GET đơn hay Location; UUID chỉ đánh dấu kết quả
một lần xử lý. Đây là bài về hợp đồng đọc sản phẩm, không thay thế tính năng lưu
snapshot trong bài 01.

Parser v1 nhận `unknown`, không có I/O hay thay đổi input. Nó yêu cầu object không
phải array, id đúng cú pháp và trùng id được hỏi, name là chuỗi không rỗng sau trim,
priceCents là số nguyên an toàn không âm. Giá 0 hợp lệ; chuỗi `"125"`, NaN,
Infinity, số lẻ, số vượt MAX_SAFE_INTEGER đều bị từ chối. Parser trả object mới
chỉ có ba trường cần dùng, chấp nhận trường response lạ như stock hoặc tags.
Input tạo đơn chặt và response đọc mở là hai chính sách khác nhau có chủ đích.

**TypeScript không kiểm tra JSON qua mạng.** Type bị xóa khi chạy; viết một kiểu
hay ép `as V1Product` không chứng minh dữ liệu đúng. Ở đây `response.json()` được
gán vào `unknown`, rồi narrowing bằng kiểm tra runtime tạo ra kiểu có thể tin dùng.
Parser còn so sánh id để không nhận nhầm sản phẩm dù cấu trúc JSON hợp lệ.

Thêm stock vào v1 tương thích với consumer này vì các trường cũ giữ nguyên nghĩa.
Đổi priceCents thành chuỗi hoặc chuyển sang object price là thay đổi phá vỡ hợp
đồng. Catalog cung cấp v2 song song thay vì âm thầm thay v1; Orders vẫn gọi đường
dẫn v1 cố định. Không tự fallback v2 vì cần quyết định rõ cách xử lý currency.
Việc thêm trường không tự bảo đảm tương thích với mọi consumer khác: consumer
kiểm tra exact keys, hoặc thay đổi ý nghĩa/đơn vị của giá, vẫn có thể gây lỗi.

## Chạy và quan sát

Từ gốc repo, môi trường đã cài dependency phát triển; nếu chưa, cài bằng
`npm ci --ignore-scripts` ở môi trường được phép truy cập registry. Mở hai terminal:

```sh
# Terminal A
node lessons/02-api-contracts/catalog.mts
```

```sh
# Terminal B
CATALOG_URL=http://127.0.0.1:4201 node lessons/02-api-contracts/orders.mts
```

```sh
curl -i http://127.0.0.1:4201/v1/products/pencil
curl -i http://127.0.0.1:4201/v2/products/pencil
curl -i http://127.0.0.1:4202/orders -H 'content-type: application/json' \
  -d '{"productId":"pencil","quantity":2}'
```

Dừng Catalog bằng Ctrl+C rồi khởi động lại một trong hai chế độ sau, giữ Orders
đang chạy và gửi lại cùng POST:

```sh
CATALOG_MODE=additive node lessons/02-api-contracts/catalog.mts
# v1 thêm stock/tags; Orders vẫn 201, snapshot không chứa trường lạ.
```

```sh
CATALOG_MODE=incompatible node lessons/02-api-contracts/catalog.mts
# v1 cố tình trả priceCents dạng chuỗi; Orders trả 502 catalog_invalid_response.
```

Hai chế độ này là fixture minh họa lỗi triển khai provider, không phải chế độ
production hay dữ liệu nhận từ request. v2 vẫn trả schema lồng nhau ở mọi chế độ.

| Cấu hình | Mặc định và giới hạn |
|---|---|
| HOST | 127.0.0.1; nên giữ loopback khi học |
| PORT | Catalog 4201, Orders 4202; 0..65535, 0 chọn cổng tạm và log JSON port |
| CATALOG_URL | http://127.0.0.1:4201; HTTP origin không user/password/path/query/hash |
| CATALOG_TIMEOUT_MS | 1000; số nguyên 1..10000, bao gồm fetch và đọc body |
| CATALOG_MODE | baseline, additive hoặc incompatible; mặc định baseline |

Dừng cả hai bằng Ctrl+C. Port 0 cần lấy port thực từ log và truyền origin tương
ứng cho Orders; không đặt CATALOG_URL có port 0.

## Lỗi và giới hạn

Lỗi dùng `{"error":{"code":"...","message":"..."}}`, không gửi stack trace.
Route lạ trả 404; method sai trên route sản phẩm/orders trả 405 kèm Allow.
Health là ngoại lệ đơn giản, trả liveness cho mọi method. Catalog thiếu sản phẩm
trả 404; Orders ánh xạ thành 422 unknown_product. Body POST sai JSON trả 400,
không phải application/json trả 415, quá 8192 byte trả 413; giá trị input sai trả
400 invalid_order. Catalog trả status ngoài 200/404 thành 502 catalog_bad_status;
JSON hỏng, content-type sai hoặc sản phẩm sai thành 502 catalog_invalid_response.
Mất kết nối trả 503 catalog_unavailable, hết deadline trả 504 catalog_timeout.
Redirect upstream bị từ chối và được phân loại 503. Tổng giá vượt số nguyên an
toàn cũng trả 502. Lỗi ngoài dự kiến trả 500 internal_error.

Không retry, cache, xác thực, lưu bền, idempotency hay thương lượng phiên bản.
Response Catalog được đọc trọn trong deadline nhưng chưa giới hạn byte: không
nên dùng nguyên mẫu này với provider không tin cậy; deadline không thay thế giới
hạn bộ nhớ. Parser chỉ kiểm chứng cấu trúc/quy tắc đã viết, không chứng minh giá
đúng nghiệp vụ. V1 ngầm dùng USD; việc hỗ trợ nhiều tiền tệ cần hợp đồng mới.
Giữ nhiều phiên bản làm tăng chi phí bảo trì; trước khi ngừng v1 cần thống kê
consumer và thống nhất lịch chuyển đổi, không chỉ thấy v2 đã triển khai.

## Kiểm thử

```sh
npm run typecheck
npm run test:unit
# Chỉ ở môi trường được phép mở socket:
node --test --test-timeout=15000 lessons/02-api-contracts/test/lesson.test.mts
npm run check
make test
```

Unit fixtures được viết trước implementation: kiểm tra trường bổ sung được bỏ
qua, giá 0 và các trường thiếu/sai kiểu/id/giá bất hợp lệ. Đã quan sát assertion
thất bại với parser tạm trước khi triển khai parser thật. Unit không mở listener.
Các test `integration:` khởi động Catalog và Orders bằng child process riêng,
HOST loopback, PORT=0; so sánh PID, gọi HTTP thật, kiểm tra cả schema v2 và kết quả
Orders vẫn dùng v1 ở ba chế độ, các status lỗi và khi Catalog dừng. Mỗi request
client có deadline 5 giây; cleanup đăng ký ngay sau startup, dùng SIGTERM và
SIGKILL dự phòng qua helper. Không listener nào chạy ở top-level của test module.

Trong worker không mạng, chỉ typecheck và unit được chạy; HTTP integration,
`npm run check` và `make test` được giao controller trong môi trường cô lập.
Không coi việc viết integration test là bằng chứng chúng đã pass.

## Tự luyện

1. Thêm trường warehouse vào v1 và giải thích vì sao Orders không cần sửa.
2. Đổi đơn vị priceCents sang mill bằng cách giữ tên trường: parser có phát hiện
   được không? Viết yêu cầu hợp đồng ngăn sai lệch ngữ nghĩa này.
3. Thiết kế parser v2 có currency; quyết định xử lý currency ngoài USD trước khi
   chuyển Orders. Thêm fixture sai currency và unit test trước implementation.
4. Bổ sung giới hạn byte cho response, test HTTP body quá lớn và timeout giữa body.
5. Lập tiêu chí ngừng v1 khi còn consumer chưa chuyển; so sánh với ép chuyển ngay.

Nguồn gốc để đọc thêm: [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
giải thích cách thu hẹp unknown bằng kiểm tra; [Node.js 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)
mô tả server, response và vòng đời kết nối. Các ví dụ trong bài được viết riêng.
