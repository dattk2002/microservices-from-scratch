# 26 — Dead-letter queue, poison message và redrive có kiểm soát

Bài 17 dừng job sau khi hết lượt thử. Bài này bổ sung quyết định vận hành: cách ly message lỗi, xem dữ liệu và lý do, sửa handler rồi chủ động đưa **cùng message** vào hàng đợi lại. Ví dụ: hóa đơn cũ có `format: "legacy"` làm handler hiện tại thất bại; hóa đơn mới vẫn ghi nhận được. Không cần broker, cloud hay polling nền.

## Điều kiện và kiến trúc

Dùng Node.js **24.12+ thuộc nhánh 24**, npm và các development dependencies đã pin ở root. Cần hiểu HTTP, SQLite transaction, retry và idempotency ở bài 05, 11, 17. Runtime chỉ dùng Node built-ins; SQLite là `node:sqlite`.

```text
operator ──admit/inspect/redrive──> queue-owner ── queue.sqlite
                                     ↑ claim / finish
operator ── POST /step ──────────> consumer ───── consumer.sqlite
                                     │ apply (original operation ID + payload)
                                     ↓
                                    sink ────── sink.sqlite
```

Mỗi service là tiến trình HTTP riêng, sở hữu một file riêng. Không service nào mở database của service khác. Consumer DB lưu cờ sửa handler và tổng bước xử lý đã tới giai đoạn finish; queue DB lưu message cùng bộ đếm; sink DB lưu operation và effect trong cùng một hàng transaction. Database path phải khác nhau; không dùng chung file giữa các vai trò.

Entrypoint chỉ gọi `main()` khi `import.meta.main`. Import không đọc cấu hình, mở SQLite, đăng ký signal, tạo listener hay công việc nền. `lib/http.mts` cung cấp JSON, giới hạn body và server; `test/support.mts` khởi động/dừng child và đọc readiness.

## Chạy trực tiếp

Từ root repository, chạy ba terminal (thư mục tạm nằm ngoài source):

```bash
mkdir -p /tmp/dlq26-demo
HOST=127.0.0.1 PORT=3026 DB_PATH=/tmp/dlq26-demo/queue.sqlite node lessons/26-dead-letter-redrive/owner.mts
```

```bash
HOST=127.0.0.1 PORT=3028 DB_PATH=/tmp/dlq26-demo/sink.sqlite TEACHING_CONTROLS=1 node lessons/26-dead-letter-redrive/sink.mts
```

```bash
HOST=127.0.0.1 PORT=3027 DB_PATH=/tmp/dlq26-demo/consumer.sqlite OWNER_URL=http://127.0.0.1:3026 SINK_URL=http://127.0.0.1:3028 TEACHING_CONTROLS=1 node lessons/26-dead-letter-redrive/consumer.mts
```

Mỗi server hỗ trợ `HOST=127.0.0.1 PORT=0`, in một dòng JSON `{ "service": "...", "port": ... }` sau khi listen. Với port 0, lấy port thực từ readiness rồi truyền URL đó cho consumer. Ctrl-C dừng server; dữ liệu giữ nguyên khi khởi động lại với cùng DB_PATH.

Playground hoặc terminal có thể gọi chuỗi sau. Các teaching-control chỉ dành cho môi trường giáo dục local, không có authentication. Không expose service ra mạng công cộng.

```bash
curl -sS localhost:3026/messages -H 'content-type: application/json' -d '{"id":"invoice-old","payload":{"amount":7,"format":"legacy"}}'
curl -sS localhost:3026/messages -H 'content-type: application/json' -d '{"id":"invoice-new","payload":{"amount":3,"format":"current"}}'
curl -sS localhost:3027/step -H 'content-type: application/json' -d '{}'
curl -sS localhost:3027/step -H 'content-type: application/json' -d '{}'
curl -sS localhost:3026/dead
curl -sS localhost:3028/total
curl -sS localhost:3027/teaching/fix -H 'content-type: application/json' -d '{}'
curl -sS localhost:3026/redrive -H 'content-type: application/json' -d '{"id":"invoice-old","expectedRedrives":0}'
curl -sS localhost:3027/step -H 'content-type: application/json' -d '{}'
curl -sS localhost:3026/messages/invoice-old
curl -sS localhost:3028/total
```

Trước sửa: old ở `dead`, new ở `done`, tổng bằng 3. Sau sửa và redrive: old ở `done`, tổng bằng 10. ID và chuỗi payload của old không đổi, `attempts=2`, `redrives=1`. Chỉ sửa handler không tự redrive. Chỉ redrive không sửa handler sẽ lại cách ly. Không sửa dữ liệu message để che lỗi.

## Cấu hình và giới hạn

