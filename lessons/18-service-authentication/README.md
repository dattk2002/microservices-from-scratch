# 18 — Danh tính dịch vụ, token ký và phân quyền

Bài học dành cho người đã biết HTTP, deadline và tiến trình Node độc lập. Mục tiêu: phân biệt **ai đang gọi** với **người đó được làm gì**, bằng một profile JWS compact hẹp dùng Ed25519 của `node:crypto`. Cần Node.js **24.12+ thuộc nhánh 24**, npm và các gói phát triển đã khóa ở root; runtime không cần package bên ngoài.

## Chạy từ root repository

```sh
node --version
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/18-service-authentication/test/lesson.test.mts
node lessons/18-service-authentication/demo.mts
node --test --test-isolation=none --test-name-pattern=integration: lessons/18-service-authentication/test/lesson.test.mts
```

Hai lệnh cuối cần quyền mở loopback. Worker không chạy chúng trong sandbox không mạng; controller chạy HTTP thật trong Docker cô lập. Kiểm tra đầy đủ của repository ở môi trường được phép: `npm run check`, `make test`, `git diff --check`. Không cần cloud, credential store hay Docker để chạy demo trên máy cá nhân cho phép loopback.

Demo tạo cặp khóa dùng một lần trong bộ nhớ, khởi động resource và caller bằng **hai child process khác nhau**, dùng cổng 0 để hệ điều hành cấp cổng, gọi một lần rồi dừng cả hai trong `finally`. Kết quả mong đợi:

```json
{"status":200,"result":{"report":"monthly","requestedBy":"invoice-worker"}}
```

Không ghi khóa ra file, không in token. Đây là dữ liệu khóa minh họa, không dùng khóa thật. Biến môi trường chỉ là phương tiện truyền khóa demo tới child process trên máy cục bộ, không phải hướng dẫn quản lý bí mật sản xuất. Mỗi lần chạy tạo khóa mới; token cũ không còn hợp lệ với lần chạy mới.

## Ranh giới và kiến trúc

```text
người chạy demo → caller POST /call
                     │ ký token, HTTP Bearer
                     ▼
                 resource POST /reports
                 xác thực → chính sách → kiểm tra payload → kết quả
```

`auth.mts` chứa profile, ký, verifier và chính sách. `caller.mts` giữ private key và chỉ ký danh tính cố định `invoice-worker`; không nhận subject/scope do người gọi yêu cầu. `resource.mts` chỉ nhận public key tin cậy cấu hình bên ngoài token. `demo.mts` điều phối vòng đời. Tất cả entrypoint xuất `main()` và chỉ chạy khi `import.meta.main`; import không đọc env, tạo khóa, đăng ký signal hoặc mở listener. Test import dùng env cố tình sai, yêu cầu child kết thúc im lặng.

Caller là điểm kích hoạt demo trên loopback **không có xác thực đầu vào**. Không được đưa endpoint này ra mạng: nó có thể trở thành nơi bất kỳ ai cũng mượn danh tính dịch vụ. Danh tính ở đây là danh tính tiến trình caller, không phải danh tính người dùng.

## Profile byte và hợp đồng tin cậy

Token gồm đúng ba segment `base64url(header).base64url(payload).base64url(signature)`, không padding, chỉ ký hai segment đầu cùng dấu chấm. Node thực hiện Ed25519; bài này không tự xây primitive mật mã. Giới hạn 4096 ký tự ASCII; chữ ký đúng 64 byte. Mọi segment phải round-trip base64url chuẩn; JSON phải là UTF-8 hợp lệ và bằng chính kết quả `JSON.stringify` sau parse. Quy tắc encoding hẹp này từ chối duplicate member, whitespace hoặc escape thay thế; không nhằm chấp nhận mọi JWT hợp lệ ngoài hệ thống này.

Header chỉ được có ba trường:

```json
{"alg":"EdDSA","typ":"service+jwt","kid":"demo-1"}
```

`alg`, `typ`, issuer, audience và key ID đều được pin bằng code. KeyObject phải là public Ed25519 khi dựng verifier; cấu hình sai dừng trước khi listen. `kid` chỉ đối chiếu allowlist một phần tử, không dùng làm đường dẫn hoặc URL. Không đọc `jku`, `jwk`, `x5u` hoặc tải khóa từ token; mọi header mở rộng đều bị từ chối. Không chuyển sang HMAC hay chấp nhận `none` theo header.

Payload đúng bảy trường: `iss=demo-issuer`, `aud=reports` (string, không array), `sub`, `scope`, `iat`, `nbf`, `exp`. Subject là tên dịch vụ chữ thường, bắt đầu bằng chữ, tối đa 64 ký tự; scope là các từ chữ thường/dấu hai chấm cách nhau bởi một dấu cách, tối đa 128 ký tự. Không có claim bổ sung. Đây là lựa chọn thu hẹp có chủ đích.

Các mốc là safe-integer giây Unix, `iat >= 0`, với:

```text
iat <= nbf <= now < exp
exp - iat <= 60
```

