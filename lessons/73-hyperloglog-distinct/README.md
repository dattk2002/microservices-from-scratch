# 73 — HyperLogLog: distinct gần đúng và hợp nhất bằng register max

Một người dùng xuất hiện ở hai service sẽ bị đếm hai lần nếu cộng hai số distinct cục bộ. Bài này cho hai nguồn giữ **sketch**, rồi một service khác hợp nhất sketch để ước lượng số giá trị khác nhau trong hợp của chúng. Không lưu danh sách giá trị đã gặp, bộ đếm distinct thật hay receipt log để loại trùng.

## Chuẩn bị và chạy

Cần Node.js **24.12.0 trở lên trong nhánh 24**, npm và các development package đã ghim ở root repository (`npm ci` khi chuẩn bị môi trường). Runtime chỉ dùng built-in Node: HTTP, SHA-256 và SQLite. Node chạy trực tiếp `.mts`; không cần transpile, Docker, tài khoản hoặc dịch vụ đám mây để chạy ví dụ native. Một số bản Node 24 in cảnh báo SQLite experimental khi **khởi động nguồn**; import entrypoint không tải runtime SQLite và không in gì.

Chạy mọi lệnh bên dưới từ root repository. Tạo một thư mục riêng cho phiên demo:

```bash
RUN_DIR=$(mktemp -d /tmp/hll-73-demo.XXXXXX)
echo "$RUN_DIR"
```

Trong ba terminal, đặt `RUN_DIR` về cùng đường dẫn vừa in. Mỗi nguồn sở hữu một file DB riêng. Khởi động lần lượt:

```bash
# Terminal A
HOST=127.0.0.1 PORT=7301 SKETCH_ID=a DB_PATH="$RUN_DIR/a.db" \
  node lessons/73-hyperloglog-distinct/hll.mts

# Terminal B
HOST=127.0.0.1 PORT=7302 SKETCH_ID=b DB_PATH="$RUN_DIR/b.db" \
  node lessons/73-hyperloglog-distinct/hll.mts

# Terminal aggregate
HOST=127.0.0.1 PORT=7373 \
SOURCE_A_ORIGIN=http://127.0.0.1:7301 \
SOURCE_B_ORIGIN=http://127.0.0.1:7302 \
  node lessons/73-hyperloglog-distinct/aggregate.mts
```

Mỗi tiến trình in một dòng readiness JSON, ví dụ `{"service":"hll-source","port":7301}`. Có thể dùng `PORT=0` để OS chọn cổng trống rồi lấy `port` từ dòng này; đặt hai origin của aggregate theo cổng thật. Chỉ `HOST=127.0.0.1` được chấp nhận. Default port: source `7301`, aggregate `7373`. `SKETCH_ID` và `DB_PATH` bắt buộc; tiến trình HTTP không chấp nhận `:memory:`. Hai nguồn không được dùng chung DB.

```bash
curl -sS http://127.0.0.1:7373/estimate
# {"registers":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"estimate":0}

curl -sS -H 'content-type: application/json' \
  -d '{"value":"v0"}' http://127.0.0.1:7301/values
curl -sS -H 'content-type: application/json' \
  -d '{"value":"v1"}' http://127.0.0.1:7301/values
curl -sS -H 'content-type: application/json' \
  -d '{"value":"v1"}' http://127.0.0.1:7302/values
curl -sS http://127.0.0.1:7373/estimate
# registers = [3,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]
# estimate = 2.136502281992361 (không phải cardinality chính xác)
```

Dừng A, chạy lại cùng `DB_PATH` và `SKETCH_ID`, rồi POST lại `v0`: kết quả là `{"changed":false}`, sketch không đổi. Nếu dùng `PORT=0`, cập nhật origin rồi khởi động lại aggregate khi cổng nguồn thay đổi. Dừng cả ba tiến trình trước khi tự xóa thư mục demo.

