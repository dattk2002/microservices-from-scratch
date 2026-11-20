# Ghép kênh HTTP/2 và hủy riêng từng stream

Một kết nối HTTP/2 có thể mang nhiều stream đồng thời. Bài này mở hai stream trên
cùng session rồi gửi `RST_STREAM(CANCEL)` cho stream đang chờ. Stream còn lại vẫn
đọc được phản hồi đầy đủ. Mục tiêu là nhìn thấy phạm vi của thao tác hủy ở cả hai
đầu kết nối.

## Chạy bài

Dùng Node.js 24.x, tối thiểu 24.12.0. Chạy các lệnh từ thư mục gốc kho mã. Hai tiến
trình dùng các mô-đun có sẵn của Node.js. Lệnh `curl` chỉ cần cho ví dụ gọi gateway.

Terminal 1 chạy worker HTTP/2 cleartext theo chế độ prior knowledge.

```sh
PORT=3087 node lessons/87-h2-stream-cancellation/worker.mts
```

Terminal 2 chạy gateway HTTP/1.1. Chờ mỗi tiến trình in dòng readiness có
`service` và `port` trước khi gửi request.

```sh
PORT=4087 WORKER_ORIGIN=http://127.0.0.1:3087 node lessons/87-h2-stream-cancellation/gateway.mts
```

Terminal 3 gọi gateway.

```sh
curl --http1.1 -i http://127.0.0.1:4087/demo
```

Phản hồi thành công có status `200` và body sau.

```json
{"fast":"ok","cancelled":true}
```

Cả hai dịch vụ luôn bind vào `127.0.0.1`. `PORT` mặc định là `3087` cho worker và
`4087` cho gateway. Đặt `PORT=0` để hệ điều hành cấp cổng và lấy cổng thực từ
readiness. `WORKER_ORIGIN` mặc định là `http://127.0.0.1:3087`. Giá trị cấu hình
phải có dạng `http://127.0.0.1`, có thể kèm cổng từ 1 đến 65535 và một dấu
`/` cuối. Dừng dịch vụ bằng Ctrl+C hoặc SIGTERM.

Có thể gọi worker trực tiếp từ một client có hỗ trợ prior knowledge.

```sh
curl --http2-prior-knowledge -i http://127.0.0.1:3087/fast
```

Lệnh trực tiếp yêu cầu bản `curl` có HTTP/2. Worker trả `200` với
`{"value":"ok"}`. Gọi riêng `/slow` sẽ nhận headers `200`, rồi stream bị reset
khi bộ hẹn giờ của worker hết hạn nếu client chưa hủy.

## Giao diện

| Dịch vụ | Request | Hành vi |
| --- | --- | --- |
| Gateway HTTP/1.1 | `GET /demo` | Trả `200 {"fast":"ok","cancelled":true}` sau khi cả hai điều kiện của demo được xác nhận |
| Worker h2c | `GET /slow` | Gửi headers `200` cho JSON với stream còn mở, chờ reset |
| Worker h2c | `GET /fast` | Gửi `200 {"value":"ok"}` và kết thúc phía gửi của stream |

Các route nhận request không có query hoặc body. HTTP/2 yêu cầu `:scheme` là
`http`, `:authority` là địa chỉ loopback được chấp nhận, `:method` hợp lệ và
`:path` ở dạng đường dẫn của origin. Một request có cờ `END_STREAM` ngay trên
HEADERS có thể được xử lý tức thì sau khi kiểm tra headers. Nếu cờ chưa có,
worker đợi EOF có giới hạn và từ chối DATA mang nội dung hoặc trailers.

