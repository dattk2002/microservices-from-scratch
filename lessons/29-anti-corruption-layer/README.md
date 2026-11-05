# 29 — Anti-corruption layer và chuyển đổi ngữ nghĩa hệ thống cũ

Một hệ thống kho cũ báo “3 kiện, mỗi kiện 4 chiếc”, giá mỗi chiếc là chuỗi
`"12.34"`, mã hàng `L:pen`, trạng thái `A`. Orders cần 12 chiếc có thể bán,
1234 cent và định danh `pen`. Chỉ đổi tên trường sẽ bỏ sót đơn vị, độ chính xác
và ý nghĩa trạng thái. Bài này dựng ba tiến trình HTTP độc lập để giữ những
quy tắc đó ngoài miền Orders. Tiền hoàn toàn mô phỏng; không thanh toán,
không gọi API ngoài, không cần thông tin xác thực.

## Điều kiện và kiến trúc

Dùng Node **24.12+ thuộc nhánh 24**, các gói phát triển đã được ghim tại root.
Chạy các lệnh từ root repository. Nên học bài HTTP contracts, deadlines,
gateway aggregation và Strangler trước.

```text
client → Orders POST /quotes → adapter GET /products/:id → legacy GET /catalog/:id
          model.mts             translation.mts              legacy.mts
          canonical only        alias + money + packs
```

- `model.mts`: hợp đồng miền, parser runtime, số nguyên và giới hạn canonical.
- `translation.mts`: bảng quy tắc legacy v1/v2, chuyển tiền bằng BigInt và
  giới hạn wire legacy. Orders không import tệp này.
- `transport.mts`: origin tin cậy, timeout, đọc JSON có giới hạn và ánh xạ lỗi.
- Ba entrypoint chỉ đọc cấu hình, đăng ký signal và mở listener trong `main`,
  được gọi dưới `import.meta.main`. Import không khởi động hệ thống.
- Không có database, cache hay durable write. Báo giá là phép tính tức thời,
  không giữ hàng, không đảm bảo tồn kho cho một lệnh đặt hàng tương lai.

## Chạy ba terminal

```sh
HOST=127.0.0.1 PORT=3029 TEACHING_CONTROLS=1 node lessons/29-anti-corruption-layer/legacy.mts
HOST=127.0.0.1 PORT=3030 LEGACY_ORIGIN=http://127.0.0.1:3029 node lessons/29-anti-corruption-layer/adapter.mts
HOST=127.0.0.1 PORT=3031 PRODUCTS_ORIGIN=http://127.0.0.1:3030 node lessons/29-anti-corruption-layer/orders.mts
```

Mỗi server ghi một dòng JSON `{ "service": "...", "port": 3029 }` khi sẵn sàng.
`PORT=0` chọn cổng ephemeral; lấy cổng readiness rồi truyền origin đúng cho
service kế tiếp. `HOST` mặc định `127.0.0.1`; giữ nguyên host này khi chạy cục bộ.
`PORT` hợp lệ 0..65535. Origins bắt buộc là `http://127.0.0.1:<port>` cố định
lúc startup, không path, query, credentials hoặc hostname tùy ý. Client không
được cung cấp URL upstream. Không theo redirect.

`UPSTREAM_MS` ở adapter mặc định 200 (20..2000); Orders mặc định 500
(20..3000). Signal timeout áp dụng cả lấy headers và đọc body. Hai deadline
độc lập, không phải ngân sách phân tán được truyền xuyên suốt. Trong vận hành
phải dành ngân sách cho cả hai hop và thời gian xử lý. Inbound HTTP helper
đặt request/header timeout 5 giây, giới hạn JSON request 8192 byte; SIGTERM/
SIGINT đóng listener và buộc đóng kết nối còn lại sau 1 giây.

```sh
curl --max-time 3 -sS http://127.0.0.1:3031/quotes \
  -H 'content-type: application/json' -d '{"productId":"pen","quantity":2}'
```

Kết quả:

```json
{"productId":"pen","quantity":2,"unitCents":1234,"currency":"USD","totalCents":2468}
```

## Hợp đồng và quyết định ngữ nghĩa

ID là chuỗi ASCII `[a-zA-Z0-9-]`, dài 1..64. Provider mô phỏng một sản phẩm
cho mỗi ID hợp lệ; ID `missing` được dành riêng cho fixture không tồn tại.
Không xem đây là catalog kinh doanh thực.

| Khái niệm | Legacy v1 | Legacy v2 | Canonical |
| --- | --- | --- | --- |
| Định danh | `sku: L:<id>` | `item: N:<id>` | `id` đúng ID được hỏi |
| Tên | `description` | `label` | `name`, 1..80 UTF-16 code units |
| Giá mỗi chiếc | `unit_price` | `price` | `unitCents`, số nguyên an toàn |
| Tiền tệ | `currency` | `money` | `currency: USD` |
| Số kiện | `packs` | `boxes` | nhân với kích thước kiện |
| Chiếc mỗi kiện | `pack_size` | `units_per_box` | `availableUnits` |
| Trạng thái | `status` | `state` | `availability` |

