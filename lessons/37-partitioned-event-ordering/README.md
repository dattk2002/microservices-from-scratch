# 37 — Thứ tự sự kiện theo partition và checkpoint không vượt qua khoảng trống

Một cập nhật tồn kho đến muộn không được phép làm consumer bỏ qua cập nhật trước nó. Bài này xây một nhật ký HTTP nhỏ bằng SQLite và hai consumer độc lập: mỗi consumer có projection, receipt và ba checkpoint trong database riêng. Đây là mô hình giảng dạy về ordering, không dùng broker package và không mô phỏng đầy đủ Kafka.

Cần biết HTTP, idempotency, transaction SQLite và projection (bài 03, 05, 15, 25). Dùng Node.js **24.12+ thuộc nhánh 24**, npm và các development dependency đã pin ở root; runtime chỉ dùng built-in. Không cần Docker cho chạy tay, tài khoản hay dịch vụ bên ngoài. Những giới hạn nhỏ là chủ ý để quan sát được trạng thái hữu hạn.

## Chạy bằng các tiến trình riêng

Từ root repository, mở ba terminal. Tạo database trong thư mục tạm; không dùng chung file database giữa broker và consumer, hoặc giữa hai consumer:

```sh
HOST=127.0.0.1 PORT=3037 DB_PATH=/tmp/lesson37-broker.sqlite \
  node lessons/37-partitioned-event-ordering/broker.mts
```

```sh
HOST=127.0.0.1 PORT=4037 DB_PATH=/tmp/lesson37-consumer-a.sqlite \
  BROKER_ORIGIN=http://127.0.0.1:3037 \
  node lessons/37-partitioned-event-ordering/consumer.mts
```

```sh
HOST=127.0.0.1 PORT=4038 DB_PATH=/tmp/lesson37-consumer-b.sqlite \
  BROKER_ORIGIN=http://127.0.0.1:3037 \
  node lessons/37-partitioned-event-ordering/consumer.mts
```

Chọn file mới nếu muốn bắt đầu lại; khởi động lại với file cũ để kiểm tra durability. `HOST=127.0.0.1 PORT=0` được hỗ trợ: mỗi server in đúng một dòng JSON readiness chứa `service` và cổng thực tế `port`. Playground có thể cấp port riêng cho hai entrypoint, đặt `DB_PATH` riêng và nối `BROKER_ORIGIN` tới broker. Không có poll nền; bấm/gửi `/poll` để tiến thêm một batch. Không cần teaching-control route trong ứng dụng này.

Ví dụ chạy tay (mỗi `curl` có deadline):

```sh
curl --max-time 3 -sS http://127.0.0.1:3037/events \
  -H 'content-type: application/json' -d '{"id":"stock-1","key":"c","delta":2}'
curl --max-time 3 -sS http://127.0.0.1:3037/events \
  -H 'content-type: application/json' -d '{"id":"stock-2","key":"c","delta":3}'
# Cố ý gửi offset 2 trước: nhận 409, expected=1, chưa có số dư.
curl --max-time 3 -sS http://127.0.0.1:4037/deliver \
  -H 'content-type: application/json' \
  -d '{"id":"stock-2","key":"c","delta":3,"partition":0,"offset":2}'
curl --max-time 3 -sS http://127.0.0.1:4037/poll \
  -H 'content-type: application/json' -d '{"partition":0}'
curl --max-time 3 -sS http://127.0.0.1:4037/state
curl --max-time 3 -sS http://127.0.0.1:4038/state
```

Consumer A có `checkpoints:[2,0,0]`, `balances:{"c":5}`; B vẫn `[0,0,0]` và `{}`. Gửi `/poll` partition 0 tới B để B tự đọc từ đầu. Gửi lại `stock-1` với `delta:2` tới broker trả offset 1 ban đầu; đổi thành `delta:9` nhận 409. Sau đó gửi key `a`: nó thuộc partition 1, có offset 1 riêng dù partition 0 đã đi xa hơn.

## Kiến trúc và invariant

```text
producer -- POST /events --> broker.sqlite: keys + events
                                   |
                   GET /events?partition=P&after=N&limit=8
                                   |
                  +----------------+---------------+
                  v                                v
             consumer A                       consumer B
          a.sqlite transaction             b.sqlite transaction
       receipt + balance + checkpoint   receipt + balance + checkpoint
```

