# Xác minh Content-Digest trong HTTP trailer

Producer gửi nội dung nhị phân theo từng chunk và công bố SHA-256 ở cuối thông điệp HTTP/1.1. Consumer tính SHA-256 khi dữ liệu đến, đối chiếu trailer sau khi thông điệp kết thúc và chỉ trả biên nhận thành công sau khi SQLite lưu xong.

## Chạy thử

Dùng Node.js từ **24.12.0 đến hết 24.x**. Chạy các lệnh từ thư mục gốc của kho mã. Hai dịch vụ chỉ dùng mô-đun tích hợp của Node.js. Các lệnh kiểm tra cần gói phát triển đã ghim trong kho mã (`npm ci`).

Mở hai terminal. Trong terminal 1, chạy producer.

```sh
node lessons/90-content-digest-trailers/producer.mts
```

Trong terminal 2, tạo thư mục riêng cho SQLite rồi chạy consumer.

```sh
db_dir=$(mktemp -d)
DB_PATH="$db_dir/receipt.sqlite" PRODUCER_ORIGIN=http://127.0.0.1:3090 \
  node lessons/90-content-digest-trailers/consumer.mts
```

Mỗi tiến trình in một dòng JSON `{"service":"producer","port":3090}` hoặc `{"service":"consumer","port":4090}` khi đã lắng nghe. Cả hai bind vào `127.0.0.1`. Đặt `PORT=0` để hệ điều hành chọn cổng rồi dùng cổng được báo trong dòng sẵn sàng. Consumer mặc định gọi `http://127.0.0.1:3090`. `PRODUCER_ORIGIN` nhận địa chỉ HTTP của `127.0.0.1` với cổng từ 1 đến 65535 nếu ghi rõ cổng, và có thể có đúng một dấu `/` ở cuối. `DB_PATH` là đường dẫn tệp bắt buộc chỉ của consumer.

Chạy các lệnh sau trong terminal thứ ba.

```sh
curl -sS -i http://127.0.0.1:4090/receipt
curl -sS -i -X POST http://127.0.0.1:4090/ingest
curl -sS -i http://127.0.0.1:4090/receipt
```

Lần đọc đầu trả `404 no_receipt`. Hai lệnh sau trả `200` với cùng biên nhận.

```json
{"bytes":6,"sha256":"d314dd5147e1c32854a780628dec9bace07700ea979c214dc3a09448d1205c3b"}
```

Dừng consumer bằng Ctrl+C, chạy lại lệnh `DB_PATH=… node …` trong terminal 2 với cùng `db_dir`, rồi gọi lại `GET /receipt` để kiểm tra dữ liệu qua lần khởi động lại. Dùng `curl` và `od` để xem cả header, kích thước chunk, octet nhị phân và trailer trên dây.

```sh
curl -sS -i --http1.1 --raw \
  -H 'TE: trailers' -H 'Connection: TE, close' \
  http://127.0.0.1:3090/blob | od -An -tx1c
```

## Hợp đồng HTTP

| Dịch vụ | Endpoint | Thành công |
| --- | --- | --- |
| Producer | `GET /blob` | `200`, sáu octet `00 41 FF 0D 0A 7F`, `Content-Type: application/octet-stream`, `Transfer-Encoding: chunked` và `Trailer: Content-Digest` |
| Consumer | `POST /ingest` | `200`, biên nhận `{bytes,sha256}` vừa được xác minh và lưu |
| Consumer | `GET /receipt` | `200`, biên nhận mới nhất trong SQLite |

Các endpoint nhận đường dẫn chính xác, không có query (kể cả dấu `?` trống), và chỉ chấp nhận request không có body với `Content-Length` vắng mặt hoặc bằng 0. `Transfer-Encoding` trong request bị từ chối. `bytes` là số nguyên từ 0 đến 1.024 và `sha256` là chuỗi 64 ký tự hex thường.

