# 23 — Distributed tracing và quan hệ span qua nhiều dịch vụ

Một đơn hàng trả chậm: Gateway chậm, hay Gateway đang chờ Orders, còn Orders
đang chờ Catalog? Bài này dựng ba **tiến trình HTTP độc lập**, mỗi nơi có một
server span cho mỗi request nghiệp vụ. Không có collector, SDK hay runtime package.
Node.js 24.12+ chạy trực tiếp `.mts`; dùng các development packages đã pin ở root
khi chạy TypeScript checker. Đọc trước bài 04 về deadline, bài 08 về correlation
logging, bài 19 về metrics và HTTP/Promise/AbortController cơ bản.

## Chạy ví dụ

Chạy tại root repo, trong ba terminal theo thứ tự:

```sh
PORT=3024 TEACHING_CONTROLS=1 node lessons/23-distributed-tracing/catalog.mts
PORT=3023 DOWNSTREAM_URL=http://127.0.0.1:3024 TEACHING_CONTROLS=1 node lessons/23-distributed-tracing/orders.mts
PORT=3022 DOWNSTREAM_URL=http://127.0.0.1:3023 TEACHING_CONTROLS=1 node lessons/23-distributed-tracing/gateway.mts
```

Mỗi tiến trình in một dòng JSON readiness `{service,port}`. `PORT=0` chọn cổng
loopback trống; fixture đọc dòng này bằng `test/support.mts`. `HOST` mặc định
`127.0.0.1`; giữ loopback cho phòng thí nghiệm. Dừng bằng Ctrl-C; shared `serve`
đóng listener và cưỡng bức đóng kết nối sau một giây khi cần.

```sh
curl -i -H 'traceparent: 00-11111111111111111111111111111111-2222222222222222-01' http://127.0.0.1:3022/order
curl http://127.0.0.1:3022/observe
curl http://127.0.0.1:3023/observe
curl http://127.0.0.1:3024/observe
```

`GET /order` trả 200 với `{order:"ready"}` ở Gateway/Orders hoặc
`{sku:"book",available:true}` ở Catalog. Mỗi response nghiệp vụ mang header
`traceparent` chứa span của server trả response. Ví dụ cây quan hệ:

```text
caller 2222222222222222 (không phải span do bài học ghi)
└─ Gateway span G, parent=2222222222222222
   └─ Orders span O, parent=G
      └─ Catalog span C, parent=O
```

G, O, C là các ID 16 ký tự hex khác nhau; cả ba giữ trace ID 32 ký tự của caller.
Gateway gửi context của G qua HTTP; Orders tạo O rồi gửi O; Catalog tạo C.
Đây là ba server span, chưa mô hình hóa riêng client span cho mỗi lần fetch.
`AsyncLocalStorage.run` giữ context qua await; outbound fetch đọc context hiện tại
thay vì dùng biến global chia sẻ giữa các request. Các entrypoint chỉ gọi `main`
khi `import.meta.main`; import mọi module không đọc configuration, mở listener,
đăng ký signal hoặc chạy công việc nền.

## Teaching profile version 00

`traceparent` phải khớp chính xác `00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`.
Trace ID và parent span ID không được toàn số 0. Không trim, không chấp nhận danh
sách, phần đuôi, uppercase hoặc version khác. Header lặp được Node ghép thành
chuỗi không hợp lệ và bị thay bằng context mới. Thiếu/sai header tạo trace ID mới,
không có parent, flags `01`. `node:crypto.randomBytes` tạo ID; generator được inject
trong unit tests, kiểm tra chiều dài/nonzero và không trùng parent trực tiếp.
Không cam kết tuyệt đối không va chạm trên toàn hệ thống; xác suất của random ID
rất nhỏ. Injected generator sai bị từ chối thay vì phát context sai.

