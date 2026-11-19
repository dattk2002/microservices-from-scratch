# 81. SSE hữu hạn, replay bền vững và Last-Event-ID

Một tiến trình ghi sự kiện vào SQLite. Tiến trình thứ hai lấy lại các sự kiện
qua HTTP, bắt đầu ngay sau checkpoint mà bên gọi cung cấp. Bài này cho thấy cách
giữ nguyên thứ tự và mã sự kiện qua lần khởi động lại, cũng như vì sao bên gọi
chỉ nên lưu checkpoint sau khi đã xử lý dữ liệu.

## Chạy thử

Cần Node.js 24.12 trở lên trong dòng 24.x và `curl`. Hai tiến trình dùng các
mô-đun tích hợp của Node.js. Chạy các lệnh sau từ thư mục gốc của repo.

**Terminal 1** mở feed với một SQLite file riêng. Giữ đường dẫn này khi khởi
động lại.

```bash
mkdir -p data/lesson81
HOST=127.0.0.1 PORT=8081 DB_PATH="$PWD/data/lesson81/feed.sqlite" \
  node lessons/81-durable-sse-replay/feed.mts
```

**Terminal 2** mở reader với origin cố định.

```bash
HOST=127.0.0.1 PORT=8082 FEED_ORIGIN=http://127.0.0.1:8081 \
  node lessons/81-durable-sse-replay/reader.mts
```

Mỗi tiến trình in một dòng JSON báo sẵn sàng, chẳng hạn
`{"service":"feed","port":8081}`. `HOST` mặc định là `127.0.0.1`. `PORT` mặc
định lần lượt là `8081` và `8082`. Có thể dùng `PORT=0` để hệ điều hành cấp
cổng trống, sau đó đọc cổng từ dòng báo sẵn sàng để cấu hình reader và câu lệnh
`curl`. `DB_PATH` là đường dẫn file riêng của feed, có sẵn thư mục cha.
`FEED_ORIGIN` chỉ nhận origin HTTP của `127.0.0.1` với cổng khác 0, có thể có
dấu `/` cuối. Reader dùng origin đã chuẩn hóa và tự gắn đường dẫn `/events`.

**Terminal 3** ghi ba sự kiện. Với file mới, ba phản hồi có mã `201` và
`sequence` lần lượt là 1, 2, 3.

```bash
curl -i -H 'Content-Type: application/json' \
  -d '{"id":"a","text":"First"}' http://127.0.0.1:8081/events
curl -i -H 'Content-Type: application/json' \
  -d '{"id":"b","text":"Second"}' http://127.0.0.1:8081/events
curl -i -H 'Content-Type: application/json' \
  -d '{"id":"c","text":"Third"}' http://127.0.0.1:8081/events
```

Xem trực tiếp phản hồi SSE khi đã xử lý tới 2.

```bash
curl -i -N -H 'Last-Event-ID: 2' http://127.0.0.1:8081/events
```

Phần thân chỉ có sự kiện 3, kết thúc bằng một dòng trống rồi đóng luồng phản
hồi.

```text
id: 3
event: item
data: {"id":"c","text":"Third"}

```

Reader kiểm tra toàn bộ luồng hữu hạn và trả JSON. Gọi hai lần với cùng cursor
để thấy cùng một kết quả.

```bash
curl -i 'http://127.0.0.1:8082/replay?after=2'
curl -i 'http://127.0.0.1:8082/replay?after=2'
```

```json
{"events":[{"sequence":3,"id":"c","text":"Third"}],"lastEventId":3}
```

Dừng feed ở terminal 1 bằng Ctrl+C, chạy lại lệnh mở feed với cùng đường dẫn
và cổng, rồi gọi lại `/replay?after=2`. Reader vẫn trả sự kiện 3. Gửi lại POST
của `b` được `200 {"sequence":2}`. Đổi `text` của `b` thành `Changed` được
`409 id_conflict`. Thử `/replay?after=3` để nhận danh sách rỗng với
`lastEventId: 3`, rồi thử `/replay?after=4` để nhận `409 cursor_ahead`.

## API

| Tiến trình | Yêu cầu | Phản hồi |
| --- | --- | --- |
| Feed | `POST /events`, `application/json`, đúng hai trường `id` và `text` | `201 {"sequence":N}` khi ghi mới. `200 {"sequence":N}` với cùng ID và nội dung. `409 id_conflict` nếu ID đã có nội dung khác. `429 capacity` nếu ghi ID mới khi đã đủ 16 sự kiện. |
| Feed | `GET /events`, tùy chọn `Last-Event-ID: N` | `200 text/event-stream` gồm các sự kiện sau N theo thứ tự tăng dần, hoặc thân rỗng nếu N đúng bằng đuôi log. Mặc định N là 0. `409 cursor_ahead` nếu N lớn hơn đuôi log. |
| Reader | `GET /replay?after=N` | `200` với `events` và `lastEventId`. Nếu danh sách rỗng, `lastEventId` bằng N. `409 cursor_ahead` nếu feed trả đúng lỗi này. `502 upstream_failure` nếu lấy hoặc kiểm tra phản hồi feed thất bại. |

