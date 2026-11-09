# 44 — URL cấp quyền theo đối tượng, thời hạn và tiêu thụ một lần bền vững

Một đường dẫn chứa quyền truy cập có thể được chuyển cho người khác mà không cần
chuyển tài khoản. Bài này xây một **bearer capability**: ai giữ ticket thì có quyền
đọc đúng một đối tượng, đúng phương thức, trước hạn, và chỉ một lần. Dữ liệu và
khóa minh họa đều công khai, tự viết; không có dịch vụ đám mây.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (node:sqlite), npm và các gói phát triển đã ghim ở root.
Chạy từ root repository. Hai terminal dùng **hai tệp SQLite khác nhau** nhưng
cùng khóa. Đây là khóa demo công khai, tuyệt đối không thay bằng bí mật thật:

```sh
CAPABILITY_SECRET=public-demo-secret-0123456789abcdef DB_PATH=/tmp/lesson44-issuer.sqlite HOST=127.0.0.1 PORT=4401 node lessons/44-one-use-capability-urls/issuer.mts
CAPABILITY_SECRET=public-demo-secret-0123456789abcdef DB_PATH=/tmp/lesson44-objects.sqlite HOST=127.0.0.1 PORT=4402 node lessons/44-one-use-capability-urls/objects.mts
```

`PORT=0` chọn cổng tạm; mỗi tiến trình in một dòng JSON `{service,port}` khi sẵn
sàng. Không có listener, mở DB, đọc cấu hình hay đăng ký signal khi import module.
`DB_PATH` bắt buộc. `CAPABILITY_SECRET` bắt buộc 32..128 ký tự ASCII in được.
Catalogue bất biến chỉ có `doc`, `photo`, `report`, mỗi nội dung vài chục byte.

```sh
curl -sS http://127.0.0.1:4401/tickets -H 'content-type: application/json' \
  -d '{"requestId":"read-01","objectId":"doc","ttlSeconds":30}'
# Lấy trường path từ JSON trên và nối với http://127.0.0.1:4402.
# GET lần đầu: 200; GET lại chính đường dẫn đó: 409.
```

Không gửi ticket thật qua shell history. Trong bài, toàn bộ dữ liệu là demo.
Đường dẫn trả về là tương đối; client tự chọn object service tin cậy. Issuer không
nhận origin hay target URL của caller, không gọi upstream và không theo redirect.
Hai server không trao đổi qua HTTP: khóa chung cho phép object service tự xác minh.

## Hợp đồng và kiến trúc

`POST /tickets` nhận JSON object: `requestId` ASCII in được dài 1..32,
`objectId` thuộc catalogue và `ttlSeconds` là số nguyên 1..60. Không ép kiểu JSON.
Trả 200 `{path,expiresAt,requestId}`. Request ID gắn vĩnh viễn với object, TTL và
expiry trong SQLite của issuer. Gửi lại cùng metadata trả ticket ban đầu, kể cả
khi đã hết hạn; đổi object hoặc TTL trả 409. Một lần đọc mới cần request ID mới.

Ticket là `base64url(JSON.stringify([1,"objects-demo","GET",objectId,expiresAt,requestId]))`
không padding, dấu chấm và HMAC-SHA256 hex chữ thường 64 ký tự. Chữ ký phủ chính
segment base64url. Bộ xác minh kiểm tra độ dài/format trước `timingSafeEqual`,
rồi kiểm tra tuple chính xác sáu phần tử, primitive, phiên bản, audience,
phương thức, object, số nguyên expiry và canonical encoding. JSON có khoảng
trắng khác chuẩn cũng bị từ chối dù chữ ký đúng. Khóa chung là ranh giới tin cậy:
người biết khóa có thể tự tạo quyền.

`GET /objects/:id?ticket=...` trả 200 `{objectId,content}` sau khi tiêu thụ quyền.
Thiếu, giả mạo, sai object/audience/schema hoặc `now >= expiresAt` trả 403.
Query lặp hoặc query không hỗ trợ trả 400; phương thức khác trả 405 và không
consume. Ticket tối đa 1024 ký tự, URL 1400, tổng raw header 4096 ký tự. Node còn
có giới hạn header riêng; header quá lớn có thể bị parser từ chối trước handler.
JSON body tối đa 8192 byte qua helper dùng chung. Request hợp lệ lớn nhất có
32 ký tự ID; kể cả JSON dùng escape `\uXXXX`, cộng tên trường, object và TTL vẫn
nhỏ hơn 512 byte. Content type sai: 415, body quá lớn: 413, JSON sai: 400.
Route không tồn tại: 404. Teaching route cũng kiểm tra primitive, không biến
`null`, array hay boolean thành lỗi 500.

