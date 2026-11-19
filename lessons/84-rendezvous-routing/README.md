# Rendezvous hashing, thay đổi membership và định tuyến ổn định

Một router nhận khóa `k0` đến `k63` và tính backend sở hữu khóa theo
*rendezvous hashing*, hay *highest random weight* (HRW). Thử bỏ backend `b`
khỏi tập đang hoạt động. Những khóa trước đó thuộc `a` hoặc `c` vẫn về đúng
backend cũ. Các khóa thuộc `b` được chia lại cho hai backend còn lại.

## Kiến trúc

```text
PUT /membership ──► router ──► SQLite riêng (một dòng chứa revision và members)
GET /route/k0 ────► router ──► GET /lookup/k0 trên đúng một backend
                                 a, b hoặc c tùy snapshot
```

Chạy bốn tiến trình Node.js độc lập. Router đọc ba địa chỉ backend khi khởi
động và giữ nguyên chúng trong suốt vòng đời tiến trình. Một lần đổi
membership chỉ thay tập ID được phép tham gia tính điểm. Backend phục vụ
giá trị mẫu `<member>/<key>` và giữ bộ đếm lookup trong bộ nhớ. SQLite của
router lưu cấu hình định tuyến qua lần khởi động lại.

## Chạy tại máy

Cần Node.js 24 từ 24.12.0 trở lên và `curl`. Runtime chỉ dùng module có sẵn
trong Node.js. Chạy các lệnh sau từ thư mục gốc của repository, mỗi khối
trong một terminal.

### Terminal A

```sh
HOST=127.0.0.1 PORT=8481 MEMBER_ID=a node lessons/84-rendezvous-routing/backend.mts
```

### Terminal B

```sh
HOST=127.0.0.1 PORT=8482 MEMBER_ID=b node lessons/84-rendezvous-routing/backend.mts
```

### Terminal C

```sh
HOST=127.0.0.1 PORT=8483 MEMBER_ID=c node lessons/84-rendezvous-routing/backend.mts
```

### Terminal router

Giữ terminal này để có thể dừng và chạy lại `run_router` với cùng tệp dữ liệu.

```sh
router_dir=$(mktemp -d) || exit 1
trap 'rm -f -- "$router_dir/membership.sqlite" "$router_dir/membership.sqlite-journal"; rmdir -- "$router_dir"' EXIT
run_router() {
  HOST=127.0.0.1 PORT=8480 DB_PATH="$router_dir/membership.sqlite" \
    MEMBER_A_ORIGIN=http://127.0.0.1:8481 \
    MEMBER_B_ORIGIN=http://127.0.0.1:8482 \
    MEMBER_C_ORIGIN=http://127.0.0.1:8483 \
    node lessons/84-rendezvous-routing/router.mts
}
run_router
```

Mỗi tiến trình in một dòng JSON chứa `service` và `port` khi đã lắng nghe.
`HOST` mặc định là `127.0.0.1`, còn `PORT` mặc định là `8080` cho router
và `8081` cho backend. Đặt `PORT=0` để hệ điều hành cấp cổng rảnh, sau đó
dùng cổng thực từ dòng JSON khi gọi dịch vụ hoặc cấu hình origin của router.
Các origin phải là HTTP trên địa chỉ `127.0.0.1`, có thể có dấu `/` cuối
và phải khác nhau sau chuẩn hóa. `DB_PATH` là đường dẫn tệp SQLite dành
riêng cho router, trong thư mục đã tồn tại và có quyền ghi. Chạy `Ctrl+C`
để dừng tiến trình.

## Quan sát khóa di chuyển

Từ terminal khác, truy vấn `k0` và `k4` ở revision 0.

```sh
curl -sS http://127.0.0.1:8480/route/k0
curl -sS http://127.0.0.1:8480/route/k4
curl -sS http://127.0.0.1:8482/stats
```

Kết quả tương ứng có owner `b` và `c`. Bộ đếm của `b` là
`{"requests":1}` nếu chưa gọi thêm lookup. Sau đó gửi tập mới `["c","a"]`.

```sh
curl -sS -X PUT http://127.0.0.1:8480/membership \
  -H 'content-type: application/json' -d '{"members":["c","a"]}'
curl -sS http://127.0.0.1:8480/route/k0
curl -sS http://127.0.0.1:8480/route/k4
curl -sS http://127.0.0.1:8482/stats
```

