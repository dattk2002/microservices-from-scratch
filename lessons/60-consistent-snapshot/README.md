# 60 — Snapshot Chandy–Lamport: marker FIFO và dữ liệu còn trên đường truyền

Bài trước quan sát mức nghi ngờ của một tiến trình. Bài này quan sát **một trạng thái toàn cục nhất quán** khi hai tiến trình vẫn trao đổi dữ liệu. Hai replica `a`, `b` có số dư hư cấu ban đầu 10. Không có tiền thật, người dùng, dịch vụ thanh toán hay cam kết dùng trong sản xuất.

## Vì sao cộng hai lần GET có thể sai?

B gửi 3: số dư B giảm từ 10 xuống 7, packet vẫn đang ở outbox. A bắt đầu snapshot khi số dư còn 10. Tổng hai số dư được ghi là 17. Packet B→A trị giá 3 thuộc phần dữ liệu **đang truyền** của cut: tổng đúng là `10 + 7 + 3 = 20`.

A ghi trạng thái local rồi xếp marker sau các packet đã gửi trước đó. Khi B nhận marker lần đầu, B ghi local 7, đóng kênh vào A→B với danh sách rỗng và xếp marker B→A. Do FIFO, packet 3 đến A trước marker của B. A đã mở recording nên ghi packet này vào snapshot, dù số dư đang chạy của A được cộng lên 13. Marker sau đó đóng recording. Các transfer tiếp theo không sửa cut đã hoàn tất.

Cut nhất quán không đòi hỏi hai đồng hồ chỉ cùng thời điểm. Nó không chứa một lần nhận mà bỏ qua lần gửi tương ứng. Một lần gửi đã xảy ra nhưng lần nhận chưa thuộc cut được biểu diễn bằng packet in-flight. Marker phân định lịch sử theo thứ tự kênh, không theo timestamp.

## Kiến trúc và giả định

```text
node a + SQLite riêng ← channel /pump {from:"b"} ← outbox b
outbox a → channel /pump {from:"a"} → node b + SQLite riêng
                 channel /snapshot → đọc hai cut đã lưu
```

Đây là topology đóng gồm đúng hai node, hai chiều FIFO, mỗi node chỉ có một kênh vào và một kênh ra. Chỉ marker và transfer hợp lệ từ node đối diện được chấp nhận. Không có discovery, consensus, topology tổng quát hoặc gửi tự động. Thí nghiệm giả định mọi transfer đều đi qua outbox của hai node này; API không cung cấp xác thực người gửi.

SQLite lưu local balance, identity, số thứ tự, outbox chưa ack, receipt đã nhận và snapshot. Mỗi thao tác thay đổi state chạy trong `BEGIN IMMEDIATE`/`COMMIT`; lỗi rollback toàn bộ. Hai file DB phải riêng tư cho hai node. Không chạy hai tiến trình cùng ghi một file. Dùng lại DB của `a` với `REPLICA_ID=b` bị từ chối trước khi listen, không đổi dữ liệu đã lưu.

Giới hạn giáo dục: mỗi chiều cấp tối đa **16** sequence slot trong suốt đời DB, kể cả marker; amount là integer **1..5**; snapshot ID gồm **1..16** ký tự `[A-Za-z0-9_-]`. Receipt giữ tối đa 16 packet mỗi chiều. Không xóa receipt để tái sử dụng sequence. Hết slot cần một thí nghiệm mới với DB mới. Số dư tối đa 90 theo giới hạn nhận 16×5; trong topology hợp lệ tổng tài sản luôn 20.

Một DB chỉ ghi một snapshot: cùng ID trả lại snapshot cũ, khác ID trả 409, kể cả sau restart. Restart không mở lại kênh đã đóng. Các entrypoint inert khi import: chỉ `main()` mới đọc cấu hình, mở SQLite, listen và đăng ký tín hiệu qua helper HTTP.

## Chạy bằng Node native