| Status | Mã lỗi ứng dụng | Khi xảy ra |
| --- | --- | --- |
| `404` | `not_found` | Route không tồn tại |
| `405` | `method_not_allowed` | Route có thật nhưng sai method, kèm `Allow: GET` |
| `400` | `invalid_query` | Có query trên route đã biết |
| `400` | `invalid_body` | Framing báo có body, có dữ liệu hoặc trailers, hoặc coding khác identity |
| `400` | `invalid_headers` | Header liên quan bị lặp hoặc pseudo-header bị từ chối ở tầng ứng dụng |
| `408` | `body_timeout` | Request chưa kết thúc trong hạn đọc |
| `431` | `headers_too_large` | Danh sách header HTTP/2 vượt ngân sách khi đã đến tầng ứng dụng |
| `502` | `upstream_failure` | Worker hoặc phản hồi vi phạm hợp đồng, hoặc hết hạn demo |
| `503` | `busy` | Gateway đã dùng đủ bốn chỗ cho session demo |

Ví dụ, mã `invalid_query` có envelope
`{"error":{"code":"invalid_query","message":"invalid_query"}}`. HEAD chỉ nhận
headers theo quy tắc HTTP. Parser HTTP/1.1 hoặc HTTP/2 có thể đóng kết nối, reset
stream hoặc trả lỗi gốc khi phát hiện framing xấu hay headers vượt giới hạn
trước khi request đến handler.

## Vòng đời của một demo

```text
Client HTTP/1.1           Gateway                       Worker h2c
     │ GET /demo ───────────►│                              │
     │                       │── GET /slow + END_STREAM ──►│
     │                       │◄─ 200 HEADERS, stream mở ────│
     │                       │── GET /fast + END_STREAM ──►│
     │                       │── RST_STREAM(CANCEL) /slow ─►│
     │                       │◄─ 200 JSON + EOF trên /fast ─│
     │◄──── 200 JSON ────────│                              │
```

Gateway mở một session dành riêng cho demo sau khi kiểm tra request HTTP/1.1.
Nó đợi HEADERS hợp lệ của `/slow` rồi mở `/fast` và gọi
`slow.close(NGHTTP2_CANCEL)`. DATA, trailers hoặc kết thúc bình thường của
`/slow` được quan sát trước khi gateway yêu cầu reset đều làm demo thất bại.
HEADERS đầu mang `END_STREAM` cũng là lỗi vì stream đã được khai báo kết thúc.

Gateway chờ sự kiện `close` với `rstCode=CANCEL` ở stream chậm. Trên stream
nhanh, sự kiện `end` và `rstCode=0` vẫn có thể xuất hiện khi peer gửi
`RST_STREAM(NO_ERROR)`. Vì vậy gateway theo dõi cờ `END_STREAM` trên frame
DATA hoặc HEADERS của đúng stream nhanh. Bộ quan sát giữ chín byte header,
đếm số byte payload còn lại và chuyển nguyên dữ liệu cho `node:http2`.
Gateway chỉ chấp nhận EOF sau khi nhận trọn frame kết thúc, kiểm tra toàn
bộ JSON và xác nhận stream đóng bình thường. Hai điều kiện có thể hoàn tất theo thứ tự bất kỳ. `rstCode` ở client
xác nhận kết quả cục bộ. Để xác nhận peer thấy reset, kiểm thử tích hợp ghi nhận
`rstCode` từ phía server của fixture. Các callback đã quan sát được là căn cứ
cho quyết định của gateway. Thứ tự các frame chưa được callback báo vẫn chưa
được xác nhận.

Session được giải phóng sau khi demo hoàn tất hoặc thất bại. Khi client HTTP/1.1
ngắt kết nối, khi hết hạn hoặc khi dịch vụ dừng, gateway hủy phần việc còn treo
và giải phóng socket. Quyền mở demo mới chỉ được trả lại sau khi socket đóng.

## Giới hạn và đánh đổi

- Gateway cấp tối đa bốn session đang hoạt động mỗi tiến trình. Worker cũng giữ
  tối đa bốn session và đóng session dư. Hai đầu quảng bá giới hạn hai stream
  đồng thời và worker còn kiểm tra giới hạn tại handler. Stream dư đã được
  dispatch có thể nhận `REFUSED_STREAM`. Client tuân thủ SETTINGS có thể tự
  xếp hàng cho request tiếp theo. Khi nhận GOAWAY, worker cho socket tối đa
  1000 ms để hoàn tất các stream đang mở. Bộ hẹn giờ này gắn với socket TCP
  để vẫn thu hồi được kết nối nếu peer chậm đóng phía gửi.
