# 67 — Bầu leader theo Raft, term và phiếu bầu lưu bền

Ba tiến trình độc lập `a`, `b`, `c` thực hành **state machine bầu cử có phiếu bầu lưu bền**. Mỗi node có SQLite riêng; chỉ lệnh HTTP tường minh mới làm thay đổi trạng thái. Không có bộ hẹn giờ tự bầu cử, gửi heartbeat nền, ghi application log hay suy luận leader từ thời gian đã trôi qua.

## Điều kiện và chạy thử

Cần Node.js **24.12+ thuộc nhánh 24**, npm và các development package đã cài ở thư mục gốc. Runtime chỉ dùng built-in Node, gồm `node:sqlite`. Chạy mọi lệnh dưới đây từ gốc repository. Các source trong lesson không import lesson khác; chúng dùng lại `lib/http.mts` và test harness `test/support.mts` của repository.

Tạo thư mục dữ liệu riêng, rồi giữ nguyên đường dẫn này khi restart. Trong cùng shell điều khiển:

```bash
RAFT_DATA=$(mktemp -d)
export RAFT_DATA
printf '%s\n' "$RAFT_DATA"
```

Ba lệnh sau chạy ở ba terminal riêng. Trước mỗi lệnh, đặt `RAFT_DATA` bằng **đúng đường dẫn vừa in**, thay vì tạo thư mục mới. Các cổng mẫu phải đang trống:

```bash
HOST=127.0.0.1 PORT=30671 REPLICA_ID=a DB_PATH="$RAFT_DATA/a.sqlite" \
PEER_ONE_ID=b PEER_ONE_ORIGIN=http://127.0.0.1:30672 \
PEER_TWO_ID=c PEER_TWO_ORIGIN=http://127.0.0.1:30673 \
node lessons/67-raft-leader-election/node.mts
```

```bash
HOST=127.0.0.1 PORT=30672 REPLICA_ID=b DB_PATH="$RAFT_DATA/b.sqlite" \
PEER_ONE_ID=a PEER_ONE_ORIGIN=http://127.0.0.1:30671 \
PEER_TWO_ID=c PEER_TWO_ORIGIN=http://127.0.0.1:30673 \
node lessons/67-raft-leader-election/node.mts
```

```bash
HOST=127.0.0.1 PORT=30673 REPLICA_ID=c DB_PATH="$RAFT_DATA/c.sqlite" \
PEER_ONE_ID=a PEER_ONE_ORIGIN=http://127.0.0.1:30671 \
PEER_TWO_ID=b PEER_TWO_ORIGIN=http://127.0.0.1:30672 \
node lessons/67-raft-leader-election/node.mts
```

Mỗi tiến trình in một dòng readiness JSON, ví dụ `{"service":"raft-a","port":30671}`. Có thể đặt `PORT=0` để hệ điều hành cấp cổng và đọc cổng thật từ dòng này; các peer vẫn cần origin cố định đã cấu hình, nên ví dụ thủ công dùng cổng biết trước. Import `node.mts` không mở SQLite, đọc cấu hình hay mở listener.

Bầu `a`, rồi đọc trạng thái của ba node:

```bash
curl -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:30671/campaign
curl -sS http://127.0.0.1:30671/state
curl -sS http://127.0.0.1:30672/state
curl -sS http://127.0.0.1:30673/state
```

Kỳ vọng `a`: `{"id":"a","term":1,"votedFor":"a","role":"leader","lastLogIndex":0,"lastLogTerm":0}`. Hai peer lưu phiếu cho `a`. Dừng `c` bằng Ctrl-C rồi chạy lại đúng lệnh, cùng DB: role là follower, phiếu term 1 vẫn còn. Thử đổi người xin phiếu trong cùng term:

```bash
curl -sS -H 'content-type: application/json' \
-d '{"term":1,"candidateId":"b","lastLogIndex":0,"lastLogTerm":0}' \
http://127.0.0.1:30673/vote
```

`c` trả `granted:false`. Gọi `/campaign` ở `c`: nó tăng term lên 2, bầu được nếu nhận thêm một phiếu; `a` nghe term mới qua `/vote` và hạ xuống follower. Dừng cả `a` và `b`, gọi `/campaign` ở `c`: trả HTTP 200 nhưng **role là candidate**, vì chỉ còn phiếu của chính nó. HTTP thành công không chứng minh đã có quorum. Khi hoàn tất, dừng các tiến trình trước khi tự xóa thư mục dữ liệu thử nghiệm.

## Cấu hình và dữ liệu

