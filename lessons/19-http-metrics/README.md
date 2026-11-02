# 19 — Metrics HTTP, histogram và cardinality có giới hạn

Bài này thêm quan sát vào hai tiến trình HTTP độc lập: gateway chuyển tiếp công
việc sang downstream; mỗi tiến trình giữ registry riêng trong RAM. Chỉ dùng
built-in Node.js, không cần Prometheus server, agent, package runtime hay tài khoản.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc nhánh 24**, npm và các development dependency đã được
pin tại gốc repository. Đọc bài HTTP cơ bản, deadline propagation và graceful
shutdown trước. Chạy các lệnh sau từ gốc repository; dùng hai terminal riêng:

```sh
PORT=3919 WORK_MS=800 node lessons/19-http-metrics/downstream.mts
```

```sh
PORT=3918 DOWNSTREAM_URL=http://127.0.0.1:3919 DEADLINE_MS=2000 node lessons/19-http-metrics/gateway.mts
```

Terminal thứ ba tạo công việc, sau đó đọc registry của **cả hai** tiến trình:

```sh
curl -i http://127.0.0.1:3918/work
curl -i http://127.0.0.1:3918/metrics
curl -i http://127.0.0.1:3919/metrics
```

Quan sát gauge khi hai công việc đang chờ bằng lệnh native Node:

```sh
node --input-type=module -e 'const jobs = [fetch("http://127.0.0.1:3918/work"), fetch("http://127.0.0.1:3918/work")]; await new Promise(r => setTimeout(r, 100)); console.log(await (await fetch("http://127.0.0.1:3918/metrics")).text()); await Promise.all(jobs);'
```

Ví dụ này chỉ minh họa thời gian chờ; integration test đồng bộ bằng cách poll gauge
ở downstream rồi gateway, có deadline rõ ràng, thay vì coi sleep là bằng chứng.
Dừng từng tiến trình bằng Ctrl-C. Không có listener, store, đọc biến môi trường,
signal handler hoặc background task khi import entrypoint. `main()` gọi `start()`;
`import.meta.main` mới kích hoạt chạy trực tiếp. `serve()` dùng helper chung để
in JSON readiness `{service,port}`, xử lý shutdown và đóng connection còn lại sau
1 giây. Code bài học không phụ thuộc tiến trình của bài trước.

## Cấu hình và hợp đồng

| Biến | Mặc định | Phạm vi / ý nghĩa |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface lắng nghe; giữ loopback cho bài thực hành |
| `PORT` | gateway 3918, downstream 3919 | Số nguyên 0..65535; 0 chọn cổng tạm |
| `DOWNSTREAM_URL` | `http://127.0.0.1:3919` | Gateway dùng HTTP, hostname phải đúng `127.0.0.1`, không user/password; chuyển tiếp cố định `/work` |
| `WORK_MS` | 50 | Số nguyên 0..3000; thời gian mô phỏng công việc downstream |
| `DEADLINE_MS` | 1000 | Số nguyên 10..5000; deadline gọi dependency ở gateway |
| `FAIL_WORK` | tắt | Giá trị đúng `1` làm downstream trả 500 sau khi chờ |

`GET /work` không có payload hay tham số điều khiển từ client. Thành công trả
200 JSON `{result:"computed"}`; gateway thêm `via:"gateway"`. Không có payment,
state nghiệp vụ hoặc external API. Path khác trả 404; method khác trên `/work`
trả 405 và `Allow: GET`. Downstream lỗi đã cấu hình trả 500; gateway đổi lỗi
HTTP downstream thành 502, lỗi kết nối thành 502, hết deadline thành 504.
Caller disconnect không có HTTP response để gửi lại: ghi outcome `cancelled`,
status `other`, đồng thời abort fetch dependency. Downstream abort thời gian chờ
khi connection đóng. Các failure test dùng GET hợp lệ, không vô tình bị chặn bởi
validation khác trước khi đến nhánh lỗi cần chứng minh.

`GET /metrics` trả `Content-Type: text/plain; version=0.0.4; charset=utf-8` và
`Cache-Control: no-store`. Mọi method trên path `/metrics` đều được loại khỏi
business metrics, kể cả method sai (405). Query string không tạo nhãn. Scrape
không gọi downstream. Có thể scrape trước request đầu tiên: khi ấy chỉ có HELP,
TYPE; các series được tạo lười khi route/method xuất hiện lần đầu.

```text
client --> gateway /work --> downstream /work
              |                    |
              v                    v
         registry RAM         registry RAM
         GET /metrics         GET /metrics
```

## Registry và định dạng Prometheus

`metrics.mts` nhận clock theo **mili giây**, mặc định `performance.now()` đơn điệu;
đổi sang giây khi kết thúc. Unit test tiêm clock để tính chính xác, không phụ thuộc
wall clock hoặc tốc độ máy.

