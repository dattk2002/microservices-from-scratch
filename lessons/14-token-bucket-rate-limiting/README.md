# 14 — Rate limiting bằng token bucket

Bài này chặn lưu lượng **trước khi gọi downstream**, theo từng ID minh họa đã kiểm tra. Hai chương trình Node chạy độc lập; gateway giữ quota trong RAM, downstream giữ bộ đếm request thực sự đi tới `/work`. Không cần package runtime, tài khoản hay dịch vụ bên ngoài.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc dòng 24**, npm và checkout repository. Các lệnh dưới chạy tại thư mục gốc; công cụ phát triển dùng phiên bản đã ghim của repository. Đọc trước bài deadline propagation và bulkhead để phân biệt giới hạn tốc độ với giới hạn đồng thời.

Terminal 1:

```bash
node lessons/14-token-bucket-rate-limiting/downstream.mts
```

Terminal 2:

```bash
CAPACITY=2 REFILL_MS=3000 MAX_CLIENTS=100 IDLE_MS=60000 \
DOWNSTREAM_URL=http://127.0.0.1:4411 DEADLINE_MS=1000 \
node lessons/14-token-bucket-rate-limiting/gateway.mts
```

Terminal 3, chạy liên tiếp trong vòng ba giây:

```bash
curl -i -H 'x-demo-client: alice' http://127.0.0.1:4410/work
curl -i -H 'x-demo-client: alice' http://127.0.0.1:4410/work
curl -i -H 'x-demo-client: alice' http://127.0.0.1:4410/work
curl -i -H 'x-demo-client: bob' http://127.0.0.1:4410/work
curl -i http://127.0.0.1:4411/stats
```

Hai request đầu của Alice được nhận, request thứ ba nhận 429; Bob vẫn có quota riêng. Nếu thao tác đủ nhanh, `/stats` trả `{"entered":3}`. Đợi số giây trong `Retry-After` rồi thử Alice lại. Thao tác tay có thể lâu hơn một chu kỳ refill nên kết quả ví dụ phụ thuộc thời gian thực; unit test dùng clock giả để kiểm tra chính xác biên thời gian.

Mỗi tiến trình in một dòng JSON có `service` và `port` khi sẵn sàng. Mặc định bind `127.0.0.1`; `PORT=0` chọn cổng tạm. Dừng bằng Ctrl-C. Import module không mở listener; `import.meta.main` mới chạy entrypoint.

## Kiến trúc và ranh giới tin cậy

```text
client -- GET /work, x-demo-client --> gateway :4410
                                      | validate route/method/query/ID
                                      | bucket.take(ID), không await
                                      | allowed: tiêu thụ 1 token
                                      v
                                  downstream :4411 /work
                                      | tăng entered
                                      v
                                  200 {state:"ok"}
```

Nhánh bị từ chối trả ngay tại gateway, không gọi downstream và không đưa request vào hàng đợi. Gateway không chuyển header client sang downstream. `/stats` nằm ở downstream, không được gateway public hóa; đây là công cụ quan sát cục bộ để kiểm chứng admission, không phải endpoint quản trị production.

**`x-demo-client` không phải authentication.** Người gọi tự đặt và giả mạo được header này, có thể đổi ID để lấy quota mới hoặc làm đầy bảng client. Regex và giới hạn bộ nhớ chỉ phục vụ một mô hình học hữu hạn. Hệ thống thật cần xác thực trước, lấy khóa quota từ danh tính đã kiểm chứng và có cơ chế chống lạm dụng khi onboarding; không dùng header tùy ý như bằng chứng danh tính. Cổng downstream cũng không được bảo vệ bởi gateway nếu gọi trực tiếp.

ID hợp lệ dài 1–32 ký tự ASCII, ký tự đầu là `a-z` hoặc `0-9`, phần sau cho phép thêm `_` và `-`. Thiếu ID, chữ hoa, dấu phẩy, khoảng trắng, giá trị quá dài đều bị 400. Header lặp được Node ghép bằng dấu phẩy nên cũng không hợp lệ. Không trim/normalize ID thành danh tính khác.

## Token bucket và clock

Gọi `C` là capacity và `R` là `REFILL_MS`:

- Bucket mới có `C` token; mỗi request được nhận tốn một token.
- Refill liên tục với tốc độ **một token mỗi R millisecond**, tối đa `C` token. `R` không phải chu kỳ nạp lại toàn bộ bucket.
- Mã lưu credit theo millisecond: trần `C × R`, mỗi request tốn `R`, thời gian trôi qua `dt` cộng `dt` credit. Không cần timer nền hay làm tròn token từng lần cập nhật.
- Khi thiếu credit, `Retry-After = max(1, ceil((R - credit) / 1000))`. Ví dụ còn thiếu 1501 ms → 2 giây, thiếu 1000 ms → 1 giây. Tại đúng biên đủ một token, request được nhận.

