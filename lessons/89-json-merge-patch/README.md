# 89. Cập nhật tài liệu với JSON Merge Patch

Hai client đọc cùng một hồ sơ, rồi lần lượt gửi thay đổi. Nếu cả hai dựa vào
cùng một bản, store chỉ chấp nhận bản ghi thay đổi đến trước. Client còn lại
nhận `412` và có thể đọc lại hồ sơ trước khi quyết định có gửi patch mới hay
không. Bài này dùng JSON Merge Patch để mô tả phần thay đổi và `If-Match` để
chỉ rõ phiên bản mà client đã đọc.

## Hai tiến trình

```text
curl ── HTTP/1 ──> gateway :4089 ── HTTP/1 ──> store :3089 ──> SQLite
```

- `store.mts` sở hữu một hàng trong SQLite. Hồ sơ khởi tạo là
  `{"name":"Ada","tags":[]}` ở phiên bản `0`. Store quyết định hiệu lực của
  patch và phát hành ETag.
- `gateway.mts` kiểm tra request tại biên, gửi đúng một lần đến store và kiểm tra
  cả HTTP headers lẫn nội dung phản hồi. Gateway không cần đọc trước để dự
  đoán hồ sơ sau merge. Store là nơi duy nhất biết bản đang được sửa.
- `merge.mts` thực hiện phép merge thuần trên giá trị JSON. `contract.mts`
  áp ràng buộc hồ sơ và phiên bản lên kết quả của phép merge.

## Chạy từ thư mục gốc của repo

Dùng Node.js **24.12.0 trở lên trong nhánh 24.x** và Bash. Runtime chỉ dùng
module có sẵn trong Node.js, bao gồm `node:sqlite`. Cài các công cụ phát triển
đã ghim bằng `npm ci` nếu cần chạy typecheck và kiểm thử toàn repo.

Terminal 1 chạy store với một tệp SQLite riêng. Dừng store bằng Ctrl+C. Thư
mục tạm được dọn khi khối lệnh thoát.

```bash
(
  db_dir=$(mktemp -d) || exit 1
  trap 'rm -rf -- "$db_dir"' EXIT
  DB_PATH="$db_dir/profile.sqlite" node lessons/89-json-merge-patch/store.mts
)
```

Terminal 2 chạy gateway.

```bash
STORE_ORIGIN=http://127.0.0.1:3089 node lessons/89-json-merge-patch/gateway.mts
```

Terminal 3 đọc hồ sơ, cập nhật hai lần và thử gửi lại ETag cũ. Chạy các lệnh
theo thứ tự với một DB mới.

```bash
curl -i http://127.0.0.1:4089/profile

curl -i -X PATCH http://127.0.0.1:4089/profile \
  -H 'Content-Type: application/merge-patch+json' \
  -H 'If-Match: "v0"' \
  --data-binary '{"name":"Grace","tags":["node","sqlite"],"note":"learning"}'

curl -i -X PATCH http://127.0.0.1:4089/profile \
  -H 'Content-Type: application/merge-patch+json' \
  -H 'If-Match: "v1"' \
  --data-binary '{"tags":["http"],"note":null}'

curl -i -X PATCH http://127.0.0.1:4089/profile \
  -H 'Content-Type: application/merge-patch+json' \
  -H 'If-Match: "v1"' \
  --data-binary '{"name":"Lin"}'
```

Lệnh đầu trả `200` và `ETag: "v0"`. PATCH thứ nhất trả `"v1"`. PATCH thứ
hai thay toàn bộ mảng `tags`, xóa `note` và trả
`{"name":"Grace","tags":["http"]}` cùng `"v2"`. Lệnh cuối trả
`412 precondition_failed`. Để thử khởi động lại và giữ dữ liệu, dùng cùng
đường dẫn `DB_PATH` trong một thư mục riêng mà bạn giữ lại.

| Biến | Tiến trình | Giá trị |
| --- | --- | --- |
| `DB_PATH` | Store | Bắt buộc. Đường dẫn tệp SQLite do store sở hữu. |
| `PORT` | Cả hai | Mặc định `3089` cho store và `4089` cho gateway. `0` yêu cầu hệ điều hành cấp cổng. |
| `STORE_ORIGIN` | Gateway | Mặc định `http://127.0.0.1:3089`. Chấp nhận HTTP trên địa chỉ IPv4 literal `127.0.0.1`, cổng tùy chọn từ 1 đến 65535 và tối đa một dấu `/` cuối. |

Cả hai chỉ lắng nghe trên `127.0.0.1` và in một dòng readiness dạng
`{"service":"store","port":3089}` hoặc `{"service":"gateway","port":4089}`
sau khi đã bind.