`model.mts` chứa routing thuần, quyết định next/old/gap và hai store SQLite; `broker.mts`, `consumer.mts` là HTTP entrypoint; `runtime.mts` giới hạn admission/body. Test fixture `test/upstream.mts` chỉ phục vụ kiểm thử. Import tất cả entrypoint không đọc cấu hình, mở database, đăng ký signal, chạy nền hoặc listen. Tất cả nằm trong `main()` với guard `import.meta.main`.

Routing duyệt từng ký tự ASCII: bắt đầu `h=0`, cập nhật `h=(31*h+code)%3`. Số partition cố định là 3; ví dụ `c→0`, `a→1`, `b→2`, `ab→0`. Đây là hàm đơn giản, xác định; không hứa phân bố đều hay chống key được chọn để gây tải lệch. Broker gán offset 1..32 liên tục **trong từng partition**, trong transaction `BEGIN IMMEDIATE`. Không có thứ tự toàn cục giữa partition 0 và 1. Các key khác nhau cùng partition vẫn chia sẻ một dãy offset.

Consumer chỉ chấp nhận offset bằng `checkpoint+1`. Gap trả 409 với `error.expected` và không ghi gì; không tạo buffer chờ vô hạn. Offset cũ chỉ thành công khi receipt tại chính `(partition,offset)` khớp cả id, key, delta, partition và offset. Id đã có ở vị trí khác hoặc payload bị sửa trả 409. Consumer tự tính lại partition từ key. `/deliver` là ranh giới tin cậy của bài học: nó kiểm tra hợp đồng và tính nhất quán, nhưng không xác thực chữ ký hay đối chiếu trực tiếp với broker; chỉ nên dùng trong môi trường local.

Một transaction ghi receipt, cộng balance và tiến checkpoint. Batch `/poll` cũng là **một transaction**: dù phần tử cuối bị trùng id, sai balance hoặc đầy key, mọi thay đổi đầu batch đều rollback. SQLite dùng WAL và `synchronous=FULL`; shutdown bình thường đóng database. Tiến trình restart đọc lại các bảng, không reset offset. Đây là durability theo bảo đảm của SQLite/filesystem, không phải replication hay chứng minh chống mọi sự cố phần cứng. Mỗi service nên có một tiến trình sở hữu file DB; bài không cung cấp giao thức chia sẻ file giữa nhiều writer service.

## Hợp đồng HTTP và giới hạn

Các POST cần `content-type: application/json`. Các trường bắt buộc phải đúng primitive type; `"0"`, `false`, `null` không được ép thành partition hay delta. Thuộc tính ngoài hợp đồng không được lưu và không thay đổi danh tính event.

| Route | Request | Thành công |
| --- | --- | --- |
| Broker `POST /events` | `{id,key,delta}` | 200, event đầy đủ `{id,key,delta,partition,offset}`; retry giống hệt cũng 200 |
| Broker `GET /events` | query `partition=0..2&after=0..32&limit=1..8` | 200, `{partition,after,events:[...]}`, offset tăng dần |
| Consumer `POST /deliver` | một event đầy đủ từ broker | 200, state hiện tại; duplicate chính xác không cộng lại |
| Consumer `POST /poll` | `{partition:0..2}` | 200, `{applied,checkpoints,balances}`; tối đa 8 event mỗi lần |
| Consumer `GET /state` | không body | 200, `{checkpoints:[c0,c1,c2],balances:{key:number}}` |

`after` là exclusive; poll rỗng có `applied:0`. Không tự động drain nhiều batch, không tự retry. Query số phải là dạng thập phân nguyên không dấu, không leading zero trừ `0`. `id` dài 1..64, `key` dài 1..32, chỉ ASCII `[A-Za-z0-9_-]`; id là **toàn broker**, không phải mỗi key. `delta` là safe integer khác 0 trong `[-1000000,1000000]`. Balance sau mỗi event phải nằm trong `[-4000000,4000000]`; ngay cả batch có tổng cuối nhỏ cũng không được vượt biên ở trạng thái trung gian.

Broker giữ tối đa **16 key khác nhau toàn cục**, **32 event mỗi partition**. Consumer giữ tối đa 16 projection và 96 receipt; offset cũng chỉ 1..32. Không TTL, không eviction, không nén receipt: khi đầy, từ chối event mới bằng 409 thay vì phá idempotency hoặc làm mất lịch sử cần cho consumer chậm. Retry event cũ chính xác vẫn được nhận khi đầy. Giới hạn là theo từng database, không phối hợp quota giữa các consumer. Đây là nhật ký hữu hạn cho thực hành, không phù hợp luồng vô hạn nếu chưa có thiết kế retention/snapshot/ack an toàn.

