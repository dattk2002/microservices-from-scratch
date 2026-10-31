# 04 — Truyền deadline và hủy yêu cầu

Bài này dùng ba tiến trình HTTP độc lập: Gateway → Orders → Catalog. Một lần lấy
báo giá có **một deadline tuyệt đối**, tính bằng Unix milliseconds. Mỗi hop chuyển
nguyên giá trị `x-request-deadline-ms`; thời gian đã dùng không được cấp lại.
Orders chỉ lấy báo giá, chưa tạo hoặc lưu đơn hàng.

Khác bài 01 đặt timeout riêng cho một lần gọi Catalog, bài này ràng buộc cả chuỗi.
Ví dụ deadline là `1800`: lúc Gateway có đồng hồ `1000` còn 800ms; lúc Orders thấy
`1450` chỉ còn 350ms. Nếu mỗi hop tự cấp thêm 800ms, tổng thời gian có thể vượt
ngân sách mà caller cho phép.

## Chuẩn bị và chạy

Cần Node **24.12+ và <25**, npm, curl. Không cần Docker, database, tài khoản hoặc
package runtime. Tại thư mục gốc repository, cài dev tools một lần bằng `npm ci`.
Ba terminal riêng, đều bắt đầu tại gốc repository:

```bash
PORT=4401 node lessons/04-deadline-propagation/catalog.mts
```

```bash
PORT=4402 CATALOG_URL=http://127.0.0.1:4401 node lessons/04-deadline-propagation/orders.mts
```

```bash
PORT=4400 ORDERS_URL=http://127.0.0.1:4402 node lessons/04-deadline-propagation/gateway.mts
```

Mỗi tiến trình in một dòng JSON `{service,port}` khi đã listen. `GET /health` trả
200 với `{"status":"ok"}`. `PORT=0` chọn cổng tạm cho integration tests. `HOST`
mặc định `127.0.0.1`; URL downstream chỉ nhận HTTP origin `127.0.0.1`, không path,
query, fragment hoặc credentials. Các cổng mặc định lần lượt Catalog 4401, Orders
4402, Gateway 4400. SIGINT/SIGTERM đóng kết nối ngay; đây chưa phải graceful drain.

Một báo giá tức thời, Gateway tự cấp 1000ms khi thiếu header:

```bash
curl -i 'http://127.0.0.1:4400/quote/pencil?workId=quick-1'
```

Kết quả 200 có dạng:

```json
{"productId":"pencil","priceCents":125,"workId":"quick-1","deadlineMs":1793420001000}
```

`deadlineMs` thực tế phụ thuộc đồng hồ lúc chạy. Dùng workId mới cho mỗi lần gọi;
Catalog không cho tái sử dụng workId còn được lưu. Đây là ID của công việc để quan
sát, **không phải** hợp đồng idempotency của lệnh tạo đơn.

## Thấy công việc bị hủy thật

Catalog mô hình hóa việc **chờ duyệt tồn kho** khi có `hold=1`. Nó không giả lập
bằng một sleep: yêu cầu thực sự chờ hành động release, deadline hoặc disconnect.
Các endpoint `/work` là API thực hành cục bộ để người học quan sát và duyệt công
việc; không có phương thức chỉ dành cho test trong production class.

Tại terminal thứ tư, bắt đầu một yêu cầu chờ với ngân sách 4500ms:

```bash
end=$(node -p 'Date.now() + 4500')
curl -i -H "x-request-deadline-ms: $end" \
  'http://127.0.0.1:4400/quote/pencil?workId=approval-1&hold=1' &
caller=$!
curl -sS 'http://127.0.0.1:4401/work/approval-1?until=running'
# Chỉ release sau khi đã quan sát running:
curl -i -X POST 'http://127.0.0.1:4401/work/approval-1/release'
wait "$caller"
```

Để thấy hết ngân sách, đổi ID thành `expiry-1`, gọi cùng URL với `hold=1` và bỏ
bước release. Gateway trả 504; quan sát bằng:

```bash
curl -i 'http://127.0.0.1:4401/work/expiry-1?until=cancelled'
```

Để thấy disconnect trước deadline, bắt đầu lại bằng ID `disconnect-1` và header
4500ms, đợi `/work/disconnect-1?until=running`, rồi `kill "$caller"` để dừng curl.
`/work/disconnect-1?until=cancelled` trả trạng thái `cancelled`, reason `caller`.
Catalog dừng chờ và bỏ release callback; release sau đó trả 409. Không thể kết
luận hủy chỉ từ việc client nhận lỗi: cần quan sát công việc downstream đã dừng.