Mọi giá trị flags từ `00` đến `ff` đều hợp lệ về hình dạng. Giữ nguyên byte khi
propagate; chỉ bit thấp nhất quyết định ghi span (`01`, `03`, `ff` có sampled bit;
`00`, `02`, `fe` không có). Các bit khác không được bài học diễn giải. Unsampled
vẫn được truyền context và xử lý HTTP, nhưng không thêm record quan sát.
Đây là profile dạy học cố định version00, **không phải toàn bộ W3C version
negotiation**, OpenTelemetry SDK, exporter hay implementation chứng nhận tuân thủ.

`traceparent` cung cấp định danh và flags cho quan hệ nhân quả. `tracestate` là
metadata tùy vendor, có quy tắc riêng về key, thứ tự và giới hạn. Bài này bỏ qua
và không forward `tracestate`, tránh giả vờ hiểu dữ liệu của vendor.

## Quan sát, thời gian và bảo mật

Mỗi process giữ ring tối đa 128 record trong RAM; record chỉ có operation allowlist
`gateway|orders|catalog`, traceId, spanId, parentSpanId nếu có, flags, durationMs,
status và outcome. Với các trường cố định này mỗi record dưới 512 byte. Không ghi
body, authorization, URL, raw query string, tên operation do caller chọn hay error
message. Không in mỗi request ra stdout; `/observe` là snapshot giới hạn, không
phải hàng đợi delivery hay kho lưu bền. Restart xóa tất cả. `finish`, `close`,
`error` cùng gọi bộ hoàn thành idempotent: sự kiện đầu tiên thắng, ghi tối đa một
record. `finish` chỉ chứng tỏ server đã chuyển dữ liệu cho hệ thống I/O, không
chứng minh caller đã nhận. `close` sớm có status 0/outcome cancelled; response
HTTP lỗi có outcome error; sự kiện error có status 0/outcome error.

Duration dùng `performance.now()` đơn điệu trong từng process, chặn về [0, 86400000]
ms. Không dùng đồng hồ wall time để suy ra thời lượng. Không thể sắp thứ tự các
máy bằng timestamp chưa đồng bộ; dùng parent ID cho quan hệ nhân quả. Duration
Gateway thường bao gồm chờ dependency và lớn hơn Catalog, nhưng không cộng ba
server durations vì chúng lồng nhau. Bài 08 chỉ giúp tìm log cùng correlation ID,
không biểu diễn cha/con và thời lượng từng hop. Bài 19 gộp nhiều request thành
counter/histogram; trace mô tả một đường thực thi, không thay thế metrics.

Context caller cung cấp không phải danh tính hay bằng chứng đáng tin: họ có thể
chọn trace ID của người khác, làm sai parent tree hoặc bật sampled để tăng chi phí.
Không dùng trace ID cho authorization, tenancy hoặc idempotency. Production cần
trust boundary, chính sách sampling phía server và hạn mức; không nhận flags như
quyền được ghi vô hạn. ID cũng có thể giúp liên kết hành vi người dùng: cần thời
hạn lưu trữ và kiểm soát truy cập. Các endpoint điều khiển chỉ bật bằng
`TEACHING_CONTROLS=1`, không có authentication: chỉ dùng trong loopback lab.

## Hợp đồng lỗi và barrier

`DEADLINE_MS` mặc định 1000, số nguyên 20..10000; mỗi hop có deadline cục bộ riêng.
Không truyền deadline tuyệt đối trong bài này. `PORT` 0..65535; `DOWNSTREAM_URL`
phải là HTTP origin `127.0.0.1` không user/password/path/query/fragment. Defaults
Orders 3023, Catalog 3024. Config sai chỉ lỗi khi start, không lỗi khi import.
Route hoặc method nghiệp vụ khác trả 404. Lỗi dependency, bao gồm HTTP không 2xx,
trả 502; hết deadline của process hiện tại trả 504. Lỗi socket sớm có thể trả 502
trước deadline. Không retry. Không gửi body của dependency về caller.

