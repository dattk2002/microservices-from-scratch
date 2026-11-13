# 65 — Two-phase commit: lời hứa prepare và quyết định lưu bền

Bài này nối tiếp các bài về saga và TCC. Hai participant `a`, `b` quản lý **hai tài nguyên giả lập riêng biệt**, mỗi bên có tổng sức chứa 4 đơn vị. Một giao dịch yêu cầu cùng một `amount` ở cả hai bên. Coordinator ghi quyết định vào SQLite riêng trước khi gửi bất kỳ lệnh commit nào. Không có thanh toán, dữ liệu cá nhân, dịch vụ bên ngoài hay cam kết phù hợp cho production.

Mục tiêu: quan sát trực tiếp một participant giữ tài nguyên khi coordinator ngừng chạy, một quyết định commit tồn tại dù chưa ai nhận nó, và khoảng thời gian chỉ một bên đã commit. Chúng ta điều khiển từng bước; không có vòng lặp phục hồi ngầm.

## Điều kiện và chạy kiểm tra

Cần Node.js **24.12+ trong nhánh 24**, npm và các gói phát triển đã ghim ở thư mục gốc. Runtime chỉ dùng built-in Node: HTTP, fetch và `node:sqlite`; TypeScript là cú pháp erasable chạy trực tiếp. Chạy từ gốc repository:

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/65-two-phase-commit/test/lesson.test.mts
node --test --test-isolation=none --test-name-pattern=integration: lessons/65-two-phase-commit/test/lesson.test.mts
npm run check
make test
git diff --check
```

Lệnh integration cần môi trường cho phép mở loopback và ghi thư mục `node:os.tmpdir()`. Worker không mạng chỉ chạy typecheck và unit; controller chạy HTTP integration trong Docker cô lập. Không bỏ giới hạn sandbox để chạy thử. Không import entrypoint rồi tự động mở listener: `main()` chỉ chạy qua `import.meta.main`. Các biến môi trường sai không ảnh hưởng tới việc import.

## Kiến trúc và ranh giới

```text
client ── /transactions, /step, /deliver ── coordinator.sqlite
                                           │           │
                                 origin a  │           │ origin b
                                       participant a   participant b
                                       a.sqlite        b.sqlite
```

Mỗi process sở hữu một DB_PATH khác nhau, đặt trong thư mục riêng có quyền truy cập thích hợp. Không chia sẻ tệp DB giữa các dịch vụ. Participant lưu `PARTICIPANT_ID=a|b`; dùng lại DB với identity khác thất bại trước khi listen. Coordinator lưu role và cặp origin đã chuẩn hóa; đổi origin khi dùng lại DB cũng thất bại. Không có tham số URL trong request. Các origin HTTP loopback phải khác nhau sau chuẩn hóa (`:80` và cổng mặc định là cùng origin), không có userinfo, path khác `/`, query hoặc fragment.

Giới hạn **4 đơn vị**, **8 ID được giữ vĩnh viễn mỗi DB**, ID `[A-Za-z0-9_-]{1,16}` và **một prepared transaction tại một participant** là lựa chọn dạy học. Không có xóa hàng, thu gom tombstone, TTL hay rollback theo thời gian. Giá trị `amount` phải là number nguyên an toàn từ 1 đến 4; string `"2"` không được ép thành số. Payload cùng ID bất biến kể cả khi DB đã đầy.

SQLite dùng WAL và `synchronous=FULL`. Mỗi thay đổi cục bộ và receipt phục vụ replay nằm trong một `BEGIN IMMEDIATE`/`COMMIT`. `committed` được tính từ các hàng committed, thay vì tăng một bộ đếm bên ngoài transaction; chuyển prepared → committed và hiệu ứng tiêu thụ là cùng một thay đổi nguyên tử. Đây là mô hình tài nguyên giả lập trong SQLite, **không phải** transaction phân tán của SQLite hoặc tích hợp `PREPARE TRANSACTION` của PostgreSQL.

## Chạy thủ công: ba process độc lập

Mở terminal A, tạo DB riêng rồi chạy participant đầu tiên. Ghi lại `port` từ dòng readiness JSON, ví dụ `{"service":"2pc-a","port":...}`. Mọi lần khởi động đầu dùng cổng ephemeral:

```bash
LAB_A=$(mktemp -d)
export LAB_A
HOST=127.0.0.1 PORT=0 PARTICIPANT_ID=a DB_PATH="$LAB_A/a.sqlite" \
  node lessons/65-two-phase-commit/participant.mts
```

Terminal B:

```bash
LAB_B=$(mktemp -d)
export LAB_B
HOST=127.0.0.1 PORT=0 PARTICIPANT_ID=b DB_PATH="$LAB_B/b.sqlite" \
  node lessons/65-two-phase-commit/participant.mts
