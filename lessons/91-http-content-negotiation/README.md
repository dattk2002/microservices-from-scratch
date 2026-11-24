# 91 · Thương lượng nội dung HTTP bằng Accept và độ ưu tiên

Cùng một tài nguyên `GET /greeting` có hai biểu diễn. Provider tạo lời chào. Gateway chuyển yêu cầu sang provider qua một kết nối HTTP riêng, đọc hết phản hồi trong giới hạn rồi kiểm tra nội dung trước khi trả cho client. Hai tiến trình đều có `GET /health` trả `200 {"ok":true}`, kể cả khi gateway không kết nối được provider.

## Chạy bài học

Cần Node.js 24.12 trở lên trong dòng 24 và `curl`. Mở hai terminal tại thư mục gốc của repo.

```bash
PORT=3091 node lessons/91-http-content-negotiation/provider.mts
```

```bash
PORT=4091 PROVIDER_ORIGIN=http://127.0.0.1:3091 node lessons/91-http-content-negotiation/gateway.mts
```

Các giá trị trên là mặc định. Hai dịch vụ chỉ bind vào `127.0.0.1`. `PORT=0` để hệ điều hành cấp cổng, đọc cổng thực tế từ dòng JSON lúc khởi động. `PROVIDER_ORIGIN` là origin HTTP loopback của provider, không kèm đường dẫn tài nguyên, thông tin xác thực, query hoặc fragment. Gateway từ chối cấu hình trỏ về chính cổng của nó. Dừng từng tiến trình bằng Ctrl+C.

```bash
curl -i http://127.0.0.1:4091/greeting
curl -i -H 'Accept: application/json;q=0,*/*;q=1' http://127.0.0.1:4091/greeting
curl -i -H 'Accept: image/png' http://127.0.0.1:4091/greeting
curl -i -H 'Accept: text/plain;q="1"' http://127.0.0.1:4091/greeting
curl -i http://127.0.0.1:4091/health
```

Kết quả lần lượt là JSON `{"greeting":"xin-chao"}`, văn bản `xin-chao` kết thúc bằng một byte LF, `406 not_acceptable`, `400 invalid_accept` và `200`. Có thể đổi cổng trong các lệnh thành `3091` để gọi trực tiếp provider.

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/91-http-content-negotiation/test/lesson.test.mts
node --test lessons/91-http-content-negotiation/test/lesson.test.mts
```

Lệnh đầu chỉ chạy unit test. Lệnh sau cần quyền mở cổng loopback, tạo thư mục tạm và chạy tiến trình con.

## Hợp đồng Accept

Đây là tập con có chủ đích của API bài học. Khi thiếu trường `Accept`, dịch vụ dùng `*/*`. Nhiều dòng `Accept` được ghép theo thứ tự bằng dấu phẩy rồi kiểm tra chung, tối đa 1.024 byte ASCII và 16 mục. Chấp nhận token không phân biệt hoa thường, khoảng trắng SP hoặc HTAB ở rìa mục và quanh dấu chấm phẩy, và các dạng `type/subtype`, `type/*`, `*/*`. Tham số duy nhất là `q` tùy chọn, mặc định bằng 1. Cú pháp cho phép từ 0 đến 1 với tối đa ba chữ số sau dấu chấm, kể cả `0.` và `1.`.

Các mục rỗng, media range trùng sau chuẩn hóa, wildcard sai vị trí, media parameter, extension và q đặt trong dấu ngoặc kép đều trả `400 invalid_accept`. Một danh sách hợp lệ nhưng không chọn được kiểu nào trả `406 not_acceptable`.

Với mỗi biểu diễn, lấy q từ range **cụ thể nhất** khớp với nó. Vì vậy `application/json;q=0,*/*;q=1` loại JSON và chọn văn bản. Với `application/json;q=0.1,application/*;q=1,text/plain;q=0.2`, JSON có q hiệu lực 0.1, nên văn bản thắng. So sánh q hiệu lực trước, rồi độ cụ thể. Nếu vẫn hòa, JSON thắng theo ưu tiên cố định của server.

Hai biểu diễn thành công và phản hồi 406 đều có `Vary: Accept`, để bộ đệm biết phải xét Accept khi dùng lại phản hồi. Content-Type tương ứng là `application/json; charset=utf-8` hoặc `text/plain; charset=utf-8`. Mọi lỗi do ứng dụng trả có dạng `{"error":{"code":"…","message":"…"}}`, trong đó message bằng code. Route đã biết chỉ nhận GET, phương thức khác trả `405` kèm `Allow: GET`. Route lạ trả `404`. Query hoặc body trên các route GET trả `400`. Trình phân tích HTTP của Node có thể trả lỗi riêng cho thông điệp sai cú pháp.

## Biên giữa gateway và provider

Gateway chuyển danh sách Accept đã kiểm tra cho provider và chấp nhận `200` chỉ khi biểu diễn nhận được có q hiệu lực dương, media type đúng và nội dung khớp hợp đồng. Gateway chấp nhận `406` khi không có biểu diễn phù hợp và mã lẫn thông báo trong JSON đều là `not_acceptable`. Gateway kiểm tra các trường phản hồi đơn như Content-Type, Content-Encoding và Vary trên header thô để phát hiện lặp, kiểm tra framing, giải mã UTF-8 nghiêm ngặt, xác thực JSON rồi phát lại biểu diễn chuẩn. Phản hồi lỗi giao thức, biểu diễn bị loại, redirect, HTTP 421 và hết hạn đều thành `502 upstream_failure`.

Gateway dùng trực tiếp `node:http.request` với một lần gọi, không retry, theo redirect, qua proxy hay tự giải nén. Giới hạn header là 8.192 byte mỗi chặng. Không có route nhận body, nên server từ chối body khai báo ngay và đóng kết nối thay vì chờ tải lên. Body phản hồi provider được đọc tối đa 8.192 byte. Deadline tổng là 500 ms tính đến khi đọc hết thông điệp HTTP, kể cả khi header đã đến. Gateway hủy yêu cầu đi khi client ngắt kết nối. Tối đa tám lần gọi provider đồng thời, yêu cầu vượt giới hạn nhận `503 busy` ngay. Health không chiếm suất.

Tập con này ưu tiên kết quả xác định và kiểm tra dễ hơn ở ranh giới dịch vụ. Đổi lại, client dùng media parameter hoặc cách viết Accept rộng hơn phải điều chỉnh header. Gateway lưu phản hồi nhỏ trong bộ nhớ và kiểm tra hoàn chỉnh trước khi gửi, nên bài học phù hợp với lời chào ngắn. Với nội dung lớn, streaming cần một hợp đồng riêng về lỗi sau khi đã gửi header.

## Bài tập

1. Dự đoán kết quả của `Accept: text/*;q=0.5,application/json;q=0.5`, rồi đối chiếu bằng curl.
2. Dừng provider, gọi cả hai đường dẫn của gateway và giải thích status của từng đường dẫn.
3. Thêm một biểu diễn CSV. Viết test cho q bằng nhau, trường hợp CSV bị q=0 loại, và các byte chính xác ở biên provider.

## Tham khảo

- [RFC 9110 §12.5.1 · Accept](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.1)
- [RFC 9110 §12.4.2 · Quality Values](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.4.2)
- [RFC 9110 §12.5.5 · Vary](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.5)
