# Đóng khung thông điệp TCP bằng độ dài

TCP chuyển một luồng byte theo thứ tự. Một lần `socket.write()` có thể được
đọc qua nhiều sự kiện `data`, và một sự kiện `data` có thể chứa phần cuối của
frame trước cùng các frame tiếp theo. Bài này dùng tiền tố độ dài để tìm ranh
giới thông điệp, rồi dùng FIN để xác nhận peer đã gửi hết dữ liệu của một RPC.

## Chạy thử

Cần Node.js từ 24.12.0 trở lên trong dòng 24.x. Bài chạy trực tiếp bằng các
module tích hợp của Node.js. Tại thư mục gốc, chạy `npm ci` để cài công cụ
kiểm tra kiểu của repo.

Chạy worker trong terminal thứ nhất.

```bash
PORT=3086 node lessons/86-length-prefixed-tcp/worker.mts
```

Chạy gateway trong terminal thứ hai.

```bash
PORT=4086 WORKER_ORIGIN=tcp://127.0.0.1:3086 node lessons/86-length-prefixed-tcp/gateway.mts
```

Mỗi tiến trình chỉ lắng nghe trên `127.0.0.1` và in một dòng JSON
`{"service":"worker","port":3086}` hoặc `{"service":"gateway","port":4086}`
sau khi bind thành công. `PORT=0` yêu cầu hệ điều hành chọn cổng. Nếu dùng
cổng động của worker, lấy cổng đã in để đặt `WORKER_ORIGIN` cho gateway.

`WORKER_ORIGIN` mặc định là `tcp://127.0.0.1:3086`. Giá trị phải đúng nguyên
dạng `tcp://127.0.0.1:PORT`, với cổng thập phân từ 1 đến 65535 và chữ số đầu
khác 0. Gateway kiểm tra chuỗi gốc rồi tách host và cổng một lần trước khi
lắng nghe. Đường dẫn, thông tin đăng nhập, query, fragment, khoảng trắng và
tên thay thế cho địa chỉ loopback đều bị từ chối.

Gửi một yêu cầu từ terminal thứ ba.

```bash
curl -i http://127.0.0.1:4086/echo \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data '{"text":"Hello 86"}'
```

Gateway trả HTTP 200 với `{"echo":"Hello 86"}`. Dừng từng tiến trình bằng
Ctrl+C.

## Hợp đồng HTTP

`POST /echo` nhận đối tượng JSON có đúng trường `text`. Giá trị gồm 1 đến 64
ký tự thuộc `A–Z`, `a–z`, `0–9` hoặc dấu cách ASCII. Gateway giữ nguyên dấu
cách và chữ hoa, chữ thường. Endpoint không nhận query string.

Body chứa tối đa 8192 byte JSON UTF-8 trước khi giải mã. Với transfer coding
`chunked`, gateway đếm các byte dữ liệu và chờ cả phần kết thúc của body.
`Content-Type` phải là `application/json`, có thể kèm duy nhất tham số
`charset=utf-8`. Giá trị charset có thể đặt trong dấu ngoặc kép. Tên media
type, tham số và giá trị charset được so sánh không phân biệt hoa, thường.
`Content-Encoding` có thể vắng mặt hoặc xuất hiện đúng một lần với
`identity`. Gateway kiểm tra các trường HTTP gốc trước khi dùng giá trị,
kể cả khi có nhiều header ngắn đứng trước một trường lặp.

Lỗi ứng dụng có dạng `{"error":{"code":"invalid_body","message":"invalid_body"}}`,
với cùng mã trong `code` và `message`.

| HTTP | Mã lỗi | Điều kiện |
| --- | --- | --- |
| 400 | `invalid_query` | Endpoint nhận query string. |
| 400 | `invalid_json` | Body không giải mã được thành JSON UTF-8. |
| 400 | `invalid_body` | Dữ liệu sai schema hoặc cách xác định độ dài không được hỗ trợ. |
| 404 | `not_found` | Đường dẫn không tồn tại. |
| 405 | `method_not_allowed` | Phương thức khác POST trên `/echo`, có header `Allow: POST`. |
| 408 | `body_timeout` | Body HTTP chưa hoàn tất trong 500 ms tính từ lúc handler bắt đầu. |
| 413 | `body_too_large` | Body vượt 8192 byte. |
| 415 | `unsupported_media_type` | Thiếu media type, hoặc media type hay content coding bị lặp hoặc không được hỗ trợ. |
| 502 | `upstream_failure` | Kết nối TCP thất bại, quá hạn hoặc phản hồi vi phạm giao thức. |
| 503 | `busy` | Gateway đã có tám RPC TCP đang hoạt động. |

HTTP parser có giới hạn header 8192 byte. Framing HTTP không hợp lệ ở tầng
parser có thể nhận lỗi HTTP do Node.js sinh ra hoặc bị đóng socket trước khi
handler chạy.

## Frame nhị phân và vòng đời RPC

Mỗi frame gồm 4 byte độ dài không dấu theo thứ tự big-endian, theo sau là
đúng số byte payload đã khai báo. Độ dài hợp lệ từ 1 đến 1024 byte. Ví dụ,
payload hai byte `41 42` có frame `00 00 00 02 41 42`. Decoder coi payload
là byte tùy ý. Tầng RPC mới giải mã UTF-8 nghiêm ngặt, phân tích JSON và kiểm
tra schema.

