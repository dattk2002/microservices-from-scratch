# 31 — Consumer-driven contracts và kiểm chứng provider tương thích

Consumer đặt yêu cầu tối thiểu lên giao diện mà nó thực sự dùng. Provider được
phép bổ sung trường mà không buộc consumer đổi phiên bản. Bài này xây dựng một
verifier nhỏ, nguyên bản bằng Node.js built-ins; đây **không phải Pact**, không
đọc/ghi định dạng Pact và không thay thế hệ sinh thái broker của Pact.

Điều kiện: Node **24.12+ trong nhánh 24**, npm và bộ công cụ development đã được
cài từ root. Hiểu HTTP, kiểm tra runtime của JSON và child processes từ các bài
trước. Không cần credential, SQLite, dịch vụ ngoài hay package runtime.

## Kiến trúc và quyền sở hữu

```text
GET /quote/tea ──> consumer HTTP ──> provider HTTP /products/tea
                       │                 ▲
                  client.mts             │
                       ▲                 │
GET /verify ──> verifier HTTP ────────────┘
                  catalogue → buildRequest → consume → parseReply → quote
```

Ba entrypoint chạy trong ba tiến trình độc lập. `contracts.mts` thuộc consumer:
catalogue TypeScript tĩnh mô tả đúng hai request, status và những trường được
đọc. Consumer dùng giá để tính giá hai gói trà: `1250 × 2 = 2500` cent. Trường
`id` kiểm chứng nhận đúng sản phẩm. Trạng thái không tìm thấy sinh kết quả không
khả dụng, tổng bằng 0. Không có ép JSON thành chuỗi hay ép kiểu để né kiểm tra.

| Interaction / provider state | Request | Status và trường tối thiểu | Consumer |
| --- | --- | --- | --- |
| `product-found`: đã có trà | `GET /products/tea` | 200, `id: "tea"`, integer `priceCents` 0..100000 | 200, `{available:true,totalCents:2500}` với fixture giá 1250 |
| `product-missing`: không có absent | `GET /products/absent` | 404, `code: "PRODUCT_MISSING"` | 404, `{available:false,totalCents:0}` |

Provider sở hữu fixture sản phẩm, cách thiết lập state và triển khai endpoint.
`provider.mts` **không import** catalogue, parser hay matcher của consumer. Hai
state cố định cùng tồn tại, không cần endpoint setup state tổng quát. Revision
chỉ thay cách provider trả lời để quan sát tương thích; không phải dữ liệu do
verifier gửi lên nhằm tạo đúng kết quả mong muốn.

Verifier gọi chính `consume`, request builder và parser đang chạy ở consumer,
không tạo báo cáo pass đóng hộp. Fixture provider được viết riêng nên chia sẻ
parser không khiến cả hai phía tự động cùng đúng. `verify` lần lượt chạy đúng
hai interaction, trả 200 nếu tất cả pass, 409 nếu có mismatch. Mỗi kết quả chỉ
chứa interaction, field/status bị lệch và giá trị consumer tính được. Không
chép body, origin, header hay thông báo từ JSON lỗi vào báo cáo.

## Chạy native và Playground

Từ root, mở ba terminal (các port sau chỉ là ví dụ chạy tay):

```bash
HOST=127.0.0.1 PORT=43131 TEACHING_CONTROLS=1 node lessons/31-consumer-driven-contracts/provider.mts
HOST=127.0.0.1 PORT=43132 PROVIDER_ORIGIN=http://127.0.0.1:43131 node lessons/31-consumer-driven-contracts/consumer.mts
HOST=127.0.0.1 PORT=43133 PROVIDER_ORIGIN=http://127.0.0.1:43131 node lessons/31-consumer-driven-contracts/verifier.mts
```

Mỗi tiến trình in một dòng JSON readiness, ví dụ
`{"service":"contract-provider","port":43131}`. Có thể dùng `PORT=0` ở cả ba:
đọc port thực từ readiness provider rồi truyền vào `PROVIDER_ORIGIN` của hai
process còn lại. Dùng port readiness consumer/verifier cho lệnh gọi sau. Ctrl-C
hoặc SIGTERM đóng listener; helper chung cưỡng chế đóng connection sau 1 giây.
Mọi đọc environment, listener và đăng ký signal chỉ xảy ra trong `main`, được
guard bằng `import.meta.main`. Import module không khởi động dịch vụ.

