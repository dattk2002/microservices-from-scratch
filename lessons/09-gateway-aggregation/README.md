# 09 — API gateway và kết quả một phần

Một trang sản phẩm cần tên/giá từ catalog và số lượng từ stock. Nếu stock bảo trì,
trang vẫn có thể hiển thị tên và giá, nhưng phải ghi rõ chưa biết tồn kho.
Bài này xây một API tổng hợp chỉ đọc, không phải API đặt hàng.

## Chuẩn bị và chạy

Cần Node.js **24.12+ và <25**, npm và các development package đã được cài ở root
(`npm ci` khi chuẩn bị checkout có mạng). Runtime chỉ dùng built-in Node; chạy trực
tiếp `.mts`, không cần build. Nên hiểu HTTP/status, service ownership, timeout và
các bài 01–08, đặc biệt deadline ở bài 04. Mọi lệnh dưới đây chạy từ root repo.

Mở ba terminal, mỗi terminal chạy một lệnh:

```sh
node lessons/09-gateway-aggregation/catalog.mts
node lessons/09-gateway-aggregation/stock.mts
node lessons/09-gateway-aggregation/gateway.mts
```

Terminal thứ tư:

```sh
curl -i 'http://127.0.0.1:3900/product?sku=tea-01'
curl -i 'http://127.0.0.1:3901/catalog?sku=tea-01'
curl -i 'http://127.0.0.1:3902/stock?sku=tea-01'
```

Dừng stock bằng Ctrl-C, khởi động lại bằng:

```sh
MODE=fail node lessons/09-gateway-aggregation/stock.mts
```

Gọi gateway lần nữa: HTTP 200, `state: "partial"`, giữ catalog và đánh dấu stock lỗi.
Đổi thành `DELAY_MS=1000 node lessons/09-gateway-aggregation/stock.mts` để thấy
`timeout`. Dừng cả hai downstream để thấy HTTP 503. Ctrl-C dừng từng tiến trình.
Không chạy bản thủ công cùng port với dịch vụ khác; thay `PORT` và URL tương ứng
nếu cần. Không có credentials, cloud hay API bên ngoài.

## Ranh giới và luồng gọi

```text
client -> gateway :3900 /product?sku=tea-01
                |-- HTTP -> catalog :3901 /catalog?sku=tea-01
                `-- HTTP -> stock   :3902 /stock?sku=tea-01
```

Catalog sở hữu `{sku,name,priceCents}`, stock sở hữu `{sku,available}`. Ví dụ gốc là
trà sen `tea-01`, giá 42000 đơn vị tiền nhỏ nhất, tồn 7. Dữ liệu fixture nằm trong
bộ nhớ của từng tiến trình; không có database dùng chung. `resources.mts` chỉ tái
sử dụng mã HTTP cho hai chương trình minh họa; không phải datastore chung. Mỗi
request chỉ chọn nhánh của chủ sở hữu tương ứng. Khi triển khai độc lập thật,
hai chủ sở hữu có thể tách repository và persistence riêng.

Gateway không chứa bảng giá, quy tắc tồn kho, giảm giá hay quyết định mua hàng.
Nó kiểm tra đầu vào, gọi cả hai nguồn ngay bằng `Promise.all`, kiểm tra phản hồi
và chọn các trường công khai. Không có retry làm tăng độ trễ và số request.
Không import entrypoint nào tự mở listener: chỉ `import.meta.main` mới khởi động.

## Hợp đồng HTTP

Cả ba endpoint chỉ nhận GET; phương thức khác trả 405 với `Allow: GET`, đường dẫn
khác trả 404. `sku` bắt buộc xuất hiện đúng một lần, dài 1–32 ký tự, bắt đầu bằng
chữ thường ASCII hoặc số, phần sau cho phép thêm dấu `-`. Query khác bị từ chối.
Ví dụ `?sku=tea%0A`, thiếu SKU và SKU trùng trả 400 trước khi gọi downstream.
Lỗi routing/validation dùng `{error:{code,message}}` từ `lib/http.mts`.
Downstream trả 404 cho SKU hợp lệ nhưng không tồn tại; gateway coi mọi status
khác 200 là lỗi nguồn. Vì không biết nguồn kia có resource hay không, gateway
không suy diễn 404 toàn cục từ một downstream.

| Số nguồn thành công | HTTP gateway | `state` | Ý nghĩa với client |
| --- | --- | --- | --- |
| 2 | 200 | `complete` | Có cả hai resource |
| 1 | 200 | `partial` | Chỉ dùng resource có `state: "ok"` |
| 0 | 503 | `unavailable` | Không có dữ liệu hữu ích cho màn hình |

Ví dụ khi stock bảo trì:

```json
{
  "state": "partial",
  "catalog": {"state":"ok","data":{"sku":"tea-01","name":"Trà sen","priceCents":42000}},
  "stock": {"state":"error","code":"upstream_status"}
}
```

Mỗi nguồn luôn có mặt trong envelope: thành công là `{state:"ok",data:...}`, lỗi
là `{state:"error",code:...}`; không có `data` giả, không thay lỗi bằng tồn kho 0.
`timeout` là hết budget, `unreachable` là lỗi transport trước khi nhận header,
`upstream_status` là status khác 200, `invalid_response` là sai content type,
JSON/schema/SKU hoặc lỗi đọc body sau khi nhận header. Không lộ error message hay
body nội bộ. Giá và số lượng phải là số nguyên an toàn không âm; tên dài 1–100.
Mọi JSON response có `Cache-Control: no-store`. Client phải đọc cả HTTP status
và `state`; chỉ đếm HTTP 200 sẽ che mất tỷ lệ suy giảm. Không dùng 206 vì đây
không phải byte-range response. Hợp đồng này cho phép xem sản phẩm; bước checkout
phải tự xác nhận giá/tồn tại service sở hữu, không tin snapshot tổng hợp.

## Cấu hình và deadline

| Biến | Mặc định | Miền hợp lệ / nơi dùng |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Địa chỉ bind của mỗi process |
| `PORT` | 3901 / 3902 / 3900 | 0–65535; 0 chọn port tạm |
| `CATALOG_URL` | `http://127.0.0.1:3901` | HTTP origin, không path/query/credentials |
| `STOCK_URL` | `http://127.0.0.1:3902` | Như trên; gateway dùng cấu hình, không dùng URL từ client |
| `CATALOG_TIMEOUT_MS` | 400 | 10–5000, gateway |
| `STOCK_TIMEOUT_MS` | 300 | 10–5000, gateway |
| `OVERALL_TIMEOUT_MS` | 500 | 10–5000, gateway |
| `DELAY_MS` | 0 | 0–5000, từng downstream, mô phỏng chậm |
| `MODE` | `healthy` | `healthy`, `fail` (503), `invalid` (200 sai schema) ở downstream |

