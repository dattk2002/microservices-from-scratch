# 77 — Heavy hitters bằng Misra–Gries, sai số có chặn và hợp nhất summary

Hai stream nhận sự kiện độc lập. Mỗi stream chỉ duy trì tối đa ba bộ đếm để
tóm tắt tần suất theo key. Query hợp nhất hai summary và trả một khoảng tần
suất cho từng ứng viên. Mọi key có tần suất thật **lớn hơn** một phần tư tổng
số sự kiện đều xuất hiện trong kết quả.

## Chuẩn bị và chạy

Cần Node.js **24.12.0 trở lên, dưới 25**, npm và các gói phát triển đã ghim
ở gốc repository (`npm ci` nếu chưa cài). Runtime dùng built-in của Node.
Kiến thức nền gồm HTTP/JSON, transaction SQLite và cách đếm tần suất.
Chạy các lệnh sau tại gốc repository trong shell POSIX.

Tạo thư mục mới cho lần thử, rồi mở hai terminal cho stream a và b. Mỗi
stream sở hữu file riêng. Dùng tên thư mục mới nếu đường dẫn demo đã tồn tại.

```bash
mkdir -m 700 /tmp/mg77-demo
```

```bash
STREAM_ID=a DB_PATH=/tmp/mg77-demo/a.db HOST=127.0.0.1 PORT=8077 \
  node lessons/77-misra-gries-heavy-hitters/stream.mts
```

```bash
STREAM_ID=b DB_PATH=/tmp/mg77-demo/b.db HOST=127.0.0.1 PORT=8078 \
  node lessons/77-misra-gries-heavy-hitters/stream.mts
```

Mở terminal thứ ba cho query.

```bash
SOURCE_A_ORIGIN=http://127.0.0.1:8077 SOURCE_B_ORIGIN=http://127.0.0.1:8078 \
  HOST=127.0.0.1 PORT=8079 node lessons/77-misra-gries-heavy-hitters/query.mts
```

`HOST` mặc định và chỉ nhận `127.0.0.1`. Khi bỏ `PORT`, stream dùng 3077
và query dùng 3177. `PORT=0` chọn cổng ephemeral. Đọc cổng thực từ dòng
readiness dạng `{"service":"mg77-stream-a","port":8077}` trên stdout. Đặt hai
biến origin theo cổng thực của từng nguồn. Chúng phải là HTTP origin trên
`127.0.0.1`, với cổng hợp lệ, tùy chọn dấu `/` cuối và không có thông tin
đăng nhập, path khác `/`, query hoặc fragment. Query chuẩn hóa origin trước
khi so sánh, từ chối hai origin trùng và origin trỏ về cổng cố định của nó.

`STREAM_ID` nhận `a` hoặc `b`. `DB_PATH` là đường dẫn file cục bộ riêng
của stream. SQLite ghi identity vào file và từ chối mở dưới identity khác
trước khi listen. Có thể dừng bằng Ctrl-C hay SIGTERM rồi chạy lại với cùng
file và identity. Chỉ stream nạp SQLite khi chạy trực tiếp, nên trên Node
24.12 cảnh báo SQLite có thể xuất hiện lúc khởi động. Import entrypoint
không đọc cấu hình, mở database hay mở listener.

## Gửi và truy vấn sự kiện

Gửi sáu sự kiện đến a theo thứ tự. Bốn key đầu tiên triệt tiêu lẫn nhau.
Hai lần xuất hiện tiếp theo của `k0` nằm trong summary.

```bash
i=0
for key in k0 k1 k2 k3 k0 k0; do
  curl -sS http://127.0.0.1:8077/events \
    -H 'content-type: application/json' \
    -d "{\"id\":\"e$i\",\"key\":\"$key\"}"
  i=$((i + 1))
done
curl -sS http://127.0.0.1:8077/summary
```

```json
{"id":"a","algorithm":"mg3-v1","total":6,"dropped":1,"counters":[{"key":"k0","count":2}]}
```

Phát lại `e0` vào a chỉ đọc receipt cũ. Gửi `e0` vào b tạo một sự kiện mới
vì ID được xét trong từng nguồn.

