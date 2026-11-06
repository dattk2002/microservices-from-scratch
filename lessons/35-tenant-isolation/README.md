# 35 — Cô lập tenant trong context, truy vấn và idempotency

Bài trước đã bàn về sửa trạng thái; bài này đặt câu hỏi khác: khi hai khách hàng cùng gọi tài liệu `same`, dữ liệu và biên nhận thao tác thuộc về ai? Ta xây hai tiến trình HTTP độc lập: gateway ký context Ed25519; document service tự xác minh bằng public key ghim trong cấu hình và lưu SQLite bền vững. Không cần dịch vụ danh tính, thông tin đăng nhập bên ngoài hoặc package runtime.

## Điều kiện và chạy thử

Dùng Node.js 24.12+ (SQLite built-in), chạy từ gốc repository. Các dependency phát triển được pin ở gốc. Cần hiểu HTTP, chữ ký bất đối xứng, khóa ghép SQL và idempotency. Gateway không mở SQLite; documents không giữ private key.

Trong một shell Bash, sinh cặp khóa demo tạm thời bằng Node và giữ trong biến môi trường (không lưu private key vào repository):

```bash
export PRIVATE_KEY_PEM="$(node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto"; const k=generateKeyPairSync("ed25519"); process.stdout.write(k.privateKey.export({type:"pkcs8",format:"pem"}));')"
export PUBLIC_KEY_PEM="$(node --input-type=module -e 'import {createPublicKey} from "node:crypto"; process.stdout.write(createPublicKey(process.env.PRIVATE_KEY_PEM).export({type:"spki",format:"pem"}));')"
export DB_PATH="$(node --input-type=module -e 'import {mkdtempSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; process.stdout.write(join(mkdtempSync(join(tmpdir(),"tenant-demo-")),"documents.sqlite"));')"
HOST=127.0.0.1 PORT=3531 node lessons/35-tenant-isolation/documents.mts &
DOC_PID=$!
HOST=127.0.0.1 PORT=3530 DOCUMENT_ORIGIN=http://127.0.0.1:3531 TEACHING_CONTROLS=1 node lessons/35-tenant-isolation/gateway.mts &
GATEWAY_PID=$!
```

Mỗi tiến trình in một dòng JSON `{ "service": "…", "port": 3531 }` khi sẵn sàng. Có thể dùng `PORT=0` để hệ điều hành cấp cổng; lấy cổng từ JSON rồi đặt `DOCUMENT_ORIGIN` tương ứng trước khi chạy gateway. Ví dụ dưới dùng cổng cố định để dễ thao tác; nếu cổng bận, chọn cổng khác. Dừng bằng `kill "$GATEWAY_PID" "$DOC_PID"` và đợi tiến trình thoát. Giữ file DB để thử restart; tự xóa thư mục demo khi không dùng nữa. Sinh khóa mới khi bắt đầu phiên demo mới.

```bash
curl -sS --max-time 5 http://127.0.0.1:3530/documents/same \
  -H 'x-demo-principal: alice' -H 'content-type: application/json' \
  -d '{"op":"save1","text":"Bản thảo của nhóm đỏ"}'
curl -sS --max-time 5 http://127.0.0.1:3530/documents/same \
  -H 'x-demo-principal: bob' -H 'content-type: application/json' \
  -d '{"op":"save1","text":"Ghi chú của nhóm xanh"}'
curl -sS --max-time 5 http://127.0.0.1:3530/documents -H 'x-demo-principal: alice'
curl -sS --max-time 5 http://127.0.0.1:3530/documents/same -H 'x-demo-principal: bob'
```

Hai lần ghi trả `200`, `replay:false` với nội dung riêng. Gửi lại chính xác thao tác đầu: `replay:true`. Đổi nội dung nhưng giữ `save1` trong cùng tenant: `409 conflict`. Bob vẫn dùng `save1` độc lập. Replay trả kết quả lịch sử của thao tác, không nhất thiết là phiên bản hiện tại nếu tài liệu đã được sửa bằng op khác.

### Playground

Hai entrypoint dùng cùng `HOST=127.0.0.1`, `PORT=0`, readiness JSON. Cấu hình documents với `PUBLIC_KEY_PEM=$auth.public`, `DB_PATH` trỏ tới file bền vững trong thư mục dữ liệu của phiên. Cấu hình gateway với `PRIVATE_KEY_PEM=$auth.private`, `DOCUMENT_ORIGIN` là origin documents vừa được cấp và `TEACHING_CONTROLS=1`. Đây là các giá trị PEM môi trường do manager cung cấp, không phải đường dẫn file. Không sửa root/manager để chạy bài này.

