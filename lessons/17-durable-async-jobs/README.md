# 17 — Job bất đồng bộ lưu bền và HTTP 202

Bài này chuyển phép tính tổng `1 + … + n` ra khỏi vòng đời request. Ví dụ
`n=10` cho kết quả `55`; `fail=true` mô phỏng lỗi tính toán xác định để quan sát
retry và lỗi cuối cùng. Không có thanh toán, email hay tác dụng phụ bên ngoài.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc nhánh 24**, npm và các dev dependency đã được cài từ
lockfile ở gốc. Ôn HTTP, SQLite service-owned persistence và retry ở các bài trước.
Không cần dịch vụ cloud hay runtime package. Chạy lệnh từ thư mục gốc repository.

Terminal 1 (thư mục dữ liệu phải tồn tại, không chia sẻ file này cho worker):

```sh
DB_PATH=/tmp/lesson17-jobs.sqlite PORT=3017 node lessons/17-durable-async-jobs/api.mts
```

Terminal 2:

```sh
OWNER_URL=http://127.0.0.1:3017 PORT=3018 node lessons/17-durable-async-jobs/worker.mts
```

Terminal 3:

```sh
curl -i -H 'content-type: application/json' -d '{"n":10}' http://127.0.0.1:3017/jobs
# Lấy Location từ response, thay ID bên dưới bằng UUID thật.
curl -i http://127.0.0.1:3017/jobs/ID
curl -i http://127.0.0.1:3017/jobs/ID/result
curl -i -H 'content-type: application/json' -d '{"n":4,"fail":true}' http://127.0.0.1:3017/jobs
```

Dừng bằng Ctrl-C. Chạy lại API với cùng DB_PATH sẽ giữ job và kết quả. Mỗi lần
thực hành độc lập dùng đường dẫn SQLite khác; không dùng chung file với bài khác.
File `-wal` và `-shm` cạnh database cũng thuộc SQLite, không xóa khi API đang chạy.

## Ranh giới và kiến trúc

```text
client --POST /jobs--> owner API --transaction--> SQLite
client <--202 + Location-- owner API
worker --POST /claims--> owner API
worker <--job + token + lease-- owner API
worker --POST /jobs/:id/complete--> owner API
client --GET status / result--> owner API
```

API sở hữu duy nhất SQLite; worker chỉ biết OWNER_URL, không truy cập database.
Worker là tiến trình riêng, xử lý tuần tự một job và có listener riêng phục vụ
quan sát test. Muốn thêm cạnh tranh, chạy worker thứ hai với PORT khác. Không có
listener khi import store hoặc test; entrypoint khởi động tiến trình rõ ràng.
`lib/http.mts` cung cấp JSON giới hạn 8192 byte, timeout nhận HTTP 5 giây và shutdown;
`test/support.mts` cung cấp child process, readiness và cleanup.

## Hợp đồng HTTP

- `POST /jobs` nhận `{n: integer 0..10000, fail?: boolean}`. Commit admission trước
  khi trả **202**, `Location: /jobs/:id`, `Retry-After: 1`, body `{id,state:"queued"}`.
  202 chỉ xác nhận đã nhận và lưu công việc; worker có thể chưa tồn tại, hoặc cuối
  cùng thất bại. UUID do owner cấp. POST lại tạo job mới, chưa có idempotency key.
- `GET /jobs/:id`: 200 với `id,state,attempt,error,result`. Bốn state là `queued`,
  `running`, `succeeded`, `failed`; `result` là URL khi succeeded, còn lại null.
  `error` là mã cố định, không phải stack trace. Có `Retry-After: 1`; client nên
  poll cách ít nhất một giây và đặt tổng deadline riêng. Response chỉ một job,
  không có listing vô hạn hoặc long-poll. UUID không tồn tại: 404.
- `GET /jobs/:id/result`: 200 `{sum:55}` khi succeeded; 409 `result_unavailable`
  khi chưa có kết quả hoặc failed; 404 nếu không tồn tại. Kết quả không tự redirect.
- `POST /claims` trả 200 `{job:null}` hoặc một job nội bộ gồm input, attempt,
  token và lease (timestamp millisecond). Transaction claim commit trước response.
- `POST /jobs/:id/complete` nhận `{token,success,result?}`. Success cần result đúng
  công thức; failure dùng `success:false`. Token hiện hành và `now < lease` mới
  được sửa trạng thái. 200 `{accepted:true}` hoặc 409 `stale_claim` (cũng dùng cho
  kết quả success không hợp lệ). Không gửi token cho client status công khai.
- Input sai: 400, media type sai: 415, body quá lớn: 413. Capacity hết: 503 kèm
  `Retry-After: 1`. Route lạ: 404, method sai trên job: 405. JSON dùng `no-store`.

Endpoint claim/complete chỉ dành cho mạng nội bộ tin cậy. Bài chưa có auth/TLS;
không public các endpoint này. Bind mặc định loopback. Timeout fetch worker 1 giây;
response không rõ kết quả thì worker để lease phục hồi, không giả định thành công.

## State machine và độ bền

`queued → running → succeeded`. Lỗi tính toán: `running → queued` nếu còn lượt,
ngược lại `running → failed`. Claim tăng attempt, kể cả worker chết trước tính.
Lease hết tại **now >= lease**: claim kế tiếp được phép reclaim và cấp token UUID
mới; nếu đã hết lượt thì chuyển failed với `attempts_exhausted`. Việc quét lease
là lazy khi có `/claims`; không có worker thì trạng thái running có thể vẫn hiển
thị sau expiry, nhưng completion đã bị từ chối. Lease không được gia hạn.