Gateway đặt budget tổng từ lúc handler bắt đầu. Mỗi call kết hợp signal tổng
và signal riêng bằng `AbortSignal.any`. Deadline hiệu dụng là thời điểm sớm hơn
của hai signal; áp dụng cả fetch header lẫn đọc body, không chỉ kết nối. Hai call
chạy đồng thời nên thời gian chờ gần nguồn chậm nhất trong budget, không phải
cộng hai budget. Kết quả đã thành công vẫn được giữ khi nguồn còn lại timeout.
Body downstream tối đa 8192 byte, redirect bị từ chối, body không dùng bị cancel.

Đây là deadline hợp tác trong event loop, không phải bảo đảm thời gian thực.
Nó không bao gồm thời gian request chờ trước handler, truyền response tới client
hay độ trễ do CPU bị nghẽn. `lib/http.mts` giới hạn nhận request/header ở 5 giây.
Timeout hủy việc chờ của gateway, không rollback công việc downstream; fixture
có thể vẫn ngủ hết delay. Vì vậy chỉ dùng GET trong bài. Chưa có truyền deadline
sang downstream, admission control, client-disconnect cancellation, auth,
rate limit, tracing, cache hay circuit breaker. Deadline không ngăn mọi quá tải;
production cần thêm giới hạn concurrent request và quan sát từng nguồn.

## Kiểm thử và bằng chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/09-gateway-aggregation/test/lesson.test.mts
npm run check
make test
git diff --check
```

Hai lệnh đầu không mở socket. Lệnh test riêng chạy cả unit và integration; hai
lệnh `check`/`make test` dành cho môi trường đủ quyền HTTP theo quy ước repo.
Worker không có mạng chỉ chạy typecheck và unit; controller chạy HTTP trong
Docker cô lập có loopback riêng. Không coi việc unit đạt là bằng chứng HTTP đạt.

Unit test được viết trước implementation, kiểm tra validation, bảng trạng thái
và schema/identity; đã quan sát assertion thất bại với stub trước khi triển khai.
Integration dùng `test/support.mts`: spawn Node riêng cho catalog, stock, gateway,
`HOST=127.0.0.1`, `PORT=0`, lấy readiness qua stdout. Cleanup được đăng ký trước
startup và dừng mọi child kể cả khi assertion/startup thất bại. Không listener ở
top-level test. Client test có deadline 5 giây. Các ca kiểm tra healthy và chồng
lấp hai call chậm, lỗi từng nguồn, cả hai lỗi (gồm connection refused), deadline
riêng/tổng, schema lỗi, input sai, route và method. Đo thời gian có khoảng dư cho
scheduler; máy quá tải có thể cần điều tra nếu kiểm tra concurrency thất bại.

## Đánh đổi và bài tập

Gateway giảm số round trip từ client và tập trung hợp đồng tổng hợp, đổi lại có
thêm hop và điểm lỗi chung. Hai resource đọc ở hai thời điểm khác nhau: không có
transaction hay snapshot nhất quán. Nếu nghiệp vụ buộc đủ hai nguồn, cần hợp
đồng khác; không tùy tiện biến một phần thành thành công toàn bộ. Khi resource
và client tăng, tránh để gateway biến thành nơi sở hữu mọi nghiệp vụ.

1. Thiết kế UI cho `partial`: hiển thị giá nhưng ghi “chưa xác định tồn kho”.
   Vì sao không cho đặt hàng dựa trên `available` từ lần đọc này?
2. Thêm resource thứ ba: viết bảng trạng thái và test trước; quyết định nguồn nào
   bắt buộc thay vì giữ máy móc quy tắc “một nguồn là đủ”.
3. Mở rộng fixture để trả JSON sai cú pháp, body quá lớn và body chảy chậm sau
   header; viết kiểm thử HTTP cho từng nhánh bảo vệ.
4. Truyền thời gian còn lại xuống downstream theo bài 04, giữ trần cục bộ, giải
   thích vì sao hủy request không đồng nghĩa rollback.

Tham khảo chính thức: [Microsoft — API gateways trong microservices](https://learn.microsoft.com/en-us/azure/architecture/microservices/design/gateway),
[Node.js — AbortSignal](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal).
