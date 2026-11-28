# WebSocket có giới hạn thông điệp và heartbeat

Bài học xây một luồng echo WebSocket từ HTTP Upgrade đến đóng kết nối. Server tự
đọc frame RFC 6455 theo từng phần để thấy rõ ranh giới giữa một chunk TCP, một
frame và một thông điệp. Client chạy ở tiến trình riêng, mở HTTP Upgrade bằng
`node:http` rồi dùng chung codec với server để đọc frame trực tiếp từ socket.

## Chạy thử

Cần Node.js 24.12 trở lên trong nhánh 24.x. Runtime chỉ dùng mô-đun tích hợp.
Từ thư mục gốc của repo, chạy server ở terminal thứ nhất.

```sh
PORT=8099 node lessons/99-bounded-websocket-heartbeat/server.mts
```

Ở terminal thứ hai, kiểm tra HTTP rồi chạy client.

```sh
curl -i http://127.0.0.1:8099/health
PORT=8099 node lessons/99-bounded-websocket-heartbeat/client.mts
```

Server chỉ lắng nghe trên `127.0.0.1`. Hai tiến trình mặc định dùng cổng
`8099`. Server chấp nhận `PORT=0` để hệ điều hành chọn cổng và in
`{"port":...}` khi sẵn sàng. Dùng cổng được in ra cho client. Client gửi một
chuỗi, đối chiếu echo, yêu cầu đóng với mã 1000 và in
`{"echo":"Xin chào WebSocket","closeCode":1000}` sau khi xác nhận đóng sạch.
Lỗi in JSON ra stderr và thoát với mã 1. Toàn bộ phiên client có hạn 3 giây.
Nhấn Ctrl+C ở terminal server để đóng các phiên đang mở.

```sh
node --test --test-name-pattern=unit: lessons/99-bounded-websocket-heartbeat/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/99-bounded-websocket-heartbeat/test/lesson.test.mts
```

Unit test đưa byte trực tiếp vào codec, điều khiển đồng hồ heartbeat và close,
rồi dùng stream trong bộ nhớ để kiểm tra backpressure. Integration test khởi
động tiến trình server ở cổng tạm, chạy client thật và dùng peer TCP để kiểm
tra frame lỗi, giới hạn byte và việc giải phóng kết nối khi shutdown.

## Hợp đồng HTTP và Upgrade

- `GET /health` trả 200 cùng `{"ok":true}`, kể cả khi hết chỗ WebSocket.
- `GET /events` yêu cầu HTTP/1.1, token `Upgrade` trong `Connection`,
  `Upgrade: websocket`, phiên bản 13 và một key base64 chuẩn biểu diễn đúng
  16 byte. Server tính `Sec-WebSocket-Accept` bằng SHA-1 trên key nối với
  GUID của RFC, rồi mã hóa base64. Những byte đi kèm ngay sau Upgrade được
  chuyển vào codec sau khi đã ghi phản hồi 101.
- Với HTTP/1.1, `Host` phải là `127.0.0.1` hoặc `localhost`, có thể kèm cổng
  từ 1 đến 65535 ở dạng thập phân không có số 0 đứng đầu.
- Query, body, subprotocol và trường đơn bị lặp làm yêu cầu không hợp lệ.
  Server bỏ qua đề nghị extension, kể cả `permessage-deflate` do client Node
  đưa ra, và luôn kiểm tra RSV bằng 0. Chỉ khai báo extension trong request
  không đủ để dùng extension đó.
- Lỗi HTTP dùng `application/json;charset=utf-8` và
  `{"error":{"code":"…","message":"…"}}`, trong đó hai giá trị giống nhau.
  Yêu cầu sai trả 400 `bad_request`, đường dẫn lạ trả 404 `not_found`,
  phương thức sai trả 405 `method_not_allowed` kèm `Allow: GET`.
  Phiên thứ chín nhận 503 `busy` trước 101. Lỗi cú pháp hoặc framing bị
  bộ phân tích HTTP chặn có thể nhận lỗi gốc của Node.
- Header tối đa 8192 byte với hạn 500 ms từ khi nhận socket. Cả hai đường
  dẫn đều chỉ nhận yêu cầu không có body. Server từ chối khai báo body
  thay vì đọc hay giải mã nó. Bài này không có đường dẫn nhận JSON hoặc
  yêu cầu HTTP đến dịch vụ phụ thuộc.

## Xử lý sau Upgrade

