# 64 — Merkle anti-entropy: bỏ qua nhánh giống nhau, sửa snapshot có revision

Hai store có cùng tám slot nhưng mất đồng bộ ở một vài giá trị. Có cần đọc lại cả tám record? Bài này xây một cây Merkle cố định, tìm các lá khác nhau, rồi áp dụng **một patch nguyên tử** từ source sang target. Ví dụ source có `k5="null"`, target có `k5=null`: chúng khác nhau, dù nhìn trên màn hình khá giống.

Đây là repair **một chiều, source có thẩm quyền** cho một snapshot hữu hạn. Nó có thể ghi đè một giá trị mới hơn về mặt nghiệp vụ ở target. Không phải giải quyết xung đột hai chiều, proof chống đối thủ, hay implementation tương thích Dynamo. Dữ liệu chỉ là token hư cấu; không có tài khoản, credential, mạng ngoài hay tích hợp thật.

## Kiến trúc và điều kiện tiên quyết

```text
source: store.mts + a.sqlite       target: store.mts + b.sqlite
              ↑ GET root/node/record        ↑ GET root/node, POST apply
              └──────── repair.mts ─────────┘
                           ↑ POST /repair {}
```

Node **24.12+** (bài kiểm tra dùng Node 24), npm và dev dependencies đã pin ở root. Runtime chỉ dùng built-in Node: HTTP, crypto, SQLite, fetch. Mỗi store là process riêng, DB riêng, `REPLICA_ID` riêng. Không dùng chung DB, không chạy hai writer trên cùng một file; cấu hình nhầm identity trên DB đã tồn tại làm startup thất bại trước khi listen, không đổi state đã lưu.

Cả tám key `k0..k7` luôn tồn tại, ban đầu `null`. Value là `null` hoặc chuỗi **1..16** ký tự `[A-Za-z0-9_-]`. `null` là dữ liệu đã commit, không phải lệnh xóa slot. Revision local bắt đầu **0**, tăng tối đa **32** trong suốt đời DB. Không reset revision, không xóa key để tái sử dụng budget. Đây là các giới hạn giảng dạy, không phải thông số khuyến nghị cho hệ thống thật.

## Chạy native và playground

