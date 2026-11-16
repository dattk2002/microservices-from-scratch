# 66 — Paxos cho một quyết định

Ba acceptor độc lập `a,b,c` cùng quyết định **một slot duy nhất**, với giá trị `red|blue`. Proposer dùng ballot nguyên `1..16`. Bài học tập trung vào hai điều dễ bỏ sót: promise phải sống qua restart, và proposer phải tiếp nhận giá trị đã được chấp nhận trong quorum promise, dù người gọi yêu cầu màu khác.

Cần Node.js **24.12+ thuộc dòng 24**, npm và kiến thức HTTP, SQLite, timeout, quorum. Runtime chỉ dùng built-in Node; chạy các lệnh bên dưới từ gốc repository, sau khi đã cài development dependencies được pin ở gốc. Không cần cloud, credential hay Docker để chạy bài học thủ công.

## Chạy bốn tiến trình

Tạo một thư mục dữ liệu riêng. Dùng bốn terminal, đặt cùng đường dẫn `PAXOS_DIR` trong từng terminal:

```sh
export PAXOS_DIR=/tmp/paxos66-demo
mkdir -p "$PAXOS_DIR"
```

Terminal A:

```sh
HOST=127.0.0.1 PORT=3068 REPLICA_ID=a DB_PATH="$PAXOS_DIR/a.sqlite" \
  node lessons/66-single-decree-paxos/acceptor.mts
```

Terminal B:

```sh
HOST=127.0.0.1 PORT=3069 REPLICA_ID=b DB_PATH="$PAXOS_DIR/b.sqlite" \
  node lessons/66-single-decree-paxos/acceptor.mts
```

Terminal C:

```sh
HOST=127.0.0.1 PORT=3070 REPLICA_ID=c DB_PATH="$PAXOS_DIR/c.sqlite" \
  node lessons/66-single-decree-paxos/acceptor.mts
```

Terminal proposer:

```sh
HOST=127.0.0.1 PORT=3071 DB_PATH="$PAXOS_DIR/proposer.sqlite" \
  A_ORIGIN=http://127.0.0.1:3068 B_ORIGIN=http://127.0.0.1:3069 \
  C_ORIGIN=http://127.0.0.1:3070 \
  node lessons/66-single-decree-paxos/proposer.mts
```

`HOST/PORT` điều khiển listener; `PORT=0` chọn cổng ephemeral và in một dòng readiness JSON `{service,port}`. Mỗi service phải có `DB_PATH` riêng, khác `:memory:`; thư mục cha phải tồn tại. Giữ nguyên file và cổng khi restart. Proposer lưu cả ánh xạ **id → origin** đã chuẩn hóa trong DB; đổi cổng, tráo id hoặc dùng DB acceptor làm DB proposer sẽ làm startup thất bại trước listen. `REPLICA_ID` cũng được lưu bền và không thể đổi khi tái sử dụng DB.

Ba origin phải khác nhau sau chuẩn hóa, là HTTP origin `127.0.0.1`, không có tài khoản, path, query hoặc fragment. Không có URL do request của người gọi cung cấp. Đây là topology cố định; không hỗ trợ thay thành viên hoặc discovery. Entrypoint chỉ chạy khi gọi trực tiếp, import không mở DB/listener hay đọc cấu hình.

## Thử một quyết định có acceptor hỏng

Dừng C bằng Ctrl-C, giữ A, B và proposer hoạt động:

```sh
curl -sS http://127.0.0.1:3071/propose -H 'content-type: application/json' \
  -d '{"ballot":1,"value":"red"}'
```

Kết quả: `{"ballot":1,"requested":"red","value":"red","phase":"chosen"}`. Khởi động lại C và proposer bằng đúng lệnh cũ, rồi:

```sh
curl -sS http://127.0.0.1:3071/propose -H 'content-type: application/json' \
  -d '{"ballot":2,"value":"blue"}'
curl -sS http://127.0.0.1:3071/attempts/2
curl -sS http://127.0.0.1:3070/state
```

Ballot 2 có `requested:"blue"`, nhưng `value:"red"`. C cũng chấp nhận red. Khởi động lại B và gửi prepare ballot 1: promise 2 vẫn tồn tại, nên `ok:false`.