Yêu cầu Node **24.12+**, npm và các dev package đã pin ở root. Chạy từ root repository; không cài runtime package.

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/60-consistent-snapshot/test/lesson.test.mts
npm run test:unit
node --test --test-name-pattern=integration: lessons/60-consistent-snapshot/test/lesson.test.mts
```

Full checks ở môi trường được phép mở loopback: `npm run check`, `make test`, `git diff --check`. Worker không có mạng chỉ chạy typecheck/unit; controller chạy HTTP integration trong Docker riêng. Không coi test chưa chạy là đã pass.

Playground: khởi động lần lượt A, B, rồi channel trong ba terminal. Mỗi lệnh in một dòng JSON `{service,port}`. Thay các port placeholder bằng port vừa nhận, không dùng dấu `< >` trực tiếp trong shell.

```bash
HOST=127.0.0.1 PORT=0 REPLICA_ID=a DB_PATH=/tmp/cut-a.sqlite node lessons/60-consistent-snapshot/node.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=b DB_PATH=/tmp/cut-b.sqlite node lessons/60-consistent-snapshot/node.mts
# Ví dụ A in 41001 và B in 41002: dùng giá trị thực từ hai dòng readiness.
HOST=127.0.0.1 PORT=0 A_ORIGIN=http://127.0.0.1:41001 B_ORIGIN=http://127.0.0.1:41002 node lessons/60-consistent-snapshot/channel.mts
```

Dùng đường dẫn DB mới cho mỗi lần thí nghiệm độc lập. Channel chuẩn hóa hai HTTP origin loopback cố định, từ chối origin giống nhau, credentials, path/query/fragment. Caller không truyền URL. Không dùng biến môi trường bắt đầu `NODE_`, `LD_`, `DYLD_`. Các service thật không có control route. Chỉ fixture test có `/control` khi `TEACHING_CONTROLS=1`; khi tắt trả 404.

Ví dụ sau giả sử channel in port 41003; thay cả ba port bằng giá trị thực:

```bash
curl -sS -H 'content-type: application/json' -d '{"amount":3}' http://127.0.0.1:41002/transfer
curl -sS -H 'content-type: application/json' -d '{"snapshotId":"cut1"}' http://127.0.0.1:41001/snapshot
curl -sS -H 'content-type: application/json' -d '{"from":"a"}' http://127.0.0.1:41003/pump
curl -sS -H 'content-type: application/json' -d '{"from":"b"}' http://127.0.0.1:41003/pump
curl -sS -H 'content-type: application/json' -d '{"from":"b"}' http://127.0.0.1:41003/pump
curl -sS http://127.0.0.1:41003/snapshot
```

Kết quả cuối: `complete:true`, `balances:{a:10,b:7}`, một transfer B→A amount 3 trong `inFlight`, `total:20`. Gửi thêm B2, pump thêm một lần; báo cáo vẫn giữ nguyên. Dùng Ctrl-C để dừng từng service; chỉ xóa các file DB thí nghiệm của chính bạn sau khi service đã dừng.

## Hợp đồng node

Mọi JSON object phải có đúng các field mô tả; null, array, primitive, field thừa và kiểu sai trả 400. JSON request phải có content-type JSON (415 nếu sai), tối đa 8192 byte (413 nếu vượt). Method/path không hỗ trợ trả 404. Lỗi dùng `{error:{code,message}}`.

| Route | Request / kết quả |
| --- | --- |
| `POST /transfer` | `{amount}` → 201 packet `{from,seq,kind:"transfer",amount}`. Atomically trừ balance và append outbox. Không đủ balance 409 `insufficient`; hết slot 429 `exhausted`; không đổi state khi thất bại. |
| `GET /head` | 200 `{message:packet|null}`; không tự gỡ packet. |
| `POST /ack` | `{seq}` → 200 `{seq}`. Chỉ ack head hiện tại hoặc lặp ack đã commit. Gap/ack chưa được cấp trả 409 `ack_conflict`. |
| `POST /messages` | Packet của replica đối diện → 200 `{seq}`. Seq phải kế tiếp hoặc duplicate chính xác. Gap/đổi nội dung duplicate 409, không cộng lại. |
| `GET /state` | `{replica,balance,outbox,sentThrough,receivedThrough}`; outbox chỉ gồm packet chưa ack, theo seq. |
| `POST /snapshot` | `{snapshotId}` → 201 `{snapshot}` lần đầu; 200 snapshot hiện có khi cùng ID; 409 khi ID khác. |
| `GET /snapshot` | `{snapshot:null}` hoặc `{snapshot:{snapshotId,localBalance,channelOpen,inFlight}}`. |

Marker là `{from,seq,kind:"marker",snapshotId}`. Transfer và marker dùng chung sequence; không thể vượt marker bằng business packet mới. Nhận marker đầu tiên phải đủ slot để append marker local trong cùng giao dịch. Nếu hết slot, trả 429 và **không** lưu receipt, tăng receivedThrough hay bắt đầu snapshot. Gửi snapshot local cũng rollback nếu không cấp được marker.

## Hợp đồng channel và thất bại không chắc chắn

`POST /pump {from:"a"|"b"}` đọc một head, POST packet đến node đối diện, rồi ack source. Thành công trả 200 `{delivered:true,from,seq}`; head rỗng trả `{delivered:false}`. Chỉ một pump đang chạy mỗi chiều; yêu cầu trùng chiều trả 409 `busy`. Hai chiều độc lập. Không có retry nội bộ, timer gửi nền hay caller URL.

Mỗi pump có **một deadline tuyệt đối 500 ms**, bao gồm toàn bộ body của cả ba hop. Bất kỳ non-200, JSON/schema sai, body quá lớn, chậm, redirect hoặc lỗi kết nối đều trở thành 502 `upstream_failure`. Channel không suy diễn business rejection từ HTTP status của upstream, kể cả envelope `internal_error` trông hợp lệ. Các giới hạn body response: head 2048 byte; receipt/ack 256 byte; mỗi snapshot 16384 byte. Những giới hạn này đủ cho chuỗi JSON escape tối đa `\uXXXX` của schema hữu hạn. Body đọc theo stream, không chỉ kiểm tra Content-Length. `redirect:'error'` ngăn chuyển payload sang origin khác.

Trước khi ack commit, head vẫn còn trong source. Receiver có thể đã nhận dù channel trả 502. Pump tiếp theo gửi lại đúng packet; receipt ngăn cộng tiền và ghi in-flight hai lần. **Ack cũng có thể commit trước khi reply hỏng**: lần pump sau có thể thấy head kế tiếp. 502 không chứng minh rollback ở bất kỳ hop nào. Reliability ở đây nghĩa là operator tiếp tục pump/retry sau lỗi tạm thời; nếu dừng mãi, marker không đến và snapshot không hoàn tất.

`GET channel /snapshot` đọc cả hai node trong tổng 500 ms và validate **toàn bộ** hai envelope trước khi báo kết quả. Có node chưa ghi hoặc channelOpen → 200 `{complete:false}`. Hai snapshot không-null khác ID → 409. Upstream không hợp lệ → 502, không trả phần dữ liệu đã đọc. Hoàn tất → `{complete:true,snapshotId,balances:{a,b},inFlight,total}`; packet sort theo `from`, rồi `seq`. Tổng là hai localBalance cộng tất cả amount đang truyền.

Đây không phải live read nguyên tử của hai DB: nó đọc các bản ghi cut bất biến sau khi marker hoàn tất. Không có global transaction, distributed restore, phục hồi mất DB, chống giả mạo, hoặc xử lý node vĩnh viễn biến mất. FIFO và topology đóng là giả định cần thiết, không phải chi tiết tối ưu hóa.

## Kiểm chứng và bài tập

Unit đầu tiên tái hiện đúng B3 → A cut1 → B nhận marker → A nhận B3 → A nhận marker; literal expected local sum 17, in-flight 3, total 20. Các unit khác kiểm tra gap, replay thay đổi, duplicate, marker ordering, ID conflict, rollback capacity, identity, restart và import im lặng. HTTP tests khởi động process độc lập với port ephemeral và DB trong `tmpdir()`, cleanup được bảo vệ kể cả startup lỗi. Fixture được tái sử dụng qua control mode, test redirect có đích 127.0.0.1 khác thật sự reachable và kiểm tra counter trước khi đổi mode. Test deadline đọc body chậm và tổng hai hop chậm; test escaped chỉ biến đổi JSON string token, giữ nguyên number/boolean/null.

1. Đổi thứ tự: cho B3 đến A trước khi bắt đầu cut. Dự đoán localBalance và inFlight, rồi kiểm tra tổng vẫn 20.
2. Dừng node A sau khi nhận B3 nhưng trước source ack; restart và pump. Vì sao không thể dùng HTTP 502 để quyết định cộng lại?
3. Bỏ kiểm tra seq ở receiver trong một bản thử riêng: tạo lịch giao marker trước transfer cũ. Chỉ ra cut sai phát sinh ở đâu.
4. Vì sao mở lại `channelOpen` sau restart sẽ làm thay đổi cut đã ghi? Thêm test bảo vệ hành vi ấy.

Tham khảo chính: Chandy & Lamport, [Distributed Snapshots: Determining Global States of Distributed Systems](https://lamport.azurewebsites.net/pubs/chandy.pdf). Mô hình hai node và các giới hạn số trong bài là lựa chọn giảng dạy, không phải thông số của bài báo.