## Hợp đồng HTTP

- `GET /profile` trả `200`, ETag mạnh và hồ sơ JSON trực tiếp. GET không nhận
  request body. Đường dẫn này không nhận query.
- `PATCH /profile` nhận `application/merge-patch+json` với tham số tùy chọn
  duy nhất là `charset=utf-8`. Tên media và charset không phân biệt hoa
  thường. Charset có thể đặt trong dấu ngoặc kép. Content coding phải vắng
  mặt hoặc là một giá trị `identity`.
- PATCH nhận đúng một `If-Match` mạnh dạng `"v0"` đến `"v16"`. Đây là
  giới hạn riêng của bài. Cú pháp tổng quát của HTTP còn có danh sách và
  wildcard.
- Hồ sơ cuối có đúng `name`, `tags` và có thể có `note`. `name` gồm 1–32
  ký tự ASCII in được. `tags` có tối đa 8 chuỗi phân biệt, mỗi chuỗi gồm 1–16
  chữ ASCII thường. `note` gồm 1–64 ký tự ASCII in được.
- PATCH thành công trả `200`, hồ sơ và ETag. Bản thay đổi tăng đúng một
  phiên bản. Nếu hồ sơ bằng bản hiện tại theo giá trị JSON, ETag giữ nguyên
  ngay cả ở `"v16"`. Thứ tự thuộc tính object không ảnh hưởng phép so sánh.
  Thứ tự phần tử mảng có ảnh hưởng.

Lỗi ở tầng ứng dụng có dạng `{"error":{"code":"invalid_body","message":"invalid_body"}}`,
với `message` bằng `code`. Lỗi cú pháp HTTP hoặc header quá lớn có thể
bị Node.js từ chối ngay tại parser.

| Trạng thái | Mã | Điều kiện |
| --- | --- | --- |
| 400 | `invalid_query`, `invalid_body`, `invalid_json`, `invalid_precondition` | Có query, GET kèm body, số JSON không hữu hạn, JSON hoặc UTF-8 lỗi, hoặc `If-Match` sai dạng. |
| 404 | `not_found` | Đường dẫn không tồn tại. |
| 405 | `method_not_allowed` | Sai phương thức trên `/profile`. Có `Allow: GET, PATCH`. |
| 408 | `body_timeout` | Body của request không hoàn tất trong ngân sách 500 ms từ lúc handler bắt đầu. |
| 409 | `revision_exhausted` | Bản sửa hợp lệ sẽ làm thay đổi hồ sơ đang ở phiên bản 16. |
| 412 | `precondition_failed` | ETag hợp lệ nhưng đã cũ. |
| 413 | `body_too_large` | Vượt ngân sách byte hoặc độ phức tạp JSON. |
| 415 | `unsupported_media_type` | Media hoặc content coding thiếu khi bắt buộc, sai hoặc có trường lặp. |
| 422 | `invalid_document` | Kết quả merge vi phạm schema của hồ sơ. |
| 428 | `precondition_required` | PATCH thiếu `If-Match`. |
| 500 | `internal_error` | Lỗi nội bộ tại tiến trình xử lý. |
| 502 | `upstream_failure` | Gateway nhận lỗi kết nối, quá hạn, phản hồi thiếu hoặc vi phạm hợp đồng store. |
| 503 | `busy` | Gateway đã có 8 lượt gọi store đang mở. Request này không tạo kết nối mới. |

## Merge, giao dịch và giới hạn

Theo RFC 7396, một JSON object mô tả thay đổi theo tên thành viên. Giá trị
`null` tại một thành viên xóa thành viên đó, object con được merge đệ quy và
mảng được thay nguyên mảng. Thành viên vắng trong patch được giữ nguyên.
Patch có gốc là mảng, chuỗi, số, boolean hoặc `null` thay cả tài liệu.
Ví dụ `{"note":null}` xóa riêng ghi chú, còn `null` thay cả hồ sơ và bị
schema từ chối với `422` nếu ETag đang đúng. Bài 22 dùng JSON Patch, nơi
client gửi một mảng thao tác có đường dẫn JSON Pointer.

Store kiểm tra cú pháp và giới hạn của request trước khi mở giao dịch
`BEGIN IMMEDIATE`. Trong giao dịch, store đọc phiên bản, so `If-Match`,
merge, kiểm tra schema, rồi so sánh giá trị JSON. Nếu có thay đổi, một
`UPDATE ... WHERE version = ?` ghi cả tài liệu và phiên bản. SQLite commit
trước khi store trả thành công. Lỗi trong giao dịch dẫn tới rollback. Hai
PATCH làm thay đổi cùng một ETag sẽ có một request nhận `200` và một
request nhận `412`.