```bash
curl --max-time 3 http://127.0.0.1:43132/quote/tea
curl --max-time 3 http://127.0.0.1:43132/quote/absent
curl --max-time 3 http://127.0.0.1:43133/verify
curl --max-time 3 http://127.0.0.1:43131/__teaching
curl --max-time 3 -H 'content-type: application/json' -d '{"revision":"additive"}' http://127.0.0.1:43131/__teaching
curl --max-time 3 http://127.0.0.1:43133/verify
curl --max-time 3 -H 'content-type: application/json' -d '{"revision":"type"}' http://127.0.0.1:43131/__teaching
curl --max-time 3 http://127.0.0.1:43133/verify
curl --max-time 3 http://127.0.0.1:43132/quote/tea
curl --max-time 3 -H 'content-type: application/json' -d '{"revision":"compatible"}' http://127.0.0.1:43131/__teaching
curl --max-time 3 http://127.0.0.1:43133/verify
```

`GET /__teaching` trả revision và counter request sản phẩm. `POST /__teaching`
chỉ nhận object có đúng một trường chuỗi `revision`. Các route này tồn tại khi
**`TEACHING_CONTROLS=1`**, chỉ phục vụ bài tập local; chúng không có xác thực và
không phù hợp để phơi ra mạng. Không bật cờ thì GET trả 404, POST trả 405. Không
có cơ chế đổi revision qua query/header sản phẩm.

| Revision | Thay đổi ở phản hồi found | Kết quả |
| --- | --- | --- |
| `compatible` | id trà, giá 1250 | verifier 200, consumer 2500 |
| `additive` | thêm `note` chứa 256 ký tự NUL cần escape | vẫn pass, vẫn 2500 |
| `removal` | bỏ `priceCents` | verifier 409 field mismatch, consumer 502 |
| `type` | giá thành chuỗi `"1250"` | verifier 409 field mismatch, consumer 502 |
| `status` | 201 thay cho 200, giữ body hợp lệ | verifier 409 status mismatch, consumer 502 |
| `oversized` | thêm note 2048 ký tự ASCII, schema vẫn đúng | verifier 409 byte limit, consumer 502 |
| `slow` | cả hai state trì hoãn 800 ms | timeout từng request, verifier 409 |

Ví dụ mismatch được giữ gọn:
`{interaction:"product-found",ok:false,mismatch:"priceCents: expected integer"}`.
Các revision breaking không sửa phản hồi missing. Khôi phục về `compatible`
không cần restart, và lượt verify tiếp theo phải pass.

## Giới hạn, deadline và ngân sách byte

Verifier không nhận URL hoặc danh sách interaction từ caller. Chỉ cấu hình
startup `PROVIDER_ORIGIN=http://127.0.0.1:<port>` với port 1..65535 được chấp nhận;
không credentials, HTTPS, hostname DNS, path, query hoặc redirect. Request tới
`/verify?url=...` bị từ chối. Body ở `/verify` bị từ chối; method duy nhất là GET.
Request outbound được dựng từ catalogue, không body, đường dẫn dài nhất 16 byte
ASCII (`/products/absent`), không đưa header/body caller sang provider.

Mỗi response upstream tối đa **2048 byte** (đếm chunk Buffer trước JSON.parse),
bao gồm cả trường thêm và whitespace. Không chỉ tin `Content-Length`. Deadline
**400 ms/request**, **1200 ms/toàn lượt**, bao gồm đọc body. `node:http` không tự
follow redirect. Một verifier chỉ nhận một lượt tại một thời điểm; lượt thứ hai
nhận 429, không xếp hàng không giới hạn. Consumer cũng chỉ xử lý một quote tại
một thời điểm. Đây là admission đơn giản, không phải bài backpressure/write-drain.

Ngân sách được tính cho profile fixture JSON.stringify: tên trường cố định,
identifier `tea` dài 3 ASCII, giá tối đa 100000 dài 6 chữ số. Object found cơ bản
có 32 byte; thêm `,"note":""` có 10 byte; note 256 UTF-16 code unit có trường
hợp xấu nhất 6 byte escape mỗi unit. Tổng tối đa **32 + 10 + 256×6 = 1578 byte**,
thấp hơn 2048. Trường missing chỉ chứa code ASCII cố định. Đây không phải tuyên
bố mọi cách biểu diễn JSON tương đương đều nằm trong 2048: quá nhiều whitespace
hoặc trường thêm cũng vượt giới hạn wire độc lập với schema tối thiểu.

Body teaching-control tối đa **256 byte**, deadline đọc tuyệt đối 400 ms. Enum
dài nhất `compatible` có 10 ký tự; nếu từng ký tự dùng `\uXXXX`, object cần
15 + 10×6 = 75 byte. Unit kiểm tra response hợp lệ tối đa, JSON đúng schema vượt
budget và ranh giới đúng 2048 byte. HTTP test gửi control escape tối đa, padding
whitespace tới đúng 256 byte vẫn nhận, rồi gửi JSON cùng schema chỉ vượt byte.
Fixture oversized sản phẩm giữ đúng id, giá, status và content type: nếu bỏ cổng
byte, parser sẽ chấp nhận và regression test phải thất bại.

