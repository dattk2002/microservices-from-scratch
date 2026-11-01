# 06 — Retry có giới hạn và backoff

Một báo giá lỗi tạm thời có thể đọc lại. Một lệnh giữ hàng đã ghi thành công nhưng trả lỗi thì nguy hiểm hơn: gửi lại có thể giữ hai lần. Bài này nối kiến thức deadline ở bài 04 và idempotency ở bài 05 để quyết định **khi nào được thử lại**, đợi bao lâu và dừng lúc nào.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (dòng 24), npm và checkout repository. Runtime chỉ dùng built-ins; TypeScript được Node xóa kiểu trực tiếp, không cần build. Các lệnh dưới chạy từ thư mục gốc. Nếu chưa có development dependencies đã pin, cài bằng `npm ci` trong môi trường được phép tải dependencies.

Terminal A:

```sh
PORT=4601 FAIL_FIRST=2 node lessons/06-safe-retries/upstream.mts
```

Terminal B:

```sh
PORT=4600 UPSTREAM_URL=http://127.0.0.1:4601 node lessons/06-safe-retries/client.mts
```

Terminal C:

```sh
curl -i http://127.0.0.1:4600/quote
curl -i -X POST http://127.0.0.1:4600/unsafe
curl -i -X POST -H 'Idempotency-Key: checkout-06' http://127.0.0.1:4600/protected
curl http://127.0.0.1:4601/state
```

GET trả 200 sau ba lần gọi; POST unsafe trả 503 sau một lần; POST protected trả 201 sau ba lần nhưng chỉ ghi một reservation. `/state` cho `{get:3,unsafe:1,protected:3,effects:2}` khi chạy đúng chuỗi trên trên upstream mới. Gửi lại protected cùng key trả cùng reservation. Ctrl-C dừng từng service. Khởi động lại upstream để đặt lại bộ đếm và replay map.

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern='unit:' lessons/06-safe-retries/test/lesson.test.mts
node --test --test-timeout=15000 --test-name-pattern='integration:' lessons/06-safe-retries/test/lesson.test.mts
npm run check
make test
git diff --check
```

Lệnh unit có `--test-isolation=none` hiển thị trực tiếp từng assertion khi cần chẩn đoán. Integration cần môi trường cho phép listener loopback và child process; worker không chạy chúng trong sandbox này. Controller chạy kiểm tra HTTP trong Docker cô lập. `npm run check` và `make test` là kiểm tra toàn repository có HTTP, dành cho môi trường đó.

## Kiến trúc và ranh giới

```text
caller → retry-client (4600) → retry-upstream (4601)
           retry.mts             counts + replay map
