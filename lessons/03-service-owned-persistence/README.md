# Bài 03 — Dữ liệu thuộc từng dịch vụ

Sau bài này, bạn có thể lưu dữ liệu qua lần khởi động lại mà vẫn giữ đúng ranh giới Catalog/Orders. Hai tiến trình Node giao tiếp bằng HTTP; mỗi tiến trình mở **một tệp SQLite riêng**. Orders đọc đơn cũ từ snapshot của mình, kể cả khi Catalog đã dừng.

## Chuẩn bị

- Chạy từ thư mục gốc repository, dùng Node.js 24.12+ thuộc nhánh 24; bài được kiểm chứng với Node 24.20.0.
- `npm ci` để cài công cụ phát triển đã khóa phiên bản. Runtime chỉ dùng built-in, không cần SQLite CLI, Docker, tài khoản hoặc dịch vụ bên ngoài.
- Đọc bài 01 về HTTP và bài 02 về kiểm tra JSON lúc chạy. TypeScript không chứng thực dữ liệu từ HTTP hoặc tệp đã bị sửa.

## Ranh giới dữ liệu

```text
Client ──POST /orders──> Orders ──GET /products/pencil──> Catalog
                           │                               │
                           ▼                               ▼
                     orders.sqlite                   catalog.sqlite
                  snapshot và tổng tiền             tên và giá hiện tại

Client ──GET /orders/:id──> Orders ──đọc orders.sqlite
```

Catalog khởi tạo `pencil` giá 125 cent và `notebook` giá 450 cent. Orders không JOIN bảng Catalog, không import store đang chạy của Catalog và không mở tệp Catalog. Hai dịch vụ dùng chung mã tiện ích trong bài để giảm lặp, nhưng mỗi instance chỉ khởi tạo store của mình. Cùng dùng SQLite không có nghĩa là cùng sở hữu database.

Mỗi đơn chứa `id`, `product: {id, name, priceCents}`, `quantity`, `totalCents`. Giá là số nguyên cent; lượng 1–100 và giá tối đa 100.000.000 giữ tổng trong miền số nguyên an toàn. Snapshot là bản sao đóng băng trong bộ nhớ và một hàng riêng trong database. Bài không cung cấp API sửa đơn; đổi giá Catalog về sau không đổi đơn cũ.

## Chạy hai tiến trình

Terminal 1, từ gốc repository:

```bash
CATALOG_DB_PATH=/tmp/microservices-03-demo/catalog.sqlite PORT=3301 \
  node lessons/03-service-owned-persistence/catalog.mts
```

Terminal 2:

```bash
ORDERS_DB_PATH=/tmp/microservices-03-demo/orders.sqlite PORT=3302 \
  CATALOG_URL=http://127.0.0.1:3301 \
  node lessons/03-service-owned-persistence/orders.mts
```

Terminal 3:

```bash
curl -i http://127.0.0.1:3301/products/pencil
curl -i http://127.0.0.1:3302/orders \
  -H 'Content-Type: application/json' \
  -d '{"productId":"pencil","quantity":2}'
```

POST trả `201`, `Location: /orders/<uuid>` và ví dụ sau (UUID mỗi lần khác nhau):

```json
{
  "id": "b37346d1-3e00-4420-8845-6b1e1af07552",
  "product": {"id": "pencil", "name": "Pencil", "priceCents": 125},
  "quantity": 2,
  "totalCents": 250
}
```

Ghi lại UUID thật. Dừng cả hai terminal dịch vụ bằng Ctrl+C. Chạy lại **chỉ Terminal 2**, giữ nguyên `ORDERS_DB_PATH`. Đọc UUID vừa tạo:

```bash
curl -i http://127.0.0.1:3302/orders/UUID_VUA_NHAN
```

Kết quả vẫn `200` với cùng nội dung. POST mới khi Catalog đang dừng trả `503`; GET đơn đã lưu không gọi Catalog. Không dùng lại UUID mẫu nếu nó không tồn tại trong tệp của bạn. Muốn một lần thực hành mới, chọn thư mục khác trong `/tmp`; chạy lại cùng đường dẫn giữ dữ liệu cũ.

Các biến cấu hình:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `CATALOG_DB_PATH` | `data/catalog.sqlite` bên cạnh source bài | Chỉ Catalog mở tệp này |
| `ORDERS_DB_PATH` | `data/orders.sqlite` bên cạnh source bài | Chỉ Orders mở tệp này |
| `HOST` | `127.0.0.1` | Địa chỉ bind |
| `PORT` | Catalog 3301, Orders 3302 | `0` chọn cổng tạm khi test |
| `CATALOG_URL` | `http://127.0.0.1:3301` | HTTP(S) origin, không user/password/path/query |
| `CATALOG_TIMEOUT_MS` | 500 | Deadline 1–10000 ms, gồm tải body |

Thư mục cha được tạo tự động; đường dẫn tương đối tính từ working directory. Không đặt hai biến DB thành cùng đường dẫn. Khi lỡ mở tệp của dịch vụ còn lại, startup thất bại với `Database belongs to another service`. Dấu nhận diện này là kiểm tra cấu hình; phân quyền filesystem vẫn cần thiết ở hệ thống thật.

## Khởi tạo schema và transaction

`store.mts` mở `DatabaseSync` với busy timeout 1000 ms, rồi `BEGIN IMMEDIATE` trước khi kiểm tra metadata. Tệp mới có `application_id = 0`, `user_version = 0` và chưa có đối tượng schema do ứng dụng tạo. Trong **cùng transaction**, dịch vụ tạo bảng `STRICT`, đặt `application_id` riêng và `user_version = 1`, rồi commit. Chỉ Catalog seed sản phẩm trong lần khởi tạo đó; restart không ghi đè giá hiện có.

