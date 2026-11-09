# 49 — Audit log hash-chain và checkpoint độc lập

Một log tự khai báo hash cuối không chứng minh rằng nó chưa bị viết lại. Người kiểm soát toàn bộ lịch sử có thể sửa mục đầu, tính lại tất cả hash và đưa ra một lịch sử hoàn toàn nhất quán. Bài này giữ một checkpoint trong **SQLite riêng của auditor** để phát hiện lịch sử mới không còn chứa tiền tố đã tin cậy.

## Chuẩn bị và chạy

Cần Node.js **24.12+**, kiến thức HTTP, idempotency và transaction SQLite (bài 03/05), cùng các gói phát triển đã ghim ở root. Runtime chỉ dùng built-in Node. Chạy từ root repository; không cần tài khoản hoặc dịch vụ ngoài.

Terminal 1:

```sh
AUDIT_LOG_DIR=$(mktemp -d)
DB_PATH="$AUDIT_LOG_DIR/logger.sqlite" HOST=127.0.0.1 PORT=4941 TEACHING_CONTROLS=1 \
  node lessons/49-tamper-evident-audit/logger.mts
```

Terminal 2 (thư mục và DB khác):

```sh
AUDIT_PIN_DIR=$(mktemp -d)
DB_PATH="$AUDIT_PIN_DIR/auditor.sqlite" LOGGER_ORIGIN=http://127.0.0.1:4941 \
  HOST=127.0.0.1 PORT=4942 VERIFY_TIMEOUT_MS=800 \
  node lessons/49-tamper-evident-audit/auditor.mts
```

Mỗi server in đúng một dòng readiness JSON chứa `service` và `port`. Có thể dùng `PORT=0` để hệ điều hành chọn port; đưa port logger thực tế vào `LOGGER_ORIGIN` trước khi chạy auditor. Playground chạy hai entrypoint với DB_PATH khác nhau, HOST=127.0.0.1, PORT=0; bật TEACHING_CONTROLS=1 riêng logger khi cần mô phỏng. Không có biến ứng dụng mang tiền tố NODE_, LD_ hoặc DYLD_.

Mặc định: logger port 4941, DB `logger.sqlite`; auditor port 4942, DB `auditor.sqlite`, origin `http://127.0.0.1:4941`. DB_PATH trỏ tới file có thư mục cha đã tồn tại. HOST mặc định loopback. VERIFY_TIMEOUT_MS mặc định 800, phạm vi 50..3000 ms, bao trùm cả nhận headers lẫn đọc body. LOGGER_ORIGIN chỉ chấp nhận HTTP origin thuần, không credentials/path/query/fragment; URL cố định `/export`, không theo redirect. Không đăng ký signal, đọc cấu hình, mở SQLite hoặc listen khi import module.

## Hợp đồng

Tất cả POST dùng `Content-Type: application/json`. Body tối đa 8192 byte; sai media type 415, quá lớn 413, JSON sai hoặc sai kiểu/field 400. Object yêu cầu đúng tập field: null, array, boolean và field thừa đều bị từ chối. Route không tồn tại trả 404. Phản hồi lỗi có `{error:{code,message}}`.

| Dịch vụ / route | Body | Kết quả 200 / lỗi chính |
| --- | --- | --- |
| logger POST `/entries` | `{id,action,subject}` | Entry gốc; id trùng khác payload 409, đầy 409 |
| logger GET `/export` | — | `{entries:[{seq,prev,id,action,subject,hash}],head:{count,hash}}` |
| auditor POST `/verify` | `{}` | `{count,checkpoint:{count,hash}}`, không nâng checkpoint |
| auditor POST `/checkpoint` | `{}` | Kiểm tra rồi nâng checkpoint atomically; trả cùng cấu trúc |
| auditor GET `/state` | — | `{checkpoint:{count,hash}}` |
| logger POST `/teaching/view` | `{mode}` | `{mode}`, chỉ khi TEACHING_CONTROLS=1; mặc định 404 |

