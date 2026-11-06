# 33 — Leader lease, fencing token và chặn leader cũ ghi dữ liệu

Một job xuất danh mục chỉ nên có một worker điều phối. Nhưng worker A có thể bị
pause sau khi kiểm tra lease, rồi tiếp tục chạy khi B đã tiếp quản. Lease quyết
định ai được điều phối; fencing ở nơi ghi mới chặn được lệnh cũ đang bay trên mạng.
Bài này dùng bốn tiến trình Node độc lập, không có thư viện runtime ngoài built-in.

## Chuẩn bị và chạy kiểm thử

Cần Node **24.12+ thuộc dòng 24**, npm và các devDependencies đã cài ở root.
Đọc trước bài về HTTP contract, idempotency và optimistic concurrency. Các lệnh
sau chạy từ root repository:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/33-leader-lease-fencing/test/lesson.test.mts
node --test --test-timeout=15000 lessons/33-leader-lease-fencing/test/lesson.test.mts
npm run check
make test
git diff --check
```

Lệnh test đầy đủ mở HTTP loopback; sandbox worker chỉ chạy typecheck và unit.
Bộ điều phối bên ngoài chạy HTTP trong Docker cô lập. Test integration dùng
`node:os.tmpdir()`, cổng 0, deadline từng request và `finally` dừng children rồi
xóa database. Source có thể chỉ đọc. Không cần Internet hay Docker để chạy native
trên máy cho phép mở loopback. `node:sqlite` có thể được Node báo là experimental.

## Kiến trúc và bất biến

```text
worker alpha ── acquire/renew/release ──┐
                                      ├── coordinator ── coordinator.sqlite
worker beta  ── acquire/renew/release ──┘
     │                                      │
     └──────── write(generation,id,payload)  │ cấp generation, không gọi sink
                       │                    │
                       ▼                    │
                 fenced sink ── sink.sqlite
