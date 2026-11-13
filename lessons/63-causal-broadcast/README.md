# 63 — Giao sự kiện theo quan hệ nhân quả và bộ đệm chờ dependency

Một dịch vụ tạo sự kiện `a1 = created`. Dịch vụ B đã giao `a1` cho ứng dụng rồi mới tạo `b1 = observed`. Nếu C nhận `b1` trước `a1`, giao ngay sẽ làm ứng dụng quan sát một kết quả trước nguyên nhân của nó. Bài này dùng vector clock và bộ đệm bền vững để giữ `b1`, rồi giao `a1` trước `b1` khi dependency tới.

Đây là thí nghiệm ba replica cố định, không có credentials hay dịch vụ ngoài. Giá trị chỉ là chuỗi hư cấu. Đọc trước các khái niệm HTTP, SQLite transaction, idempotency và vector clock; không cần broker hoặc runtime package.

## Quy tắc giao

Mỗi node giữ vector `clock = {a:0,b:0,c:0}`. Thành phần `clock[x]` là số sự kiện liên tiếp của sender `x` đã **giao**, không phải đã nhận qua mạng. Một event có đúng dạng:

```json
{"sender":"b","seq":1,"clock":{"a":1,"b":1,"c":0},"value":"observed"}
```

`sender` thuộc `a|b|c`; `seq` là integer 1..8; mọi thành phần vector là integer 0..8 và `event.clock[event.sender] === event.seq`. `value` dài 1..16, chỉ `[A-Za-z0-9_-]`. Object, vector và request đều không nhận field thừa; null, array, primitive và kiểu sai bị từ chối. Không chuyển object thành string để kiểm tra.

Tại receiver, event chỉ đủ điều kiện nếu:

1. `event.seq === clock[event.sender] + 1`: không nhảy qua khoảng trống của cùng sender.
2. Với từng sender khác `x`, `event.clock[x] <= clock[x]`: mọi dependency khác đã được giao.

Khi giao, chỉ cập nhật thành phần của sender bằng `seq`. Không merge toàn bộ vector của event vào vector receiver; làm vậy sẽ giả vờ đã giao dependency chưa tồn tại.

Ví dụ gốc của bài:

| Thao tác | Vector của C | Lịch sử giao của C | Pending của C |
| --- | --- | --- | --- |
| A publish `a1`; B nhận `a1`, publish `b1` | `{0,0,0}` | rỗng | rỗng |
| C nhận `b1`, clock event `{1,1,0}` | `{0,0,0}` | rỗng | `b1` |
| C nhận `a1`, clock event `{1,0,0}` | `{1,1,0}` | `a1,b1` | rỗng |

Hai event `{a:1,b:0,c:0}` và `{a:0,b:1,c:0}` độc lập có thể được giao theo hai thứ tự khác nhau tại hai replica. Causal delivery **không hứa total order**.

## Kiến trúc và lưu trữ

```text
A + SQLite riêng ─┐             GET /events/{sender}/{seq}
B + SQLite riêng ─┼─ relay ───► POST /receive tại node đích
C + SQLite riêng ─┘       caller chọn một hop /relay
```

`core.mts` chứa validation và thuật toán. `node.mts` cung cấp API replica; `relay.mts` chỉ chuyển một event đã giao qua một hop cố định. Không có broadcast, polling, retry hoặc vận chuyển nền. Relay không có DB. Một hop từ B sang C có thể mang event gốc của A; `from` chỉ là nơi đang giữ bản sao đã giao. Source identity được xác định bằng **configured origin và tuple gốc được yêu cầu**, không yêu cầu `event.sender === from` và không thêm GET identity.

SQLite chứa một hàng snapshot gồm identity, vector, lịch sử giao theo thứ tự và pending. Mỗi publish/receive chạy `BEGIN IMMEDIATE`, đọc snapshot, kiểm tra receipt, đổi state, drain và ghi snapshot, rồi `COMMIT`. Nếu có lỗi thì `ROLLBACK`. Một event vừa được giữ vừa được giao local trong cùng commit. `journal_mode=WAL`, `synchronous=FULL`; không coi bài này là bảo đảm cho mọi lỗi phần cứng. Không dùng chung DB giữa các node hay chạy nhiều tiến trình ghi cùng một DB.

