# 42 — Webhook có chữ ký: đúng byte, đúng thời gian, đúng một hiệu ứng

Bài này dùng hai tiến trình Node.js và hai SQLite riêng. Publisher giữ sự kiện
bất biến; receiver cộng `delta` vào một bộ đếm. Mỗi lần giao là một HTTP request
thật, không có dịch vụ thanh toán, tài khoản hay endpoint bên ngoài.

Cần Node **24.12+ thuộc dòng 24**, npm và các development dependencies đã cài ở
root. Runtime chỉ dùng built-ins. Đọc trước bài transactional outbox, idempotency
và service authentication. Chạy lệnh bên dưới từ root repository.

## Chạy hai terminal

Khóa sau là **dữ liệu demo công khai**, không phải credential. Hãy dùng nguyên
khóa này cho cả hai tiến trình; mỗi tiến trình cần đường dẫn DB khác nhau.

```bash
WEBHOOK_SECRET=public-demo-key-01234567890123456789 \
DB_PATH=/tmp/lesson42-receiver.sqlite HOST=127.0.0.1 PORT=4242 \
TEACHING_CONTROLS=1 node lessons/42-signed-webhooks/receiver.mts
```

```bash
WEBHOOK_SECRET=public-demo-key-01234567890123456789 \
DB_PATH=/tmp/lesson42-publisher.sqlite HOST=127.0.0.1 PORT=4241 \
RECEIVER_ORIGIN=http://127.0.0.1:4242 \
node lessons/42-signed-webhooks/publisher.mts
```

Có thể dùng `PORT=0`: mỗi server in đúng một dòng JSON readiness chứa `port`.
Cấu hình, mở DB, listener và signal handler chỉ chạy trong `main()` khi file là
entrypoint; import module không khởi động dịch vụ.

```bash
curl -sS http://127.0.0.1:4241/events -H 'content-type: application/json' \
  -d '{"id":"stock-adjustment-7","delta":3}'
curl -sS http://127.0.0.1:4241/deliver -H 'content-type: application/json' \
  -d '{"id":"stock-adjustment-7"}'
curl -sS http://127.0.0.1:4242/state
curl -sS http://127.0.0.1:4241/events/stock-adjustment-7
```

Giao lại bằng cùng lệnh `/deliver`: receiver trả `duplicate:true`, tổng vẫn là 3.
Đổi delta của cùng id ở `/events` nhận 409. Với id chứa ký tự đặc biệt, dùng
`encodeURIComponent(id)` khi tạo đường dẫn GET.

## Đường đi và ranh giới tin cậy

```text
POST /events → publisher.sqlite (id, delta, exact raw JSON)
POST /deliver → tăng attempts, ghi uncertain → timestamp + HMAC → HTTP /webhook
                                                       ↓
                     receiver.sqlite: BEGIN IMMEDIATE → receipt + total → COMMIT
                                                       ↓
                      ack được kiểm tra schema/byte/deadline → delivered
```

Publisher chuẩn hóa đầu vào thành `{id,delta}` một lần rồi giữ **đúng các byte**
của JSON đó trong BLOB; không stringify lại khi retry. Các lần giao tạo timestamp
Unix giây mới tại thời điểm bắt đầu attempt và tính:

```text
HMAC-SHA256(WEBHOOK_SECRET, ASCII(timestamp) || "." || retained_raw_bytes)
```

Hai attempt trong cùng giây có thể có timestamp và chữ ký giống nhau. “Mới” nghĩa
là tính lại từ đồng hồ hiện tại, không yêu cầu nonce khác nhau.
`x-demo-timestamp` chỉ nhận chữ số thập phân canonical, không dấu, không số 0 đầu
(trừ chính `0`), tối đa 11 chữ số. `x-demo-signature` phải là đúng 64 ký tự hex
thường. Receiver kiểm tra kiểu, định dạng và độ dài trước `timingSafeEqual`.
Cửa sổ chấp nhận là **[now−60, now+60]**, bao gồm hai biên.

