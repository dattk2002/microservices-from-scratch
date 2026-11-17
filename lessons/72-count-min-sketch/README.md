# 72 — Count-Min Sketch, tần suất xấp xỉ và cộng bản tóm tắt từ các shard

Ta muốn hỏi tần suất của một key trong hai luồng sự kiện mà không chuyển toàn bộ
sự kiện qua mạng mỗi lần đọc. Hai tiến trình nguồn giữ Count-Min Sketch (CMS)
trong SQLite riêng; tiến trình aggregate lấy hai ma trận hiện tại, cộng từng ô,
rồi lấy **minimum của ba ô được key chọn**. Mỗi truy vấn bắt đầu từ dữ liệu vừa
đọc, không cộng dồn vào một cache sống lâu.

Bài này tiếp nối ý tưởng cấu trúc xác suất của Bloom filter: Bloom trả lời khả
năng tồn tại, CMS ước lượng số lượng có trọng số. Có thể chạy bài độc lập; không
cần khởi động các bài trước.

## Chuẩn bị và chạy

Cần Node.js **24.12.0 trở lên, dưới 25**, npm và các development dependencies đã
cài theo lockfile ở root. Runtime chỉ dùng built-in Node: HTTP, crypto, SQLite.
Không có tài khoản, container hay dịch vụ mạng ngoài. Chạy lệnh từ root repo.
SQLite ở Node 24.12 có thể ghi experimental warning khi **khởi động** nguồn;
import các entrypoint không tải SQLite, không đọc cấu hình và không mở listener.

Tạo thư mục dùng riêng cho demo:

```bash
mkdir -m 700 -p /tmp/cms-72-demo
```

Chạy mỗi lệnh trong một terminal riêng. Nếu có dữ liệu cũ, nguồn phục hồi dữ liệu
đó; dùng một thư mục mới để làm lại từ snapshot rỗng.

```bash
HOST=127.0.0.1 PORT=3072 SKETCH_ID=a DB_PATH=/tmp/cms-72-demo/a.db \
  node lessons/72-count-min-sketch/sketch.mts
```

```bash
HOST=127.0.0.1 PORT=3073 SKETCH_ID=b DB_PATH=/tmp/cms-72-demo/b.db \
  node lessons/72-count-min-sketch/sketch.mts
```

```bash
HOST=127.0.0.1 PORT=3272 \
  SOURCE_A_ORIGIN=http://127.0.0.1:3072 SOURCE_B_ORIGIN=http://127.0.0.1:3073 \
  node lessons/72-count-min-sketch/aggregate.mts
```

Readiness là một dòng JSON, ví dụ `{"service":"count-min-a","port":3072}`.
`HOST` chỉ cho phép `127.0.0.1` (mặc định); `PORT=0` nhờ hệ điều hành chọn cổng
và công bố cổng thực trong readiness. PORT mặc định: a=3072, b=3073,
aggregate=3272. `SKETCH_ID` bắt buộc là `a` hoặc `b`; `DB_PATH` bắt buộc là đường
dẫn file, không phải `:memory:`. Mỗi nguồn dùng file riêng, quyền 0600, trong thư
mục riêng; không chạy hai writer dùng chung một DB. SQLite lưu cả identity và từ
chối khởi động với identity khác trước khi listen. WAL/FULL bảo vệ transaction
trong phạm vi bảo đảm của SQLite và hệ thống lưu trữ. SIGINT/SIGTERM đóng HTTP,
sau đó đóng connection DB; không xóa dữ liệu.

`SOURCE_A_ORIGIN` và `SOURCE_B_ORIGIN` bắt buộc là HTTP origin loopback hữu hạn,
không credentials/path/query/fragment. Chúng được chuẩn hóa, phải khác nhau và
khác cổng listener đã cấu hình (nếu PORT khác 0). Origin `http://127.0.0.1:80`
và `http://127.0.0.1/` là một origin, nên không thể làm hai shard. Không có URL
caller truyền vào. Khi dùng PORT=0, đọc readiness các nguồn rồi truyền origin
thực cho aggregate; aggregate cũng có thể dùng PORT=0.

Gửi ba sự kiện tạo ví dụ va chạm có thể tính tay:

```bash
curl -sS -H 'content-type: application/json' -d '{"id":"one","key":"k2","weight":2}' http://127.0.0.1:3072/events
curl -sS -H 'content-type: application/json' -d '{"id":"two","key":"k1","weight":3}' http://127.0.0.1:3072/events
curl -sS -H 'content-type: application/json' -d '{"id":"three","key":"k5","weight":4}' http://127.0.0.1:3073/events
curl -sS http://127.0.0.1:3072/snapshot
curl -sS http://127.0.0.1:3272/estimate/k0
curl -sS http://127.0.0.1:3272/estimate/k2
```

Kết quả hai truy vấn cuối lần lượt là `{"key":"k0","estimate":2,"total":9}`
và `{"key":"k2","estimate":2,"total":9}`. `k0` chưa xuất hiện nhưng vẫn có thể
được ước lượng dương. Gửi lại `one` đúng nội dung trả duplicate, total vẫn là 9.
Đọc lại nhiều lần cũng không làm tăng total.

## Kiến trúc và hợp đồng HTTP

```text
POST /events -> sketch a -> a.db (receipt + version + total + 3x16 cells)
POST /events -> sketch b -> b.db (receipt + version + total + 3x16 cells)
                              ^                        ^
                              | GET /snapshot          | GET /snapshot
                              +-------- aggregate -----+
                                        |
                              cộng từng ô -> min -> GET /estimate/key
```

Hai nguồn biểu diễn **hai luồng logic rời nhau**. Cùng một id xuất hiện ở cả a
và b được tính hai lần có chủ ý. Receipt chỉ khử replay trong một nguồn; muốn
chống trùng giữa các nguồn phải có quy tắc phân vùng/dedup riêng trước khi ghi.

| API | Request / điều kiện | Response |
| --- | --- | --- |
| Nguồn `POST /events` | Chính xác `{id,key,weight}`; id 1–16 ký tự ASCII `[a-z0-9]`, key `k0`…`k31`, weight integer 1…9 | Mới: 201 `{id,duplicate:false}` |
| Cùng API, cùng id và nội dung | So sánh cả key và weight | 200 `{id,duplicate:true}` |
| Cùng API, id đã dùng với nội dung khác | Không sửa receipt hay ma trận | 409 `id_conflict` |
| Cùng API, receipt mới khi đã có 64 receipt | Replay đúng vẫn được 200; conflict vẫn được 409 | 429 `capacity`, không đổi trạng thái |
| Nguồn `GET /snapshot` | Không query string | 200 `{id,version,total,cells}` |
| Aggregate `GET /estimate/{key}` | Key chuẩn, không query string | 200 `{key,estimate,total}` |

Mọi object JSON có đúng các field đã nêu. Không ép kiểu string/number; null,
array, primitive, field thừa, weight âm/0/thập phân, id viết hoa, `k00` và
`k32` đều bị từ chối. Schema request sai trả 400 `invalid_request`; JSON sai trả
400 `invalid_json`, sai media type trả 415 `unsupported_media_type`, request
body quá 8192 byte trả 413 `body_too_large`. Method sai trả 405
`method_not_allowed` và `Allow`; route không có trả 404 `not_found`. Lỗi nội bộ
nguồn trả 500 `internal_error`. Envelope các lỗi có dạng
`{"error":{"code":"id_conflict","message":"id_conflict"}}`: message bằng code.
Snapshot không có thời hạn lưu hay endpoint reset.

`version` là số **receipt được chấp nhận**, 0…64; `total` là tổng **weight**,
0…576; `version <= total <= 9*version`. Snapshot chứa đúng 3 hàng, mỗi hàng
đúng 16 integer 0…576, tổng mỗi hàng bằng total. Với version=0 mọi ô đều bằng 0.
Nguồn đọc toàn bộ snapshot từ một hàng SQLite, nên không trộn cells/total/version
của hai transaction. Ghi receipt, tăng version/total và ba ô trong cùng
`BEGIN IMMEDIATE … COMMIT`; lỗi SQL ở giữa phải rollback toàn bộ.

Aggregate yêu cầu snapshot đầu mang `id=a`, snapshot sau mang `id=b` và kiểm tra
**toàn bộ schema, kích thước, khoảng số và tổng hàng** trước khi dùng. Kết quả
cộng có total tối đa 1152; đây không phải một snapshot nguồn có giới hạn 576.
Không dùng version như sequence chung hay chỉ lấy shard có version lớn hơn.

