# 22 — Optimistic concurrency với ETag và If-Match

Hai biên tập viên cùng đọc bản mô tả ban đầu. A sửa thành “Giao trước 17h”,
B sửa thành “Nhận tại quầy”. Nếu chỉ UPDATE theo ID, người ghi sau âm thầm
xóa sửa đổi của người trước. Bài này buộc mỗi lần ghi mang phiên bản đã đọc:
chỉ một lần ghi thắng; người còn lại nhận 412 và tự quyết định cách sửa lại.

## Điều kiện và kiến trúc

Cần Node.js **24.12+**, nhánh 24, và bộ dev dependencies đã cài ở root.
Không cần package runtime, credential hoặc dịch vụ ngoài. Đây là phần tiếp theo
của HTTP contract, service-owned persistence và deadline; không cần chạy bài cũ.

```text
editor A (HTTP process) ──┐
                        ├── owner (HTTP process) ── SQLite riêng
editor B (HTTP process) ──┘
```

Chỉ owner mở database; editor không đọc file SQLite. Mỗi editor là một HTTP
service độc lập, chuyển GET/PUT/PATCH tới owner với deadline, không cache,
không retry. Có thể dùng curl như giao diện của người biên tập. Bài tái sử dụng
`../../lib/http.mts` và test harness `../../../test/support.mts` trong repository,
không phụ thuộc việc chạy service của bài khác.

`model.mts` chứa parser, validation và store; `owner.mts` chứa HTTP boundary;
`client.mts` chứa editor. Import không đọc cấu hình, mở database, đăng ký signal
hay listen; mọi hoạt động đó nằm trong main, được chặn bởi `import.meta.main`.
Unit test import trong child với cấu hình cố ý sai phải thoát 0 và im lặng.

## Chạy thử bằng các tiến trình riêng

Từ root repository, terminal owner:

```sh
DB_PATH=/tmp/lesson22-owner.sqlite PORT=3022 node lessons/22-optimistic-concurrency/owner.mts
```

Hai terminal khác:

```sh
OWNER_URL=http://127.0.0.1:3022 PORT=3023 node lessons/22-optimistic-concurrency/client.mts
OWNER_URL=http://127.0.0.1:3022 PORT=3024 node lessons/22-optimistic-concurrency/client.mts
```

Mỗi service in một dòng JSON readiness chứa port thực tế. Lấy ETag qua
hai editor trước khi ghi:

```sh
curl --max-time 3 -i http://127.0.0.1:3023/resource
curl --max-time 3 -i http://127.0.0.1:3024/resource
curl --max-time 3 -i -X PUT http://127.0.0.1:3023/resource -H 'Content-Type: application/json' -H 'If-Match: "v1"' --data '{"value":"Giao trước 17h"}'
curl --max-time 3 -i -X PATCH http://127.0.0.1:3024/resource -H 'Content-Type: application/json' -H 'If-Match: "v1"' --data '{"value":"Nhận tại quầy"}'
```

Với database mới, cả hai GET trả `{"value":"initial","version":1}`,
ETag `"v1"`. PUT trả 200, version 2; PATCH sau đó trả 412.
GET lại rồi **chủ động** sửa nội dung theo thông tin mới, gửi `If-Match: "v2"`.
Không gắn ETag mới vào cùng mutation rồi tự động gửi lại: như vậy vẫn có thể
ghi đè ý định của người khác. Dừng owner và chạy lại cùng DB_PATH để thấy
giá trị/version được giữ nguyên. Database đã tồn tại có thể không bắt đầu ở v1.

### Cấu hình

| Biến | Tiến trình | Hợp đồng |
| --- | --- | --- |
| DB_PATH | owner | Bắt buộc; thư mục cha phải tồn tại; production demo dùng file, không dùng :memory: |
| OWNER_URL | editor | Bắt buộc; HTTP origin 127.0.0.1, không path/query/credential |
| DEADLINE_MS | editor | Số nguyên 10..5000, mặc định 500; gồm nhận response body |
| PORT | cả hai | 0..65535; mặc định owner 3022, editor 3023; 0 chọn port tạm |
| HOST | cả hai | Mặc định 127.0.0.1; giữ loopback khi chạy bài |

Cấu hình sai làm startup thất bại; readiness chỉ xuất hiện sau listen.
SIGTERM/SIGINT đóng listener, cưỡng đóng connection sau 1 giây, owner đóng
SQLite khi server đóng. Không background poll hay mutation tự phát.

## Hợp đồng HTTP có chủ ý giới hạn

Chỉ có một resource cố định `/resource`, luôn tồn tại. GET trả 200, JSON và
strong ETag `"vN"`. Mọi mutation thành công trả 200 cùng representation mới,
tăng version đúng một. PUT và PATCH đều nhận đúng `{"value":string}`;
PATCH ở đây thay trường value duy nhất, **không phải JSON Patch/Merge Patch**.
Chuỗi 1..200 UTF-16 code units, không chỉ whitespace; giữ nguyên khoảng trắng.
Extra fields, array, null, số, JSON lỗi đều bị từ chối.

| Trường hợp | Status / code |
| --- | --- |
| Thiếu If-Match | 428 / precondition_required |
| Weak ETag, wildcard, danh sách, duplicate field, sai cú pháp hoặc quá giới hạn | 400 / invalid_if_match |
| Body không hợp lệ | 400 / invalid_value hoặc invalid_json |
| Version hợp lệ nhưng cũ | 412 / version_conflict |
| Version hiện tại đã đạt 9007199254740991 | 409 / version_exhausted |
| Không phải application/json | 415 / unsupported_media_type |
| Body vượt 8192 bytes | 413 / body_too_large |
| Sai route / method | 404 / 405, 405 có Allow |
| Editor không kết nối được owner | 503 / owner_unavailable |
| Editor hết deadline | 504 / owner_deadline |
| Lỗi nội bộ, kể cả SQLite bận quá 200ms | 500 / internal_error |