Lệnh PUT trả `{"revision":1,"members":["a","c"]}`. `k0` chuyển sang
`a` với giá trị `a/k0`, còn `k4` giữ owner `c`. Bộ đếm của `b` vẫn
là 1. Gửi lại cùng tập theo thứ tự bất kỳ để quan sát revision vẫn bằng
1. Ở terminal router, dừng bằng `Ctrl+C` rồi chạy lại `run_router`. Cùng
hai truy vấn vẫn trả revision 1 và cùng owner. Để quan sát lỗi, dừng
backend `a` rồi gọi `k0` với `curl -i`. Router trả 502 và membership
vẫn là `["a","c"]`. Một lệnh PUT với `{"members":["c"]}` sẽ cho các
lookup mới đi tới `c`.

## Hợp đồng HTTP

| Dịch vụ | Yêu cầu | Thành công |
| --- | --- | --- |
| Router | `PUT /membership`, JSON `{"members":[...]}` | 200 `{revision,members}` |
| Router | `GET /route/{key}` | 200 `{revision,members,owner,key,value}` |
| Backend | `GET /lookup/{key}` | 200 `{member,key,value}` |
| Backend | `GET /stats` | 200 `{requests}`, đếm lookup hợp lệ từ lúc backend khởi động |

Mọi endpoint dùng đường dẫn chuẩn, không kèm query. Các GET không nhận
body. Khóa là chữ `k` theo sau bởi số nguyên từ 0 đến 63, viết trực tiếp
trong URL, không có số 0 ở đầu, chữ hoa hay mã hóa phần trăm. PUT cần
`Content-Type: application/json`, tối đa 8192 byte. Object phải có đúng
trường `members`, chứa từ một đến ba ID khác nhau thuộc `a`, `b`, `c`.
Router lưu và trả về danh sách đã sắp xếp theo ASCII.

Lỗi được trả dưới dạng `{"error":{"code":"...","message":"..."}}` với
`message` bằng `code`.

