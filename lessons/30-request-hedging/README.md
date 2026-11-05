# 30 — Request hedging cho GET, ngân sách tải và hủy nhánh thua

Bài này tự xây dựng một chính sách HTTP có giới hạn, lấy cảm hứng từ hedging.
Đây không phải triển khai giao thức gRPC. Ví dụ: đọc mô tả mặt hàng `a` từ hai
replica có cùng dữ liệu; replica chính đôi lúc bị giữ, replica phụ vẫn trả lời.
Không dùng thanh toán, ghi dữ liệu, dịch vụ ngoài hay thư viện runtime.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (<25), npm và các dev dependency đã ghim ở root. Đọc bài 04
(deadline), 06 (retry), 13 (bulkhead) trước. Chạy từ root repository, ba terminal:

```sh
HOST=127.0.0.1 PORT=3031 TEACHING_CONTROLS=1 node lessons/30-request-hedging/replica.mts
HOST=127.0.0.1 PORT=3032 TEACHING_CONTROLS=1 node lessons/30-request-hedging/replica.mts
HOST=127.0.0.1 PORT=3030 PRIMARY_URL=http://127.0.0.1:3031 SECONDARY_URL=http://127.0.0.1:3032 HEDGE_MS=50 DEADLINE_MS=1000 HEDGE_CAPACITY=2 node lessons/30-request-hedging/client.mts
```

Mỗi process in một dòng JSON `{service,port}` khi sẵn sàng. Có thể đặt `PORT=0`
để hệ điều hành cấp cổng rồi dùng cổng trong dòng readiness. HOST chỉ cho phép
`127.0.0.1`; hai URL upstream cũng chỉ chấp nhận origin HTTP loopback, không
credentials/path/query/fragment; redirect bị từ chối. SIGTERM đóng server và cưỡng
chế đóng kết nối sau 1 giây. Import entrypoint không đọc config, đăng ký signal,
khởi chạy timer hoặc listener.

```sh
curl http://127.0.0.1:3030/items/a
curl -H 'content-type: application/json' -d '{"mode":"hold"}' http://127.0.0.1:3031/control
curl http://127.0.0.1:3030/items/a
curl http://127.0.0.1:3031/stats
curl -H 'content-type: application/json' -d '{"mode":"normal"}' http://127.0.0.1:3031/control
```

Lần đọc khi primary bị giữ vẫn trả `{ "id": "a", "text": "hello" }` từ secondary.
`cancelled` ở primary tăng và `active` về 0. Không có endpoint ghi nghiệp vụ.

## Kiến trúc và hợp đồng

```text
caller -> hedging-client -> primary replica (GET ngay)
                        -> secondary replica (sau HEDGE_MS nếu chưa kết thúc + có permit)
```

`hedge.mts` quản lý vòng đời với clock/scheduler tiêm vào; `protocol.mts` đọc stream
có giới hạn và kiểm tra runtime; `client.mts` thực hiện HTTP; `replica.mts` mô phỏng
công việc độc lập. Hai replica là hai process, dù dùng cùng entrypoint. Không có
SQLite hay durable state cần ghi.

* Chỉ `GET /items/:id` được forward/hedge. ID dài 1..64 ký tự ASCII thuộc
  `[A-Za-z0-9_-]`; query, path khác nhận 404. Mọi method khác GET nhận 405 trước
  forwarding. `GET /stats` là quan sát cục bộ, không hedge.
* Mỗi operation bắt đầu primary ngay; một timer duy nhất quyết định secondary.
  Nếu primary đã thành công hoặc fatal thì timer bị hủy. Nếu primary lỗi tạm thời,
  vẫn chờ mốc hedge; không để lỗi sớm che một kết quả hợp lệ còn có thể đến.
* HTTP 200 chỉ thắng sau khi body JSON hợp lệ, đúng hai field `id`, `text`, ID
  trùng yêu cầu và text là string tối đa 256 UTF-16 code unit. Content-Type phải là
  application/json. Không chấp nhận sai identity, malformed JSON hoặc body quá lớn.