Chạy từ root repository:

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/64-merkle-anti-entropy/test/lesson.test.mts
npm run test:unit
# Chỉ chạy ở môi trường cho phép HTTP loopback:
node --test --test-name-pattern=integration: lessons/64-merkle-anti-entropy/test/lesson.test.mts
```

Full checks của repository: `npm run check`, `make test`, `git diff --check`. Worker không có mạng chỉ chạy typecheck/unit; outer controller chạy integration trong Docker biệt lập. Test chưa chạy không được tính là pass.

Khởi động source, target, rồi repair trong ba terminal, dùng **hai đường dẫn DB thí nghiệm mới và khác nhau**. Mỗi service in JSON readiness `{service,port}`. `PORT=0` yêu cầu hệ điều hành cấp port ephemeral; thay ví dụ 41001/41002 bằng port thực trước khi chạy lệnh thứ ba:

```bash
HOST=127.0.0.1 PORT=0 REPLICA_ID=alpha DB_PATH=/tmp/merkle-alpha.sqlite TEACHING_CONTROLS=1 node lessons/64-merkle-anti-entropy/store.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=beta DB_PATH=/tmp/merkle-beta.sqlite TEACHING_CONTROLS=1 node lessons/64-merkle-anti-entropy/store.mts
HOST=127.0.0.1 PORT=0 SOURCE_ORIGIN=http://127.0.0.1:41001 TARGET_ORIGIN=http://127.0.0.1:41002 node lessons/64-merkle-anti-entropy/repair.mts
```

`REPLICA_ID` là token 1..16 ký tự cùng bảng chữ cái value. Cấu hình hai HTTP origin cố định được chuẩn hóa bằng URL; từ chối hai origin giống nhau sau chuẩn hóa, credentials, path khác `/`, query hoặc fragment. Caller không cung cấp origin hoặc redirect destination trong body. Chỉ cấu hình những process thí nghiệm đáng tin cậy. Không có xác thực hay phân quyền: bind loopback và không công khai API này.

Nếu repair in port 41003, dùng các port thực tương ứng:

```bash
curl -sS -H 'content-type: application/json' -d '{"key":"k5","value":"null"}' http://127.0.0.1:41001/write
curl -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:41003/repair
curl -sS 'http://127.0.0.1:41002/record?key=k5&revision=1'
curl -sS http://127.0.0.1:41001/teaching/stats
curl -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:41003/repair
```

Lần repair đầu trả `{changed:["k5"],sourceRevision:1,targetRevision:1}`. Source nhận 4 node request (các path `""`, `1`, `10`, `101`) và đúng 1 record request cho `k5`. Target cũng nhận 4 node request, không nhận record request, nhận 1 apply. Lần repair sau chỉ đọc hai root và trả `changed:[]`; không tăng revision hoặc apply counter.

Dừng bằng Ctrl-C, restart với cùng DB/identity để thấy giá trị, revision và hash tồn tại. Sau thí nghiệm mới dọn đúng DB của mình khi các process đã dừng. Các tên cấu hình ở trên an toàn cho playground; không đặt biến bắt đầu `NODE_`, `LD_`, `DYLD_`.

## Canonical bytes và cây depth 3

Thứ tự lá cố định `k0..k7`; đường đi binary `000..111`, trái `0`, phải `1`. Cây có 8 lá và 7 internal node. Helpers hash là hàm thuần; không đọc clock, DB, config hoặc mở listener.

```text
leaf = SHA256( byte(0) || UTF8(JSON.stringify([key,value])) )
node = SHA256( byte(1) || decodedHex(left) || decodedHex(right) )
```

Hash là **64 ký tự hex lowercase**. Internal input chứa đúng 32 byte trái + 32 byte phải, không nối hai chuỗi hex UTF-8. Prefix 0/1 tách domain lá và internal node; key trong lá ngăn đổi vị trí slot mà giữ nguyên leaf hash. JSON tuple có thứ tự cố định và phân biệt `null` với `"null"`; không hash trực tiếp object với thứ tự property tùy ý.

Golden độc lập:

| Trường hợp | SHA-256 |
| --- | --- |
| `k5,null` | `30852e04832f48d4833542a8be30c295384c247d41155c63b74fa11fd36f995f` |
| `k5,"null"` | `fe15432d8e871959a32f60e5ef12b08d5870af57e24fb607496d9c13be96fc85` |
| Root của tám `null` | `c3f85e1c1f500145fe1cf7654af3bad5b9864bec7ed2824285a07ec5ca07be8a` |

Nếu hash bằng nhau, thuật toán bỏ qua toàn bộ subtree, dựa vào giả định SHA-256 không collision trong thí nghiệm. Hash khác nhau bắt buộc nội dung canonical khác nhau; hash bằng nhau không phải chứng minh toán học rằng dữ liệu giống nhau. Hai store độc hại thông đồng hoặc một source nói dối không bị mô hình này ngăn chặn: việc kiểm tra composition và commitment phát hiện reply sai tương quan, không xác thực root đến từ một authority độc lập.

## Hợp đồng store

Object phải có **đúng field**; array, null, primitive và sai kiểu bị từ chối. Public JSON/schema/query lỗi trả **400** `invalid_request` (bao gồm malformed JSON, sai content-type, body quá 8192 byte). Query không được thiếu/thừa/trùng key. Revision query dùng số thập phân canonical `0..32`, không có leading zero. Route lạ **404**; method sai trên route đã biết **405** với `Allow`.

| Route | Request và 200 response |
| --- | --- |
| `POST /write` | `{key,value}` → `{revision}`. Nếu value thay đổi, commit và tăng revision đúng một lần; identical write không tăng. |
| `GET /root` | Không query → `{revision,hash}`. |
| `GET /node?path=&revision=0` | Path 0..3 bit; root dùng chuỗi rỗng. `{revision,path,hash,children}`. Nonleaf: `children:{left,right}`; lá: `children:null`. |
| `GET /record?key=k5&revision=1` | `{revision,key,value,hash}` với hash lá tương ứng. |
| `POST /apply` | `{expectedRevision,records:[{key,value}]}` → `{revision}`. Tối đa 8 key, unique và tăng dần; patch rỗng hợp lệ. |

`/node` và `/record` so revision với state hiện tại; khác thì **409** chính xác `{error:{code:"revision_changed",message:"Revision changed"}}`. Bài không lưu lịch sử MVCC hoặc phục vụ revision đã cũ.

`/apply` kiểm tra envelope/kiểu expectedRevision rồi, **trong transaction**, so revision trước khi validate records. Expected revision cũ trả 409 kể cả records không hợp lệ. Revision khớp thì validate **toàn patch** trước khi sửa state. Nhiều key đổi vẫn chỉ tăng revision một lần. Lỗi bất kỳ rollback toàn bộ. SQLite `BEGIN IMMEDIATE` bảo vệ compare-and-apply khỏi ghi cạnh tranh.

Ở revision 32, no-op `/write`, patch rỗng và patch identical vẫn 200/32. Thay đổi thật trả **429** chính xác `{error:{code:"revision_limit",message:"Revision limit reached"}}`, không đổi giá trị hay revision. Không sửa một phần patch rồi mới báo hết budget.

`GET /teaching/stats` chỉ bật khi `TEACHING_CONTROLS=1`: 200 `{root,node,record,apply}` đếm request tới từng route; không đổi state hoặc reset counter. Khi tắt trả 404. Fixture test có thêm `/teaching/mode {mode}` với whitelist chuỗi và stats mở rộng; không dùng fixture như store thật. Sai kiểu như `{mode:{toString:null}}` trả 400, không ép object thành chuỗi.

## Hợp đồng repair và validate trước apply

`POST /repair {}` là route duy nhất. Thành công 200 `{changed,sourceRevision,targetRevision}`; changed sort theo key. Không nhận field thừa, không nhận caller URL. Không có retry tự động, polling, repair nền hoặc khóa distributed.

1. Đọc root source rồi target, validate đầy đủ revision và hash. Root bằng nhau trả report ngay, dù hai revision khác nhau.
2. Root khác: duyệt trái trước, chỉ thăm các path hash khác. Mỗi node request mang revision đã pin của store đó. Reply phải đúng path/revision, hash đúng commitment parent. Nonleaf phải có hai child hash canonical và composition đúng. Lá phải có children null.
3. Ở mỗi lá khác, chỉ fetch record **source**. Validate đúng key, revision, value và leaf hash; hash phải bằng commitment đã duyệt. Không đọc record target.
4. Sau khi toàn plan hợp lệ, POST **đúng một** `/apply` với original target revision. Apply 200 phải trả revision target cũ +1. Lá khác và giả định không collision bảo đảm đây là modification thật. Response cuối có revision target vừa nhận.

Đổi source giữa các lần đọc gây 409 ở lần đọc tiếp theo; bỏ plan, không apply. Target đổi giữa planning và apply gây 409, giữ nguyên concurrent write. Một record sai ở lá cuối cũng ngăn **mọi** apply, dù các lá đầu đã validate.

Repair chỉ giữ status **409** từ `/node`, `/record`, `/apply` khi envelope đúng cả code/message `revision_changed`. Chỉ giữ **429** từ `/apply` khi đúng code/message `revision_limit`. Không suy diễn ý nghĩa nghiệp vụ từ HTTP status: `internal_error` với cùng message, primitive, array, field thừa hoặc envelope sai đều thành **502**. `/root` không có contract 409 nên ngay cả một envelope revision_changed ở đó cũng thành 502.

Mọi status/schema/hash/revision sai khác, JSON/UTF-8 lỗi, transport, redirect, chậm hoặc body quá budget trả **502** `{error:{code:"bad_upstream",message:"Invalid or unavailable upstream"}}`. Full-body response mỗi hop tối đa **4096 byte**, kiểm tra cả Content-Length lẫn byte stream. Budget đủ cho tối đa `\uXXXX` của mọi JSON string token hợp lệ của từng schema, kể cả tên field/hash. Oversize test thêm whitespace vào JSON còn nguyên schema/identity; không làm sai `null`, number, boolean để giả vờ kiểm tra byte gate. Patch gửi ra hữu hạn bởi tối đa 8 record và giới hạn value.

Có **một deadline tuyệt đối 1000 ms** từ khi bắt đầu repair network work: bao gồm mọi header, hop, full body và apply reply. Không cấp thêm 1000 ms mỗi hop. `redirect:'error'` ngăn GET hoặc patch POST đi tiếp sang origin khác. Test dùng một đích loopback khác thật sự reachable và kiểm tra counter đích trước khi thay mode; 502 đơn độc không chứng minh không rò payload.

## Revision bảo đảm gì, và không bảo đảm gì?

Pinning xác định một snapshot lịch sử đã quan sát, rồi kiểm tra rằng mỗi phần đọc thuộc revision ấy. Không cần so revision source bằng revision target: chúng là counter local độc lập. Không có cam kết source vẫn đứng yên **sau lần đọc source cuối cùng**; nó có thể đổi ngay trước hoặc sau target commit. Report mô tả lần sửa snapshot này, không bảo đảm hai store luôn bằng nhau trong tương lai.

Tương tự, bằng root ở hai lần đọc riêng biệt không phải distributed atomic read. Store có thể chuyển động sau reply. Giá trị có thể đổi A→B→A cho cùng root nội dung, trong khi revision vẫn tăng; bài không dùng hash để phát hiện lịch sử thay đổi. Collision có thể tạo false equality. Revision không reset giúp tránh ABA của **revision** trong vòng đời DB, nhưng không thay thế transaction hai DB.

Nếu apply commit rồi reply mất, repair trả 502 và **commit không chắc chắn đối với caller**. Test `lost-apply` xác nhận target đã đổi dù report lỗi. Không tự retry trong cùng request. Operator có thể chủ động chạy một repair mới để quan sát state hiện tại; không tuyên bố lần trước rollback chỉ vì thấy 502.

Về chi phí: bằng root cần 2 HTTP read và không record read. Một lá khác cần 8 node read (4 path ×2 store), 1 source record và 1 apply, cộng hai root. Tất cả lá khác cần 30 node read, 8 record read và 1 apply: với chỉ 8 slot, đọc toàn snapshot thường rẻ hơn. Bài ưu tiên thấy rõ pruning và validation; không tuyên bố tối ưu latency. Recompute cây 15 node mỗi store read làm CPU đổi lấy code đơn giản. Hệ lớn thường cache hash, chia range, batch proof hoặc lưu snapshot; các lựa chọn ấy cần cơ chế invalidation và nhất quán riêng.

## Kiểm chứng và bài tập

Test unit đầu tiên dùng golden digest độc lập và k5 là khác biệt duy nhất, kiểm tra skip subtree, thứ tự request, source-only record và một apply. Unit khác kiểm tra all-different/equal roots, revision stale hai phía, race target, lỗi lá muộn, parent commitment, composition, schema/status, max32/no-op, rollback và import im lặng với cấu hình runtime cố ý sai. Không có config read, SQLite open, listener, signal registration hoặc công việc nền ở import.

HTTP tests chạy store/repair process độc lập, loopback ephemeral, DB trong `node:os tmpdir()` để dùng được với source mount read-only. Cleanup bảo vệ acquisition tiếp theo và startup thất bại; fixtures được tái sử dụng qua nhiều fault mode. Counter chứng minh pruning; restart và identity mismatch kiểm tra persistence. Các ca byte/deadline/redirect không dựa riêng vào status code.

1. Cho source và target khác revision nhưng cùng values. Dự đoán request counters và giải thích tại sao không cần apply.
2. Đổi hai lá ở hai nửa cây. Đếm số node/record request trước khi chạy; so với đọc tám record thẳng.
3. Thử patch chứa key đầu hợp lệ và key cuối sai value. Kiểm tra root/revision trước và sau; vì sao transaction vẫn cần dù đã validate patch?
4. Cho target có một giá trị quan trọng hơn source về mặt nghiệp vụ. Vì sao source-authoritative repair vẫn ghi đè nó? Phác thảo metadata cần có cho conflict resolution, rồi chỉ ra phần nào không thể suy ra chỉ từ hash.
5. Thiết kế một bản mở rộng lưu history theo revision. Khi nào được garbage-collect history nếu repair có thể đang chạy? Chỉ nêu thiết kế, không bỏ guard hiện tại.

Nguồn chính: DeCandia và cộng sự, [Dynamo: Amazon’s Highly Available Key-value Store (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), đặc biệt phần anti-entropy bằng Merkle tree. Bài này tự xây mô hình tám slot có revision, không triển khai consistent hashing, vector clocks, sloppy quorum hay protocol của Dynamo. Native API tham khảo: [Node.js SQLite](https://nodejs.org/api/sqlite.html) và [Crypto](https://nodejs.org/api/crypto.html).
