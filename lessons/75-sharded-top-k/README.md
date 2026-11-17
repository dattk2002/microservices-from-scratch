# 75 — Top-k qua nhiều shard, thứ tự toàn phần và vector snapshot bất biến

Một bảng xếp hạng được chia thành hai shard sở hữu dữ liệu riêng. Dịch vụ query
đọc đúng hai phiên bản đã công bố, lấy top K **ở mỗi shard**, rồi trộn thành top K
chung. Kết quả hoặc đầy đủ cả hai shard, hoặc thất bại; không trả bảng xếp hạng
thiếu một nửa mà vẫn báo thành công.

## Chuẩn bị và chạy

Cần Node.js **24.12.0 trở lên, dưới 25**, npm và các gói phát triển đã ghim ở gốc
repository (`npm ci` nếu chưa cài). Runtime chỉ dùng built-in của Node, gồm
`node:sqlite` đang thử nghiệm; cảnh báo SQLite lúc chạy shard là bình thường.
Kiến thức nền: HTTP/JSON, sorting, transaction SQLite, process độc lập và deadline.
Mọi lệnh dưới chạy tại gốc repository, trên shell POSIX. Không cần Docker, cloud,
credential hay dịch vụ ngoài để chạy native.

Mở ba terminal; mỗi shard dùng **một file SQLite riêng**, không chia sẻ file:

```bash
mkdir -p /tmp/top-k-75-a /tmp/top-k-75-b
SHARD_ID=a DB_PATH=/tmp/top-k-75-a/state.db HOST=127.0.0.1 PORT=8075 \
  node lessons/75-sharded-top-k/shard.mts
```

```bash
SHARD_ID=b DB_PATH=/tmp/top-k-75-b/state.db HOST=127.0.0.1 PORT=8076 \
  node lessons/75-sharded-top-k/shard.mts
```

```bash
SHARD_A_ORIGIN=http://127.0.0.1:8075 SHARD_B_ORIGIN=http://127.0.0.1:8076 \
  HOST=127.0.0.1 PORT=8077 node lessons/75-sharded-top-k/query.mts
```

`HOST` chỉ nhận `127.0.0.1` (mặc định). `PORT=0` chọn cổng ephemeral; readiness là
một dòng JSON `{ "service": "...", "port": 12345 }` trên stdout. Khi không đặt
PORT, shard mặc định 3075, query 3175; hai shard phải đặt cổng khác nhau hoặc dùng
0. `SHARD_ID=a|b` và `DB_PATH` bắt buộc với shard; hai biến origin bắt buộc với
query. Origin phải là HTTP loopback `127.0.0.1`, không user/password, path khác
`/`, query hay fragment; query chuẩn hóa origin và từ chối hai origin trùng nhau
kể cả khác dấu `/` cuối hoặc cách viết cổng mặc định. Không nhận URL từ caller.
Query cũng từ chối origin trỏ vào chính cổng cố định của nó.

SQLite lưu identity shard; mở lại file a bằng `SHARD_ID=b` sẽ thoát **trước khi
listen**. Cả hai entrypoint đều inert khi import, kể cả environment sai. Chỉ
`main()` của shard mới dynamic-import SQLite, nên import không phát cảnh báo
SQLite trên Node 24.12. Dừng bằng Ctrl-C/SIGTERM; lần chạy sau dùng lại đúng file.
File dưới `/tmp` chỉ phục vụ demo, không bảo đảm tồn tại qua reboot của máy.

## Thử bảng xếp hạng và phiên bản

```bash
curl -sS -X PUT http://127.0.0.1:8075/items/a0 \
  -H 'content-type: application/json' -d '{"score":100}'
curl -sS -X PUT http://127.0.0.1:8075/items/a1 \
  -H 'content-type: application/json' -d '{"score":99}'
curl -sS -X PUT http://127.0.0.1:8075/items/a2 \
  -H 'content-type: application/json' -d '{"score":98}'
curl -sS -X PUT http://127.0.0.1:8076/items/b0 \
  -H 'content-type: application/json' -d '{"score":97}'
curl -sS -X POST http://127.0.0.1:8075/publish \
  -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8076/publish \
  -H 'content-type: application/json' -d '{}'
curl -sS 'http://127.0.0.1:8077/top?k=3&a=3&b=1'
```