Hai format có tập trường chính xác, không được trộn. Tên có thể chứa ký tự
điều khiển đã escape trong JSON, để kiểm tra giới hạn mã hóa; giao diện thực
cần hiển thị chúng an toàn. Giá phải là chuỗi thập phân không âm, đúng hai
chữ số sau dấu chấm, không số 0 thừa đầu, tối đa 14 chữ số phần nguyên.
Adapter bỏ dấu chấm rồi dùng BigInt, kiểm tra <= `Number.MAX_SAFE_INTEGER`
trước khi chuyển sang number. `90071992547409.91` hợp lệ; thêm 0.01 bị từ chối.
Không dùng `parseFloat * 100`.

Số kiện nguyên 0..1.000.000; kích thước kiện nguyên 1..1000; tích phải
<=1.000.000 chiếc. `A` bắt buộc có số chiếc >0 và ánh xạ `available`.
`O` (hết hàng) hoặc `D` (ngừng bán) bắt buộc có 0 chiếc và ánh xạ
`unavailable`. Đây là quyết định miền đã thỏa thuận cho fixture, không phải
quy tắc phổ quát. `D` với tồn kho dương bị từ chối; adapter không tự xóa số
hàng còn lại hay chữa dữ liệu kinh doanh mâu thuẫn.

Mọi enum phải là chuỗi trước khi so sánh: `["USD"]`, `["A"]` và object không
được ép thành chuỗi để vượt validation. Thiếu trường, thừa trường, alias
khác ID yêu cầu, currency khác USD, trạng thái lạ hoặc số không an toàn đều
bị từ chối. Orders parse lại canonical trước khi tính toán, không cast JSON
thành kiểu đã tin cậy. Không có ghi bền vững trước/sau parsing trong bài này.

Request `/quotes` chỉ nhận `productId` và `quantity` nguyên 1..1000. Tổng dùng
BigInt rồi kiểm tra miền safe integer; tràn tổng trả 422. Không cộng thuế,
phí, đổi tiền hay làm tròn.

| Tình huống | Adapter | Orders |
| --- | --- | --- |
| Sản phẩm thiếu, legacy 404 `not_found` | 404 | 404 |
| Sản phẩm tồn tại nhưng không thể bán | 200 canonical unavailable | 409 |
| Yêu cầu vượt số chiếc có sẵn | 200 canonical | 409 |
| Dữ liệu sai, quá lớn, JSON hỏng, redirect | 502 | 502 |
| Provider lỗi tạm thời 503 `temporary` | 503 | 503 |
| Hết deadline | 504 | 504 |
| Input quote không hợp lệ | — | 400 (415 nếu sai content type) |

Legacy và adapter dùng envelope dependency `{ "error": "not_found" }`,
`temporary`, `invalid_upstream` hoặc `deadline` tùy status. Orders dùng envelope
HTTP helper `{ "error": { "code": "...", "message": "..." } }`.
Lỗi dependency không bao giờ được biến thành tồn kho 0. Không retry ngầm.

Body upstream bị giới hạn khi đọc stream, không chỉ tin Content-Length.
`LEGACY_LIMIT` và `CANONICAL_LIMIT` được tính từ JSON với tên trường thực,
độ dài chuỗi tối đa nhân sáu byte mỗi UTF-16 code unit (escape `\u0000`),
số nguyên lớn nhất và dấu phân cách. Đây là upper bound bảo thủ cho JSON
gọn của protocol; whitespace tùy ý không thuộc hợp đồng wire. Test nhận cả
ID dài 64 và tên 80 ký tự điều khiển, đồng thời từ chối body vượt trần.
Cả response thành công và lỗi đều qua bộ đọc hữu hạn; lỗi còn được kiểm tra
status/envelope phù hợp. Parser không tin kiểu TypeScript ở runtime.

## Playground: thay đổi hệ cũ, giữ nguyên consumer

Chỉ provider chạy với **`TEACHING_CONTROLS=1`** mới mở route điều khiển.
Đây là công cụ dạy học cục bộ, không có auth, không đưa lên mạng công cộng.
Thay mode là đồng bộ; response 200 là barrier xác nhận đã áp dụng cho request
kế tiếp, không cần sleep trong client.

```sh
curl --max-time 3 -sS http://127.0.0.1:3029/teaching/scenario \
  -H 'content-type: application/json' -d '{"scenario":"v2"}'
# Gửi lại quote ở trên: cùng totalCents=2468, không sửa/restart Orders.
```

