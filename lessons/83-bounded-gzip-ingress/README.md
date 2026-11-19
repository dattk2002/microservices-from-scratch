# Giới hạn dữ liệu nén và giải nén gzip tại biên dịch vụ

Ingress nhận JSON qua HTTP, có thể ở dạng gzip. Một body chỉ vài chục byte trên dây vẫn có thể sinh nhiều byte khi giải nén. Bài này giới hạn riêng hai lượng dữ liệu, đọc gzip theo luồng và chỉ gửi bản tin đã kiểm tra sang sink. Sink lưu bản tin và dùng chính bản ghi đó làm biên nhận bền vững cho mỗi ID.

## Chạy thử

Cần Node.js 24.12 trở lên trong dòng 24.x. Chạy lệnh ở thư mục gốc repository. Hai tiến trình chỉ dùng mô-đun tích hợp của Node.js. Ví dụ dòng lệnh dùng Bash, `curl` và `gzip`. Cài gói phát triển bằng `npm ci` nếu cần chạy kiểm tra kiểu.

Terminal 1 tạo một thư mục riêng và khởi động sink. Giữ nguyên thư mục và `DB_PATH` khi muốn thử khởi động lại. Gõ Ctrl+C để dừng tiến trình. Bash dọn thư mục khi thoát terminal này.

```bash
lesson_db_dir=$(mktemp -d)
trap 'rm -rf -- "$lesson_db_dir"' EXIT
HOST=127.0.0.1 PORT=8084 DB_PATH="$lesson_db_dir/sink.sqlite" \
  node lessons/83-bounded-gzip-ingress/sink.mts
```

Terminal 2 khởi động ingress.

```bash
HOST=127.0.0.1 PORT=8083 SINK_ORIGIN=http://127.0.0.1:8084 \
  node lessons/83-bounded-gzip-ingress/ingress.mts
```

Cả hai in một dòng JSON với `service` và `port` sau khi lắng nghe. `HOST` mặc định là `127.0.0.1`. Các cổng mặc định của ingress và sink lần lượt là 8083 và 8084. Với `PORT=0`, lấy cổng thật từ dòng JSON. `SINK_ORIGIN` được kiểm tra một lần khi khởi động và phải là origin HTTP trên `127.0.0.1`, với cổng sử dụng được và tối đa một dấu `/` cuối origin. `DB_PATH` bắt buộc là tên tệp SQLite dành riêng cho sink. Hãy cấp thư mục cha đã tồn tại và giữ mỗi bộ dữ liệu trong tệp riêng.

Terminal 3 gửi gzip. Gửi lại cùng nội dung dưới dạng JSON thường để kiểm tra việc phát lại theo giá trị sau khi parse.

```bash
printf '%s' '{"id":"note1","text":"Hello gzip"}' | gzip -c |
  curl -isS -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' \
    --data-binary @- http://127.0.0.1:8083/messages

curl -isS -H 'Content-Type: application/json' \
  --data-binary '{"id":"note1","text":"Hello gzip"}' http://127.0.0.1:8083/messages

curl -isS http://127.0.0.1:8084/messages/note1
curl -isS http://127.0.0.1:8084/stats
```

Với DB mới, các phản hồi lần lượt là 201 `{"id":"note1","duplicate":false}`, 200 `{"id":"note1","duplicate":true}`, 200 `{"id":"note1","text":"Hello gzip"}` và 200 `{"count":1,"requests":2}`. Dừng sink rồi chạy lại lệnh ở Terminal 1 với cùng `DB_PATH`. `count` vẫn là 1 và `requests` bắt đầu lại từ 0.

## Hợp đồng HTTP

Ingress cung cấp `POST /messages`. Sink cung cấp `POST /messages`, `GET /messages/{id}` và `GET /stats`. Các route từ chối query string. Cả hai kiểm tra body là một object JSON có đúng hai trường `id` và `text`. `id` gồm 1–16 ký tự `a–z` hoặc `0–9`. `text` gồm 1–256 chữ cái ASCII hoặc dấu cách ASCII. Giá trị được so sánh nguyên văn, kể cả dấu cách.

Ở ingress, `Content-Type` phải xuất hiện đúng một lần, với giá trị `application/json` có thể kèm tham số hợp lệ. `Content-Encoding` có thể là `gzip`, `identity` hoặc vắng mặt. Tên coding được so sánh không phân biệt hoa thường. Sink nhận JSON identity với cùng bộ giới hạn body và dùng cổng riêng để quan sát bài chạy.

