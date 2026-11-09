# 48 · Hàng đợi công bằng theo tenant

Một tenant gửi nhiều việc không nên chiếm mọi lần chọn việc. Bài này xây dựng
weighted round-robin xác định: ring `[red, red, blue]`, cursor ban đầu `0`.
Khi cả hai tenant luôn có backlog, sáu lần chọn là red, red, blue, red, red,
blue. Mỗi tenant giữ FIFO theo số thứ tự admission, không theo tên job.
Đây là chính sách tùy biến để học, không phải bản triển khai SQS fair queues.

## Chuẩn bị và chạy

Cần Node.js **24.12+ (24.x)** có `node:sqlite`; chạy từ gốc repository.
Không cần dịch vụ đám mây, token hoặc package runtime. Kiến thức trước: HTTP,
idempotency, transaction SQLite, retry hữu hạn và tenant isolation (bài 35).

Terminal A:

```sh
HOST=127.0.0.1 PORT=4841 TEACHING_CONTROLS=1 node lessons/48-tenant-fair-queue/executor.mts
```

Terminal B:

```sh
HOST=127.0.0.1 PORT=4840 DB_PATH=/tmp/lesson48.sqlite EXECUTOR_ORIGIN=http://127.0.0.1:4841 node lessons/48-tenant-fair-queue/queue.mts
```

Mỗi tiến trình in đúng dòng readiness JSON có `service` và `port`. `PORT=0`
chọn cổng ephemeral; lấy cổng từ dòng đó. `HOST` mặc định `127.0.0.1`.
Queue mặc định port 4840, DB_PATH `tenant-queue.sqlite`, EXECUTOR_ORIGIN
`http://127.0.0.1:4841`; executor mặc định port 4841. Chỉ cấu hình ứng dụng lúc
`main()` chạy: import không đọc cấu hình, mở DB, đăng ký signal hay listener.
`SIGTERM`/`SIGINT` đóng listener và kết nối, rồi đóng DB.

```sh
curl -s http://127.0.0.1:4840/jobs -H 'content-type: application/json' -d '{"tenant":"red","id":"r1","value":7}'
curl -s http://127.0.0.1:4840/jobs -H 'content-type: application/json' -d '{"tenant":"red","id":"r2","value":8}'
curl -s http://127.0.0.1:4840/jobs -H 'content-type: application/json' -d '{"tenant":"blue","id":"b1","value":100}'
curl -s http://127.0.0.1:4840/dispatch -H 'content-type: application/json' -d '{}'
curl -s http://127.0.0.1:4840/state
```

Gọi dispatch ba lần: r1 → r2 → b1, kết quả 14 → 16 → 200. Queue không có
worker tự động, không lưu hàng chờ request dispatch. Người gọi chủ động chọn
thời điểm dispatch. Playground có thể khởi chạy hai entrypoint và dùng các
route HTTP tương tự; không cần sửa manager hoặc biến môi trường dành riêng.

## Hợp đồng

| Route | Hành vi |
| --- | --- |
| `POST /jobs {tenant,id,value}` | 200 job hiện tại, kể cả replay sau done/failed |
| `GET /state` | 200 `{jobs,cursor,active}`, tối đa 16 job theo admission |
| `POST /dispatch {}` | 200 `{dispatched:true,job}` hoặc `{dispatched:false}` khi rỗng |
| Executor `POST /execute {tenant,id,value}` | 200 `{tenant,id,result:value*2}` |

Tenant là chuỗi chính xác `red` hoặc `blue`. ID chỉ `[A-Za-z0-9_-]`, dài 1..32;
value là số nguyên 1..100, không nhận chuỗi số hay mảng giả tenant. Định danh
là cặp `(tenant,id)`: red/a và blue/a độc lập. Cùng cặp khác value trả 409.
Có tối đa 16 định danh **giữ lại**, gồm pending, done, failed. Identity mới khi
đầy trả 429, không eviction; replay vẫn được phép. Không có reset/xóa job.
Mỗi job có `seq` tăng đơn điệu, `attempts` 0..3 và state pending/done/failed;
chỉ done có result đã kiểm tra. Thuộc tính thừa của job không tham gia identity.

JSON top-level null, mảng, boolean và trường sai kiểu trả 400. `/dispatch`
chỉ nhận object rỗng. Route lạ trả 404; Content-Type khác JSON trả 415; body
request trên 8192 byte trả 413. Với các trường chuẩn, ID tối đa 32 ký tự khi
escape JSON dạng `\uXXXX` dùng 192 byte, tenant 24 byte, tên trường và value
vẫn nhỏ hơn 300 byte; 8192 đủ cho mọi input hợp lệ, kể cả escape dài nhất.
Body upstream giới hạn 512 byte: identity tối đa có escape vẫn nhỏ hơn 300
byte cùng result 200. Fixture oversized là **JSON hợp lệ**, đúng identity và
result, thêm whitespace hợp lệ để chỉ vi phạm giới hạn byte.

Trong khi executor đang chạy, dispatch khác trả 409 busy; không xếp hàng.
Lỗi status, mạng, JSON/schema, identity/result sai, redirect hoặc quá deadline
trả 502. Deadline outbound tổng cộng 700ms bao gồm đọc body; `redirect:'error'`
giữ origin cố định, không gửi payload theo Location tới dịch vụ khác. HTTP
server có request/header timeout 5000ms. Request test có deadline riêng.

## Transaction và crash

```text
caller → queue HTTP → SQLite (jobs + cursor)
                 └→ executor HTTP (pure value × 2)
```

