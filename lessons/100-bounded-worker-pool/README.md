# Worker threads và hàng đợi CPU có giới hạn

Bài này tách công việc SHA-256 lặp khỏi event loop của dịch vụ compute. Gateway và compute là hai tiến trình HTTP riêng. Trong compute, luồng chính xử lý HTTP, kiểm tra dữ liệu và điều phối công việc cho hai worker. Vì worker thực hiện phần tính toán đồng bộ, luồng chính vẫn có thể trả lời `GET /health` khi cả hai worker đang bận. Nếu máy chủ đã hết CPU, hệ điều hành vẫn có thể trì hoãn luồng chính.

## Chạy thử

Cần Node.js 24.12 trở lên trong dòng 24. Runtime chỉ dùng thư viện chuẩn. Từ thư mục gốc của kho mã, mở hai terminal:

```bash
PORT=3100 node lessons/100-bounded-worker-pool/compute.mts
```

```bash
PORT=3200 COMPUTE_ORIGIN=http://127.0.0.1:3100 node lessons/100-bounded-worker-pool/gateway.mts
```

Hai dịch vụ bind `127.0.0.1` và in một dòng JSON chứa cổng sau khi listen. `PORT=0` yêu cầu hệ điều hành chọn cổng. Khởi động worker thuộc trách nhiệm của compute, qua `new Worker(...)`.

```bash
curl --max-time 2 http://127.0.0.1:3100/health
curl --max-time 2 http://127.0.0.1:3200/hash \
  -H 'Content-Type: application/json' \
  --data '{"text":"é","iterations":1}'
```

Kết quả của yêu cầu thứ hai:

```json
{"digest":"4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"}
```

```bash
node --test --test-name-pattern=unit: lessons/100-bounded-worker-pool/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/100-bounded-worker-pool/test/lesson.test.mts
```

## Hợp đồng và thuật toán

`POST /hash` nhận đúng hai trường. `text` là chuỗi Unicode hợp lệ dài 1–1024 byte sau khi mã hóa UTF-8. `iterations` là số nguyên từ 1 đến 200.000. Tạo dãy byte ban đầu bằng cách mã hóa nguyên văn `text` sang UTF-8, giữ nguyên khoảng trắng và dạng Unicode. Mỗi vòng băm dãy byte hiện tại bằng SHA-256, lấy **32 byte thô** làm đầu vào cho vòng tiếp theo. Sau vòng cuối, mã hóa kết quả thành 64 ký tự hex chữ thường. Ví dụ `é` với hai vòng cho kết quả `51e152f7ea52d1e9d514df73ad3f12503a1da79e891d61e2033f2da2f2b51425`.

`GET /health` của compute trả về `ok`, số job đang chạy (`active`), đang xếp hàng (`queued`), số worker chưa exit (`live`) và tổng lượt thay worker đã thử (`replacements`). Gateway báo `ok` và số lượt gọi compute đang giữ chỗ (`active`). Đây là chỉ số quan sát tại chỗ, kể cả khi compute đã suy giảm và từ chối việc mới.

JSON HTTP/1 giới hạn 8192 byte phần thân và 8192 byte phần header. Bộ đọc kiểm tra UTF-8 nghiêm ngặt, kiểu nội dung JSON với charset UTF-8 tùy chọn, coding identity nếu khai báo, framing và các header liên quan bị lặp. Tên trường JSON được so sánh sau khi giải mã escape. Khóa trùng trong cùng một object bị từ chối, kể cả trong phản hồi upstream. Phần thân vào phải hoàn thành trong 500 ms kể từ khi xử lý header. Phản hồi JSON có `Content-Type: application/json;charset=utf-8`. Mỗi lỗi có đúng dạng `{"error":{"code":"…","message":"…"}}`, với `message` bằng `code`.

| HTTP | Mã | Điều kiện |
| --- | --- | --- |
| 400 | `invalid_request` | Thân, framing, kiểu dữ liệu hoặc query sai. Health phải có thân rỗng. |
| 404 | `not_found` | Đường dẫn không được định nghĩa. |
| 405 | `method_not_allowed` | Sai phương thức trên đường dẫn đã biết. Có header `Allow`. |
| 503 | `busy` | Compute hết chỗ trong pool hoặc gateway đã có tám lượt gọi compute. |
| 503 | `degraded`, `shutting_down` | Compute đã chạm giới hạn thay worker hoặc đang dừng. Gateway chỉ giữ các lỗi 503 khi envelope hợp lệ. |
| 502 | `worker_failure` | Compute gặp lỗi worker, exit bất ngờ hoặc phản hồi worker sai. |
| 502 | `upstream_failure` | Gateway gặp lỗi kết nối, lỗi compute 502, quá thời hạn riêng, redirect, 421 hoặc phản hồi sai hợp đồng. |
| 504 | `deadline_exceeded` | Compute hết ngân sách job. Gateway chỉ trả 504 khi đã nhận đầy đủ lỗi 504 đúng hợp đồng. |

