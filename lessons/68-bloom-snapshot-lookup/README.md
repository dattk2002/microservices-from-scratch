# 68 — Bloom filter, false positive và negative lookup trên snapshot bất biến

Bloom filter tiết kiệm một lần đọc khi chắc chắn khóa **không thuộc snapshot được hỏi**. Hai bit có mặt chỉ cho biết “có thể có”: lookup vẫn phải hỏi catalog. Bài này dùng snapshot bất biến để một filter cũ không che khuất khóa mới của một phiên bản khác.

## Điều kiện và lệnh chạy

Cần Node.js **24.12+**, npm, chạy từ thư mục gốc repository. Runtime chỉ dùng Node built-ins (`node:crypto`, `node:sqlite`, HTTP, fetch). Các development packages đã được ghim tại root; không cài package cho riêng bài.

Terminal 1 (giữ nguyên identity khi mở lại cùng DB):

```sh
HOST=127.0.0.1 PORT=3068 DB_PATH=/tmp/bloom-68-catalog.db CATALOG_ID=demo TEACHING_CONTROLS=1 node lessons/68-bloom-snapshot-lookup/catalog.mts
```

Terminal 2:

```sh
HOST=127.0.0.1 PORT=3168 CATALOG_ORIGIN=http://127.0.0.1:3068 node lessons/68-bloom-snapshot-lookup/lookup.mts
```

`HOST` chỉ nhận `127.0.0.1`; lookup từ chối startup nếu cổng cố định trùng catalog origin đã chuẩn hóa. `PORT=0` chọn cổng ephemeral; mỗi service in một dòng readiness JSON `{service,port}` sau khi listen. Đọc cổng đó rồi đặt `CATALOG_ORIGIN` lúc khởi động lookup. Không có listener lúc import, polling nền hay tự publish. Dừng bằng SIGTERM/Ctrl-C. Catalog đóng SQLite sau khi HTTP server đóng; mở lại với cùng `DB_PATH`/`CATALOG_ID` giữ cả live state lẫn snapshot. Sai identity làm startup thất bại trước listen. Lookup không có DB; không dùng chung file DB với service khác.

Ví dụ gốc, thực thi từng bước:

```sh
curl -sS -X PUT http://127.0.0.1:3068/items/k1 -H 'content-type: application/json' -d '{"value":"A"}'
curl -sS -X POST http://127.0.0.1:3068/publish -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:3068/filter/1
curl -sS http://127.0.0.1:3168/lookup/1/k0
curl -sS http://127.0.0.1:3168/lookup/1/k2
curl -sS http://127.0.0.1:3068/stats
curl -sS -X PUT http://127.0.0.1:3068/items/k0 -H 'content-type: application/json' -d '{"value":"B"}'
curl -sS http://127.0.0.1:3168/lookup/1/k0
curl -sS -X POST http://127.0.0.1:3068/publish -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:3168/lookup/2/k0
```

Sau publish đầu: `bits="00000900"`. `k0` thiếu bit nên 404 từ `source:"filter"`; `items` không tăng. `k2` và `k1` cùng vị trí `[11,8]`; `k2` cho false positive, bắt buộc đọc item rồi 404 `source:"catalog"`. Thêm `k0` vào live tạo revision 2 nhưng snapshot 1 vẫn trả negative đúng với nội dung cũ. Chỉ publish 2 mới khiến `/lookup/2/k0` trả `B`. Không tự đổi revision khi snapshot chưa tồn tại.

## Kiến trúc và tính đúng

```text
caller → lookup (không lưu negative cache)
           │ GET /filter/r
           ├─ thiếu một bit → 404 source=filter (không đọc item)
           └─ đủ hai bit → GET /snapshots/r/items/key → 200 hoặc 404 source=catalog
                              │
                       catalog / SQLite riêng
                       live + tối đa 4 snapshot bất biến
```

SQLite lưu một state row có giới hạn; `BEGIN IMMEDIATE` bảo vệ read-modify-write, revision và bản sao dictionary/filter trong cùng transaction. Khi publish lỗi capacity, rollback giữ nguyên state. Publish cùng revision là no-op, kể cả khi đủ 4 snapshot. Không xóa snapshot. Read không fallback về live. DB không phải API dùng chung giữa hai process; lookup chỉ dùng HTTP.