| HTTP | Mã lỗi | Điều kiện |
| --- | --- | --- |
| `400` | `invalid_query`, `invalid_body` | Query hoặc framing của body trái với hợp đồng endpoint |
| `404` | `not_found`, `no_receipt` | Đường dẫn lạ hoặc chưa lưu biên nhận thành công |
| `405` | `method_not_allowed` | Sai phương thức trên đường dẫn đã biết, có header `Allow` |
| `500` | `internal_error` | Lỗi SQLite khi đọc hoặc ghi, hoặc lỗi nội bộ khác |
| `502` | `upstream_failure` | Phản hồi peer sai, bị cắt, quá hạn, quá 1.024 byte hoặc khác digest |
| `503` | `busy` | Consumer đã có tám cuộc gọi peer đang hoạt động |

Lỗi ứng dụng có dạng `{"error":{"code":"upstream_failure","message":"upstream_failure"}}`, với `message` luôn bằng `code`. Lỗi cú pháp HTTP hoặc header quá lớn có thể bị bộ phân tích native trả lỗi hay đóng kết nối trước khi đến endpoint.

## Xác minh từng bước

1. Producer ghi hai chunk bằng `res.write()` và đưa chính hai buffer đó vào `createHash('sha256')`. Header đầu chỉ khai báo trailer bằng `Trailer: Content-Digest`. Producer gọi `addTrailers()` với giá trị `sha-256=:0xTdUUfhwyhUp4BijeybrOB3AOqXnCFNw6CUSNEgXDs=:` trước `end()`.
2. Consumer gọi duy nhất một lần `GET /blob` đến origin cố định với `TE: trailers`, `Connection: TE, close` và `Accept-Encoding: identity`. Client HTTP native cho phép đọc `rawHeaders` và `rawTrailers` trước khi mất thông tin về trường lặp. Hai đầu đều giới hạn header ở 8.192 byte. Trường nằm muộn vẫn phải qua kiểm tra.
3. Consumer yêu cầu status `200`, đúng một trường media type không tham số, đúng một `Transfer-Encoding: chunked`, đúng một khai báo trailer chỉ chứa token `Content-Digest`, và content coding vắng mặt hoặc đúng một `identity`. `Content-Length` và `Content-Digest` trong header đầu làm phản hồi bị loại. Tên trường và các token header nêu trên được so khớp bất kể hoa thường.
4. `IncomingMessage` đưa các octet nội dung đã bỏ framing HTTP vào hàm băm. Kích thước chunk, CRLF phân cách và văn bản trailer đứng ngoài dữ liệu băm. Chẳng hạn hai octet `0D 0A` nằm **trong** buffer của producer vẫn được tính. Consumer chấp nhận nội dung rỗng và dừng ngay khi nhận byte thứ 1.025.
5. Chỉ khi luồng phát `end` và `complete === true` thì consumer mới đọc trailer. Chunk kích thước 0 và dòng trống cuối trailer kết thúc **thông điệp HTTP**, kể cả khi peer vẫn giữ kết nối TCP mở. Nếu dòng trống cuối chưa đến thì digest đã nhìn thấy trên dây vẫn chưa đủ để xác nhận.
6. Trailer phải có đúng một cặp tên và giá trị `Content-Digest`. Bỏ khoảng trắng hoặc tab ở hai đầu giá trị, sau đó kiểm tra đúng một thành viên `sha-256=:…:`. Dữ liệu giải mã phải dài 32 byte và mã hoá base64 lại phải cho đúng chuỗi ban đầu, kể cả dấu đệm. Consumer đối chiếu hai buffer digest rồi mới đổi kết quả thành hex cho biên nhận.
7. Consumer dùng `performance.now()` cho ngân sách 500 ms tính từ đầu cuộc gọi. Bộ hẹn giờ hủy cuộc gọi còn dang dở, còn kiểm tra thời gian trôi qua ngay trước khi ghi bắt trường hợp vòng lặp sự kiện xử lý muộn. Câu lệnh upsert SQLite chạy trọn trong một giao dịch tự động. Khi ghi thành công, đúng một hàng ở khóa cố định được thay thế.