Registry `spent` dùng request ID, không lưu raw token. `BEGIN IMMEDIATE` bao phủ
kiểm tra trùng, kiểm tra dung lượng và insert, COMMIT **trước** phản hồi 200.
Hai kết nối SQLite tới cùng DB được tuần tự hóa bởi transaction, không phải bằng
kiểm tra trong RAM. Busy timeout 2 giây; lỗi lưu trữ ngoài hợp đồng trả 500 chung.
Restart không xóa spent ID. Cả hai registry giữ tối đa 16 bản ghi, không eviction,
kể cả bản ghi hết hạn. Đầy trả 503 và không ghi thêm; replay issuance cũ vẫn hoạt
động, replay spent vẫn 409. Đây là giới hạn cố ý của demo; muốn bắt đầu lại hãy
dừng server và chọn các DB_PATH mới. Không dùng các bản sao DB độc lập cho replica:
chúng sẽ cho phép tiêu thụ nhiều lần.

Invalid/expired/wrong-object bị chặn trước transaction consume, nên không chiếm
slot. Không có revocation trước expiry. Đồng hồ hai bên phải đồng bộ; HMAC không
sửa được clock skew. Nội dung catalogue không thay đổi sau khi cấp quyền.

## Thời gian logic và Playground

Mặc định dùng Unix seconds hiện tại. Chỉ khi đặt `TEACHING_CONTROLS=1`, có thể
đặt `TEACHING_EPOCH_SECONDS=1000` cho **cả hai** tiến trình. Fixed epoch không có
controls sẽ làm startup thất bại. Giá trị controls khác `1` bị từ chối.

```sh
curl -sS http://127.0.0.1:4402/teaching/advance \
  -H 'content-type: application/json' -d '{"seconds":30}'
```

POST này cộng thời gian riêng từng tiến trình, trả `{now}`; mỗi lần 1..60 giây,
tổng advance tối đa 3600 giây mỗi lần chạy. Không bật controls thì route là 404.
Đây là điều khiển giáo dục local, không triển khai công khai. Restart khôi phục
epoch cấu hình chứ không lưu offset; issuance và spent vẫn bền vững. Cần đặt lại
advance phù hợp khi thử expiry qua restart. Dùng hai thao tác advance nếu muốn
cả issuer và object service tiến cùng nhau; không cần chờ TTL thật.

## Giới hạn an ninh và mất phản hồi

Sau COMMIT mà kết nối đứt trước khi client nhận nội dung, retry trả 409: client
**không thể phục hồi object bằng retry tự động**. Đây là one-use, không phải bảo
đảm exactly-once delivery. Lưu cả response để replay sẽ thay đổi chính sách này.

Issuer là máy mint local **không xác thực**, không phải dịch vụ authorization
production. Production cần xác thực issuer, kiểm tra quyền theo user/object,
HTTPS, quản lý khóa, rotation (kèm chiến lược version/key ID), quota và cơ chế
revocation phù hợp. Ticket là bearer có thể ủy quyền bằng cách chuyển tiếp URL.
URL dễ lọt qua lịch sử trình duyệt, referrer, proxy/access log, analytics hoặc
ảnh chụp màn hình. Object response đặt `Cache-Control: no-store` và
`Referrer-Policy: no-referrer`; vẫn phải cấu hình toàn bộ hạ tầng không log query,
không log header hay token. Demo chỉ log readiness, không log request.

[AWS S3 presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
có thể dùng nhiều lần tới khi hết hạn. Custom one-use protocol này **không triển
khai semantics của AWS presigned URL** và không tương thích S3.

## Kiểm thử

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/44-one-use-capability-urls/test/lesson.test.mts
node --test lessons/44-one-use-capability-urls/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite `:memory:`, vector HMAC cố định, schema/tamper, scope, canonical,
expiry sát ranh giới, replay/capacity và child import với cấu hình cố tình sai.
Integration dùng hai child độc lập, ephemeral loopback, temp DB ở `node:os tmpdir`,
deadline cho từng request và cleanup trong finally; thử restart cả hai service,
wrong object rồi dùng đúng, 200/409, malformed schema, expiry logic, duplicate
query, issuer retention và không log ticket. Không listener ở test-module top level.
Trong sandbox worker không có mạng, chỉ chạy typecheck/unit; bộ điều phối chạy
HTTP và các kiểm tra toàn bộ trong Docker cô lập, không tăng timeout.

## Bài tập

1. Giải thích vì sao retry cấp vé không được kéo dài expiry và vì sao TTL thuộc
   metadata bất biến, dù expiry đã được lưu.
2. Thiết kế key rotation có hai key ID; xác định chính xác thời điểm được xóa key
   cũ mà không vô tình kéo dài quyền.
3. So sánh lưu spent vĩnh viễn với dọn spent sau expiry khi clock có thể lùi;
   điều kiện nào mới cho phép garbage collection an toàn?
4. Thay catalogue bằng nội dung có phiên bản: quyền gắn với object ID hay digest?
   Viết hợp đồng trước khi thay implementation.
