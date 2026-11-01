# 07 — Circuit breaker và half-open

Một dịch vụ báo giá liên tục trả 503. Timeout giúp từng người gọi không chờ mãi,
nhưng mỗi yêu cầu mới vẫn tiếp tục đập vào dịch vụ đang hỏng. Bài này đặt circuit
breaker trước lời gọi HTTP: sau một số lỗi liên tiếp, client từ chối ngay trong
bộ nhớ; sau khoảng nghỉ, một nhóm probe nhỏ kiểm tra khả năng phục hồi.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc nhánh 24**, npm và các development dependencies đã được
cài từ lockfile ở gốc repository. Không có runtime package, API bên ngoài hay
credentials. Nên hiểu HTTP service boundaries, deadline và safe retry ở các bài
01, 04, 06 trước khi học. Chạy mọi lệnh dưới đây từ gốc repository.

Terminal A — dependency giả lập lỗi hai lần rồi hồi phục:

```sh
HOST=127.0.0.1 PORT=4701 FAIL_FIRST=2 node lessons/07-circuit-breaker/upstream.mts
```

Terminal B — client có breaker:

```sh
HOST=127.0.0.1 PORT=4700 UPSTREAM_URL=http://127.0.0.1:4701 FAILURE_THRESHOLD=2 COOLDOWN_MS=1000 MAX_PROBES=1 TIMEOUT_MS=500 node lessons/07-circuit-breaker/client.mts
```

Terminal C — hai lần lỗi, một lần bị chặn, rồi một probe thành công:

```sh
curl -i http://127.0.0.1:4700/quote
curl -i http://127.0.0.1:4700/quote
curl -i http://127.0.0.1:4700/quote
curl -s http://127.0.0.1:4701/state
sleep 1.1
curl -i http://127.0.0.1:4700/quote
curl -s http://127.0.0.1:4700/state
```

Khi ba lệnh đầu nằm trong khoảng nghỉ một giây, hai response đầu là 503
`quote_unavailable`, response thứ ba là 503 `circuit_open`; upstream mới nhận hai
lượt. Probe trả 200 `{"priceCents":125}`, header `x-circuit-state: closed`.
Nếu gõ quá chậm, lượt thứ ba có thể đã là probe. Dừng hai service bằng Ctrl-C.
Có thể dùng `PORT=0`: service in một dòng JSON chứa cổng thực khi sẵn sàng.

Kiểm tra không cần mở socket:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern='unit:' lessons/07-circuit-breaker/test/lesson.test.mts
```

Trong môi trường được phép dùng HTTP loopback, chạy riêng toàn bộ bài:

```sh
node --test --test-timeout=15000 lessons/07-circuit-breaker/test/lesson.test.mts
```

Lệnh tổng của repository là `npm run check` và `make test`. Worker không có mạng
chỉ chạy typecheck/unit; controller chạy integration trong Docker cô lập.
Bài này có integration test thật, nhưng không khẳng định chúng đã qua tại worker.

## Ranh giới và kiến trúc

```text
người gọi → client.mts :4700 → CircuitBreaker.run → upstream.mts :4701
                                 ↓
                         clock performance.now()
