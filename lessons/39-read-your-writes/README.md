# 39 — Đọc lại điều vừa ghi: version barrier và fallback có giới hạn

Bài này cần Node.js 24.12+ (SQLite tích hợp), kiến thức HTTP, transaction và bài 15 CQRS. Không cần dịch vụ ngoài hay package runtime. CQRS tách đường ghi/đọc nhưng không tự bảo đảm rằng người vừa ghi sẽ đọc được dữ liệu đó. Ở đây client giữ `commitVersion` trả về từ primary và gửi nó làm **mức tối thiểu** cho lần đọc tiếp theo.

## Chạy bằng tiến trình riêng

Từ thư mục repository, dùng ba terminal, với hai đường dẫn SQLite khác nhau:

```sh
HOST=127.0.0.1 PORT=3932 DB_PATH=/tmp/ryw-replica.sqlite node lessons/39-read-your-writes/replica.mts
HOST=127.0.0.1 PORT=3931 DB_PATH=/tmp/ryw-primary.sqlite REPLICA_ORIGIN=http://127.0.0.1:3932 TEACHING_CONTROLS=1 node lessons/39-read-your-writes/primary.mts
HOST=127.0.0.1 PORT=3930 PRIMARY_ORIGIN=http://127.0.0.1:3931 REPLICA_ORIGIN=http://127.0.0.1:3932 DEADLINE_MS=800 node lessons/39-read-your-writes/gateway.mts
```

`PORT=0` chọn cổng tạm; dòng JSON `{service,port}` báo sẵn sàng. Mặc định HOST là loopback. DB_PATH mặc định là primary.sqlite/replica.sqlite trong thư mục hiện tại; giữ file qua restart và không dùng chung file giữa hai vai trò. Cấu hình origin chỉ chấp nhận HTTP origin không có user/password/path/query/hash. Không có origin thì mặc định cổng 1 để dependency thất bại rõ ràng. Không có listener, cấu hình, DB hay signal handler nào chạy khi import entrypoint.

Kịch bản Playground/local:

```sh
curl -X POST http://127.0.0.1:3931/replication/hold
curl -H 'content-type: application/json' -d '{"value":"ban-thao"}' http://127.0.0.1:3930/items/note
curl http://127.0.0.1:3930/items/note
curl 'http://127.0.0.1:3932/items/note?minVersion=1'
curl 'http://127.0.0.1:3930/items/note?minVersion=1'
curl -X POST http://127.0.0.1:3931/replicate
curl 'http://127.0.0.1:3930/items/note?minVersion=1'
curl -X POST http://127.0.0.1:3931/replication/release
```

Trên DB mới: casual read trả 404, replica trả 425, gateway đọc primary trả bản vừa ghi; sau replicate gateway đọc replica. Nếu DB đã có lịch sử, dùng version thực trong write reply. Hold/release chỉ bật khi `TEACHING_CONTROLS=1`, chỉ ngăn các push mới, không hủy push đang chạy. `/replicate` gửi snapshot ngay dù đang hold. Đây là HTTP control nhỏ cho giáo dục trên máy cục bộ, không có xác thực và không phù hợp production. Không có route đổi URL hay reset dữ liệu.

## Hợp đồng và kiến trúc

Primary `POST /items/:id {value}` trả `{item:{id,value},commitVersion,source:"primary"}` sau commit. Id thuộc `[A-Za-z0-9_-]{1,64}`, value là chuỗi tối đa 256 UTF-16 code units, tối đa 16 identities. Ghi đè cũng tăng version toàn cục; safe integer hết miền thì 409, không wrap. Transaction `BEGIN IMMEDIATE` đọc/sửa/lưu một JSON snapshot trong một hàng SQLite, nên item và watermark không thể lệch nhau. WAL và transaction cung cấp durability trong phạm vi bảo đảm SQLite/filesystem, không phải bảo đảm chống mất ổ đĩa.

Primary `GET /snapshot` trả `{items,commitVersion}` nguyên tử. Push best effort đến REPLICA_ORIGIN cố định, deadline 500 ms, không chặn write reply và không retry tự động. Replica `POST /snapshot` xác thực toàn bộ trước transaction. Snapshot mới thay toàn bộ trạng thái; cũ trả `older`, replay chuẩn hóa theo thứ tự id trả `duplicate`, cùng version khác nội dung trả 409. Các item phải duy nhất, số item không vượt version, version không âm và safe integer. Không truyền watermark trước rồi apply từng dòng: snapshot lỗi không được nâng barrier. API tin primary là nguồn snapshot đầy đủ; không có chữ ký hay khả năng nhận biết một nguồn hợp lệ đang cố tình nói dối.