Tệp đã có owner khác, schema chưa biết hoặc schema version khác 1 bị từ chối; bài không tự đoán hay xóa schema. Khi phát triển version 2, hãy viết migration riêng của từng dịch vụ: sao lưu, kiểm tra version nguồn, thay đổi schema và cập nhật `user_version` trong transaction, kiểm thử với dữ liệu version 1. Tách schema/migration cũng cho phép hai dịch vụ nâng cấp độc lập.

Khi tạo đơn, Orders kiểm tra request trước, tải và kiểm tra sản phẩm sau, rồi mới mở transaction ghi. Một `INSERT` dùng tham số lưu toàn bộ snapshot và tổng; `COMMIT` hoàn tất **trước** khi trả `201`. Nếu SQL thất bại, rollback giải phóng transaction. Không giữ khóa SQLite trong lúc chờ HTTP. `CHECK` bảo vệ giá, lượng và tổng ở lớp lưu trữ; khi đọc, code kiểm tra lại kiểu và tính nhất quán, trả lỗi `500` nếu dữ liệu lưu bị hỏng thay vì trả snapshot sai.

Đây là transaction **cục bộ của Orders**. Catalog có thể đổi giá ngay sau khi đáp ứng GET; đơn ghi nhận giá Catalog đã trả lúc đọc. Bài chưa có cơ chế giữ giá, thanh toán hay distributed transaction.

## Hợp đồng HTTP và lỗi

| Trường hợp | Status/code |
| --- | --- |
| `GET /products/:id`, `GET /orders/:id` tồn tại | 200 |
| `POST /orders` hợp lệ, đã commit | 201 |
| JSON sai hoặc trường/ID/lượng không hợp lệ | 400 `invalid_json` / `invalid_order` |
| Body trên 8192 byte / sai Content-Type | 413 `body_too_large` / 415 `unsupported_media_type` |
| ID sản phẩm không tồn tại khi tạo đơn | 422 `unknown_product` |
| Tài nguyên/route không tồn tại | 404 |
| Method sai trên route hợp lệ | 405 và header `Allow` |
| Catalog trả dữ liệu sai, thiếu trường, sai ID, JSON hỏng hoặc body quá lớn | 502 `catalog_invalid_response` |
| Catalog không kết nối được hoặc status khác 200/404 | 503 `catalog_unavailable` |
| Deadline đọc Catalog hết hạn | 504 `catalog_timeout` |
| Lỗi SQLite hoặc dữ liệu đã lưu bị hỏng | 500 `internal_error` |

Cả hai có `GET /health` để kiểm tra tiến trình phục vụ HTTP; đây không phải cam kết mọi thao tác database đều thành công. Request chỉ nhận `productId`, `quantity`; client không được chọn giá. Parser sản phẩm chấp nhận trường bổ sung nhưng chỉ sao chép trường đã kiểm tra. Upstream body bị giới hạn 8192 byte, redirect không được theo, timeout bao trùm cả response stream. Các lỗi trước bước ghi không để lại đơn một phần.

## Kiểm chứng

```bash
node --test --test-timeout=15000 lessons/03-service-owned-persistence/test/lesson.test.mts
node --test --test-name-pattern=unit: lessons/03-service-owned-persistence/test/lesson.test.mts
npm run typecheck
```

Test tạo thư mục tạm và cổng loopback `0`; chạy Catalog/Orders bằng child process thật, dừng rồi mở Orders bằng cùng tệp, so sánh toàn bộ đơn và kiểm tra mỗi database chỉ có bảng của chủ sở hữu. Các ca JSON/giá/ID/body/deadline không hợp lệ được kiểm tra cùng số hàng bền vững, và tài nguyên được dọn cả khi assertion thất bại. Không cần chạy dịch vụ thủ công trước test.

## Giới hạn và bài tập

SQLite phù hợp minh họa trên một máy. `DatabaseSync` chạy đồng bộ, khóa ghi và busy timeout có thể chặn event loop; bài chưa có tải lớn, pool, replica, backup tự động hoặc khôi phục sau hỏng ổ đĩa. Tệp riêng trong một repository không cung cấp cách ly bảo mật giữa tiến trình cùng quyền OS. Thư mục `/tmp` có thể bị hệ điều hành dọn; lưu bền vững thực tế cần storage và chính sách backup phù hợp.

Nếu commit xong nhưng kết nối client đứt trước khi nhận `201`, client chưa biết đơn đã tồn tại. Gửi POST lại có thể tạo đơn thứ hai; bài 05 sẽ giải quyết bằng idempotency key. Bài này chưa truyền deadline xuyên nhiều hop hoặc hủy theo client disconnect (bài 04).

1. Đổi giá trong database Catalog khi Catalog đã dừng, chạy lại Catalog, tạo đơn mới và so với đơn cũ. Vì sao Orders không nên cập nhật snapshot cũ?
2. Thiết kế migration thêm `createdAt`; kiểm tra dữ liệu version 1 trước khi nâng version. Dịch vụ nào được quyền chạy migration nào?
3. Giả lập ổ đĩa chỉ đọc hoặc database bị khóa và quan sát `500`; thiết kế mã lỗi riêng cho storage mà không lộ đường dẫn hay chi tiết SQL.

Tham khảo chính thức: [Node.js 24 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [PRAGMA application_id và user_version](https://www.sqlite.org/pragma.html), [STRICT tables](https://www.sqlite.org/stricttables.html).
