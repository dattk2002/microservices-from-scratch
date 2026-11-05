# 28 — Phân trang keyset, snapshot hữu hạn và checkpoint tiếp tục

Cần Node.js 24.12+ (SQLite tích hợp), kiến thức HTTP, transaction và retry từ các bài trước. Không cần package runtime, tài khoản hay dịch vụ ngoài. Chạy lệnh từ gốc repository.

## Hai chủ sở hữu dữ liệu

`owner.mts` sở hữu SQLite nguồn và snapshot. `scanner.mts` là process HTTP độc lập, chỉ gọi HTTP owner và sở hữu SQLite kết quả/checkpoint riêng. Không dùng chung file database giữa hai dịch vụ.

```text
client → scanner HTTP → owner HTTP → owner.sqlite
             ↓
        scanner.sqlite
```

Khóa `id` là số nguyên dương duy nhất, không đổi khi cập nhật. PUT kiểu demo thực hiện bằng POST `/resources` với `{id,kind,value}`; id cũ cập nhật kind/value, không đổi khóa. `/delete` nhận `{id}`. `kind` phải là chuỗi `a` hoặc `b`, không nhận mảng/object. Value giới hạn 128 byte UTF-8. Tối đa 100 tài nguyên đang tồn tại.

POST `/snapshots` với `{kind:"a",size:2}` trả 201 `{token}`. Trong một `BEGIN IMMEDIATE`, owner dọn session hết hạn, kiểm tra tối đa 8 snapshot, tạo session rồi `INSERT ... SELECT` dữ liệu đã chọn sang bảng frozen. Writer không thể chen giữa các bước. Mỗi snapshot chứa tối đa 100 hàng. Thay đổi nguồn sau commit không thay đổi dữ liệu frozen.

POST `/page` với `{token,kind:"a",size:2}` trả `{rows,next}`. `next:null` kết thúc. Truy vấn `WHERE session=? AND id>? ORDER BY id LIMIT ?` dùng primary index `(session,id)`, không dùng OFFSET. Keyset **không tự tạo snapshot isolation**: chính bản sao transaction mới cố định tập khóa và giá trị. Không triển khai Graph/OData.

Token là 24 byte ngẫu nhiên sinh tại owner, biểu diễn hex opaque. Scanner chỉ chuyển token trong JSON, không dùng làm SQL hay URL. Session ràng buộc kind và size (1..10). Mỗi vị trí chỉ có một record token nhờ UNIQUE(session,pos); replay token trả cùng trang/next, không tăng cursor vô hạn. Mỗi snapshot có tối đa 101 vị trí, kể cả snapshot rỗng. SQL dùng tham số bind.

## Chạy thử cục bộ

```sh
DB_PATH=/tmp/keyset-owner.sqlite HOST=127.0.0.1 PORT=3028 node lessons/28-keyset-pagination/owner.mts
DB_PATH=/tmp/keyset-scanner.sqlite OWNER_URL=http://127.0.0.1:3028 HOST=127.0.0.1 PORT=3029 TEACHING_CONTROLS=1 node lessons/28-keyset-pagination/scanner.mts
curl -s -H 'content-type: application/json' -d '{"id":1,"kind":"a","value":"ban đầu"}' http://127.0.0.1:3028/resources
curl -s -H 'content-type: application/json' -d '{"kind":"a","size":1}' http://127.0.0.1:3029/begin
curl -s -H 'content-type: application/json' -d '{}' http://127.0.0.1:3029/step
curl -s http://127.0.0.1:3029/state
```

PORT=0 chọn cổng tạm, mỗi process in một dòng JSON `{service,port}` khi sẵn sàng. Cấu hình chỉ đọc trong main; import không mở SQLite, listener, signal hay background job. DB_PATH mặc định owner.sqlite/scanner.sqlite; nên luôn chỉ định đường dẫn riêng ngoài source. OWNER_URL chỉ nhận HTTP loopback 127.0.0.1, cố định theo cấu hình, không theo token.

`/begin` chỉ tạo scan khi chưa có scan. Muốn scan mới phải gửi `replace:true`, kể cả scan đã hoàn tất/hết hạn. Không tự nối dữ liệu snapshot cũ sang snapshot mới. `/step` áp dụng đúng một trang; client có thể dừng giữa các trang. `/state` trả checkpoint và kết quả theo id. Không có vòng polling nền. Tối đa 100 hàng/scan, tối đa 100 trang. Một process scanner chỉ xử lý một mutation tại một thời điểm; không chạy nhiều scanner cùng DB_PATH.

`TEACHING_CONTROLS=1` cho phép POST `/step` với `{interrupt:true}` ném lỗi sau ghi kết quả/checkpoint nhưng trước COMMIT. Đây là điều khiển giảng dạy cục bộ, mặc định tắt; không dùng để triển khai công khai. Retry `{}` sẽ đọc lại đúng token. Transaction rollback cả hàng lẫn checkpoint khi gián đoạn. Nếu commit đã thành công nhưng response mất, retry `/step` đọc checkpoint mới; các hàng cũ không áp dụng lại. Nếu owner trả trang nhưng scanner chết trước commit, restart đọc checkpoint cũ và replay trang. Kết quả áp dụng một lần trong SQLite này, không bảo đảm một lần cho side effect ngoài transaction.