```sh
curl -sS http://127.0.0.1:3069/prepare -H 'content-type: application/json' -d '{"ballot":1}'
```

Dừng B và C, đề xuất ballot 3 blue: nhận **502**, còn `/attempts/3` vẫn lưu `{ballot:3,requested:"blue",value:null,phase:"preparing"}`. Không có kết luận abort. Khôi phục B và C rồi retry **cùng tuple** để tiếp tục; không đổi giá trị yêu cầu của ballot đã tồn tại. Gọi lại một ballot đã chosen trả đúng receipt cũ, không truy cập acceptor. Mỗi lệnh HTTP bên trên là một bước tường minh; không có vòng lặp gửi HTTP ngầm.

## Hợp đồng HTTP

Body request phải là JSON object với **đúng** các field mô tả; không nhận null, array, primitive, field thừa hay ép kiểu chuỗi thành số. Ballot là safe integer `1..16`, value chỉ `red|blue`. Body quá 8192 byte, JSON lỗi hoặc media type sai cũng được chuẩn hóa thành **400 `invalid_body`**. Error envelope là `{error:{code,message}}`, trong đó `message` bằng `code`. Route không tồn tại trả 404 `not_found`.

| Service / route | Request | Response |
| --- | --- | --- |
| Acceptor `GET /state` | Không body | 200 `{id,promised,accepted}`; promised `0..16`, accepted `null` hoặc `{ballot,value}` |
| Acceptor `POST /prepare` | `{ballot}` | 200 `{id,ballot,promised,ok,accepted}` |
| Acceptor `POST /accept` | `{ballot,value}` | 200 cùng schema; khác value ở ballot đang accepted trả 409 `ballot_conflict` |
| Proposer `POST /propose` | `{ballot,value}` | 200 `{ballot,requested,value,phase:"chosen"}` khi có hai acceptance hợp lệ |
| Proposer `GET /attempts/{ballot}` | Path canonical `1..16` | 200 `{ballot,requested,value,phase}`; chưa có trả 404 `unknown_ballot`, path ballot sai trả 400 `invalid_body` |

Prepare với `ballot >= promised` ghi promise nguyên tử, rồi trả `ok:true`. Prepare thấp hơn trả `ok:false`, không đổi state. Accept ghi đồng thời promise và accepted nếu ballot đủ lớn; lặp cùng ballot/value là idempotent. Thay value tại cùng accepted ballot trả 409 và giữ nguyên toàn bộ state. Accept thấp hơn promise trả `ok:false`; nếu đó cũng là tuple xung đột với accepted hiện tại thì ưu tiên 409. Accepted ballot không bao giờ vượt promise.

Proposer ghi **original requested** bất biến cho mỗi ballot. Thay request cùng ballot trả **409 `ballot_conflict`**, kể cả lúc đang chạy. Có một proposal đang thực thi thì proposal khác/cùng tuple trả **503 `busy`**; không tạo attempt mới cho request bị busy. Không đủ quorum hoặc kết quả không chắc chắn trả **502 `upstream_failure`**, bao gồm hết deadline. Không chuyển attempt sang aborted và không xóa adopted value.

Attempt bắt đầu ở `preparing,value:null`; sau quorum promise chuyển bền sang `accepting,value:red|blue`; sau hai acceptance xác thực chuyển `chosen`. Nếu retry một attempt đã accepting, proposer chỉ gửi lại cùng adopted value ở phase accept; không chạy lại prepare để đổi giá trị của ballot. Nếu promise đã bị ballot lớn hơn vượt qua, retry này có thể không tiến triển; operator cần ballot mới.

## Đường đi và dữ liệu lưu bền

```text
client -- {ballot,requested} --> proposer / private SQLite (tối đa 16 attempt)
                               |
                               +-- prepare a --> prepare b --> prepare c
                               |     cần >=2 promise đúng identity/ballot/schema
                               |     chọn accepted có ballot lớn nhất trong tập promise đó
                               |     không có accepted: dùng requested
                               |
                               +-- COMMIT adopted value / phase accepting
                               |
                               +-- accept a --> accept b --> accept c
                                     cần >=2 acceptance khớp ballot VÀ adopted value
                                     COMMIT phase chosen --> receipt 200
```

