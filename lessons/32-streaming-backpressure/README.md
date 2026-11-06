# 32 — NDJSON streaming, backpressure và hủy luồng có giới hạn

Bài này cần Node.js **24.12+** (nhánh 24), kiến thức HTTP, async iterator,
AbortSignal và admission/bulkhead. Runtime chỉ dùng built-in Node. Các gói phát
triển được pin ở root; chạy lệnh dưới đây từ root repository.

## Mục tiêu và kiến trúc

```text
client → GET consumer /summary → GET producer /stream
                                  item 0\n
                                  item 1\n ... item 63\n
                                  end(count=64)\n
       ← {"count":64} chỉ khi EOF và terminal hợp lệ
```

Producer và consumer là **hai tiến trình riêng**, không gọi hàm nội bộ của nhau.
`stream.mts` chứa parser thuần và vòng ghi có writer tiêm vào; `runtime.mts` tạo
HTTP server, quản lý lifetime. Chỉ `main()` đọc cấu hình và mở listener. Guard
`import.meta.main` giữ mọi entrypoint inert khi import. Không có database,
side effect bền vững hay gói stream ngoài. Tái sử dụng `lib/http.mts` cho JSON và
kiểm tra port, `test/support.mts` cho khởi động/dừng child process.

Buffered JSON thường phải giữ toàn bộ mảng rồi mới parse/trả kết quả. NDJSON cho
phép xử lý từng bản ghi và truyền áp lực ngược về nơi sinh dữ liệu. Tuy nhiên bài
này cố ý **không trả kết quả một phần**: một prefix hợp lệ không chứng minh rằng
stream hoàn tất. Summary chỉ có sau terminal đúng *và* EOF; byte bất kỳ sau terminal
cũng là lỗi. Đây là phép đếm thuần, không phải pipeline ghi dữ liệu bền vững.

## Chạy hai dịch vụ

Terminal 1:

```sh
HOST=127.0.0.1 PORT=9001 node lessons/32-streaming-backpressure/producer.mts
```

Terminal 2:

```sh
HOST=127.0.0.1 PORT=9002 PRODUCER_URL=http://127.0.0.1:9001 node lessons/32-streaming-backpressure/consumer.mts
curl --max-time 5 http://127.0.0.1:9002/summary
```

Kết quả mong đợi: `{"count":64}`. Mỗi process in một dòng JSON readiness có
`port`. `PORT=0` chọn port ephemeral; lấy port đó từ readiness để đặt
`PRODUCER_URL` của consumer. Import module không in readiness, không đăng ký signal,
không đọc cấu hình và không bắt đầu background work.

| Cấu hình | Hợp đồng |
| --- | --- |
| `HOST` | mặc định `127.0.0.1`; chỉ chạy demo local |
| `PORT` | số nguyên 0..65535, mặc định 0 |
| `PRODUCER_URL` | consumer: mặc định `http://127.0.0.1:9001`, bắt buộc HTTP và hostname `127.0.0.1` |
| `TEACHING_CONTROLS` | chỉ chuỗi chính xác `1` bật chế độ giảng dạy |

## Hợp đồng byte và schema

Mỗi dòng là JSON UTF-8 theo sau bởi **LF bắt buộc**; LF tính vào ngân sách.
Chỉ chấp nhận object có đúng các key đã định nghĩa, không ép kiểu đầu vào:

```json
{"type":"item","seq":0,"text":"Hạt giống 🌱"}
{"type":"end","count":1}
```

* `item`: `type` thực sự là string; `seq` thực sự là number, chính xác bằng số
  item đã thấy, bắt đầu 0, tối đa 63. Vì vậy không có duplicate hoặc gap.
  `text` phải là string dài tối đa **320 đơn vị UTF-16** (không phải 320 grapheme).
* `end`: `count` thực sự là number bằng số item đã nhận, từ 0 đến 64. Có đúng một
  terminal; không được thêm dữ liệu phía sau. Stream rỗng với terminal count 0
  hợp lệ ở parser; producer mẫu luôn sinh 64 item.
* Tối đa **2048 byte/dòng**, **131072 byte/stream**. Decoder fatal từ chối UTF-8 sai;
  gom byte đến LF trước khi decode nên emoji bị chẻ ở bất kỳ chunk nào vẫn đúng.
  EOF giữa dòng, thiếu terminal, JSON sai, key thừa hoặc terminal sai đều thất bại.