Response lỗi có `{"error":{"code":"…","message":"…"}}`; mọi response
không cache. Precondition header được kiểm tra trước body, body trước compare
version. Khi nhiều lỗi cùng tồn tại, thứ tự này quyết định status.
Với body hợp lệ, stale version luôn 412, kể cả khi version hiện tại đã cạn.

Chỉ chấp nhận **một strong version ETag** dạng canonical `"v[1-9][0-9]*"`,
N là safe integer 1..9007199254740991. HTTP parser có thể bỏ whitespace ngoài
field value; parser ứng dụng không tự chuẩn hóa token. `W/"v1"`, `*`,
`"v1", "v2"`, `"v01"` đều bị loại. Không hỗ trợ If-None-Match,
If-Unmodified-Since, conditional GET/304, nhiều resource hoặc toàn bộ quy tắc
conditional request của RFC. Đây là profile API hẹp, không phải triển khai đầy
đủ RFC. Strong ETag có nghĩa vì byte JSON cố định theo value/version và không
có writer nào được phép đổi value mà giữ version. Không sửa DB bằng công cụ
ngoài hay thay file bằng bản cũ khi client còn giữ ETag.

## Vì sao không mất cập nhật?

Store mở `BEGIN IMMEDIATE`, đọc version trong transaction, kiểm tra cạn version,
rồi `UPDATE ... WHERE id=1 AND version=? RETURNING ...`. SQLite serialize các
writer; so sánh và ghi value/version nằm cùng transaction. Request thất bại
rollback, validation chạy trước transaction. Không có khoảng trống “kiểm tra
xong rồi writer khác chen vào” giữa compare và commit.

Version chỉ tăng sau commit thành công, không wrap hay mất độ chính xác số.
SQLite WAL lưu dữ liệu trên đĩa, restart không đặt lại version. Transaction
ngắn, synchronous SQLite chặn event loop trong thời gian thực thi; đây là ví
dụ owner nhỏ, không phải giải pháp throughput cao. Mỗi database chỉ thuộc một
owner deployment; bài không triển khai replication/failover.

412 là kết quả chắc chắn mutation đó không được áp dụng. Ngược lại timeout,
503 sau mất kết nối, hoặc crash trước khi nhận response có thể để lại kết quả
**không rõ**: owner có thể đã commit. Abort fetch không rollback server.
Editor không tự gửi lại; hãy GET và đối chiếu trước khi người dùng quyết định.
GET cũng có thể thất bại khi owner ngừng hoạt động.

Optimistic concurrency phát hiện ghi dựa trên trạng thái cũ. Idempotency nhận
diện cùng một yêu cầu lặp để tránh thực thi hai lần; hai cơ chế có thể kết hợp
nhưng không thay thế nhau. Distributed lock phối hợp quyền truy cập giữa các
tiến trình và cần lease/fencing; ở đây client không giữ lock khi người dùng
suy nghĩ. SQLite vẫn dùng lock nội bộ trong transaction ngắn. Không có
transaction xuyên service: hai owner khác nhau không commit nguyên tử nhờ
If-Match; cần thiết kế riêng như saga nếu nghiệp vụ yêu cầu.

## Kiểm chứng

Từ root, không cần listener cho unit tests:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/22-optimistic-concurrency/test/lesson.test.mts
```

Unit tests dùng SQLite in-memory: parser weak/wildcard/list/bounds, winner/stale,
invalid input không đổi dữ liệu và cạn version. Quá trình xây bài đã quan sát
assertion RED với stub (parser trả 0 thay vì 1, update không đổi dữ liệu), sau
đó thay bằng implementation và chạy GREEN.

Chạy khi môi trường cho phép loopback HTTP (controller cô lập):

```sh
node --test --test-timeout=15000 lessons/22-optimistic-concurrency/test/lesson.test.mts
npm run check
make test
git diff --check
```

Integration dùng child owner + hai child editor, port 0, database trong
`node:os.tmpdir()` để source có thể read-only. Barrier chỉ mở khi hai GET đã
xong; kiểm tra đúng một 200, một 412, winner và version tăng đúng một, restart
giữ trạng thái, GET/revise có chủ ý, header/body lỗi không ghi, dependency chết
503 và owner treo 504 với đúng một lần gửi mutation. Request có deadline,
test có timeout, finally dừng child và xóa database tạm.

Worker không chạy HTTP integration, npm run check hoặc make test vì sandbox
không cho network; controller phải chạy chúng. Không diễn giải typecheck hay
unit pass thành bằng chứng integration pass.

## Bài tập

1. Thêm một trường nghiệp vụ và giải thích vì sao mọi thay đổi representation
   đều phải tăng version.
2. Thiết kế UI hiển thị bản của tôi/bản hiện tại khi gặp 412, yêu cầu người dùng
   xác nhận nội dung hợp nhất.
3. Thảo luận dùng idempotency key cùng If-Match khi response ghi bị mất:
   cần lưu gì để trả lại kết quả cũ mà không ghi lần nữa?
4. Thiết kế version token có generation nếu cần restore backup trong lúc client
   vẫn giữ token cũ; vì sao chỉ reset số version về 1 là nguy hiểm?

## Nguồn

- [RFC 9110 §13.1.1 — If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1):
  strong comparison và điều kiện mutation.
- [RFC 6585 §3 — 428 Precondition Required](https://www.rfc-editor.org/rfc/rfc6585.html#section-3):
  yêu cầu client gửi precondition để tránh lost update.
- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html):
  DatabaseSync và prepared statements.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html):
  BEGIN IMMEDIATE và cạnh tranh writer.