Trong chế độ controls, `GET /observe` trả `{records,active,arrivals}`; active là
số Catalog waiter đang giữ, arrivals là tổng lượt đi vào barrier từ lúc start.
`POST /release` giải phóng tất cả waiter thành công; `POST /fail` gây lỗi có chủ đích.
Các endpoint này không sinh span. Muốn nhìn thấy chờ dependency:

```sh
# Giữ terminal này; headers nghiệp vụ đều hợp lệ.
curl -i -H 'x-teaching-hold: 1' http://127.0.0.1:3022/order
# Ở terminal khác, chờ active=1 rồi giải phóng trước deadline:
curl http://127.0.0.1:3024/observe
curl -X POST http://127.0.0.1:3024/fail
```

Có thể đặt `DEADLINE_MS=10000` cho cả ba process khi thao tác bằng tay.
Không release sẽ hết deadline; đóng curl sớm sẽ abort fetch qua từng hop,
Catalog xóa waiter và abort listener. Timer và close listener được dọn trong
finally; response completion chỉ được ghi một lần dù finish/close cùng xuất hiện.
Ring có giới hạn nhưng số request đang xử lý chưa có admission control: bài này
không thay thế bulkhead/rate limiting. Tắt controls sẽ không có observation API
và header hold không làm chậm request.

## Kiểm thử và phạm vi thực thi

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/23-distributed-tracing/test/lesson.test.mts
# Chỉ chạy nơi được cấp loopback HTTP (controller Docker):
node --test --test-timeout=15000 lessons/23-distributed-tracing/test/lesson.test.mts
# Kiểm tra đầy đủ do controller thực hiện:
npm run check
make test
git diff --check
```

Unit tests inject IDs/monotonic clock, xét sampled bit, ba thứ tự finish/close/error,
ALS interleaving và child import với PORT/DOWNSTREAM_URL/DEADLINE_MS cố ý sai.
Child phải exit 0, stdout/stderr rỗng; startup thất bại không được tính là import
thành công. Đã quan sát assertion RED (parser trả undefined cho header hợp lệ)
trước implementation, rồi chạy lại các assertions GREEN.

Integration fixtures khởi động ba child process ở ephemeral loopback ports, dùng
barrier `active=1` thay vì ngủ để đoán dependency đã chạy. Một request bị giữ trong
khi request khác đi hết cây; tests kiểm tra ID, parent, không trộn trace, tiếp tục
context hợp lệ, thay context sai/thiếu, duration lỗi, 504 và caller disconnect.
Sau release kiểm tra lại mỗi hop có đúng một span. Polling có deadline; fetch có
abort timeout; stop child trong finally, helper có SIGKILL fallback. Không có
listener ở test-module top level, không có database hoặc scratch fixture trên
source; vì vậy fixtures dùng được với source read-only, không cần thư mục ghi.

Worker không chạy HTTP integration, `npm run check` hay `make test` vì không được
mở mạng/chạy Docker. Controller chịu trách nhiệm thực thi và review các test đó;
không coi việc typecheck integration code là bằng chứng HTTP đã chạy thành công.

## Bài tập

1. Thêm client spans: vẽ lại parent tree trước khi viết code, tránh gắn cả client
   và server span cùng ID. Cần thêm operation allowlist và đổi assertions nào?
2. Tạo chính sách sampling tại Gateway, đo sự khác biệt giữa không ghi span và
   không propagate context. Không bỏ parent khi chỉ tắt sampled bit.
3. Thêm hạn mức request đang giữ, trả 503 khi đầy và kiểm tra barrier không rò rỉ.
4. Thiết kế lưu trace có TTL mà không ghi request body; giải thích vì sao trace ID
   hợp lệ vẫn chưa cho caller quyền đọc record.

Tham khảo: [W3C Trace Context Level 1](https://www.w3.org/TR/trace-context-1/),
[Node.js 24 Async Context](https://nodejs.org/docs/latest-v24.x/api/async_context.html).
