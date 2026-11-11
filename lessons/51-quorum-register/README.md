# 51 — Quorum đọc/ghi, kết quả không chắc chắn và sửa replica lưu bền

Bài này dùng **ba tiến trình replica độc lập và đúng một coordinator single-writer**.
Mỗi replica có SQLite riêng; coordinator có SQLite lưu biên nhận lệnh. Chỉ một
thanh ghi số nguyên được nhân bản, không có lịch sử giá trị tăng vô hạn.
Mục tiêu là quan sát sự khác nhau giữa “đã nhận đủ xác nhận” và “không biết chắc
lệnh đã tác động đến đâu”. HTTP 503 không có nghĩa là rollback.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (nhánh 24), npm và các dev dependency đã ghim ở root.
Không cần package runtime, Docker cho chạy native, tài khoản hay dịch vụ cloud.
Từ root repository, chạy bốn terminal, dùng bốn tệp DB khác nhau:

```sh
HOST=127.0.0.1 PORT=5151 DB_PATH=/tmp/quorum-a.db TEACHING_CONTROLS=1 node lessons/51-quorum-register/replica.mts
HOST=127.0.0.1 PORT=5152 DB_PATH=/tmp/quorum-b.db TEACHING_CONTROLS=1 node lessons/51-quorum-register/replica.mts
HOST=127.0.0.1 PORT=5153 DB_PATH=/tmp/quorum-c.db TEACHING_CONTROLS=1 node lessons/51-quorum-register/replica.mts
HOST=127.0.0.1 PORT=5150 DB_PATH=/tmp/quorum-coordinator.db REPLICA_A_ORIGIN=http://127.0.0.1:5151 REPLICA_B_ORIGIN=http://127.0.0.1:5152 REPLICA_C_ORIGIN=http://127.0.0.1:5153 OPERATION_MS=800 node lessons/51-quorum-register/quorum.mts
```

Có thể đặt `PORT=0`; mỗi tiến trình in một dòng JSON `{service,port}` sau khi
listen thành công. `HOST` mặc định `127.0.0.1`. `DB_PATH` bắt buộc, thư mục cha
phải tồn tại; không chia sẻ DB giữa các vai trò. `OPERATION_MS` mặc định 800,
trong khoảng 50..5000 ms. Ba origin HTTP bắt buộc khác nhau, không userinfo,
path, query hay fragment. Chúng được chốt lúc start, không nhận URL từ caller.
Mọi fetch dùng `redirect: 'error'`, kể cả redirect về replica đã cấu hình.

Playground có thể chạy ba instance của `replica.mts` và một `quorum.mts`, truyền
các origin theo port readiness. Không dùng biến ứng dụng có tiền tố `NODE_`,
`LD_`, `DYLD_`. Import module không đọc config, mở DB, đăng ký signal hay listen.

## Thí nghiệm: một bản ghi có thể đã đổi dù client nhận 503

```sh
curl -s http://127.0.0.1:5150/register
curl -s -H 'content-type: application/json' -d '{"id":"gia-01","value":40}' http://127.0.0.1:5150/writes
curl -s -H 'content-type: application/json' -d '{"available":false}' http://127.0.0.1:5152/teaching/availability
curl -s -H 'content-type: application/json' -d '{"available":false}' http://127.0.0.1:5153/teaching/availability
curl -s -H 'content-type: application/json' -d '{"id":"gia-02","value":70}' http://127.0.0.1:5150/writes
curl -s http://127.0.0.1:5151/register
curl -s http://127.0.0.1:5150/writes/gia-02
```

Lệnh `gia-02` nhận 503 với receipt `version:2, attempts:1, state:"uncertain"`;
replica A vẫn chứa `{version:2,value:70}`. Bật B lại bằng `{ "available": true }`,
rồi POST lại **đúng** `gia-02,70`. Coordinator dùng cùng version 2, tăng attempts
lên 2 **trước** fanout; hai echo đúng làm receipt thành `acknowledged`.
Bật C lại và `POST /repair` với `{}` để C nhận phiên bản mới nhất.

