# 13 — Bulkhead và cô lập tải giữa các dependency

Khi dịch vụ báo giá vận chuyển bị chậm, người dùng vẫn cần xem danh mục trà.
Nếu gateway dùng chung một giới hạn concurrency, các request vận chuyển có thể
chiếm hết chỗ. Bài này chia ngân sách request đang chạy theo dependency, giống
các khoang kín ngăn sự cố lan trên tàu. Không cần tài khoản hay dịch vụ bên ngoài.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc dòng 24**, npm và các dev dependency đã cài theo lockfile
ở root. Runtime chỉ dùng built-in Node; `.mts` chạy trực tiếp, không cần build.
Nên học bài deadline và circuit breaker trước để đối chiếu chính sách lỗi.
Từ root repo, mở ba terminal:

```sh
node lessons/13-bulkhead-isolation/catalog.mts
```

```sh
node lessons/13-bulkhead-isolation/shipping.mts
```

```sh
CATALOG_CAPACITY=2 SHIPPING_CAPACITY=1 DEADLINE_MS=1000 node lessons/13-bulkhead-isolation/gateway.mts
```

Gọi thử từ terminal khác trong môi trường cho phép HTTP loopback:

```sh
curl -i http://127.0.0.1:4310/catalog
curl -i http://127.0.0.1:4310/shipping
```

Mỗi tiến trình in một dòng JSON readiness chứa port thực sau khi listen thành công.
Dừng bằng Ctrl-C; helper chung đóng listener và cưỡng chế đóng kết nối sau 1 giây.
Không có listener khi import module.

## Kiến trúc và phạm vi

```text
GET /catalog  -> gateway -> Pool catalog  -> HTTP catalog /work
GET /shipping -> gateway -> Pool shipping -> HTTP shipping /work
```

`catalog.mts` và `shipping.mts` là hai tiến trình HTTP độc lập, dùng chung mã
khởi tạo `downstream.mts`. Đây là hai dependency minh họa trả acknowledgement,
không mô phỏng thanh toán hay vận chuyển thật. Gateway chỉ trả trạng thái thành công,
không chuyển tiếp dữ liệu tùy ý từ downstream. Tái sử dụng `lib/http.mts` cho
HTTP contract, cấu hình số và shutdown; bài không phụ thuộc mã bài trước.

`Pool.acquire()` đồng bộ kiểm tra số permit đang giữ. Trong một event loop,
kiểm tra và tăng bộ đếm không có điểm `await`, nên hai caller không thể chen vào
giữa chúng. Hết chỗ trả `undefined` ngay, không tạo hàng đợi hoặc timer chờ chỗ.
Release đóng trên cờ riêng, gọi hai lần cũng chỉ giảm bộ đếm một lần.

`runBounded()` kiểm tra signal rồi lấy permit **trước** khi gọi callback thực hiện
`fetch`. Callback luôn được `await` trong `try/finally`; success, throw và abort đều
đi qua release. Abort không giải phóng sớm bằng `Promise.race`: callback phải thật sự
kết thúc để không đếm thiếu công việc còn đang chạy. Caller phải truyền signal vào
I/O và hợp tác hủy; callback bỏ qua signal có thể giữ permit mãi. Gateway truyền
signal vào fetch, hủy response body và chỉ gửi 200 sau khi permit đã được trả.

Pool sống trong **một instance gateway**, không phải semaphore phân tán. Ba replica
với capacity catalog bằng 2 cho phép tối đa 6 request catalog từ các gateway đó;
request gọi thẳng downstream không bị giới hạn. Một pool riêng không cô lập CPU,
heap, socket, event loop hoặc băng thông toàn máy. Downstream có thể tiếp tục xử lý
sau khi client đóng socket; abort không phải rollback nghiệp vụ.

## Cấu hình

Giá trị sai làm tiến trình thất bại trước khi listen. Số cấu hình qua helper phải
là chuỗi chữ số nguyên trong khoảng cho phép.

| Biến | Mặc định | Ràng buộc/phạm vi |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind host cho từng tiến trình |
| `PORT` | gateway 4310, catalog 4311, shipping 4312 | 0..65535; 0 để hệ điều hành chọn port |
| `CATALOG_URL` | `http://127.0.0.1:4311` | HTTP origin, không credentials/path/query/hash |
| `SHIPPING_URL` | `http://127.0.0.1:4312` | HTTP origin cùng quy tắc |
| `CATALOG_CAPACITY` | 2 | 1..1000, request catalog đang chạy |
| `SHIPPING_CAPACITY` | 2 | 1..1000, request shipping đang chạy |
| `DEADLINE_MS` | 1000 | 10..10000, ngân sách mỗi request gọi downstream |
| `TEST_CONTROLS` | tắt | Chỉ `1` bật các endpoint barrier trên downstream |

Ví dụ lệnh chạy đặt shipping capacity bằng 1 để thấy hai ngân sách khác nhau.
Deadline bắt đầu sau validation tại gateway; không bao gồm thời gian request còn
ở mạng trước đó. Client ngắt kết nối làm signal abort qua sự kiện response `close`.

## HTTP contract

Tất cả JSON có `Cache-Control: no-store`. Không có retry tự động.

| Endpoint/trạng thái | Response |
| --- | --- |
| `GET /catalog` thành công | 200 `{"dependency":"catalog","state":"ok"}` |
| `GET /shipping` thành công | 200 tương tự với `shipping` |
| Hết permit | 503 `{"error":{"code":"bulkhead_full","dependency":"catalog"}}`, `Retry-After: 1` |
| Downstream status khác 200 | 502, code `dependency_failed` |
| Lỗi kết nối hoặc redirect | 502, code `dependency_unreachable` |
| Hết deadline | 504, code `deadline_exceeded` |
| Query bất kỳ / sai method / sai route | 400 `invalid_query` / 405 `method_not_allowed` với `Allow: GET` / 404 `not_found` |

