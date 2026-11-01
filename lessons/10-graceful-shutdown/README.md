# Bài 10 — Readiness và graceful shutdown

Một worker tạo báo cáo đang xử lý yêu cầu thì nhận SIGTERM để thay phiên bản.
Đóng listener ngay sẽ ngăn kết nối mới, nhưng chưa mô tả được việc ngừng nhận
nghiệp vụ, báo cho bộ điều phối rằng instance không sẵn sàng, hay kết quả của công
việc đã nhận. Bài này xây dựng lifecycle cục bộ và kiểm chứng bằng tiến trình Node
riêng. Không cần dịch vụ ngoài, container hay gói runtime.

## Điều kiện và lệnh chạy

Cần Node.js 24.12+ thuộc nhánh 24 và các development dependencies đã được cài ở
root. Đọc bài 01 về HTTP giữa tiến trình và bài 04 về deadline trước. Chạy các
lệnh sau **từ root repository**, trên Linux/macOS có hỗ trợ SIGTERM:

```sh
node --version
npm run typecheck
npm run test:unit
# Chỉ chạy lệnh integration sau trong môi trường được phép mở loopback:
node --test --test-timeout=15000 lessons/10-graceful-shutdown/test/lesson.test.mts
# Toàn bộ kiểm tra repository, cũng cần quyền mở loopback:
npm run check
make test
```

Worker sandbox chỉ chạy typecheck và unit test. Controller bên ngoài chạy các
HTTP integration test trong Docker network cô lập; không cần chạy Docker trong
worker. `test:unit` chỉ chọn tên chứa `unit:` và không mở listener.

Chạy thử bằng hai terminal trong môi trường cho phép HTTP cục bộ:

```sh
# Terminal A: lưu PID chính xác của service, chờ công việc/kết thúc.
PORT=3010 WORK_MS=8000 DRAIN_MS=1000 SHUTDOWN_MS=12000 \
  node lessons/10-graceful-shutdown/service.mts &
worker_pid=$!
echo "$worker_pid"
wait "$worker_pid"
echo "exit=$?"
```

```sh
# Terminal B: thay 12345 bằng PID vừa in ở terminal A.
curl -i http://127.0.0.1:3010/ready
curl -i --no-buffer http://127.0.0.1:3010/work &
# Chờ dòng HTTP/1.1 200 OK: service đã nhận công việc, body chưa xong.
kill -TERM 12345
curl -i http://127.0.0.1:3010/ready
curl -i http://127.0.0.1:3010/live
curl -i http://127.0.0.1:3010/work
wait
```

Trong khi công việc đầu còn chạy, `/ready` trả 503, `/live` trả 200,
`/work` mới trả 503. Sau khoảng 8 giây kể từ lúc nhận việc, request đầu nhận
`{"result":"completed"}` và tiến trình thoát mã 0. Các lệnh probe chạy quá muộn
có thể gặp connection refused vì listener đã đóng; đó là kết quả hợp lệ sau exit.
Để thử hết deadline, đổi `SHUTDOWN_MS=1500` (vẫn lớn hơn `DRAIN_MS`): body bị
cắt, exit là 1. Không diễn giải HTTP 200 headers là công việc đã hoàn thành.

## Cấu hình và hợp đồng

| Biến | Mặc định | Phạm vi / ý nghĩa |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Địa chỉ bind; giữ loopback cho ví dụ |
| `PORT` | `3010` | Số nguyên 0–65535; 0 lấy port tạm từ OS |
| `WORK_MS` | `1000` | Số nguyên 0–60000, thời gian mô phỏng tạo báo cáo |
| `DRAIN_MS` | `300` | Số nguyên 0–60000, cửa sổ tối thiểu để readiness được quan sát |
| `SHUTDOWN_MS` | `3000` | Số nguyên 100–60000, deadline tổng từ tín hiệu đầu |

`DRAIN_MS` phải nhỏ hơn `SHUTDOWN_MS`; cấu hình sai làm startup thất bại.
Không có dấu âm, số thập phân hay hậu tố đơn vị trong biến số. Service in một dòng
JSON `{service,port}` sau khi bind và cài signal handlers, dùng được với helper
`startService`. Import module không tự mở listener.

| Request | Ready | Draining |
| --- | --- | --- |
| `GET /live` | 200 `{live:true}` | 200 `{live:true}` khi còn listener |
| `GET /ready` | 200 `{ready:true,state:"ready",active:N}` | 503 `{ready:false,state:"draining",active:N}` |
| `GET /work` mới | 200 headers ngay; JSON body sau `WORK_MS` | 503 `{error:"draining"}`, `Retry-After: 1`, `Connection: close` |
| `GET` đường dẫn khác | 404 `{error:"not_found"}` | Tương tự |
| Method khác `GET` | 405, `Allow: GET` | Tương tự |

Các đường dẫn khớp chính xác; `/work?x=1` là 404. Mọi response trong ví dụ dùng
JSON và `Cache-Control: no-store`. Liveness là khả năng phục vụ probe, không phải
khả năng nhận nghiệp vụ. Readiness là tín hiệu chọn instance cho request mới;
không có load balancer thật trong bài. `active` chỉ đếm `/work`, không đếm probe
hay request bị từ chối. Sau khi đóng listener, không còn cam kết HTTP cho probe.

## Kiến trúc và thứ tự shutdown

```text
client/test process --HTTP--> worker process
                         lifecycle: ready -> draining -> stopped
SIGTERM/SIGINT --------------------^
```