## Ranh giới và hợp đồng

```text
client --POST /values--> nguồn a -- SQLite a.db
client --POST /values--> nguồn b -- SQLite b.db
client --GET /estimate--> aggregate
                           |--GET /snapshot--> nguồn a
                           `--GET /snapshot--> nguồn b
                               max từng register -> ước lượng một lần
```

`hll.mts` chỉ đọc/ghi DB của chính nó; `aggregate.mts` không có DB, không chuyển tiếp ghi và không nhận URL từ caller. `protocol.mts` chứa thuật toán/schema; `store.mts` sở hữu giao dịch SQLite. Các module không mở listener khi import; SQLite chỉ được dynamic import trong đường khởi động `main()` qua `Sketch.open()`.

| Endpoint | Input | Thành công |
| --- | --- | --- |
| Source `POST /values` | JSON đúng một field `{"value":"v0"}`; string canonical `v0`…`v255` | `200 {"changed":boolean}` |
| Source `GET /snapshot` | Không query | `200 {"id":"a" hoặc "b","algorithm":"hll-sha256-32-p4-v1","registers":[…]}` |
| Aggregate `GET /estimate` | Không query | `200 {"registers":[…],"estimate":number}` |

`changed` nghĩa là một register **tăng**, không chứng minh giá trị mới hay cũ: một giá trị chưa từng gặp vẫn có thể không làm tăng register. Lặp lại cùng giá trị luôn không làm tăng sketch, kể cả sau restart. Không có API xóa hoặc reset.

JSON object phải có đúng các field quy định. Không nhận array, null, primitive thay object, giá trị không phải string, extra field, `v01`, `v256`, dấu cách hay newline. Snapshot cần đúng 16 số nguyên từ 0 đến 29, đúng identity theo vị trí nguồn, đúng algorithm. Không ép kiểu trước khi kiểm tra; `{ "value": {"toString":null} }` trả 400.

Mọi lỗi trả `{"error":{"code":"…","message":"…"}}`, với `message` bằng `code`:

| Status | Code | Ý nghĩa |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json` | Schema/query hoặc cú pháp JSON không hợp lệ |
| 404 | `not_found` | Route không tồn tại, kể cả trailing slash |
| 405 | `method_not_allowed` | Sai method; response có `Allow` |
| 413 / 415 | `body_too_large` / `unsupported_media_type` | Request vượt 8192 byte / không phải `application/json` |
| 502 | `upstream_failure` | Aggregate không có đủ hai snapshot đáng tin trong deadline |
| 500 | `internal_error` | Lỗi nội bộ ngoài hợp đồng nghiệp vụ, ví dụ lỗi DB lúc xử lý |

Không forward 404, 409, 422, 429 hoặc 503 của nguồn thành kết quả nghiệp vụ. Aggregate chỉ dùng status 200 **và** snapshot hợp lệ. Error envelope có vẻ đúng cấu trúc cũng không phải snapshot.

## Thuật toán cố định

Tên `hll-sha256-32-p4-v1` là hợp đồng wire và disk. Hai sketch chỉ merge được nếu dùng cùng mapping, miền giá trị, số register và cách tính rank.

1. SHA-256 của UTF-8 `value`, lấy `readUInt32BE(0)` không dấu: 32 bit đầu.
2. **4 bit cao** chọn index 0…15. Với 28 bit thấp, rank bằng số zero đầu tiên cộng 1; toàn zero có rank **29**. Ví dụ `v0` bắt đầu bằng hex `0270da4d`, cho index 0/rank 3; `v42` bắt đầu `aafa8c00`, cho index 10/rank 1. Không dùng signed shift để chọn index.
3. `register[index] = max(register[index], rank)`. Mười lăm register còn lại giữ nguyên. Ban đầu cả 16 đều là 0.
4. Hợp nhất `M[i] = max(A[i], B[i])`. Phép max giao hoán, kết hợp, lũy đẳng. Vì mỗi giá trị chọn cùng index/rank ở mọi nơi, replay toàn bộ input của A và B cho cùng register như merge hai sketch. Cộng estimate hoặc cộng register làm mất tính chất này.