Transport hủy request lỗi/hết hạn và giới hạn bộ nhớ buffer. Shared HTTP helper
đặt request/header timeout 5 giây; đó không thay thế deadline outbound. Fixture
slow có timer tối đa 800 ms, hủy khi response đóng. Không retry, không ghi bền,
không worker chạy nền và không database trong bài này.

## Kiểm thử và bằng chứng

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/31-consumer-driven-contracts/test/lesson.test.mts
# Chạy ở môi trường được phép bind loopback (controller/Docker):
node --test --test-timeout=15000 lessons/31-consumer-driven-contracts/test/lesson.test.mts
npm run check
make test
```

Unit được viết trước; implementation khởi đầu trả `{}` đã gây AssertionError ở
request builder và response matcher, rồi cùng assertions pass sau triển khai.
Unit kiểm tra thiếu trường, sai primitive, enum dạng array, status đổi, trường
thêm, interaction lạ, giá ngoài giới hạn, origin và body budgets. Child import
của cả ba entrypoint có PORT/HOST/origin cố ý sai phải exit 0, stdout/stderr rỗng;
không coi startup thất bại là bằng chứng inert import.

HTTP integration test khởi động provider/consumer/verifier bằng các child độc
lập, loopback port 0, deadline cho từng fetch; đăng ký cleanup ngay khi start
thành công. Không mở listener ở top level của test. Không tạo file/database nên
không có fixture ghi vào source; nếu mở rộng persistence, đặt fixture HTTP trong
`node:os.tmpdir()` để chạy được khi source read-only. Admission test chờ counter
provider tăng trước khi gọi lượt cạnh tranh, rồi assert 429; không suy luận tính
đồng thời chỉ từ thời gian trôi qua. Test bao phủ revision tốt/thêm trường, giá
trị consumer, missing, ba breaking revision, byte limit, timeout, gating và phục
hồi. Không dùng external network hay Docker từ worker này.

Trong worker không mạng, chỉ chạy typecheck, unit và lệnh focused unit nêu trên.
HTTP integration, `npm run check` và `make test` cần controller chạy trong môi
trường cho phép loopback; không được coi chúng đã pass chỉ vì unit pass.

## Hợp đồng chứng minh điều gì?

- Unit test kiểm tra thuật toán nhỏ, không chứng minh hai process nói chuyện được.
- Contract test chọn đúng phần giao diện consumer dùng và chạy nó lên provider;
  ở đây verifier thực hiện qua HTTP thật, nên đồng thời có phần integration.
- Integration test còn kiểm tra lifecycle, cấu hình, transport và wiring của các
  process. Các lỗi port/readiness không phải mismatch hợp đồng.
- End-to-end kiểm tra luồng nghiệp vụ đầy đủ qua các thành phần thực tế. Bài này
  không có tồn kho, thanh toán, đăng nhập hay browser nên không phải E2E cửa hàng.

Pass contract **không chứng minh đúng nghiệp vụ**: provider có thể trả giá 9999
vẫn nằm trong contract; consumer sẽ tính 19998 dù giá nghiệp vụ đúng là 1250.
Assert giá trị fixture giúp phát hiện sai ví dụ này nhưng không chứng minh mọi
sản phẩm, mọi trạng thái hay mọi consumer. Pass cũng không tự cấp quyền deploy.
Cần đánh giá consumer/version khác, bảo mật, tải, rollout và approval phù hợp.
Catalogue tĩnh không có broker, discovery, version matrix, state setup tổng quát
hay can-I-deploy. Nó phù hợp để nhìn rõ cơ chế trước khi dùng công cụ đầy đủ.

## Bài tập

1. Thêm consumer dùng currency: viết assertion RED, bổ sung trường tối thiểu,
   rồi quan sát provider cũ bị từ chối. Chỉ chia sẻ hợp đồng consumer, không để
   provider import matcher để tạo response cho khớp.
2. Thêm revision giá sai nhưng primitive đúng; giải thích vì sao contract pass
   còn assertion nghiệp vụ cần fail.
3. Thêm interaction mới có state do provider chuẩn bị độc lập; tính lại số lượt,
   byte budget và deadline trước khi tăng catalogue.
4. Thêm test provider ngắt giữa body hoặc trả redirect; giữ fixture khác hợp lệ
   và kiểm tra báo cáo không chứa nội dung upstream.

Tham khảo chính thức (cơ chế và ownership, không phải format của verifier này):
[Pact: How Pact works](https://docs.pact.io/getting_started/how_pact_works) và
[Provider verification](https://docs.pact.io/getting_started/provider_verification).
