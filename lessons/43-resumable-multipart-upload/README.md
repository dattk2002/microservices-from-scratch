# 43 — Upload nhiều phần có thể tiếp tục

Bài học dùng Node.js 24.12+ và SQLite tích hợp. Cần hiểu HTTP, SHA-256,
transaction và bài về idempotency. Đây là giao thức giảng dạy có giới hạn,
không tương thích S3 hoặc Tus. Không cần tài khoản hay dịch vụ đám mây.

## Chạy từ thư mục gốc

```sh
STORE_DB=/tmp/lesson43.sqlite HOST=127.0.0.1 PORT=4343 node lessons/43-resumable-multipart-upload/upload.mts
STORE_ORIGIN=http://127.0.0.1:4343 HOST=127.0.0.1 PORT=4344 node lessons/43-resumable-multipart-upload/reader.mts
```

Hai lệnh chạy trong hai terminal. `PORT=0` chọn cổng tạm; dòng JSON đầu tiên
chứa `port`. `STORE_DB` là cấu hình quản trị, không nhận đường dẫn từ HTTP.
`STORE_ORIGIN` cố định tại startup, chỉ nhận HTTP origin không có credentials,
query hay đường dẫn. `UPSTREAM_TIMEOUT_MS` mặc định 1000, phạm vi 50–5000.
Import module không đọc cấu hình, mở DB, đăng ký signal hay mở listener.

## Kiến trúc và hợp đồng

Client → upload owner → SQLite; client → reader → upload owner.
Reader là tiến trình riêng, không mở DB. Owner là nơi duy nhất ghi dữ liệu.
Mọi reply JSON đều tắt cache. Chỉ gọi trên loopback trong môi trường học.

- `POST /uploads` nhận `{uploadId,parts,size,sha256}`. ID dùng 1–32 ký tự
  ASCII chữ/số/`_`/`-`; parts 1–8; size 1–8192 và `parts ≤ size ≤ parts*1024`.
  Digest là 64 ký tự hex thường. Metadata giống nhau trả 200 và giữ tiến độ;
  metadata khác trả 409. Tối đa 16 danh tính, kể cả completed và aborted.
- `GET /uploads/:id` trả `{id,parts,size,sha256,status,received}`;
  received được sắp theo số phần, mỗi mục `{number,size,sha256}`.
- `PUT /uploads/:id/parts/:number` nhận `{base64,sha256}`. Mỗi phần 1–1024
  byte, số phần từ 1 đến parts. Base64 phải canonical, có padding đúng, không
  whitespace. Digest kiểm tra trên byte gốc. Replay giống hệt trả 200;
  thay phần đã chấp nhận trả 409. Sai kiểu, checksum hoặc encoding trả 400.
- `POST /uploads/:id/complete` nhận `{}`. Thiếu phần, sai tổng size hoặc full
  digest trả 409. Transaction lưu BLOB toàn bộ và chuyển complete cùng lúc.
  Replay completion trả 200. Không có thời điểm reader thấy nửa đối tượng.
- `DELETE /uploads/:id` xóa BLOB staged và giữ tombstone aborted. Lặp lại
  thành công; completed trả 409; late part không hồi sinh ID.
- `GET /objects/:id` chỉ trả completed `{id,base64,size,sha256}`. Missing,
  open và aborted trả 404. Reader xác minh schema, ID, canonical bytes, size và
  digest trước khi gửi 200. Upstream invalid/timeout/redirect trả 502; 404
  vẫn là 404. Không chuyển tiếp redirect sang origin khác.

Body request tối đa 9000 byte, tính cả JSON escaping: base64 của 1024 byte
có 1368 ký tự, mỗi ký tự có thể viết bằng 6 byte `\uXXXX`, cộng digest và
keys vẫn dưới 9000. Reader giới hạn 68000 byte, đủ JSON escaped cho object
8192 byte (10924 ký tự base64). JSON hợp lệ nhưng vượt ngân sách vẫn bị từ
chối. Request body có thời hạn 1500 ms; upstream deadline gồm headers và body.
Unknown route trả 404; quá ngân sách body trả 413. Các route có JSON input
kiểm tra object và kiểu primitive, không chuyển boolean thành số.

## Ví dụ hai phần đến đảo thứ tự

SHA-256 của `ab` là
`fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603`.
Tạo ID `demo`, parts 2, size 2 và digest trên. Gửi phần 2 chứa `Yg==` (`b`),
rồi dừng owner bằng SIGKILL. Khởi động lại với cùng STORE_DB, GET metadata
cho biết phần 2 đã nhận. Client chỉ gửi phần 1 `YQ==` (`a`), với SHA-256
của từng phần, rồi complete. Trước complete reader trả 404; sau đó trả
`base64: "YWI="`. Test tích hợp thực hiện nguyên luồng này bằng tiến trình thật.

Checksum phần phát hiện lỗi truyền sớm, checksum toàn bộ phát hiện sai nội dung
hoặc thứ tự ghép. Muốn đổi phần đã commit phải tạo upload ID mới: nếu cho ghi đè,
retry cũ có thể âm thầm đảo ngược nội dung mới. Transaction `BEGIN IMMEDIATE`
tuần tự hóa kiểm tra và ghi; WAL và synchronous FULL hỗ trợ phục hồi crash.

## Giới hạn và vận hành

Tombstone ngăn retry cũ hồi sinh dữ liệu nhưng chiếm quota vĩnh viễn. Abort
thu hồi BLOB staged về mặt logic; SQLite có thể giữ trang trống để tái sử dụng,
không đảm bảo file nhỏ lại ngay. Completed giữ cả phần và object để replay
chính xác. Demo không tự xóa abandoned uploads: cần chính sách retention và
namespace/generation trước khi tái dùng danh tính một cách an toàn.

Không có authorization, tenant quota, TLS hay chống lạm dụng cho Internet.
Triển khai thật phải ràng buộc quyền sở hữu upload/read/abort, giới hạn dung
lượng và tốc độ theo tenant, dọn abandoned uploads và quan sát quota. SHA-256
không thay thế xác thực người gửi. SQLite BLOB và JSON/base64 phải giữ dữ liệu
trong RAM, tăng dung lượng ít nhất khoảng 4/3; thiết kế này không streaming và
không dành cho file lớn. Không có mô phỏng S3, đường dẫn file từ caller hay
teaching-control trong ứng dụng; provider controls chỉ là fixture test.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/43-resumable-multipart-upload/test/lesson.test.mts
node --test lessons/43-resumable-multipart-upload/test/lesson.test.mts
npm run check
make test
git diff --check
```

Các test unit dùng SQLite in-memory. Test HTTP tạo DB dưới `node:os` tmpdir,
cổng loopback tạm, child processes độc lập và cleanup trong finally. Provider
fixture dùng lại một tiến trình qua các biến thể malformed/schema/checksum,
oversized/slow/redirect; target counter chứng minh redirect không được theo.
Worker không có mạng chỉ chạy typecheck và unit; controller chạy HTTP trong
Docker riêng. Không suy ra HTTP pass từ unit pass.

Bài tập: thiết kế retention có generation; thêm authorization theo owner;
so sánh checksum phần và checksum toàn object khi hai phần bị đảo; tính quota
cho cả BLOB staged, object và overhead SQLite; thiết kế streaming không lộ
partial object khi crash.

Tham khảo: [Amazon S3 multipart upload overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html),
[Node SQLite](https://nodejs.org/api/sqlite.html), [Node crypto](https://nodejs.org/api/crypto.html).
