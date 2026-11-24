# 95 · GOAWAY và ngừng nhận stream mới khi dừng HTTP/2

Một kết nối HTTP/2 có thể phục vụ nhiều yêu cầu đồng thời. Khi worker nhận
`SIGTERM`, nó ngừng nhận việc mới nhưng tiếp tục trả nốt những phản hồi đang
gửi. Gateway cũng phải ngừng mở stream trên phiên đã nhận GOAWAY, ngay cả khi
phiên ấy vẫn đang truyền dữ liệu cho yêu cầu cũ.

## Chạy ví dụ

Cần Node.js 24.12 trở lên trong dòng 24, Bash và `curl`. Chạy từ thư mục gốc
của repository. Hai tiến trình chỉ nghe trên `127.0.0.1`. Worker dùng HTTP/2
cleartext với prior knowledge (h2c), gateway nhận HTTP/1.1.

```bash
lesson=lessons/95-http2-goaway-drain
PORT=3095 WORK_MS=300 node "$lesson/worker.mts" &
worker_pid=$!
PORT=8095 WORKER_PORT=3095 node "$lesson/gateway.mts" &
gateway_pid=$!
```

Sau khi thấy hai dòng JSON báo cổng, thử hai tuyến công khai.

```bash
curl --max-time 2 -i http://127.0.0.1:8095/health
curl --max-time 2 -i http://127.0.0.1:8095/work
```

Để quan sát drain bằng tín hiệu thật, có thể chạy lại hai tiến trình với đoạn
Bash dưới đây. Pipe đồng bộ theo dòng log `work-started` của worker, được ghi
sau khi gọi `stream.write()` với tiền tố JSON. Chờ log giúp tín hiệu đến khi
công việc đã được nhận. Khối lệnh có thời hạn đọc và dọn hai tiến trình khi thoát.

```bash
(
  lesson=lessons/95-http2-goaway-drain
  coproc NODE_WORKER { exec env PORT=3096 WORK_MS=300 node "$lesson/worker.mts"; }
  worker_pid=$NODE_WORKER_PID
  trap 'kill -TERM "$worker_pid" ${gateway_pid:-} 2>/dev/null || true; wait' EXIT
  exec 3<&"${NODE_WORKER[0]}"
  IFS= read -r -t 3 worker_ready <&3 || exit 1
  PORT=8096 WORKER_PORT=3096 node "$lesson/gateway.mts" &
  gateway_pid=$!
  for attempt in {1..30}; do
    curl --max-time 1 -fsS http://127.0.0.1:8096/health >/dev/null 2>&1 && break
    sleep 0.05
  done
  curl --max-time 2 -i http://127.0.0.1:8096/work &
  caller_pid=$!
  IFS= read -r -t 3 started <&3 || exit 1
  printf '%s\n' "$started"
  kill -TERM "$worker_pid"
  wait "$caller_pid" || exit 1
  wait "$worker_pid" || exit 1
  curl --max-time 2 -i http://127.0.0.1:8096/work
  curl --max-time 2 -i http://127.0.0.1:8096/health
)
```

Lệnh gọi đang chạy nhận `200` và `{"result":"done"}`. Sau khi worker thoát,
`/work` nhận `502`, còn `/health` tiếp tục trả `200`. Để dừng hai tiến trình
đã khởi động ở ví dụ đầu, chạy `kill -TERM "$gateway_pid" "$worker_pid"` rồi
`wait "$gateway_pid" "$worker_pid"` trong cùng shell.

| Biến | Tiến trình | Mặc định | Phạm vi |
| --- | --- | --- | --- |
| `PORT` | Worker | `3095` | Số nguyên 0–65535 |
| `PORT` | Gateway | `8095` | Số nguyên 0–65535, khác `WORKER_PORT` |
| `WORKER_PORT` | Gateway | `3095` | Số nguyên 1–65535 |
| `WORK_MS` | Worker | `100` | Số nguyên 0–300 |

`PORT=0` yêu cầu hệ điều hành cấp cổng tạm. Đọc trường `port` trong dòng
JSON báo sẵn sàng của worker rồi truyền cổng thực vào `WORKER_PORT` khi chạy
gateway.

## Đường đi và hợp đồng

```text
Client ── HTTP/1.1 ──> gateway ── h2c, tối đa 2 phiên ──> worker
                           └── /health trả lời tại chỗ
```