```

Hai service là hai tiến trình Node riêng. `breaker.mts` chỉ giữ trạng thái và điều
phối lời gọi, không biết fetch, cổng hay biến môi trường. `client.mts` áp dụng
chính sách lỗi cho một operation cố định `GET /quote`; không làm proxy URL tùy ý.
`upstream.mts` là mô phỏng báo giá, không gọi dịch vụ thật. Không có listener khi
import module; chỉ `main()` ở entrypoint mới khởi động server.

Dùng `lib/http.mts` chung cho listen, JSON, kiểm tra số nguyên và shutdown;
`test/support.mts` khởi động tiến trình con và đăng ký cleanup ngay cả khi setup
thất bại giữa chừng. Trong integration, mỗi service bind `127.0.0.1` với `PORT=0`,
không tranh cổng cố định; mọi fetch của test có deadline 5 giây.

## Máy trạng thái

| Trạng thái | Quyết định và chuyển tiếp |
| --- | --- |
| `closed` | Nhận lời gọi. Mỗi kết quả 5xx hoặc exception tăng bộ đếm lỗi liên tiếp; kết quả dưới 500 đặt lại về 0. Đạt threshold thì `open`. |
| `open` | Không gọi operation, ném `CircuitOpenError`. Khi `now >= retryAt`, yêu cầu kế tiếp chuyển sang `half-open` và trở thành probe. |
| `half-open` | Nhận tối đa `MAX_PROBES` lượt trong nhóm đang xét. Một lỗi mở lại ngay, bắt đầu cooldown mới. Khi mọi probe đã nhận hoàn tất thành công thì đóng lại. |

Không cần timer nền để đổi trạng thái: hết cooldown mà không có traffic vẫn hiển
thị `open`. `/state` chỉ quan sát, không kích hoạt probe. Đồng hồ production là
`performance.now()` đơn điệu; unit test dùng số do test điều khiển, không sleep.
Hợp đồng của clock được tiêm là số hữu hạn, đơn điệu, đơn vị millisecond.

Admission chạy đồng bộ trước `await`, nên hai request cùng event loop không cùng
chiếm một slot. Giới hạn áp dụng cho **tổng lượt đã nhận của nhóm half-open hiện
tại**, không chỉ số đang chạy: slot hoàn tất không được cấp lại khi probe khác
còn chờ. Nếu chỉ có một probe đang chạy và nó thành công, breaker đóng luôn;
`MAX_PROBES` là trần, không phải số thành công tối thiểu. Mặc định 1 là cách thăm
dò bảo thủ nhất. Với giới hạn lớn hơn, một probe thành công chưa đủ đóng nếu còn
probe khác đang chạy.

Mỗi chu kỳ có generation. Một request được nhận lúc closed hoặc half-open vẫn có
thể hoàn tất sau khi breaker đã mở rồi hồi phục. Kết quả đó vẫn trả cho người gọi
ban đầu nhưng không được sửa trạng thái chu kỳ mới. Mở breaker không hủy các
request đã được nhận; chúng vẫn bị giới hạn bởi timeout riêng.

## Cấu hình

Các giá trị số phải là số nguyên trong khoảng; cấu hình sai làm service dừng lúc
startup. Hai service dùng `HOST` mặc định `127.0.0.1`, `PORT` từ 0 đến 65535.

| Biến | Service | Mặc định | Khoảng / ý nghĩa |
| --- | --- | --- | --- |
| `PORT` | client / upstream | 4700 / 4701 | 0 chọn cổng tạm |
| `UPSTREAM_URL` | client | `http://127.0.0.1:4701` | HTTP origin loopback, không credentials/path/query/hash |
| `FAILURE_THRESHOLD` | client | 2 | 1–100 lỗi liên tiếp |
| `COOLDOWN_MS` | client | 1000 | 1–60000 ms tính từ lần mở gần nhất |
| `MAX_PROBES` | client | 1 | 1–10 lượt mỗi nhóm half-open |
| `TIMEOUT_MS` | client | 500 | 1–10000 ms mỗi lời gọi upstream |
| `FAIL_FIRST` | upstream | 2 | 0–10000 lượt đầu giả lập lỗi |
| `FAIL_STATUS` | upstream | 503 | 400–599; thử 404 để thấy không mở breaker |
| `DELAY_MS` | upstream | 0 | 0–10000 ms trước response |

`FAIL_FIRST` đếm theo thứ tự nhận request, không theo thứ tự hoàn tất. `/state`
không tăng bộ đếm. Có thể thử `DELAY_MS=1500 TIMEOUT_MS=200` ở đúng hai service để
thấy timeout cũng được tính là lỗi; upstream có thể tiếp tục xử lý sau khi client
đã bỏ chờ.

## Hợp đồng HTTP và chính sách lỗi

Cả hai service nhận `GET /quote` và `GET /state`. Route khác trả 404 với envelope
`{"error":{"code":"not_found","message":"Unknown route"}}`. Sai method trên
route đã biết trả 405 và `Allow: GET`. `/state` client trả `{"state":"closed"}`
(hoặc `open`, `half-open`); upstream trả `{"calls":2}`.

| Tình huống ở client `/quote` | Status, body và ảnh hưởng |
| --- | --- |
| Upstream trả response | Giữ nguyên status/body JSON; dưới 500 được coi là dependency còn phục vụ, 5xx là lỗi breaker |
| Open hoặc hết slot half-open | 503 `{"error":"circuit_open"}`, không chạm upstream |
| Deadline fetch hết hạn | 504 `{"error":"upstream_timeout"}`, tính một lỗi |
| Lỗi transport, redirect bị cấm hoặc lỗi đọc body | 502 `{"error":"upstream_transport"}`, tính một lỗi |

Các response `/quote` có `x-circuit-state` chụp trạng thái sau khi xử lý kết quả,
không phải trạng thái khi request bắt đầu. Trạng thái có thể đổi ngay sau đó do
request khác. Status 503 riêng nó không phân biệt được upstream hỏng và breaker
chặn: phải xem error code. Client dùng một fetch, không tự retry, không theo
redirect. Timeout bao gồm cả đọc body, không chỉ chờ headers.