SHA256 của UTF-8 key tạo hai vị trí `readUInt32BE(0)%32`, `readUInt32BE(4)%32`. Bit 0 là bit thấp nhất của uint32; OR được chuyển unsigned trước khi in 8 chữ số hex thường. Golden vectors: `k0 → [26,14]`, `k1 → [11,8]`, `k2 → [11,8]`. Test thuật toán thêm `probe14 → [23,31]` để kiểm tra bit dấu của JavaScript; HTTP chỉ nhận miền `k0..k31`.

Bloom chuẩn không có false negative cho tập đã chèn: mọi bit cần cho từng phần tử đều đã bật. Nếu lấy filter revision 1 rồi dùng nó để quyết định về live revision 2, một khóa vừa thêm có thể bị loại nhầm — sai ở hợp đồng phiên bản, không phải xác suất của Bloom. Ở đây filter và item luôn cùng `r`; snapshot không đổi trong lúc fetch hai bước. Không suy luận filter chứng minh có mặt, và cũng không chứng minh một upstream độc hại trả filter trung thực: catalog là authority được tin cậy về nội dung; lookup kiểm tra wire schema/identity.

## HTTP contract

Chỉ chấp nhận đường dẫn canonical: revision nguyên `0..16`, không số 0 dẫn đầu; key `k0..k31`. Không nhận query parameters. Body JSON tối đa 8192 byte, `application/json`; object phải đúng trường, không arrays/null/primitives/extra fields. Value dài 1..32 **chữ cái ASCII**, không số hoặc khoảng trắng. Không ép kiểu object thành string.

| Catalog route | Kết quả |
| --- | --- |
| `PUT /items/{key}` body `{value}` | 200 `{revision}`; thay đổi thật tăng 1, cùng value no-op; mutation sau 16 trả 409 `revision_exhausted` |
| `POST /publish` body `{}` | 200 `{revision}`; chụp đúng live; snapshot thứ 5 khác revision trả 429 `snapshot_capacity` |
| `GET /filter/{r}` | 200 `{revision,m:32,k:2,bits}`; snapshot không tồn tại: 404 `unknown_snapshot` |
| `GET /snapshots/{r}/items/{key}` | 200 `{revision,key,value}`; thiếu key: 404 `absent`; snapshot không tồn tại: 404 `unknown_snapshot` |
| `GET /state` | 200 `{identity,revision,keys,published:[{revision,count,bits}]}`; metadata hữu hạn, không trả toàn bộ values |
| `GET /stats` | 200 `{filters,items}` chỉ khi `TEACHING_CONTROLS=1`; mặc định 404; counters không durable |

Error semantic catalog có đúng `{error:{code,message}}`, `message` bằng chính `code`. `/stats` đếm request vào filter/item, gồm cả semantic 404. Route lạ 404 `not_found`, sai method 405 với `Allow`, schema/path sai 400 `invalid_request`; JSON lỗi 400 `invalid_json`, body quá lớn 413, sai media type 415.

| Lookup `GET /lookup/{r}/{key}` | Body |
| --- | --- |
| 200, xác nhận tồn tại | `{revision,key,source:"catalog",value}` |
| 404, thiếu bit | `{revision,key,source:"filter",value:null}` |
| 404, catalog xác nhận absent | `{revision,key,source:"catalog",value:null}` |
| 404, upstream xác nhận snapshot không tồn tại | `{error:{code:"unknown_snapshot",message:"unknown_snapshot"}}` |
| 502, mọi upstream failure khác | `{error:{code:"upstream_failure",message:"upstream_failure"}}` |

Upstream 404 chỉ được giữ nghĩa sau khi body được đọc hết, kiểm tra giới hạn và đúng envelope/code/message. `absent` chỉ có nghĩa ở bước item; 404 primitive, `internal_error`, sai fields hoặc sai message đều thành 502. Các status 409/422/429/503 cũng thành 502. Không retry hoặc cache một reply không chắc chắn.