Clock được inject vào `Buckets`; runtime dùng `performance.now()` đơn điệu, không dùng giờ lịch có thể bị chỉnh lùi. Unit test điều khiển clock bằng số để không sleep. Clock âm, lùi hoặc không hữu hạn bị lỗi. Cấu hình được sao chép lúc tạo; mọi trường phải là số nguyên trong giới hạn đã công bố.

Mỗi lần quyết định và trừ quota đều đồng bộ trong cùng event loop, trước lần `await` đầu tiên. Vì vậy hai request trong một gateway không cùng tiêu thụ một token. Không có giao dịch xuyên process. Request được nhận đã tiêu thụ quota ngay cả khi downstream lỗi, timeout hoặc client ngắt kết nối; không hoàn token để retry lỗi trở thành đường đi miễn phí.

## Cấu hình

Tất cả biến số dùng chữ số thập phân nguyên; giá trị ngoài phạm vi làm tiến trình thất bại trước khi listen.

| Biến | Mặc định | Phạm vi / ý nghĩa |
| --- | --- | --- |
| `CAPACITY` | 3 | 1–1000 token / client |
| `REFILL_MS` | 1000 | 1–3600000 ms / token |
| `MAX_CLIENTS` | 100 | 1–10000 bucket |
| `IDLE_MS` | 60000 | 1–86400000 ms không truy cập trước khi có thể xóa |
| `DEADLINE_MS` | 1000 | 10–10000 ms cho fetch downstream |
| `DOWNSTREAM_URL` | `http://127.0.0.1:4411` | HTTP origin, không credentials/path/query/fragment |
| `HOST` | `127.0.0.1` | địa chỉ bind của từng process |
| `PORT` | gateway 4410, downstream 4411 | 0–65535; 0 chọn cổng tạm |

`HOST` chỉ dùng cho môi trường demo tin cậy. URL downstream là cấu hình operator, không lấy từ request. Shared helper `lib/http.mts` cung cấp JSON, HTTP errors, listen và shutdown; `test/support.mts` khởi tạo/thu hồi child process. Hai service của bài không cần service từ bài trước.

## Bộ nhớ hữu hạn và chính sách khi đầy

Map chứa tối đa `MAX_CLIENTS` bucket. ID và dữ liệu mỗi bucket có kích thước hữu hạn. Khi ID mới đến và bảng đầy, gateway quét các bucket; chỉ xóa khi **cả hai điều kiện** đúng:

1. Không có request cho ID đó trong ít nhất `IDLE_MS` (request bị 429 cũng được tính là truy cập).
2. Credit sau refill theo thời gian hiện tại đã đạt trần `C × R`.

Nếu vẫn đầy, trả **503 `client_table_full`** cho ID mới, không tạo bucket và không gọi downstream. ID đã có vẫn được xét quota bình thường. Không dùng LRU xóa bừa: xóa bucket đang cạn rồi tạo lại sẽ tặng một burst mới và phá giới hạn. `IDLE_MS` ngắn hơn thời gian nạp đầy vẫn an toàn vì điều kiện thứ hai bắt buộc. Khi bucket đã đầy, xóa rồi tạo lại không cho thêm token so với trạng thái lẽ ra nó có.

Không có sweeper nền; map có thể giữ bucket hết hạn đến khi cần chỗ. Lookup thông thường O(1), quét khi đầy O(`MAX_CLIENTS`); bộ nhớ O(`MAX_CLIENTS`). Chính sách này ưu tiên giữ quota đang tồn tại, có thể từ chối client mới trong lúc các client cũ còn nợ token hoặc chưa idle. Nó không đảm bảo công bằng trước người đổi ID liên tục.

## Hợp đồng HTTP và lỗi

Chỉ `GET /work` không query được gateway hỗ trợ. JSON luôn có `cache-control: no-store`. Response của downstream là acknowledgement nhỏ cố định; gateway kiểm tra status, hủy body và trả JSON của riêng mình, không làm proxy nội dung tùy ý.

| Status | Code / body | Khi nào |
| --- | --- | --- |
| 200 | `{"state":"ok"}` | đủ quota và downstream trả 200 |
| 400 | `invalid_client` hoặc `invalid_query` | request không hợp lệ, không mất token |
| 404 | `not_found` | sai route, không mất token |
| 405 | `method_not_allowed`, `Allow: GET` | sai method, không mất token |
| 429 | `{"error":{"code":"rate_limited"}}` | ID hiện tại cạn quota; luôn có `Retry-After` là số nguyên dương |
| 503 | `{"error":{"code":"client_table_full"}}` | không còn chỗ an toàn cho ID mới; không có `Retry-After` |
| 502 | `dependency_failed` / `dependency_unreachable` | status downstream khác 200 hoặc kết nối thất bại |
| 504 | `deadline_exceeded` | fetch downstream vượt deadline |

Các lỗi từ shared helper có dạng `{"error":{"code":"...","message":"..."}}`. Downstream cung cấp `GET /stats` → `{"entered":N}`; chỉ `/work` hợp lệ tăng N. Shutdown và restart đặt N về 0.

