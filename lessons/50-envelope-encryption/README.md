# 50 — Envelope encryption, AAD và rewrap

Bài này tách hai tiến trình: `vault.mts` giữ dữ liệu mã hóa trong SQLite; `keys.mts`
bọc/mở khóa dữ liệu qua HTTP cục bộ. Mỗi object có một DEK ngẫu nhiên 32 byte.
KEK v1/v2 chỉ bọc DEK; đổi KEK không bắt buộc mã hóa lại nội dung.

**Đây là demo công khai, HTTP không xác thực, không có bí mật sản xuất, cách ly KMS
hay quản lý khóa sản xuất.** Các khóa dưới đây là dữ liệu giáo dục công khai.
Không thay bằng credential thật. Không dùng cho dữ liệu nhạy cảm. Cả người biết
KEK lẫn người truy cập endpoint unwrap đều có thể lấy DEK.

## Điều kiện và chạy

Cần Node.js 24.12+ (nhánh 24), npm và các development package đã pin ở root.
Runtime chỉ dùng built-in: crypto, HTTP, SQLite. Chạy từ root repository.
Không cần Docker, tài khoản cloud hay dịch vụ ngoài cho hai server.

Terminal 1:

```bash
WRAP_KEY_V1=1111111111111111111111111111111111111111111111111111111111111111 \
WRAP_KEY_V2=2222222222222222222222222222222222222222222222222222222222222222 \
TEACHING_CONTROLS=1 HOST=127.0.0.1 PORT=5051 \
node lessons/50-envelope-encryption/keys.mts
```

Terminal 2:

```bash
DB_PATH=/tmp/lesson50-vault.sqlite KEYS_ORIGIN=http://127.0.0.1:5051 \
HOST=127.0.0.1 PORT=5050 node lessons/50-envelope-encryption/vault.mts
```

Chọn đường dẫn DB mới cho mỗi lần thực hành độc lập. SQLite tự tạo bảng, không tự
xóa dữ liệu cũ. `HOST=127.0.0.1 PORT=0` hợp lệ; mỗi tiến trình in một dòng JSON
`{"service":"…","port":…}` sau khi listen. Không ghi plaintext hoặc DEK vào log.
Không đọc cấu hình, mở DB, đăng ký signal hoặc listen khi chỉ import module.
SIGTERM/SIGINT đóng HTTP; vault đóng DB khi server đóng.

Terminal 3:

```bash
curl -sS -H 'content-type: application/json' -d '{"id":"note-1","plaintext":"Hẹn gặp ở thư viện 📚"}' http://127.0.0.1:5050/objects
curl -sS http://127.0.0.1:5050/objects/note-1
curl -sS http://127.0.0.1:5050/envelopes/note-1
curl -sS -H 'content-type: application/json' -d '{"active":"v2","disableV1":false}' http://127.0.0.1:5051/teaching/keys
curl -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:5050/objects/note-1/rewrap
curl -sS http://127.0.0.1:5050/envelopes/note-1
curl -sS -H 'content-type: application/json' -d '{"active":"v2","disableV1":true}' http://127.0.0.1:5051/teaching/keys
curl -sS http://127.0.0.1:5050/objects/note-1
```

Ghi lại envelope trước và sau rewrap: version từ 1 lên 2, `wrapped.kekId` đổi v1
sang v2; toàn bộ `data` giữ nguyên. Tạo thêm object trước khi đổi active và không
rewrap nó: disable v1 làm object đó trả 409, còn note-1 vẫn đọc được.

## Luồng và hợp đồng

1. Vault kiểm tra id và chuỗi, sinh DEK và IV mới, mã hóa nội dung AES-256-GCM.
2. Vault gọi origin cố định `/wrap`, parse envelope và gọi `/unwrap` để kiểm tra
   DEK trả về bằng so sánh constant-time. Chỉ sau đó mới INSERT.
3. Khi đọc, vault unwrap DEK, xác thực toàn bộ ciphertext bằng GCM trước khi trả
   `{id,plaintext}`. Không gửi phần plaintext từ `decipher.update()` trước `final()`.