Body vào và body upstream tối đa **8192 byte**, đọc theo chunk; không tin `content-length`. Identifier lớn nhất có thể dùng escape JSON `\uXXXX`: 96 ký tự id+key cần tối đa 576 byte. Một event với cả tên trường cũng escape sáu byte/ký tự vẫn dưới 800 byte; tám event cộng envelope dưới 6600 byte. Budget 8192 chừa chỗ cho dấu câu và whitespace thông thường. JSON có quá nhiều whitespace hoặc trường dư vẫn có thể vượt budget và bị từ chối dù đúng cú pháp. Test có identifier cực đại và batch tám event escape đầy đủ; fixture quá cỡ dùng chính batch hợp lệ đó cộng whitespace, nên chỉ byte gate gây từ chối.

| Lỗi | HTTP / code | Tác động |
| --- | --- | --- |
| Primitive, routing, query, offset ngoài biên | 400 `invalid` | không ghi |
| JSON sai / media type sai / body quá lớn | 400 / 415 / 413 | không ghi |
| Gap | 409 `gap`, `error.expected` | không ghi và không giữ hàng đợi gap |
| Offset/id cũ bị sửa hoặc id dùng lại vị trí khác | 409 `conflict` | rollback batch |
| Hết key/event/receipt hoặc vượt balance | 409 `capacity` | rollback batch |
| Admission đầy hoặc poll partition đã chạy | 503 `busy` | không xếp hàng chờ |
| Broker lỗi, redirect, reply sai hoặc hết deadline | 502 `upstream` | không áp dụng batch |
| Body đến chậm quá 1000ms hoặc quá total poll | 408 `body_deadline` | không ghi |
| Route/method không hỗ trợ | 404 `not_found` | không ghi |

Mỗi server nhận tối đa 12 handler đang hoạt động, tính cả lúc chờ body. Có tối đa một poll đang chờ broker cho mỗi partition (Set tối đa 3 phần tử), không khóa partition khác. `/deliver` vẫn chạy trong lúc poll đang chờ I/O. Nếu delivery khác tiến checkpoint trong khoảng đó, receipt/transaction quyết định duplicate hay conflict khi poll về. Không giữ transaction qua `await fetch`. Gap được quyết định ngay và giải phóng admission. SQLite đồng bộ vẫn dùng chung event loop, nên độc lập partition không có nghĩa là thực thi CPU song song.

## Poll, deadline và origin cố định

`BROKER_ORIGIN` được đọc lúc main chạy, mặc định `http://127.0.0.1:3037`; chỉ HTTP origin, không userinfo/path/query/fragment. Caller không gửi URL. Fetch dùng **`redirect:'error'`**, kể cả redirect HTTP cùng origin cũng bị từ chối; một URL cấu hình cố định không được ngầm chuyển thành origin khác.

Consumer kiểm tra status, media type, byte budget, JSON envelope đúng partition và after, array tối đa tám event, primitive/schema/routing của từng event và offset liên tục `after+1...` **trước khi ghi**. Không bỏ qua event hỏng để tiến checkpoint. Consumer vẫn kiểm tra receipt và balance trong transaction sau bước parse.

`POLL_REQUEST_MS` mặc định 400 (50..2000), áp dụng cho fetch **và toàn bộ response body**. `POLL_TOTAL_MS` mặc định 800 (50..4000), tính từ đầu xử lý route poll, gồm đọc request và chờ upstream; request body còn có deadline 1000ms riêng. Fetch lấy signal kết hợp hai deadline và kiểm tra lại trước khi apply. Chúng là deadline hợp tác của event loop, không thể ngắt một lệnh SQLite đồng bộ đang chạy; lượng công việc được giới hạn bằng batch/storage nhỏ. Không có retry ngầm. HTTP server còn đặt header/request timeout 5000ms và đóng kết nối đang mở khi shutdown.

Biến chung: `HOST` mặc định loopback, `PORT` mặc định 3037/4037 và nhận 0; `DB_PATH` mặc định `broker.sqlite`/`consumer.sqlite`. Dùng đường dẫn riêng nếu mở consumer lần hai. Không dùng tên biến thuộc `NODE_*`, `LD_*`, `DYLD_*` để cấu hình ứng dụng.

## Kiểm thử và đọc kết quả