Ước lượng từ sketch đã merge:

```text
m = 16
raw = 0.673 * 16 * 16 / sum(2 ** (-M[i]))
V = số register bằng 0
estimate = 16 * ln(16 / V)   nếu raw <= 40 và V > 0
estimate = raw              trong các trường hợp khác
```

Sketch rỗng cho 0 nhờ small-range correction. Kết quả hữu hạn, không làm tròn, không clamp thành [0,256]. Không áp dụng large-range correction. Test ngưỡng trực tiếp kiểm tra `raw=40` và giá trị ngay trên nó: tổng của các `2**(-rank)` là dyadic, nên các register nguyên không thể sinh đúng raw 40 với hệ số này.

SQLite giữ đúng một row chứa identity, algorithm và vector 16 register; không có bảng giá trị thật, count unique hay lịch sử request. `BEGIN IMMEDIATE` bao quanh read–max–write, commit cả vector; POST chỉ trả thành công sau commit. WAL và `synchronous=FULL` hỗ trợ durability theo bảo đảm của SQLite và storage bên dưới. Startup kiểm tra schema trạng thái, identity và algorithm đã lưu **trước listen**; mismatch làm tiến trình thoát, không âm thầm reset dữ liệu. Snapshot trả một bản parse mới, caller không giữ tham chiếu sửa được state trong bộ nhớ.

## Deadline và lỗi nguồn

Hai origin là cấu hình cố định, được normalize bằng URL và phải khác nhau, là HTTP loopback `127.0.0.1`, không credentials/path/query/hash, không port 0. `http://127.0.0.1:80` và `http://127.0.0.1/` là cùng một origin nên bị từ chối khi dùng cho cả hai nguồn. Nếu port aggregate biết trước và trùng origin nguồn, startup cũng từ chối.

Mỗi GET estimate tạo **một ngân sách tổng 500ms** cho hai fetch song song, từ headers đến byte cuối cùng. Cùng AbortController bảo vệ cả hai; không cấp lại 500ms khi bắt đầu đọc body/chunk hoặc nguồn còn lại. Redirect dùng `redirect:'error'`; không theo Location. Mỗi body upstream tối đa **8192 byte thực đọc**, không tin Content-Length. Kiểm tra media type, UTF-8 hợp lệ, JSON, status và toàn bộ snapshot trước merge. Body treo, JSON lỗi, byte thừa vượt bound, rank sai, identity đổi, algorithm đổi, mất kết nối hoặc timeout đều thành 502. Cancel stream, nhả reader lock và clear timer ở các nhánh kết thúc; không chờ một cancel promise bị treo để trả deadline. Không retry, polling hoặc background loop.

Hai snapshot không phải một distributed snapshot cùng thời điểm. Kết quả mô tả hợp của hai state đã đọc; khi đang có ghi, nó có thể bỏ lỡ ghi đến sau lần đọc nguồn tương ứng. Định danh đúng giúp tránh đọc nhầm DB; nó không thay authentication hay transport security cho mạng production.

## Ý nghĩa và giới hạn thống kê

Distinct hỏi “có bao nhiêu giá trị khác nhau?”, frequency hỏi “một giá trị xuất hiện bao nhiêu lần?”. HLL phục vụ câu đầu và cố ý quên số lần lặp. Không thể dùng nó để truy ra membership chính xác, audit input, xóa một giá trị hay khôi phục count thật.