Mỗi thao tác aggregate có **một ngân sách tổng 500ms**, dùng chung cho hai fetch
song song và toàn bộ response body. Mỗi upstream JSON tối đa **8192 byte trên
wire**, bao gồm whitespace; không tin Content-Length. Bộ đọc xử lý stream,
kiểm tra UTF-8/JSON và hủy khi quá giới hạn. Redirect bị cấm bằng
`redirect:'error'`. Transport error, redirect, hết hạn (kể cả body chưa kết
thúc), body quá lớn, JSON/schema/identity/media type sai và mọi HTTP status khác
200 đều thành **502 `upstream_failure`**. Không có status business từ upstream
được chuyển nguyên trạng, kể cả envelope lỗi trông hợp lệ. Không trả kết quả
một phần, không giữ cache cũ và không retry ngầm.

## Vì sao dùng minimum và cộng ma trận?

Với hàng r=0,1,2, cột của key là:

```text
h_r(key) = SHA256(UTF8(`${r}:${key}`)).readUInt32BE(0) % 16
```

Mỗi sự kiện weight w cộng w vào một ô ở **mỗi** hàng. Truy vấn lấy
`min(C[0][h_0(key)], C[1][h_1(key)], C[2][h_2(key)])`. Tất cả update không âm,
nên ô chứa tần suất thật của key cộng phần nhiễu do key khác va chạm: ước lượng
không thấp hơn tần suất thật. Minimum chọn hàng có ít nhiễu nhất. Cộng ba hàng
sẽ đếm lại một sự kiện ba lần, còn max chọn hàng nhiễu nhiều nhất.

Các giá trị cố định dùng trong test:

| Key | Hàng 0 | Hàng 1 | Hàng 2 |
| --- | --- | --- | --- |
| k0 | 4 | 10 | 15 |
| k1 | 15 | 10 | 7 |
| k2 | 4 | 6 | 7 |
| k5 | 11 | 4 | 15 |

Với stream a={k2:2,k1:3}, b={k5:4}, ba ô cho k0 sau cộng là `[2,3,4]`:
ước lượng 2 dù tần suất thật 0. Với k2, ba ô là `[2,2,5]`: minimum=2,
max=5, sum=9. Nếu lấy riêng minimum ở từng shard rồi cộng, k0 cho 0+0=0;
đó không phải query trên sketch của stream nối. Phải **cộng ma trận trước,
lấy minimum sau**.

Hash/width/depth phải giống nhau ở các shard. Update tuyến tính nên
`CMS(A nối B) = CMS(A) + CMS(B)` theo từng ô. Mỗi lần GET lấy lại a,b hiện tại,
cộng mỗi nguồn **một lần**, rồi bỏ kết quả trung gian. Nếu cứ cộng snapshot vào
ma trận lưu lâu, một receipt đã nằm trong lần pull trước sẽ bị đếm lại.

Snapshot từng nguồn nhất quán, nhưng cặp `(snapshot_a, snapshot_b)` **không là
một global atomic cut**. Hai request có thể quan sát thời điểm khác nhau, nhất
là khi đang ghi. Không hứa hẹn total tại một timestamp chung; nếu cần ranh giới
toàn cục, phải thiết kế epoch/barrier/snapshot protocol riêng.

## Độ chính xác, đánh đổi và giới hạn

Width lớn hơn giảm xác suất/tác động va chạm; depth lớn hơn cho nhiều lựa chọn
hàng để giảm xác suất mọi hàng cùng nhiễu mạnh. Với họ hash độc lập phù hợp
(thường là universal hashing), update không âm, width cỡ `e/epsilon`, depth
cỡ `ln(1/delta)`, lý thuyết CMS cho một query cố định có lỗi cộng không quá
`epsilon * total` với xác suất ít nhất `1-delta`, trên lựa chọn hash ngẫu nhiên.