Từ root:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/37-partitioned-event-ordering/test/lesson.test.mts
# Máy cho phép tiến trình con và HTTP loopback:
node --test --test-timeout=15000 lessons/37-partitioned-event-ordering/test/lesson.test.mts
# Kiểm tra đầy đủ theo repository, do bộ điều phối chạy trong môi trường phù hợp:
npm run check
make test
git diff --check
```

Unit dùng SQLite `:memory:`: gap không ghi, partition khác tiến, duplicate/conflict, rollback balance+receipt+checkpoint, routing, 16 key, 32 event và giữ đủ 96 receipt. Chu kỳ RED đầu tiên thật sự báo `Missing expected exception` cho gap/conflict/overflow; sau implementation các assertion qua.

Integration dùng broker và consumer là **tiến trình con riêng**, port loopback ephemeral, DB trong `node:os.tmpdir()` để source read-only vẫn chạy. Có hai consumer/cursor, restart broker và consumer, concurrency mixed-key, retention đầy, batch hỏng ở cuối, sequence/envelope sai, byte bound, body escape cực đại, redirect sang fixture độc lập và deadline cả trong lúc stream body. Fixture hold cho phép test đợi bộ đếm `entered` trước khi kiểm tra 503 và partition khác tiến; deadline đợi `aborted` để xác nhận upstream bị hủy. Không suy luận tính đồng thời chỉ từ thời gian chạy nhanh/chậm. Fixture là tiện ích test, không phải API điều khiển production.

Test import chạy child với `PORT`, `DB_PATH`, `BROKER_ORIGIN`, timeout cố ý không hợp lệ: phải thoát 0, stdout/stderr ứng dụng rỗng (tắt riêng cảnh báo ExperimentalWarning của Node/SQLite bằng cờ CLI). Startup thất bại không được tính là import inert. Tất cả process và thư mục tạm được dọn bằng `finally`; request/barrier/startup có deadline. Worker không có mạng chỉ chạy typecheck/unit; integration và toàn bộ HTTP suite cần bộ điều phối chạy trong môi trường cô lập cho phép loopback. Không suy diễn unit xanh thành integration xanh.

## Phạm vi ordering và đánh đổi

- Thứ tự chỉ theo partition. Các key cùng partition chặn nhau: một event thiếu hoặc balance sai ở offset N làm N+1 chưa đi được. Key nóng tạo hot partition; thêm consumer không tự chia nhỏ thứ tự đó. Partition khác có cursor riêng và có thể tiến.
- Checkpoint commit cùng projection trong một DB tạo hiệu ứng nguyên tử **nội bộ**. Nếu gửi email hoặc gọi payment trước commit rồi crash, retry có thể lặp side effect; gọi sau commit rồi crash có thể mất side effect. Cần transactional outbox/idempotency ở hệ đích, không gọi đó là exactly-once toàn hệ thống.
- Hai consumer là hai bản projection độc lập. Bài không có consumer group, rebalance, lease, ownership, leader election, replication hoặc failover broker. Không có protocol chuyển partition giữa worker hay offset commit từ xa.
- Đổi số partition làm thay đổi routing của key và miền offset. Không thể chỉ đổi `%3` thành `%4`: dữ liệu cũ, receipt và checkpoint sẽ không còn cùng ý nghĩa. Cần kế hoạch migration: version routing, ranh giới log/epoch, snapshot hoặc replay, và điều phối writer/consumer trong thời gian chuyển. Bài cố định ba partition để không giấu vấn đề này.
- Không auth/TLS hoặc multi-tenant isolation; giữ ví dụ trên loopback. Không eviction an toàn cho luồng vô hạn; một consumer bị kẹt cần sửa dữ liệu/nghiệp vụ có chủ đích thay vì tự skip event.

Bài tập: (1) tạo hai key khác nhau cùng partition và chứng minh gap của một key chặn key còn lại nhưng không chặn partition khác; (2) gây overflow balance ở event thứ hai của batch rồi kiểm tra receipt của event thứ nhất chưa tồn tại bằng cách deliver lại; (3) đề xuất snapshot+retention với bằng chứng consumer chậm không mất dữ liệu; (4) viết kế hoạch đổi routing version khi nâng số partition, chỉ rõ checkpoint thuộc epoch nào. Không mở rộng sang rebalance trước khi có hợp đồng ownership rõ ràng.

Tham khảo: [Apache Kafka 4.1 — Design](https://kafka.apache.org/41/design/design/) để đối chiếu phạm vi partition, consumer position và bảo đảm giao nhận của một hệ thống broker thật; [Node.js SQLite](https://nodejs.org/api/sqlite.html) và [SQLite atomic commit](https://sqlite.org/atomiccommit.html) cho ranh giới transaction/durability. Phần giải thích và mã của bài là ví dụ độc lập.