`id` và `subject` là chuỗi ASCII URL-safe `[A-Za-z0-9_-]`, dài 1..32. `action` đúng một chuỗi `created`, `approved`, `cancelled`. Chỉ dùng dữ liệu giả như `po-7`, không thông tin cá nhân. Tối đa **16 entry được giữ vĩnh viễn**, không có API sửa/xóa hay quay vòng. Replay đúng cả id/action/subject trả entry cũ ngay cả khi đã đầy. Một entry vừa là receipt idempotency vừa là mắt xích: transaction `BEGIN IMMEDIATE` kiểm tra duplicate/capacity và INSERT nên không có receipt rời khỏi lịch sử.

Với seq bắt đầu 1:

```text
prev = 64 ký tự '0' cho mục đầu, sau đó là hash mục trước
hash = SHA256(UTF8(JSON.stringify([1,seq,prev,id,action,subject])))
```

Hash dạng hex thường 64 ký tự; số `1` là phiên bản định dạng. Empty head là `{count:0,hash:64-zero}`. Auditor kiểm tra **toàn bộ** thứ tự seq, uniqueness của id, primitive/enum/field, prev, từng hash và head; dữ liệu không hợp lệ hoặc nguồn lỗi trả 502. Chuỗi hợp lệ nội bộ nhưng ngắn hơn checkpoint hoặc hash tại vị trí checkpoint không khớp trả 409. Empty checkpoint neo tiền tố rỗng; nó không xác nhận nội dung chưa xuất hiện.

Mỗi lần verify/checkpoint chỉ fetch đúng một lần. Giới hạn upstream 32768 byte kể cả whitespace; tối đa 16 mục, kể cả cách mã hóa hợp lệ `\uXXXX` cho các ký tự ASCII và tên field, dưới 25000 byte. Canonical JSON bình thường dưới 4700 byte. Vì vậy giới hạn không loại payload hợp lệ dài nhất nhưng chặn padding/buffer vô hạn. Status khác 200, redirect, JSON/schema/hash sai, UTF-8 sai, body chậm hoặc quá lớn đều 502, không ghi checkpoint.

## Kiến trúc và checkpoint đồng thời

```text
caller -> logger -> logger.sqlite (receipt + chain, transaction)
                     |
                  GET /export (bounded O(n))
                     |
caller -> auditor -> auditor.sqlite (một hàng checkpoint duy nhất)
```

Auditor fetch và validate bên ngoài transaction; sau đó đọc lại checkpoint và so sánh tiền tố **bên trong** transaction đồng bộ trước khi UPDATE. Hai request có thể nhận snapshot khác nhau: nếu snapshot mới commit trước thì snapshot cũ bị 409, không ghi đè checkpoint mới. `/verify` cũng đọc checkpoint hiện tại trong transaction nhưng không UPDATE. Checkpoint không tiến lùi; một logger extension bình thường được chấp nhận. Khi restart, hai DB giữ lịch sử và niềm tin; chế độ view của logger trở lại `clean` vì chỉ tồn tại trong bộ nhớ.

## Thực hành tấn công cục bộ

Chỉ bật teaching controls trên môi trường học loopback. Các mode chỉ thay **view xuất ra**, không sửa SQLite, không log raw request; mode là enum nhỏ và body vẫn có byte limit. Attack mode cần ít nhất một entry, nếu rỗng trả 409. `edit` đổi subject đầu nhưng giữ hash; `truncate` bỏ mục cuối và tính head của tiền tố; `rewrite` đổi subject đầu rồi tính lại toàn bộ prev/hash/head. `clean` khôi phục view bền vững.

```sh
curl -sS http://127.0.0.1:4941/entries -H 'content-type: application/json' \
  -d '{"id":"po-7","action":"created","subject":"demo-7"}'
curl -sS http://127.0.0.1:4942/checkpoint -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:4941/entries -H 'content-type: application/json' \
  -d '{"id":"po-8","action":"approved","subject":"demo-8"}'
curl -sS http://127.0.0.1:4942/verify -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:4941/teaching/view -H 'content-type: application/json' -d '{"mode":"edit"}'
curl -i http://127.0.0.1:4942/verify -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:4941/teaching/view -H 'content-type: application/json' -d '{"mode":"rewrite"}'
curl -i http://127.0.0.1:4942/checkpoint -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:4941/teaching/view -H 'content-type: application/json' -d '{"mode":"clean"}'
curl -sS http://127.0.0.1:4942/checkpoint -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:4941/teaching/view -H 'content-type: application/json' -d '{"mode":"truncate"}'
curl -i http://127.0.0.1:4942/verify -H 'content-type: application/json' -d '{}'
```

