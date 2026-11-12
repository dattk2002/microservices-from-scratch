# 56 — Version vector và multi-value register có context

Bài này xây một thanh ghi hư cấu ở hai tiến trình độc lập. Hai người ghi trong lúc mất kết nối tạo ra hai phiên bản cùng tồn tại. Người dùng phải đọc cả hai rồi quyết định giá trị mới; hệ thống không tự chọn người thắng theo đồng hồ.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (SQLite tích hợp), npm và các development package đã ghim của repository. Không cần thư viện runtime, tài khoản hay dịch vụ ngoài. Chạy từ thư mục gốc, mỗi lệnh service trong terminal riêng:

```sh
REPLICA_ID=a DB_PATH=/tmp/register-a.sqlite HOST=127.0.0.1 PORT=5656 node lessons/56-causal-multi-value-register/replica.mts
REPLICA_ID=b DB_PATH=/tmp/register-b.sqlite HOST=127.0.0.1 PORT=5657 node lessons/56-causal-multi-value-register/replica.mts
A_ORIGIN=http://127.0.0.1:5656 B_ORIGIN=http://127.0.0.1:5657 HOST=127.0.0.1 PORT=5658 node lessons/56-causal-multi-value-register/sync.mts
```

Mỗi replica dùng một file riêng. Danh tính được lưu cùng dữ liệu; dùng lại file của `a` với `REPLICA_ID=b` sẽ thất bại trước khi listen. Không xóa file để giải quyết xung đột danh tính. `HOST=127.0.0.1 PORT=0` chọn cổng tạm và in một dòng JSON `{service,port}` cho trình quản lý. Import entrypoint không đọc cấu hình, mở database, đăng ký signal hay listen.

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/56-causal-multi-value-register/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-name-pattern=integration: lessons/56-causal-multi-value-register/test/lesson.test.mts
npm run check
make test
git diff --check
```

Worker không có mạng chỉ chạy typecheck/unit; controller chạy HTTP thật trong Docker cô lập. Các test tạo file dưới `node:os.tmpdir()`, đóng mọi tiến trình trước khi xóa thư mục, kể cả khi startup lỗi. Không cần sửa source readonly trong container.

## Hợp đồng và kiến trúc

```text
client → replica a → SQLite riêng a
client → replica b → SQLite riêng b
client → sync → GET nguồn cố định → POST /merge đích cố định
```

`GET /value` trả toàn bộ trạng thái, ban đầu:

```json
{"context":{"a":0,"b":0},"siblings":[]}
```

Context là vector các số nguyên 0..16 đã quan sát. Mỗi sibling có đúng `{dot:{actor,counter},value}`. Actor chỉ `a` hoặc `b`, counter 1..16 phải bằng thành phần context tương ứng. Value là `null` hoặc chuỗi URL-safe `[A-Za-z0-9_-]` dài 1..32. Có tối đa hai sibling theo thứ tự actor, không lặp actor/dot. Chỉ context toàn zero được có danh sách rỗng. Các object đều kiểm tra field chính xác; null/array/primitive không thay cho object.

`POST /write {context,value}` yêu cầu context bằng chính xác trạng thái hiện tại. Stale hoặc forged context trả 409, không đổi dữ liệu. Ghi thành công tăng riêng thành phần của replica, thay mọi sibling đã quan sát bằng một dot mới, trả 200 với trạng thái đầy đủ. Counter riêng đã 16 trả 429, kể cả khi muốn xóa. `BEGIN IMMEDIATE` bảo vệ đọc-kiểm tra-cập nhật; context và siblings nằm cùng một hàng JSON và commit cùng nhau. GET, write, merge đều đọc state bền vững, không có cache state trong RAM.

`POST /merge` nhận state hoàn chỉnh, kiểm tra trước transaction. Context kết quả là max theo từng thành phần. Dot chung giữ lại nếu value giống nhau; cùng dot khác value trả 409. Dot chỉ có ở một phía sống sót khi counter lớn hơn context của phía kia cho actor đó. Một lịch sử mâu thuẫn có thể loại hết sibling trong khi context vẫn khác zero: trả 409 và rollback. State bị dominated và merge lặp trả 200. JSON/schema lỗi trả 400; body public lớn hơn 8192 byte trả 413; media type khác JSON trả 415; route khác trả 404.

## Ví dụ nhân quả, không dựa vào thời gian

1. Ghi `red` tại a với context `{a:0,b:0}` tạo `a1`. Trong lúc chưa sync, ghi `blue` tại b với cùng context tạo `b1`.
2. Gọi sync `{from:"a"}`, rồi `{from:"b"}`. Hai bên có context `{a:1,b:1}` và cả `red`, `blue`. Không có quan hệ quan sát giữa hai lần ghi này nên chúng đồng thời.
3. Đọc hai sibling, người dùng chọn `purple`, ghi tại a với `{a:1,b:1}` tạo `a2` với context `{a:2,b:1}`. Sau merge chỉ còn `purple`.
4. Ghi `null` tại a với context mới tạo `a3`. Null là một sibling được lưu, không phải vắng dữ liệu. Merge snapshot cũ chứa `a1`/`b1` không hồi sinh màu cũ vì context của deletion đã quan sát chúng.

```sh
curl -s http://127.0.0.1:5656/value
curl -s -H 'content-type: application/json' -d '{"context":{"a":0,"b":0},"value":"red"}' http://127.0.0.1:5656/write
curl -s -H 'content-type: application/json' -d '{"from":"a"}' http://127.0.0.1:5658/sync
```

Version vector mô tả quan hệ quan sát; nó không đo thời gian thực. Dot định danh một sự kiện ghi. Thứ tự actor trong JSON chỉ để canonical hóa, không tạo total order và không ưu tiên `a`. Không có last-writer-wins ẩn. Các luật giao hoán/kết hợp/lũy đẳng được kiểm thử trên những lịch sử reachable suy ra bằng tay; đầu vào tự mâu thuẫn bị loại, không được xem là lịch sử hợp lệ để hứa các luật đại số.

## Relay, lỗi và giới hạn

`POST /sync {from:"a"|"b"}` chỉ dùng hai origin cấu hình, chuẩn hóa và buộc khác nhau, HTTP loopback không có credentials/path/query/hash. Caller không chỉ định URL. Relay GET `/value` nguồn, kiểm tra schema đầy đủ, POST `/merge` đích rồi kiểm tra state trả về. Thành công 200; semantic conflict từ đích trả 409. Source 404/status lỗi, malformed/schema lỗi, body quá lớn, timeout, redirect và transport lỗi trả 502. Không retry tự động.

Một `AbortSignal.timeout(300)` dùng chung cả hai hop và đọc hết body, không cấp lại 300ms mỗi hop. Fetch dùng `redirect:error`. Mỗi body upstream tối đa 2048 byte; con số này dư cho mọi string token JSON escape thành `\uXXXX`, kể cả hai value dài 32 và key. Không giả định độ dài JSON canonical bằng wire size. Body vượt mức nhưng vẫn parse được và schema đúng vẫn bị chặn. Public inbound dùng giới hạn 8192 byte từ helper chung. Không có hàng đợi hoặc lịch sử tăng vô hạn.

Lỗi phản hồi không chứng minh chưa commit: target có thể commit rồi mất kết nối. Khôi phục bằng sync lại cùng snapshot với merge lũy đẳng, không tuyên bố exactly-once. Fixture test-only có control khi `TEACHING_CONTROLS=1`; mặc định route control 404. Fixture tái sử dụng cho status, JSON, escaped/oversize, body chậm, redirect, ngắt kết nối. Redirect có origin đích khác thật và kiểm tra bộ đếm trước mọi đổi mode để chứng minh payload không đi tới đó.

Context là lời khai được tin cậy trong topology học tập này. Người gửi độc hại có thể giả context để loại giá trị; strict schema không xác thực lịch sử. Không dùng đây như hệ thống phân quyền hoặc production assurance. Hai thành viên cố định, capacity 16, giới hạn value và 300ms là lựa chọn giáo dục. Không đổi membership, garbage-collect tombstone, tái sử dụng actor với database trắng, hay reset counter an toàn. Đây là tập con dotted multi-value-register hai replica có chặn dung lượng, không tương thích giao thức Dynamo/Riak.

## Bài tập

- Vẽ các context cho hai lần ghi liên tiếp tại b trước khi b gặp a1; dự đoán sibling sau merge.
- Vì sao xóa sibling null mà giữ context tạo đầu vào không hợp lệ ở bài này?
- Thiết kế migration capacity không reset counter; cần đổi schema và test biên nào?
- Nếu thêm actor c, phần nào của proof, validation và giới hạn body phải thay đổi?

## Nguồn gốc khái niệm

- [Amazon Dynamo, SOSP 2007](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): versioning, reconciliation và tradeoff availability.
- [Dotted Version Vectors, 2012](https://gsd.di.uminho.pt/members/vff/dotted-version-vectors-2012.pdf): tách định danh sự kiện khỏi context nhân quả.

Ví dụ, giao thức HTTP và các giới hạn ở đây được viết riêng cho bài học, không sao chép implementation của hai tài liệu.
