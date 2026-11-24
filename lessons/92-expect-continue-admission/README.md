# Từ chối upload sớm với Expect: 100-continue

Khi upload qua HTTP/1.1, client có thể gửi header trước và chờ phản hồi tạm
thời `100 Continue` rồi mới gửi nội dung. Receiver dùng khoảng chờ đó để
kiểm tra request và giữ chỗ xử lý. Ví dụ, nếu kích thước khai báo vượt giới hạn,
receiver trả `413` ngay và uploader không gửi byte nào của payload.

## Chạy thử

Cần Node.js **24.12 trở lên trong dòng 24**. Mã chạy bằng các module tích hợp
của Node, không cần cài thư viện runtime. Chạy từ thư mục gốc của repo.

Terminal 1:

```bash
PORT=3000 node lessons/92-expect-continue-admission/receiver.mts
```

Receiver chỉ nghe trên `127.0.0.1`. Dùng `PORT=0` để hệ điều hành chọn cổng
trống và đọc cổng thực tế từ dòng JSON khởi động.

Terminal 2:

```bash
RECEIVER_ORIGIN=http://127.0.0.1:3000 PAYLOAD=hello \
  node lessons/92-expect-continue-admission/uploader.mts
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/stats
```

Với một lần chạy thành công, uploader in:

```json
{"ok":true,"bytes":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}
```

Nếu vừa khởi động receiver và chỉ chạy một upload, `/stats` trả
`{"accepted":1,"completed":1,"bytes":5,"active":0}`.
`PAYLOAD` mặc định là `hello`. `RECEIVER_ORIGIN` mặc định là
`http://127.0.0.1:3000` và chỉ chấp nhận origin HTTP với địa chỉ
`127.0.0.1` viết nguyên dạng. Payload được mã hóa UTF-8, nên giới hạn tính
theo số byte. Có thể import hàm `upload(origin, payload)` từ `uploader.mts`.

So sánh với request gửi nội dung ngay:

```bash
curl -i --http1.1 -H 'Expect:' -H 'Content-Type: application/octet-stream' \
  --data-binary 'hello' http://127.0.0.1:3000/upload
```

Để quan sát một lần từ chối sớm, gửi nội dung 8193 byte với curl. Uploader của
bài giới hạn kích thước ngay ở đầu vào nên sẽ không mở kết nối cho payload này.

```bash
node -e 'process.stdout.write(Buffer.alloc(8193, 97))' | \
  curl -i --http1.1 -H 'Expect: 100-continue' \
    -H 'Content-Type: application/octet-stream' \
    --data-binary @- http://127.0.0.1:3000/upload
```

## Luồng xử lý

1. Uploader mở một kết nối HTTP/1.1 qua `node:http.request` với `agent: false`.
   Nó đẩy header bằng `flushHeaders()`, rồi chờ frame tạm thời. Chỉ frame
   `100` đầu tiên cho phép gọi `end(payload)`.
2. Receiver dùng `request`, `checkContinue` và `checkExpectation` để áp dụng
   chung một bước kiểm tra tuyến, phương thức, query và header. Khi nhận
   `POST /upload` hợp lệ, receiver giữ một slot trước khi gọi
   `writeContinue()`. Request không có `Expect` phải giữ cùng slot đó.
3. Receiver đếm byte và cập nhật SHA-256 theo từng chunk. Khi request kết
   thúc đầy đủ, đúng kích thước và còn trong hạn, receiver nhả slot và trả
   `201` với `{bytes, sha256}`. Nếu phía gửi ngắt giữa chừng hoặc gửi thiếu,
   receiver nhả slot và giữ nguyên số lần hoàn tất.
4. Uploader giới hạn phản hồi và kiểm tra toàn bộ JSON. Một thành công cần
   đúng hai trường, đúng số byte và đúng SHA-256 của payload đã gửi. Uploader
   dùng một hạn tổng 500 ms tính bằng đồng hồ đơn điệu, từ lúc bắt đầu request
   đến lúc đã nhận và kiểm tra xong phản hồi. Receiver có hạn 500 ms riêng từ
   lúc xét giữ slot. Hết hạn ở uploader sẽ đóng kết nối, kể cả khi receiver
   chưa trả gì.

## Hợp đồng HTTP

`POST /upload` dùng đúng media type `application/octet-stream`, một
`Content-Length` dạng thập phân chính tắc trong khoảng 1–8192, không có
`Transfer-Encoding` hoặc `Content-Encoding`. Có thể bỏ `Expect` hoặc gửi
một trường `Expect: 100-continue`, không phân biệt hoa thường ở giá trị.
`GET /health` trả `{"ok":true}`. `GET /stats` chỉ đọc số lần giữ chỗ, số
lần nhận hoàn tất, tổng byte đã đọc trong các upload được nhận và số slot
đang dùng. Các bộ đếm tích lũy bão hòa tại `Number.MAX_SAFE_INTEGER` và trở
về 0 khi khởi động lại.