| Biến | Hợp đồng |
| --- | --- |
| `HOST` | `127.0.0.1`, mặc định cùng giá trị |
| `PORT` | Số nguyên 0..65535, mặc định 3067; 0 cho readiness với cổng thật |
| `DB_PATH` | Bắt buộc, đường dẫn file SQLite riêng cho mỗi node; từ chối `:memory:` và URI `file:`; không chia sẻ file |
| `REPLICA_ID` | Chính xác `a`, `b` hoặc `c` |
| `PEER_ONE_ID`, `PEER_TWO_ID` | Hai id khác nhau còn lại trong cụm |
| `PEER_ONE_ORIGIN`, `PEER_TWO_ORIGIN` | Hai HTTP origin `127.0.0.1` khác nhau sau chuẩn hóa; không credentials, path, query, fragment |
| `BOOTSTRAP_LOG_INDEX`, `BOOTSTRAP_LOG_TERM` | Mặc định 0/0; mỗi số 0..4, cùng bằng 0 hoặc cùng dương |

Cặp bootstrap chỉ seed DB lần đầu. Với file đã tồn tại, vẫn phải cung cấp đúng identity và cặp log ban đầu; khác cấu hình sẽ lỗi **trước listen**, không sửa dữ liệu cũ. Term khởi tạo bằng `lastLogTerm`. Có thể dùng 4/2 cho `c` để thấy một candidate có log 4/1 bị từ chối dù index bằng nhau; log 1/3 lại mới hơn vì **so term của log trước, index sau**. Log là metadata cố định để minh họa điều kiện cấp phiếu, không phải một log được nhân bản.

Bảng SQLite lưu một dòng `id`, `current_term`, `voted_for`, `log_index`, `log_term`. SQLite dùng WAL, `synchronous=FULL` và mỗi lần cập nhật term/vote là một commit nguyên tử trước HTTP reply. Role và số phiên campaign nằm trong RAM. Restart luôn trở về follower, giữ nguyên term và phiếu. Độ bền vẫn phụ thuộc filesystem/storage và việc giữ đúng file, kể cả các file phụ WAL; không sao chép nóng riêng file `.sqlite` rồi coi đó là backup đầy đủ. Đây là mô hình một tiến trình sở hữu một DB, không hỗ trợ nhiều instance dùng chung file.

## HTTP contract

Request POST dùng `application/json`, body tối đa **8192 byte**. Mọi object phải có đúng các trường dưới đây; arrays, null, primitives, thiếu/thừa trường, string thay số và id ngoài `a|b|c` đều bị từ chối. Không ép kiểu trước kiểm tra primitive.

| Endpoint | Request | HTTP 200 |
| --- | --- | --- |
| `GET /state` | Không body | `{id,term,votedFor,role,lastLogIndex,lastLogTerm}` |
| `POST /vote` | `{term,candidateId,lastLogIndex,lastLogTerm}` | `{id,term,granted:boolean}` |
| `POST /heartbeat` | `{term,leaderId}` | `{id,term,accepted:boolean}` |
| `POST /campaign` | `{}` | State hiện tại khi hai yêu cầu xin phiếu đã kết thúc hoặc hết budget |

Term request nằm trong 1..16, metadata log trong 0..4 và tuple cùng 0 hoặc cùng dương. State term có thể bằng 0. `votedFor` là null hoặc id. Role là follower, candidate hoặc leader. Đạt trần term 16 thì `/campaign` trả **409** `{"error":{"code":"term_exhausted","message":"term_exhausted"}}`, giữ nguyên state. Muốn thực hành lại từ đầu cần chủ động tạo cụm dữ liệu mới; không reset term trong file đang dùng.

Các lỗi khác dùng `{error:{code,message}}`: 400 `invalid_body` hoặc `invalid_json`; 413 `body_too_large`; 415 `unsupported_media_type`; 405 `method_not_allowed` kèm header Allow; 404 `not_found`; 500 `internal_error` cho lỗi ngoài dự kiến. Phiếu từ chối và heartbeat cũ là kết quả hợp lệ HTTP 200, không phải lỗi schema.

### Quy tắc chuyển trạng thái

1. `/vote` có term lớn hơn: lưu term mới và xóa phiếu trước khi xét độ mới của log. Candidate log cũ bị từ chối nhưng term vẫn tiến lên và node thành follower. Term nhỏ hơn bị từ chối, không xóa phiếu.
2. Cùng term chỉ cấp phiếu khi chưa bầu hoặc đã bầu đúng candidate đó, đồng thời log candidate ít nhất mới bằng local. Xin lại phiếu cùng người là idempotent; đổi người cùng term không được cấp phiếu. Phiếu được commit trước `granted:true`.
3. `/heartbeat` cũ trả `accepted:false`. Cùng term hoặc cao hơn trả true và chuyển follower. Cùng term giữ phiếu, cao hơn xóa phiếu. Không tự kiểm chứng leader đã có đa số; các endpoint là giao thức giữa thành viên tin cậy của mô hình thử nghiệm, không có authentication.
4. `/campaign` tăng term, lưu self-vote rồi thành candidate. Nó POST `/vote` tới đúng hai peer đã cấu hình, song song. Tính phiếu của chính mình cộng các id peer khác nhau trả đúng identity, đúng term và `granted:true`. Tổng ít nhất 2/3 thì thành leader; thiếu đa số thì vẫn candidate.
5. Phản hồi hợp lệ mang term cao hơn lập tức được lưu, xóa phiếu và hạ role. Campaign cũ không thể ghi đè term mới, hoặc ghi đè việc một heartbeat cùng term vừa chuyển node về follower: khi hoàn tất, nó kiểm tra cả term, role và số phiên campaign. Campaign chờ cả hai kết quả trước khi công bố leader nên không bỏ qua một phản hồi term cao hơn đến sau phiếu đa số.

