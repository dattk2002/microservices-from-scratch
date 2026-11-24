# Theo redirect với allowlist và deadline toàn chuỗi

Gateway cung cấp `GET /resource`. Nó gọi một URL bắt đầu cố định, kiểm tra từng phản hồi chuyển hướng và chỉ trả tài nguyên sau khi đã nhận, giải mã và xác thực trọn vẹn phản hồi cuối. Client không có tham số để chọn URL upstream.

## Chạy tại máy

Cần Node.js 24.12 trở lên thuộc dòng 24 và ba cổng loopback còn trống. Các service chỉ dùng module tích hợp của Node. Chạy từ thư mục gốc repo, mỗi lệnh trong một terminal, theo thứ tự sau:

```bash
PORT=8096 node lessons/94-bounded-redirect-policy/resource.mts
```

```bash
PORT=8095 TARGET_ORIGIN=http://127.0.0.1:8096 node lessons/94-bounded-redirect-policy/redirector.mts
```

```bash
PORT=8094 START_ORIGIN=http://127.0.0.1:8095 TARGET_ORIGIN=http://127.0.0.1:8096 node lessons/94-bounded-redirect-policy/gateway.mts
```

Mỗi tiến trình in một dòng JSON chứa tên service và cổng sau khi bind thành công. `PORT=0` chọn cổng tạm thời. Nếu dùng cổng tạm, lấy cổng được in ra để đặt origin cho tiến trình tiếp theo. Gateway chuẩn hóa hai origin trước khi so sánh và từ chối cấu hình trùng nhau. Dừng từng tiến trình bằng Ctrl+C.

```bash
curl --max-time 2 -i http://127.0.0.1:8094/resource
curl --max-time 2 -i http://127.0.0.1:8095/start
curl --max-time 2 -i http://127.0.0.1:8096/health
```

Lệnh đầu trả `200` và `{"resource":"manual"}`. Lệnh thứ hai cho thấy phản hồi `302` với `Location: http://127.0.0.1:8096/resource`. Cả ba tiến trình có `GET /health` trả `{"status":"ok"}` mà không gọi upstream.

## Luồng xử lý

1. Gateway giữ một trong tám chỗ xử lý, lấy mốc hết hạn từ đồng hồ đơn điệu và gọi `START_ORIGIN/start`.
2. Transport dùng `node:http.request` với `agent: false`. Mỗi lần gọi tạo GET mới với `Accept: application/json` và `Host` của địa chỉ đích. Gateway không truyền header, cookie hoặc dữ liệu xác thực của client vào các hop.
3. Gateway chỉ xét `Location` sau khi đọc đến hết thông điệp HTTP. Các mã `301`, `302`, `303`, `307` và `308` đều tiếp tục bằng GET không body trong bài này. Mỗi redirect phải có đúng một trường `Location`. URL tương đối được giải theo URL của hop vừa hoàn tất. Ví dụ `2` tại `/step/1` dẫn tới `/step/2`.
4. Chính sách kiểm tra cú pháp tham chiếu thô và URL đã chuẩn hóa trước khi mở kết nối tiếp. Origin phải khớp một trong hai origin HTTP đã cấu hình, gồm đúng địa chỉ `127.0.0.1` và cổng. Path đích chỉ có thể là `/start`, `/resource`, `/step/1`, `/step/2`, `/step/3`. Query, fragment và thông tin đăng nhập đều bị từ chối. URL đã thăm được so sánh sau chuẩn hóa. Chuỗi chỉ được theo tối đa ba redirect, tức tối đa bốn lần gọi.
5. Với phản hồi cuối `200`, gateway kiểm tra kiểu media `application/json` với tùy chọn `charset=utf-8`, UTF-8 hợp lệ và object đúng một trường `resource` mang giá trị chuỗi `manual`. Gateway tự tạo lại phản hồi JSON nên `Set-Cookie` của upstream không xuất hiện ở client.

## Hợp đồng và giới hạn