Kết quả: extension verify 200 nhưng checkpoint vẫn count=1; edit 502; rewrite 409; clean checkpoint tiến lên 2; truncate sau đó 409. Nếu truncate chỉ bỏ phần **sau** anchor, vẫn 200: auditor chưa từng neo phần đó. Tương tự viết lại suffix chưa neo có thể tránh phát hiện. Chạy lại `clean` trước khi kết thúc demo. Dừng hai server rồi chạy lại với chính DB_PATH để kiểm tra niềm tin còn nguyên; xóa DB auditor sẽ **phá hủy niềm tin**, không phải cách sửa lỗi fork. Chỉ xóa thư mục tạm sau khi đã dừng tiến trình và không cần giữ demo.

## Kiểm tra

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/49-tamper-evident-audit/test/lesson.test.mts
node --test --test-name-pattern=integration: lessons/49-tamper-evident-audit/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite in-memory, fixture hash độc lập cố định, sửa/đảo/recompute chain, checkpoint prefix và duplicate/capacity transaction. Import test chạy child với cấu hình cố tình sai và yêu cầu exit thành công, stdout/stderr rỗng. Integration khởi động logger/auditor thật trên port tạm, DB trong `node:os.tmpdir()`, restart, rollback/fork/corruption, payload tối đa, và nguồn fixture process tái sử dụng cho các lỗi. Barrier `/state` của fixture chứng minh snapshot cũ đã bị giữ trước khi snapshot mới commit; không dùng phỏng đoán thời gian cho tính chất đồng thời. Redirect sang một process khác có counter để chứng minh không đi theo origin mới. Mọi request có deadline, finally dừng child/xóa DB. Fixture chỉ nằm trong `test/`, không phải entrypoint sản phẩm.

Worker không chạy HTTP integration trong sandbox không mạng; controller chạy chúng trong Docker cô lập. Typecheck và unit không thay thế xác nhận HTTP thật.

## Giới hạn, đánh đổi và bài tập

Hash chain cung cấp liên kết nội dung, không cung cấp danh tính người ghi, chữ ký, bảo mật nội dung hay timestamp đáng tin. Không có authentication/signatures/confidentiality. Kẻ kiểm soát cả hai DB có thể thay cả lịch sử và anchor. Cần giữ auditor trong miền quản trị/storage độc lập thực sự; chỉ hai file cùng máy là mô hình dạy học, không đủ bảo vệ trước quản trị viên máy chủ. Lần checkpoint đầu chỉ tin lịch sử đang được quan sát, không chứng minh quá khứ trước đó.

Đọc toàn bộ O(n) và giữ vĩnh viễn 16 mục làm cách kiểm tra dễ hiểu, nhưng không phù hợp audit volume lớn; đầy log cần quy trình mới ngoài phạm vi bài. Transaction SQLite bảo vệ cập nhật cục bộ, không tạo distributed transaction giữa hai dịch vụ. Mất nguồn khiến auditor không thể xác minh; không tự xóa hay hạ anchor để phục hồi.

[RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html) mô tả cây Merkle và inclusion/consistency proofs trong Certificate Transparency: inclusion chứng minh leaf thuộc tree, consistency liên kết hai kích thước tree để kiểm tra tăng trưởng. Hash chain ở đây phải tải tiền tố và kiểm tra tuyến tính; format và thuật toán không tương thích proof Merkle trong RFC. Một hash tự khai báo, kể cả Merkle root, vẫn cần anchor độc lập để chống việc đưa ra lịch sử thay thế.

Bài tập:

1. Neo mục 1, thêm mục 2, tự tạo nguồn viết lại riêng mục 2 và tính hash đúng. Vì sao verify 200? Sau khi neo mục 2 điều gì đổi?
2. Vẽ tình huống hai auditor neo hai fork khác nhau. Vì sao bài chưa phát hiện equivocation giữa hai auditor?
3. Thiết kế lưu checkpoint ngoài miền quản trị logger; nêu chính sách phục hồi khi mất DB auditor mà không ngầm tin lại nguồn.
4. So sánh băng thông O(n) của export này với Merkle proofs; phân biệt inclusion, consistency và xác thực người phát hành checkpoint.