```

Terminal coordinator: nhập hai origin vừa nhận, dạng `http://127.0.0.1:12345`. DB coordinator cố định hai giá trị này để tránh vô tình gửi quyết định của một log cũ sang participant mới.

```bash
read -r -p 'A_ORIGIN từ readiness: ' A_ORIGIN
read -r -p 'B_ORIGIN từ readiness: ' B_ORIGIN
export A_ORIGIN B_ORIGIN
LAB_C=$(mktemp -d)
export LAB_C
HOST=127.0.0.1 PORT=0 DB_PATH="$LAB_C/coordinator.sqlite" \
  node lessons/65-two-phase-commit/coordinator.mts
```

Terminal client: nhập origin coordinator từ readiness. Hàm `send` hiển thị cả HTTP status.

```bash
read -r -p 'Origin coordinator: ' C
read -r -p 'Origin participant a: ' A
read -r -p 'Origin participant b: ' B
send() { curl -sS -i -H 'content-type: application/json' -d "$2" "$C$1"; printf '\n'; }
send /transactions '{"txId":"order_7","amount":3}'
send /step '{"txId":"order_7"}'
curl -sS "$A/state"
send /step '{"txId":"order_7"}'
curl -sS "$C/transactions/order_7"
```

Kết quả lần lượt: tạo `201 preparing`, bước một lưu `a=yes,b=null`, bước hai lưu `commit` với hai ack vẫn `false`. **Dừng coordinator tại đây** bằng Ctrl-C. Cả participant vẫn `prepared`, `committed=0`, `available=1`. Đợi lâu không giải phóng reservation.

Chạy lại coordinator trong cùng terminal và cùng DB, giữ nguyên A_ORIGIN/B_ORIGIN:

```bash
HOST=127.0.0.1 PORT=0 DB_PATH="$LAB_C/coordinator.sqlite" \
  node lessons/65-two-phase-commit/coordinator.mts
```

Cập nhật biến `C` trong terminal client theo cổng mới rồi giao quyết định từng bên:

```bash
read -r -p 'Origin coordinator sau restart: ' C
send /deliver '{"txId":"order_7"}'
curl -sS "$A/state"
curl -sS "$B/state"
send /deliver '{"txId":"order_7"}'
send /deliver '{"txId":"order_7"}'
```

Sau deliver đầu: `a.committed=3`, `b` vẫn prepared. Sau deliver thứ hai: cả hai committed 3; lần thứ ba không phát request nào. Để thử restart participant, Ctrl-C rồi dùng lại DB và **cổng đầu tiên của chính nó**; ví dụ trong terminal A:

```bash
read -r -p 'Cổng a ban đầu: ' A_PORT
HOST=127.0.0.1 PORT="$A_PORT" PARTICIPANT_ID=a DB_PATH="$LAB_A/a.sqlite" \
  node lessons/65-two-phase-commit/participant.mts
```

Thực hiện tương tự với B. Dừng các process trước khi dọn thư mục; chỉ khi không còn cần phục hồi log mới chạy `rm -r -- "$LAB_A"`, `rm -r -- "$LAB_B"`, `rm -r -- "$LAB_C"` trong các terminal tương ứng.

## Hợp đồng participant

Tất cả POST cần `content-type: application/json`. Object phải đúng bộ trường; `null`, array, primitive, trường thừa hoặc sai kiểu trả `400 invalid_body`. JSON hỏng trả `400 invalid_json`, body quá 8192 byte trả `413 body_too_large`, media type khác trả `415 unsupported_media_type`. Error có dạng `{error:{code,message}}`; với lỗi nghiệp vụ trong bài này `message` bằng `code`. Route không hỗ trợ, kể cả mọi route teaching trên dịch vụ thật, trả `404 not_found`.

| Route | Request / kết quả |
| --- | --- |
| `GET /state` | `200 {participant,committed,available,transactions}`; transactions sắp tăng theo txId, mỗi hàng `{txId,amount,phase}` |
| `POST /prepare` | `{txId,amount}` → `200 {txId,amount,vote:"yes"|"no"}` |
| `POST /decide` | `{txId,amount,decision:"commit"|"abort"}` → `200 {txId,amount,phase:"committed"|"aborted"}` |

`available = 4 − tổng committed − tổng prepared`, luôn trong 0..4. Phase participant là `prepared`, `rejected`, `committed`, `aborted`.

Prepare mới bỏ phiếu yes khi không có hàng prepared nào khác **và** đủ available. Nếu không, lưu rejected và trả no, kể cả có khả năng đủ chỗ sau này. Replay cùng payload: prepared/committed trả yes, rejected/aborted trả no. Payload khác cùng ID trả `409 tx_conflict`; ID mới thứ chín trả `429 capacity`. Replay không cần thêm chỗ.

