# 61 — Escrow counter: chuyển quyền tiêu thụ và giữ bất biến tồn kho

Ta có **6 món hàng hư cấu**, hai replica A/B và hai file SQLite riêng. Mỗi replica giữ 3 **quyền tiêu thụ** ban đầu. Khi mất kết nối, mỗi bên vẫn có thể bán trong phần quyền của mình mà tổng số đã bán không vượt 6. Đây là ví dụ gốc, thu nhỏ cho đúng hai actor cố định, lấy cảm hứng từ bounded counter; không phải thư viện CRDT tổng quát hay giao thức chống Byzantine.

## Bài toán: tồn kho toàn cục chưa hết nhưng local phải từ chối

A biết `remaining=6` nhưng `spend4` vẫn trả 409: A chỉ sở hữu 3 quyền. B chuyển 2 quyền sang A, quyền B giảm ngay còn 1. A chưa quan sát transfer thì vẫn chỉ dùng được 3. Sau một lần sync B→A, A có 5 quyền, tiêu 5 được, toàn cục còn đúng 1. Một món cuối nằm trong quyền của B; A không tự mượn nó.

Availability đến từ việc **phân bổ trước quyền**. Khi partition, không cần hỏi node kia cho mỗi lần spend. Đổi lại, nhu cầu lệch về một node có thể bị từ chối dù nơi khác còn quyền. Transfer cần truyền trạng thái để receiver quan sát; không có lời hứa rằng hai GET riêng lẻ là ảnh chụp đồng thời của toàn hệ thống.

## Trạng thái và chứng minh bảo toàn

Snapshot durable chỉ có đúng bốn bộ đếm đơn điệu:

```json
{"spent":{"a":0,"b":0},"transferred":{"ab":0,"ba":0}}
```

`spent.a`, `spent.b` là safe integer 0..6; `ab`, `ba` là safe integer 0..16. A là writer duy nhất của `spent.a` và `ab`; B tương tự với `spent.b` và `ba`. Giá trị dẫn xuất:

```text
rights.a = 3 + ba - ab - spent.a
rights.b = 3 + ab - ba - spent.b
remaining = 6 - spent.a - spent.b
rights.a + rights.b + spent.a + spent.b = 6
```

Mỗi rights phải nằm trong 0..6, tổng spent không vượt 6. Spend tăng riêng spent của local và giảm đúng lượng quyền local. Transfer tăng riêng bộ đếm outbound, giảm quyền sender và cấp quyền receiver; hai hạng transfer triệt tiêu trong đẳng thức tổng. Sender không thể tiêu lại phần đã gửi, kể cả receiver chưa nhận. Receiver không thể dùng transfer chưa quan sát. Khi hai bên tiêu 3 trong partition, hợp nhất cho spent `{a:3,b:3}`, rights `{a:0,b:0}`, remaining 0.

Merge là lấy **max riêng từng component**, không cộng snapshot và không ghi đè bằng state nhận sau cùng. Với các lịch sử reachable dưới giả định một writer mỗi actor, phụ thuộc vào quyền inbound đã thấy được giữ trong full snapshot. Một state mới không làm mất dependency của spend đã ghi. Max giữ thành phần mới nhất mỗi writer; duplicate, thứ tự đảo và snapshot cũ không hạ bộ đếm. Max có tính giao hoán, kết hợp, lũy đẳng; tests dùng ba lịch sử hand-derived: A→B1, B tiêu2 sau khi thấy transfer, A tiêu1 khi chưa thấy lần tiêu của B.

API kiểm tra cả snapshot đầu vào **và kết quả join** trước commit. Hai snapshot riêng hợp lệ vẫn có thể join bất khả thi nếu có writer bị fork: A tiêu3 ở lịch sử thứ nhất, nhưng một writer giả khác của A chuyển3 ở lịch sử thứ hai. Join cho rights.a=-3; server trả 409, giữ nguyên dữ liệu. Đây là phát hiện một số lỗi giả định, không phải chứng minh nguồn gốc của state.

## Kiến trúc và phạm vi tin cậy

```text
replica A + private a.sqlite ← POST snapshot /merge ← sync ← GET /state B
replica A /state             → sync → /merge replica B + private b.sqlite
```