Teaching route chỉ tồn tại khi `TEACHING_CONTROLS=1`, chỉ để thực hành local.
Nó không ghi availability xuống DB. Restart replica giữ register nhưng availability
trở lại true. Không expose các port này ra mạng không tin cậy. Khi tắt controls,
route trả 404. Không có hold/release trong application; fixture riêng trong test
có barrier HTTP để kiểm tra busy mà không dựa vào đo thời gian.

## Kiến trúc và hợp đồng

```text
client ── POST /writes ── coordinator + receipts.sqlite
                             ├── PUT /register ── A + a.sqlite
                             ├── PUT /register ── B + b.sqlite
                             └── PUT /register ── C + c.sqlite
            GET /register ── fanout GET cả ba ── chọn max version nếu đủ 2 vote
            POST /repair ── đọc quorum rồi PUT cả ba, cùng deadline
```

### Replica

`GET /register` trả đúng `{version,value}`: ban đầu `{version:0,value:null}`;
version tiếp theo trong 1..16, value nguyên 1..100. `PUT /register` nhận đúng hai
field này. Transaction `BEGIN IMMEDIATE` so sánh và thay thế nguyên tử: version
lớn hơn được lưu; version bằng và cùng value là replay 200; version thấp hoặc
bằng nhưng khác value trả 409 và giữ nguyên dữ liệu. Echo 200 luôn là register.
Sai kiểu, array/null/boolean hoặc field thừa trả 400. Chỉ có một hàng register.

### Coordinator

| Route | Kết quả |
| --- | --- |
| `POST /writes {id,value}` | 200 receipt khi đủ 2 echo đúng; 503 receipt uncertain khi ít hơn 2 |
| `GET /writes/:id` | `{receipt,active}`, 404 nếu không tồn tại; id sai trả 400 |
| `GET /state` | `{receipts,active}`, receipts tăng theo version, tối đa 16 |
| `GET /register` | Chỉ `{version,value}`, hoặc 503 thiếu 2 vote / 502 xung đột |
| `POST /repair {}` | 200 `{register,acknowledgements}` sau read quorum; lỗi đọc 503/502 |

`id` là 1..32 ký tự `[A-Za-z0-9_-]`; không ép kiểu JSON. Value nguyên 1..100.
Payload chỉ đúng các field đã nêu. Receipt gồm `{id,value,version,attempts,state}`;
id/value/version bất biến, attempts và state cập nhật có giới hạn. Lệnh mới được
cấp đúng một version tăng dần trong transaction SQLite. Attempt được commit trước
khi gửi mạng. Một command uncertain chặn mọi id mới bằng 409; sửa payload của id
cũ cũng 409. Replay acknowledged trả receipt gốc, không gọi replica, không tăng
attempts, kể cả khi replica đều không khả dụng. Tối đa 16 command suốt vòng đời DB;
không xóa receipt để tái sử dụng version.

Chỉ retry explicit cùng id uncertain, tối đa ba attempts. Đến giới hạn trả 409,
receipt vẫn uncertain và chặn lệnh mới. Restart không tự retry hay tự acknowledge.
Crash sau commit attempt nhưng trước fanout vẫn tiêu tốn attempt: đây là lựa chọn
bảo thủ có chủ ý. SQLite dùng WAL và `synchronous=FULL`; bảo đảm phụ thuộc filesystem
và thiết bị lưu trữ thực sự tôn trọng fsync.

Một mutation (write hoặc repair) được nhận tại một thời điểm. Guard đặt trước
await đầu tiên, kể cả đọc request body; mutation khác nhận 409 `busy`. `GET /state`
quan sát được active, GET thông thường không giữ guard. Guard chỉ nằm trong tiến
trình: **không được chạy nhiều coordinator**, kể cả cùng DB. Không có bầu leader,
lease hay phân phối quyền ghi.

Mỗi thao tác có một deadline tổng, dùng chung cho các fetch chạy song song, và với
repair dùng tiếp cho cả pha PUT. Request body mutation cũng tính trong deadline;
body không kết thúc đúng hạn có thể bị đóng kết nối. Không có retry fetch ngầm.
Request JSON giới hạn 8192 byte (413), content-type sai 415, JSON lỗi 400; các body
hợp lệ có escaping tối đa của id vẫn nhỏ hơn giới hạn. Reply upstream giới hạn
1024 byte kể cả whitespace; schema được kiểm tra sau parse, status khác 200 không
là vote. Read có ít hơn 2 reply hợp lệ trả 503. Nếu đủ vote nhưng bất kỳ hai reply
hợp lệ cùng version khác value thì 502, kể cả xung đột ở version thấp hơn max.