* Fatal: 400, 401, 403, 404, 405, 410, 422. Một nhánh fatal kết thúc operation và
  hủy nhánh còn lại. Giả định các replica thống nhất về quyền và tồn tại tài nguyên;
  nếu giả định sai, chính sách fatal phải được thiết kế lại. Đây là quyết định dạy
  học cụ thể, không quy tắc chung cho mọi HTTP API.
* Mọi status khác ngoài 200 hợp lệ và fatal (kể cả 408, 429, 5xx, redirect), lỗi
  transport, representation không hợp lệ đều eligible cho cơ hội secondary. Không
  chờ Retry-After và không gửi nhánh thứ ba. Khi hết cơ hội và không còn nhánh chờ,
  client trả 502. Không có tự động retry sau deadline.
* Deadline chung bắt đầu khi operation được tạo; hết hạn trả 504 và abort cả hai.
  Caller đóng socket khiến operation nội bộ kết thúc 499; không thể gửi response
  cho socket đã đóng. Kết quả đến muộn bị bỏ qua. Thành công/fatal/deadline/disconnect
  đều dọn timer, listener abort và permit. Fetch/body đều dùng cùng AbortSignal.

Giới hạn body được suy ra thay vì chọn tùy ý: JSON compact `{id:"",text:""}` chiếm
19 byte, ID tối đa 64 byte, text tối đa `256 * 6` byte do control character hoặc
lone surrogate có thể escape `\uXXXX`: tổng **1619 byte**. Giới hạn áp lên byte đọc
stream (sau giải nén của fetch), không tin Content-Length. JSON có khoảng trắng hay
escape ID dư thừa vượt giới hạn không thuộc canonical representation của bài này.
Unit test nhận đúng maximal representation với ID 64 ký tự và 256 NUL; oversized
là JSON đúng schema/identity nhưng thêm whitespace vượt trần, bị chặn trước
JSON.parse. Integration regression xác nhận fixture vẫn qua `parseValue`, rồi
`readResponse` từ chối riêng vì byte limit; nếu bỏ kiểm tra byte thì test thất bại.
Parsing runtime được thực hiện trước khi chọn winner.

## Ngân sách tải và cấu hình

| Biến | Mặc định | Giới hạn |
| --- | --- | --- |
| PORT | client 3030, replica 3031 | 0..65535 |
| HEDGE_MS | 50 | 1..5000 ms |
| DEADLINE_MS | 1000 | > HEDGE_MS và <=10000 ms |
| HEDGE_CAPACITY | 2 | 0..100 extra attempt đang chờ/process |
| TEACHING_CONTROLS | tắt | chỉ chuỗi `1` bật controls ở replica |

Mỗi operation tối đa 2 attempt. Permit chỉ dành cho extra attempt, dùng chung mọi
operation của một client process. Không có hàng đợi: thiếu permit tại mốc hedge
thì bỏ cơ hội đó vĩnh viễn, dù permit rảnh sau này. Primary còn chờ vẫn có thể thắng.
Capacity 0 tắt secondary. Permit được trả khi extra kết thúc hoặc operation bị hủy;
đây là giới hạn công việc do client theo dõi, không bảo đảm remote đã dừng ngay.
Primary concurrency chưa bị giới hạn: production cần thêm admission control riêng.

`GET /stats` ở client trả `extra`, `skipped` (số lần thiếu permit); ở replica trả `received`, `active`, `cancelled`,
`held`. Counter tích lũy trong RAM process. Controls chỉ dùng cho Playground loopback,
không phải API production hay cơ chế auth. Khi bật `TEACHING_CONTROLS=1`,
`POST /control` nhận JSON `{ "mode": "..." }` (body input tối đa 8192 byte qua helper).
Mode bắt buộc là primitive string; array/object/number/null không được ép kiểu.

| Mode | Hành vi |
| --- | --- |
| normal | trả id và hello |
| hold | giữ các request đọc cho tới đổi mode hoặc socket bị đóng |
| malformed | 200 với text kiểu number |
| wrong-id | 200 đúng schema nhưng sai identity |
| transient | 503 |
| fatal | 404 |
| oversized | 200 đúng schema/identity, whitespace làm body vượt byte limit |
| maximal | text gồm 256 NUL |