- `http_requests_total{route,method,outcome,status}`: counter request **đã kết thúc**.
- `http_active_requests{route,method}`: gauge tăng lúc vào handler và giảm khi kết thúc.
- `http_request_duration_seconds{route,method}`: classic histogram gồm `_bucket`,
  `_count`, `_sum`. Biên giây cố định: 0.1, 0.5, 1, 5, `+Inf`.

Mỗi observation tăng tất cả bucket có biên lớn hơn hoặc bằng duration, vì vậy
bucket **cumulative**. Ví dụ một request 0.25 giây tạo:

```text
http_request_duration_seconds_bucket{route="/work",method="GET",le="0.1"} 0
http_request_duration_seconds_bucket{route="/work",method="GET",le="0.5"} 1
http_request_duration_seconds_bucket{route="/work",method="GET",le="1"} 1
http_request_duration_seconds_bucket{route="/work",method="GET",le="5"} 1
http_request_duration_seconds_bucket{route="/work",method="GET",le="+Inf"} 1
http_request_duration_seconds_count{route="/work",method="GET"} 1
http_request_duration_seconds_sum{route="/work",method="GET"} 0.25
```

Output có HELP và TYPE cho từng family, newline cuối, escape `\\`, `"`, newline
trong label theo text exposition. Nhãn runtime đã được allowlist; hàm escape
vẫn được kiểm thử riêng để tránh lỗi khi bảo trì formatter. Tổng bucket `+Inf`
luôn bằng `_count`. Histogram gồm cả lỗi và hủy, vì đó cũng là thời gian tài nguyên
bị chiếm. Không có nhãn outcome trong histogram; vì vậy không thể dùng histogram
này để tính percentile riêng cho request thành công.

`finish` biểu thị response đã giao cho hệ thống truyền, **không chứng minh client
đã nhận hết**. `close` trước `writableFinished` được coi là hủy. Cả hai cùng gọi
closure completion có cờ idempotent: không tăng counter/histogram hay giảm gauge
hai lần. Nếu `close` đến sau `finish` thì không hủy. Completion được gắn trước
nhánh route validation, nên 404, 405 và dependency failure đều được đo.
Gauge bằng 0 nghĩa là HTTP request đã kết thúc theo hợp đồng này, không phải cam
kết mọi công việc tùy ý bên ngoài đã dừng; ở đây fetch/timer đều hỗ trợ abort.

## Giới hạn cardinality

Không lấy raw URL, resource ID, request ID, header, query, method tùy ý hoặc nội
dung lỗi làm label. Allowlist chính xác:

| Nhãn | Giá trị |
| --- | --- |
| `route` | `/work`, `unknown` |
| `method` | `GET`, `POST`, `OTHER` |
| `outcome` | `ok`, `error`, `cancelled` |
| `status` | `200`, `400`, `404`, `405`, `500`, `502`, `504`, `other` |

Các giá trị status dự phòng được giữ hữu hạn cho việc mở rộng hợp đồng; nhiều tổ
hợp chưa thể xảy ra trong dịch vụ hiện tại. Trần bảo thủ mỗi process là
`2 × 3 × (3 × 8 + 1 + 5 + 2) = 192` series: counter theo outcome/status, một gauge,
năm bucket và count/sum cho mỗi route/method. Registry chỉ tạo tổ hợp đã quan sát.
Cần nhân thêm số instance và các target label bên ngoài nếu triển khai thật.
Giữ request ID trong log để tra cứu, không thêm nó vào metric. Các URL lạ khác
nhau đều vào một route `unknown`; integration test gửi 25 URL có query khác nhau
và chứng minh chỉ thêm đúng 9 series cho nhóm unknown/GET.

## Đọc số liệu đúng

Counter là tổng từ lúc process khởi động. Ví dụ scrape trước có 12 completion,
sau 10 giây có 42, tốc độ trung bình là `(42 - 12) / 10 = 3 request/giây` nếu
không restart. Counter giảm có thể là restart, không phải lưu lượng âm. Restart
mất toàn bộ registry; cần scraper lưu chuỗi thời gian và xử lý reset.

Nếu có Prometheus riêng trong môi trường khác, có thể dùng các biểu thức sau;
bài này không cài hay chạy monitoring server:

```promql
sum by (job, route) (rate(http_requests_total[5m]))
sum by (job, route) (http_active_requests)
histogram_quantile(0.95,
  sum by (job, route, le) (rate(http_request_duration_seconds_bucket[5m])))
```