`id` dài 1–16 ký tự trong `a-z0-9`. `text` dài 1–32 ký tự trong `A-Z`,
`a-z` và dấu cách ASCII. Feed giữ nguyên nội dung, kể cả dấu cách. Số thứ
tự do feed cấp nằm trong 1–16. Cursor là một số thập phân dạng chuẩn từ
`0` đến `16`. Các dạng như `02`, `+2`, `2.0`, và query `after=%32` bị
từ chối. Feed không nhận query và reader yêu cầu đúng một tham số `after`.

Lỗi có dạng `{"error":{"code":"cursor_ahead","message":"cursor_ahead"}}`,
trong đó `message` luôn bằng `code`. Dữ liệu, query hoặc cursor sai
trả `400 invalid_request`, còn JSON hỏng cú pháp trả `400 invalid_json`.
POST sai kiểu nội dung trả `415 unsupported_media_type` và JSON quá 8192
byte trả `413 body_too_large`. Đường dẫn khác trả `404 not_found`. Sai phương
thức trên đường dẫn và query hợp lệ trả `405 method_not_allowed` với header
`Allow`.

## Ghi nguyên tử và chốt đuôi log

```text
Bên ghi ── POST /events ──► feed ──► SQLite riêng (events + receipts)
Bên đọc ── GET /replay ──► reader ── GET /events + Last-Event-ID ──► feed
```

Feed sở hữu file SQLite. Bảng `events` giữ nội dung theo sequence, còn
`receipts` ánh xạ ID của bên ghi tới đúng sequence. Khóa duy nhất và khóa
ngoại giữ quan hệ một-một. Một giao dịch `BEGIN IMMEDIATE` bao trọn việc
tìm receipt, cấp sequence mới và ghi hai bản ghi. Feed chỉ phản hồi thành
công sau khi commit. Nếu bước ghi receipt thất bại, sự kiện cũng rollback
và số thứ tự đó vẫn có thể dùng cho lần ghi tiếp theo. Khi đã đầy, feed
vẫn xử lý ID cũ theo quy tắc ghi lặp hoặc xung đột. Thao tác ghi lặp không
chiếm thêm chỗ.

Ở đầu mỗi yêu cầu đọc hợp lệ, một câu `SELECT` lấy cùng lúc toàn bộ prefix
đã commit theo thứ tự. Feed chốt đuôi từ kết quả đó và mã hóa các sự kiện
cần trả trước khi gửi byte HTTP đầu tiên. Một lần ghi commit sau mốc này
chỉ xuất hiện trong yêu cầu sau, kể cả khi client còn đang đọc phản hồi cũ.
Với tối đa 16 hàng, cách này giữ bộ nhớ có giới hạn và không cần giữ
giao dịch đọc trong lúc truyền dữ liệu.

## Framing và lỗi giữa luồng

Feed dùng dòng trống để kết thúc từng frame SSE. Trường `id:` trong frame
là sequence của log, còn `id` trong JSON là khóa mà bên ghi gửi. Reader giải
mã UTF-8 nghiêm ngặt theo từng chunk, kể cả khi byte của một ký tự hay
cặp CRLF nằm ở hai chunk khác nhau. Nó chấp nhận LF, CRLF và CR, bỏ qua
comment và các trường không dùng, ghép nhiều dòng `data:` bằng LF. Một
frame có dữ liệu chỉ hợp lệ nếu có kiểu `item`, sequence kế tiếp và payload
đúng schema. ID trong payload phải duy nhất trong phần replay đang đọc.

Một deadline 500 ms tính từ trước khi gọi feed đến sau khi đọc và kiểm tra
toàn bộ thân phản hồi. Đồng hồ monotonic bắt cả trường hợp timer chưa được
lập lịch dù mốc đã tới. Reader đọc tối đa 8192 byte, yêu cầu
`Content-Encoding` vắng hoặc `identity` và cấm theo redirect. Reader
yêu cầu một giá trị media type duy nhất và hủy đọc ngay khi vượt giới hạn
byte, kể cả khi feed vẫn giữ thân phản hồi mở. Với status `409`, reader
phải đọc hết JSON hợp lệ và đối chiếu đúng cả mã lẫn thông
điệp `cursor_ahead`. Phản hồi nén, lỗi truyền tải, timeout, payload sai,
sequence bị hổng hay mã lỗi lạ đều dẫn tới `502 upstream_failure`.