4. Rewrap đọc snapshot version, unwrap DEK cũ, wrap bằng active KEK, xác minh vòng
   kín và UPDATE chỉ khi version vẫn đúng. Không sửa cột data. Hai request cùng
   snapshot chỉ một request thắng; request còn lại 409, không ghi đè version mới.

| Route | Request / response thành công | Lỗi chính |
|---|---|---|
| keys POST /wrap | `{id,dek}` → `{kekId,iv,tag,ciphertext}` | 400 encoding/schema |
| keys POST /unwrap | `{id,wrapped}` → `{dek}` | 400 schema; 409 tag/AAD hoặc khóa disabled |
| keys POST /teaching/keys | `{active:"v1" hoặc "v2",disableV1:boolean}` | 404 nếu không bật controls; 400 primitive sai hoặc active disabled |
| vault POST /objects | `{id,plaintext}` → 201 `{id,version:1}` | 400 validation; 409 trùng id hoặc đủ 16 object |
| vault GET /objects/:id | 200 `{id,plaintext}` | 404 thiếu; 409 không unwrap/xác thực được |
| vault GET /envelopes/:id | 200 `{id,version,wrapped,data:{iv,tag,ciphertext}}` | 404 thiếu |
| vault POST /objects/:id/rewrap | `{}` → 200 `{id,version}` | 409 stale CAS hoặc version đã 8 |

JSON top-level phải là object; null, array, boolean và sai primitive bị 400.
JSON lỗi cú pháp trả 400; content-type khác application/json trả 415.
Id chỉ gồm `[A-Za-z0-9_-]`, dài 1..32. Plaintext không rỗng, tối đa 256 byte
UTF-8, không chứa lone surrogate. Emoji thường dùng 4 byte, không phải một byte.
Object bất biến; chỉ wrapped key và version được cập nhật.

DEK base64 phải canonical và giải mã đúng 32 byte; IV 12 byte, tag 16 byte,
wrapped ciphertext 32 byte. Base64 thiếu padding, whitespace hay padding-bit
không canonical bị từ chối. KEK phải là **hai** biến môi trường explicit, khác
nhau, mỗi biến đúng 64 ký tự hex lowercase. Không có KEK mặc định.
Client không được chọn thuật toán, địa chỉ upstream hay KEK để wrap.

AAD data là UTF-8 của `JSON.stringify([1,id])`; AAD wrapped DEK là UTF-8 của
`JSON.stringify([1,id,kekId])`. Trộn envelope của object khác hoặc đổi kekId không
thể tạo plaintext hợp lệ. AAD không bí mật, nhưng được xác thực cùng ciphertext.
IV ngẫu nhiên mới 12 byte cho mỗi lần encrypt/wrap. GCM yêu cầu **không lặp nonce
với cùng khóa**: xác suất va chạm vẫn tồn tại, nên demo ngẫu nhiên nhỏ không phải
chính sách nonce ở quy mô sản xuất.

Body request dùng helper chung, giới hạn 8192 byte. Payload hợp lệ xấu nhất cho
create gồm 256 ký tự ASCII escape `\u0000` (1536 byte), id 32 ký tự escape
(192 byte), cộng 24 byte cấu trúc JSON = 1752 byte, nằm dưới giới hạn. Wrap/unwrap
cũng nhỏ hơn 8192 với encoding canonical. JSON whitespace/field thừa không được
cam kết có ngân sách vô hạn. Reply keys bị chặn ở 512 byte; envelope thông thường
nhỏ hơn 200 byte. Không tin Content-Length: đếm byte stream thực tế.

Tất cả fetch dùng origin cấu hình cố định, `redirect:error`, không retry, cùng
một AbortSignal 1200 ms cho chuỗi wrap/unwrap của mỗi operation, kể cả đọc body.
Upstream không khả dụng, chậm, redirect, quá lớn, malformed hoặc round-trip sai
đều không ghi DB. Lỗi kết nối trả 502; keys 409 được giữ 409. Schema reply sai có
thể trả 400; client không nên retry mù quáng. Helper HTTP giới hạn request/header
timeout 5 giây. Handler không có retry nền hoặc timer tái thực hiện ghi.

## Ranh giới và đánh đổi