Một deadline **500 ms tổng cộng** bao gồm filter, item, headers và toàn bộ hai body; không cấp lại ngân sách cho bước item. Fetch dùng `redirect:"error"`, abort khi hết hạn; timeout cũng là 502. Mỗi upstream JSON bị giới hạn 8192 byte trên wire trước decode (kể cả whitespace/escape), UTF-8 strict và media type JSON. Revision/key phản hồi phải đúng request; filter phải có đúng `m=32,k=2` và 8 lowercase hex. `CATALOG_ORIGIN` cố định lúc startup, chỉ HTTP loopback `127.0.0.1` với cổng riêng; caller không truyền URL. Redirect không được theo tới origin khác.

## Kiểm tra và giới hạn

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/68-bloom-snapshot-lookup/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/68-bloom-snapshot-lookup/test/lesson.test.mts
npm run check
make test
git diff --check
```

Hai lệnh đầu nhóm unit không mở socket. Integration test tự tạo temp SQLite dưới `node:os.tmpdir()`, spawn các service độc lập với cổng ephemeral, đợi readiness thay vì sleep, luôn đóng process/xóa temp kể cả startup lỗi. Chúng kiểm tra bypass bằng counter thực, collision, live/snapshot tách biệt, restart, identity mismatch, no-op và capacity rollback. Fixture local có mode lỗi cho cả filter/item; một sink reachable có cổng riêng chứng minh redirect destination nhận **0** request trước khi mode đổi. Các trường hợp oversized JSON vẫn đúng schema nếu bỏ phần whitespace; escaped fixture chỉ mã hóa token string, giữ nguyên số/bool/null. Test deadline gồm chain 300+300 ms và body treo sau headers. Không dùng dịch vụ bên ngoài.

Worker không có network chỉ chạy unit/typecheck. HTTP integration, `npm run check` và `make test` cần môi trường loopback được outer controller cho phép; không suy luận chúng pass từ kết quả unit.

Giới hạn bài học: một catalog process, một SQLite file, 32 khóa, tối đa 16 mutation, 4 snapshot không pruning, không delete/auth/replication. Bộ lọc chỉ 4 byte nhưng JSON/HTTP overhead lớn hơn; đây là ví dụ tính đúng, không benchmark production. Giữ 4 bản dictionary tốn nhiều hơn 4 filter; không nên coi Bloom là storage authority. State/counter là teaching endpoint, không phải public production API.

Với giả định hash độc lập, xác suất false positive gần đúng `(1-exp(-kn/m))^k`, ở đây `m=32,k=2`. Khi `n=1` khoảng 0,37%; khi `n=16` khoảng 40%. Miền 32 key hữu hạn và hai lát SHA256 cố định khiến tần suất thực có thể khác nhiều (collision `k1/k2` là ví dụ). Tăng `m` giảm xác suất nhưng tốn bộ nhớ; số hash gần tối ưu là `(m/n) ln 2`. Filter bão hòa vẫn đúng nhưng mất lợi ích bỏ qua lookup. Không được xóa một key bằng cách clear hai bit: khóa khác có thể dùng chung bit, tạo false negative. Muốn xóa, xây filter mới từ tập snapshot mới hoặc học counting Bloom với hợp đồng khác.

## Bài tập

1. Đếm toàn bộ false positive trong miền `k0..k31` cho tập `{k1}`, so sánh với ước lượng xác suất và giải thích khác biệt.
2. Thiết kế format mới `m=128,k=3` có version riêng; mô tả cách tránh reader cũ hiểu nhầm filter.
3. Nếu thêm pruning, chứng minh điều gì xảy ra giữa fetch filter và item; đề xuất snapshot lease hoặc explicit gone contract, không fallback live.
4. Thêm delete vào live nhưng chỉ rebuild filter khi publish; viết test hai key chung bit trước khi triển khai.

Nguồn chính: [Broder & Mitzenmacher — Network Applications of Bloom Filters](https://www.eecs.harvard.edu/~michaelm/postscripts/im2005b.pdf), [Node.js v24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html). Tham khảo thêm [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html). Diễn giải và code trong bài là ví dụ tự xây dựng.
