# 36 — Consistent hashing, virtual nodes và cache affinity

Bài trước đã tách tenant; bài này giải quyết một câu hỏi khác: khi đổi danh sách máy cache, có thể giữ nhiều key ở đúng máy đang giữ cache nóng không? Cần biết TypeScript, HTTP, cache-aside và deadline. Dùng Node **24.12+**, chỉ built-in; chạy các lệnh từ thư mục gốc repository, sau khi cài development dependencies đã pin.

Đây là **cache affinity**, dữ liệu catalogue giả lập có thể tính lại hoàn toàn. Giá trị là SHA-256 của chuỗi UTF-8 `catalogue-v1:${key}`, phiên bản cố định, không phải kho dữ liệu mutable có thẩm quyền. Đổi membership không di chuyển dữ liệu bền vững, không replication, consensus hay tự động bảo đảm availability.

## Chạy bốn tiến trình độc lập

Mở ba terminal cho ba physical node:

```bash
CACHE_ID=a HOST=127.0.0.1 PORT=4631 node lessons/36-consistent-hashing/node.mts
CACHE_ID=b HOST=127.0.0.1 PORT=4632 node lessons/36-consistent-hashing/node.mts
CACHE_ID=c HOST=127.0.0.1 PORT=4633 node lessons/36-consistent-hashing/node.mts
```

Terminal thứ tư:

```bash
HOST=127.0.0.1 PORT=4630 TEACHING_CONTROLS=1 \
CACHE_A_ORIGIN=http://127.0.0.1:4631 \
CACHE_B_ORIGIN=http://127.0.0.1:4632 \
CACHE_C_ORIGIN=http://127.0.0.1:4633 \
node lessons/36-consistent-hashing/router.mts
```

Mọi server hỗ trợ `PORT=0`, in một dòng JSON `{service,port}` sau khi listen. `HOST` mặc định loopback. `node.mts` mặc định port 4631, router 4630; ba node cần ba port khác nhau. Tất cả origin đều bắt buộc, chỉ nhận HTTP origin không userinfo/path/query/fragment và được chốt khi startup. Không có caller URL trong API. `UPSTREAM_TIMEOUT_MS` mặc định 500, số nguyên 50..2000, bao gồm nhận headers và đọc hết body. Stop bằng Ctrl-C.

Trong một terminal khác:

```bash
curl -s http://127.0.0.1:4630/placement/catalogue-12
curl -s http://127.0.0.1:4630/objects/catalogue-12
curl -s http://127.0.0.1:4630/objects/catalogue-12
curl -s -H 'content-type: application/json' -d '{"members":["a","b","c"]}' http://127.0.0.1:4630/ring
curl -s http://127.0.0.1:4630/objects/catalogue-12
curl -s -H 'content-type: application/json' -d '{"members":["a","c"]}' http://127.0.0.1:4630/ring
```

Để thấy một key thật sự chuyển owner, dùng `sample.mts` hoặc so sánh `/placement/catalogue-N` trước/sau với N hữu hạn. Không giả định key minh họa nào cũng chuyển. Playground có thể chạy cùng bốn entrypoint process và gửi các request trên. `/ring` là teaching control local-only, chỉ tồn tại khi **`TEACHING_CONTROLS=1`**; không có xác thực, không dùng public production. Bỏ biến này thì `/ring` trả 404.

## Hợp đồng và giới hạn

| Route | Hành vi |
| --- | --- |
| `GET /placement/:key` | `{key,owner,epoch}`, không gọi node, không đọc/lưu lịch sử mapping |
| `GET /objects/:key` trên router | Gọi đúng một owner, trả `{key,owner,hit,value,epoch}` |
| `GET /objects/:key` trên node | `{key,owner,hit,value}`, cache LRU tối đa 32 key |
| `POST /ring` | JSON chỉ có `members`, subset không rỗng, không trùng của chuỗi `a,b,c`; trả `{members,epoch}` |