Suy ra giới hạn tương thích: một đơn vị UTF-16 có thể cần JSON escape `\uXXXX`
(6 byte), nên phần text xấu nhất là 320 × 6 = **1920 byte**. Khung item với seq
hai chữ số và LF là 35 byte, tổng **1955 byte**. Terminal 64 với LF là 26 byte.
Toàn bộ producer tối đa 64 × 1955 + 26 = **125146 byte**, nhỏ hơn 131072.
Surrogate hoặc control character được `JSON.stringify` escape; không giả định mọi
ký tự chỉ chiếm một byte. Whitespace JSON hợp lệ vẫn tính vào ngân sách. Unit test
thử dòng đúng 2048 byte và stream đúng 131072 byte, cũng như vượt mỗi cận 1 byte
hoặc terminal. Fixture vượt byte vẫn giữ schema, sequence và identity hợp lệ;
không dùng text quá dài để giả làm lỗi byte.

Consumer trả `200 {"count":64}` chỉ khi upstream có status 200, media type
`application/x-ndjson`, toàn bộ schema đúng và hoàn tất. Bất kỳ lỗi upstream,
timeout hay parser đều trả `502 {"error":"invalid_stream"}` nếu client còn kết
nối. Không trả count tạm. Route sai trả 404, mode không được phép trả 400,
admission đầy trả `503 {"error":"saturated"}`. Các summary/error đều có kích
thước hằng số; không phản chiếu payload tùy ý vào lỗi.

## Backpressure và giới hạn tài nguyên

Mỗi dịch vụ nhận tối đa **2 stream đang hoạt động**. Slot được lấy đồng bộ trước
`await` và trả trong `finally`, kể cả lỗi, client ngắt hoặc deadline. Producer có
overall deadline **4000 ms**; consumer **3000 ms**, gồm cả chờ header. Mỗi lần đọc
body consumer có thêm deadline **700 ms**; timeout hủy reader/upstream, không tiếp
tục giữ slot. Producer bị giữ bởi teaching barrier vẫn chịu overall deadline.

`pump` chỉ lấy record tiếp theo sau khi `write()` trước đó thành công, hoặc sau
`drain` nếu `write()` trả false. Nó đăng ký close/error/abort và dọn mọi listener
khi kết thúc. Khi chờ drain mà peer đóng hoặc caller hủy, waiter được đánh thức
để thất bại. Generator producer cũng kiểm tra abort trước khi sinh item. Không có
hàng đợi item nền. Tối đa một record đang sinh/ghi tại điểm hủy; record đã vào
socket có thể vẫn tới peer. Hủy là tín hiệu dừng hợp tác, không thu hồi byte đã gửi.

Parser giữ một buffer dòng 2048 byte và vài counter, không giữ mảng item. Vòng
consumer chỉ có một read đang chờ và parser không giữ tham chiếu vào chunk sau
`feed`. Fetch/HTTP có buffer riêng; chunk mạng có thể chứa nhiều dòng, không đồng
nhất với một record. Tổng byte được kiểm tra trước khi xử lý chunk. Không gọi
`response.json()` hay `arrayBuffer()` trong consumer thật.

HTTP server đặt `highWaterMark: 1` bằng built-in Node để response nonempty thực sự
đi qua `write(false)` trong integration test. Đây là ngưỡng báo áp lực, **không phải
trần tuyệt đối**: write hiện tại vẫn được nhận vào buffer. Producer chỉ viết một
dòng ≤2048 byte rồi đợi drain. Counter `blocked` ghi số lần false, `drains` ghi số
lần drain quan sát. Test yêu cầu cả hai khớp trên luồng hoàn tất. Kernel socket,
TCP window, HTTP và fetch buffering nằm ngoài JavaScript queue này; bài không
khẳng định kiểm soát toàn bộ bộ nhớ TCP hay số byte đã đến peer.

## Teaching controls cho Playground/local

Khởi động **cả hai process** với `TEACHING_CONTROLS=1`. Đây là các route giáo dục
local, không có auth và không dành cho public service. Không cần sửa Playground.

Producer:

* `GET /control/stats`: active, generated, blocked, drains, completed, cancelled,
  rejected, waiting (số waiter tại barrier).
* `POST /control/hold`: giữ generator trước record tiếp theo. Counter/barrier là
  bằng chứng đã vào trạng thái giữ; không dựa vào việc ngủ một khoảng thời gian.