## Ranh giới RPC và sự cố

Một campaign có **một deadline 500 ms chung** cho cả hai RPC, từ lúc bắt đầu gửi cho đến khi đọc xong mọi body. Không cấp lại 500 ms sau headers. Fetch dùng `redirect:'error'` và cùng AbortSignal. Mỗi upstream body tối đa 8192 byte trên wire, kể cả whitespace và JSON string đã escape; không chỉ kiểm kích thước object sau parse. Reply phải là JSON đúng content type và schema chính xác. HTTP 200 với `null`, boolean, array, id sai, granted sai kiểu hay trường thừa không thành phiếu.

Response lỗi cũng được đọc có giới hạn và kiểm `{error:{code,message}}` theo status/code/message cố định của `/vote`. Ví dụ 400 `invalid_body` hợp lệ chỉ là peer từ chối RPC; 400 `internal_error` dù có đủ hai string vẫn là response bất thường. Không status upstream nào được chuyển tiếp thành trạng thái business của campaign. Từ chối RPC, lỗi schema, kết nối đứt, redirect hoặc timeout đều không đóng góp phiếu; caller nhận state tổng hợp. Không suy ra phiếu chưa được ghi từ lỗi mạng: peer có thể đã commit phiếu nhưng mất response. Vì vậy không rollback term hay self-vote khi RPC lỗi.

Lỗi ghi SQLite cục bộ khác lỗi RPC: node lập tức hạ về follower, vô hiệu hóa mọi campaign đang chờ và khóa các thao tác `/campaign`, `/vote`, `/heartbeat` cho đến khi restart tiến trình. Campaign gặp lỗi ghi không trả state thành công; các thao tác bị khóa trả HTTP 500 `internal_error`. Phản hồi RPC đến muộn không thể bầu leader hay sửa term/vote sau lỗi. Đặc biệt, khi nghe term cao hơn nhưng không lưu được, node không được tiếp tục bầu trong term cũ. `/state` vẫn có thể đọc nếu SQLite còn đọc được; nó phản ánh term/vote đã commit, có thể thấp hơn term vừa nghe. Không tự sửa term/vote trong RAM để giả vờ commit thành công.

Để phục hồi, dừng tiến trình lỗi, xử lý nguyên nhân storage và khởi động lại với đúng DB cùng cấu hình; không xóa DB hay reset term/phiếu. Chỉ sửa storage trong khi tiến trình vẫn chạy không mở khóa node. Khi restart, role là follower và term/vote được đọc lại từ dữ liệu bền; node tiếp tục học term mới qua giao thức. Nếu không bảo đảm dữ liệu bền còn nguyên, cần phục hồi dữ liệu an toàn trước khi cho node tham gia lại.

`core.mts` chứa state machine và ownership của state, `protocol.mts` kiểm schema/config, `transport.mts` giữ budget/body boundary, `node.mts` chuyển HTTP sang hành vi. `test/fixture.mts` chỉ phục vụ test, có control tường minh để giữ/mất/đổi response và một origin khác đếm redirect; không nằm trong entrypoints của lesson.

## Vì sao điều này chưa phải Raft đầy đủ

Một node chỉ bầu một candidate mỗi term sau crash, và hai đa số trong cụm ba node luôn có giao. Hai tính chất này là nền tảng của **election safety trong cùng term**, với giả định danh tính cấu hình đúng, thành viên không Byzantine, dữ liệu bền không bị mất và một owner cho mỗi DB. Chúng không ngăn một leader cũ ở term 1 còn giữ role leader trong RAM trong khi cụm khác đã bầu leader ở term 2. Nó chỉ hạ role khi nghe term mới; unit test mô phỏng partition bằng cách chặn RPC tới node cũ, không dùng đồng hồ để đoán sự cố.