`replica.mts` sở hữu SQLite. `model.mts` kiểm tra schema/bất biến và tính quyền. `store.mts` dùng giao dịch `BEGIN IMMEDIATE` cho spend, transfer và merge; lỗi rollback. Danh tính cấu hình được lưu cùng snapshot, kiểm tra khi mở DB trước listen. Chạy lại với danh tính khác thất bại và không thay dữ liệu. Restart đúng danh tính giữ nguyên quyền và counters. Không chạy hai writer cùng actor, kể cả trên hai DB khác nhau; khóa SQLite trên một file không ngăn được fork đó.

`sync.mts` không giữ bản sao state. Nó chỉ trao đổi theo một chiều khi caller yêu cầu, không có lịch gửi nền, retry nội bộ, receipt, danh sách operation hay tracking tăng vô hạn. Mọi entrypoint inert khi import: chỉ `main()` mới đọc env, mở DB, tạo listener và đăng ký signal shutdown qua helper HTTP.

Các giả định bắt buộc: đúng hai thành viên A/B, một writer đáng tin mỗi actor, private DB không bị sửa ngoài service và peer state đáng tin. Không có authentication, chữ ký, discovery, consensus hoặc tái cấu hình thành viên. Một client có thể chế tạo snapshot thỏa schema/bất biến; validation không biến client đó thành peer hợp lệ. Chỉ chạy trên loopback cho thí nghiệm.

6 hàng, 3 quyền ban đầu, transfer component tối đa 16, amount 1..6, 500 ms và 2048 byte đều là giới hạn giáo dục. Không có mint, restock, reclaim, reset transfer, mượn quyền ngầm hoặc expiry. Mất DB/actor đồng nghĩa mất khả năng dùng phần quyền của actor đó. Không được khởi tạo actor thay thế rồi cấp lại 3 quyền khi actor cũ có thể quay lại. Khôi phục/reclaim an toàn đòi hỏi phối hợp, chặn writer cũ và thay giao thức; bài này không cung cấp thao tác ấy.

## Chạy native và playground

