# 45 — Traffic shadowing, so sánh bản mới và giới hạn tải quan sát

Một nhóm thay bộ đọc giá sản phẩm. Họ muốn biết bản mới có trả cùng giá với
bản đang phục vụ hay không trước khi chuyển người mua sang bản mới. Gateway
luôn trả kết quả primary; sau một lần đọc hợp lệ, gateway có thể gửi một bản
GET tối giản sang shadow để quan sát. Không có traffic thật hay triển khai cloud.

## Điều kiện và chạy thử

Cần Node.js **24.12+ (<25)**, npm và các gói phát triển đã khóa ở root. Không
cần database, khóa bí mật hay package runtime. Chạy các lệnh từ root repository.
Mỗi lệnh dưới đây chạy trong terminal riêng; dùng Ctrl-C để dừng:

```sh
HOST=127.0.0.1 PORT=4546 VARIANT=primary TEACHING_CONTROLS=1 node lessons/45-traffic-shadowing/backend.mts
HOST=127.0.0.1 PORT=4547 VARIANT=shadow TEACHING_CONTROLS=1 node lessons/45-traffic-shadowing/backend.mts
HOST=127.0.0.1 PORT=4545 PRIMARY_ORIGIN=http://127.0.0.1:4546 SHADOW_ORIGIN=http://127.0.0.1:4547 TEACHING_CONTROLS=1 node lessons/45-traffic-shadowing/gateway.mts
```

`PORT=0` chọn cổng tạm; mỗi server in đúng thông tin sẵn sàng dạng JSON
`{"service":"…","port":…}`. `HOST` mặc định `127.0.0.1`. `VARIANT` chỉ nhận
`primary` hoặc `shadow`, mặc định primary. Hai origin bắt buộc là HTTP origin
không credentials, path ngoài `/`, query hay fragment. Chúng được đọc một lần
khi khởi động. Import module không đọc cấu hình, mở listener hay đăng ký signal.
Không dùng tên môi trường dành riêng `NODE_*`, `LD_*`, `DYLD_*`.

```sh
curl http://127.0.0.1:4545/products/ao_01
curl -X POST http://127.0.0.1:4545/teaching/drain -H 'content-type: application/json' -d '{}'
curl http://127.0.0.1:4545/stats
curl -X POST http://127.0.0.1:4547/teaching/behavior -H 'content-type: application/json' -d '{"mode":"different"}'
curl http://127.0.0.1:4545/products/ao_01
curl -X POST http://127.0.0.1:4545/teaching/drain -H 'content-type: application/json' -d '{}'
```

Hai lần đọc đều trả `{"id":"ao_01","price":10000,"currency":"VND"}`. Sau
lần thứ hai, stats ghi `mismatched`: shadow có giá 12000 nhưng không có quyền
thay kết quả gửi cho người gọi. Drain giúp nhìn kết quả quan sát xác định mà
không biến GET sản phẩm thành thao tác chờ shadow.

## Đường đi và hợp đồng

```text
caller -> gateway -> primary -> validate -> business JSON -> caller
                                  |
                                  +-> permit còn trống? -> shadow -> compare -> stats
                                       không: skipped++
```

* `GET /products/:id`: id ASCII gồm chữ, số, `_`, `-`, dài 1–32 ký tự; không
  query, không body. Không giải mã path để biến ký tự escape thành đường dẫn
  khác. POST trả 405; id/query/body sai trả 400. Header của route này tối đa
  8192 byte theo tổng chuỗi tên/giá trị đã parse; Node còn có giới hạn parser.
* Kết quả hợp lệ có đúng ba trường: id trùng yêu cầu, price là số nguyên an
  toàn không âm, currency đúng `VND`. Chỉ object đã dựng lại này được trả về.
* Primary có deadline 700 ms bao trùm cả đọc body; reply phải status 200,
  `application/json`, tối đa 512 byte. Lỗi status/schema/JSON/byte/redirect trả
  502; hết deadline primary trả 504. Không lấy dữ liệu shadow để cứu primary.
* Budget 512 tính cả id 32 ký tự với JSON escape `\uXXXX` (192 byte), giá
  nguyên an toàn tối đa 16 chữ số và các khóa/dấu phân cách. Test chấp nhận
  payload legal dùng escape đầy đủ. Dữ liệu vượt budget bằng whitespace vẫn
  là JSON/schema hợp lệ và phải bị từ chối chỉ vì giới hạn byte.
* Mỗi primary thành công được thử lấy một permit; tối đa hai tác vụ mirror,
  không queue. Khi đầy, primary vẫn phục vụ và `skipped` tăng. Mirror có
  deadline riêng 1000 ms; mọi settlement, kể cả throw đồng bộ, đều giải phóng
  permit trong `finally`. Rejection được xử lý tại pool.
* Outbound chỉ dựng GET tới origin cố định và path từ id đã kiểm tra, với
  header ứng dụng allowlist `accept: application/json`. Fetch tự thêm header
  giao thức chuẩn; gateway không sao chép authorization, cookie, signed
  context, query hay body người gọi. Cả primary và shadow dùng `redirect:error`.
  Redirect sang cùng hay khác origin đều lỗi; không có bước follow tự động.
* Primary không thành công hoặc request không hợp lệ không tạo mirror. Client
  ngắt trước khi hoàn tất phản hồi sẽ hủy công việc liên quan; hoàn tất phản hồi
  bình thường không hủy mirror. SIGTERM/SIGINT hủy mirror và đóng kết nối gateway.
* `GET /stats`: active 0–2; started/skipped/matched/mismatched/failed bão hòa
  tại 1.000.000. `last`, nếu có, chỉ là một enum matched/mismatched. Failure
  không tạo dữ liệu kinh doanh hay ghi payload. Không lưu id, header hay lịch sử
  theo khách. Stats chỉ nằm trong RAM và mất khi restart.