| Scenario | Hiệu ứng |
| --- | --- |
| `valid` / `v2` | Cùng sản phẩm, hai bộ alias/tên trường |
| `missing` / `unavailable` | 404 / canonical hết hàng |
| `malformed` | Giá `12.345`, mọi trường khác hợp lệ |
| `ambiguous` | Thêm trường giá của format khác |
| `mismatch` | Alias không đúng sản phẩm được hỏi |
| `currency` | Currency là array, không phải string |
| `failure` | 503 tạm thời |
| `slow` | Chờ 700ms, vượt deadline mặc định adapter |
| `oversized` / `redirect` | Body quá lớn / 302 không được theo |
| `maximum` | Tên escape tối đa, giá safe tối đa, 1 triệu chiếc |

Đặt lại `valid` để quan sát phục hồi, không restart process. `maximum` cho
phép quote một chiếc, hai chiếc trả 422. Mode chỉ tồn tại trong RAM provider,
được chụp lúc xử lý request; không mô phỏng concurrent migration giữa replica.
Mặc định route điều khiển trả 404. Body cần chính xác một trường `scenario`
thuộc enum chuỗi; array/object trả 400.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/29-anti-corruption-layer/test/lesson.test.mts
# Chạy trong môi trường được phép mở HTTP loopback (controller):
node --test --test-timeout=15000 lessons/29-anti-corruption-layer/test/lesson.test.mts
# Kiểm tra toàn repository trong môi trường controller:
npm run check
make test
git diff --check
```

Unit tests kiểm tra tiền chính xác, tràn số, pack bounds, identity, trường
thiếu/thừa, enums, availability, status mapping và giới hạn JSON. Một child
import cả ba entrypoint với cấu hình cố ý sai phải exit 0, stdout/stderr rỗng.
Integration khởi động ba child độc lập bằng helper, cổng ephemeral loopback,
request có timeout, xác nhận quote và format v2 giống nhau, lỗi từng mode,
phục hồi sau từng lỗi, maximum body và controls mặc định tắt. `finally` đóng
child theo thứ tự ngược kể cả startup dở dang. Không listener ở top level,
không database hoặc scratch fixture trên source; nếu mở rộng fixture file,
hãy dùng `node:os.tmpdir()` để chạy được với source read-only trong Docker.

Trong worker không mạng: đã quan sát assertion RED `0 !== 1234` trước triển
khai. Controller cần chạy HTTP integration; worker không chạy Docker hoặc
xin quyền network. Việc có test integration không có nghĩa chúng đã pass.

## Ranh giới, chi phí và bài tập

ACL thêm một hop HTTP, parsing, bộ nhớ buffer hữu hạn và một điểm có thể
hỏng. Chủ sở hữu miền Orders nên chịu trách nhiệm hợp đồng canonical cùng
nhóm hiểu nghiệp vụ legacy; thay đổi format phải có mapping, fixture và
review ngữ nghĩa tương ứng. Không cho consumer tự xử lý alias/status cũ vì
như vậy chi phí thay đổi sẽ lan sang mọi consumer. Ví dụ v2 ở đây đã có
mapping từ trước; một v3 chưa biết phải fail, không đoán.

Gateway aggregation ghép kết quả nhiều dịch vụ cho client; ACL bảo vệ ngữ
nghĩa miền khỏi mô hình khác. API field renaming chỉ đổi tên; bài này còn đổi
đơn vị, biểu diễn tiền và ý nghĩa availability. Strangler chuyển quyền sở hữu
chức năng/dữ liệu từng phần sang hệ mới; ACL có thể hỗ trợ quá trình đó nhưng
bài này không chuyển quyền sở hữu catalog hay loại bỏ legacy. Adapter không
thể biết dữ liệu mâu thuẫn nào đúng; trả lỗi và nhờ chủ dữ liệu sửa.

Bài tập:

1. Thêm legacy v3 với giá mỗi kiện. Viết test chia không hết trước; quy định
   rõ khi nào được từ chối thay vì tự làm tròn.
2. Thêm một currency được miền hỗ trợ và chứng minh không trộn currency khi
   mở rộng sang quote nhiều dòng; không tích hợp thanh toán thật.
3. Đo latency mỗi hop trong môi trường loopback và thiết kế deadline tổng.
   Giải thích vì sao retry có thể làm tăng tải khi provider đang chậm.
4. Thử thêm trạng thái chưa biết. Chứng minh Orders không cần sửa nhưng vẫn
   nhận 502 cho đến khi nhóm sở hữu adapter phê duyệt semantics mới.

Tài liệu gốc để đối chiếu:
- [Microsoft: Anti-corruption Layer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
- [Node.js 24 HTTP API](https://nodejs.org/docs/latest-v24.x/api/http.html)