`x-demo-principal` chỉ có hiệu lực khi gateway có `TEACHING_CONTROLS=1`: `alice → red`, `bob → blue`. Không bật cờ hoặc tên khác trả `401`. Đây là **danh tính mô phỏng**, tuyệt đối không phải đăng nhập an toàn: bất kỳ người gọi nào cũng có thể chọn Alice hoặc Bob khi cờ bật. Chỉ bật trên máy cục bộ trong môi trường học. Không có route điều khiển ẩn hay yêu cầu dịch vụ danh tính thật.

## Luồng và hợp đồng

```text
người gọi -- selector mô phỏng --> gateway (private key)
                                     |
                        HTTP + x-tenant-context đã ký
                                     v
                             documents (public key)
                                     |
                          SQLite khóa ghép tenant
```

Context có dạng `base64url(JSON).base64url(signature)`; Ed25519 ký chính chuỗi payload mã hóa. Đây là định dạng demo riêng, không phải triển khai JWT. Documents yêu cầu `iss="demo-gateway"`, `aud="documents"`, `tenant/sub` là chuỗi định danh, `exp` là số nguyên an toàn, lớn hơn thời điểm hiện tại và không quá 60 giây trong tương lai. Gateway cấp 30 giây. Context tối đa 2048 ký tự; sai chữ ký, sai key, thiếu, hết hạn hoặc sai claim đều trả cùng `401 invalid_context`. Đồng hồ lệch có thể làm request hợp lệ bị từ chối; không có grace period, rotation, revocation hay chống replay token trong demo.

| API | Kết quả |
| --- | --- |
| `GET /documents` | `200 {documents:[{id,text}]}` của tenant, sắp theo id |
| `GET /documents/:id` | `200 {id,text}` hoặc `404 not_found` |
| `POST /documents/:id` với `{op,text}` | `200 {document:{id,text},replay:boolean}` |
| Op cũ đổi id/text | `409 conflict`, không thay dữ liệu |
| Hết dung lượng tenant | `409 capacity`, không ghi hoặc xóa receipt |
| Query bất kỳ, body thêm tenant/sai kiểu | `400` |
| Media type khác JSON / body quá lớn | `415` / `413` |
| Method khác | `405` sau các bước xác thực/định tuyến |
| Upstream redirect, lỗi kết nối, reply sai hoặc quá lớn | gateway trả `502 upstream_failure` |

`id`, `op`, `tenant`, `sub` là primitive string khớp `[a-zA-Z0-9_-]{1,64}`. `text` là primitive string dài tối đa 1024 UTF-16 code units, kể cả chuỗi rỗng. Không ép array/object/number thành chuỗi. Body chỉ nhận đúng hai trường `op,text`. Gateway tự tạo context và không chuyển tiếp context/header tenant của người gọi. Documents chọn tenant duy nhất từ context đã xác minh; `x-tenant` bị bỏ qua. Query tenant bị từ chối; body tenant bị từ chối. ID đoán được ở tenant khác và ID không tồn tại đều có cùng status/body `404`; đây là bảo đảm hợp đồng HTTP, không phải cam kết timing side-channel.

Giới hạn byte dựa trên JSON xấu nhất: 1024 code units có thể cần `1024 × 6 = 6144` byte khi escape `\u0000`; op ASCII 64 byte và 19 byte cú pháp `{ "op", "text" }` dạng compact cho tổng 6227 byte. Vì vậy body 8192 byte của helper chung chấp nhận mọi write compact hợp lệ, kể cả id 64 ký tự trong URL. Whitespace JSON vẫn tính byte; test quá giới hạn dùng whitespace với schema, danh tính và op hợp lệ để riêng gate byte quyết định `413`. URL tối đa 256 ký tự, không query. HTTP parser Node giới hạn tổng header mặc định 16 KiB; context có gate riêng 2048 ký tự. Timeout header/request của helper là 5 giây, gateway gọi upstream với deadline 2 giây, không theo redirect. `redirect:'error'` giữ origin cố định, kể cả redirect 307 vốn có thể chuyển cả body và context.

Gateway đọc response theo stream tối đa 160000 byte rồi kiểm tra schema runtime trước khi trả cho client. List có tối đa 20 tài liệu; ngay cả escape xấu nhất, mỗi tài liệu có 6144 byte text + 64 byte id + 19 byte cú pháp, nên list compact nhỏ hơn 125000 byte. SQLite chỉ được documents ghi sau khi parse input; gateway không ghi dữ liệu nhận từ upstream vào DB. Không có cache chung hoặc biến mutable `currentTenant` dùng cho các request.

## Cô lập và bền vững

