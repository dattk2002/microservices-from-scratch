# 54 — Gom request có giới hạn, trả kết quả đúng key và hủy waiter độc lập

Cần Node.js **24.12+**, npm và kiến thức HTTP, Promise, AbortController,
backpressure. Chỉ dùng built-in ở runtime; chạy các lệnh dưới từ gốc repository.

```sh
npm ci
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/54-bounded-request-batching/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/54-bounded-request-batching/test/lesson.test.mts
npm run check
make test
```

Hai terminal độc lập:

```sh
HOST=127.0.0.1 PORT=5401 node lessons/54-bounded-request-batching/catalog.mts
HOST=127.0.0.1 PORT=5400 CATALOG_ORIGIN=http://127.0.0.1:5401 node lessons/54-bounded-request-batching/gateway.mts
```

`PORT=0` chọn cổng tạm; mỗi process in một dòng JSON `{service,port}` khi sẵn
sàng. `HOST` mặc định `127.0.0.1`. Import module không đọc cấu hình, tạo timer,
đăng ký signal hay mở listener. Cấu hình chỉ được đọc trong `main()`.
`CATALOG_ORIGIN` là origin HTTP cố định do người vận hành đặt, không phải URL
caller truyền. Không credentials, path, query hoặc fragment trong origin.

```sh
curl -s http://127.0.0.1:5400/lookup -H 'content-type: application/json' \
  -d '{"ids":["h","a","h","unknown"]}'
curl -s http://127.0.0.1:5400/state
```

Kết quả đầu tiên:

```json
{"items":[{"id":"h","found":true,"value":80},{"id":"a","found":true,"value":10},{"id":"h","found":true,"value":80},{"id":"unknown","found":false}]}
```

## Hợp đồng và luồng xử lý

Catalog giữ dữ liệu hư cấu bất biến: `a..h` tương ứng `10,20,..80`.
`POST /batch {ids}` nhận 1–4 ID khác nhau; ID là chuỗi 1–16 ký tự
`A-Z a-z 0-9 _ -`. ID hợp lệ nhưng không tồn tại trả `found:false`.
Catalog chủ động trả thứ tự đảo ngược để gateway không thể dựa vào vị trí.

Gateway `POST /lookup {ids}` nhận 1–8 ID, có thể trùng. Mỗi vị trí là một
waiter; hai vị trí `h` chiếm hai waiter nhưng chỉ một key. Gateway ghép theo
`id`, kiểm tra toàn bộ batch rồi mới trả đủ vị trí theo thứ tự đầu vào.
Không có kết quả một phần. Top-level null, array, boolean hoặc field sai kiểu
trả 400; JSON lỗi trả 400, media type sai 415, request quá 8192 byte trả 413.
Route không tồn tại trả 404.

```text
caller A [a,b,a] ─┐
                 ├─ batcher: FIFO key → tối đa 4 key → catalog process
caller B [b,c] ───┘                     một batch đang chạy
                 └─ map theo ID → [a,b,a] và [b,c]
```

`setImmediate` gom các enqueue trong cùng vòng xử lý; scheduler có thể tiêm vào
unit test. Không bảo đảm hai HTTP request bất kỳ luôn vào cùng batch: điều này
phụ thuộc thời điểm chúng tới. Test HTTP giữ một batch để quan sát các request
sau đang chờ, rồi xác nhận chúng đi cùng batch qua `lastIds` và số call.
Tám key khác nhau được chia thành hai batch bốn key. Chỉ một batch hoạt động
toàn process; key chờ theo thứ tự lần đầu được nhận.

Giới hạn admission là **16 waiter tổng cộng**, **8 key tổng cộng**, tính cả
in-flight. Cả danh sách được nhận nguyên tử hoặc trả 429, không giữ một phần.
Khi batch trước hoàn tất, waiter đã có kết quả không tiếp tục chiếm capacity.
Không lưu cache: key chỉ chia sẻ khi pending/in-flight; lookup sau khi key đã
settled gọi catalog lại. Không có retry ngầm.

Mỗi caller có deadline tổng 600ms tính cả đọc body và queue. Hết hạn khi còn
kết nối trả 504. Đóng kết nối xóa riêng waiter của caller đó, không gửi response.
Key queued hết waiter bị xóa; batch đang chạy chỉ bị hủy vì caller rời đi khi
**tất cả** waiter của mọi key trong batch đều biến mất. Deadline upstream 300ms
độc lập vẫn có thể hủy batch. Timer bắt đầu trước fetch và không đặt lại theo
chunk. Hủy transport có thể hoàn tất bất đồng bộ; batch kế tiếp bắt đầu sau
khi batch trước đã kết thúc, tránh vượt concurrency.

## Ranh giới tin cậy và lỗi

Gateway dùng `redirect:'error'`: origin không thay đổi qua 307; payload không
được gửi sang đích redirect. Test có một process đích thật trên cổng loopback
khác và kiểm tra counter của đích trước khi thay fixture mode.