```

Hai worker chạy cùng `worker.mts`, khác `HOLDER`. Coordinator sở hữu duy nhất
lease có tên khái niệm **catalog-export**; API không tạo tên lease động. Sink
sở hữu sổ xuất danh mục: mỗi receipt `(id,payload)` chính là một bản ghi hiệu ứng
bền vững. `applied` là tổng số bản ghi, không phải số request. Không giả lập gửi
email hay gọi thanh toán bên ngoài transaction.

* Acquire thành công nếu `expiresAt <= now`; cấp `generation + 1`. Ngay tại
  `now === expiresAt`, renew/release đều thất bại. Acquire khi đang giữ lease cũng
  trả 409, kể cả cùng holder; dùng renew để gia hạn.
* `BEGIN IMMEDIATE` bao quanh đọc–quyết định–ghi của acquire và sink; không có
  `await` ở giữa. Renew/release dùng điều kiện holder, generation và
  `expiresAt > now` trong chính câu UPDATE. Release không đưa generation về 0.
* Sink so generation **trước** tra receipt. Thấp hơn high-water mark → 409
  `fenced`, kể cả replay id đã tồn tại. Generation bằng hoặc cao hơn có thể ghi.
* Cùng id/cùng payload → duplicate, không thêm hiệu ứng; cùng id/khác payload →
  409 `conflict`. Một replay hợp lệ với generation cao hơn vẫn nâng fence.
  Fence và receipt commit chung; conflict hoặc hết dung lượng rollback cả hai.
* Không tự xóa receipt: tối đa 128 id, id thứ 129 trả 507 `capacity`. Replay của
  id đã giữ vẫn dùng được. Đây là admission bound hữu hạn, không hứa nhận vô hạn.

**Ranh giới quan trọng:** lease hết hạn hoặc B vừa được grant generation 2
**không tự động chặn** generation 1 tại sink. Sink chỉ biết generation 2 sau một
write hợp lệ của generation đó. A vẫn có thể ghi trước mốc ấy. Sau khi mốc mới
được commit, mọi write generation 1 đều bị chặn. Renew trước write của worker
bình thường giảm nguy cơ, nhưng vẫn có khoảng pause giữa hai RPC; nó không thay
thế fencing. Không có lời hứa thu hồi lệnh đã ghi trước barrier.

## Chạy bốn tiến trình

Tạo thư mục dữ liệu mới dành riêng cho ví dụ; giữ nguyên hai file khi restart:

```sh
mkdir -p /tmp/lesson33-demo
HOST=127.0.0.1 PORT=3331 DB_PATH=/tmp/lesson33-demo/coordinator.sqlite TEACHING_CONTROLS=1 node lessons/33-leader-lease-fencing/coordinator.mts
```

Ở terminal thứ hai:

```sh
HOST=127.0.0.1 PORT=3332 DB_PATH=/tmp/lesson33-demo/sink.sqlite node lessons/33-leader-lease-fencing/sink.mts
```

Hai terminal khác, mỗi lệnh một tiến trình:

```sh
HOST=127.0.0.1 PORT=3333 HOLDER=alpha LEASE_MS=10000 COORDINATOR_URL=http://127.0.0.1:3331 SINK_URL=http://127.0.0.1:3332 TEACHING_CONTROLS=1 node lessons/33-leader-lease-fencing/worker.mts
HOST=127.0.0.1 PORT=3334 HOLDER=beta LEASE_MS=10000 COORDINATOR_URL=http://127.0.0.1:3331 SINK_URL=http://127.0.0.1:3332 TEACHING_CONTROLS=1 node lessons/33-leader-lease-fencing/worker.mts
```

`PORT=0` cũng được: mỗi tiến trình in một dòng JSON
`{"service":"lease-worker","port":<cổng thực tế>}` khi sẵn sàng. Đọc cổng đó để
điền URL của các tiến trình phụ thuộc. SIGTERM/SIGINT đóng listener, giới hạn thời
gian giữ connection và đóng SQLite khi server đóng. Không có election loop,
heartbeat tự chạy hay listener khi import module; config, SQLite và signal handler
chỉ được thiết lập trong `main()` có guard `import.meta.main`.

Ví dụ gửi lệnh bằng curl (mọi lệnh đều POST JSON; thêm `--max-time 5` để giới hạn):

```sh
curl --max-time 5 -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:3333/acquire
curl --max-time 5 -sS -H 'content-type: application/json' -d '{"id":"daily-export","payload":"batch-1"}' http://127.0.0.1:3333/write
curl --max-time 5 -sS -H 'content-type: application/json' -d '{}' http://127.0.0.1:3333/release
```

## Contract và cấu hình

| Thành phần | Route | JSON vào | 200 |
| --- | --- | --- | --- |
| Coordinator | `/acquire` | `{holder,ttl}` | `{holder,generation,expiresAt}` |
| Coordinator | `/renew` | `{holder,generation,ttl}` | grant cùng generation |
| Coordinator | `/release` | `{holder,generation}` | `{released:true}` |
| Sink | `/write` | `{generation,id,payload}` | `{generation,duplicate,applied}` |
| Worker | `/acquire`, `/renew`, `/release` | `{}` | grant hoặc released |
| Worker | `/write` | `{id,payload}` | receipt của sink |
| Coordinator, chỉ teaching | `/teaching/advance` | `{ms}` | `{offset}` |
| Worker, chỉ teaching | `/teaching/stale-write` | `{id,payload}` | receipt, bỏ qua renew |

`expiresAt` là Unix milliseconds theo đồng hồ coordinator. TTL là số nguyên
1..10000 ms; worker mặc định `LEASE_MS=5000`. `holder` và `id` là chuỗi ASCII
`[A-Za-z0-9_-]`, dài 1..48. Generation là số nguyên an toàn JavaScript >=1;
coordinator dừng cấp mới khi không thể tăng an toàn. Payload là chuỗi Unicode
hợp lệ, tối đa 256 UTF-16 units, cho phép chuỗi rỗng và ký tự điều khiển; không
nhận surrogate lẻ. Không ép kiểu số, boolean, mảng hay object thành chuỗi hợp lệ.
Upstream success được parse cấu trúc và đối chiếu holder/generation; worker không
lưu grant chưa hợp lệ. Lỗi upstream không làm worker tiến tới sink.

`DB_PATH` bắt buộc cho coordinator/sink, là file local bền vững, dài <=1024 ký tự,
không nhận `:memory:`. Worker không có database. `COORDINATOR_URL`/`SINK_URL`
bắt buộc cho worker: HTTP origin `127.0.0.1` có cổng tường minh, không credentials,
query hay path. `HOST` chỉ cho phép `127.0.0.1`. `PORT`: 0..65535, mặc định lần
lượt 3331/3332/3333. Hai worker phải dùng cổng khác nhau hoặc cổng 0.

JSON body tối đa **8192 bytes** qua `lib/http.mts`. Worst case của write chuẩn:
16 chữ số generation, 48 ký tự id, 256 units payload escape `\uXXXX` thành
1536 bytes, cộng tên field và dấu JSON: dưới 1700 bytes. Acquire/renew nhỏ hơn.
Whitespace/field phụ vẫn tính vào byte gate. Test gửi payload NUL đủ 256 units và
id đủ 48 ký tự; fixture 8193 bytes dùng cùng JSON hợp lệ cộng whitespace, nên nếu
bỏ gate nó sẽ thành replay 200, không bị lỗi schema khác che mất.

Request/header timeout server: 5 giây; mỗi upstream RPC: 1.5 giây kể cả đọc body,
response tối đa 8192 bytes, không follow redirect. Worker có một command đang chạy,
command chồng lấn trả 429 `busy`, không có hàng đợi vô hạn. Mỗi server tối đa
32 TCP connections, keep-alive idle 1 giây. Đây là các giới hạn cho ví dụ local,
không phải mô hình stream backpressure. SQLite dùng FULL synchronous, rollback
journal DELETE, busy timeout 1 giây và max_page_count=128 (file mới mặc định page
4096 bytes, khoảng 512 KiB cho main DB; journal tạm cũng chiếm đĩa). Một lease,
một fence và tối đa 128 receipt giữ dữ liệu logic hữu hạn; không tạo row cho mỗi
renew. Hết đĩa/SQLite busy có thể trả 500; không báo thành công giả.

Các lỗi có dạng `{error:{code,message}}`: 400 input sai, 404 route/control đóng,
405 method, 413 body quá lớn, 415 content-type, 409 lease không còn current hoặc
fencing/conflict, 429 worker bận, 507 receipt đầy. Worker ánh xạ upstream 409 thành
409 `upstream_rejected`; lỗi/timeout upstream khác thành 502. Muốn quan sát nguyên
nhân fence/conflict riêng, gọi sink hoặc xem assert của test trên sink trực tiếp.
Không tự retry write: nếu mất response sau commit, gửi lại **cùng id và payload**.

## Playground: pause, takeover và barrier xác định

Chỉ bật `TEACHING_CONTROLS=1` trên coordinator và hai worker cho demo local.
Các control không cần trên sink. Chúng không phải API quản trị triển khai thật.
Có thể dùng Playground gửi POST lần lượt, không cần sửa root/Playground:

1. Alpha `/acquire`, sau đó `/write` id `daily-export`, payload `batch-1`.
   Beta `/acquire` khi lease còn hiệu lực trả 409.
2. Coordinator `/teaching/advance` với `{"ms":10001}` (delta mỗi lần 1..60000).
   Response là barrier đã hết hạn. Beta `/acquire` nhận generation mới.
3. Alpha `/renew` thất bại. Alpha `/write` bình thường cũng thất bại trước sink.
   Alpha `/teaching/stale-write` id `late-before-fence`, payload `possible` vẫn
   có thể thành công: mô phỏng lệnh đã qua kiểm tra trước khi process bị pause.
4. Beta `/write` id `new-export`, payload `batch-2`. Đợi receipt 200: đây là barrier
   sink đã thấy generation mới. Alpha stale-write id mới hoặc replay id cũ đều 409.
5. Beta replay `daily-export`/`batch-1`: duplicate true, không tăng applied.
   Đổi payload nhưng giữ id: conflict. Restart coordinator/sink với đúng DB_PATH
   và cổng cũ: generation, fence và receipt vẫn tồn tại. Worker restart phải acquire
   lại; không khôi phục cache leadership bằng đoán generation.

Offset teaching cộng vào `Date.now()`, lưu bền vững; tổng offset <=1 tỷ ms. Database
đã advance không được mở khi controls tắt, tránh âm thầm quay đồng hồ lùi. Dùng
một bộ database mới để bắt đầu ví dụ bình thường; không xóa/khôi phục database cũ
khi hệ thống cũ hoặc message cũ còn có thể hoạt động. Bài test dùng đồng hồ inject
cho đúng biên expiry; integration dùng advance đã được xác nhận và receipt barrier,
không dùng sleep để suy ra tính chất đồng thời.

## Giả định, hỏng hóc và giới hạn

Các participant loopback đều **đáng tin, không Byzantine**. Generation không phải
credential: client ác ý có thể gửi generation cực lớn để chiếm fence. Không có auth,
TLS, phân quyền hay chống giả holder. Không mở port này ra Internet. Worker holder
phải duy nhất trong nhóm đang chạy; biết holder+generation không chứng minh danh tính.

Lease dựa vào wall clock của **một coordinator**. Clock nhảy tới trước có thể cấp
lease sớm; lùi có thể trì hoãn takeover và làm lease tưởng còn hiệu lực lâu hơn.
Worker không quyết định validity bằng clock riêng; renew có thẩm quyền ở coordinator.
Fencing vẫn bảo vệ thứ tự đã quan sát nếu generation bền vững không bị quay lùi,
nhưng không biến đồng hồ thành chính xác. Snapshot rollback/mất database coordinator
có thể tái sử dụng generation; mất database sink mất fence và dedup. Cần quy trình
khôi phục được thiết kế riêng trước khi gọi đây là production.

Coordinator chết: không acquire/renew; worker bình thường dừng ghi khi RPC lỗi.
Sink chết: write thất bại, có thể đã commit trước mất response nên phải replay id.
Paused worker: đường bình thường kiểm tra lại lease, nhưng pause sau renew vẫn tồn
tại; sink chịu trách nhiệm chặn write cũ sau barrier. Cùng generation không phân
biệt hai process giả cùng holder; giả định uniqueness là thiết yếu.

SQLite transaction là cơ chế tuần tự hóa local, không phải đồng thuận nhiều máy.
Không có quorum, log replication, Raft, leader election Kubernetes hay tự động failover
coordinator. Kubernetes Lease là một cơ chế phối hợp riêng; bài này không triển khai
hay tuyên bố tái tạo nó. Không dùng shared SQLite qua network filesystem để thay
consensus. Receipt không evict khiến hệ thống cuối cùng hết admission; giải pháp
thực tế cần policy dedup/retention và hợp đồng replay rõ ràng, không đơn giản xóa id.

## Bài tập

1. Viết timeline A renew → pause → B acquire → A write → B write. Đánh dấu write
   nào có thể thành công, rồi đổi thứ tự hai write và giải thích kết quả.
2. Thiết kế sink riêng cho hai tài nguyên: high-water mark nên theo tài nguyên nào?
   Điều gì sai nếu dùng một fence cho các leader độc lập?
3. Đề xuất protocol đóng một epoch, lưu checkpoint và thu hồi receipt; chứng minh
   replay epoch cũ không áp dụng lại hiệu ứng sau khi garbage collect.
4. Thử gửi generation lớn từ một client đáng tin nhưng bị lỗi. Cần thêm quyền hạn
   hoặc chứng thực ở đâu nếu bỏ giả định non-Byzantine?

## Tài liệu gốc

* [Kubernetes — Leases](https://kubernetes.io/docs/concepts/architecture/leases/):
  cách hệ sinh thái Kubernetes dùng lease cho phối hợp và heartbeat.
* [SQLite — Transactions](https://www.sqlite.org/lang_transaction.html):
  transaction, single writer và ý nghĩa của `BEGIN IMMEDIATE`.