Admission đếm tất cả bản ghi trong `BEGIN IMMEDIATE`; claim chọn và sửa cũng trong
transaction này, nên hai HTTP claim không lấy cùng lease. Completion kiểm tra
state, token, thời gian và cập nhật trong cùng transaction. SQLite WAL cùng commit
lưu admission, attempt, token, terminal state và result qua restart. Không có
await bên trong transaction. Đây là một owner, không phải SQLite phân tán hay HA;
độ bền vẫn phụ thuộc filesystem và phần cứng. Lỗi SQLite không được giả thành 202.

Retry tối đa ATTEMPTS, không reset qua restart. Lỗi xác định có thể phí toàn bộ
lượt; bài cố ý giữ nó đơn giản để học terminal failure. Retry cách POLL_MS, chưa
có exponential backoff/jitter hoặc phân loại lỗi permanent/transient. Worker chết
ở lượt cuối sẽ failed khi một claim request phát hiện lease hết.

Token fencing bảo vệ **ghi kết quả vào owner**, không ngăn worker cũ tiếp tục
chạy CPU. Vì vậy computation là **at-least-once trong quá trình retry**, không
exactly-once, và không đảm bảo hoàn thành trước khi hết lượt. Phép tính thuần có
thể chạy lại an toàn. Nếu thay bằng tác dụng phụ thật, token ở SQLite không tự bảo
vệ hệ thống ngoài; cần thiết kế idempotency/fencing ở đích riêng.

## Cấu hình và giới hạn

| Biến | Mặc định | Khoảng / ý nghĩa |
| --- | --- | --- |
| DB_PATH | jobs.sqlite | Chỉ API dùng; thư mục cha phải tồn tại |
| CAPACITY | 100 | 1..100000, tổng job giữ lại |
| ATTEMPTS | 3 | 1..10, tổng lượt claim |
| LEASE_MS | 2000 | 100..100000 ms |
| OWNER_URL | http://127.0.0.1:3017 | Worker gọi owner qua HTTP |
| POLL_MS | 100 | 10..10000 ms giữa các vòng worker |
| PORT | 3017 API / 3018 worker | 0..65535; 0 cấp cổng ephemeral |
| HOST | 127.0.0.1 | Địa chỉ bind |
| TEST_CONTROLS | không bật | `1` bật worker `/stats`, POST `/release` |
| HOLD | không giữ | `1` giữ worker sau claim; dùng cùng test controls |

Job và kết quả giữ **vô thời hạn**, kể cả failed. Không có DELETE/TTL tự động;
capacity đầy thì từ chối cả khi không còn job đang chạy. Đây là giới hạn lưu trữ
có chủ ý, không phải hàng đợi chỉ giới hạn in-flight. Muốn bắt đầu lại dùng DB_PATH
mới sau khi dừng tiến trình; production cần retention/archival có hợp đồng rõ ràng.
Không lưu payload tùy ý; n và body bị chặn nên mỗi record/response hữu hạn.

Clock là wall-clock của owner. Đồng hồ nhảy tới trước có thể hết lease sớm; nhảy
lùi có thể trì hoãn recovery. Worker không tự quyết expiry. Chọn lease lớn hơn
thời gian xử lý/HTTP thông thường và giám sát clock; token vẫn cần thiết khi clock
ổn định. Event loop bị nghẽn hoặc owner ngừng hoạt động cũng trì hoãn tiến độ.

## Kiểm thử

Trong worker sandbox không có mạng:

```sh
npm run typecheck
npm run test:unit
# Xem rõ từng test của bài, không tạo HTTP listener:
node --test --test-isolation=none --test-name-pattern='unit:' lessons/17-durable-async-jobs/test/lesson.test.mts
```

Controller chạy trong môi trường cho phép loopback cô lập:

```sh
node --test --test-timeout=15000 lessons/17-durable-async-jobs/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite `:memory:` và injected clock để kiểm tra trước expiry, đúng
expiry, token cũ, kết quả sai, retry hết lượt, terminal state và admission đầy.
Integration dùng child process thật, PORT=0, database trong thư mục tạm riêng mỗi
test, deadline fetch và barrier polling. HOLD dừng sau claim; `/stats` xác nhận
claim thật trước khi release/kill. Không dùng sleep cố định để đoán job đã chạy.
Các ca chứng minh 202 trước xử lý, polling và result, lỗi cuối cùng, hai worker
reclaim/fencing, SIGKILL rồi phục hồi, restart owner giữ cả queued và succeeded.
Cleanup dừng mọi child trước khi xóa database, kể cả assertion thất bại. Barrier
có deadline 6 giây; lease integration 1200 ms. Unit mới kiểm tra chính xác biên,
integration xác nhận luồng hệ thống bằng thời gian thật.

## Bài tập

1. Thêm phân loại lỗi để fail xác định không tốn nhiều lượt; viết test trước.
2. Thiết kế retention hữu hạn và response khi kết quả đã bị xóa (ví dụ 410), rồi
   phân tích client đang poll bị ảnh hưởng thế nào.
3. Thêm heartbeat gia hạn lease bằng cùng token; kiểm tra race gia hạn/reclaim
   tại đúng thời điểm expiry với injected clock.
4. Bổ sung idempotency key cho admission và phân biệt retry POST với job mới.

## Nguồn

- [Azure: Asynchronous Request-Reply pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply): lý do tách acceptance, status và result.
- [RFC 9110 §15.3.3 — 202 Accepted](https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted): ý nghĩa chấp nhận không đồng nghĩa hoàn tất.
- [Node.js SQLite](https://nodejs.org/api/sqlite.html): DatabaseSync và prepared statements.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): BEGIN IMMEDIATE và writer serialization.