Response bị chặn ở **2048 byte**, kể cả whitespace. Budget bao gồm 4 ID dài
16 ký tự: ngay cả mỗi ký tự chuỗi JSON và tên field đều viết dạng `\uXXXX`,
response hợp lệ vẫn dưới 1100 byte. Request 8 ID tương tự dưới 1000 byte,
nhỏ hơn budget 8192 của reader dùng chung. Test chấp nhận maximal escaping chỉ
trên token chuỗi đã decode; không làm hỏng boolean/number. Fixture oversized
vẫn đúng schema và đủ membership, thêm whitespace hợp lệ để chỉ byte gate
quyết định lỗi.

Mỗi ID yêu cầu phải xuất hiện đúng một lần, không extra/missing/duplicate.
`found` phải là boolean; true cần value nguyên 1–100, false cấm field value.
Lỗi JSON, schema, byte, upstream status, slow body hoặc redirect đều thành 502
cho caller có key trong batch lỗi. Các caller queued độc lập vẫn chạy tiếp.
Không trả phần kết quả đã thu được trước lỗi. Không retry, ghi dữ liệu hoặc
thực hiện thanh toán.

`GET /state` chỉ trả `{waiters,keys,activeBatchSize,upstreamCalls,cancelledWaiters}`.
Gauge bị giới hạn bởi admission, counter bão hòa 65535. Không giữ lịch sử
request vô hạn. `cancelledWaiters` đếm vị trí chưa có kết quả bị bỏ do timeout
hoặc disconnect, không đếm lỗi upstream.

## Playground: quan sát hold và failure

Chỉ bật local để học:

```sh
HOST=127.0.0.1 PORT=5401 TEACHING_CONTROLS=1 node lessons/54-bounded-request-batching/catalog.mts
curl -s http://127.0.0.1:5401/teaching/hold -H 'content-type: application/json' -d '{"enabled":true}'
curl -s http://127.0.0.1:5401/teaching/state
curl -s http://127.0.0.1:5401/teaching/hold -H 'content-type: application/json' -d '{"enabled":false}'
curl -s http://127.0.0.1:5401/teaching/behavior -H 'content-type: application/json' -d '{"mode":"unavailable"}'
curl -s http://127.0.0.1:5401/teaching/behavior -H 'content-type: application/json' -d '{"mode":"normal"}'
```

Controls không bật trả 404. `enabled` phải boolean, `mode` phải chuỗi
`normal|unavailable`, sai kiểu trả 400. State gồm `calls,lastIds,maxConcurrent,active`;
`lastIds` tối đa 4, counter bão hòa. Một held batch tối đa, tự giải phóng sau
800ms, có release rõ ràng; response đóng hoặc shutdown cũng dọn timer.
Gateway có thể hết deadline upstream trước thời gian hold này. Không dùng
controls để đo benchmark hay triển khai public.

## Kiểm chứng và giới hạn

Unit test chạy batcher thật với scheduler/timer tiêm vào: phân biệt fanout và
batching, đảo thứ tự reply, chia 4 key, admission nguyên tử, hủy một/tất cả,
queue deadline, upstream deadline và giải phóng capacity. HTTP test dùng child
process độc lập, cổng tạm, barrier state/hold, timeout và `finally` cleanup;
không suy concurrency từ thời gian chạy. Fixture source được tái sử dụng giữa
các lỗi và reset calls từng case; đích redirect giữ nguyên counter bằng chứng.
Test import chạy child có cấu hình cố ý sai nhưng vẫn phải thoát 0, không output.

Batching giảm số call nhờ ghép **key khác nhau**. Cache stampede suppression
chỉ hợp nhất nhiều người chờ **cùng key**; bài này có cả pending fanout nhưng
không cache kết quả đã settled. Durable job queue lưu công việc qua restart,
ack/retry và thường có side effect; pending work ở đây chỉ trong RAM, mất khi
process restart. Client chỉ có thể retry an toàn vì lookup là phép đọc thuần.
Restart không khôi phục waiter cũ; request mới chạy bình thường.

Tradeoff: concurrency một batch làm throughput thấp hơn nhưng dễ chứng minh
bound; FIFO key không phải fairness theo tenant. Admission là per-process,
không phải quota toàn cluster. Không tương thích API DataLoader, không retry,
không persistence, không benchmark workload production. Node HTTP và runtime
vẫn có buffer riêng ngoài giới hạn dữ liệu ứng dụng được trình bày ở đây.

Bài tập: thêm fairness theo caller mà vẫn admission nguyên tử; giải thích vì
sao retry cho mutation không được dùng quy tắc của lookup này; thử bỏ kiểm tra
membership rồi quan sát regression nào bắt lỗi; thiết kế shutdown drain có
hạn mà không nhận caller mới.

Tham khảo chính thức: [DataLoader — batching và caching](https://github.com/graphql/dataloader),
[Node.js timers](https://nodejs.org/api/timers.html),
[Node.js HTTP](https://nodejs.org/api/http.html),
[Fetch redirect](https://fetch.spec.whatwg.org/#concept-request-redirect-mode).