Mã hóa trực tiếp dùng KEK mã hóa mọi nội dung: đổi KEK thường phải đọc và mã hóa
lại toàn bộ dữ liệu. Envelope encryption chỉ rewrap DEK nhỏ; bytes nội dung giữ
nguyên. Rewrap không đổi DEK, không khắc phục DEK đã lộ, và không thu hồi bản sao
ciphertext/khóa cũ đã bị lấy. Nếu DEK lộ, cần quy trình mã hóa lại dữ liệu với DEK
mới, nằm ngoài bài này.

DB chỉ lưu id, version, IV/tag/ciphertext và wrapped DEK; không lưu plaintext,
DEK hay hash plaintext. DEK/plaintext vẫn tồn tại tạm trong bộ nhớ JavaScript;
không có bảo đảm xóa bộ nhớ, chống dump hay chống side-channel. SQLite do một
vault process sở hữu; count/INSERT đồng bộ không có await ở giữa. Không chạy
nhiều vault process chung DB để suy ra bảo đảm capacity đa writer.

Keys không lưu DEK/plaintext. Hai KEK vẫn ở bộ nhớ của keys; local HTTP và khóa
public không tạo isolation thật. Controls chỉ phục vụ thực hành local, bật rõ
`TEACHING_CONTROLS=1`; mặc định 404, active v1, cả hai enabled. Restart keys đặt
lại active/disable; cần áp dụng lại controls. Đừng nhầm disable với xóa khóa:
xóa KEK khi vẫn còn envelope cũ có thể mất dữ liệu vĩnh viễn, kể cả backup.
Backup phải tính đến khóa, phiên bản, retention và quyền truy cập.

Giới hạn 16 object, 8 version giúp demo hữu hạn, không phải quota sản xuất.
Không có auth, TLS, audit vận hành, lịch xoay khóa, xóa object hay migration DB.
`/envelopes` công khai metadata phục vụ quan sát; không phải API nên công khai
trong hệ thống thật. Lỗi không chứa khóa hay partial plaintext.

## Kiểm thử

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/50-envelope-encryption/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/50-envelope-encryption/test/lesson.test.mts
npm run check
make test
```

Worker không có network chỉ chạy typecheck và unit; outer controller chạy các
HTTP test trong Docker cô lập, không cần Internet. Không suy ra integration pass
từ unit pass. Unit dùng SQLite `:memory:` và vector AES-256-GCM zero key/nonce,
16 byte plaintext zero, AAD rỗng, expected ciphertext/tag literal độc lập; kiểm
tra AAD/tag, encoding, Unicode, CAS, version cap và import inert trong child.

Integration dùng child keys/vault độc lập, loopback port 0, DB trong `os.tmpdir()`,
finally dừng child và xóa thư mục tạm. Fixture `test/upstream.mts` chỉ là process
thử lỗi, không phải entrypoint: một fixture tái sử dụng cho JSON sai, body quá lớn
nhưng vẫn schema đúng, redirect, DEK sai, 503 và hold. Hold có bộ đếm pending và
release tường minh để chứng minh hai rewrap cùng snapshot, không dựa vào thời
gian chạy. Fetch test có deadline. Redirect test kiểm tra endpoint đích không
nhận request; mỗi biến thể kiểm tra envelope cũ không đổi và object mới không có.
Import test cố ý đặt cấu hình runtime sai nhưng vẫn yêu cầu exit 0 và không có
stdout/stderr, không coi startup thất bại là bằng chứng inert.

## Bài tập

- Giải thích vì sao sửa id làm unwrap thất bại dù key/IV/tag còn đúng.
- Tạo hai object cùng plaintext, so sánh ciphertext; giải thích nonce và DEK mới.
- Tính số byte JSON khi toàn bộ id cũng được escape; thử giới hạn 64 emoji.
- Phác thảo quy trình kiểm kê envelope trước khi xóa KEK v1, tính cả backup.
- Thiết kế migration mã hóa lại với DEK mới khi DEK cũ lộ; chỉ ra điều CAS phải bảo vệ.

Tham khảo: [Google Cloud KMS — envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption)
và [Node.js crypto](https://nodejs.org/api/crypto.html). Triển khai này là mô hình
cục bộ để quan sát hợp đồng, không gọi Cloud KMS.