Codec giữ tối đa 8192 byte chờ xử lý và vùng riêng 4096 byte cho thông điệp
text. Header được kiểm tra trước khi đợi payload, kể cả độ dài mở rộng và
bit cao của độ dài 64 bit. Mọi frame từ client phải có mask. Continuation
được ghép theo byte, nên một ký tự UTF-8 có thể nằm qua hai frame. Ping và
pong xen giữa các fragment không làm thay đổi trạng thái ghép. Text chỉ
được kiểm tra UTF-8 và echo sau fragment cuối. Frame server không có mask.
Client dùng mask ngẫu nhiên mới cho mỗi frame, kể cả pong và close.

| Tình huống | Phản ứng |
| --- | --- |
| Sai mask, RSV, opcode, thứ tự fragment, độ dài hoặc cấu trúc close | Close 1002 |
| Binary | Close 1003 |
| Text hoặc lý do close sai UTF-8 | Close 1007 |
| Text khai báo vượt 4096 byte khi cộng các fragment | Close 1009 trước khi đợi payload |
| Shutdown hoặc thiếu pong đúng hạn | Close 1001 |
| Hàng đợi ghi vượt 8192 byte | Hủy socket |

Mỗi phiên chỉ có một ping đang chờ, với token ngẫu nhiên 8 byte. Server chờ
ít nhất 250 ms giữa hai lần gửi và dùng đồng hồ đơn điệu để giới hạn thời
gian đợi pong ở 1000 ms. Chỉ pong trùng token và đến trước hạn mới xác nhận
ping. Text và pong sai token không gia hạn. Ping từ peer nhận pong có cùng
payload.

Khi `socket.write()` trả `false`, hai phía đợi `drain` trước khi ghi tiếp.
Giới hạn đầu ra tính cả byte đang chờ trong stream và hàng đợi của ứng
dụng. Mỗi phía gửi tối đa một close frame. Nếu peer gửi close trước, phía
nhận phản hồi bằng cùng payload. Trong lúc đợi close từ peer, hai phía vẫn
trả pong cho ping và bỏ qua text mới. Socket bị hủy nếu phiên vẫn mở sau
250 ms kể từ khi bắt đầu đóng.

## Phạm vi và bài tập

Codec viết tay minh họa một tập con phục vụ học tập. Bài chỉ hỗ trợ text,
các frame điều khiển và loopback. Phạm vi không bao gồm nén, truyền binary,
TLS, xác thực, cấp quyền theo `Origin` trình duyệt hoặc triển khai production.
Client kết nối duy nhất đến `127.0.0.1` ở cổng đã chọn. Client giới hạn header
phản hồi ở 8192 byte, kiểm tra 101 và đúng một `Sec-WebSocket-Accept` khớp với
key đã gửi. Client từ chối extension, subprotocol và các trường
`Content-Length` (kể cả 0), `Transfer-Encoding`, `Trailer` hoặc
`Content-Encoding` trong phản hồi 101. Sau Upgrade, codec đọc ngay các byte đi kèm phản hồi và áp dụng giới hạn 4096 byte
trước khi tích lũy payload khai báo. Một fragment dở dang trong ngân sách byte
vẫn chịu hạn toàn phiên 3 giây. Sau echo hợp lệ, client chờ hoàn tất đóng tối
đa 250 ms. Nếu peer đóng trước khi echo, client gửi close phản hồi rồi báo
lỗi. Client chỉ thực hiện một lần kết nối.

1. Chia ký tự UTF-8 bốn byte qua ba fragment và thêm ping ở giữa. Kiểm tra
   thứ tự pong và echo.
2. Gửi text trước khi hết hạn heartbeat nhưng giữ lại pong. Quan sát mã
   close và đo thời gian từ ping đến close.
3. Giữ tám phiên rồi đóng một phiên bằng close frame đúng chuẩn. Kiểm tra
   khi nào có thể mở phiên mới và `GET /health` trả gì trong cả quá trình.

## Tài liệu gốc

- [RFC 6455, giao thức WebSocket](https://www.rfc-editor.org/rfc/rfc6455.html)
- [WebSocket tích hợp trong Node.js 24.12](https://nodejs.org/download/release/v24.12.0/docs/api/globals.html#class-websocket)
- [Sự kiện HTTP upgrade trong Node.js 24.12](https://nodejs.org/download/release/v24.12.0/docs/api/http.html#event-upgrade)