Commit chỉ được nhận khi đã prepared. Chuyển thành committed đúng một lần; replay commit trả cùng receipt, không tiêu thụ lần nữa. Unknown/rejected commit trả `409 not_prepared`. Abort chuyển prepared/rejected thành aborted; unknown abort tạo tombstone, cũng chịu giới hạn 8. Replay abort trả `200`; quyết định đối nghịch với terminal state trả `409 decision_conflict`. Nếu amount khác, `tx_conflict` được xét trước. Tombstone chặn prepare đến muộn: trả no. Một yes từng được lưu là lời hứa giữ tài nguyên cho tới quyết định; sau abort rõ ràng, retry prepare được trả no.

## Hợp đồng coordinator

Record chính xác:

```json
{"txId":"order_7","amount":3,"phase":"preparing","votes":{"a":null,"b":null},"acks":{"a":false,"b":false}}
```

Phase là `preparing`, `commit` hoặc `abort`. `commit` là **quyết định**, không phải bằng chứng mọi bên đã áp dụng. `acks` mô tả receipt cục bộ đã được coordinator xác thực và lưu.

| Route | Kết quả |
| --- | --- |
| `POST /transactions {txId,amount}` | `201` record preparing lưu bền; replay `200` record hiện tại; `409 tx_conflict`, `429 capacity` |
| `GET /transactions/{id}` | `200` record; `404 unknown_transaction`; ID/path escape sai `400 invalid_body` |
| `POST /step {txId}` | Gọi đúng **một** participant chưa vote, a trước b; `200` record; record đã quyết định không gọi upstream |
| `POST /deliver {txId}` | Gọi đúng **một** participant chưa ack, a trước b; `200` record; đã ack cả hai không gọi upstream |

Step chỉ lưu vote khi status `200`, media type JSON, đúng bộ trường `{txId,amount,vote}`, đúng tuple, vote đúng literal. No lập tức lưu abort; hai yes mới lưu commit. Timeout, mất kết nối, redirect, status khác 200, error envelope dù đúng JSON, trường thừa, sai tuple, kiểu sai hoặc body quá lớn: **lưu abort trước**, trả `502 upstream_failure`. Sau lỗi đọc GET để biết quyết định; không suy ra từ response lỗi rằng chưa thay đổi gì.

Deliver trước quyết định trả `409 undecided`. Deliver chỉ lưu ack sau status `200` và đúng `{txId,amount,phase}` tương ứng với quyết định đã lưu. Mọi bất định trả `502 upstream_failure`, giữ ack false và giữ quyết định. Không forward 404/409/422/429 từ upstream thành nghĩa nghiệp vụ ở API coordinator; kể cả envelope `{error:{code:"internal_error",message:"internal_error"}}` cũng không phải vote/receipt. Không tin HTTP status thay cho schema. Step/deliver cùng ID đang chạy trả `409 busy`; ID khác độc lập. Unknown ID trả `404 unknown_transaction`.

Mỗi lần gọi có một deadline tuyệt đối **500 ms** gồm kết nối, headers và đọc **toàn bộ** body; `redirect:'error'`. Reply tối đa **1024 byte** gồm cả whitespace. Budget này đủ cho schema cố định, ID dài 16 và tất cả JSON string token escape thành `\uXXXX`. Fixture quá lớn vẫn là JSON/schema/tuple hợp lệ để byte gate là nguyên nhân thất bại. Không có retry tự động, URL do caller chọn hay endpoint thay đổi authority.

## Hai kịch bản thất bại cần phân biệt

1. **Mới một yes, coordinator chết:** a giữ prepared. Một transaction khác vẫn bị a trả no dù lượng yêu cầu nhỏ hơn available, vì bài giới hạn một prepared. Trên DB mới, tạo reservation riêng ở b trước, rồi cho coordinator step a và dừng. Restart cùng DB, step b sẽ nhận no từ reservation riêng đó; coordinator lưu abort. Chỉ `/deliver` abort tới a mới giải phóng nó. Reservation riêng ở b không bị abort nhầm; phải quyết định đúng ID của nó.
2. **Commit cục bộ xong nhưng mất reply:** participant đã tiêu thụ, coordinator vẫn ack false. Gọi lại `/deliver` cùng tuple; participant trả receipt committed hiện có. Không tăng committed hai lần. Restart không làm mất receipt hay đổi commit sang abort.

Abort có thể đến trước prepare bị chậm. Tombstone khiến prepare ấy không thể giữ tài nguyên sau khi coordinator đã hủy. Với vote bất định, coordinator không biết participant đã prepared hay chưa: abort cả hai an toàn trong mô hình này, nhưng việc giao abort vẫn có thể phải chờ participant phục hồi.