```bash
curl -sS http://127.0.0.1:8077/events \
  -H 'content-type: application/json' -d '{"id":"e0","key":"k0"}'
curl -sS http://127.0.0.1:8078/events \
  -H 'content-type: application/json' -d '{"id":"e0","key":"k0"}'
curl -sS http://127.0.0.1:8078/events \
  -H 'content-type: application/json' -d '{"id":"b1","key":"k4"}'
curl -sS http://127.0.0.1:8078/events \
  -H 'content-type: application/json' -d '{"id":"b2","key":"k0"}'
curl -sS http://127.0.0.1:8079/heavy
```

```json
{"total":9,"dropped":1,"candidates":[{"key":"k0","lower":4,"upper":5},{"key":"k4","lower":1,"upper":2}]}
```

Tần suất thật của `k0` là 5, lớn hơn `9/4`. `k4` có tần suất thật
là 1 nhưng vẫn xuất hiện dưới dạng ứng viên. `k1` đã bị loại khỏi cả
hai summary. Khoảng ngầm định của nó là `[0, 1]`. Gọi lại `GET /heavy`
trước khi có sự kiện mới sẽ trả cùng kết quả.

## Hợp đồng HTTP

| Route | Dữ liệu vào | Thành công | Lỗi |
| --- | --- | --- | --- |
| Stream `POST /events` | Chính xác `{id,key}`. ID gồm 1–16 ký tự ASCII thuộc `a-z` hoặc `0-9`. Key từ `k0` đến `k31`. | 201 `{"id":"e0","duplicate":false}` khi ghi mới, 200 `{"id":"e0","duplicate":true}` khi phát lại đúng key | 409 `id_conflict` nếu ID cũ khác key, 429 `capacity` nếu ID mới khi đã giữ 64 receipt |
| Stream `GET /summary` | Không có query string | 200 `{id,algorithm,total,dropped,counters}` | Lỗi HTTP chung ở dưới |
| Query `GET /heavy` | Không có query string | 200 `{total,dropped,candidates}` | 502 `upstream_failure` nếu bất kỳ nguồn nào thất bại |

ID và key phải là chuỗi thật. Object có field thừa hoặc thiếu, kiểu nguyên
thủy, `null` hay mảng thay object đều bị từ chối với 400 `invalid_request`.
JSON hỏng trả 400 `invalid_json`. Content-Type sai trả 415
`unsupported_media_type`. Body request trên 8192 byte trả 413 `body_too_large`.
Request bị gián đoạn trả 400 `request_aborted`. Route khác trả 404
`not_found`. Method sai trả 405 `method_not_allowed` kèm `Allow`.
Lỗi có nghĩa đã định dùng dạng `{"error":{"code":"capacity","message":"capacity"}}`
với `message` bằng `code`.

Summary nguồn chứa đúng identity `a` hoặc `b` và `algorithm` là `mg3-v1`.
`total` nằm trong 0–64 và `dropped` trong 0–16. `counters` có tối đa ba
phần tử `{key,count}`, mỗi count nguyên trong 1–64, key duy nhất và xếp
tăng theo chuỗi ASCII (ví dụ `k10` đứng trước `k2`). Kết quả hợp nhất
có tối đa ba `{key,lower,upper}` theo cùng thứ tự, tổng tối đa 128.

## Kiến trúc và lưu trạng thái

```text
POST /events ──> stream a ──> a.db
POST /events ──> stream b ──> b.db

                             ┌── GET /summary ──> stream a
GET /heavy ──> query ────────┤
                             └── GET /summary ──> stream b
                   kiểm tra cả hai → hợp nhất → trả khoảng
```

Mỗi ID mới ghi một receipt bất biến và cập nhật summary trong cùng một
transaction SQLite `BEGIN IMMEDIATE` với WAL và `synchronous=FULL`. Khi
một ghi thất bại, rollback bao phủ cả hai thay đổi. Stream kiểm tra receipt
trước khi kiểm tra sức chứa để phát lại hoặc báo xung đột đúng cả khi đã đầy.
Đọc summary chỉ dùng hàng trạng thái đã commit. Receipt cho phép demo
khử trùng lặp qua restart, tốn thêm một hàng mỗi ID. Thuật toán không quét
receipt và chỉ lưu ba bộ đếm gần đúng, tổng số nhận và lượng giảm.