Mỗi lần thử đi theo thứ tự cố định `a,b,c` ở mỗi phase. Một id chỉ đếm một lần tại origin gắn với nó: B tự nhận là A không trở thành phiếu thứ hai của A. Promise cũ, boolean sai kiểu, accepted vượt promise, acceptance sai màu hoặc envelope sai field không được tính. Nếu hai promise khai báo cùng accepted ballot nhưng khác màu, cả lần thử thất bại trước accept. Không dùng `status:200` thay cho kiểm tra runtime.

Chỉ 409 với envelope đúng `{error:{code:"ballot_conflict",message:"ballot_conflict"}}` được nhận diện là conflict của acceptor; nó không phải phiếu và cũng không được chuyển nguyên status cho client. JSON primitive, array, lỗi nội bộ có hình dạng tương tự và status không thuộc hợp đồng đều không tạo phiếu. Mọi body upstream, kể cả lỗi, được đọc hết với giới hạn **8192 wire byte**, kiểm tra media type rồi parse thành `unknown`. JSON escape nhiều lần vẫn được tính theo byte trên đường truyền. Redirect bị chặn bằng `redirect:'error'`.

Một AbortController và một mốc thời gian monotonic bao trùm **toàn bộ 500ms** của cả hai phase, bao gồm connect, headers và đọc hết body. Không cấp thêm 500ms ở hop tiếp theo. Body gửi đủ nội dung JSON nhưng không kết thúc HTTP vẫn có thể timeout. Mất kết nối sau khi acceptor COMMIT có nghĩa là proposer **không biết** kết quả; 502 không chứng minh giá trị chưa chosen.

`store.mts` dùng SQLite transaction `BEGIN IMMEDIATE`, WAL và `synchronous=FULL`. Promise/acceptance COMMIT trước khi trả reply; adoption COMMIT trước **bất kỳ** accept request. Acceptor chỉ giữ **một** state record; proposer giữ tối đa 16 record theo ballot, không có history vô hạn. DB identity ngăn tái sử dụng nhầm vai trò/topology. Unit dùng SQLite in-memory để chạy nhanh, integration dùng file riêng và restart tiến trình để chứng minh tính bền.

## Vì sao giữ an toàn?

Trong tập ba acceptor, hai majority bất kỳ đều giao nhau. Nếu red đã được hai acceptor chấp nhận ở ballot 1, quorum promise của ballot 2 phải gặp ít nhất một thành viên thuộc quorum đó. Thành viên đã promise ballot 2 không thể nhận accept thấp hơn nữa. Proposer nhận báo cáo accepted, chọn màu của accepted ballot cao nhất trong quorum; quy tắc này duy trì cùng giá trị qua các ballot tiếp theo. Ví dụ A hỏng, B báo accepted `(1,red)`, C chưa có accepted: ballot 2 phải tiếp nhận red dù caller yêu cầu blue.

**Accepted không đồng nghĩa chosen.** Ngay cả một accepted chưa đạt majority cũng có thể được tiếp nhận để giữ an toàn khi proposer không biết những acceptance khác có tồn tại hay không. Ngược lại, hai acceptor đã COMMIT nhưng reply thứ hai mất thì giá trị thực tế có thể đã chosen, trong khi proposer vẫn ở accepting. Retry cùng adopted value và việc giữ attempt giúp xử lý điều không chắc chắn đó.

**Safety** là không có hai màu khác nhau được chosen cho slot này. **Liveness** là cuối cùng có thể hoàn thành. Majority mất, mạng chậm hoặc ballot cạnh tranh có thể ngăn liveness mà không làm mất safety. Cách gửi tuần tự và chờ cả ba peer ở đây làm peer chậm có thể tiêu hết ngân sách, dù hai peer khác khỏe. Đây là đánh đổi để nhìn rõ thứ tự giao thức; không tuyên bố chịu được mọi lịch lỗi hay tối ưu latency.