## Hợp đồng lỗi và giới hạn

- 400: body/token sai định dạng, kind không phải primitive string hợp lệ, size/id/value không hợp lệ.
- 409: binding_mismatch, snapshot_capacity, live_capacity, scan_exists, busy hoặc checkpoint_changed.
- 410: cursor_unavailable (không biết token hoặc hết hạn), scan_deadline. Không âm thầm tạo scan mới.
- 413/415: JSON quá 8192 byte hoặc sai content-type. 404 route; 405 method; 500 lỗi nội bộ/teaching interruption.

TTL_MS mặc định 60000, cho phép 100..300000 ms. Biên hết hạn là `now >= expires`. Restart owner giữ nguyên sessions/tokens/frozen; restart không gia hạn TTL. Session hết hạn bị xóa khi tạo snapshot tiếp theo, cascade cả frozen/tokens; không cần background job. Vì giới hạn 8 session, dữ liệu giữ lại luôn hữu hạn, kể cả khi không có request dọn dẹp. SQLite có thể giữ page trống/WAL vật lý; demo không bảo đảm file tự co lại. Chi phí logic O(8 × 100 × kích thước hàng), cộng chỉ mục/token. Replay không kéo dài retention.

Scanner giữ deadline tuyệt đối 30 giây trong DB qua restart. Mỗi request tới owner có timeout 1500 ms bao gồm đọc body; reader chặn tại 16384 byte trước khi ghép và parse JSON. Owner trả tối đa 10 hàng/trang, mỗi value 128 byte UTF-8; JSON escape có thể tăng mỗi byte điều khiển thành 6 byte. Trang có 10 key safe-integer lớn nhất và 128 ký tự NUL mỗi value dài 8208 byte, nên trần16KiB vẫn nhận toàn bộ dữ liệu hợp lệ. Phản hồi tạo snapshot phải chứa token chuỗi hex48 ký tự trước khi ghi checkpoint; sai schema trả502 và không tạo scan. Request server có timeout 5 giây. `/state` tối đa 100 hàng. Timeout không chứng minh remote chưa commit: `/begin` có thể để lại snapshot mồ côi khi mất response, nhưng capacity và TTL chặn tăng vô hạn; client phải chủ động thử scan mới. `/step` retry an toàn nhờ token và transaction.

TTL/deadline dựa wall clock bền qua restart: đồng hồ nhảy tới trước có thể hết hạn sớm; nhảy lùi có thể kéo dài retention theo thời gian thực. Không tuyên bố chống clock rollback. Demo tin cậy owner cấu hình và đĩa SQLite cục bộ, chưa có auth, quota theo người dùng, migration hay kiểm soát nguồn công khai. Sau expiry, người dùng phải chủ động `/begin` với replace:true và hiểu rằng tập dữ liệu có thể khác.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/28-keyset-pagination/test/lesson.test.mts
# Bộ điều khiển bên ngoài chạy với loopback được cho phép:
node --test --test-timeout=15000 lessons/28-keyset-pagination/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite in-memory, clock tiêm vào, kiểm tra seek/index, snapshot bất biến, binding, replay, capacity, expiry đúng biên, rollback và import silent trong child với cấu hình cố tình sai. Integration dùng tmpdir(), process độc lập, cổng tạm và HTTP response làm barrier giữa các bước: đọc trang đầu, sửa/xóa/chèn nguồn, ngắt transaction trang hai, restart cả hai process và hoàn tất snapshot ban đầu. Test khác kiểm tra expiry HTTP, malformed/unknown token và capacity. Mọi request có deadline, child/DB fixture được dọn trong finally. Worker sandbox chỉ chạy typecheck/unit; không tuyên bố đã chạy HTTP integration tại đây.

Bài tập: thêm budget byte cho toàn scan; đo query plan khi bỏ index; thiết kế dọn retention khi đồng hồ bị lùi; mô tả cách giữ checkpoint nếu kết quả cần gửi sang hệ thống khác bằng outbox thay vì gọi trực tiếp trong transaction.

Tham khảo: [SQLite row values và scrolling window](https://www.sqlite.org/rowvalue.html), [Microsoft Azure API guidelines](https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md). Bài này dùng khóa đơn; khóa ghép cần thứ tự tổng duy nhất và seek tuple tương ứng.

Kiểm thử hồi quy bổ sung dùng 11 hàng với key gần Number.MAX_SAFE_INTEGER và value NUL để quét đủ hai trang; fixture HTTP trả token số/null/thiếu/sai định dạng phải bị từ chối trước khi tạo checkpoint.