- Hạn demo là 500 ms, tính từ trước khi kết nối qua bước nhận HEADERS, EOF và
  sự kiện đóng của các stream. Đồng hồ đơn điệu được kiểm tra lại lúc hoàn
  tất để tránh thành công sau hạn khi callback hẹn giờ bị chậm. Worker dành
  tối đa 500 ms để nhận đủ request. Stream chậm tự reset bằng CANCEL khi đạt
  giới hạn vòng đời 1000 ms kể từ lúc được dispatch.
- HTTP/1.1 có giới hạn header 8192 byte tại parser và kiểm tra các trường liên
  quan từ danh sách thô. Mỗi đầu HTTP/2 quảng bá giới hạn danh sách header
  8192 byte và kiểm tra tổng kích thước UTF-8 của tên, giá trị và 32 byte phụ
  phí cho từng trường, kể cả pseudo-header. Phản hồi nhanh được đọc tối đa
  8192 byte, dùng identity coding và giải mã UTF-8 nghiêm ngặt. Kiểu nội dung
  phải là `application/json`, có thể kèm duy nhất tham số `charset=utf-8`.
- Một session cho mỗi demo giúp nhìn rõ quyền sở hữu và vòng đời, đổi lại là
  chi phí thiết lập TCP và SETTINGS cho mỗi lượt gọi. Hai stream chia sẻ kết
  nối và vẫn chịu ảnh hưởng chung khi TCP bị nghẽn hoặc mất gói. Bài chỉ dùng
  h2c trên loopback, không dùng TLS, ALPN, push hay pool. Đích worker cố định
  theo cấu hình và mỗi stream chỉ có một lần gọi.

## Kiểm thử và bài tập

```sh
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/87-h2-stream-cancellation/test/lesson.test.mts
```

Unit test mô phỏng các callback stream để kiểm soát thứ tự sự kiện, bao gồm
DATA hoặc trailers đến trước reset và trường hợp hết hạn đúng lúc hoàn tất.
Kiểm thử tích hợp chạy worker và gateway ở các tiến trình riêng trên cổng
tạm. Kiểm thử adapter đợi nhận DATA hoặc trailers trên stream chậm trước
khi yêu cầu reset, nên kết quả không phụ thuộc vào thứ tự giữa hai event loop.
Một client trực tiếp hủy `/slow` rồi hoàn tất hai lần gọi `/fast` trên
cùng session. Fixture HTTP/2 ghi nhận đúng hai đường dẫn và mã reset, đồng
thời thử phản hồi hỏng, GOAWAY và phản hồi thiếu EOF.

1. Dùng client trực tiếp để giữ `/slow` mở rồi đọc `/fast` trước khi hủy.
   Quan sát stream nào chấm dứt và session còn nhận request mới hay không.
2. Thử gửi request HTTP/2 có DATA hoặc trailing HEADERS sau HEADERS đầu chưa
   mang `END_STREAM`. Kiểm tra status và envelope worker trả về.
3. Giữ bốn demo đồng thời ở bước chờ HEADERS của `/slow`. Đối chiếu status
   trả về cho lượt thứ năm với số kết nối fixture thực sự nhận.

## Tài liệu gốc

- RFC 9113, xem phần 4.3 về nén và kích thước trường, phần 5 về streams, phần
  6.4 về RST_STREAM và phần 6.8 về GOAWAY. [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113.html)
- API của `node:http2` trên phiên bản tối thiểu của bài, xem `connect`,
  `Http2Session`, `Http2Stream.close()` và các callback headers. [Node.js 24.12.0](https://nodejs.org/download/release/v24.12.0/docs/api/http2.html)