Mỗi tài liệu gốc, patch và kết quả có độ sâu tối đa 8 tính từ gốc ở độ sâu 0
và tối đa 128 node, gồm cả container lẫn giá trị lá. Request và phản hồi từ
store tối đa 8192 byte body trên đường truyền. Kết quả merge cũng bị
giới hạn 8192 byte sau khi serialize sang UTF-8. Patch có 127 thành viên mới
có đúng 128 node, nhưng kết quả giữ thêm `name` và `tags` nên bị chặn với
`413` trước khi kiểm schema. Các tên như `__proto__` được xử lý như khóa
JSON riêng. Bộ merge tạo bản sao và chỉ duyệt thành viên riêng có thể liệt
kê.

Gateway dùng `node:http.request` cho một kết nối duy nhất mỗi lượt gọi, với
giới hạn 8192 byte header và kiểm tra trường lặp trước khi dùng giá trị.
Gateway gửi nguyên body PATCH đã kiểm tra, vì `null` là một phần quan
trọng của phép merge. Phản hồi `200` từ store cần đúng schema và đúng một
ETag hợp lệ. Khi trả lời PATCH, phiên bản phải bằng bản trong `If-Match`
hoặc tăng đúng một. Chỉ PATCH mới được chuyển tiếp các lỗi `412`, `422`,
`409` và `413` với đúng mã và envelope theo bảng. Các phản hồi ngoài hợp
đồng, kể cả `421` và chuyển hướng, dẫn tới `502`.

Ngân sách outbound 500 ms tính từ lúc bắt đầu gọi đến khi nhận hết thông
điệp HTTP. Header, byte body cuối và thông tin kết thúc body cùng dùng
ngân sách đó. Gateway không thử lại, theo redirect, dùng proxy hay tự giải
nén. Cửa sổ 8 lượt gọi không có hàng chờ. Gateway hủy lượt gọi khi kết nối
với client đóng sớm hoặc khi gateway dừng. Store vẫn đọc DB cục bộ trực tiếp.

## Đánh đổi và bài tập

- Xóa thành viên bằng `null` khiến Merge Patch khó biểu diễn yêu cầu gán
  thành viên đó thành giá trị JSON `null`. Mảng nhỏ dễ thay nguyên khối.
  Với mảng lớn hoặc nhiều chỉnh sửa độc lập theo vị trí, hãy phân tích chi
  phí gửi cả mảng và khả năng xung đột.
- ETag phiên bản đơn giản trong phạm vi một hồ sơ. Bài cố ý dừng ở phiên bản
  16 để quan sát trường hợp hết phiên bản. Trong hệ thống nhiều hồ sơ, thiết
  kế phạm vi định danh ETag và chiến lược sao lưu sao cho một ETag cũ không
  vô tình khớp với tài liệu khác.
- Dùng hai terminal gửi PATCH thay đổi khác nhau trên cùng một ETag. Quan
  sát `200` và `412`, đọc lại hồ sơ rồi quyết định có áp dụng thay đổi còn
  thiếu trên phiên bản mới hay không.
- Quan sát trường hợp store đã commit nhưng client mất kết nối trước khi
  nhận `200`. Thiết kế cách đối chiếu lại với GET trước khi người dùng gửi
  PATCH lần nữa.
- Bài dùng loopback và không có xác thực. Nếu đưa thiết kế ra ngoài máy
  cục bộ, xác định quyền đọc và quyền sửa hồ sơ trước khi chọn cơ chế xác
  thực, cách cấp ETag và ngân sách kết nối.

## Kiểm thử

```bash
npm run typecheck
npm run test:unit
node --test --test-concurrency=2 lessons/89-json-merge-patch/test/*.test.mts
```

Các test `integration:` cần quyền mở kết nối loopback. Chúng dựng các tiến
trình riêng với cổng tạm và dọn tiến trình cùng thư mục SQLite sau mỗi
kịch bản. Test kiểm tra cập nhật đồng thời, dữ liệu sau restart, phản hồi
peer ngoài hợp đồng, redirect không chạm máy đích và từ chối lượt gọi thứ
chín khi tám lượt còn đang xử lý.

## Tài liệu tham khảo

- [RFC 7396, JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html)
- [RFC 5789, PATCH Method for HTTP](https://www.rfc-editor.org/rfc/rfc5789.html)
- [RFC 9110 §13.1.1, If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)