| HTTP | Body hoặc mã lỗi | Điều kiện |
| --- | --- | --- |
| 201 | `{id, duplicate: false}` | Sink ghi ID mới và commit thành công. |
| 200 | `{id, duplicate: true}` | Sink đã lưu cùng ID và cùng text. |
| 200 | `{id, text}` hoặc `{count, requests}` | Đọc bản tin hoặc thống kê trực tiếp từ sink. |
| 400 | `invalid_gzip`, `invalid_json`, `invalid_message`, `invalid_request` | Gzip lỗi, JSON hoặc UTF-8 lỗi, sai schema hoặc có query string. |
| 404 | `not_found` | Route không tồn tại hoặc sink không có ID cần đọc. |
| 405 | `method_not_allowed` | Sai phương thức đối với route. Header `Allow` ghi phương thức được hỗ trợ. |
| 408 | `body_timeout` | Pha đọc, giải nén và kiểm tra body đã hết 500 ms. |
| 409 | `id_conflict` | Sink đã lưu cùng ID với text khác. |
| 413 | `encoded_too_large`, `decoded_too_large` | Bộ đếm tương ứng vượt 1.024 byte hoặc 512 byte. |
| 415 | `unsupported_media_type`, `unsupported_encoding` | Media type hoặc content coding ngoài hợp đồng của route. |
| 429 | `capacity` | Đã có 16 ID và yêu cầu muốn tạo ID mới. |
| 502 | `upstream_failure` | Ingress gặp lỗi kết nối, redirect, timeout hoặc phản hồi sai hợp đồng từ sink. |

Mọi lỗi ứng dụng trả JSON dạng `{"error":{"code":"invalid_message","message":"invalid_message"}}` với `message` bằng `code`. Khi socket đã ngắt thì không còn nơi để gửi phản hồi. Lỗi framing do HTTP parser phát hiện trước handler thuộc về Node.js.

## Hai pha tại ingress

```text
Client ── HTTP JSON hoặc gzip ──► Ingress
                                 │ pha 1: body 500 ms
                                 │ đếm byte trên dây → gunzip → đếm byte đầu ra
                                 │ chờ EOF và trailer → UTF-8 → JSON → schema
                                 │
                                 └─ pha 2: HTTP JSON identity 500 ms ──► Sink ──► SQLite
                                    kiểm tra status và toàn bộ body ◄────┘
```

1. Pha body bắt đầu khi handler nhận request. Nếu `Content-Length` khai báo quá 1.024 byte, ingress trả `encoded_too_large` ngay, bất kể cách chia chunk. Mỗi chunk thực nhận vẫn được đếm trước khi ghi vào bộ giải nén, kể cả khi request không khai báo độ dài. Đầu ra được đếm trước khi giữ lại, với bộ đếm dùng chung cho mọi gzip member. Identity cũng đi qua hai giới hạn.
2. `createGunzip` phát kết quả theo từng khối nhỏ. Ingress chờ stream kết thúc bình thường để zlib đọc trailer và kiểm tra checksum. Các member nối tiếp được chấp nhận nếu tổng đầu ra vừa giới hạn. Số byte zlib báo đã tiêu thụ phải khớp số byte nhận được, kể cả khi zlib dừng ở byte đệm sau member cuối. Khi quá giới hạn, lỗi hoặc ngắt kết nối, ingress dừng đọc và hủy decoder. Với lỗi còn trả được, response yêu cầu đóng kết nối để bỏ phần body chưa đọc.
3. Sau khi parse UTF-8, JSON và kiểm tra schema, ingress dựng lại `{id,text}` rồi gửi đúng một POST đến sink cố định. Pha này có **500 ms riêng**, gồm cả chờ headers và đọc đến EOF. Ingress chỉ nhận phản hồi có một media type `application/json`, yêu cầu identity, chặn redirect và giữ tối đa 8.192 byte JSON. Nó kiểm tra ID cùng cờ `duplicate` đối với 201/200 và kiểm tra đúng mã lẫn nội dung lỗi đối với 409/429. Các phản hồi còn lại được quy thành 502.
4. Timer xử lý tình huống chờ I/O và đồng hồ đơn điệu kiểm tra hạn tại các điểm xử lý dữ liệu. Hai pha tuần tự có tổng ngân sách tối đa **1.000 ms** cho phần xử lý này. Thời gian nhận headers từ client, xếp lịch của hệ điều hành và gửi phản hồi về client nằm ngoài phép cộng ngân sách đó.

## Bất biến tại sink

SQLite là nguồn dữ liệu của `count` và kết quả tra cứu. Khóa chính `id` giữ một bản ghi duy nhất cho mỗi ID. Trong một giao dịch `BEGIN IMMEDIATE`, sink tìm ID, so sánh text nếu đã có hoặc kiểm tra sức chứa trước khi insert. Chỉ sau commit mới trả biên nhận. Phát lại chính xác vẫn thành công khi sink đã đầy. Cùng ID nhưng text khác vẫn trả 409.

