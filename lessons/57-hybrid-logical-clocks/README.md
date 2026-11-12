# 57 — Hybrid logical clock: đồng hồ lùi và nhân quả

Hai tiến trình ghi sự kiện vào hai SQLite riêng. Relay chỉ chuyển một sự kiện được yêu cầu; không có đồng bộ nền. Mục tiêu là thấy thứ tự nhân quả vẫn tăng khi đồng hồ vật lý lùi, đồng thời thấy rõ những điều một HLC không thể kết luận.

## Điều kiện và chạy

Node.js 24.12+ (bao gồm `node:sqlite`), npm và các dev dependency đã ghim ở root. Không cần dịch vụ ngoài. Chạy từ root repository, mỗi lệnh dịch vụ ở một terminal:

```sh
REPLICA_ID=a DB_PATH=/tmp/hlc-a.db TEACHING_CONTROLS=1 HOST=127.0.0.1 PORT=3057 node lessons/57-hybrid-logical-clocks/clock-service.mts
REPLICA_ID=b DB_PATH=/tmp/hlc-b.db TEACHING_CONTROLS=1 HOST=127.0.0.1 PORT=3058 node lessons/57-hybrid-logical-clocks/clock-service.mts
A_ORIGIN=http://127.0.0.1:3057 B_ORIGIN=http://127.0.0.1:3058 HOST=127.0.0.1 PORT=3059 node lessons/57-hybrid-logical-clocks/relay.mts
```

Dùng đường dẫn DB mới cho lần thực hành mới; không dùng chung DB giữa hai replica. Identity được lưu cùng state: mở DB của `b` với `REPLICA_ID=a` thất bại trước khi listen. Các entrypoint không đọc cấu hình, mở DB hay đăng ký tín hiệu khi import. `PORT=0` chọn cổng tạm và stdout in một dòng JSON `{service,port}` để playground khởi động lần lượt a, b rồi relay với hai origin vừa nhận.

```sh
curl -s -H 'content-type: application/json' -d '{"id":"a1","payload":"hello"}' http://127.0.0.1:3057/events
curl -s -H 'content-type: application/json' -d '{"from":"a","id":"a1"}' http://127.0.0.1:3059/deliver
curl -s -H 'content-type: application/json' -d '{"id":"b1","payload":"after_a1"}' http://127.0.0.1:3058/events
curl -s -H 'content-type: application/json' -d '{"offset":-2000}' http://127.0.0.1:3058/teaching/clock
curl -s -H 'content-type: application/json' -d '{"id":"b2","payload":"rollback"}' http://127.0.0.1:3058/events
curl -s http://127.0.0.1:3058/state
```

Với DB mới, a1 có `(1700000000000,0,a)`, receive tại b trả clock `(1700000000000,1)`, b1 có counter 2 và b2 có counter 3 dù now đã lùi 2000ms. Gửi lại a1 không làm clock b tăng. Dừng b bằng SIGTERM, chạy lại cùng DB và tạo b3: counter tiếp tục tăng, dù teaching offset sau restart trở về 0.

## Đồng hồ và công thức

Giờ vật lý nhằm biểu diễn thời gian thực nhưng có thể nhảy lùi, lệch giữa máy và bị điều chỉnh. HLC giữ cặp `(wall,counter)`; `replica` chỉ là tie-break để có thứ tự toàn phần ổn định. Nó không đồng bộ đồng hồ máy.

Clock ban đầu `(0,0)`. Tick lấy wall lớn nhất giữa now và wall cũ; nếu wall cũ >= now thì tăng counter cũ, ngược lại counter bằng 0. Receive lấy wall lớn nhất trong now, wall cũ và wall nhận:

| Wall thắng | Counter mới |
| --- | --- |
| Cùng bằng wall cũ và wall nhận | max hai counter + 1 |
| Chỉ bằng wall cũ | counter cũ + 1 |
| Chỉ bằng wall nhận | counter nhận + 1 |
| Now lớn hơn cả hai | 0 |

So sánh stamp theo wall, rồi counter, rồi replica (`a` trước `b`). Nếu x dẫn đến y qua chuỗi xử lý/gửi/nhận trong bài, stamp x nhỏ hơn stamp y. Chiều ngược lại không đúng: hai sự kiện độc lập vẫn bị ép vào thứ tự toàn phần. Vector clock lưu tiến triển của từng replica, có thể nhận diện quan hệ không so sánh được để biểu diễn đồng thời; HLC ở đây không giữ đủ thông tin đó. Thứ tự stamp không chứng minh thứ tự thời gian thực, consensus, linearizability hoặc thời điểm UTC chính xác.

## Hợp đồng và ranh giới

Mọi JSON công khai phải là object đúng trường, đúng kiểu primitive; null, array, trường thừa và ép kiểu ngầm đều bị từ chối. ID là `[A-Za-z0-9_-]` dài 1..16, payload cùng alphabet dài 1..32. Stamp có đúng `{wall,counter,replica}`; wall là safe integer 0..9000000000000, counter là integer 0..65535, replica là a hoặc b. Không có API cho client chọn stamp của sự kiện local.