## Giới hạn và tình huống lỗi

- Một cuộc gọi tốn đúng một lượt kết nối. Phản hồi chuyển hướng, `421` và mọi status peer khác `200` đều cho `502`. Địa chỉ kết nối đến từ cấu hình khởi động. Một lỗi sau khi đã nhận một phần nội dung cũng giữ nguyên biên nhận cũ.
- Tám cuộc gọi đang chạy chiếm hết suất. Cuộc gọi thứ chín nhận `503 busy` ngay, còn `GET /receipt` vẫn đọc trực tiếp từ SQLite. Consumer trả suất trong `finally` và hủy cuộc gọi peer khi client ngắt phản hồi hoặc tiến trình dừng.
- Bài dùng một tập con chặt của RFC 9530. Một trường có nhiều thuật toán, tham số hoặc kiểu mã hóa khác có thể hợp lệ ở hệ thống khác nhưng nằm ngoài hợp đồng ở đây. Trung gian HTTP có thể bỏ trailer. Nếu vậy, consumer từ chối xác nhận.
- SHA-256 phát hiện sai khác giữa nội dung nhận được và digest đi kèm. Bất kỳ bên nào sửa nội dung cũng có thể tính lại digest. TLS xác thực peer theo cấu hình tin cậy và bảo vệ dữ liệu trên đường truyền. Chữ ký có thể ràng buộc digest và ngữ cảnh với khóa của bên ký.
- Consumer chỉ lưu biên nhận mới nhất theo thứ tự ghi thành công. SQLite đồng bộ giữ đường ghi đơn giản với một hàng nhỏ. Nếu tệp bị khóa, lỗi được trả ngay thay vì chờ khóa. Biên nhận chỉ gồm độ dài và digest, nên consumer không thể phục hồi nội dung từ tệp.

## Kiểm tra và bài tập

```sh
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/90-content-digest-trailers/test/lesson.test.mts
node --test --test-timeout=15000 lessons/90-content-digest-trailers/test/*.test.mts
```

Các bài kiểm tra HTTP chạy hai entrypoint trong tiến trình riêng, dùng cổng tạm và thư mục SQLite riêng. Peer TCP mô phỏng đối chiếu các trường hợp thiếu CRLF cuối, nhiều dòng trailer trùng, chuyển hướng và kết nối vẫn mở sau trailer hợp lệ.

1. Tính lại SHA-256 bằng cách chia sáu byte thành các chunk khác nhau. Dự đoán giá trị trailer rồi đối chiếu với biên nhận.
2. Trong fixture, chỉ đổi một byte nội dung và giữ nguyên trailer. Kiểm tra `POST /ingest` và đọc lại biên nhận đã lưu trước đó.
3. Thử hai biến thể của fixture. Giữ TCP mở sau dòng trống cuối, rồi giữ TCP mở và bỏ dòng trống đó. Giải thích vì sao hai biến thể có kết quả khác nhau.
4. Thiết kế cách xác minh danh tính bên tạo digest khi producer và consumer đi qua một trung gian. Liệt kê những trường cần được chữ ký bao phủ cùng với digest.

## Tài liệu gốc

- Trường `Content-Digest` và các ví dụ về digest nội dung. [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html)
- Cú pháp chunk kết thúc và phần trailer của HTTP/1.1. [RFC 9112, mục 7.1.2](https://www.rfc-editor.org/rfc/rfc9112.html#section-7.1.2)
- API native cho `http.request()`, `IncomingMessage` và `response.addTrailers()`. [Node.js 24.12.0 HTTP](https://nodejs.org/download/release/v24.12.0/docs/api/http.html)