Query đọc song song hai summary và tính lại trên mỗi yêu cầu. Nó không lưu
kết quả tích lũy. Hai lần đọc nguồn có thể thấy hai thời điểm commit khác
nhau. Bảo đảm tần suất áp dụng cho hợp của hai prefix thực tế đã đọc. Bài
học giả định hai luồng sự kiện rời nhau về mặt ghi nhận. Nếu cùng một sự
kiện nghiệp vụ được gửi đến cả hai nguồn, cả hai lượt đều được tính.

## Vì sao khoảng sai số đúng

Khi nhận một key đã có bộ đếm, tăng bộ đếm đó. Nếu key mới và còn chỗ, tạo
bộ đếm 1. Nếu cả ba chỗ đã đầy, giảm **cả ba** bộ đếm đi 1, xóa bộ đếm về
0, bỏ lần xuất hiện vừa đến và tăng `dropped` đi 1. Mỗi lần giảm như vậy
triệt đúng bốn lần xuất hiện thuộc bốn key khác nhau. Với một nguồn luôn có
`sum(count) + 4*dropped = total`. Tần suất của từng key mất nhiều nhất một
đơn vị mỗi lần giảm. Bốn key cùng xuất hiện đúng một lần có thể biến mất
hết, nên ngưỡng bảo đảm là **lớn hơn** `total/4`.

Để hợp nhất, cộng bộ đếm theo key và cộng hai `dropped`. Nếu còn hơn ba key,
lấy số đếm dương nhỏ nhất `d` rồi trừ `d` khỏi **mọi** bộ đếm đang có. Xóa
các bộ đếm về 0 và cộng `d` vào `dropped`. Lặp đến khi còn tối đa ba key.
Khi có `m` key trong một bước, tổng bộ đếm giảm `m*d`, còn `4*dropped` chỉ
tăng `4*d`. Vì `m >= 4`, kết quả hợp nhất thỏa
`sum(lower) + 4*dropped <= total`. Bất đẳng thức có thể nghiêm ngặt. Ví dụ
mảng đếm sau phép cộng có năm giá trị `[12,3,2,4,3]`, tổng nguồn là 36 và
`dropped` ban đầu là 3. Hai lần trừ 2 và 1 để lại `[9,1]`, `dropped=6`
và `9 + 1 + 4*6 = 34 < 36`.

Với mỗi key, `lower` bằng bộ đếm còn lại hoặc 0 nếu bị loại. Sai số do
hai nguồn cộng lại được chặn bởi tổng hai `dropped` ban đầu. Mỗi bước nén
tăng mức thiếu tối đa của bất kỳ key nào thêm `d`. Vì vậy
`lower <= tần suất thật <= lower + dropped`. Key vắng mặt có tần suất thật
tối đa `dropped <= total/4`, nên một heavy hitter thật sự không thể vắng mặt.
Chọn ba bộ đếm lớn nhất sau khi cộng sẽ bỏ một phần khối lượng mà không
cập nhật được chặn sai số theo quy tắc trên.

Thứ tự sự kiện ảnh hưởng đến summary. Với năm key khác nhau, đưa key nào
vào sau cùng sẽ quyết định key còn lại sau lần triệt đầu tiên. Cách chia
luồng và nhóm phép hợp nhiều tầng cũng có thể đổi các ứng viên và sai số.
Ứng viên có thể là dương tính giả với ngưỡng `total/4`. Muốn xác nhận một
ứng viên vượt ngưỡng, có thể kiểm tra `lower > total/4` hoặc đếm lại dữ
liệu gốc. Bài này trả ứng viên theo key và không cung cấp top-k chính xác.
Count-Min Sketch ước lượng cho một key đã biết. Các ô băm của nó không
tự liệt kê tên key. Misra–Gries lưu trực tiếp tên các ứng viên.

## Failure và giới hạn tài nguyên