- `lifecycle.mts` chứa state machine thuần: `admit()` tăng bộ đếm và trả hàm
  release idempotent; sau `drain()` không được nhận thêm. `stop()` bình thường
  chỉ hợp lệ sau drain và khi bộ đếm bằng 0; `stop(true)` dành cho deadline.
- `service.mts` sở hữu HTTP server, tín hiệu và timer. Nó dùng `json` và
  `numberSetting` từ `lib/http.mts`, nhưng không dùng `serve`: helper đó đóng
  listener ngay và có lịch cưỡng bức riêng, không phù hợp cửa sổ drain này.
  Không thay đổi shared helper.
- Tín hiệu đầu chuyển trạng thái đồng bộ trước khi xử lý request tiếp theo,
  bật deadline và timer propagation. Tín hiệu lặp không kéo dài hoặc rút ngắn
  deadline. Listener vẫn mở trong drain để thể hiện readiness và từ chối nghiệp
  vụ ở tầng HTTP, kể cả qua kết nối keep-alive có sẵn.
- Khi hết `DRAIN_MS` **và** mọi công việc được release, gọi `server.close()`.
  Callback close dọn timer và signal handlers, Node tự thoát 0. Nếu không có việc,
  vẫn chờ cửa sổ drain. `stopped` nghĩa là đã đóng cổng nhận nghiệp vụ và bắt đầu
  đóng transport; callback close mới xác nhận transport đóng xong.
- Nếu hết `SHUTDOWN_MS` trước callback, hủy các kết nối HTTP và `process.exit(1)`.
  Timer có reference để bảo đảm tiến trình không bỏ qua deadline. Đây là đường
  cưỡng bức có chủ ý: không chờ flush log, không bảo đảm giữ body dở dang.

`finish` đánh dấu response được bàn giao cho hệ thống, không xác nhận client đã
nhận đủ qua mạng. `close` xử lý cả client ngắt giữa chừng; release idempotent
tránh trừ hai lần khi cả hai sự kiện xảy ra. Trong ví dụ, đóng response cũng hủy
timer công việc, nên không còn tác vụ nền sau khi client rời đi. Công việc thật
phải có cơ chế cancel/cooperative completion riêng và giữ token đến lúc tác vụ
thật sự kết thúc; chỉ đếm socket sẽ không đủ cho giao dịch database.

## Kiểm thử và ca lỗi

Unit test được viết trước implementation và đã quan sát assertion thất bại khi
`admit()` chưa tăng bộ đếm. Chúng kiểm tra admission, chuyển trạng thái một chiều,
không stop sớm, tín hiệu lặp, release hai lần và forced stop khi còn việc.

Integration test dùng `test/support.mts` để spawn service độc lập, bind loopback
port 0, đọc port từ stdout và luôn đăng ký cleanup. Test `/work` chờ headers đã
flush thay vì ngủ rồi đoán công việc đã bắt đầu. Sau SIGTERM, nó poll readiness
có hạn, xác nhận active=1, liveness vẫn tốt và việc mới bị từ chối; cuối cùng
kiểm tra body hoàn chỉnh và exit `[0,null]`. Test deadline đợi body bị gián đoạn
và exit `[1,null]` trong giới hạn, phân biệt với SIGKILL của cleanup. Có thêm
ca idle và method/route. Tất cả request và việc chờ exit có timeout; không có
listener ở top level test module. HTTP tests được cung cấp để controller chạy;
chúng chưa được thực thi trong worker sandbox.

Các lỗi cần hiểu: SIGKILL không chạy handler; event loop bị chặn bằng CPU đồng bộ
cũng chặn timer, nên deadline trong tiến trình không phải bảo đảm thời gian thực.
Supervisor phải có hard deadline riêng, lớn hơn shutdown budget cộng biên an toàn.
Probe hoặc client gửi chậm có thể giữ transport mở sau khi nghiệp vụ xong; deadline
vẫn bao trùm giai đoạn `server.close()`. Không hỗ trợ WebSocket/HTTP upgrade, HTTP/2,
queue consumer, durable job hay bảo đảm exactly-once. Client mất kết nối không thể
biết chắc side effect đã commit; ứng dụng có ghi dữ liệu cần idempotency như bài 05.

## Đánh đổi và bài tập

Cửa sổ propagation cố định dễ quan sát nhưng tăng thời gian rollout, không chứng
minh mọi proxy đã nhận readiness mới. Ví dụ không giới hạn concurrency, không
thực hiện load shedding khi ready và không cung cấp endpoint điều khiển shutdown.
`Retry-After` chỉ là gợi ý; retry phải tuân deadline và tính an toàn của nghiệp vụ.

1. Thêm test client hủy body: chứng minh active về 0 và worker thoát bình thường
   sau SIGTERM, không đợi timer công việc cũ.
2. Tách báo cáo thành job bền vững: xác định token active theo lifetime của job,
   rồi giải thích tại sao mất HTTP client không được coi là hoàn thành job.
3. Mô phỏng nhiều worker và bộ chọn dựa trên readiness; đo số 503 trong cửa sổ
   propagation, thay đổi cửa sổ và nêu chi phí rollout.
4. Thử công việc chặn CPU rồi so sánh deadline nội bộ với hard deadline bên ngoài.

## Tài liệu gốc

- [Node.js 24: server.close(callback)](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback):
  thời điểm ngừng nhận kết nối và callback khi server đóng.
- [Node.js 24: server.closeAllConnections()](https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections):
  giới hạn của việc cưỡng bức đóng kết nối HTTP.
- [Node.js 24: signal events](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events):
  hành vi khi cài handler cho SIGTERM/SIGINT.