- `GET /work` mở đúng một stream cho mỗi yêu cầu được gateway nhận vào pool.
  Worker gửi ngay status `200` và tiền tố `{"result":`, rồi gửi phần
  `"done"}` và kết thúc stream sau `WORK_MS`. Gateway đợi toàn bộ phản hồi
  hợp lệ trước khi gửi JSON cho client HTTP/1.1.
- `GET /health` trên gateway trả `{"status":"ok"}`. Nó kiểm tra tiến trình
  gateway và hoạt động cả khi worker không khả dụng.
- Route có query trả `400 invalid_query`. Route lạ trả `404 not_found`.
  Phương thức sai trên route đã biết trả `405 method_not_allowed` với
  `Allow: GET`. HEAD tuân theo quy tắc HTTP không gửi thân phản hồi.
- Hai tuyến đều không nhận body. Gateway từ chối framing khác độ dài bằng
  không và các khai báo coding, trailer hoặc expectation trên yêu cầu.
  Worker đòi HEADERS có `END_STREAM` cho yêu cầu bodyless. Các lỗi trước
  handler có thể dùng phản hồi hay reset của bộ phân tích giao thức Node.
- JSON dùng `application/json; charset=utf-8`. Lỗi ứng dụng có dạng
  `{"error":{"code":"busy","message":"busy"}}`, với `message` bằng `code`.
  Gateway kiểm tra các header quan trọng trùng lặp từ danh sách thô.
  Giới hạn header và body upstream là 8192 byte, cùng giới hạn 64 trường.
- Gateway trả `502 upstream_failure` khi kết nối lỗi, status khác 200
  (kể cả redirect và 421), stream bị reset hoặc kết thúc sớm, media type
  hay coding sai, UTF-8 lỗi, hoặc JSON khác đúng một trường
  `result` kiểu chuỗi có giá trị `done`. Body vượt giới hạn cũng trả 502.
  Hết ngân sách 500 ms tới EOF trả `504 upstream_timeout`.
- Gateway trả `503 busy` nếu đã có tám yêu cầu upstream hoạt động hoặc
  cả hai vị trí phiên không còn khả năng nhận stream. Gateway không xếp
  hàng chờ phiên. Client HTTP/1.1 ngắt kết nối thì gateway hủy riêng
  stream tương ứng.

## Vòng đời khi dừng

1. Worker đóng listener khi nhận tín hiệu đầu tiên và đóng cổng nhận việc
   của từng phiên. Trạng thái drain lưu các ID đã nhận còn hoạt động, ID
   cao nhất đã nhận và hạn monotonic 750 ms. Đóng stream giải phóng ID
   đúng một lần. Tín hiệu lặp không kéo dài hạn.
2. Worker gửi `GOAWAY(NO_ERROR)` với cutoff của phiên rồi gọi
   `session.close()`. Node hoàn tất quá trình đóng phiên sau các stream
   còn lại. Hết hạn drain thì tiến trình hủy các phiên và socket còn sống.
   Log `work-finished` ghi nhận sự kiện `finish` của stream tại worker
   trước khi tiến trình thoát sạch. Gateway kiểm tra toàn bộ phản hồi tới
   EOF rồi mới trả 200. Thứ tự giữa lúc worker thoát và lúc client HTTP/1.1
   đọc xong không được bảo đảm vì luồng này không có xác nhận từ client.
3. Gateway chuyển phiên sang `draining` ngay trong callback GOAWAY. Stream
   cũ tiếp tục dùng hạn riêng của nó. Yêu cầu đến sau có thể dùng phiên
   mở khác hoặc tạo kết nối mới nếu pool còn chỗ. Kết nối mới phục vụ yêu
   cầu mới. Mỗi yêu cầu chỉ có một lần thử, kể cả khi gặp
   `REFUSED_STREAM`, GOAWAY hay 421.
4. Khi chính gateway nhận `SIGTERM`, nó đóng listener, từ chối tiếp nhận
   công việc mới và đóng các phiên upstream theo vòng đời graceful.
   Hạn 750 ms cũng giới hạn quá trình dừng của gateway.