Các lỗi qua `HttpError` có dạng `{"error":{"code":"...","message":"..."}}`.
503 nói rằng gateway đang đầy, không khẳng định downstream chết. `Retry-After` là
gợi ý 1 giây, không đặt chỗ và không đảm bảo lần sau thành công. Client retry cần
ngân sách tổng, backoff và jitter; retry dồn dập có thể làm tải xấu thêm.

Để quan sát thủ công, khởi động lại catalog với `TEST_CONTROLS=1`, sau đó:

```sh
curl -X POST 'http://127.0.0.1:4311/control?mode=hold'
curl http://127.0.0.1:4310/catalog &
curl http://127.0.0.1:4310/catalog &
curl 'http://127.0.0.1:4311/barrier?count=2'
curl -i http://127.0.0.1:4310/catalog
curl -i http://127.0.0.1:4310/shipping
curl -X POST 'http://127.0.0.1:4311/control?mode=open'
wait
```

Dùng `DEADLINE_MS=10000` khi thử để có thời gian thao tác; nếu chậm hơn deadline,
request đã bị hủy và chỗ có thể đã trống. `POST /control?mode=fail` mở barrier và
trả 500 cho `/work`; `open` phục hồi 200. `/stats` trả tổng `entered` và số request
đang giữ ở barrier `active`. `GET /barrier?count=N` đợi tổng số lần vào `/work` đạt N,
trả 200 hoặc 408 sau 3 giây; count là tích lũy từ lúc tiến trình khởi động.
Các route điều khiển không có authentication, chỉ dùng fixture local, mặc định tắt;
không triển khai fixture ra mạng công cộng.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/13-bulkhead-isolation/test/lesson.test.mts
```

Lệnh cuối cần môi trường được phép bind và gọi HTTP loopback. Worker không có mạng
chỉ chạy hai lệnh đầu; outer controller chạy integration trong Docker network cô lập.
Kiểm tra toàn repo trong môi trường controller: `npm run check`, `make test` và
`git diff --check`. Không chạy Docker từ worker.

Unit test kiểm tra cấu hình capacity, admission, release idempotent, từ chối trước
callback, trả chỗ sau success/error/cancel và signal đã abort trước admission.
Integration dùng `test/support.mts` spawn ba PID riêng, port 0 trên loopback và
hook cleanup kể cả assertion fail. Không listen ở top level test.

Barrier xác nhận hai request catalog đã tới downstream và đang bị giữ trước khi
gửi request thứ ba. Request thứ ba phải nhận 503 trong budget 1,5 giây trong khi
hai request đầu có deadline 8 giây; `entered` vẫn bằng 2 chứng minh request bị từ
chối chưa chạy downstream. Shipping vẫn trả 200. Kiểm thử đối xứng giữ shipping
để kiểm tra pool capacity 1 của nó. Kiểm thử lỗi gọi nhiều lần hơn capacity rồi
phục hồi. Kiểm thử deadline giữ hai request, nhận 504, quan sát downstream thấy
socket đóng, rồi giữ được hai request mới bằng barrier count 4 trước khi mở.
Polling có deadline chỉ dùng để quan sát sự kiện đóng socket bất đồng bộ; việc
lấp đầy pool dùng barrier, không dùng sleep để đoán.

## So sánh và giới hạn

| Chính sách | Câu hỏi trả lời | Trạng thái chính |
| --- | --- | --- |
| Bulkhead | Dependency này đang dùng bao nhiêu chỗ? | Request đang chạy |
| Circuit breaker | Gần đây dependency có thất bại đủ nhiều để tạm ngắt không? | Lịch sử lỗi và cửa sổ phục hồi |
| Rate limit | Trong khoảng thời gian này nhận bao nhiêu request? | Token hoặc bộ đếm theo thời gian |

Rate thấp vẫn có thể đầy concurrency nếu mỗi request rất chậm; concurrency thấp
vẫn có thể tạo nhiều request mỗi giây nếu chúng rất nhanh. Bulkhead tiếp tục gọi
một downstream lỗi khi còn permit; breaker có thể từ chối dù pool trống. Chúng
có thể kết hợp nhưng phải định nghĩa thứ tự admission, retry và deadline rõ ràng.

Không có fairness hay hàng đợi: caller mới có thể lấy chỗ vừa trống trước caller
đã từng bị từ chối. Capacity cố định cần đo latency và tải thực; quá nhỏ làm mất
throughput, quá lớn dời điểm nghẽn xuống downstream. Bài chưa có metrics vận hành,
giới hạn tổng request, giới hạn theo tenant hay phân phối quota giữa replica.

## Bài tập

1. Thêm metric admitted/rejected/in-flight theo dependency; giữ số label hữu hạn.
2. Thiết kế retry budget phía client và giải thích vì sao không retry ngay mọi 503.
3. Thêm pool cho dependency thứ ba; viết barrier test chứng minh hai pool cũ vẫn dùng được.
4. Tính tổng concurrency khi autoscale từ 2 lên 8 replica; đề xuất giới hạn tại
   downstream nếu tổng capacity vượt sức chịu tải.

Tham khảo: [Microsoft Azure Architecture — Bulkhead pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead),
[Node.js AbortSignal](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal),
[HTTP 503 và Retry-After (RFC 9110)](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable).