Receiver gom raw body có giới hạn trước, xác thực trên byte trước khi giải mã
UTF-8 và JSON. Đổi khoảng trắng hay thứ tự key mà giữ chữ ký cũ bị 403; ký lại một
JSON có thứ tự key khác nhưng cùng id/delta được xem là duplicate về ngữ nghĩa.
Không dùng JSON đã parse để kiểm tra chữ ký.

HMAC chứng minh tính toàn vẹn và quyền sở hữu khóa chung; **không mã hóa** nội dung.
Bất kỳ ai biết khóa demo đều tự ký được. HTTP loopback, khóa công khai và endpoint
teaching không đem lại an ninh production.

## Hợp đồng hữu hạn

| API | Thành công | Từ chối |
| --- | --- | --- |
| Publisher `POST /events {id,delta}` | 201 mới, 200 cùng payload | 400 sai kiểu, 409 đổi payload hoặc đủ 16 sự kiện |
| Publisher `POST /deliver {id}` | 200 ack đã kiểm tra | 400 sai kiểu, 404 chưa có id, 409 busy hoặc đủ 8 attempts, 502 kết quả không chắc chắn |
| Publisher `GET /events/:id` | id/delta, attempts, delivered (0/1), outcome, busy | 404 không tồn tại |
| Receiver `POST /webhook` | 200 `{id,duplicate,total}` | 403 credential thiếu/sai/cũ/tương lai, 400 JSON/schema sai sau xác thực, 413 quá byte, 409 conflict/capacity |
| Receiver `GET /state` | `{total,receipts}` | Không trả danh sách receipt |

Id có 1..64 ký tự ASCII (bao gồm ký tự cần JSON escape). Delta là số nguyên khác
0 trong −100..100. Mỗi bên giữ tối đa 16 id, không TTL hay eviction: xóa receipt
cũ trong lúc sender còn retry có thể cộng hiệu ứng lần nữa. Tổng luôn nằm trong
−1600..1600. Request body tối đa 512 byte: trường hợp 64 ký tự đều dùng `\uXXXX`
vẫn vừa ngân sách. JSON hợp lệ nhưng có quá nhiều whitespace vẫn nhận 413.
Không chấp nhận top-level null, array, boolean hoặc ép kiểu trường từ string.

Một delivery hoạt động trên toàn publisher; busy trả 409 và không tăng attempts.
Mỗi id có tối đa 8 lần thử, kể cả lỗi mạng, deadline hoặc ack sai. Không có retry
nền, queue hay forwarding URL của caller. `RECEIVER_ORIGIN` là HTTP origin cố định
(không userinfo/path/query/fragment); outbound fetch dùng `redirect:'error'`.
Redirect sang origin khác không được chuyển body/chữ ký.

`DELIVERY_TIMEOUT_MS` mặc định 800, cho phép 50..3000 ms, bao gồm đọc ack.
Ack tối đa 512 byte, phải có id khớp, duplicate boolean, total số nguyên hữu hạn
trong −1600..1600. HTTP 2xx một mình chưa đủ để ghi delivered. Lỗi giữ outcome
`uncertain`; `delivered=1` có nghĩa đã từng nhận ack hợp lệ, không bị xóa khi
một lần thử sau thất bại. State chỉ giữ kết quả cuối và bộ đếm, không lịch sử vô hạn.

Transaction receiver gắn receipt và delta trong cùng commit. Conflict không đổi
tổng. Test trigger SQLite cố ý chặn UPDATE chứng minh INSERT receipt cũng rollback.
Publisher persist attempts trước network; crash ở ranh giới này có thể tiêu thụ
một attempt mà request chưa đi. Không có giao dịch phân tán giữa hai DB.

## Thí nghiệm mất xác nhận sau commit

Bật controls chỉ trong môi trường học cục bộ. Route sau mô phỏng handler đã ghi
DB nhưng không trả ack thành công:

```bash
curl -sS http://127.0.0.1:4242/teaching/failure \
  -H 'content-type: application/json' -d '{"afterCommit":true}'
curl -sS http://127.0.0.1:4241/events \
  -H 'content-type: application/json' -d '{"id":"uncertain-8","delta":2}'
curl -sS http://127.0.0.1:4241/deliver \
  -H 'content-type: application/json' -d '{"id":"uncertain-8"}'
curl -sS http://127.0.0.1:4242/state
```