Theo RFC 9113, last-stream-ID là giới hạn stream mà phía gửi GOAWAY có thể
đã xử lý trên kết nối đó. Nó chỉ mô tả phạm vi xử lý ở tầng giao thức.
Muốn xác nhận một nghiệp vụ đã commit hoặc đạt hiệu ứng exactly-once thì
cần hợp đồng riêng ở tầng ứng dụng, chẳng hạn khóa idempotency và bản ghi
kết quả bền vững.

## Giới hạn và đánh đổi

- Gateway giữ tối đa tám phản hồi upstream trong bộ nhớ, kiểm tra byte,
  UTF-8 và schema trước khi công bố kết quả. Cách này phù hợp với JSON
  nhỏ và làm client HTTP/1.1 đợi EOF thay vì nhận dữ liệu từng phần.
- Node xử lý HTTP/2, pseudo-header và HPACK. Gateway chỉ quan sát ranh
  giới frame bên nhận h2c để xác nhận `END_STREAM` thật vì readable
  `end` có thể xuất hiện sau reset mã zero. Chương trình không giữ payload
  trong bộ quan sát này. Node vẫn quyết định tính hợp lệ của frame.
- Mỗi worker tối đa 16 kết nối TCP và quảng bá tám stream đồng thời trên
  từng phiên. Kết nối worker hoặc phiên gateway rảnh bị đóng sau khoảng
  năm giây. Đây là ví dụ loopback một đích cố định, dùng plaintext và
  không có service discovery hoặc kiểm tra sẵn sàng của worker.
- Mô hình không lưu trạng thái nghiệp vụ. Hủy stream chặn việc chờ hoặc
  truyền dữ liệu tiếp. Công việc thực tế đã có tác dụng phụ cần cơ chế
  dừng và xác nhận ở tầng nghiệp vụ.

## Kiểm thử và bài tập

```bash
node --test --test-name-pattern=unit: lessons/95-http2-goaway-drain/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/95-http2-goaway-drain/test/lesson.test.mts
npm run typecheck
```

Unit tests kiểm tra trạng thái drain, bộ chọn phiên, hạn monotonic, tín
hiệu EOF trên từng stream và import im lặng. Integration tests cần quyền
mở socket loopback và chạy tiến trình con trên cổng tạm. Một client TCP
thô đợi DATA đầu tiên rồi kiểm tra cutoff GOAWAY bằng ID stream đang chạy.
Client gửi HEADERS của stream kế tiếp trên cùng kết nối và đợi PING ACK
để xác nhận peer đã đọc qua vị trí của HEADERS. Worker chỉ ghi nhận việc
đã nhận trước khi dừng. Kiểm thử riêng giữ một kết nối ở preface dở dang
và giữ một stream hết cửa sổ flow control để buộc worker đi qua nhánh hủy
sau 750 ms. Peer mô phỏng của gateway gửi JSON hợp lệ, tiếp tục gửi khoảng
trắng và lên lịch END_STREAM ở 700 ms. Gateway phải hủy đúng một stream
trước END_STREAM và trả 504. Các ca khác kiểm tra reset, giới hạn pool và
hủy khi client rời đi.

1. Đặt `WORK_MS=0`, sau đó đặt `WORK_MS=300`. So sánh thời điểm có log
   `work-started` với thời điểm gateway trả phản hồi.
2. Chạy các kiểm thử GOAWAY, rồi tạm bỏ điều kiện loại phiên
   `draining` trong bộ chọn. Xác định assertion nào phát hiện phiên đã
   retire vẫn được chọn.
3. Thiết kế một hợp đồng idempotency cho một lệnh ghi tưởng tượng. Nêu dữ
   liệu nào phải commit cùng giao dịch và cách client tra cứu kết quả khi
   kết nối đóng trước phản hồi.

## Tài liệu gốc

- [RFC 9113, mục 6.8 — GOAWAY](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.8)
- [Node.js 24.12.0 — `http2session.close()`](https://nodejs.org/download/release/v24.12.0/docs/api/http2.html#http2sessionclosecallback)

Test drain của gateway còn giữ một peer TCP chỉ đóng nửa kết nối: request hết hạn và gửi RST_STREAM sau 500 ms, nhưng phía đọc vẫn còn tài nguyên. Hạn drain 750 ms phải đóng phần còn lại. Test dùng khoảng dung sai lập lịch để phân biệt với hồi quy kéo dài lên 1000 ms.