Trên hai database mới, phản hồi cuối là:

```json
{"snapshots":{"a":3,"b":1},"items":[{"id":"a0","score":100},{"id":"a1","score":99},{"id":"a2","score":98}]}
```

Toàn bộ top 3 nằm ở a. Nếu chỉ xin `ceil(3/2)=2` item mỗi shard, query làm mất a2
và đưa b0 vào sai vị trí. Tiếp tục hạ điểm live của a0:

```bash
curl -sS -X PUT http://127.0.0.1:8075/items/a0 \
  -H 'content-type: application/json' -d '{"score":0}'
curl -sS 'http://127.0.0.1:8077/top?k=3&a=3&b=1'
curl -sS -X POST http://127.0.0.1:8075/publish \
  -H 'content-type: application/json' -d '{}'
curl -sS 'http://127.0.0.1:8077/top?k=3&a=4&b=1'
```

Vector `(a=3,b=1)` vẫn trả kết quả cũ. Vector mới `(a=4,b=1)` trả a1, a2, b0.
Đọc revision 4 **trước** khi publish là lỗi, không tự rơi về live hoặc revision
khác. Khởi động lại shard với cùng file vẫn đọc được cả snapshot cũ lẫn mới.

## Hợp đồng HTTP

Body JSON phải đúng tập field, đúng primitive type; không nhận null, array,
primitive thay object, field thừa hay ép kiểu chuỗi thành số. Các lỗi được nhận
biết có dạng `{"error":{"code":"...","message":"..."}}`, với `message=code`.

| Dịch vụ / route | Request hợp lệ | Thành công | Lỗi nghiệp vụ |
| --- | --- | --- | --- |
| Shard `PUT /items/{id}` | `{ "score": N }`, N nguyên 0..100; a sở hữu a0..a7, b sở hữu b0..b7; không query | 200 `{ "revision": R }` | 409 `revision_exhausted` nếu thay đổi thực sau revision 16 |
| Shard `POST /publish` | Chính xác `{}`, không query | 200 `{ "revision": R }` | 429 `snapshot_capacity` nếu cần snapshot mới khi đã giữ 4 |
| Shard `GET /snapshots/{R}/top?k=K` | R 0..16, K 1..8; chỉ một key k | 200 `{ "shard":"a", "revision":R, "items":[{"id":"a0","score":100}] }` | 404 `unknown_snapshot` nếu R chưa publish |
| Query `GET /top?k=K&a=A&b=B` | Chính xác một k, a, b; K 1..8, A/B 0..16 | 200 `{ "snapshots":{"a":A,"b":B}, "items":[...] }` | 502 `upstream_failure` nếu bất kỳ shard nào thất bại |

Các số trên path/query phải là chữ số thập phân canonical: `0`, `1`, `16`;
`00`, `+1`, `1.0`, `1e0`, số âm, thiếu key, key lặp/thừa đều 400
`invalid_request`. Key có thể đổi thứ tự. Sai method là 405
`method_not_allowed`; route không tồn tại là 404 `not_found`. Body JSON hỏng là
400 `invalid_json`; sai content-type là 415 `unsupported_media_type`; body
request vượt 8192 byte là 413 `body_too_large`.

Live ban đầu rỗng, revision 0, **snapshot 0 rỗng được tự publish và chiếm một
trong bốn slot**. Thêm ID mới, kể cả score 0, là thay đổi. PUT cùng giá trị không
tăng revision, vẫn thành công ở revision 16. Publish cùng live revision luôn
idempotent, kể cả khi đủ slot. Không có xóa snapshot, xóa item hoặc reset revision.
GET chỉ nhìn snapshot đã publish. Item luôn xếp `score DESC, id ASC`; tie dùng
so sánh ID ASCII, không phụ thuộc locale. Shard rỗng trả mảng rỗng.

## Kiến trúc và tính đúng