| Trường hợp | Phản hồi |
| --- | --- |
| Tìm được tài nguyên hợp lệ trong hạn | `200` |
| Sai method trên route đã biết | `405 method_not_allowed`, có `Allow: GET` |
| Route không tồn tại | `404 not_found` |
| Route GET có query hoặc gửi body | `400 invalid_query` hoặc `400 invalid_body` |
| Redirect sai, vòng lặp, quá số hop, lỗi transport, body quá giới hạn, schema sai hoặc status ngoài hợp đồng (kể cả `421`) | `502 upstream_failure` |
| Hết 500 ms cho toàn bộ chuỗi | `504 upstream_timeout` |
| Đã có tám chuỗi đang chạy | `503 busy` |

Lỗi do ứng dụng phát có dạng `{"error":{"code":"upstream_failure","message":"upstream_failure"}}`, với `message` bằng `code`. Phản hồi JSON dùng `application/json;charset=utf-8`. HTTP parser có thể tự từ chối request lỗi cú pháp hoặc vượt giới hạn trước khi route chạy. Các route công khai chỉ có GET không body. Gateway từ chối dấu hiệu framing mang body ngay khi đọc header, không cần đợi body tới hạn.

Header mỗi thông điệp được giới hạn bằng tùy chọn `maxHeaderSize: 8192` của bộ phân tích HTTP trong Node; `maxHeadersCount: 0` giữ lại toàn bộ trường trong ngân sách đó để kiểm tra trường lặp. Đây là cách Node tính ngân sách header, không phải phép cộng riêng mọi byte dấu phân cách và CRLF trên dây. Body upstream được đếm trực tiếp và có tối đa 8192 byte. Dùng các trường thô để phát hiện trùng lặp trong khối header đã giới hạn theo byte. Phản hồi upstream chỉ chấp nhận identity coding. Body redirect có thể chứa byte tùy ý trong giới hạn. Gateway vẫn đợi hết body, kể cả chunk kết thúc khi dùng chunked, rồi mới thử hop mới. Timer của mỗi thao tác được tính theo phần thời gian còn lại đến cùng một deadline. Kiểm tra lại thời gian khi tới EOF ngăn phản hồi muộn được coi là thành công nếu callback timer chưa kịp chạy. Gateway không phát thành công từng phần và hủy kết nối đang gọi khi client ngắt. Chỗ xử lý được trả trong `finally`, không có hàng chờ.

Bài học chủ động giới hạn HTTP vào hai địa chỉ loopback literal. Nếu cần hỗ trợ tên miền hoặc đích động, phải thiết kế chính sách riêng cho DNS, địa chỉ IPv4/IPv6 được phép, địa chỉ thực khi kết nối, proxy và ranh giới mạng. Chính sách GET ở đây cũng không mô tả cách phát lại body hoặc chuyển đổi method trong hệ thống hỗ trợ POST. Đọc trọn body trước khi đi tiếp giúp việc xác thực rõ ràng, đổi lại một redirect chậm có thể dùng hết ngân sách của cả chuỗi.

## Kiểm thử và bài tập

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/94-bounded-redirect-policy/test/lesson.test.mts
node --test lessons/94-bounded-redirect-policy/test/lesson.test.mts
```

Lệnh thứ nhất chạy chính sách với đồng hồ giả lập và kiểm tra việc import entrypoint. Lệnh thứ hai cần quyền mở cổng loopback tạm, chạy các tiến trình độc lập và quan sát số request tại từng đích. Fixture đích thứ ba có thể kết nối được nhưng bộ đếm request tài nguyên phải bằng 0 khi redirect bị từ chối.

- Vẽ vết chạy cho chuỗi `/start → /step/1 → /step/2 → /step/../start`. Xác định thao tác đầu tiên không được mở kết nối và giải thích URL nào nằm trong tập đã thăm.
- Dùng fixture để cho hai hop lần lượt tốn 200 ms và 310 ms. Giải thích vì sao chuỗi hết hạn dù từng hop hoàn thành trong 500 ms.
- Thay header của phản hồi cuối bằng hai trường `Content-Type` và dự đoán vì sao kết quả phải khác với trường hợp một header hợp lệ.

## Tham khảo

- Mã trạng thái chuyển hướng trong RFC 9110. https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4
- Cách diễn giải trường `Location` trong RFC 9110. https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.2
- Framing của thông điệp HTTP/1.1 trong RFC 9112. https://www.rfc-editor.org/rfc/rfc9112.html#section-6
- API HTTP của Node.js. https://nodejs.org/docs/latest-v24.x/api/http.html