Đổi mode giải phóng toàn bộ request đang hold và áp mode mới. Set này là tập công
việc đang xử lý, không phải queue hedge. Controls tắt mặc định. Không mở server ra
Internet. Tất cả failure fixture vẫn có ID/route hợp lệ để lỗi thử nghiệm là nguyên
nhân thực sự.

## Vì sao dùng và khi nào không dùng

Tail latency là phần chậm ở p95/p99; average thấp không có nghĩa request chậm hiếm
không ảnh hưởng người dùng. Gửi bản đọc thứ hai sau một ngưỡng có thể giảm đuôi nếu
độ chậm giữa replica đủ độc lập. Không có benchmark hay cam kết giảm latency ở đây.
Giá phải trả là tăng số đọc, CPU, connection và băng thông; khi hai replica cùng
quá tải, hedge có thể làm tình hình tệ hơn. Delay và capacity cần đo theo workload.

Sequential retry đợi nhánh cũ thất bại rồi mới thử tiếp; hedging cho phép hai nhánh
chồng lấn. Bulkhead giới hạn concurrency trong một miền tài nguyên; permit ở đây
chỉ giới hạn phần tải đọc thêm. Circuit breaker nhớ lỗi qua nhiều operation để
ngắt endpoint; bài này không có trạng thái breaker. Cancellation là best effort:
server có thể đã chạy truy vấn hoặc không hỗ trợ ngắt I/O; abort không rollback.
GET an toàn theo HTTP không đồng nghĩa miễn phí hay luôn idempotent đúng trong code.
Replica phải phục vụ cùng logical resource, schema và snapshot/consistency phù hợp;
kiểm tra id không phát hiện dữ liệu stale, sai version hay quyền khác nhau.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/30-request-hedging/test/lesson.test.mts
# Các lệnh dưới cần môi trường cho phép loopback; controller chạy trong Docker cô lập:
node --test --test-timeout=15000 lessons/30-request-hedging/test/lesson.test.mts
npm run check
make test
git diff --check
```

Worker không mạng chỉ chạy typecheck và unit, không chạy Docker hoặc HTTP integration.
Unit dùng deferred promise và clock thủ công: primary nhanh, secondary thắng,
transient/fatal, hết nhánh, deadline/disconnect, bỏ kết quả muộn, skip không queue,
cleanup timer/permit/listener, bounds/schema và import child silent với config sai.
Import child phải exit 0 và không in gì; startup lỗi không tính là pass.

Integration tạo hai replica con và client con trên cổng ephemeral loopback, không
listener ở top level. Không cần file fixture hay database. Các barrier đọc counter
và held state, không lấy độ trễ đoán winner. Test giữ cả hai replica trước khi thả
secondary để chứng minh primary thua bị hủy; deadline/disconnect phải đưa active về
0. Test saturation giữ một permit rồi đọc thêm sáu operation, xác nhận không tạo
thêm request secondary. Mọi HTTP call có timeout, barrier có hạn chót, child được
cleanup trong finally. Thời gian giới hạn chỉ là guard thất bại, không là điều kiện
thành công của barrier.

## Bài tập

1. Đo histogram p50/p95/p99 và số attempt với workload loopback có phân phối chậm;
   chọn delay/capacity từ dữ liệu, giữ admission control để tránh tự gây quá tải.
2. Thêm version vào representation và định nghĩa rõ stale version có được thắng
   hay không. Sửa cả bound JSON, validator và failure fixture.
3. Thử replica không tôn trọng cancellation; phân biệt client permit về 0 với remote
   CPU thực sự dừng. Đề xuất deadline được truyền xuống truy vấn.

Nguồn: [gRPC request hedging](https://grpc.io/docs/guides/request-hedging/) và
[RFC 9110 safe methods](https://www.rfc-editor.org/rfc/rfc9110.html#name-safe-methods).
Chính sách HTTP, code và ví dụ trong bài được xây dựng riêng; không sao chép triển
khai gRPC hay tuyên bố tương thích các option của gRPC.
