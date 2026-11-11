# 53 — HTTP cache, ETag revalidation, Age và Vary

Bài này xây một **JSON gateway/cache có tập con HTTP cố định**, không phải một
intermediary triển khai đầy đủ RFC 9111. Mục tiêu là phân biệt “đã lưu” với “còn
fresh”, và thấy tại sao một bản tiếng Việt không thể dùng để trả lời tiếng Anh.

Cần Node.js 24.12+ (SQLite tích hợp), npm và các dev package đã khóa ở root.
Đọc trước bài 16 (cache-aside), 22 (If-Match) và HTTP request/response cơ bản.
Không cần tài khoản, dịch vụ bên ngoài hay runtime package.

## Chạy hai tiến trình

Chạy từ root repository, mỗi dòng trong một terminal riêng:

```sh
DB_PATH=/tmp/lesson53-origin.sqlite HOST=127.0.0.1 PORT=3053 node lessons/53-http-cache-revalidation/origin.mts
ORIGIN_URL=http://127.0.0.1:3053 HOST=127.0.0.1 PORT=3054 node lessons/53-http-cache-revalidation/cache.mts
curl -i -H 'Accept-Language: vi' http://127.0.0.1:3054/document
curl -i -H 'Accept-Language: vi' http://127.0.0.1:3054/document
```

`HOST` mặc định `127.0.0.1`; `PORT=0` chọn cổng ephemeral, stdout báo readiness
JSON `{service,port}`. Origin mặc định cổng 3053, cache 3054. `DB_PATH` mặc định
`documents.sqlite` trong thư mục hiện hành. `ORIGIN_URL` mặc định
`http://127.0.0.1:3053`, phải là một HTTP origin không userinfo/path/query/hash.
Origin này cố định suốt đời tiến trình; caller không cung cấp URL upstream.
Không redirect, retry hoặc refresh nền. Một fetch, gồm cả đọc body, có deadline
1 giây. Mỗi HTTP server dùng request/header timeout 5 giây của helper chung.
Không đưa hai dịch vụ này lên Internet.

Luồng dữ liệu:

```text
client → cache.mts → origin.mts → SQLite (en và vi)
            │
            └─ Map tối đa hai biến thể trong RAM, không có file cache
```

Các module chỉ thực hiện cấu hình, mở DB, listen và đăng ký signal trong `main()`;
import không khởi động ứng dụng. SQLite được import trong `main()` để import
entrypoint cũng không phát cảnh báo SQLite. SIGTERM/SIGINT đóng listener; khi
listener đã đóng, origin đóng database. Startup lỗi sau mở DB cũng đóng DB.

## Hợp đồng

`GET /document` ở cả hai dịch vụ chọn đúng `Accept-Language: en` hoặc `vi`.
Thiếu header chọn `en`; danh sách, trọng số và ngôn ngữ khác trả 400. Body 200 là
`{language,version,text}`; version là số nguyên 1..8; text có 1..32 ký tự ASCII
trong `[A-Za-z0-9_-]`. Ban đầu `en/1/Hello`, `vi/1/Xin_chao`.
Origin dùng strong ETag chính xác `"en-1"` hoặc `"vi-1"`; chỉ một
`If-None-Match` bằng hoàn toàn mới nhận 304 rỗng. Cả 200 lẫn 304 có:

- `ETag`, `Vary: Accept-Language`, `Date` HTTP canonical, `Age: 0`.
- Policy public: `Cache-Control: public,max-age=5,must-revalidate`.
- Hai policy khác: `Cache-Control: private` hoặc `no-store`.