Deadline bao gồm fetch và xử lý body; khi client ngắt kết nối, gateway abort fetch. Không retry tự động. `Retry-After` là thời gian chờ tối thiểu ước tính tại lúc từ chối, không phải đặt trước token: request khác cùng ID có thể tiêu thụ token trước lần retry. Client nên đợi, dùng jitter và giới hạn số lần thử, tránh retry đồng loạt.

## Kiểm chứng

Lệnh native từ root (không cần HTTP):

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/14-token-bucket-rate-limiting/test/lesson.test.mts
```

Unit test kiểm tra burst ban đầu, refill đúng biên, trần tích lũy, làm tròn Retry-After, cấu hình sai, ID, clock, cách ly client, bảng đầy và cả hai điều kiện eviction. Tests được viết trước implementation; stub cho mọi request đi qua đã gây assertion failure thực tế trước khi thay bằng token bucket.

Trong môi trường được phép mở loopback, chạy toàn bộ bài:

```bash
node --test --test-timeout=15000 lessons/14-token-bucket-rate-limiting/test/lesson.test.mts
```

Integration test tạo **hai child process độc lập** bằng `startService`, mỗi process dùng `HOST=127.0.0.1 PORT=0`, có deadline cho startup/request và teardown SIGTERM/SIGKILL. Không mở listener ở top level của test. Kiểm thử dùng refill rất dài cho burst để không phụ thuộc sleep, đối chiếu bộ đếm downstream chính xác: Alice 2 lần, Bob 2 lần, mọi request bị từ chối không làm tăng tổng 4. Bài test khác chứng minh request sai không tạo bucket/mất token và thực sự đợi `Retry-After` rồi gửi HTTP lại sau refill. Unit test mới là bằng chứng chính xác cho biên millisecond; test HTTP xác nhận wiring thực tế.

Worker không có network chỉ chạy typecheck/unit; **chưa chạy integration test trong sandbox này**. Outer controller chạy HTTP trong Docker cô lập có loopback riêng, rồi kiểm tra toàn repository bằng `npm run check`, `make test` và `git diff --check`. Không chạy Docker hay yêu cầu quyền mạng từ worker.

## Giới hạn và lựa chọn thiết kế

- **Per-instance:** mỗi gateway có map riêng. Hai replica cho cùng một ID có thể nhận tổng burst `2C` và tốc độ `2/R`; sticky routing không tự giải quyết restart hoặc thay đổi replica. Muốn quota toàn cụm cần state phối hợp và quyết định rõ khi store lỗi, độ trễ và tính nguyên tử.
- **Restart reset:** mọi client lấy lại burst sau restart. Không có persistence, khôi phục quota hay chống đổi ID. Đây là giới hạn có chủ đích của ví dụ RAM cục bộ.
- **Không giới hạn concurrency:** tốc độ một request/giây vẫn có thể tạo khoảng 30 request đồng thời nếu mỗi request kéo dài 30 giây. Capacity còn cho burst ban đầu. Deadline giảm thời gian giữ tài nguyên nhưng không thay thế bulkhead; kết hợp bài 13 nếu cần giới hạn số request đang chạy.
- Token bucket cho burst hữu hạn và tốc độ trung bình dài hạn; không áp đặt “tối đa C request trong mọi cửa sổ trượt”. Các request có cùng chi phí một token dù công việc downstream có thể khác nhau.
- Throttling không phải chống DDoS hoàn chỉnh: parser, socket và validation vẫn tiêu tốn tài nguyên trước admission. Không có quota theo IP, phân quyền, TLS hay metrics production.
- Không queue giúp phản hồi từ chối nhanh, nhưng caller phải chịu trách nhiệm retry. Không hoàn token khi downstream lỗi bảo vệ downstream khỏi retry storm, đổi lại request thất bại cũng tốn quota.

## Bài tập

1. Với `C=3`, `R=1500 ms`, gửi ba request tại t=0. Tính kết quả và Retry-After tại t=499, t=1500, t=1501; viết test clock giả trước khi chạy thử.
2. Chứng minh bằng test rằng đổi chính sách thành xóa bucket idle dù chưa đầy sẽ cho phép vượt quota. Sau đó khôi phục điều kiện an toàn.
3. Thiết kế thứ tự admission khi ghép token bucket với bulkhead: nếu có token nhưng bulkhead đầy, có hoàn token không? Giải thích ảnh hưởng tới retry và downstream.
4. Phác thảo quota dùng state chung cho hai replica: chọn khóa từ danh tính đã xác thực, thao tác nguyên tử và hành vi khi store không khả dụng. Không cần triển khai cloud.

## Nguồn tham khảo

- [Azure Architecture — Throttling pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/throttling): mục đích điều tiết tải và lựa chọn phản hồi khi quá tải.
- [RFC 6585 §4 — 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#section-4): ngữ nghĩa 429; bài này chọn luôn gửi Retry-After khi cạn token.
- [RFC 9110 — Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after): chuẩn cho phép HTTP-date hoặc delay-seconds; ví dụ dùng số giây nguyên dương.