Khi EOF sạch, phần frame cuối thiếu dòng trống bị bỏ theo quy tắc SSE.
Reader vẫn trả các frame hoàn chỉnh đã kiểm tra, với checkpoint của frame
hoàn chỉnh cuối cùng. Nếu frame hoàn chỉnh sai hoặc luồng bị ngắt bất thường
sau một frame đúng, reader trả lỗi cho cả lượt và không trả checkpoint mới.

## Checkpoint và giới hạn

Client lưu sequence của sự kiện cuối đã xử lý thành công rồi dùng nó làm
`after` ở lần sau. Nếu đã thực hiện side effect nhưng bị dừng trước khi lưu
checkpoint, reconnect sẽ replay sự kiện đó. Đây là hành vi at-least-once khi
client tiếp tục thử từ checkpoint cũ và log vẫn còn. Handler cần xử lý lặp
an toàn, chẳng hạn lưu ID đã xử lý cùng giao dịch với thay đổi nghiệp vụ.
Việc feed ghi POST lặp một cách idempotent không bảo đảm exactly-once cho
consumer. Lưu checkpoint trước khi xử lý xong có thể làm mất sự kiện ở phía
consumer.

Bài dùng catch-up hữu hạn. Mỗi HTTP response kết thúc khi gửi hết prefix, không
đăng ký nhận sự kiện mới và không gửi heartbeat. Reader không triển khai
`EventSource` của trình duyệt hay cơ chế tự reconnect. Giới hạn 16 sự kiện
giúp quan sát cách feed từ chối dữ liệu mới khi log đầy. Bản mẫu không xoay log, không có
retention hoặc nhiều phân vùng. Bài cũng giả định một feed sở hữu file SQLite
và không chia sẻ DB với reader. Nếu muốn mở rộng sang log dài, cần quyết định
cách phân trang catch-up, giữ lịch sử và báo cursor đã cũ sau khi dọn dữ liệu.

## Kiểm tra và bài tập

Chạy suite của bài từ thư mục gốc. HTTP integration tests tự mở các tiến trình
riêng trên cổng loopback tạm thời và dọn thư mục SQLite sau khi kết thúc.

```bash
npm ci
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/81-durable-sse-replay/test/lesson.test.mts
node --test --test-timeout=15000 lessons/81-durable-sse-replay/test/lesson.test.mts
```

- Giả lập consumer đã xử lý sự kiện 3 nhưng chỉ lưu checkpoint 2. Gọi lại
  `after=2`, rồi thêm bước dedup trong consumer bằng ID của sự kiện.
- Dùng nhiều POST để chạm giới hạn 16 và kiểm tra cả ba nhánh ở ngưỡng này.
  ID mới bị từ chối, lặp đúng nội dung trả receipt cũ, lặp khác nội dung
  vẫn trả xung đột.
- Thử chèn một dòng trống trước khi frame có đủ trường, rồi chuyển cùng phần
  dữ liệu hỏng xuống sau frame cuối nhưng bỏ dòng trống kết thúc. Quan sát
  sự khác nhau giữa frame sai và frame chưa được dispatch.

## Tài liệu gốc

- WHATWG HTML mô tả Last-Event-ID, cú pháp dòng và thuật toán dispatch SSE. [Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- SQLite mô tả snapshot đọc và khi nào `BEGIN IMMEDIATE` giành giao dịch ghi. [Transaction](https://www.sqlite.org/lang_transaction.html)
- Node.js mô tả API SQLite tích hợp. [node:sqlite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

Reader từ chối mọi dấu phẩy trong Content-Type, kể cả tham số có dấu nháy. Đây là giới hạn của hợp đồng demo để không chấp nhận hai trường lỗi bị Fetch gộp thành một chuỗi có vẻ hợp lệ. Feed mẫu chỉ gửi text/event-stream; charset=utf-8.

Client mặc định dùng `node:http.request` với đúng một HTTP attempt, agent riêng, không proxy môi trường, không retry 421, không redirect hoặc tự giải nén. Header upstream có giới hạn 8 KiB và giữ toàn bộ trường trong giới hạn đó; Content-Type/Encoding/Length, ETag và Content-Range lặp bị từ chối trước khi tạo Response. Body vẫn được đọc theo stream bằng cầu nối tích hợp `Readable.toWeb` dưới deadline và giới hạn riêng đã nêu. Dịch vụ giữ toàn bộ header inbound trong giới hạn byte của HTTP parser, tránh mất metadata trên Node 24.12.