Gateway luôn trả 200 JSON đã kiểm tra, ngay cả khi origin trả 304. Header
`X-Cache` là `miss`, `hit`, `revalidated` hoặc `bypass`. Các header metadata được
kiểm tra rồi chuyển tiếp; `Age` được tính lại và làm tròn xuống. `private` và
`no-store` luôn còn trên downstream response, bao gồm sau 304: bỏ header này có
thể khiến một cache khác lưu dữ liệu không được phép lưu. Cache xóa biến thể đó
và không lưu bản mới. Caller có `Authorization` hoặc `Cookie` nhận 400; đây không
phải proxy cho dữ liệu đã xác thực. Client conditional request không được hỗ trợ;
gateway tự quyết định điều kiện với origin và trả 200.

`GET /state` của cache trả mảng sắp theo ngôn ngữ:
`[{language,etag,version,age}]`. Không trả text hay lịch sử request. Các route
không tồn tại hoặc method không được hỗ trợ nhận 404. JSON input không hợp lệ,
null, array, boolean hoặc field sai primitive nhận 400. Body control tối đa 8192
byte qua helper HTTP chung; upstream representation tối đa 1024 byte. Với JSON
canonical không whitespace, ba key có tổng 19 ký tự, language tối đa 2 và text
32: escape mỗi ký tự thành `\uXXXX` vẫn dưới 512 byte kể cả dấu phân cách và
version. Budget 1024 nhận được mọi biểu diễn string-token escape tối đa đó, nhưng
không nhận whitespace vô hạn. Fixture oversize vẫn là JSON và schema hợp lệ;
nó chỉ thêm whitespace sau object. Không escape chữ số của version hoặc các
primitive JSON khi tạo fixture.

## Tuổi và revalidation

Với thời gian tính bằng giây, `requestTime` trước fetch và `responseTime` lúc
nhận response headers:

```text
apparentAge = max(0, responseTime - DateSeconds)
responseDelay = max(0, responseTime - requestTime)
initialAge = max(apparentAge, originAge + responseDelay)
currentAge = initialAge + max(0, now - responseTime)
```

Ví dụ requestTime=100, responseTime=103, Date=102, Age=4 cho initialAge=7,
không phải 4. Date=90, Age=0 cho initialAge=13. Clock skew không được làm tuổi
âm. Hit chỉ khi `currentAge < 5`: age4 hit, age5 phải hỏi origin. Origin có clock
riêng; advance cache không tự sửa Date origin.

Khi stale, gateway gửi ETag của **đúng language**. 304 chỉ hợp lệ khi có body cũ
và ETag khớp, Vary/policy/Date/Age hợp lệ. Nó giữ body cũ và cập nhật metadata.
200 phải được đọc hết trong budget, parse JSON và kiểm tra language/version/text
cùng ETag trước khi thay RAM. Metadata không hợp lệ, upstream 503, lỗi kết nối,
redirect, JSON lỗi, quá byte hoặc quá deadline đều thành 502, không trả stale,
không cập nhật nửa chừng. Đây là `must-revalidate`, không có stale-if-error.

Mỗi lần cập nhật có generation riêng cho từng ngôn ngữ. Response bắt đầu từ
generation cũ vẫn có thể kết thúc request đang chờ của nó, nhưng không được ghi
đè hoặc làm fresh bản mới. Unit test giữ một 304, cho một 200 version2 hoàn tất
trước, rồi mới thả 304; state phải vẫn là version2. Không dùng sleep để chứng
minh race. Cache không gộp các request đồng thời: có thể phát sinh nhiều fetch.

## Điều khiển giảng dạy

Chỉ bật **cục bộ** với `TEACHING_CONTROLS=1`. Mỗi dịch vụ có thể thêm
`TEACHING_EPOCH_SECONDS=1700000000` để chạy logical clock. Có epoch mà không có
controls, epoch sai hoặc vượt miền HTTP Date sẽ làm startup thất bại. Bình thường
clock là thời gian thực. `POST /teaching/advance {seconds:1..60}` tăng offset,
tổng không quá 300 giây, trên từng dịch vụ riêng. Không bật controls: route 404.

Origin còn có:

- `POST /teaching/content {language,version,text,policy}`; policy chính xác
  `public|private|no-store`. Version cao hơn được lưu; full replay chính xác được
  nhận; cùng version nhưng khác field hoặc version cũ nhận 409. Cả hai biến thể
  được lưu SQLite qua restart.
- `POST /teaching/availability {available:boolean}` chỉ làm GET document trả
  503; control vẫn chạy. Trạng thái này chỉ ở RAM.
- `GET /teaching/state` trả `{requests,notModified}`; counters bão hòa ở 1 triệu,
  không lưu raw request hay header.

Ví dụ khởi động lại hai lệnh trên với controls và epoch giống nhau; sau hit,
advance **cả origin lẫn cache**:

```sh
curl -s -H 'Content-Type: application/json' -d '{"seconds":5}' http://127.0.0.1:3053/teaching/advance
curl -s -H 'Content-Type: application/json' -d '{"seconds":5}' http://127.0.0.1:3054/teaching/advance
curl -i http://127.0.0.1:3054/document
curl -s -H 'Content-Type: application/json' -d '{"language":"en","version":2,"text":"New_text","policy":"public"}' http://127.0.0.1:3053/teaching/content
```

Advance cả hai thêm 5 giây: request tiếp theo lấy 200 version2. Đổi policy cần
version mới; policy public vừa lưu vẫn có thể được dùng đến hết freshness đã
cấp trước đó. Origin không thể thu hồi tức thì một response đã được cache.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/53-http-cache-revalidation/test/lesson.test.mts
node --test lessons/53-http-cache-revalidation/test/lesson.test.mts
npm run check
make test
git diff --check
```

Worker không có network chỉ chạy typecheck và unit. Controller chạy HTTP tests
trong môi trường isolated có loopback; đừng diễn giải unit xanh là integration
xanh. Integration dùng child process thật, PORT=0, tmpdir của hệ điều hành,
finally lồng nhau để bảo vệ cả startup failure. Một fixture process dùng lại cho
các lỗi schema/metadata/body; redirect tới một process loopback khác đã readiness,
kiểm tra counter đích ngay sau redirect để chứng minh không có forwarding.
Test import chạy child với DB_PATH/ORIGIN_URL/PORT/epoch cố tình sai, yêu cầu exit0
và stdout/stderr rỗng.

## Ranh giới và đánh đổi

Khác cache-aside ở bài 16: application cache-aside thường biết DB/domain và tự
invalidation; ở đây gateway chỉ dựa trên HTTP representation, freshness và
validator của origin. Khác If-Match ở bài 22: If-None-Match kiểm tra có cần tải
body để đọc; If-Match bảo vệ một write khỏi cập nhật mất dữ liệu. Control version
trong bài là quy tắc demo đơn giản, không phải giao thức write concurrent hoàn chỉnh.

Tập con này không có heuristic freshness, shared auth caching, client conditional
requests, ranges, compression, stale-if-error, negotiation tổng quát, cache trên
disk hay proxy tới URL tùy ý. Chỉ một route, hai ngôn ngữ và ba policy chính xác.
Date phải canonical, Age chỉ nhận số nguyên không âm tối đa 9 chữ số; nhiều
Cache-Control/Vary hợp lệ ngoài tập con vẫn bị từ chối. Giới hạn text/version là
để mọi fixture có bounds nhỏ, không phải khuyến nghị cho ứng dụng nội dung thực.

Bài tập: (1) thêm test Date nằm trong tương lai với Age lớn; (2) cho hai client
cùng revalidate tiếng Việt và giải thích generation; (3) thiết kế request
coalescing nhưng vẫn có deadline và không trộn language; (4) giải thích vì sao
không thể thêm authenticated response chỉ bằng bỏ kiểm tra Cookie.

Nguồn chuẩn để đối chiếu, không phải tuyên bố hỗ trợ toàn bộ:
[RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html), đặc biệt
freshness/age/validation; [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html),
ETag, điều kiện request và 304.