```text
                              GET exact A, local top K
                          +----------------------------> shard a -> a.db
caller -> query /top -----+
                          +----------------------------> shard b -> b.db
                              GET exact B, local top K
                     validate -> merge -> take K
```

Đây là scatter/gather: fanout song song tới hai đích cấu hình cố định, gather đầy
đủ rồi trả một bảng xếp hạng. Không khởi tạo listener ở module scope.

**Vì sao local K đủ?** Xét item x ngoài top K của shard sở hữu nó. Trong cùng
snapshot shard đó, ít nhất K item đứng trước x theo **cùng một thứ tự toàn phần**.
Những item này cũng đứng trước x trong hợp của mọi shard; x không thể vào top K
chung. Do đó có thể bỏ toàn bộ phần đuôi từng shard, hợp các local top K rồi lấy
K đầu. ID duy nhất toàn hệ thống nhờ ownership a/b tách biệt; tie-breaker làm
định nghĩa “đứng trước” nhất quán. Không được thay K bằng K/chỉ số shard.

Đây là xếp hạng **item**, không phải phép cộng điểm theo key xuất hiện ở nhiều
shard. Nếu một key có score 40 ở a và 40 ở b, tổng 80 có thể vượt item 70 dù key
đó không xuất hiện trong local top K nào. Bài toán aggregate theo key cần thuật
toán khác, ví dụ thu thập đủ đóng góp trước khi xếp hạng hoặc bound/threshold
chứng minh được; thuật toán này không hỗ trợ ownership trùng nhau.

`ShardStore` lưu một hàng JSON có identity, live revision/items và toàn bộ
snapshot trong SQLite. Mỗi thay đổi dùng `BEGIN IMMEDIATE` / COMMIT, rollback
khi bị từ chối. Revision và payload không thể commit riêng lẻ. Publication sao
chép dữ liệu, không tham chiếu lại live map; read cũng đọc lại dữ liệu đã commit.
WAL + `synchronous=FULL` hỗ trợ durability trong giới hạn bảo đảm filesystem và
SQLite. Dung lượng nhỏ hữu hạn giúp một hàng phù hợp cho bài học; không phải
thiết kế lưu hàng triệu item trong một JSON blob.

Vector `{a:A,b:B}` là **hai snapshot được publish độc lập**. A và B không phải
hai phần của một distributed transaction, không chứng minh cùng thời điểm hay
một global consistent cut. Query xác định được dữ liệu đang đọc và lặp lại cùng
kết quả nếu cả hai shard vẫn phục vụ; nó không cung cấp global atomic snapshot.
Không có coordinator publish chung, quorum hay consensus trong bài này.

## Failure và giới hạn tài nguyên

- Mỗi query có **một deadline tổng 500 ms**, bắt đầu trước fanout và gồm cả đọc
  hết hai response body. Không cấp thêm 500 ms cho shard thứ hai hoặc body.
  Kết thúc thành công/thất bại đều abort công việc còn lại và hủy body reader.
- Fetch dùng `redirect: 'error'`. Không chuyển request qua Location. HTTP test
  dùng một sink process tại origin loopback ephemeral khác, đọc counter bằng 0
  **trước** mọi thao tác đổi mode fixture sau redirect.
- Mỗi body upstream tối đa **8192 byte**, kiểm tra theo chunk, kể cả không có
  Content-Length. Chỉ nhận `application/json`, JSON/UTF-8 hợp lệ, object đúng
  field, shard/revision đúng yêu cầu, ID đúng ownership, không trùng, điểm đúng
  miền, số item không quá K và thứ tự toàn phần đúng.
- Unknown snapshot, error envelope bất ngờ, status 409/422/429/503, schema sai,
  malformed/oversize body, transport/disconnect, redirect hay timeout đều thành
  **502 `upstream_failure`**. Bài này không preserve status của shard; timeout
  cũng là 502. Không trả snapshot khác hoặc partial ranking để che lỗi.
- Giới hạn 8 ID/shard, 16 revision và 4 snapshot (kể cả 0) là ngân sách cố ý để
  failure/capacity thấy được. Không có retry, vòng nền, discovery, xóa snapshot,
  auth, cache hay cân bằng tải. Mạng local không đại diện latency production.