Repair đọc cùng quy tắc quorum rồi fanout register đã chọn; chỉ echo 200 khớp cả
version lẫn value mới tăng acknowledgements. Stale/conflict/oversized/malformed/
redirect/timeout không được tính. Với version 0, repair không PUT và trả ack 0.
Pha PUT ít ack vẫn trả 200 với số ack thực tế 0..3: đây là báo cáo sửa chữa, không
phải xác nhận command. Repair và read không sửa receipt. GET không tự repair.

## Vì sao R + W > N chưa đủ

Ở đây N=3, R=W=2 nên tập đọc và tập ghi thành công giao nhau ít nhất một replica.
Khi không có ghi xen kẽ và có một ghi W2 đã xong, đọc R2 sẽ nhìn thấy version đó
hoặc mới hơn. Tuy nhiên, một write chỉ chạm một replica rồi nhận 503 vẫn có thể
được một read quorum chọn làm max. Read tiếp theo có thể chạm hai replica cũ và
trả version thấp hơn: **không bảo đảm monotonic reads**. Với write uncertain,
client cũng không có read-your-write. Repair có thể lan truyền write uncertain;
điều đó không biến command receipt thành acknowledged. Một read và write đồng
thời có thể quan sát các tập reply tại những thời điểm khác nhau.

Bài không có read write-back như một atomic register protocol hoàn chỉnh. Không
suy ra linearizability, consensus, exactly-once transport, Dynamo hay Raft từ bất
đẳng thức giao nhau. Version chỉ có nghĩa dưới giả định một coordinator hợp lệ;
đọc/ghi trực tiếp replica trong demo là thao tác quản trị có thể phá giả định đó.
Không có thay đổi membership, auth, Byzantine defense hoặc xử lý mất đĩa. Replica
nói dối có thể thắng bằng version cao; runtime validation không phải chứng thực.

Sau ba attempts uncertain, bài **không cung cấp API tự phục hồi receipt**. Operator
phải dừng ghi, kiểm tra cả ba DB/receipt và chọn quy trình khôi phục bên ngoài bài;
không xóa DB/reset version khi replica còn dữ liệu và không coi repair là giải
quyết uncertainty. Bài cố ý dừng tại ranh giới an toàn thay vì phát minh kết quả.

## Kiểm tra và bài tập

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/51-quorum-register/test/lesson.test.mts
node --test --test-timeout=15000 lessons/51-quorum-register/test/lesson.test.mts
npm run check
make test
git diff --check
```

HTTP tests dùng process độc lập, port ephemeral, DB ở `node:os.tmpdir()`, timeout
cho mọi request, finally dừng child và xóa DB. Fixture lỗi tái sử dụng một process
với HTTP control chỉ dành cho test, đếm pending để xác nhận guard. Oversized reply
vẫn là JSON/register hợp lệ, chỉ thừa whitespace để kiểm tra đúng byte gate.
Import test chạy child với config cố ý sai và yêu cầu exit 0, stdout/stderr rỗng.
Worker không có mạng chỉ chạy typecheck/unit; controller mới chạy HTTP suite trong
Docker cô lập. Lệnh toàn bộ suite phía trên dành cho môi trường cho phép loopback.

1. Vẽ hai read quorum khác nhau để chứng minh version có thể đi lùi sau write uncertain.
2. Dừng coordinator ngay sau commit attempt: vì sao restart không được tự gửi lại?
3. So sánh thêm pha read write-back với repair explicit: chi phí và giả định nào đổi?
4. Nếu muốn nhiều writer, version số nguyên từ một DB không còn đủ. Cần giải quyết
   ordering, leadership và failure detector thế nào trước khi sửa code?

Tham khảo: [Dynamo, SOSP 2007](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
(về quorum, versioning và phục hồi replica; thiết kế trong bài nhỏ hơn nhiều),
[Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html),
[SQLite atomic commit](https://sqlite.org/atomiccommit.html).