Identity lưu trong DB. Restart cùng identity giữ nguyên lịch sử và pending; dùng lại DB với identity khác thất bại trước khi listen. Node không xóa receipt. Tuple `(sender,seq)` đã giữ chỉ có một nội dung bất biến, kể cả sau restart. Có tối đa 24 tuple trong cả đời DB: 3 sender × 8 sequence. Hết counter cần một thí nghiệm với DB mới, không tái sử dụng sequence trong DB cũ.

Pending tối đa 4 event. Khi đầy, event mới chưa đủ điều kiện bị 429 và không đổi state; một dependency **đủ điều kiện vẫn được nhận**. Sau mỗi delivery, chọn event đủ điều kiện đầu tiên theo thứ tự sender `a,b,c`, rồi seq; lặp tới khi không còn event đủ điều kiện. Toàn bộ drain nằm cùng transaction. Thứ tự này chỉ là cách xử lý tie tại một node, không tạo total order giữa các node.

Publish chụp vector **đã giao**, tăng thành phần local rồi tạo event. Các dependency chỉ đang pending không được đưa vào clock mới. Publish cũng có thể mở khóa pending đang chờ sự kiện local vừa tạo.

## Chạy native

Yêu cầu Node **24.12+** (nhánh 24), npm và dev dependencies đã pin ở root. Dùng built-ins `node:sqlite`, `node:http`, `fetch`; không thêm package runtime. Từ root repository:

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/63-causal-broadcast/test/lesson.test.mts
npm run test:unit
node --test --test-name-pattern=integration: lessons/63-causal-broadcast/test/lesson.test.mts
```

Trong môi trường được phép mở loopback, chạy full checks `npm run check`, `make test`, `git diff --check`. Worker không mạng chạy typecheck/unit; controller chạy HTTP integration trong Docker cô lập. Test chưa chạy không được xem là pass.

Playground khởi động **lần lượt** A, B, C, relay trong bốn terminal. Chọn đường dẫn DB mới, riêng cho mỗi node. Mỗi tiến trình in JSON readiness `{service,port}`. `PORT=0` xin port ephemeral; dùng port thực từ readiness khi cấu hình tiến trình sau:

```bash
HOST=127.0.0.1 PORT=0 REPLICA_ID=a DB_PATH=/tmp/causal63-a.sqlite node lessons/63-causal-broadcast/node.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=b DB_PATH=/tmp/causal63-b.sqlite node lessons/63-causal-broadcast/node.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=c DB_PATH=/tmp/causal63-c.sqlite node lessons/63-causal-broadcast/node.mts
# Ví dụ readiness A=41001, B=41002, C=41003: thay bằng các port thực.
HOST=127.0.0.1 PORT=0 A_ORIGIN=http://127.0.0.1:41001 B_ORIGIN=http://127.0.0.1:41002 C_ORIGIN=http://127.0.0.1:41003 node lessons/63-causal-broadcast/relay.mts
```

Relay chuẩn hóa ba HTTP origin cố định và yêu cầu chúng khác nhau sau chuẩn hóa; cấm credentials, path khác `/`, query và fragment. Request không được chứa URL. Cấu hình playground chỉ dùng loopback. Không dùng tên biến bắt đầu `NODE_`, `LD_`, `DYLD_`. Các entrypoint inert khi import: không đọc cấu hình, mở DB, đăng ký signal hay listener trước `main()`. SIGTERM/SIGINT đóng listener qua helper, sau đó đóng DB.

Giả sử relay nhận port 41004; thay cả bốn port bằng giá trị thực:

```bash
curl -sS -H 'content-type: application/json' -d '{"value":"created"}' http://127.0.0.1:41001/publish
curl -sS -H 'content-type: application/json' -d '{"from":"a","to":"b","sender":"a","seq":1}' http://127.0.0.1:41004/relay
curl -sS -H 'content-type: application/json' -d '{"value":"observed"}' http://127.0.0.1:41002/publish
curl -sS -H 'content-type: application/json' -d '{"from":"b","to":"c","sender":"b","seq":1}' http://127.0.0.1:41004/relay
curl -sS http://127.0.0.1:41003/state
# B đã giao a1 nên có thể chuyển tiếp bản sao đó cho C.
curl -sS -H 'content-type: application/json' -d '{"from":"b","to":"c","sender":"a","seq":1}' http://127.0.0.1:41004/relay
curl -sS http://127.0.0.1:41003/state
```

Lần GET đầu thấy vector C còn zero và `b1` pending. GET cuối thấy `a1,b1` được giao theo thứ tự đó. Thử lặp lại relay `b1`: trả 200 delivered và lịch sử không tăng.

## Hợp đồng HTTP

Các POST yêu cầu `content-type: application/json`. Body inbound tối đa 8192 byte theo helper dùng chung; JSON hỏng trả 400, media type sai 415, body quá lớn 413. Schema sai trả `400 {error:{code:"invalid_request",message:"Invalid request"}}`. GET trả JSON; query/path lạ và route/phương thức không hỗ trợ trả 404. Không có route reset hoặc control ở node/relay thật.

| API replica | Thành công / kết quả |
| --- | --- |
| `POST /publish {value}` | 201 event local, hoặc 429 `counter_limit` nếu local component đã là 8 |
| `POST /receive event` | 200 `{status:"delivered"}` nếu giao ngay; 202 `{status:"buffered"}` nếu mới giữ pending |
| Replay đúng event đã giữ | 200 với status hiện tại `buffered` hoặc `delivered`, không giao lại |
| Cùng tuple, khác value hoặc clock | 409 `event_conflict`, không đổi state |
| Event chưa biết tự nhận là sender local | 409 `event_conflict`, không đổi state |
| Pending đầy, event mới chưa đủ điều kiện | 429 `buffer_full`, không đổi state |
| `GET /state` | `{node,clock,delivered,pending}`; delivered theo thứ tự giao, pending sort sender/seq |
| `GET /events/{sender}/{seq}` | 200 event chỉ khi đã giao; pending hoặc chưa biết trả 404 `unknown_event` |

Error envelope luôn có đúng `{error:{code,message}}`. Các thông điệp nghiệp vụ cố định:

| code | message |
| --- | --- |
| `unknown_event` | `Event is not delivered` |
| `event_conflict` | `Event conflicts with retained identity` |
| `buffer_full` | `Pending buffer is full` |
| `counter_limit` | `Local counter reached 8` |

Relay nhận đúng `POST /relay {from,to,sender,seq}`, ba identity thuộc `a|b|c`, `from != to`, seq integer 1..8. Nó GET source đã cấu hình, kiểm tra event schema và tuple requested, rồi POST event sang `/receive` tại destination đã cấu hình.

Relay chỉ giữ nguyên source 404 `unknown_event`, destination 409 `event_conflict`, 429 `buffer_full` khi **cả code và message cố định** đều đúng, không có field thừa. Destination 200 nhận đúng `{status:"delivered"}` hoặc `{status:"buffered"}`; 202 chỉ nhận `{status:"buffered"}`. JSON hợp lệ nhưng là primitive/array/sai schema, `internal_error` giả dạng 409, status khác, tuple sai hoặc clock sai đều trở thành `502 {error:{code:"upstream_failure",message:"Invalid upstream response"}}`.

Một deadline **500ms tổng** bao gồm GET, toàn bộ body GET, POST và toàn bộ body POST; không đặt lại đồng hồ giữa hai hop. Timeout cũng trả 502. Mỗi upstream body tối đa **2048 byte trên wire**, tính cả whitespace và escaping. Đọc stream có giới hạn, hủy khi lỗi; không đọc body vô hạn rồi mới kiểm tra. Giới hạn này đủ cho event và semantic envelope hợp lệ dù mọi ký tự của JSON string được mã hóa `\uXXXX`. Padding hợp lệ vẫn bị byte gate. Cả hai fetch dùng `redirect:'error'`, không chuyển event tới Location khác. Không có retry tự động hay URL do caller chọn.

## Lỗi mạng, liveness và giới hạn

Nếu destination commit rồi mất reply, relay trả 502 nhưng không thể kết luận event chưa được nhận. Retry cùng tuple/nội dung sẽ đọc receipt: vẫn buffered hoặc đã delivered, không tạo delivery lần hai. Retry thay đổi nội dung bị 409. Receipt làm **nhận lại** an toàn; client vẫn phải quyết định lúc nào retry và phải giữ nguyên payload. Publish chưa có request key: nếu mất reply publish, gửi lại `{value}` có thể tạo event mới, không có lời hứa exactly-once cho publish.

Dependency vắng có thể làm event chờ vô hạn. Không timeout pending để kết luận sender chết, không tự bỏ khoảng trống và không tạo dependency giả. Bộ đệm hữu hạn có thể gây backpressure; caller cần giao các dependency trước hoặc xử lý 429. Một node vẫn publish được dù đang giữ pending phụ thuộc vào sự kiện chưa tới.

Membership cố định; không có epoch, join/leave hoặc thay replica identity trong DB. Giả định sender trung thực và DB riêng tư: HTTP không xác thực origin thật của event. Vector có thể bị giả mạo qua `/receive`; validation không phải cơ chế chống Byzantine. Không có anti-entropy, phục hồi event thất lạc, consensus, quorum, atomic multicast hoặc reliable multicast. Causal delivery chỉ ràng buộc thứ tự của các event thật sự được giao; nó không hứa mọi replica cuối cùng đều nhận đủ mọi event hay đồng loạt commit một tập event.

Các con số 8 sequence, 4 pending, 24 receipt, 2048 byte và 500ms là lựa chọn giáo dục để các biên kiểm thử hữu hạn, không phải ngưỡng vận hành sản xuất. Một hàng JSON snapshot đơn giản hóa quan sát transaction nhưng không tối ưu throughput; không xóa receipt vì việc tái sử dụng tuple sẽ phá bất biến replay.

## Kiểm thử và bài tập

Unit dùng SQLite `:memory:`; ca đầu tiên mô tả C nhận `b1` trước `a1`, phải giữ vector zero rồi giao `a1,b1`. Các ca khác kiểm tra concurrent order, local publish chỉ chứa dependency đã giao, gap, replay thay đổi, buffer đầy vẫn nhận dependency, drain có thứ tự, cap 8, tổng 24 receipt, identity và chống sửa state qua object trả về.

HTTP integration khởi động ba node và relay thành các child process với port ephemeral, DB tạm dưới `node:os.tmpdir()`, không ghi vào source mount. Restart giữ pending và immutable receipt; identity sai không listen. Các fixture upstream hữu hạn tái sử dụng `/control {mode}` chỉ khi `TEACHING_CONTROLS=1`, còn mặc định 404. Fixture kiểm tra kiểu primitive trước khi dùng mode. Cleanup bao cả startup thất bại; mỗi lần acquire tài nguyên nằm trong phạm vi đã được bảo vệ.

Redirect test dùng destination `127.0.0.1` có port ephemeral riêng, reachable, đếm GET/POST; kiểm tra counter trước đổi mode. Chỉ thấy 502 không đủ chứng minh payload chưa bị chuyển tiếp. Test escaping chỉ biến đổi **JSON string token đã decode**, giữ nguyên number/boolean/null; fixture oversize vẫn parse được và có schema/tuple đúng. Header/body chậm và hai hop 300ms chứng minh deadline là tổng, không phải 500ms cho mỗi hop. Không cần mạng Internet.

Bài tập:

1. Cho `a2` đến C trước `a1`, rồi cho `b1` phụ thuộc `a1` đến. Dự đoán pending và thứ tự drain khi `a1` tới; đối chiếu `/state`.
2. Tạo hai event concurrent và chuyển đến hai replica theo thứ tự ngược nhau. Giải thích vì sao hai lịch sử khác nhau vẫn thỏa causal delivery.
3. Giữ một dependency vắng mãi: chứng minh bằng trạng thái rằng nhận request thành công không có nghĩa ứng dụng đã được giao event.
4. Thiết kế epoch và garbage collection receipt trên giấy. Cần điều kiện nào để biết mọi replica sẽ không replay tuple cũ? Không chỉ xóa receipt sau một khoảng thời gian.
5. Phân biệt xử lý reply bị mất của `/receive` với `/publish`. Nếu thêm idempotency key cho publish, key và event phải commit cùng transaction nào?

## Tài liệu gốc

- [Birman, Schiper, Stephenson — Lightweight Causal and Atomic Group Multicast (1991)](https://www.cs.cornell.edu/courses/cs614/2003sp/papers/BSS91.pdf): thuật toán multicast nhân quả, quan hệ với membership và các bảo đảm mạnh hơn. Bài học chỉ mô phỏng phần delivery/dependency trong membership cố định.
- [Lamport — Time, Clocks, and the Ordering of Events in a Distributed System (1978)](https://lamport.azurewebsites.net/pubs/time-clocks.pdf): quan hệ happens-before và partial order; đồng hồ vật lý hoặc một thứ tự bất kỳ không thay thế chứng cứ dependency.