Role leader không chứng minh quyền ghi, lease còn hạn, hay freshness của một lần đọc. `/state` chỉ là quan sát cục bộ, **không phải linearizable read**. Lesson không nhận application writes, không có lease, fencing, `AppendEntries`, commitIndex, state machine replication, membership change hoặc snapshot. Điều kiện log freshness ở đây chỉ dùng metadata cố định; nó không tự tạo ra log matching hay leader completeness. Một heartbeat thủ công cũng không phải triển khai `AppendEntries` hoàn chỉnh.

Raft thực tế dùng election timeout ngẫu nhiên để giảm split vote và tiến tới bầu được leader khi mạng đủ ổn định. Lesson cố ý loại cơ chế timer và log replication: hai campaign đồng thời có thể chia phiếu, và chỉ thao tác tiếp theo của người học mới thử lại. Hết 500 ms chỉ chốt việc chờ RPC của lần thử này, không chứng minh node chết, quyền leader hết hạn hay quyền ghi của bất kỳ ai.

## Kiểm thử và kiểm chứng

Unit dùng SQLite in-memory và Promise được điều khiển trực tiếp để tái hiện thứ tự RPC/heartbeat, không ngủ chờ. Ca RED đầu tiên đòi cấp phiếu cho `a` term 2, mở lại state machine trên cùng DB, từ chối `b` cùng term và cấp `b` term 3. Integration bổ sung restart tiến trình thật với file còn nguyên.

Regression storage dùng SQLite trigger từ chối commit term 5 trong khi peer còn lại cấp phiếu đúng term campaign. Test đòi campaign báo lỗi, giữ term/vote đã commit và role follower, khóa cả ba thao tác dù trigger đã được gỡ, rồi kiểm tra restart. Promise barrier giữ hai RPC của campaign cũ để xác nhận các phiếu đến sau lỗi cũng không trả thành công hay bầu leader.

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/67-raft-leader-election/test/lesson.test.mts
npm run typecheck
npm run test:unit
```

Các kiểm thử HTTP thật dành cho môi trường có loopback/network được controller cho phép:

```bash
node --test --test-concurrency=1 --test-timeout=15000 lessons/67-raft-leader-election/test/lesson.test.mts
npm run check
make test
git diff --check
```

Integration không mở listener ở module top level. Ba node là child process độc lập, dùng file trong `node:os.tmpdir()`. Test dành trước ba cổng ephemeral rồi đóng reservation trước startup vì cấu hình peer cần cổng biết trước; có một khoảng bind race nhỏ và startup sẽ báo lỗi rõ nếu có tiến trình khác chiếm cổng. Mọi temp directory, socket, SQLite và service được đặt trong cleanup scope trước acquisition tiếp theo, kể cả startup lỗi. Đồng bộ campaign đang giữ qua `/stats`, không dùng sleep để đoán thời điểm.

Các ca HTTP kiểm tra bầu 3 node, restart giữ phiếu, thay leader bởi term mới, thiếu đa số, strict schemas, trần term, reply sai và lỗi semantic không được công nhận, mất response sau ghi phiếu, body vượt giới hạn vẫn parse/schema hợp lệ, body đến chậm sau headers, race heartbeat, và redirect tới origin loopback khác thực sự đang listen. Counter của đích phải bằng 0 ngay sau redirect, trước khi đổi mode. Test chỉ cho phép fixture sinh lỗi; node production không có control này.

Worker không có quyền network chỉ chạy typecheck/unit; controller chạy integration và `make test` trong môi trường cô lập. Việc có source test không phải bằng chứng HTTP test đã pass.

## Bài tập

- Cho `c` bootstrap 4/2, hai node còn lại 4/1. Gọi campaign ở node log cũ rồi giải thích vì sao term của `c` vẫn tăng dù không cấp phiếu. Sau đó bầu `c`.
- Trong cùng term, gửi heartbeat sau khi đã cấp phiếu, rồi xin phiếu với candidate khác. Kiểm tra vote vẫn còn sau cả heartbeat lẫn restart.
- Dùng unit sender được điều khiển để cho hai campaign chồng nhau và trả một response term cao hơn sau cùng. Giải thích chỗ cần kiểm số phiên ngoài kiểm term.
- Vẽ hai đa số bất kỳ trong tập `{a,b,c}`. Dùng giao của chúng và phiếu lưu bền để lập luận vì sao không có hai leader được bầu ở cùng term; chỉ rõ tại sao lập luận không áp dụng cho hai term khác nhau.
- Liệt kê cơ chế còn thiếu trước khi phục vụ một linearizable read hoặc application write. Không biến endpoint `/state` thành read tuyến tính chỉ bằng kiểm tra `role==='leader'`.

Nguồn chính: Diego Ongaro và John Ousterhout, [In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf), đặc biệt Figure 2 và §5.2–5.4. Đọc cùng phần safety/liveness để phân biệt lời hứa của bầu cử với lời hứa của toàn bộ giao thức.