Operator phải cấp **ballot duy nhất**, không cho hai proposer độc lập sở hữu cùng số với các giá trị khác nhau, và không chạy nhiều tiến trình dùng chung DB proposer. Promise không phải bằng chứng danh tính mật mã; contract validation không chống Byzantine. Mô hình giả định operator tin cậy, acceptor không nói dối, dừng/hỏng rồi phục hồi bằng đúng durable storage; không mất/rollback/copy DB đang hoạt động. SQLite FULL phụ thuộc vào storage thực hiện đúng fsync. Không có authentication, membership change, leader election, ballot allocation phân tán hay phục hồi sau mất đĩa.

Đây là **single-decree Paxos**: chỉ một slot và một quyết định; không phải log có nhiều lệnh. Multi-Paxos cần nhiều slot cùng các quy tắc quản lý leader, tiến độ, catch-up và compaction. Khác bài 2PC, các acceptor không giữ reservation nghiệp vụ chờ commit/abort; Paxos chọn một giá trị nhờ majority và vẫn có thể quyết định khi một acceptor dừng. Bài này không thay thế thư viện consensus production, cũng không biến transaction nhiều service thành atomic chỉ bằng một màu đã chosen. Ballot 16 là giới hạn kết thúc demo; không quay vòng về 1 trên cùng state.

## Kiểm chứng

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/66-single-decree-paxos/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-name-pattern=integration: lessons/66-single-decree-paxos/test/lesson.test.mts
npm run check
make test
git diff --check
```

Test unit đầu tiên kiểm tra `(1,red)` ở A,B, A mất liên lạc, rồi quorum B,C của ballot 2 vẫn chọn red với requested blue. Các unit còn lại kiểm tra promise qua tái dựng store, immutable ballot, một acceptance không đủ, identity, schema chính xác, tie xung đột, mất reply, replay, adoption ghi trước send và deadline với clock logic.

Integration spawn ba acceptor thật cùng proposer, cổng ephemeral, DB dưới `node:os.tmpdir()`, không listener khi import. Fixture đối kháng là một tiến trình riêng mở ba origin và một sink loopback khác để giảm số process. Nó có control tường minh, counter cộng dồn, chế độ mất reply **sau** acceptance, body không kết thúc, delayed responses, JSON escape, oversize JSON vẫn đúng schema, foreign identity, lỗi có code ngoài hợp đồng và redirect. Test kiểm tra sink hoạt động qua `/health`, rồi đọc counter ngay sau redirect **trước** khi đổi mode: counter phải bằng 0. Mỗi acquisition được đưa vào vùng cleanup trước acquisition tiếp theo; startup thất bại cũng phải đóng tài nguyên. Fixture chỉ phục vụ test, không phải entrypoint vận hành.

Worker không có mạng chỉ chạy typecheck và unit; integration, `npm run check`/`make test` cần môi trường cho phép loopback và do controller chạy. Không xem việc viết integration test là bằng chứng nó đã pass.

## Bài tập

1. Chạy ballot 1 chỉ được A chấp nhận rồi mất reply. Vì sao ballot 2 có thể chọn red dù ballot 1 chưa được biết là chosen? Thử các quorum AB, AC, BC.
2. Cho B promise 8, restart B rồi accept 7. Quan sát response và giải thích vì sao promise không được chỉ lưu trong RAM.
3. Dừng hai acceptor sau adoption; đọc attempt, restart proposer và retry cùng ballot. Phân biệt durable intent, acceptance thực tế và kiến thức của proposer.
4. Thiết kế cách gửi song song để majority nhanh có thể tiến triển khi peer thứ ba chậm. Xác định chính xác tập promise làm quorum, điều kiện hủy I/O và thời điểm ghi adoption; giữ các kiểm tra identity/deadline.
5. Nếu mở rộng thành nhiều slot, dữ liệu nào phải thêm slot id? Vì sao chỉ đổi giới hạn ballot thành số lớn không tạo ra Multi-Paxos?

Nguồn chính: Leslie Lamport, [Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf). Đọc các phần về chọn proposal và nhận proposal; lời giải thích, ví dụ và mã trong bài là nội dung riêng của repository.