## Hợp đồng HTTP và giới hạn

| Endpoint | Method và hợp đồng |
| --- | --- |
| Gateway `/quote/:productId` | GET; header có thể thiếu, khi đó cấp 1000ms |
| Orders `/quote/:productId` | GET; bắt buộc header |
| Catalog `/products/:productId` | GET; bắt buộc header; chỉ có `pencil` |
| Catalog `/work/:workId` | GET; trả snapshot hoặc 404 nếu chưa có/đã bị loại |
| Catalog `/work/:workId?until=running\|completed\|cancelled` | GET long-poll tối đa 2000ms, kể cả khi work chưa đến |
| Catalog `/work/:workId/release` | POST không body; duyệt một work đang chờ |

Các route quote/products yêu cầu một `workId` gồm 1..48 ký tự `[a-z0-9-]`, có thể
thêm đúng một `hold=1`. Tham số lạ, lặp hoặc sai giá trị trả 400. Product ID cũng
có cùng giới hạn. Mọi endpoint không nhận request body; gửi Content-Length khác
0 hoặc Transfer-Encoding bị trả 400 và đóng kết nối. Dùng đúng method; sai method
trả 405 với `Allow`. URL tối đa 2048 ký tự, header tối đa 4096 byte. Server giới
hạn 128 kết nối; timeout nhận header/request 5000ms, socket bất động 6000ms.

Giá trị header sau khi Node parse phải là đúng một số nguyên thập phân dương
dạng chuẩn, không khoảng trắng, leading zero, dấu, số mũ hoặc danh sách; giá trị
phải là safe integer. Node chuẩn hóa HTTP optional whitespace (OWS) quanh giá trị
trên đường truyền trước khi `deadline()` nhận nó, nên validator không thể từ chối
OWS đã được Node loại bỏ. Deadline
phải còn hiệu lực và cách đồng hồ hiện tại không quá **5000ms**. Metadata sai hoặc
quá xa trả 400 `invalid_deadline`; đã hết hạn trả 504 `deadline_exceeded`, trước
khi tạo công việc. Header lặp bị Node ghép thành danh sách và cũng bị từ chối.

| Status | Ý nghĩa |
| --- | --- |
| 200 | Báo giá, health, snapshot hoặc release thành công |
| 400 | Query/header/body không hợp lệ; thiếu header tại hop nội bộ |
| 404 | Route, sản phẩm hoặc work không tồn tại |
| 405 | Method không hợp lệ |
| 408 | Long-poll chưa thấy trạng thái mong đợi trong 2000ms |
| 409 | Catalog gặp workId trùng hoặc work không còn chờ release |
| 414 | URL quá dài |
| 429 | Catalog hết chỗ chứa work hoặc observer |
| 502 | Downstream trả status/hợp đồng không hợp lệ, redirect hoặc JSON lỗi/quá lớn |
| 503 | Không kết nối được downstream |
| 504 | Ngân sách end-to-end hết hạn |

Lỗi ứng dụng có dạng `{"error":{"code":"...","message":"..."}}`. Các hop chuyển
404/429/503/504 thành lỗi cùng status; status downstream khác, kể cả 409 nội bộ,
trở thành 502. Server HTTP còn có thể từ chối header lỗi trước khi vào handler.
Nếu caller đã đóng socket, không còn nơi gửi status; 499 chỉ là phân loại lỗi nội
bộ khi hủy, không phải phản hồi hứa hẹn tới caller.

Downstream response phải có Content-Type `application/json`, không quá 8192 byte,
quote hợp lệ và đúng workId/deadline ban đầu. Không follow redirect. AbortSignal
bao phủ cả fetch lẫn quá trình đọc body: server gửi header rồi giữ body vô hạn
vẫn bị hủy khi hết deadline. Không retry nên không có attempt mới sau khi ngân
sách hết.

Catalog chỉ giữ tối đa 128 work trong RAM; khi đầy, loại terminal work cũ nhất;
không loại work đang chạy. Nếu tất cả đều chạy, từ chối 429. Tối đa 64 observer
long-poll; từng observer có ngân sách riêng 2000ms và được dọn khi disconnect.
Snapshot terminal chỉ là lịch sử ngắn hạn, mất khi restart, không phải audit log.

## Đọc code và kiểm chứng