Một transaction `BEGIN IMMEDIATE` terminalize pending đã đủ ba lượt, quét tối
đa ba slot từ cursor, lấy job FIFO đầu tiên thuộc tenant không rỗng, tăng
attempts và chuyển cursor sang slot tiếp theo **trước HTTP**. Tenant rỗng được
bỏ qua ngay trong lần dispatch, không làm phí lượt có ích. Không có job thì
cursor không đổi. SQLite WAL và synchronous FULL giữ transaction qua restart.

Ví dụ executor nhận red/a rồi queue bị kill trước khi ghi done: attempts đã
được tiêu thụ, cursor đã tiến; job vẫn pending. Restart được retry vì executor
là phép tính thuần, không thanh toán, gửi mail hay tích lũy tác dụng phụ.
Không có cam kết transport exactly-once. Crash khi attempts=3 khiến job thành
failed ở lần dispatch kế tiếp, không gọi executor lần thứ tư. Sau lỗi thông
thường, pending nếu attempts<3, failed khi bằng 3. Failed không chặn job kế
trong cùng tenant. Acknowledgement hợp lệ mới ghi done; không lưu lịch sử lỗi
vô hạn hay trả lịch sử theo request.

Chỉ chạy **một tiến trình queue / một consumer** trên DB. Permit trong RAM bảo
vệ execution toàn cục cho tiến trình đó; transaction SQLite không thay thế
lease phân tán. Hai queue cùng DB có thể chạy executor đồng thời: cấu hình đó
không được hỗ trợ. DB do service sở hữu, không sửa thủ công khi đang chạy.

## Điều khiển giảng dạy

Chỉ bật executor với `TEACHING_CONTROLS=1` trên loopback để mô phỏng lỗi:

```sh
curl -s http://127.0.0.1:4841/teaching/behavior -H 'content-type: application/json' -d '{"mode":"unavailable"}'
curl -s http://127.0.0.1:4841/teaching/behavior -H 'content-type: application/json' -d '{"mode":"same"}'
curl -s http://127.0.0.1:4841/teaching/hold -H 'content-type: application/json' -d '{"enabled":true}'
curl -s http://127.0.0.1:4841/teaching/state
curl -s http://127.0.0.1:4841/teaching/hold -H 'content-type: application/json' -d '{"enabled":false}'
```

Mode chỉ nhận chuỗi same/unavailable, hold chỉ nhận boolean; sai kiểu trả 400.
Không bật flag thì mọi teaching route trả 404. Chỉ giữ tối đa một reply;
execute thứ hai trong lúc giữ trả 409. Barrier `held:true` quan sát được nên
test busy không dựa vào ngủ đo thời gian. Hold tự giải phóng sau 1000ms hoặc
khi client ngắt/kết nối đóng; deadline queue ngắn hơn hold. Các control này
chỉ để học local, không phải API vận hành production hay xác thực tenant.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/48-tenant-fair-queue/test/lesson.test.mts
node --test lessons/48-tenant-fair-queue/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite in-memory, thử lịch chính xác, FIFO, skip slot, cursor, identity,
capacity, retry/crash limit và permit với barrier Promise. Import test chạy child
với PORT/origin/DB_PATH cố ý sai và đòi exit thành công, stdout/stderr rỗng.
Integration khởi động các service bằng child process, port ephemeral, DB dưới
`node:os.tmpdir()` để source read-only vẫn chạy; luôn cleanup trong finally.
Một fixture upstream tái sử dụng qua các mode, reset counter mỗi case; sink
độc lập chứng minh redirect không nhận payload. Tests giữ executor để chứng
minh busy, kill queue để kiểm tra consumed attempt, restart kiểm tra job/cursor,
thử phản hồi sai identity/primitive, oversized, chậm body và lỗi status.
Trong worker không có network, chỉ chạy typecheck/unit; controller chạy toàn bộ
HTTP suite trong Docker cô lập. Các lệnh đầy đủ trên dành cho môi trường đó.

## Giới hạn và bài tập

Fairness là **số lần chọn việc**, không phải thời gian CPU, chi phí, throughput
hay latency SLA. Blue được chọn trong tối đa ba lựa chọn khi còn pending;
request thất bại vẫn tiêu thụ selection. Red chạy 600ms và blue chạy 1ms không
có nghĩa red chỉ dùng hai phần ba thời gian. Một active execution gây
head-of-line blocking: tenant khác phải đợi job chậm hoặc deadline.

Rate limiting giới hạn lượng admission/request theo thời gian; lịch này phân
chia cơ hội phục vụ backlog. Tenant authorization cần ràng buộc tenant với
identity đã xác thực; trường tenant người gọi tự khai ở đây không bảo vệ dữ
liệu. Bulkhead tách capacity/concurrency của tenant, khác permit chung một
slot. Capacity 16 toàn cục vẫn có thể bị một tenant chiếm hết admission.
Không có TTL, GC, multi-consumer lease, priority hay chống DB hỏng; cần thiết
kế riêng nếu dùng ngoài bài học.

1. Với chỉ blue pending và cursor=1, tính cursor sau ba dispatch. Vì sao không
   cần phát ra hai dispatch rỗng cho red?
2. Thay cost của red gấp 20 blue: so sánh weighted selection và deficit round-robin.
3. Thiết kế quota admission mỗi tenant mà replay không bị từ chối khi đầy.
4. Muốn nhiều consumer, cần persist ownership/lease và fencing ở đâu? Vì sao
   phép nhân thuần không giải quyết exactly-once cho một hệ thống thanh toán?

Nguồn để đối chiếu và mở rộng (không xem chính sách bài này là AWS SQS):

- [AWS: SQS fair queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html)
- [Amazon Builders’ Library: Fairness in multi-tenant systems](https://d1.awsstatic.com/builderslibrary/pdfs/fairness-in-multi-tenant-systems-david-yanacek.pdf)
- [Node.js SQLite](https://nodejs.org/api/sqlite.html)