Lỗi ở tầng phân tích HTTP có thể dùng phản hồi mặc định của Node.

## Điều phối và vòng đời

Pool có hai worker, mỗi worker nhận tối đa một job chưa hoàn thành, cộng với tối đa bốn job đợi theo FIFO. Khi cả sáu chỗ đã kín, job thứ bảy nhận 503 ngay. Mỗi job có UUID và 400 ms tính bằng đồng hồ đơn điệu kể từ lúc tiếp nhận vào pool, gồm cả thời gian chờ và thời gian chạy. Pool bỏ job đã quá hạn trước khi giao cho worker. Khi client ngắt kết nối, job đợi được gỡ khỏi hàng. Với job đang chạy, pool yêu cầu dừng worker và chỉ tạo worker thay thế sau sự kiện exit. Deadline khi đang chạy cũng thu hồi worker theo cách đó.

Pool đối chiếu ID và cấu trúc kết quả trước khi hoàn thành job. Nếu nhận kết quả hoặc lỗi worker khi job đã hết 400 ms, pool trả về lỗi deadline ngay cả khi callback hẹn giờ chưa chạy. Worker bị lỗi được thay thế mà không chạy lại job cũ. Pool thử tối đa ba lượt thay thế trong cửa sổ trượt 10 giây. Khi cần thêm lượt trong cửa sổ đó, compute chuyển sang `degraded` cho đến khi khởi động lại tiến trình. Khi nhận SIGTERM, compute đóng tiếp nhận, từ chối hàng đợi và cho phép job đang chạy hoàn thành trong khoảng dừng tối đa 750 ms, vẫn áp dụng deadline riêng 400 ms. Tiến trình chờ mọi worker exit trước khi kết thúc.

Gateway gọi một lần tới origin HTTP loopback cố định từ `COMPUTE_ORIGIN`. Nó dùng kết nối riêng, không dùng proxy hoặc tự theo redirect. Tối đa tám lượt gọi đồng thời, mỗi lượt có 500 ms tính đến EOF với thân tối đa 8192 byte. Chênh lệch danh nghĩa 100 ms dành cho HTTP và lập lịch, không bảo đảm độ trễ đầu cuối. Tám chỗ ở gateway có thể đầy dù compute vẫn xử lý được một số yêu cầu trực tiếp.

## Giới hạn và đánh đổi

Mỗi worker đặt giới hạn heap thế hệ cũ 32 MB và stack 2 MB. Giới hạn này áp dụng cho tài nguyên V8 tương ứng, không đặt trần cho RSS của tiến trình hay các cấp phát bên ngoài heap. Worker vẫn chia sẻ tiến trình và ranh giới bảo mật với luồng chính. Chúng giúp tách CPU khỏi event loop nhưng không tạo ranh giới cô lập của dịch vụ hoặc tiến trình. Việc hủy công việc đồng bộ bằng terminate có chi phí khởi tạo lại worker và có thể tiêu hết ngân sách thay thế khi nhiều client ngắt kết nối. Hàng đợi ngắn giới hạn thời gian chờ và buộc caller xử lý quá tải sớm. Ví dụ dùng SHA-256 lặp để minh họa tải CPU, không phụ thuộc vào kho dữ liệu hay dịch vụ khác.

## Bài tập

1. Đổi phân bố tải giữa các job ngắn và dài. Đo tỷ lệ 503, tỷ lệ 504 và độ trễ của `/health` khi hàng đợi đầy.
2. So sánh khi dùng FIFO và khi phân lớp job theo số vòng. Giải thích cách tránh để nhóm job dài phải chờ vô hạn.
3. Thử ngắt một client khi job còn đợi, rồi khi job đã chạy. Dùng `/health` để so sánh số lượt thay worker.

## Tài liệu tham khảo

- [Node.js 24.12, Worker threads và resourceLimits](https://nodejs.org/download/release/v24.12.0/docs/api/worker_threads.html)
- [Node.js 24.12, crypto.createHash](https://nodejs.org/download/release/v24.12.0/docs/api/crypto.html#cryptocreatehashalgorithm-options)
- [Node.js 24.12, HTTP](https://nodejs.org/download/release/v24.12.0/docs/api/http.html)