```text
Client HTTP       Gateway HTTP          Worker TCP
    | POST /echo       |                    |
    |----------------->| frame {text}      |
    |                  |------------------->|
    |                  | FIN                |
    |                  |------------------->| kiểm tra toàn bộ luồng
    |                  |       frame {echo} |
    |                  |<-------------------|
    |                  |                FIN |
    |                  |<-------------------|
    | 200 {echo}       | kiểm tra toàn bộ luồng và đối chiếu text
    |<-----------------|
```

Gateway mở một kết nối mới cho mỗi RPC. Cả hai đầu dùng `allowHalfOpen: true`
để khi một đầu nhận FIN, chiều ghi của đầu đó vẫn mở. `end(frame)` gửi
frame rồi kết thúc chiều ghi. Gateway gọi nó ngay khi gửi yêu cầu, còn
worker chỉ gọi sau khi nhận sự kiện `end` của chiều đọc và kiểm tra xong
yêu cầu. Worker gửi đúng một đối tượng `{"echo":"..."}` trong một frame.
Gateway chỉ trả 200 sau khi chiều đọc kết thúc với đúng một frame và
`echo` trùng chính xác với `text` đã gửi.

`FrameDecoder.push(chunk)` trả các frame hoàn chỉnh theo thứ tự, kể cả khi
chúng nằm chung một chunk. Decoder giữ tối đa 1028 byte bộ đệm cho header và
payload đang xử lý. Khi đủ bốn byte header, decoder kiểm tra độ dài trước
khi cấp phát bộ đệm payload. Mỗi byte được chép vào vị trí đích một lần.
`finish()` chấp nhận luồng rỗng ở tầng decoder, nhưng từ chối header hoặc
payload dở dang. Lớp `SingleFrame` áp thêm điều kiện phải có đúng một frame
cho RPC. Một frame đúng theo sau bằng hai byte header vẫn là luồng lỗi.

Cả hai tiến trình giữ tối đa tám RPC TCP hoạt động. Worker hủy socket vượt
giới hạn mà không gửi frame. Ngân sách 500 ms tính bằng đồng hồ đơn điệu từ
lúc worker nhận socket hoặc gateway bắt đầu kết nối. Một timer xử lý peer
im lặng, và các bước đọc, kiểm tra EOF, kết thúc kết nối đều kiểm tra thời
gian đã trôi qua. Một peer gửi đủ frame nhưng giữ chiều ghi mở vẫn làm RPC
quá hạn. Lỗi, đóng kết nối khi chưa thấy `end`, và hủy từ phía HTTP đều kết
thúc RPC và trả lại suất sau khi socket TCP đóng. Worker đóng kết nối không
gửi phản hồi nếu yêu cầu TCP sai. Gateway có đúng một lần thử cho mỗi RPC.

## Kiểm tra và thử nghiệm

```bash
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/86-length-prefixed-tcp/test/*.test.mts
```

Unit test mở đầu đưa hai byte đầu của header vào decoder, sau đó đưa phần
header còn lại, payload và cả frame tiếp theo trong cùng chunk. Kết quả là
hai payload đúng thứ tự. Một unit test khác chia cùng một frame ở từng vị
trí byte có thể. Integration test với worker thật ghi từng byte và kết
thúc chiều ghi sau byte cuối. Kích thước các lần ghi của test không ràng
buộc kích thước chunk Node.js đọc được.

Kết nối riêng cho mỗi RPC giúp dùng EOF làm ranh giới kết thúc trao đổi,
đổi lại mỗi lần gọi tốn một lần thiết lập kết nối. Bài này chỉ chạy trên
loopback và không có TLS, xác thực, request ID, pooling hay multiplexing.
Với kết nối sống lâu, cần quy tắc tương quan phản hồi hoặc thứ tự xử lý
và một cách kết thúc từng RPC trong khi luồng TCP vẫn mở.

1. Sửa client TCP trong integration test để gộp nhiều lần ghi và quan sát
   kết quả sau FIN. Giữ nguyên dữ liệu và thứ tự byte.
2. Cho peer thử gửi một frame đúng cộng với một byte header rồi đóng chiều
   ghi. So sánh với trường hợp gửi frame đúng nhưng giữ chiều ghi mở.
3. Thử tách giới hạn số kết nối khỏi hợp đồng frame. Giải thích gateway
   nên trả gì khi một worker quá tải đóng socket và khi gateway đã dùng hết
   tám suất cục bộ.

## Tài liệu gốc

- Đặc tả TCP, bao gồm luồng byte và thủ tục đóng kết nối. [RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html)
- API socket, `allowHalfOpen` và các sự kiện `end`, `close`. [Node.js 24.12.0 net](https://nodejs.org/download/release/v24.12.0/docs/api/net.html)
- Đọc và ghi số nguyên không dấu big-endian. [Node.js 24.12.0 Buffer](https://nodejs.org/download/release/v24.12.0/docs/api/buffer.html)