Membership ban đầu `a,b`; thứ tự đầu vào không ảnh hưởng ring. Mỗi thay đổi tập hợp tăng epoch từ 1; gửi cùng tập hợp không tăng. Epoch chặn ở 1.000.000 (409 nếu tiếp tục đổi), không tăng vô hạn. Restart router đặt lại epoch/membership; epoch chỉ có ý nghĩa trong vòng đời process, không phải fencing token toàn cụm.

Key sau percent-decoding dài 1..64 UTF-16 code units, không có surrogate lẻ. Encode key bằng `encodeURIComponent`; URL segment `.`/`..` có thể bị HTTP client chuẩn hóa trước khi đến server, nên dùng catalogue ID thông thường. Các ký tự control được chấp nhận khi encode; test dùng 64 ký tự U+0001, không chỉ ASCII dễ serialize. Không gửi query để chọn owner hoặc upstream.

JSON control nhận tối đa 8192 byte qua helper chung, kể cả whitespace. Sai JSON/schema/duplicate/member type trả 400; sai content type 415, quá byte 413, sai method 405. Route lạ 404. Không coercion từ object, number hay array thành member. Upstream phải status 200, content type JSON, đúng bốn trường, key/owner khớp request, `hit` boolean, value đúng catalogue v1. Sai contract, redirect, ngắt kết nối hoặc hết deadline đều 502. Không retry và không thử owner kế tiếp.

Upstream body tối đa **640 byte**, đọc stream và chặn trước JSON.parse. Với key hợp lệ, worst-case JSON escaping là 64 × 6 = 384 byte; value 64 hex, owner một ký tự, hit boolean và các tên trường/punctuation vẫn dưới 640. Reply router thêm epoch tối đa bảy chữ số vẫn dưới 640. Reply lỗi chỉ gồm thông báo cố định, không phản chiếu dữ liệu lỗi. Fixture kiểm tra payload maximal hợp lệ 640 byte và cùng schema/identity/value ở 641 byte nhờ whitespace JSON hợp lệ; bỏ gate byte sẽ làm test thất bại. `redirect:'error'` giữ fixed origin ngay cả khi upstream trả 307 tới một origin khác.

## Ring hoạt động thế nào?

```text
client → router (snapshot membership + epoch)
             → owner a hoặc b hoặc c → LRU 32 key → catalogue tính lại
```

`ring.mts` băm `member:index` bằng SHA-256, index 0..15. Mỗi physical node sở hữu 16 virtual token, tối đa 48 token cho ba máy. Băm key trên cùng không gian hex 256-bit; chọn token đầu tiên có vị trí ≥ key theo chiều tăng, hết vòng thì quay về token nhỏ nhất. Token cùng vị trí so member theo thứ tự a/b/c rồi index số tăng; không dùng locale hay thứ tự request để phá hòa. Fixture nhỏ với point `10`, key `ff` minh họa wraparound mà không trông chờ collision SHA-256 tự xảy ra.

Thêm c chỉ chèn token của c: nếu một key đổi owner thì owner mới phải là c. Xóa b chỉ bỏ token của b: key đổi owner phải từng thuộc b. Virtual token là nhiều đoạn trên ring, không phải thêm process/replica. Số 16 chỉ là lựa chọn giảng dạy; không bảo đảm tải bằng nhau. Router xây lại tối đa 48 token trên mỗi lookup để giữ mã nhỏ; production thường lưu mảng đã sort rồi binary-search.

`cache.mts` là Map LRU trong bộ nhớ: mỗi đọc xóa rồi chèn lại, đủ 33 phần tử thì bỏ phần tử lâu không đọc nhất. Cache miss tính lại cùng value; restart node chỉ làm mất cache của node đó. Dù key đã chuyển đi, bản cache cũ có thể còn cho tới eviction/restart; không có vòng quét/migration nền. Test warm-affinity dùng tổng cộng 32 key, đủ nhỏ để tránh nhầm eviction với chuyển owner.

Router snapshot owner/epoch trước await. Đổi ring khi request đang bay không gắn nhầm epoch mới vào reply cũ. Trong hệ nhiều router, membership có thể stale: cùng key có thể nóng trên hai máy. Bài này chỉ có một router và control không đồng bộ membership toàn cụm.