Không clock leeway. Tại `now=exp` token hết hạn; tại `now=nbf` đã có hiệu lực. Verifier nhận clock qua tham số để test không phải ngủ. Runtime dùng `floor(Date.now()/1000)`. Máy lệch giờ có thể làm token bị từ chối: cần đồng bộ giờ bên ngoài bài này. Thứ tự xử lý: kích thước/shape và header → chữ ký với khóa tin cậy → payload/issuer/audience/thời gian → authorization. Lỗi parse/chữ ký/claim đều trả lỗi chung.

Chính sách cho tài nguyên báo cáo là **subject bằng `invoice-worker` VÀ scope chứa nguyên từ `reports:read`**. Token hợp lệ của `other-service` hoặc chỉ có `reports:write` nhận 403. Chữ ký hợp lệ không tự động cấp quyền.

## HTTP và cấu hình

| Tiến trình | Cấu hình trong `main()` | Mặc định / ràng buộc |
| --- | --- | --- |
| resource | `PUBLIC_KEY` | bắt buộc PEM SPKI Ed25519 demo, tối đa 2048 ký tự |
| caller | `PRIVATE_KEY`, `RESOURCE_URL` | bắt buộc PEM PKCS8 Ed25519 demo; URL `http://127.0.0.1:<port>` không user/password/path/query/hash |
| cả hai | `HOST`, `PORT` | chỉ `127.0.0.1`; port 0..65535, mặc định resource 3018, caller 3019 |

Cấu hình khóa/host/URL sai fail closed trước listener, chỉ in thông báo startup chung. `lib/http.mts` cung cấp HTTP server, JSON giới hạn 8192 byte, timeout server 5 giây, readiness chỉ chứa service/port và shutdown có thời hạn. Caller gọi resource với deadline 1500 ms, không theo redirect, lỗi kết nối/timeout trả 502. Test HTTP có deadline 5 giây qua helper và timeout runner 15 giây qua script root.

| Request / tình huống | Status / nội dung |
| --- | --- |
| POST `/call`, JSON `{"report":"monthly"}` | caller gọi resource và chuyển status/JSON |
| POST `/reports`, cùng payload, Bearer hợp lệ và đủ quyền | 200 với report và requestedBy |
| thiếu Bearer, token sai/hết hạn/sai audience/key/algorithm | 401, `WWW-Authenticate: Bearer`, lỗi `unauthenticated` |
| token hợp lệ nhưng sai subject hoặc thiếu scope | 403, lỗi `forbidden` |
| đã có quyền nhưng payload sai | 400; content-type không phải JSON: 415 |
| route không có / method sai | 404 / 405 |
| resource không phản hồi trong deadline | caller 502 |

Mọi test lỗi xác thực/phân quyền đều gửi payload `report=monthly` và content-type JSON hợp lệ để lỗi payload không che mất hợp đồng đang kiểm tra. Response lỗi không nhắc token, key ID hoặc nội dung khóa; không log authorization header. Không có endpoint phát token công khai.

## Kiểm chứng và giới hạn

Unit tests kiểm tra biên 99/100/159/160 bằng clock tiêm, token bị thay nội dung, kiểu và mốc thời gian sai, token quá lớn, base64url không chuẩn, metadata không được tin, thuật toán sai, khóa không phải Ed25519, scope/subject và import inert. HTTP integration thật khởi động resource/caller riêng biệt với port tạm, kiểm tra thành công qua caller và gọi resource bằng token lỗi/thiếu/hết hạn/sai audience, unknown key, algorithm confusion, thiếu scope và sai subject. Cleanup được đăng ký ngay sau mỗi lần start thành công.

Đây là **verifier giáo dục hẹp**, không phải thư viện JWT tổng quát, OAuth server hay hệ thống identity sản xuất. Chữ ký đảm bảo tính toàn vẹn, không mã hóa nội dung. Bearer bị lấy cắp có thể replay trong thời gian còn hiệu lực; không có nonce, revocation, discovery, rotation tự động hay phân phối khóa. Loopback HTTP không cung cấp bảo mật đường truyền. Production cần TLS, quản lý và luân chuyển khóa, đồng bộ giờ, policy phù hợp và implementation tiêu chuẩn được duy trì; không sao chép verifier này làm nền tảng bảo mật sản xuất.

## Bài tập

1. Thêm identity thứ hai vào policy và viết test chứng minh scope đúng nhưng identity sai vẫn bị từ chối trước thay đổi.
2. Thiết kế rotation hai public key cấu hình tin cậy: token cũ sống tối đa bao lâu, khi nào gỡ khóa cũ? Không dùng URL lấy từ token.
3. Mô tả cách replay token còn hạn xảy ra, rồi phân tích TLS và cơ chế ràng buộc người gửi giải quyết phần nào. Không thêm kho token hoặc credential thật vào demo.
4. Tiêm clock lệch một giây ở biên `exp` và giải thích vì sao zero leeway có thể giảm tính sẵn sàng.

## Nguồn chính thức

- [RFC 8725 — JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html): pin thuật toán, kiểm tra audience và tránh nhầm loại token.
- [RFC 8037 — CFRG Elliptic Curve Cryptography for JOSE](https://www.rfc-editor.org/rfc/rfc8037.html): EdDSA trong JOSE.
- [Node.js 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html): generateKeyPairSync, KeyObject, sign và verify với Ed25519.