Áp dụng `rate` **trước** `sum` để xử lý reset từng instance. Chỉ cộng histogram
có cùng đơn vị, biên bucket và ý nghĩa route. Giữ `le` khi cộng bucket. Không
cộng percentile của các instance hoặc lấy trung bình percentile. Tách `job`
gateway/downstream: một thao tác đi qua cả hai, cộng chúng sẽ đếm hai HTTP hop
chứ không phải hai thao tác người dùng. Gauge là ảnh chụp tức thời, scrape có thể
bỏ lỡ đỉnh tải. Các series counter không xuất hiện trước completion đầu tiên,
nên truy vấn production cần xử lý missing series theo ngữ cảnh.

Histogram không lưu mẫu thô: duration 0.11 và 0.49 giây cùng rơi vào khoảng
(0.1, 0.5]. Percentile nội suy là xấp xỉ; tăng độ phân giải gần ngưỡng quan trọng
đổi lại nhiều series hơn. Trung bình tính bằng `rate(_sum)/rate(_count)` và cần
xử lý mẫu số 0. Không thể suy ra latency end-to-end bằng cộng percentile gateway
và downstream. Duration gateway đã chứa phần chờ downstream.

## Lỗi, giới hạn và thử nghiệm

Khởi động lại downstream với `FAIL_WORK=1 WORK_MS=0` để thấy downstream
`error/500`, gateway `error/502`. Hoặc đặt `WORK_MS=2000` và gateway
`DEADLINE_MS=500` để thấy gateway `error/504`, downstream `cancelled/other`.
Đóng request từ client đang chờ sẽ tạo `cancelled/other` ở hai hop; request đã
finish trước khi client đóng vẫn là completion bình thường. Tất cả nhánh dùng
một completion, không sửa metric bằng cách bù trừ ở catch.

Bài học chỉ có registry cục bộ, chưa có lưu trữ time series, discovery, HA scrape,
retention, dashboard, recording rules hay alert delivery. Metrics của process
không tự định nghĩa SLI/SLO, cửa sổ đánh giá, error budget, burn rate hoặc trực ca.
`/metrics` chưa có auth và không nên public ra Internet. Work chỉ là timer, không
mô phỏng mọi dạng CPU-bound hoặc dependency không hỗ trợ cancellation. Graceful
shutdown dùng helper giới hạn đơn giản, không phải cơ chế drain production đầy đủ.

## Kiểm thử và trạng thái xác minh

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/19-http-metrics/test/lesson.test.mts
```

Unit test bao gồm clock tiêm, bucket cumulative và `+Inf`, count/sum, escape,
allowlist, gauge đồng thời, idempotence và import entrypoint với cấu hình sai.
Trước triển khai, `npm run test:unit` đã fail; focused command hiển thị assertion
`Metrics implementation must exist and expose real observations`. Sau triển khai,
bốn unit test pass với assertions hiển thị khi tắt isolation.

Lệnh HTTP cho môi trường có private loopback của controller:

```sh
node --test --test-isolation=none --test-name-pattern=integration: lessons/19-http-metrics/test/lesson.test.mts
npm run check
make test
git diff --check
```

HTTP tests spawn tiến trình riêng, `PORT=0`, loopback, readiness JSON; không có
listener ở test-module top level. Chúng kiểm tra counter chính xác cả hai hop,
gauge khi hai request đồng thời, scrape không tự đếm, series hữu hạn khi URL
thay đổi, cleanup sau lỗi/timeout/hủy. Polling có deadline; fetch có timeout;
`finally` dừng children, helper có SIGKILL dự phòng. Worker không chạy HTTP tests,
`npm run check` hoặc `make test` vì sandbox không cho mạng; controller chạy các
check này trong môi trường cô lập. Không tuyên bố integration đã pass.

## Bài tập

1. Với observation 0.05, 0.25 và 2 giây, tự tính từng bucket, count và sum rồi
   kiểm tra bằng injected clock. Ngưỡng 0.5 giây có bao nhiêu request đạt?
2. Thử POST `/work`, một method lạ và 100 path lạ. Dự đoán số series tăng thêm
   trước khi scrape; giải thích tại sao số path không quyết định cardinality.
3. Đề xuất bucket quanh mục tiêu 300 ms. Tính chi phí series cho 40 instance và
   chỉ ra điều kiện để gộp histogram giữa phiên bản cũ/mới an toàn.
4. Thiết kế SLI tỷ lệ thành công ở gateway: quyết định 404 và cancellation có
   tính vào mẫu số không, xác định cửa sổ đo và dữ liệu ngoài process cần lưu.

## Tham khảo

- [Prometheus — Instrumentation practices](https://prometheus.io/docs/practices/instrumentation/)
- [Prometheus — Text exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Prometheus — Histograms and summaries](https://prometheus.io/docs/practices/histograms/)