Cả hai store `GET /items/:id?minVersion=N`: 425 `{error:"lag",commitVersion,source}` nếu chưa đạt N, kể cả khi item không tồn tại; đạt rồi mới trả 200 hoặc 404 `{error:"missing",commitVersion,source}`. N chỉ nhận dạng thập phân chuẩn `0` hoặc số không có zero đầu; không nhận âm, phân số, exponent, overflow hay tham số lặp.

Gateway đọc replica **một lần**. Chỉ 425 với `source` đúng chuỗi `replica`, `error` đúng chuỗi `lag` và watermark nhỏ hơn N mới được fallback primary **một lần**. Cả hai lần dùng chung AbortSignal với DEADLINE_MS (10–5000, mặc định 800). Primary cũng kiểm tra barrier, nên future token trả 425 thay vì stale success. Mạng lỗi, redirect, upstream sai schema hoặc success dưới N trả 502; hết deadline trả 504. Không fallback khi replica chết, 404 hay reply giả mạo lag: đây là chính sách hẹp để quan sát chi phí và tránh che lỗi. Successful reply phải có id, value, version và source đúng vai trò; failure 404/425 cũng được kiểm tra trước khi chuyển tiếp. Reply lag thiếu hoặc sai source trả 502 trước khi gọi primary. Write lỗi upstream trả lỗi gateway rõ ràng; nếu mất reply sau primary commit, kết quả write có thể không chắc chắn, không retry mù.

Fetch dùng `redirect:error` cho ghi, đọc và push; origin cố định không bị HTTP redirect đổi thành nơi nhận payload khác. Request timeout server là 5 giây. Body được đếm bytes trong stream; write tối đa 1600 bytes: value xấu nhất `256*6=1536` bytes escape cộng 12 bytes envelope. Snapshot tối đa 27000 bytes: `16*(1536+64+32)` cộng envelope/version nhỏ hơn 27000. Id hợp lệ không cần escape bắt buộc khi serialize; một client tự escape id hoặc thêm whitespace quá mức có thể vượt budget dù schema tương đương. JSON stringify của 16 item có value toàn NUL vẫn được chấp nhận. Response upstream cũng bị chặn 27000 bytes; không đọc vô hạn.

## Giới hạn quan trọng

Token chỉ là minimum version của **một lịch sử primary bền vững**. Token cũ có thể trả dữ liệu mới hơn, không chọn historical snapshot. Nó không phải credential, không nối epoch giữa database và không chứng minh causal consistency toàn hệ thống. Xóa/thay DB làm token mất phạm vi ý nghĩa: đừng đưa token cũ vào lịch sử mới dù số version trùng nhau. Bài không triển khai failover primary, chống giả mạo token, retry bền vững, outbox, catch-up tự động hay tombstone/delete. Process chết sau commit trước push có thể để replica cũ đến lần push/replicate sau.

Barrier đổi availability và latency lấy sự nhất quán cho lần đọc: replica lag cần thêm round trip; primary unavailable thì đọc có token thất bại. Casual read chấp nhận stale để rẻ hơn. Khác bài 15, không chỉ tạo projection bất đồng bộ: bài này ràng buộc kết quả đọc bằng watermark và làm failure observable qua source/version. Tham khảo mô hình session/read-your-writes: [Azure Cosmos DB consistency levels](https://learn.microsoft.com/en-us/azure/cosmos-db/consistency-levels). Cơ chế nhỏ này không có đầy đủ bảo đảm session của Cosmos DB.

## Kiểm thử và bài tập

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/39-read-your-writes/test/lesson.test.mts
node --test --test-timeout=15000 lessons/39-read-your-writes/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit tests dùng SQLite memory, đã quan sát assertion RED trước GREEN. Integration dùng child processes, loopback ephemeral ports, fixture DB trong `os.tmpdir()` và cleanup trong finally. Chúng kiểm tra stale/fallback, token cũ/future, restart, dependency lỗi, deadline, body byte gate, snapshot invalid không ghi, và redirect không gửi dữ liệu đến sink. Worker mạng bị khóa chỉ chạy typecheck/unit; controller chạy HTTP và các kiểm tra đầy đủ trong Docker.

Bài tập: thử hai writes liên tiếp khi hold rồi replicate một snapshot; giải thích vì sao token đầu tiên đọc giá trị mới nhất. Thiết kế epoch rõ ràng trước khi hỗ trợ thay database. So sánh chính sách fallback khi replica unavailable với chính sách chỉ fallback 425 ở đây; nêu tải primary và nguy cơ thác lỗi. Nếu thêm delete, chứng minh full snapshot cùng watermark vẫn không hồi sinh item khi nhận snapshot cũ.
