# 59 — Phi: nghi ngờ có giới hạn

Bài này tạo heartbeat tổng hợp, **không phải hệ thống giám sát thật hay xác thực**.
Cần Node.js 24.12+ (SQLite tích hợp), chạy lệnh từ gốc kho mã. Không cần dịch vụ ngoài.

## Chạy hai tiến trình

```sh
DB_PATH=/tmp/phi-beacon.sqlite REPLICA_ID=beacon HOST=127.0.0.1 PORT=5959 TEACHING_CONTROLS=1 node lessons/59-phi-failure-detector/beacon.mts
BEACON_ORIGIN=http://127.0.0.1:5959 HOST=127.0.0.1 PORT=5960 TEACHING_CONTROLS=1 node lessons/59-phi-failure-detector/monitor.mts
```

Mỗi tiến trình in một dòng JSON chứa `port` sau khi lắng nghe. `PORT=0` chọn cổng
loopback tạm; khởi động beacon trước, dùng cổng đã báo để cấu hình monitor.
Không dùng tên biến môi trường dành riêng `NODE_*`, `LD_*`, `DYLD_*`.

```sh
curl -H 'content-type: application/json' -d '{}' http://127.0.0.1:5960/sample
curl -H 'content-type: application/json' -d '{"milliseconds":100}' http://127.0.0.1:5960/teaching/advance
curl http://127.0.0.1:5960/state
```

Lặp advance/sample ba lần để có ba khoảng 100ms. Advance thêm 460ms: healthy,
phiMilli=1997; thêm 1ms: suspect, phiMilli=2002. Đặt beacon thành duplicate bằng
POST `/teaching/behavior` với `{"mode":"duplicate"}` rồi sample: nghi ngờ không
biến mất. `unavailable` tạo 503, monitor trả 502 và giữ nguyên bộ theo dõi.
`normal` cho heartbeat mới; một heartbeat hợp lệ mới có thể phục hồi healthy.

## Ranh giới và hợp đồng

Beacon sở hữu SQLite riêng: bảng một hàng gắn `REPLICA_ID` (mặc định beacon),
không chia sẻ DB giữa replica. Khởi động trong giao dịch IMMEDIATE tăng incarnation
1..8 và đặt sequence=0. Sai danh tính hoặc lần khởi động thứ 9 thất bại trước khi
listen, rollback dữ liệu. GET `/heartbeat` tăng nguyên tử sequence 1..32, trả đúng
`{incarnation,sequence}`; sau đó 429 và không đổi sequence. Duplicate không tăng,
trước heartbeat đầu trả 409. Restart tạo incarnation mới; đây không phải fencing.

Monitor chỉ fetch origin cấu hình cố định, HTTP loopback, không nhận URL từ caller.
POST `/sample` yêu cầu đúng `{}`; null, mảng, primitive hoặc thuộc tính thừa là 400.
GET `/state` không fetch. Chỉ một sample đang hoạt động; overlap trả 409, không có
hàng đợi hay phản hồi cũ chạy song song ghi đè tracker. Một deadline tổng 200ms bao
trùm fetch và đọc toàn bộ body, tối đa 512 byte (đủ cả tên trường escape Unicode),
redirect bị cấm. Trạng thái khác 200, body sai/thiếu/thừa trường, sai số nguyên,
quá lớn, chậm hoặc redirect đều trả 502 và không cập nhật tracker.

Sequence thấp hơn hoặc incarnation cũ bị từ chối. Cùng incarnation/sequence là
bản trùng: trả state hiện tại nhưng không sửa thời điểm nhận hay samples. Incarnation
cao hơn xóa khoảng cũ và ghi heartbeat đầu lạnh. Sequence nhảy có thể chấp nhận:
khoảng đo là thời gian **nhận tại monitor**, không phải timestamp từ xa.
Khoảng bằng 0 chỉ đổi sequence/thời điểm, không thêm sample. Chỉ giữ bốn khoảng dương.

State có `{status,phiMilli,intervals,last}`; last là null hoặc
`{incarnation,sequence,receivedAt}`. Chưa nhận gì: unknown; dưới ba khoảng dương:
warming; cả hai có phiMilli=null. Restart monitor mất toàn bộ RAM, trở về unknown.

## Mô hình EXPONENTIAL tùy chỉnh

Đây là mô hình đuôi mũ tự chọn, **không tương thích mô hình phân phối chuẩn Akka**.
Với n khoảng, tổng S và elapsed từ lần nhận mới cuối:

- mean = S/n; phi = elapsed/(mean × ln(10)).
- suspect khi elapsed × n ≥ 2 × S × ln(10); còn lại healthy.
- phiMilli = floor(1000 × elapsed × n/(S × ln(10))).

Ngưỡng 2 và cửa sổ bốn là lựa chọn giảng dạy. Thông thường dùng
floor(performance.now()), không cần đồng bộ đồng hồ tường. Khi
TEACHING_CONTROLS=1, đồng hồ logic bắt đầu 0; POST `/teaching/advance` nhận đúng
`{milliseconds: số nguyên 1..1000}`, tổng không quá 60000, trả `{now}`.
Behavior chỉ nhận đúng một trường mode thuộc normal/unavailable/duplicate, trả
`{ok:true}`. Controls bị tắt thì 404. Tất cả route khác là 404.

Phi là tín hiệu thống kê: không thể phân biệt crash, pause GC và mất mạng. Mô hình
mũ giả định dạng đuôi cụ thể; dữ liệu tương quan, thay đổi tải, heavy-tail và cửa sổ
nhỏ khiến điểm nghi ngờ sai lệch. Không có election, membership removal, failover,
fencing, xác thực hay bảo đảm production. Beacon dùng counter hữu hạn để nhìn rõ
ranh giới thí nghiệm; không tự reset để chạy vô hạn.

## Kiểm tra và bài tập

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/59-phi-failure-detector/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-isolation=none lessons/59-phi-failure-detector/test/lesson.test.mts
npm run check
make test
git diff --check
```

HTTP tests chạy các child process độc lập, cổng tạm, DB trong tmpdir và cleanup
kể cả lỗi startup. Fixture upstream tái dùng qua các mode; redirect dùng một đích
loopback khác có counter được kiểm trước đổi mode. Trong worker không có network,
chỉ chạy unit/typecheck; bộ điều phối chạy HTTP trong Docker riêng.

Bài tập: tính tay mean sau các khoảng 100,100,100,500,200; so sánh với cửa sổ dài
hơn. Tạo một pause lớn rồi quan sát heartbeat kế tiếp làm mean tăng và độ nhạy giảm.
Giải thích vì sao bản trùng không được cập nhật receivedAt, và vì sao không dùng
phi làm bằng chứng quyền ghi dữ liệu.

Tham khảo gốc: [Akka failure detector](https://doc.akka.io/libraries/akka-core/current/typed/failure-detector.html)
để so sánh ý tưởng accrual và giả định phân phối; công thức bài này được định nghĩa
riêng phía trên.