## Đo movement có giới hạn

```bash
node lessons/36-consistent-hashing/sample.mts
```

Mẫu cố định `catalogue-0`..`catalogue-511`, modulo dùng 32 bit đầu SHA-256 rồi `% memberCount` trên danh sách canonical:

```json
{"sample":512,"ringAdd":151,"ringRemove":186,"moduloAdd":339,"moduloRemove":336}
```

`Add` là a,b → a,b,c; `Remove` là a,b,c → a,c. Đây là số key đổi owner trên đúng mẫu này, không phải benchmark throughput, không là tỷ lệ phổ quát hay cam kết cân bằng. Modulo có thể chuyển key giữa hai máy cũ khi thêm máy mới; ring chỉ chuyển vào máy mới. Hot key vẫn dồn request vào một owner dù có nhiều virtual token; kích thước/value hay chi phí tính lại không được mô hình hóa bằng số key.

## Kiểm chứng

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/36-consistent-hashing/test/lesson.test.mts
node --test --test-timeout=15000 --test-name-pattern=integration: lessons/36-consistent-hashing/test/lesson.test.mts
npm run check
make test
```

Unit test kiểm tra hash/token, thứ tự member, tie/wrap, các bất biến chuyển key, giá trị catalogue cố định và LRU/recompute. Import entrypoint chạy trong child với config sai, phải exit 0 và hoàn toàn im lặng. Không có config reads, listener, signal hoặc background work khi import.

Integration test dùng process riêng, port ephemeral, request có deadline và cleanup trong finally. Kiểm tra cold→warm, thêm/xóa node, giữ cache ở owner không đổi, reconstruction value bằng nhau, owner chết trả 502 và không chạm cache máy khác, restart mất đúng cache, control vắng mặt, schema/type/byte/content-type, deadline cả headers và body, redirect sang origin khác không có request đích. Fixture nằm trong test, không thêm behavior giả vào production node. Không dùng file dữ liệu nên không cần scratch directory hay SQLite.

Worker bị cấm network chỉ chạy typecheck/unit; controller chạy integration và toàn bộ check/make test trong Docker riêng. Việc test được viết không có nghĩa integration đã pass.

## Ranh giới và bài tập

Nếu đây là shard có durable writes, tính lại bằng hash không thể khôi phục dữ liệu. Cần một migration protocol riêng: snapshot/copy dữ liệu, chuyển tiếp hoặc ghi kép có version, catch-up log, kiểm tra đầy đủ, cutover có fencing và rollback. Cần giải quyết concurrent writes, routing stale, delete/tombstone và ownership agreement. Consistent hashing tự nó không cung cấp các bước đó.

Thử tắt đúng owner từ `/placement`, quan sát 502 dù hai máy khác sống; bật lại node và so value/hit. Tạo hơn 32 key cùng owner để thấy cold start vì eviction. Thay đổi mẫu key trong một bản thử nghiệm riêng để so sánh độ lệch, không biến một mẫu đẹp thành cam kết. Phác thảo cách chống hot key và tradeoff consistency khi replicate cache. Giải thích vì sao epoch local không đủ cho hai router độc lập.

Nguồn gốc ý tưởng và giới hạn cần phân biệt với hệ đầy đủ: [Amazon Dynamo, SOSP 2007](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) thảo luận consistent hashing, virtual nodes và nhiều cơ chế bổ sung. Bài này chỉ mô hình cache affinity, không triển khai Dynamo.

Playground dùng `CACHE_ID` và `CACHE_A_ORIGIN`/`CACHE_B_ORIGIN`/`CACHE_C_ORIGIN` vì manager chặn nhóm biến `NODE_*` dành cho runtime. Các tên `NODE_ID` và `NODE_A_ORIGIN`/`NODE_B_ORIGIN`/`NODE_C_ORIGIN` vẫn được nhận như alias cho lệnh native cũ; `CACHE_*` được ưu tiên khi có cả hai. Giá trị ưu tiên sai vẫn bị từ chối, không âm thầm chuyển sang alias. Test HTTP kiểm tra cả cấu hình mới và đường cấu hình cũ.