Bài dùng **hash SHA256 cố định với prefix hàng**, 3x16 rất nhỏ để dễ kiểm tra.
Việc thêm prefix không chứng minh đây là họ independent universal hash. Các test
va chạm và tính không đánh giá thấp là tính chất xác định của ví dụ; chúng
**không chứng minh cận xác suất lý thuyết**. Không diễn giải 3x16 thành một SLA
độ chính xác, nhất là trước input đối kháng.

CMS chỉ lưu bộ đếm, không lưu danh sách key. Nó **không tự liệt kê heavy hitters**;
cần candidate structure hoặc tập key bên ngoài. Vì bài giới hạn chỉ 32 key,
bảng exact 32 bộ đếm còn nhỏ hơn ma trận 48 ô: mục tiêu ở đây là học phép merge
và lỗi xấp xỉ, không tuyên bố tiết kiệm bộ nhớ trên miền demo. Receipt được giữ
nguyên tối đa 64/source để replay có nghĩa rõ ràng; triển khai production cần
chính sách retention/dedup riêng. Chi phí SQLite còn gồm receipt và metadata,
không chỉ 48 counter.

Không có negative update, deletion, counter saturation, conservative update,
sliding window, auto-discovery, quorum hay recovery giữa shard. Trọng số và số
receipt hữu hạn giữ tất cả phép cộng nguyên chính xác, không cần clamp. Thay
hash/dimensions sau khi có dữ liệu đòi hỏi rebuild hoặc versioning format. Bộ
kiểm tra schema bắt lỗi cấu trúc, không xác thực rằng upstream trung thực về
sự kiện; đây là mô hình peer loopback đáng tin, không có authentication.

## Kiểm chứng

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/72-count-min-sketch/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/72-count-min-sketch/test/lesson.test.mts
npm run check
make test
git diff --check
```

Các lệnh có integration cần môi trường cho phép listener loopback; worker không
có network chỉ chạy focused unit, typecheck và toàn bộ unit suite. Controller
chạy HTTP thật trong môi trường cách ly. Unit test không mở listener: golden
hash, ma trận tính tay, các schema sai, replay/conflict/capacity, rollback bằng
SQLite trigger, import im lặng và deadline ngay cả khi cancel bị treo. Injection
fetch ở unit chỉ thay ranh giới HTTP, còn parser, kiểm tra schema, merge và
SQLite vẫn chạy thật.

Integration test spawn tiến trình Node riêng với PORT=0 và temp DB riêng: hai
nguồn + aggregate; read nhiều lần, khởi động lại nguồn, identity sai, cùng id ở
hai stream, HTTP schema/status và giữ receipt sau restart. Bộ peer lỗi riêng
kiểm tra cả hai nhánh nguồn, JSON hợp lệ nhưng wire quá lớn, body chậm, nhiều
chặng trong một deadline, đứt kết nối và redirect sang **origin loopback khác
thật sự reachable**. Test đọc counter đích bằng 0 trước khi đổi mode; chỉ 502
không đủ chứng minh redirect không bị theo. Escape fixture chỉ thay JSON string
token đã decode, không làm hỏng number/null/boolean token. Mỗi thư mục, child
process và DB connection được bảo vệ bằng cleanup ngay trước acquisition kế
tiếp; cả startup failure cũng được dọn. Test HTTP có deadline riêng, không có
polling/background loop vô hạn.

## Bài tập

1. Tìm một key khác có estimate lớn hơn tần suất thật; giải thích hàng nào có
   nhiễu và tại sao minimum vẫn không phải exact count.
2. Giữ seed/họ hash được mô tả rõ, thử width 32/64 và nhiều stream phân bố khác
   nhau; đo sai số nhưng phân biệt bằng chứng thực nghiệm với bảo đảm lý thuyết.
3. Thiết kế candidate tracking để tìm heavy hitters mà không cần duyệt miền key;
   nêu giới hạn false positive/false negative của toàn pipeline.
4. Thiết kế window theo epoch: khi nào được xóa receipt, cách tránh cộng cùng
   shard/epoch hai lần, và cách xác định global cut nếu sản phẩm cần nó.

## Tài liệu gốc

- [Count-Min Sketch — trang thuật toán, tài liệu và bài báo của tác giả](https://sites.google.com/site/countminsketch/).
- [Node.js 24: Crypto — createHash, Hash.update và digest](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
- [Node.js 24: SQLite — DatabaseSync và transaction SQL](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