| Route | Kết quả |
| --- | --- |
| POST /events `{id,payload}` | 201 sự kiện bất biến; replay cùng payload 200 sự kiện gốc; đổi payload 409 |
| GET /events/:id | 200 sự kiện được tạo tại node này; không có 404 |
| POST /receive sự kiện đầy đủ từ replica kia | 201 `{clock:{wall,counter}}`; replay chính xác 200 clock của lần nhận đầu; thay stamp/payload 409 |
| GET /state | `{replica,clock,created,received}`; created sắp ID, received chứa `{event,clock}` sắp replica/ID |
| POST /teaching/clock `{offset}` | Chỉ khi TEACHING_CONTROLS=1; offset integer -2000..10000; 200 `{offset}`; tắt thì 404 |
| POST relay /deliver `{from,id}` | 200 clock từ receiver; source thiếu 404; receiver 409/422/429 giữ nguyên; lỗi upstream 502 |

Teaching now là epoch 1700000000000 + offset, offset ban đầu 0. Control không sửa HLC và không lưu offset. Khi tắt dùng Date.now(). Sai schema 400; thiếu content-type JSON 415; body request vượt 8192 byte 413. Route khác 404.

Mỗi node giữ tối đa 8 created và 8 received, tổng 16. Capacity hoặc counter overflow trả 429, không ghi một phần. Đạt counter 65535 vẫn hợp lệ; lần tăng tiếp thất bại, không wrap và không tự đẩy wall. Nếu now thực sự tiến qua wall hiện tại, tick mới có thể về counter 0.

Receive mới có remote.wall > now + 1000 bị 422. Đây là lựa chọn giáo dục để hạn chế clock bị kéo quá xa, đánh đổi availability: sau rollback, một sự kiện hợp lệ về nhân quả vẫn có thể bị từ chối. Replay lookup diễn ra sau kiểm tra schema nhưng trước capacity/future check, vì vậy sự kiện từng nhận vẫn replay được sau rollback. Payload/stamp bị thay không được xem là replay.

## Kiến trúc, lỗi và độ bền

`model.mts` chứa thuật toán, validation và Store SQLite. Mỗi thao tác thay đổi dùng BEGIN IMMEDIATE, đọc state, kiểm tra, ghi state và COMMIT; mọi lỗi ROLLBACK. State nhỏ được giữ trong một JSON record có schema được kiểm tra khi đọc. Đây là cách nhìn rõ tính nguyên tử cho giới hạn 16 sự kiện, không phải thiết kế lưu log quy mô lớn. Snapshot đọc không sửa HLC. SQLite chịu trách nhiệm persistence; mất file DB hay hỏng ổ đĩa nằm ngoài bài.

`clock-service.mts` sở hữu DB riêng. `relay.mts` chỉ biết hai origin HTTP loopback cố định, chuẩn hóa và từ chối hai origin giống nhau. Người gọi không chọn URL. Relay đọc sự kiện từ source rồi gửi nguyên sự kiện sang node kia, dùng redirect:error ở cả hai hop, tối đa 4096 byte cho mỗi response và một deadline tuyệt đối 300ms bao gồm cả hai full body. Ngân sách đủ cho schema hợp lệ ngay cả khi mọi ký tự chuỗi JSON được biểu diễn bằng Unicode escape. Padding vượt ngân sách bị chặn dù JSON và schema sau decode vẫn đúng.

Relay kiểm tra status, schema đầy đủ, source ID và source replica. Lỗi source404 hoặc receiver409/422/429 chỉ được giữ nguyên khi envelope đúng `{error:{code:"rejected",message:"Request rejected"}}`; mã lỗi khác, primitive hay trường dư đều thành502. Không retry và không background delivery. Nếu receiver đã commit nhưng relay hết deadline trước khi đọc xong, client nhận 502 mà không biết trạng thái commit; gửi lại cùng sự kiện giải quyết bằng idempotency. Đây không phải exactly-once transport. Không có bảo mật, xác thực, replication tự động, chống kẻ tấn công hoặc cam kết vận hành production.

## Kiểm thử

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/57-hybrid-logical-clocks/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-name-pattern=integration: lessons/57-hybrid-logical-clocks/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite in-memory, các expected stamp tính độc lập. RED đầu tiên chứng minh rollback sai sẽ bị bắt. Integration dùng child process độc lập, cổng loopback tạm, DB trong `node:os.tmpdir()` và cleanup kể cả startup thất bại. Fixture upstream được tái sử dụng cho malformed/status/schema/byte/deadline/redirect; đích redirect là origin reachable riêng và counter của nó được kiểm tra trước khi đổi mode. Sandbox worker chỉ chạy typecheck và unit; controller chạy HTTP trong Docker cô lập. Không cần Docker để chạy native khi môi trường cho phép loopback.

## Bài tập

1. Tạo hai sự kiện độc lập ở a và b cùng wall/counter. Giải thích vì sao tie-break không chứng minh quan hệ nhân quả.
2. Cho a tiến offset 10000 rồi gửi sang b offset 0. Dự đoán 422 và kiểm tra state không đổi. Nêu đánh đổi nếu bỏ ngưỡng 1000.
3. Giải thích vì sao replay phải trả receive clock gốc thay vì clock hiện tại.
4. Đề xuất cách lưu nhiều sự kiện hơn bằng bảng riêng và unique key, giữ nguyên atomicity và idempotency; không sửa giới hạn bài để che overflow.

Tham khảo gốc: [Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases](https://cse.buffalo.edu/tech-reports/2014-04.pdf). Các giới hạn số, topology hai replica và policy future rejection ở đây là lựa chọn giảng dạy của bài, không phải bảo đảm chung của HLC.