## Điều khiển giảng dạy cục bộ

Chỉ bật với **`TEACHING_CONTROLS=1`**, không có xác thực và chỉ dùng trên máy
học tập. Không bật trên dịch vụ công khai. Khi tắt, `/teaching/*` trả 404.

| Tiến trình | Route | JSON / kết quả |
| --- | --- | --- |
| Backend | POST `/teaching/behavior` | `{"mode":"same"}`, `different`, hoặc `unavailable` (503) |
| Backend | POST `/teaching/hold` | `{"enabled":true}` giữ tối đa hai reply; `false` giải phóng tất cả |
| Backend | GET `/teaching/state` | Số call và số reply đang held, không payload |
| Gateway | POST `/teaching/drain` | `{}`; chờ snapshot tối đa hai tác vụ hiện tại, trả stats |

Body control tối đa 256 byte, deadline đọc 500 ms; null/array/boolean và primitive
sai trả 400. Drain không chờ tác vụ mới xuất hiện sau snapshot và được chặn trên
bởi deadline còn lại của từng mirror (tối đa 1000 ms). Backend held tự giải
phóng sau 1500 ms, khi client ngắt hoặc khi shutdown. Một request thứ ba trực
tiếp tới backend đang hold trả 503 thay vì tạo hàng đợi vô hạn.

Để thấy giới hạn: bật hold shadow, đọc gateway hai lần và đọc `/teaching/state`:
held bằng 2 trong khi hai caller đã nhận đủ JSON. Đọc lần ba vẫn nhận primary,
nhưng skipped tăng. Gửi hold false rồi drain: active về 0. Nếu không release,
deadline mirror cũng đưa active về 0 và shadow quan sát client đóng kết nối.

## Kiểm thử và ranh giới bằng chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/45-traffic-shadowing/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/45-traffic-shadowing/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit test kiểm tra schema/comparator, hai permit/drop, success/rejection/throw
đều release và counter saturation. HTTP tests chạy các **tiến trình độc lập**,
cổng loopback tạm và deadline từng request; không listener ở top-level test.
Barrier `held=2` cùng việc caller đã đọc xong body chứng minh nonblocking;
không lấy thời gian chạy nhanh làm bằng chứng. Một upstream fixture process được
tái sử dụng cho lỗi schema, byte, chậm, redirect và outage, reset counter mỗi case.
Fixture oversize giữ nguyên schema/id. Test redirect kiểm tra sink không nhận call.
Tests cũng kiểm tra controls tắt và import trong child với cấu hình cố ý sai nhưng
vẫn exit 0 im lặng. Các child được dọn trong finally; held có release và deadline.
Không cần scratch database/file; nếu thêm fixture ghi file hãy dùng `node:os`
`tmpdir()`, không ghi source vì controller có thể mount source read-only.

Worker không có network chỉ chạy typecheck và unit; controller phải chạy HTTP
integration và toàn bộ check/make trong Docker cô lập. Không suy diễn HTTP đã qua
chỉ từ unit GREEN.

## Khi nào dùng và điều gì chưa biết

Shadowing giữ **toàn bộ quyết định trả dữ liệu** ở primary. Canary routing chuyển
một tỷ lệ caller sang bản mới nên lỗi bản mới ảnh hưởng caller đó. Hedged reads
chạy các nhánh cạnh tranh để chọn một kết quả sớm; ở đây shadow tuyệt đối không
thắng primary. Quan sát không chứng minh khả năng thay thế trong mọi tình huống.

GET vẫn có thể ghi analytics, tạo session, làm nóng cache hoặc kích hoạt nghiệp
vụ ở downstream. Chỉ mirror khi đã kiểm toán side effect và cô lập môi trường
shadow; tên HTTP method không phải bảo đảm an toàn. Không dùng bài này cho thanh
toán thật. Allowlist giảm rò rỉ PII nhưng chính id sản phẩm cũng có thể nhạy cảm;
phải đánh giá quyền truy cập, dữ liệu nguồn và chính sách lưu giữ trước khi áp dụng.

Mỗi mirror tốn thêm CPU/kết nối/database read. Permit 2 chỉ giới hạn gateway này,
không phải quota toàn cụm; khi scale gateway, tổng tải tăng. Bản học thử mirror mọi
read được nhận permit; production cần sampling, ngân sách riêng và theo dõi tỷ lệ
skipped để tránh kết luận từ mẫu thiên lệch. Counter trong RAM không phải hệ metrics
bền vững. Chỉ so id/price/currency không giải thích nguyên nhân lệch, không so độ trễ,
độ mới, quyền truy cập hay các semantics khác. Những hệ có dữ liệu thay đổi đồng
thời cần version/snapshot phù hợp để phân biệt lỗi logic với đọc khác thời điểm.

## Bài tập

1. Thêm sampling xác định từ id, không thêm dữ liệu nhận diện vào stats; chứng
   minh sampling không thay đổi primary result và không vượt hai permit.
2. Thiết kế comparison có version cho nguồn giá thay đổi liên tục; nêu cách xử lý
   khác version thay vì đếm mọi khác biệt là lỗi bản mới.
3. Thử primary trả redirect trong fixture: giải thích vì sao dù shadow khỏe vẫn
   phải trả 502 và sink không được nhận request.
4. Thiết kế shutdown có thời gian grace quan sát riêng mà vẫn không để mirror
   giữ process sống vô hạn; viết barrier test trước khi thay code.

Tham khảo: [Envoy route mirroring sandbox](https://www.envoyproxy.io/docs/envoy/latest/start/sandboxes/route-mirror).