Bài báo gốc mô tả sai số chuẩn tương đối xấp xỉ `1.04 / sqrt(m)` dưới các giả định phân bố hash và chế độ phân tích của thuật toán. Với m=16, con số tham khảo là khoảng **26%**, không phải giới hạn sai số cho mọi dataset. 16 register rất nhỏ; small-range correction và miền cố định 256 giá trị làm hành vi khác ví dụ asymptotic lớn. SHA-256 ở đây là ánh xạ deterministic trên miền nhỏ; chạy lặp cùng input không tạo thí nghiệm ngẫu nhiên độc lập. Hash rút xuống 32 bit vẫn có khả năng collision.

Đây là HLL tối giản để học phép merge, **không phải HLL++ production**: không sparse encoding, bias correction nâng cao, register packing, đổi precision, window/expiry, sharding hoặc calibration. Không đặt assertion “estimate luôn bằng unique thật” hay “mọi tập đều sai dưới 26%”. Các fixture test estimator kiểm tra công thức, không biến tính chất thống kê thành bảo đảm tuyệt đối.

## Kiểm tra

```bash
# Unit riêng: không mở listener; dùng SQLite :memory: và stream/fetch được kiểm soát
node --test --test-isolation=none --test-name-pattern=unit: \
  lessons/73-hyperloglog-distinct/test/lesson.test.mts

npm run typecheck
npm run test:unit

# Môi trường cho phép listener: chạy HTTP test độc lập của bài này
node --test --test-timeout=15000 \
  lessons/73-hyperloglog-distinct/test/lesson.test.mts

# Kiểm tra toàn repository của coordinator
npm run check
make test
git diff --check
```

Unit bao gồm golden hash/rank, suffix toàn zero, bit 31, update max, tính chất merge, replay union, estimator, exact schema, SQLite update, wire bound/deadline và import silence với env sai. HTTP tests dùng ba tiến trình thật cho hai DB riêng và aggregate, kiểm tra overlap, restart/duplicate, mismatch metadata, schema/method. Fixture nguồn là các tiến trình riêng; nguồn giả từng phía phát snapshot lỗi, JSON hợp schema nhưng wire vượt byte bound, redirect tới **một origin loopback khác đang reachable**, hoặc body chậm. Test đọc counter đích bằng 0 trước khi thay mode fixture. `finally` dừng mọi process và dọn thư mục, kể cả khi acquisition hoặc assertion sau đó thất bại; helper `startService` tự cleanup khi startup thất bại.

Worker không có quyền mạng chỉ chạy unit và typecheck. HTTP/Docker, independent review và publication thuộc coordinator; việc có test HTTP trong source không có nghĩa worker đã chạy chúng.

## Bài tập

1. Với `v0` ở cả A và B, giải thích vì sao `changed:false` không thể dùng để nhận diện mọi duplicate. Tìm hai giá trị khác nhau cập nhật cùng register mà lần thứ hai không tăng rank.
2. Dùng các tập overlap khác nhau trong miền 256 giá trị; so sánh estimate với distinct thật **trong chương trình thí nghiệm**, không thêm exact set vào service. Giải thích vì sao không nên cộng hai estimate.
3. Nếu đổi từ p=4 sang p=5, cần đổi những phần nào của algorithm id, hash slicing, schema, estimator và dữ liệu lưu? Tại sao không được merge trực tiếp hai precision?
4. Thiết kế distinct theo ngày bằng nhiều sketch độc lập, rồi phân tích vì sao max merge không hỗ trợ “trừ ngày cũ” khỏi sketch đã hợp nhất.

## Tài liệu gốc

- Flajolet, Fusy, Gandouet, Meunier, [HyperLogLog: the analysis of a near-optimal cardinality estimation algorithm (2007)](https://algo.inria.fr/flajolet/Publications/FlFuGaMe07.pdf): register, harmonic estimator, small-range correction và phân tích sai số. Diễn giải và mã trong bài học này được viết riêng cho hợp đồng hữu hạn ở trên.
- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), [SQLite transactions](https://sqlite.org/lang_transaction.html): API runtime và ranh giới durability dùng trong ví dụ.