Chính sách `<500` giả định operation báo giá dùng HTTP status đúng nghĩa. 404 hoặc
429 không mở breaker ở ví dụ này; production có thể cần chính sách riêng cho
rate limit, từng mã lỗi hay lỗi nghiệp vụ. Client tin body nhỏ của upstream mô
phỏng, chưa giới hạn kích thước hoặc xác thực schema response. Đây không phải
HTTP proxy dùng cho upstream không tin cậy. Exception trong operation đều tính
là lỗi: giữ operation nhỏ để tránh tính nhầm bug lập trình thành dependency lỗi.

## Breaker khác timeout và retry thế nào?

- **Timeout** chặn thời gian chờ của từng lần gọi đang chạy; breaker vẫn cần nó,
  nếu không probe treo sẽ giữ half-open mãi.
- **Retry** thử lại một operation có thể an toàn và còn ngân sách; nó làm tăng
  traffic, có thể khuếch đại sự cố. Bài 06 xử lý an toàn và deadline của retry.
- **Circuit breaker** nhớ lịch sử giữa các request và chủ động không gửi thêm
  khi dependency có dấu hiệu lỗi. Nó có thể từ chối cả khi dependency vừa hồi
  phục nhưng chưa hết cooldown.

Nếu ghép retry, phải quyết định breaker đếm mỗi attempt hay kết quả cuối cùng.
Không thêm retry lồng nhau tùy tiện; probe cũng không nên âm thầm phát nhiều
request. Breaker không đảm bảo idempotency, không thay thế giới hạn đồng thời
(bulkhead), không đảm bảo tính đúng đắn giao dịch.

## Kiểm thử và giới hạn

Unit test kiểm tra ranh giới `cooldown-1` và đúng cooldown, lỗi liên tiếp và reset
bởi 404, exception, giới hạn nhóm probe, lỗi probe mở lại, và kết quả cũ không
làm sai chu kỳ mới. Deferred promises giữ probe đang chạy mà không cần socket
hay sleep. Các integration test khởi động hai child processes, kiểm tra count ở
upstream để chứng minh chặn thật, thời gian từ chối ngắn hơn deadline, probe hồi
phục, probe lỗi và timeout. Sleep chỉ dùng trong integration để chờ thời gian
thực; assertion ranh giới thời gian chính xác thuộc unit test. Các ngưỡng thời
gian HTTP có dung sai nhưng máy quá tải vẫn có thể làm test timing thất bại.

State là **per-instance, trong RAM**, riêng cho một dependency/operation. Hai
client replicas có hai breaker khác nhau; restart xóa lịch sử. Nếu có N replica,
giới hạn probe toàn hệ thống có thể tới N × MAX_PROBES, và nhiều instance có thể
probe đồng thời sau cooldown giống nhau. Không có coordination, persistence,
jitter, rolling error window hay metrics backend. Cần cân nhắc jitter cooldown,
phân vùng theo dependency, quan sát transition/rejection và giới hạn tài nguyên
khi triển khai thật. Không chia breaker theo từng user/URL không giới hạn vì sẽ
tăng cardinality và bộ nhớ. Closed vẫn nhận số request đồng thời không giới hạn;
request đang chạy trước lúc mở không được hủy, do đó đây không phải load limiter.

Threshold lỗi liên tiếp đơn giản nhưng nhạy với thứ tự hoàn tất khi chạy song
song, và một thành công xen kẽ có thể che tỷ lệ lỗi cao. Cooldown dài giảm tải
nhưng chậm phát hiện hồi phục; ngắn quá tạo nhiều probe thất bại. Một probe thành
công không chứng minh dependency chịu được toàn bộ traffic ngay khi đóng lại.

## Bài tập

1. Dùng fake clock bổ sung test nhiều lần probe lỗi, kiểm tra mỗi lần mở có đủ
   cooldown mới; không dùng sleep trong unit test.
2. Đề xuất chính sách riêng cho 429 và 503. Viết test trước khi thay đổi phân loại,
   giải thích tại sao quota theo người gọi không nhất thiết là dependency hỏng.
3. Chạy hai client trên hai cổng trỏ cùng upstream, so sánh `/state` để quan sát
   state độc lập. Tính trần probe khi tăng số replica lên 8.
4. Thiết kế metric đếm transition và rejected call với label hữu hạn. Sau đó đánh
   giá cửa sổ tỷ lệ lỗi và số mẫu tối thiểu so với bộ đếm liên tiếp hiện tại.

## Tham khảo

- Martin Fowler, [Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html):
  trạng thái và động cơ bảo vệ lời gọi từ xa.
- Node.js, [performance.now()](https://nodejs.org/api/perf_hooks.html#performancenow):
  nguồn thời gian đơn điệu trong cùng tiến trình.
- Node.js, [AbortSignal.timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay):
  giới hạn chờ fetch và đọc body.