Yêu cầu Node **24.12+ trong nhánh 24**, npm và dev dependencies đã pin ở root. Runtime chỉ dùng built-ins. Chạy lệnh từ root repository:

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/61-escrow-bounded-counter/test/lesson.test.mts
npm run test:unit
node --test --test-name-pattern=integration: lessons/61-escrow-bounded-counter/test/lesson.test.mts
```

Full checks ở môi trường phù hợp: `npm run check`, `make test`, `git diff --check`. Worker không có mạng chỉ thực thi typecheck/unit; controller chạy HTTP tests bằng loopback riêng trong Docker. Test HTTP chưa chạy không được tính là pass. Các test persistent/HTTP dùng `node:os tmpdir()` và cleanup kể cả startup thất bại; units thuật toán dùng SQLite in-memory.

Mở lần lượt **A, B, sync** trong ba terminal. Dùng đường dẫn DB mới riêng cho từng replica trong lần thí nghiệm đầu. Khởi động lại phải giữ đúng file và identity. Mỗi service in một dòng JSON `{service,port}` sau khi listen:

```bash
HOST=127.0.0.1 PORT=0 REPLICA_ID=a DB_PATH=/tmp/escrow-a.sqlite node lessons/61-escrow-bounded-counter/replica.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=b DB_PATH=/tmp/escrow-b.sqlite node lessons/61-escrow-bounded-counter/replica.mts
# Ví dụ A in 41001, B in 41002: thay bằng port thực vừa đọc.
HOST=127.0.0.1 PORT=0 A_ORIGIN=http://127.0.0.1:41001 B_ORIGIN=http://127.0.0.1:41002 node lessons/61-escrow-bounded-counter/sync.mts
```

Sync chuẩn hóa hai origin HTTP `127.0.0.1`, yêu cầu khác nhau; từ chối credentials, path khác `/`, query và fragment. Không nhận URL từ caller. Không dùng biến env bắt đầu `NODE_`, `LD_`, `DYLD_` do playground manager dành riêng. Cấu hình ứng dụng chỉ gồm `HOST`, `PORT`, `REPLICA_ID`, `DB_PATH`, `A_ORIGIN`, `B_ORIGIN`. Fixtures có `SINK_ORIGIN` cố định và control chỉ bật bằng `TEACHING_CONTROLS=1`; service thật không có control route.

Giả sử sync in 41003; thay các port dưới đây bằng giá trị readiness thực tế:

```bash
curl -sS -H 'content-type: application/json' -d '{"amount":4}' http://127.0.0.1:41001/spend
# 409 insufficient_rights, không đổi snapshot.
curl -sS -H 'content-type: application/json' -d '{"amount":2}' http://127.0.0.1:41002/transfer
curl -sS -H 'content-type: application/json' -d '{"from":"b"}' http://127.0.0.1:41003/sync
curl -sS -H 'content-type: application/json' -d '{"amount":5}' http://127.0.0.1:41001/spend
curl -sS http://127.0.0.1:41001/state
```

GET cuối trả:

```json
{"replica":"a","snapshot":{"spent":{"a":5,"b":0},"transferred":{"ab":0,"ba":2}},"rights":{"a":0,"b":1},"remaining":1}
```

Sync A→B rồi B tiêu1 để dùng món cuối. Ctrl-C để dừng từng process. Giữ các DB nếu muốn kiểm tra restart; chỉ xóa DB thí nghiệm của mình sau khi dừng. Không tái tạo một DB trắng cho actor còn tồn tại trong cùng hệ thống.

## Hợp đồng replica

Request JSON phải có content-type `application/json`, tối đa 8192 byte theo helper chung (sai media type 415, vượt byte 413). Object phải có đúng field; null/array/primitive/extra field/kiểu sai trả 400. JSON lỗi cũng 400. Không ép kiểu chuỗi/số/object. Route hoặc method không hỗ trợ trả 404.

| Route | Request | Kết quả |
| --- | --- | --- |
| `GET /state` | Không body | 200 `{replica,snapshot,rights,remaining}`. |
| `POST /spend` | `{amount}` integer 1..6 | 200 full state; tăng own spent khi đủ local rights. Thiếu quyền 409 `insufficient_rights`. |
| `POST /transfer` | `{amount}` integer 1..6 | 200 full state; tăng outbound `ab` hoặc `ba`. Thiếu local rights 409; nếu đủ quyền nhưng outbound vượt16 thì 429 `transfer_limit`. |
| `POST /merge` | Snapshot đúng `{spent:{a,b},transferred:{ab,ba}}` | 200 full state sau max join. Schema sai 400; snapshot hoặc join vi phạm bất biến 409 `invariant_conflict`. |

Mọi nhánh từ chối đều không thay snapshot. Transfer không mang transfer ID và không thể rút lại. Gửi lại cùng `{amount:1}` là **thao tác mới**; client không được retry spend/transfer mù khi mất reply. Chỉ merge cùng snapshot là lũy đẳng. Hai lệnh transfer1 liên tiếp tăng outbound2; hai merge của cùng outbound2 chỉ ghi nhận tổng2, không thành4.

Envelope lỗi chuẩn `{error:{code,message}}`; `invariant_conflict` có message cố định `Snapshot violates escrow invariants`. Counter ngoài giới hạn schema, chẳng hạn outbound17, là 400; counter trong giới hạn nhưng quyền âm là 409. Nhờ cap16, ping-pong quyền mãi sẽ cạn counter dù vẫn còn hàng; không reset để đi vòng qua giới hạn. Spend vẫn dùng được quyền còn lại khi transfer đã chạm cap.

## Hợp đồng sync và kết quả không chắc chắn

`POST /sync {from:"a"|"b"}` đọc `/state` từ origin được cấu hình cho actor đó, kiểm tra identity, snapshot, rights và remaining, rồi POST **chỉ snapshot** đến `/merge` của actor kia. Thành công trả 200 full state target đã được kiểm tra hoàn toàn. Không có bước gọi thêm để xác minh origin, không cho caller chỉ định đích.

Một `AbortSignal.timeout(500)` duy nhất áp dụng cho cả hai fetch và cả hai body đến byte cuối. Reader giới hạn mỗi response **2048 byte**, bao gồm whitespace và nội dung decode sau HTTP transfer encoding; không chỉ dựa Content-Length. Schema hữu hạn này cần dưới1024 byte khi mọi ký tự trong key/value chuỗi đều dùng `\uXXXX`; 2048 có khoảng dư nhưng không chấp nhận whitespace vô hạn. Không escape các token number/true/false/null trong fixtures. Reader còn yêu cầu JSON content-type.

Chỉ target409 với đúng envelope `invariant_conflict` và đúng message trên được chuyển thành409. `internal_error`, `insufficient_rights`, message khác, field thừa, primitive hay array dưới HTTP409 đều thành502. Source phải trả200 full state; source404/409 và mọi status bất ngờ đều502, kể cả JSON cú pháp hợp lệ. Mọi malformed JSON, sai derived field/identity, oversize, redirect, lỗi transport hoặc chậm đều502 `sync_failed`. Deadline ở bài này cũng502, không504. `redirect:'error'` ngăn GET/POST theo Location; tests dùng một destination loopback khác đang listen và kiểm tra counter ngay trước khi đổi mode.

**502 không chứng minh target rollback.** Target có thể đã commit merge rồi kết nối mất hoặc hết hạn khi gửi body. Caller chưa biết trạng thái cuối. Lặp lại snapshot merge không cộng lần nữa; gọi `/sync` lại lấy state source mới nhất cũng an toàn dưới giả định một writer, vì các component chỉ tăng. Sync thành công không có nghĩa mọi thay đổi local sau GET source đã được truyền. Chạy thêm một vòng khi cần hội tụ; không tự động retry các lệnh spend/transfer.

## Kiểm chứng và bài tập

Unit đầu tiên buộc `spend4` thất bại ở A dù còn6 toàn cục; B chuyển2, A quan sát rồi tiêu5, còn1. Các unit khác bảo vệ disconnected spend3+3, quyền chưa quan sát, stale/duplicate/reordered merge, luật max join với expected literal, rollback trước/sau join, giới hạn transfer16 và schema primitive/extra field. Import entrypoints trong child có env sai phải thoát0, không stdout/stderr.

HTTP tests khởi động process độc lập trên ephemeral loopback, DB riêng, dừng/restart và thử sai identity trước listen. Fixture process được tái sử dụng qua các biến thể lỗi; byte oversize vẫn là JSON/schema/identity hợp lệ nếu bỏ whitespace dư. Có kiểm tra deadline tổng300+300 ms, body chậm sau headers, redirect không đến sink, transport hỏng, error envelope không mong đợi ở cả hai hop và genuine target409 giữ nguyên DB. Một test cố ý tạo lịch sử fork để minh họa ranh giới trusted writers.

1. A nhận tải5 còn B không có tải khi partition. So sánh chia3/3 với chia5/1: tính availability và điều kiện nào buộc phải phối hợp.
2. Tự lập lịch sử A→B2, B→A1, A tiêu2, B tiêu2. Ghi dependencies cần quan sát trước từng bước, kiểm tra đẳng thức tổng và join hai bản đọc cũ.
3. Actor B mất vĩnh viễn cùng DB khi giữ2 quyền. Vì sao timeout không đủ căn cứ để A reclaim2? Thiết kế thêm bước fencing trước khi đổi membership trên giấy.
4. Thêm idempotency cho spend cần lưu gì cùng transaction? Khi nào được xóa receipt mà vẫn ngăn replay? Đừng gán đặc tính này cho API hiện tại.
5. Nếu bỏ giới hạn16 hoặc thêm restock, chứng minh nào và schema nào phải thay đổi? Nêu nguy cơ overflow và history reset.

Nguồn chính: [Balegas và cộng sự — Extending Eventually Consistent Cloud Databases for Enforcing Numeric Invariants](https://arxiv.org/abs/1503.09052). Đọc cách phân phối quyền để thực thi bất biến số và đối chiếu với tập con hai replica ở đây. Bài tập không sử dụng tài khoản, dữ liệu cá nhân, tiền thật, cloud hay tích hợp production.