| Status | Code | Điều kiện |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_key`, `invalid_membership`, `invalid_json` | Query hoặc body GET, khóa, schema hoặc cú pháp JSON không hợp lệ |
| 404 | `not_found` | Đường dẫn chưa được định nghĩa |
| 405 | `method_not_allowed` | Sai method trên endpoint đã định nghĩa, kèm header `Allow` |
| 409 | `revision_exhausted` | Tập mới khác tập hiện tại và revision đã là 16 |
| 413 | `body_too_large` | JSON gửi đến router vượt 8192 byte |
| 415 | `unsupported_media_type` | PUT thiếu kiểu nội dung JSON |
| 500 | `internal_error` | Lỗi nội bộ, chẳng hạn thao tác SQLite thất bại |
| 502 | `upstream_failure` | Backend được chọn không trả kết quả hợp lệ trong giới hạn |

## Vì sao placement ổn định

Với mỗi member trong snapshot, mã hóa chuỗi `${key}:${member}` theo UTF-8,
tính SHA-256 rồi biểu diễn kết quả bằng 64 ký tự hex thường. Chọn điểm lớn
nhất theo thứ tự từ điển. Vì các điểm có cùng độ dài, thứ tự này tương
ứng với thứ tự của giá trị số. Khi hai điểm bằng nhau, ID nhỏ hơn theo
ASCII thắng, nên đổi thứ tự liệt kê các member cũng giữ nguyên kết quả.

Điểm của một cặp khóa và member giữ nguyên qua các revision. Khi loại một
member, mọi owner còn lại vẫn có điểm cao nhất trong tập mới nếu trước đó
đã thắng. Khi thêm một member, chỉ member mới có thể vượt qua owner cũ.
Có thể đối chiếu với phép lấy `SHA256(key) % N` để chọn một chỉ số trong
danh sách đã sắp xếp. Với `k2` trong ví dụ kiểm thử, modulo chọn `c` với
`[a,b,c]` rồi chọn `a` với `[a,c]` dù `c` vẫn còn hoạt động. Kết quả
này minh họa một lần đổi mapping, còn độ cân bằng tải phụ thuộc workload.

HRW ở đây quét `N` member, gọi hash `N` lần và giữ ứng viên tốt nhất
trong bộ nhớ phụ `O(1)`. Bài 36 đặt virtual node trên vòng hash và tìm
điểm kế tiếp theo chiều kim đồng hồ. HRW dùng trực tiếp ID member, nên
không cần vòng hay bảng virtual node. [Bài 36](../36-consistent-hashing/README.md)

## Snapshot, lỗi và giới hạn

- Ban đầu SQLite chứa `[a,b,c]` ở revision 0. Một transaction đọc dòng
  hiện tại, so sánh với tập đã chuẩn hóa và ghi membership cùng revision
  trong một thay đổi nguyên tử. Lỗi ghi rollback cả hai. PUT lặp cùng
  tập là no-op kể cả tại revision 16.
- Một GET chụp snapshot đã commit trước khi gọi HTTP. Nếu revision 1
  được commit khi GET ở revision 0 đang chờ backend `b`, GET đó vẫn
  kiểm tra và trả kết quả của `b` với revision 0. GET mới chụp
  revision 1. Các client hoặc router tự tính placement cần cùng revision,
  cùng tập member, cùng cấu hình ID và cùng thuật toán.
- Mỗi lookup gửi đúng một GET trực tiếp đến origin đã cấu hình của
  owner qua `node:http`, độc lập với proxy từ biến môi trường. Router
  chặn redirect và trả 502 ngay khi gặp status ngoài 200, kể cả 421.
  Một deadline monotonic 500 ms bao gồm thời gian chờ headers, đọc body
  đến hết và kiểm tra kết quả. Router giới hạn headers ở 8192 byte và
  kiểm tra tất cả các trường trong giới hạn này. `Content-Type` phải là
  một kiểu `application/json` hợp lệ. Router chỉ chấp nhận body JSON
  UTF-8 với encoding vắng mặt hoặc `identity`, tối đa 8192 byte và đúng
  ba trường cùng member, key và giá trị dự kiến. Body còn mở vẫn có thể
  vượt giới hạn byte hoặc hết deadline, ngay cả khi đã nhận đủ một object JSON.
- Sự cố backend cần một thay đổi membership tường minh từ người điều
  hành. Bài học không có health check tự động, retry hay fallback. Tập
  membership, state và revision ở đây thuộc một router đơn lẻ. Demo
  dùng cổng loopback và không có xác thực cho thao tác PUT.
- Mapping chỉ xác định owner. Backend tạo giá trị mẫu tại chỗ, không
  lưu dữ liệu thật. Với dữ liệu thật, hệ thống phải tự tổ chức sao
  chép, chuyển dữ liệu và chuyển giao quyền ghi trước khi đổi tập.
  Bài này không triển khai replica, rebalance dữ liệu hay migration.
- SHA-256 công khai cho phép bên chọn khóa tìm trước khóa rơi vào một
  member. Một khóa nóng cũng dồn tải vào đúng một owner. HRW không biết
  mức tải, dung lượng hay độ khỏe của backend. Ví dụ giới hạn 64 khóa,
  ba member, 16 lần đổi revision và ngân sách upstream cố định để các
  bất biến dễ quan sát.

## Kiểm thử

Chạy các lệnh sau ở thư mục gốc sau khi đã cài dependency phát triển từ lockfile.

```sh
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/84-rendezvous-routing/test/lesson.test.mts
node --test --test-timeout=15000 lessons/84-rendezvous-routing/test/lesson.test.mts
```

Unit test so điểm hash với vector cố định và dùng oracle sắp xếp digest
để kiểm tra cả 64 khóa. Integration test chạy router và backend thành
tiến trình riêng trên cổng tạm, đối chiếu bộ đếm từng backend, khởi động
lại router trên cùng DB và dùng điểm đồng bộ để đổi membership khi một
lookup đang chờ. Các fixture còn kiểm tra backend chỉ nhận một lookup
khi trả 421, đích redirect và proxy nhận 0 lượt, và `Content-Encoding`
vẫn được kiểm tra sau 1100 header ngắn. Các fixture cũng kiểm tra body
đang mở vượt giới hạn byte và JSON hợp lệ vẫn hết deadline khi backend
giữ body mở.

## Bài tập

1. Chọn một khóa thuộc `b` ở revision 0. Tính ba digest bằng Node.js,
   sắp xếp bằng tay rồi dự đoán owner sau khi bỏ `b`.
2. Tạo tải với tần suất truy vấn khác nhau cho 64 khóa. So sánh số khóa
   và số lookup mà mỗi member nhận được.
3. Phác thảo cách xác nhận dữ liệu đã sẵn sàng ở owner mới trước khi
   đổi membership cho một dịch vụ có quyền ghi lên dữ liệu thật.

## Tài liệu gốc

- David G. Thaler và Chinya V. Ravishankar, thiết kế HRW cho việc ánh xạ
  phân tán. [Using Name-Based Mappings to Increase Hit Rates](https://www.eecs.umich.edu/techreports/cse/96/CSE-TR-316-96.pdf)
- Node.js v24, cách tạo digest SHA-256 bằng `createHash`. [Crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
- SQLite, cách transaction thực hiện rollback khi ghi thất bại. [Transaction](https://www.sqlite.org/lang_transaction.html)

Router và backend tắt riêng việc cắt danh sách header theo số trường (`maxHeadersCount = 0`), vẫn giữ giới hạn byte của HTTP parser. Content-Length hoặc Transfer-Encoding ở cuối một loạt header vẫn được kiểm tra; GET có body bị từ chối trước khi gọi backend.