```

Client là nơi duy nhất retry. Hai service là hai tiến trình độc lập; integration dùng `test/support.mts` để spawn, đọc readiness JSON, cấp `PORT=0` trên `127.0.0.1` và đăng ký cleanup ngay trước startup. Không có listener khi import module. `lib/http.mts` cung cấp JSON, đọc body giới hạn 8192 byte và shutdown.

`retry.mts` không biết HTTP hay đồng hồ hệ thống: nhận operation, clock đơn điệu, RNG, sleep và deadline tuyệt đối. Operation phải tự giới hạn thời gian I/O theo ngân sách còn lại; policy không thể hủy một Promise bất kỳ. Client dùng `performance.now()` và `AbortSignal.timeout` cho cả fetch lẫn đọc body, không đặt lại tổng budget sau mỗi lần thử. Deadline được kiểm tra trước lời gọi, sau lời gọi và sau sleep (ở đầu vòng tiếp theo), nên scheduler thức dậy muộn không gây thêm attempt.

## Hợp đồng

| Endpoint client | Upstream | Retry và kết quả |
| --- | --- | --- |
| `GET /quote` | `GET /quote` | Đọc an toàn; 200 với `{priceCents:125}` khi hết lỗi mô phỏng |
| `POST /unsafe` | `POST /unsafe` | Một attempt; có thể đã ghi tác dụng dù nhận 503 |
| `POST /protected` | `POST /protected` | Yêu cầu đúng một `Idempotency-Key`, 1–64 ký tự ASCII chữ/số/`_`/`-`; được retry |

Hai endpoint POST của client là lệnh cố định, bỏ qua body caller và gửi chính xác `{"item":"pencil"}`. Chúng không phải proxy POST tổng quát. Upstream kiểm tra đúng payload này; payload khác trả 400, JSON sai trả 400, media type sai trả 415. Vì chỉ có một payload hợp lệ, cùng key luôn chỉ cùng một ý định: map lưu kết quả trước khi mô phỏng lỗi phản hồi, thực hiện trong đoạn đồng bộ không có `await`. Không chỉ thêm header là đủ: `/unsafe` vẫn không được retry ngay cả khi caller gửi key. Muốn mở rộng payload cần fingerprint và trả 409 khi key dùng cho payload khác, như bài 05.

Client trả nguyên status/body upstream, kèm `x-attempts` cho các đường đã gọi policy. Key thiếu/sai trả 400 trước upstream. Deadline trả 504 với `{"error":"deadline_exceeded"}`; transport exception trả 502 với `{"error":"upstream_transport"}`, không retry. Route hoặc method ngoài hợp đồng trả 404. `/state` chỉ ở upstream, dành cho quan sát demo, không retry.

Chỉ **502, 503, 504 từ HTTP** được xem là transient trong bài. 400, 409, 429, 500, 501 và mọi status khác dừng ngay. Không phải mọi 5xx đều được retry. Không suy ra lỗi mạng là transient từ một exception chung; một lỗi transport có thể che kết quả đã ghi. Chính sách production có thể phân loại lỗi kết nối cụ thể nếu hợp đồng cho phép. Không tự theo redirect.

## Backoff và ngân sách

`maxAttempts` gồm cả lần đầu. Sau lần thất bại thứ `n`:

```text
window(n) = min(capMs, baseMs × 2^(n−1))
delay(n)  = floor(RNG × window(n)), RNG thuộc [0,1)
```

Đây là full jitter, có thể đợi 0 ms. Ví dụ base=10, cap=25, RNG=0.5 tạo các khoảng 5, 10, 12 ms. Hết attempts trả lỗi HTTP cuối; không sleep sau lần cuối. Nếu delay lớn hơn hoặc bằng ngân sách còn lại, policy trả deadline ngay, không ngủ vô ích. Kết quả đến đúng hoặc sau deadline cũng bị từ chối. Không bảo đảm thời gian thực cứng khi event loop bị chặn.

| Biến | Mặc định | Miền hợp lệ |
| --- | --- | --- |
| `PORT`, `HOST` | 4600 client, 4601 upstream; 127.0.0.1 | PORT 0–65535; test dùng 0 |
| `UPSTREAM_URL` | http://127.0.0.1:4601 | HTTP origin loopback, không credentials/path/query/fragment |
| `MAX_ATTEMPTS` | 3 | 1–10 |
| `BUDGET_MS` | 1000 | 1–10000 |
| `BASE_MS` | 20 | 0–1000 |
| `CAP_MS` | 100 | 0–2000 |
| `FAIL_FIRST` (upstream) | 2 | 0–100 lần đầu mỗi loại operation |
| `FAIL_STATUS` (upstream) | 503 | 400–599 |
| `DELAY_MS` (upstream GET) | 0 | 0–10000 |

Cấu hình số phải là chuỗi chữ số nguyên trong miền; sai thì service không khởi động. FAIL_FIRST đếm toàn bộ request theo loại, không theo key; đây là bộ tạo lỗi demo. Policy thuần cho phép tối đa 100 attempts để kiểm tra độc lập; service cố ý giới hạn chặt hơn.

## Kiểm chứng và giới hạn

Unit test dùng clock/RNG/sleep giả để chứng minh cửa sổ tăng rồi bị cap, đúng số attempt, không sleep cuối, không retry unsafe/permanent/exception, từ chối cấu hình sai, deadline hết trước attempt, thành công muộn và scheduler overshoot. Integration tạo upstream mới từng test: fail hai lần rồi thành công đúng lần ba; hết hai attempts; unsafe chỉ một tác dụng; protected ba attempts nhưng một tác dụng và replay ổn định; key thiếu không chạm upstream; status vĩnh viễn không retry; GET chậm hết deadline chỉ gọi một lần.

Map idempotency chỉ nằm trong RAM, không TTL, không giới hạn số key, không sống qua restart và không chia sẻ giữa replica. Đây không phải exactly-once trong hệ phân tán. Dùng bài 05 làm nền cho lưu bền, atomic commit và xử lý tranh chấp. Endpoint state, payload cố định và mô phỏng lỗi không phải API production. Client chỉ đọc response từ upstream demo có body nhỏ; nếu kết nối upstream không tin cậy phải thêm giới hạn body. Timeout client không hoàn tác tác dụng upstream và không bảo đảm upstream dừng làm việc.

Retry làm tăng tải khi upstream đang yếu. Jitter giảm đồng loạt thức dậy nhưng không thay thế rate limit, admission control, retry budget chung hay circuit breaker. Retry ở nhiều tầng có thể nhân số lời gọi; giữ một tầng chịu trách nhiệm. Bài không xử lý Retry-After/429, deadline truyền từ caller, cancellation khi caller ngắt kết nối, hoặc per-attempt timeout ngắn hơn tổng deadline.

## Bài tập

1. Đổi MAX_ATTEMPTS=2 và FAIL_FIRST=2: dự đoán status và bộ đếm trước khi chạy. Vì sao không có lần thứ ba?
2. Dùng RNG=0 và RNG gần 1 trong unit test; kiểm tra cận jitter mà không đo wall clock.
3. Mở rộng lệnh giữ nhiều mặt hàng: thiết kế fingerprint, 409 và lưu replay bền trước khi cho phép retry.
4. Thiết kế hỗ trợ 429/Retry-After nhưng vẫn tôn trọng tổng deadline; thêm test deterministic cho thời gian chờ quá dài.

Tham khảo: [AWS Builders’ Library — Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/), [RFC 9110: safe methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1), [idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), [Node.js globals: AbortSignal.timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay). Bài dùng ví dụ và triển khai riêng; không cần tài khoản cloud hoặc API bên ngoài.