- `budget.mts`: parse timestamp và tính thời gian còn lại bằng clock được inject.
- `lifecycle.mts`: scope AbortController cho mỗi request, HTTP server và bounded
  downstream JSON. `res.close` trước khi gửi xong và `req.aborted` hủy fetch.
  Timer expiry cũng hủy fetch; `finally` gỡ timer/listener, reader được cancel hoặc
  drain rồi release lock.
- `gateway.mts`, `orders.mts`, `catalog.mts`: ba điểm vào riêng. Mỗi hop kiểm tra
  ngân sách trước khi gọi và trước khi gửi kết quả. Catalog chờ release bằng
  Promise có listener hủy được gỡ trên mọi nhánh.

Từ repository root:

```bash
node --test --test-name-pattern=unit: lessons/04-deadline-propagation/test/lesson.test.mts
node --test --test-timeout=15000 lessons/04-deadline-propagation/test/lesson.test.mts
npm run typecheck
```

Unit tests dùng clock giả, không ngủ để kiểm tra phép tính và dữ liệu lỗi.
Integration tests chạy Gateway/Orders/Catalog bằng ba child process trên cổng tạm,
khẳng định timestamp ở Catalog bằng nguyên giá trị gửi vào, dùng long-poll làm
barrier cho running/cancelled, và dọn tất cả tiến trình kể cả khi assertion lỗi.
Có controlled HTTP peer trong test process để kiểm tra JSON lỗi/quá lớn,
redirect, deadline bị kéo dài và body không kết thúc. Deadline expiry dùng timer
thật vì đó là hành vi cần kiểm tra; không có assertion dựa trên `sleep(50)`.

## Trust, đồng hồ và tradeoff

Đây là lab trên loopback, không xác thực. Trong hệ thống thật, edge phải kiểm tra
hoặc tự đặt deadline và chỉ tin metadata từ hop nội bộ đã xác thực; không coi
header client là quyền dùng tài nguyên vô hạn. Trần 5000ms là policy của bài học,
không phải thông số nên sao chép cho mọi nghiệp vụ. Không public các endpoint
duyệt/quan sát cục bộ khi chưa thiết kế authorization và chống lạm dụng.

Timestamp tuyệt đối cần đồng hồ đủ đồng bộ giữa các máy. Clock chạy nhanh làm
ngân sách ngắn hơn; clock chậm có thể làm hop tưởng còn nhiều hơn hoặc từ chối
vì vượt trần. `Date.now()` không phải monotonic clock. Timer được lập một lần từ
remaining budget ở mỗi hop, không liên tục gia hạn khi đồng hồ đổi. Production
cần chính sách clock skew rõ ràng, đo thời gian cục bộ bằng monotonic clock, đồng
bộ clock và khoảng dự phòng; đừng lặng lẽ cộng thêm thời gian ở mỗi hop.

Hủy là cooperative và best effort: đóng HTTP khiến server biết caller biến mất,
nhưng không hoàn tác side effect đã commit. Bài này chỉ chờ duyệt và đọc báo giá;
không chứng minh transaction phân tán hay exactly-once. Khi timer các hop cùng
hết hạn, Catalog có thể ghi reason `deadline` hoặc `caller` vì upstream đóng
socket trước; cả hai đều phải đưa work tới `cancelled`. Endpoint quan sát có
budget riêng để vẫn đọc được kết quả hủy sau khi budget nghiệp vụ kết thúc.

## Bài tập

1. Dùng clock giả chứng minh vì sao `now + timeout` tại mỗi hop kéo dài ngân sách.
2. Thêm reserve 50ms cho việc đóng gói phản hồi bằng cách rút ngắn ngân sách
   downstream; giải thích vì sao không được tăng deadline tuyệt đối.
3. Thiết kế policy khi clock lệch ±100ms và viết test cho policy trước khi code.
4. Thay chờ duyệt bằng thao tác I/O có API AbortSignal; xác nhận underlying work
   đã dừng, rồi so sánh với một thư viện bỏ qua signal.

## Tài liệu chính thức

- [Node 24 — AbortController / AbortSignal](https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortcontroller)
- [Node 24 — fetch](https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch)
- [Node 24 — HTTP IncomingMessage, ServerResponse và timeout](https://nodejs.org/docs/latest-v24.x/api/http.html)
- [Node 24 — Timers](https://nodejs.org/docs/latest-v24.x/api/timers.html)