| Biến | Mặc định / hợp đồng |
|---|---|
| HOST, PORT | 127.0.0.1, owner 3026 / consumer 3027 / sink 3028; port 0–65535 |
| DB_PATH | queue.sqlite / consumer.sqlite / sink.sqlite, đọc lúc main |
| CAPACITY | Owner: 100, số nguyên 1–100, tính cả message done/dead được giữ lại |
| LEASE_MS | Owner: 3000, số nguyên 20–10000 ms |
| OWNER_URL, SINK_URL | Consumer bắt buộc URL HTTP origin loopback 127.0.0.1, không credentials/path/query |
| TEACHING_CONTROLS | Chỉ chuỗi `1` bật route điều khiển, còn lại 404 |

Payload có đúng hai trường: `amount` nguyên 1–1000 và `format` là chuỗi `current`, `legacy` hoặc `transient`. ID dài 1–64, chỉ chữ ASCII, số, `_`, `-`. Payload được canonicalize theo thứ tự amount,format lúc admission và giữ nguyên qua redrive. Body JSON tối đa 8192 bytes; sai content-type trả 415, sai JSON/input 400, quá lớn 413. Không có batch đầu vào; một `/step` chỉ claim một message. Một consumer có tối đa một step đang xử lý (request cạnh tranh trả 429); mỗi lease có một token. Tổng message và claim đang hoạt động bị chặn bởi capacity; nhiều replica vẫn có thể dùng tài nguyên HTTP nên đây không phải admission control cho Internet.

## Hợp đồng HTTP

| Service / route | Request và kết quả |
|---|---|
| Owner POST /messages | `{id,payload}` → 202 message; ID đã tồn tại 409; capacity đầy 429 |
| Owner GET /messages/:id | 200 message với state, payload (chuỗi JSON), counters, reason, token, until; không có ID 404 |
| Owner GET /dead | 200 `{messages:[...]}`, tối đa 100, chỉ dead, thứ tự admission |
| Owner POST /claim | `{}` → 200 `{message: row hoặc null}`; thu hồi lease hết hạn trước claim |
| Owner POST /finish | `{id,token,outcome}`; outcome `ok`, `poison`, `transient`; thành công 200 message, token/state/lease lỗi 409, ID thiếu 404 |
| Owner POST /redrive | `{id,expectedRedrives}` (nguyên 0–2) → 200 message; stale, active, missing, hết ngân sách đều 409 |
| Consumer POST /step | `{}` → 200 message sau finish hoặc `{idle:true}`; busy 429; remote failure 500 |
| Sink POST /apply | `{id,payload}` → 200 `{applied:true}` lần đầu, `{applied:false}` duplicate; cùng ID khác fingerprint 409 |
| Sink GET /total | 200 `{total}` tổng effect durable |
| Consumer POST /teaching/fix | `{}` → `{fixed:true}`, lưu durable; bật hỗ trợ legacy và chấm dứt lỗi transient giả lập |
| Sink POST /teaching/lose-next | `{}` → `{armed:true}`, đóng kết nối của lần apply hợp lệ kế tiếp **sau commit**; cờ một lần, không durable |

Route không biết hoặc sai method trả 404. Error body theo `{error:{code,message}}`; lỗi nội bộ không lộ exception. Token của claim chỉ dùng ở mạng tin cậy trong bài, không phải cơ chế phân quyền. Unknown delivery hoặc owner finish thất bại trả lỗi để operator quan sát; không tự lặp vô hạn. Teaching fix tác động các bước đọc cờ sau đó, không hủy bước đang chạy.

## Chuyển trạng thái, fencing và audit

`queued → running → done` cho thành công. `poison` đưa thẳng sang `dead` với `unsupported_format`. `transient` quay lại queued nếu còn lượt; lần thứ hai trong chu kỳ vào dead với `attempts_exhausted`. Không đưa exception, URL hay payload vào reason. Allowlist còn có `transient_failure`, `lease_expired`; khi claim mới, reason được xóa. Một claim tăng cả `attempts` tổng và `cycleAttempts` của chu kỳ, kể cả khi tiến trình chết trước xử lý.

Owner dùng transaction `BEGIN IMMEDIATE` để expire + claim nguyên tử. Claim có UUID token mới, `until=owner wall clock + lease`. Finish chỉ hợp lệ khi state running, đúng token và `now < until`; đúng biên hết hạn cũng bị từ chối. Expire được đánh giá khi có `/claim`, không phải bởi timer. Inspect có thể vẫn thấy running đã quá hạn cho tới claim kế tiếp. Lần thử cuối hết lease bị cách ly thay vì được claim vô hạn.

Redrive là một SQL UPDATE có điều kiện `state=dead AND redrives=expected AND redrives<2`. Nó tăng redrives, reset riêng cycleAttempts, giữ ID, payload, tổng attempts và reason trước đó cho tới claim. Hai request cùng version chỉ một request thành công; request cũ không reset active work. Không INSERT bản sao vào queue. Có tối đa 3 chu kỳ × 2 attempts = 6 claims/message. Poison có thể dùng ít hơn.