* `POST /control/release`: nhả mọi waiter hiện tại; không reset counter.
* `GET /stream?mode=truncated|malformed|terminal|line|stream`: lần lượt thiếu
  terminal, JSON sai ở item 0, count terminal 63 thay vì 64, chỉ dòng đầu2049 byte,
  64 dòng 2048 byte cộng terminal làm vượt tổng stream. Các mode byte chỉ thêm
  whitespace JSON, không phá schema hoặc thứ tự.

Consumer có `GET /control/stats` (active/completed/failed/rejected) và chuyển query
`mode` từ `/summary` sang producer khi được bật. Mặc định controls trả 404 và mode
bất thường bị từ chối trước khi stream bắt đầu.

Kịch bản thử tay (port ví dụ ở trên):

```sh
curl --max-time 5 -X POST http://127.0.0.1:9001/control/hold
curl --max-time 5 http://127.0.0.1:9002/summary
# Trong terminal khác: quan sát waiting, rồi release trước read deadline 700ms.
curl --max-time 5 http://127.0.0.1:9001/control/stats
curl --max-time 5 -X POST http://127.0.0.1:9001/control/release
curl --max-time 5 'http://127.0.0.1:9002/summary?mode=terminal'
```

Nếu thao tác tay chậm hơn 700ms thì 502 là hành vi deadline dự kiến. Integration
test tự điều phối bằng barrier. Để quan sát saturation lâu hơn có thể dùng hai
client trực tiếp `/stream` khi hold; process producer sẽ tự hủy sau 4 giây.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/32-streaming-backpressure/test/lesson.test.mts
# Chạy trong môi trường được phép mở loopback:
node --test --test-timeout=15000 lessons/32-streaming-backpressure/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit test được viết trước stub, đã quan sát assertion RED (`count` 0 thay vì 1,
thiếu exception và pull count sai), rồi mới triển khai. Unit bao gồm split từng
byte UTF-8, escape tối đa, cận byte chính xác, thiếu/sai terminal, delayed drain,
close/error/abort/deadline khi chờ drain và import trong child với cấu hình sai.

Integration test không mở listener ở top level. Mỗi test tự spawn các service trên
`127.0.0.1:0`, có request deadline, polling có cận, shutdown trong `finally`.
Không cần file fixture, SQLite hoặc thư mục ghi; chạy được khi source read-only,
không có scratch ngoài source. Các test kiểm tra complete streaming, counter
false/drain thật, max-two admission, hủy một waiter rồi nhận stream mới, deadline
đọc giải phóng cả hai phía, fixture lỗi, recovery và start/stop lại process.
Worker không được mở mạng nên **chưa chạy integration, npm run check hoặc make
test**; controller chạy chúng trong Docker cô lập. Không coi unit là bằng chứng
HTTP integration đã qua.

## Giới hạn, tradeoff và bài tập

Streaming giảm nhu cầu giữ toàn bộ payload, đổi lại cần giao thức terminal,
parser incremental và quản lý lifecycle rõ ràng. Không retry tự động: chạy lại
stream có thể tạo hiệu ứng trùng nếu downstream ghi bền vững. Sequence chỉ xác
nhận thứ tự trong một response; không phải event ID toàn cục, replay cursor hay
cam kết exactly-once. Muốn replay cần log lưu bền, cursor có phiên bản, retention;
muốn hiệu ứng không trùng cần idempotency/transaction ở đích.

Deadline cố định và max-two là lựa chọn dạy học; read deadline 700ms có thể từ chối
peer chậm nhưng còn sống. High-water mark 1 tăng số wake-up, không phải giá trị
tối ưu throughput cho production. Summary cố ý không chứa nội dung text. Không
có xác thực, compression, resume, fan-out hoặc durable writes.

1. Thêm tổng độ dài text vào summary nhưng giữ output có cận và không giữ text.
2. Thử UTF-8 sai ở byte cuối, terminal có `count: "64"`, duplicate sequence và
   record thứ 65; mỗi fixture phải giữ mọi điều kiện không liên quan hợp lệ.
3. Thiết kế replay cursor cho một log bền vững: phân biệt offset, stream identity,
   duplicate và retention gap trước khi viết code.
4. So sánh high-water mark 1 và 16384 bằng counter, giải thích vì sao số lần drain
   thay đổi mà không suy ra được bộ nhớ kernel từ số đó.

Tài liệu chính thức: [Node v24 Streams](https://nodejs.org/docs/latest-v24.x/api/stream.html)
(`write`, `drain`, highWaterMark, destroy) và
[Node v24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)
(`createServer`, `ServerResponse`, timeout và lifecycle).