| HTTP | Mã lỗi | Điều kiện |
| --- | --- | --- |
| 400 | `invalid_headers` | Header trùng hoặc mơ hồ, độ dài sai dạng, có query hoặc có body trên tuyến chỉ đọc |
| 404 | `not_found` | Tuyến không tồn tại |
| 405 | `method_not_allowed` | Sai phương thức trên tuyến đã biết, kèm `Allow` |
| 408 | `body_timeout` | Upload đã giữ slot nhưng quá hạn nhận body |
| 411 | `length_required` | Thiếu `Content-Length` cho upload |
| 413 | `body_too_large` | Upload vượt giới hạn kích thước |
| 415 | `unsupported_media_type` | Media type upload không được hỗ trợ |
| 417 | `expectation_failed` | Expectation không được hỗ trợ |
| 503 | `busy` | Slot đã có upload khác giữ |

Các lỗi do ứng dụng trả có dạng `{"error":{"code":"busy","message":"busy"}}`
với `message` bằng `code`. Phản hồi JSON dùng
`application/json; charset=utf-8`. Khi từ chối ở bước đọc header, receiver
gửi phản hồi cuối cùng với `Connection: close`, không gọi `writeContinue()`
hay đọc body vào bộ xử lý upload. Node có thể tự trả lỗi framing cho request bị
từ chối ngay tại parser HTTP. Cả client và server giới hạn header ở 8192 byte
và kiểm tra trường trùng trên danh sách header thô. Phản hồi uploader đọc
được giới hạn ở 8192 byte và JSON dùng bộ giải mã UTF-8 nghiêm ngặt.

CLI thoát với mã 1 sau một dòng JSON nếu upload thất bại. Phản hồi từ xa chỉ
xuất hiện dưới dạng `{ok:false,status,error}` khi mã HTTP, mã lỗi và nội dung
envelope khớp hợp đồng. Lỗi cục bộ có dạng `{ok:false,local}`, chẳng hạn
`timeout` khi chờ quá hạn hoặc `upstream_failure` khi nhận redirect, 421,
phản hồi sai schema hay frame tạm thời bất ngờ. Uploader không theo redirect,
không thử lại, không dùng proxy, không gửi body theo timer và không in payload.

## Giới hạn và đánh đổi

- Từ chối sớm tiết kiệm băng thông khi client chờ `100`. Client bất kỳ vẫn
  có thể gửi byte ngay. Hệ điều hành và parser cũng có thể đã nhận dữ liệu
  trước khi handler từ chối. Vì vậy admission và giới hạn body luôn áp dụng.
- Nếu phần lớn upload được chấp nhận, bước chờ `100` có thể tốn thêm một
  vòng truyền. Một slot và không có hàng đợi giúp dễ dự đoán tải, nhưng upload
  chậm giữ chỗ của client khác đến khi kết thúc, ngắt kết nối hoặc hết hạn.
- Bộ đếm chỉ phản ánh một tiến trình. Bài học tính digest trong bộ nhớ, không
  lưu file, không xác thực người gửi và không khôi phục upload dở. SHA-256
  ở đây kiểm tra dữ liệu phản hồi, không thay thế xác thực hay TLS.

## Kiểm thử và bài tập

```bash
node --test --test-name-pattern='unit:' lessons/92-expect-continue-admission/test/lesson.test.mts
node --test --test-name-pattern='integration:' lessons/92-expect-continue-admission/test/lesson.test.mts
```

Các bài tích hợp dùng receiver và uploader chạy ở tiến trình riêng, cổng
loopback tạm thời và peer TCP quan sát trực tiếp frame `100` cùng số byte
payload. Chúng kiểm tra từ chối trước khi gửi, tranh chấp slot, giải phóng
slot sau timeout hoặc ngắt kết nối và xác minh phản hồi cuối.

1. Giải thích vì sao `accepted` và `bytes` có thể tăng khi `completed` giữ
   nguyên. Đối chiếu với các assertion của bài kiểm thử upload bị gián đoạn.
2. Thử payload Unicode và so sánh số byte UTF-8 với số ký tự.
3. Thiết kế phiên bản nhiều slot nhưng vẫn kiểm tra và giữ chỗ trước `100`.
   Nêu cách kiểm thử để một upload hết hạn chỉ trả lại slot của chính nó.

## Tham khảo

- [RFC 9110 §10.1.1 – Expect](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.1.1)
- [Node.js 24.12 HTTP – checkContinue](https://nodejs.org/download/release/v24.12.0/docs/api/http.html#event-checkcontinue)