## 2PC chặn ở đâu, và điều bài này không giải quyết

Participant đã yes không thể tự hủy vì chờ quá lâu: coordinator có thể đã ghi commit và giao cho bên kia. Heuristic timeout rollback có thể tạo một bên committed, một bên aborted. Vì vậy log quyết định của coordinator phải còn: mất log sau khi một bên commit khiến coordinator mới không có cơ sở hợp lệ để chọn abort. Bài không có thao tác sửa tay hay tái tạo quyết định bị mất.

2PC điều phối một quyết định chung khi coordinator đáng tin và log còn nguyên. Nó **không** bảo đảm đồng thời nhìn thấy kết quả trên hai HTTP read độc lập, cũng không bảo đảm tiếp tục tiến triển khi coordinator hoặc participant không phục hồi. Nếu reader cần một snapshot nhất quán xuyên dịch vụ, đó là một hợp đồng khác cần cơ chế đọc thích hợp.

TCC cũng có Try/Confirm/Cancel ở tầng nghiệp vụ; các reservation có thể có chính sách hết hạn riêng và cần giải quyết cuộc đua với Confirm. Trong bài 2PC này, yes là lời hứa không hết hạn. Saga cho phép các bước đã công bố rồi bù trừ ở tầng nghiệp vụ, không giữ mọi participant prepared tới một quyết định chung. Consensus nhân bản một log để quyết định vẫn có thể tồn tại khi một số node hỏng; một coordinator SQLite duy nhất ở đây không thực hiện consensus. Gắn consensus vào log coordinator không tự xóa mọi trường hợp participant không truy cập được.

Các endpoint quyết định giả định **chỉ coordinator cố định đáng tin** gọi chúng. Chúng không có xác thực/ủy quyền, không ngăn caller tùy ý giả lệnh quyết định, không chống Byzantine, không triển khai leader election, TLS, disk corruption recovery, quota nhiều tenant hay HA. Chỉ bind loopback cho thực hành. Không dùng chung DB participant, không mất log để “mở khóa”, không dùng kết quả bài này làm bảo đảm giao dịch production.

## Thiết kế kiểm thử và bài tập

Unit dùng SQLite in-memory và transport được tiêm để kiểm tra quyết định thật của engine. Test đầu bắt việc mất reservation sau outage; logical clock đi xa vẫn không hủy prepared. Các test khác bắt terminal conflict, tombstone, immutable amount, tám ID, hai-yes gate, ack sai schema và lock cùng transaction. Import trong child process với cấu hình cố ý sai phải im lặng, không mở SQLite/listener.

Integration khởi động process độc lập trên `127.0.0.1:0`, DB ở tmpdir, có cleanup cả khi startup lỗi. Nó dừng coordinator đúng sau commit log trước deliver; restart cả ba, giao từng quyết định và kiểm tra partial visibility. Fixture teaching chỉ bật với `TEACHING_CONTROLS=1`, kiểm tra kiểu nguyên thủy trước khi dùng mode. Fixture được tái sử dụng qua nhiều biến thể; fixture wire không giả vờ cung cấp độ bền thật. Redirect trỏ tới origin loopback khác đang chạy và kiểm tra request counter của đích **trước khi đổi mode**, thay vì chỉ nhìn `502`. Các test HTTP được viết để controller thực thi, không phải bằng chứng chúng đã chạy ở worker.

Bài tập:

- Dừng sau một yes, sau hai yes, sau một ack. Liệt kê điều gì đã lưu bền ở từng DB và lệnh tiếp theo hợp lệ.
- Thử abort trước prepare, payload khác cùng ID, ID thứ chín. Giải thích vì sao không được tái sử dụng tombstone.
- Chạy hai `/step` đồng thời cùng ID rồi khác ID. Phân biệt lock coordinator với giới hạn một prepared của participant.
- Nếu muốn thu gom tám hàng cũ, cần bằng chứng nào để request đến muộn không hồi sinh transaction? Viết giao thức trước khi sửa code.
- Thiết kế reader cần nhất quán xuyên participant. Có thể chỉ dùng hai `GET /state` để đạt điều đó trong khoảng partial visibility không?

Nguồn gốc để đọc tiếp: [PostgreSQL — Two-Phase Transactions](https://www.postgresql.org/docs/current/two-phase.html) mô tả cơ chế và trách nhiệm của transaction manager; [PREPARE TRANSACTION](https://www.postgresql.org/docs/current/sql-prepare-transaction.html) nêu trạng thái prepared và tác động giữ tài nguyên. Bài dùng mô hình độc lập, không sao chép prose hay yêu cầu chạy PostgreSQL.