Với S shard, payload mạng là O(S*K) item. Bản triển khai dễ đọc này sort hợp tối
đa S*K item, chi phí CPU O(S*K*log(S*K)), bộ nhớ O(S*K). Trong mỗi shard, sort tập
nhỏ rồi slice; hệ thống lớn cần index phù hợp. Fanout song song giảm critical
path nhưng availability chung giảm khi yêu cầu mọi shard đều thành công. K-way
heap merge có thể giảm CPU khi S lớn mà giữ nguyên chứng minh local K.

## Kiểm chứng

```bash
node --test --test-isolation=none --test-name-pattern=unit: \
  lessons/75-sharded-top-k/test/lesson.test.mts
npm run typecheck
npm run test:unit
# Chạy ở môi trường được phép mở listener:
node --test --test-timeout=15000 lessons/75-sharded-top-k/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit bao gồm phản ví dụ top 3 cùng shard (đã quan sát assertion RED trước khi
triển khai), property fixtures 64 seed với K=1..8 so với sort hợp đầy đủ, tie,
empty, schema, capacity, no-op ở 16, import-silence và stalled-body cancellation.
Fixture oversize vẫn parse được và có schema đúng: chỉ thêm whitespace JSON hợp
lệ. Fixture escaped biến đổi **token string đã decode rồi encode lại**, không
làm hỏng number/boolean/null. Nó là response hợp lệ phải đọc được trong byte
budget, không phải một lỗi JSON giả làm lỗi kích thước.

Integration tạo process Node độc lập trên cổng ephemeral và temporary directory,
bảo vệ cleanup cả khi startup thất bại. Có kiểm thử ba dịch vụ thật, vector cũ
và mới, restart/identity mismatch, source chết, schema công khai và fixture đối
kháng trên cả hai nhánh. Mỗi acquisition nằm trong scope cleanup trước khi lấy
tài nguyên tiếp theo; stop mọi process trước khi xóa directory. Fixture chỉ dùng
cho test, không có teaching control trong dịch vụ thật.

Worker giới hạn mạng chỉ chạy unit và typecheck; HTTP, `npm run check` và
`make test` cần được outer controller chạy và xác nhận. Không suy ra HTTP pass
từ unit pass.

## Bài tập

1. Tự tạo phản ví dụ top 8 cùng một shard và tie giữa a7/b0; giải thích vì sao
   so sánh điểm đơn thuần chưa định nghĩa top K ổn định.
2. Thay phép sort hợp bằng heap merge, giữ nguyên property tests. Chứng minh
   việc dừng sau K lần pop không bỏ sót item.
3. Thiết kế retention có xóa snapshot: caller giữ vector lâu sẽ gặp điều gì?
   Đề xuất lease/pin hữu hạn và mô tả capacity khi có reader chậm.
4. Muốn global snapshot thật, cần thêm giao thức hoặc ràng buộc gì? Phân biệt
   nhất quán từng shard, thứ tự publish và atomicity toàn hệ thống.
5. Cho phép một key có mặt nhiều shard và cộng điểm: đưa ra dữ liệu mà local
   top K sai rồi mô tả thông tin bổ sung cần thiết để đảm bảo đúng.

## Nguồn chính

- PostgreSQL — [LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html):
  vì sao LIMIT cần thứ tự dự đoán được; bài học dùng thêm ID làm tie-breaker.
- SQLite — [Isolation In SQLite](https://www.sqlite.org/isolation.html): transaction,
  isolation và hành vi reader/writer với WAL. Atomicity SQLite chỉ bao phủ một
  database, không tự biến hai file của hai process thành transaction phân tán.

Cấu hình service từ chối `DB_PATH=:memory:` trước khi import SQLite: dữ liệu và snapshot phải nằm trong file riêng để sống qua restart. Store trong unit test vẫn có thể dùng SQLite in-memory. Origin của listener cũng được chuẩn hóa bằng URL trước khi so sánh, kể cả alias cổng mặc định `:80`, để không bỏ sót cấu hình query trỏ vào chính listener.