- Mỗi lần `GET /heavy` cấp **500 ms tổng cộng**, tính từ trước hai lượt
  fetch qua lúc đọc, kiểm tra cả hai body và hợp nhất. Timer hủy các lượt
  đọc đang chờ. Query dùng đồng hồ đơn điệu để kiểm tra mốc hết hạn trước
  khi chấp nhận kết quả, kể cả khi callback của timer bị trễ. Một lỗi hủy
  lượt đọc còn lại và làm cả truy vấn thất bại.
- Query chỉ dùng hai origin đã cấu hình và đường dẫn `/summary`.
  `redirect: 'error'` chặn việc theo Location, kể cả tới loopback khác.
- Nguồn gửi JSON không nén. Query chỉ chấp nhận `Content-Encoding` vắng
  mặt hoặc `identity`, vì Fetch có thể tự giải nén body mà vẫn giữ header
  gốc. Query từ chối `Content-Length` sai hoặc lớn hơn **8192 byte** và
  đếm byte theo chunk để áp dụng cùng giới hạn khi không có độ dài khai
  báo. Body trong giới hạn được giải mã UTF-8 và kiểm tra Content-Type,
  schema, identity và đẳng thức của nguồn.
- Status khác 200, error envelope từ nguồn, sai schema, sai identity,
  lỗi mạng, redirect hay hết deadline đều thành 502 `upstream_failure`.
  Query không chuyển tiếp status hay error envelope của nguồn.
- Mỗi bước cập nhật đọc hoặc sửa tối đa ba bộ đếm. Query giữ nhiều nhất
  sáu key trước nén. Giới hạn 64 receipt mỗi nguồn làm tradeoff lưu trữ
  có thể kiểm tra được. Bài học không có retry tự động, tiến trình chạy
  nền, xóa receipt hay snapshot phân tán. Yêu cầu cả hai nguồn làm giảm
  khả năng phục vụ khi một nguồn lỗi.

## Kiểm chứng

```bash
node --test --test-isolation=none --test-name-pattern=unit: \
  lessons/77-misra-gries-heavy-hitters/test/lesson.test.mts
npm run typecheck
npm run test:unit
# Chạy tại môi trường được phép mở listener loopback.
node --test --test-timeout=15000 lessons/77-misra-gries-heavy-hitters/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit kiểm tra lần triệt đầu tiên và bộ đếm còn sống, phép nén có trọng số,
sai số so với đếm chính xác, rollback sau lỗi ghi SQLite, schema và import
im lặng. Integration chạy các process Node riêng, dùng database trong
thư mục tạm và cổng ephemeral. Test đọc counter của đích redirect trước
khi đổi mode. Fixture gửi JSON hợp lệ 8193 byte và gzip có phần chú thích
dài để kiểm tra giới hạn byte trên đường truyền. Fixture gửi JSON thành
nhiều chunk để kiểm tra cả lượt đọc kịp hạn và lượt đọc quá hạn.

## Bài tập

1. Đổi thứ tự năm key khác nhau và dự đoán ứng viên duy nhất. Kiểm tra lại
   bằng hai database mới với cùng multiset sự kiện.
2. Tìm một bộ dữ liệu khiến kết quả hợp nhất có đúng ba ứng viên nhưng
   chỉ một ứng viên vượt `total/4`. Dùng cận dưới và cận trên để phân
   loại key chắc chắn vượt ngưỡng, chắc chắn không vượt và chưa biết.
3. Thử nén riêng từng cặp trong ba summary theo hai cách nhóm. So sánh
   ứng viên và chứng minh chặn sai số còn đúng cho mỗi kết quả.
4. Thiết kế chính sách hết hạn receipt. Mô tả cách một lần retry đến sau
   hạn có thể làm tăng số đếm và ảnh hưởng đến ý nghĩa của `total`.

## Nguồn chính

- Bài báo gốc mô tả cách tìm phần tử lặp bằng bộ nhớ hữu hạn. [Misra và Gries, Finding Repeated Elements](https://www.cs.utexas.edu/~misra/scannedPdf.dir/FindRepeatedElements.pdf)
- Tài liệu về sketch tần suất, các cận ước lượng và khả năng hợp nhất. [Apache DataSketches, Frequency Sketches](https://datasketches.apache.org/docs/Frequency/FrequencySketches.html)