Audit ở đây là **counter durable và reason cuối**, không phải lịch sử sự kiện đầy đủ. Không lưu từng token, thời điểm hay operator identity. Message done/dead vẫn chiếm capacity, không có purge, TTL, archive hoặc pagination; vận hành đủ 100 message sẽ dừng admission. Sink giữ dedup record vô hạn trong ví dụ; xóa record sớm hơn thời gian có thể replay sẽ cho phép effect lặp lại. Consumer steps là telemetry cục bộ, không transaction chung với queue/sink và không phải sổ kiểm toán chính xác mọi delivery.

## Delivery không đồng nghĩa business effect

Không có transaction xuyên ba database. Sink có thể commit nhưng phản hồi bị mất; consumer báo transient và cùng ID được gửi lại. Sink canonicalize payload, băm SHA-256 rồi trong một transaction kiểm tra ID/fingerprint và insert effect. Dữ liệu khớp thì không tăng tổng lần nữa; khác thì 409. Tổng tính từ chính những hàng effect này, không có khoảng trống giữa ghi dedup và business update.

Lease hạn chế quyền hoàn tất queue, không thu hồi một HTTP request cũ đã tới sink. Vì vậy fencing ở queue vẫn cần dedup ở sink. Đây là delivery **at-least-once trong các lượt retry/redrive được cho phép**, không đảm bảo message cuối cùng thành công: hết budget sẽ dừng để con người quyết định. Không gọi kết quả là exactly-once transport. Sau sự cố, operator phải kiểm tra sink effect trước khi quyết định sửa và redrive; không tạo ID mới chỉ vì không nhận được phản hồi.

Owner dựa vào Date.now trên cùng máy cho lease, cần clock đủ ổn định qua restart; bước nhảy lùi có thể giữ lease lâu, bước nhảy tới có thể hết hạn sớm. Production cần chính sách clock, deadlines, observability và fencing downstream phù hợp. Sink bảo vệ effect khỏi duplicate kể cả khi clock lệch, nhưng không bảo đảm liveness.

## Kiểm thử và lệnh kiểm tra

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/26-dead-letter-redrive/test/lesson.test.mts
```

Unit assertions dùng SQLite `:memory:` và clock điều khiển để kiểm tra biên lease, token cũ, budget, redrive, payload validation, capacity và dedup. Test import dùng child với cấu hình không hợp lệ, đòi exit 0 và cả stdout/stderr rỗng. Quá trình viết test đã ghi nhận assertion lỗi trên claim chưa được triển khai và lần apply đầu tiên trả false trước khi triển khai SQLite thật.

Các lệnh sau chỉ chạy ở môi trường được phép mở HTTP loopback (controller dùng Docker cô lập); worker network-free không chạy chúng:

```bash
node --test --test-isolation=none --test-name-pattern=integration: lessons/26-dead-letter-redrive/test/lesson.test.mts
npm run check
make test
```

Integration tạo file trong `node:os tmpdir()`, dùng process độc lập, port 0, deadline mỗi request 2 giây và cleanup children trước database trong `t.after`. Test barrier lease quan sát claim thực thay vì đoán bằng một sleep dài. Các tình huống: poison không chặn message tốt; retry hết budget; DLQ inspection/restart; redrive cạnh tranh và stale; sửa handler durable; sink mất response sau commit; duplicate/conflict sau restart; lease fencing; admission/body limits; teaching controls tắt. Mọi fixture lỗi vẫn có ID/payload/token/outcome hợp lệ ở những trường không liên quan.

## Giới hạn và bài tập

Đây là queue nhỏ để học state machine và ranh giới transaction, **không phải triển khai Azure Service Bus hay RabbitMQ**: không replication, broker protocol, routing, ordering toàn cục giữa nhiều consumer, delayed retry, authentication, distributed clock hay khả năng chịu mất ổ đĩa. SQLite durability còn phụ thuộc filesystem và phần cứng. Retained messages bị giới hạn nhưng bảng effect/telemetry lâu dài cần retention thực tế. Operator HTTP không có RBAC; chỉ sử dụng loopback local.

1. Vì sao tăng attempt khi claim thay vì khi handler trả lỗi? Tìm một tình huống crash khiến lựa chọn ngược lại retry vô hạn.
2. Thiết kế audit append-only có hạn dung lượng, actor và thời gian; làm sao không để cleanup xóa bằng chứng redrive đang cần?
3. Nếu muốn purge message done nhưng vẫn chống duplicate admission, cần giữ lại tombstone nào, trong bao lâu?
4. Thử mất phản hồi sink trên lượt cuối: queue có thể dead trong khi total đã tăng. Viết runbook kiểm tra trước redrive, giữ nguyên operation ID.
5. Thêm backoff với clock giả và giới hạn retry; tránh đưa sleep vào transaction SQLite.

## Nguồn tham khảo

- [Azure Service Bus dead-letter queues](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues): mục đích DLQ, lý do và xử lý lại do ứng dụng quyết định. Hợp đồng bài này tự định nghĩa, không mô phỏng đầy đủ Azure.
- [Idempotent Consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html): xử lý delivery trùng bằng việc ghi nhận identity nguyên tử cùng effect.