Hai bảng chia sẻ database:

- `documents`: primary key `(tenant,id)`; mọi get/list/update đều có predicate tenant.
- `receipts`: primary key `(tenant,op)`; lưu id và text gốc để so sánh replay, không chỉ lưu dấu đã thấy.

Một transaction `BEGIN IMMEDIATE` bao trùm kiểm tra receipt, giới hạn và hai lần ghi. Mỗi tenant tối đa 20 documents, 40 receipts giữ lại. Có thể sửa tài liệu cũ bằng op mới đến khi đủ 40 receipts. Khi đầy, từ chối op mới rõ ràng; replay cũ vẫn thành công. Không eviction receipt vì eviction sẽ làm op cũ được thực thi lần nữa. Một tenant đầy không tiêu hết quota của tenant kia. Không có delete/reset API trong bài; muốn chu kỳ retention mới cần thiết kế giao thức riêng. SQLite thực hiện đồng bộ và serialize ghi, phù hợp demo nhỏ, không chứng minh công bằng CPU/I/O hay khả năng mở rộng cho nhiều process cùng ghi.

**Authentication** xác định người gọi là ai. Demo thay bước đó bằng selector công khai có cờ bật. **Tenant authorization** xác định tenant được phép dùng; gateway ánh xạ principal sang tenant, documents tin key ghim và tự xác minh context. Hệ thống thật cần xác thực principal, quản lý membership và quyền trên từng tài nguyên trước khi ký. Chữ ký bảo vệ context khỏi sửa đổi trên đường đi nhưng không mã hóa context. Nếu quên `WHERE tenant=?`, chữ ký hoàn toàn đúng vẫn không cứu được truy vấn rò dữ liệu.

Shared-table tiết kiệm vận hành nhưng mỗi đường truy cập phải có tenant predicate và khóa ghép, kể cả idempotency/cache/job nền. Schema/database riêng tạo ranh giới mạnh hơn nhưng tốn migration, connection và vận hành. Demo chưa có Row Level Security, TLS, token rotation, audit, quota storage byte, chống DoS hoặc authorization theo vai trò. Chỉ chạy cục bộ, không dùng selector này cho production.

Các module inert khi import: đọc cấu hình, mở SQLite, listener và signal handler chỉ bắt đầu trong `main()` dưới `import.meta.main`. Shutdown đóng listener rồi SQLite; readiness được in sau listen thành công. Không sinh khóa hay dữ liệu ở import.

## Kiểm chứng

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/35-tenant-isolation/test/lesson.test.mts
node --test --test-timeout=15000 lessons/35-tenant-isolation/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite `:memory:` kiểm tra chữ ký, claim primitive, khóa ghép, replay và quota. Test import chạy child với cấu hình cố ý sai, yêu cầu exit 0 và output rỗng; chỉ tắt cảnh báo experimental SQLite của Node, không nuốt lỗi ứng dụng. Các unit gốc đã được quan sát RED bằng assertion trước triển khai ở lượt tác giả trước.

Integration tự sinh key, dùng child documents/gateway riêng, cổng loopback ephemeral, DB trong `node:os.tmpdir()`, deadline request và cleanup `finally`. Chúng kiểm tra concurrent mixed tenants bằng kết quả read/cross-read cụ thể, không suy luận từ thời gian chạy; restart cùng DB để kiểm tra cả document và receipt; spoof hints và signed claim sai; quota độc lập; payload escape tối đa và body quá byte; gate selector; upstream độc hại redirect sang process sink phải không nhận request nào, reply sai schema/quá lớn trả 502. Fixture upstream chỉ là chương trình test, không phải entrypoint sản phẩm. Không có lease fencing/backpressure writer trong kiến trúc này.

Worker mạng bị chặn chỉ chạy typecheck và unit; HTTP integration, `npm run check` và `make test` cần outer controller chạy trong Docker cô lập. Việc có test HTTP trong repository không có nghĩa worker đã chạy chúng.

## Bài tập

1. Thử bỏ tenant predicate trong một truy vấn ở bản sao riêng: test nào phát hiện rò dữ liệu dù chữ ký vẫn đúng?
2. Đề xuất retention receipt có thời hạn với hợp đồng retry hữu hạn, không âm thầm thực thi lại op cũ.
3. Thiết kế rotation hai public key với key ID bị giới hạn và cửa sổ chuyển tiếp rõ ràng.
4. Nếu dùng cache, viết khóa bao gồm tenant, tài nguyên và version; thêm test hai tenant dùng cùng ID.

Tham khảo: [Azure: mô hình tenancy và tradeoff](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models), [Node.js 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html), [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