Lần đầu publisher nhận 502 vì receiver trả **503 sau commit**. State đã tăng 2.
Giao lại cùng id: duplicate vẫn trả 200 dù failure switch đang bật, tổng không
tăng lần nữa. Điều này mô hình hóa mất ack/timeout sau commit: sender không thể
suy ra receiver đã áp dụng hay chưa từ lỗi HTTP. Retry với timestamp mới là
at-least-once delivery; receipt làm hiệu ứng idempotent trong phạm vi retention.
Không được gọi đây là “exactly once network delivery”. Restart receiver dùng
cùng DB vẫn giữ tổng/receipts.

`POST /teaching/failure` yêu cầu boolean thật; `{afterCommit:"true"}` nhận 400.
Khi không có `TEACHING_CONTROLS=1`, các route teaching trả 404. Có thể đặt thêm
`TEACHING_EPOCH=1700000000` khi controls bật để đồng hồ receiver cố định. Route
`POST /teaching/clock {"advance":60}` tiến đồng hồ logic 0..120 giây mỗi lần, không
phải ngủ theo TTL. Không đặt epoch khi chạy publisher demo bằng đồng hồ thật,
trừ khi cố ý minh họa lệch đồng hồ. Epoch mà không bật controls làm startup lỗi.
Khóa `WEBHOOK_SECRET` bắt buộc 32..128 ký tự ASCII in được; không có giá trị ngầm.

## Kiểm chứng

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/42-signed-webhooks/test/lesson.test.mts
# Cần môi trường cho phép private loopback:
node --test lessons/42-signed-webhooks/test/lesson.test.mts
# Kiểm tra đầy đủ repository do controller thực hiện:
npm run check
make test
```

Unit test dùng SQLite `:memory:` và đồng hồ truyền vào verifier; có vector HMAC
cố định, tamper raw byte, freshness biên, sai kiểu, rollback/conflict/capacity,
import trong child với cấu hình cố ý sai. Integration test dùng child process độc
lập, port 0, DB dưới `node:os.tmpdir()`, request deadline và finally cleanup.
Fixture upstream được tái sử dụng giữa malformed/schema/oversize/redirect/hold;
đếm request và barrier `held` chứng minh busy mà không dựa chỉ vào thời gian.
Redirect target là một tiến trình origin khác, counter phải bằng 0. Đây là fixture
riêng trong `test/`, không phải entrypoint của bài học.

## Giới hạn và bài tập

Không đảm bảo thứ tự giao: idempotency không đồng nghĩa ordering. Phép cộng ở đây
giao hoán; một workflow phụ thuộc thứ tự cần sequence/version và chính sách gap.
Clock skew thật cần đồng bộ giờ và giám sát, không nới vô hạn cửa sổ replay. Trong
60 giây, chữ ký có thể được phát lại; receipt, không timestamp, ngăn cộng trùng.
Sau khi chạm capacity cần chính sách vòng đời có chứng minh, không xóa tùy tiện.

Production cần HTTPS, phân phối secret an toàn, phân quyền, xoay khóa có key id và
thời gian chồng lấn hữu hạn, log không lộ body/chữ ký, admission/rate limit và cơ chế
retry vận hành được. Bài này không tự đọc credential thật và không tích hợp Stripe.
Tham khảo [Stripe: webhook signatures và raw body](https://docs.stripe.com/webhooks)
và [Node.js crypto](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b).

1. Giải thích vì sao gửi cùng id với delta khác phải 409 thay vì ghi đè.
2. Thiết kế key rotation hai khóa: giới hạn nào ngăn khóa cũ sống mãi?
3. Với sự kiện “đặt tồn kho = 5” thay cho cộng delta, thứ tự giao ảnh hưởng ra sao?
4. Đề xuất thời hạn retry và retention có thể phối hợp; chỉ ra điều gì xảy ra nếu
   sender retry lâu hơn receiver giữ receipt.