`requests` là bộ đếm trong bộ nhớ của mọi POST đến route `/messages`, kể cả POST sai query, sai body, phát lại, xung đột hoặc chạm giới hạn. GET không tăng bộ đếm. So sánh `requests` trước và sau một lỗi ingress giúp phát hiện cả việc lỡ gọi sink mà không tạo thêm hàng. Nếu sink đã commit nhưng kết nối đứt trước khi ingress nhận phản hồi, client có thể gửi lại cùng ID và text để lấy biên nhận phát lại.

## Đánh đổi và giới hạn

- Mức 512 byte áp dụng cho JSON tuần tự hóa sau giải nén, gồm cả dấu ngoặc, khoảng trắng cú pháp và các escape như `\u0041`. Hai JSON biểu diễn cùng một bản tin có thể nằm ở hai phía của giới hạn byte.
- Giới hạn đầu ra khống chế lượng bộ nhớ ứng dụng giữ cho từng body. Decoder, HTTP và kernel vẫn có bộ đệm riêng. Tốn bao nhiêu CPU còn phụ thuộc luồng gzip được xử lý đến đâu, số yêu cầu đồng thời, hàng đợi thread pool và độ trễ event loop. Timeout hủy việc chờ của ứng dụng và việc đọc tiếp. Một lệnh native đang chạy có thể cần trả quyền điều khiển trước khi việc hủy có hiệu lực.
- Giới hạn cấp ứng dụng áp dụng sau khi request vào handler. Hệ thống triển khai còn phải quyết định giới hạn headers, body, kết nối và lưu lượng ở reverse proxy, cùng hạn mức CPU/bộ nhớ và cách cô lập tiến trình ở hệ điều hành. Bài chỉ nhận gzip và identity, với sink loopback dành cho thực hành. Sink dùng SQLite đồng bộ và giữ tối đa 16 bản tin.

## Kiểm thử và bài tập

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/83-bounded-gzip-ingress/test/lesson.test.mts
node --test --test-timeout=15000 lessons/83-bounded-gzip-ingress/test/lesson.test.mts
npm run typecheck
npm run test:unit
```

Unit test dùng stream trong bộ nhớ, gồm các biên 512/513 và 1.024/1.025 byte, trailer lỗi, member nối tiếp và mốc timeout chính xác. Bộ HTTP test cần quyền mở các cổng loopback do hệ điều hành cấp. Nó chạy ingress và sink ở hai tiến trình, thử DB sau khi khởi động lại, kiểm tra số POST thực sự đến sink, và chạy một origin đích riêng để quan sát redirect.

1. Tìm hai JSON hợp lệ có cùng `id` và `text` nhưng chênh một byte quanh ngưỡng 512. Dự đoán hai kết quả rồi kiểm tra cả mã HTTP lẫn `/stats`.
2. Chia một bản tin thành hai gzip member, đặt ranh giới trong một chuỗi JSON escape. Giải thích vì sao tính hợp lệ phải được kiểm tra trên luồng đầu ra ghép lại.
3. Xét tình huống sink chậm sau khi đã gửi headers. Xác định pha nào hết hạn, client nhận mã nào và khi nào client có thể phát lại an toàn.

## Tài liệu gốc

- Luồng gzip, `createGunzip` và `bytesWritten` trong [Node.js Zlib](https://nodejs.org/docs/latest-v24.x/api/zlib.html)
- Ngữ nghĩa của Content-Encoding và coding trong [RFC 9110 §8.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-content-encoding)
- Cấu trúc member, header và trailer trong [RFC 1952 §2](https://www.rfc-editor.org/rfc/rfc1952#section-2)
- Giao dịch ghi và `BEGIN IMMEDIATE` trong [SQLite Transaction](https://www.sqlite.org/lang_transaction.html)

Sau khi hoàn tất body, reader tháo toàn bộ listener giữ trạng thái thao tác và hủy timer. Reader cố ý giữ đúng một error handler dùng chung, không capture buffer hay request, để lỗi từ callback `_destroy` đến sau EOF không làm sập process. Cách này cũng hoạt động khi nguồn đặt `emitClose: false`; không chờ một close event mà nguồn đã tắt. Đây là guard có kích thước cố định gắn với stream, không phải công việc nền. [Node mô tả cùng lý do giữ error handler ở async iterator](https://nodejs.org/download/release/v24.22.2/docs/api/stream.html#consuming-readable-streams-with-async-iterators).

Client mặc định dùng `node:http.request` với đúng một HTTP attempt, agent riêng, không proxy môi trường, không retry 421, không redirect hoặc tự giải nén. Header upstream có giới hạn 8 KiB và giữ toàn bộ trường trong giới hạn đó; Content-Type/Encoding/Length, ETag và Content-Range lặp bị từ chối trước khi tạo Response. Body vẫn được đọc theo stream bằng cầu nối tích hợp `Readable.toWeb` dưới deadline và giới hạn riêng đã nêu. Dịch vụ giữ toàn bộ header inbound trong giới hạn byte của HTTP parser, tránh mất metadata trên Node 24.12.
