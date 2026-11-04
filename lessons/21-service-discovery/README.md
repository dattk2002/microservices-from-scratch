# 21 — Service discovery và cân bằng tải phía client

Một client gọi tên logic `catalog`, nhưng địa chỉ tiến trình Catalog có thể đổi sau mỗi lần khởi động. Bài này xây registry trong bộ nhớ và client tự phân phối request. Hai Catalog chạy cùng một entrypoint, khác `INSTANCE_ID` và cổng. Ví dụ trả sản phẩm `tra-sen`, giá 42.000 đồng; không có thanh toán thật.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc nhánh 24**, npm và các dev dependency đã pin tại root (`npm ci` khi chuẩn bị môi trường có mạng). Runtime chỉ dùng built-in. Chạy từ root repository; không cần database, tài khoản hay credential.

Mở bốn terminal, mỗi dòng dưới đây là một tiến trình độc lập:

```bash
PORT=4300 node lessons/21-service-discovery/registry.mts
PORT=4301 INSTANCE_ID=catalog-a REGISTRY_URL=http://127.0.0.1:4300 node lessons/21-service-discovery/catalog.mts
PORT=4302 INSTANCE_ID=catalog-b REGISTRY_URL=http://127.0.0.1:4300 node lessons/21-service-discovery/catalog.mts
PORT=4303 REGISTRY_URL=http://127.0.0.1:4300 node lessons/21-service-discovery/client.mts
```

Sau khi registry có hai member, gọi liên tiếp:

```bash
curl --max-time 2 http://127.0.0.1:4300/services/catalog
curl --max-time 2 http://127.0.0.1:4303/product
curl --max-time 2 http://127.0.0.1:4303/product
```

Kết quả hai request cuối lần lượt có `instance: catalog-a`, `instance: catalog-b`. GET đầu tiên là cách quan sát registration hoàn tất; dòng JSON `{service,port}` chỉ báo listener đã mở, chưa khẳng định Catalog đăng ký thành công. `PORT=0` chọn cổng tạm và in cổng thực, dùng trong integration test. Dừng bằng Ctrl-C. Khi kill cưỡng bức, hãy quan sát registry tới khi member biến mất thay vì đoán một khoảng sleep.

| Biến | Mặc định | Giới hạn / nơi đọc |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Chỉ đúng địa chỉ này, cả ba service |
| `PORT` | 4300/4301/4303 | Số nguyên 0..65535, tương ứng registry/Catalog/client |
| `REGISTRY_URL` | `http://127.0.0.1:4300` | Catalog và client; origin loopback IPv4, cổng 1..65535 |
| `INSTANCE_ID` | `catalog-a` | Catalog; chữ thường đầu tiên, sau đó chữ/số/dấu `-`, tối đa 32 ký tự |
| `LEASE_MS` | 3000 | Catalog: số nguyên 1000..5000 ms |
| `CAPACITY` | 16 | Registry: số nguyên 1..256 registration đang sống |

Registry API cho phép lease 100..5000 ms để thử nghiệm expiry ngắn; Catalog tự quản lý chỉ cho 1000..5000 ms để chừa khoảng deadline renewal. URL phải đúng dạng `http://127.0.0.1:PORT`, không slash cuối, path, query, fragment, userinfo, hostname DNS hay HTTPS. Không có endpoint nhận URL từ request client rồi proxy theo URL đó. Redirect bị từ chối.

## Kiến trúc và quyền sở hữu

```text
Catalog a ---- register / renew / remove ----> Registry
Catalog b ---- register / renew / remove ----> Registry
Client    ---- resolve catalog -------------> Registry
Client    ---- GET product -----------------> a hoặc b
```

`registry.mts` là nguồn membership cho đúng một tên logic `catalog`. `model.mts` chứa lease và thuật toán round-robin, không mở listener. `transport.mts` gói deadline HTTP. `catalog.mts` phục vụ sản phẩm và quản lý lease của chính nó. `client.mts` resolve trước **mỗi** request, không giữ cache membership giữa request.

Registry dùng `performance.now()` đơn điệu, không dùng giờ lịch. Với lease L tại thời điểm t, registration sống khi `now < t + L`; bằng mốc hết hạn là đã chết. List, register, renew, remove đều dọn entry hết hạn trước khi thao tác. Do đó bộ nhớ không vượt capacity dù không có timer quét nền. GET list trả bản sao, sắp theo ID; không lộ token sở hữu.

Mỗi lần register thành công sinh UUID `owner` mới. ID đang sống không được register đè, kể cả cùng URL. Renew chỉ gia hạn lease của đúng ID và owner hiện tại, không đổi URL. Remove cũng phải khớp owner. Khi lease hết hạn hoặc đã remove, incarnation mới có thể đăng ký cùng ID; packet renew/remove trễ của incarnation cũ nhận 409, không thể hồi sinh hoặc xóa incarnation mới. Không nên log token hay coi đây là xác thực production: token là capability cục bộ, không có TLS hoặc định danh bên gửi.

Catalog renew sau mỗi L/3 kể từ lần thành công gần nhất, chỉ một request renewal tại một thời điểm. Renewal lỗi hoặc kết quả không chắc chắn làm Catalog đóng listener và thoát lỗi; không tự register lại hay replay write. Khi dừng bình thường, Catalog gửi remove một lần, best effort. Nếu remove không tới nơi thì lease tự hết hạn. Muốn phục hồi sau mất quyền sở hữu, khởi động lại sau khi lease cũ hết hạn; registry không cho cưỡng đoạt ID.

Client giữ ID đã chọn gần nhất, chọn ID nhỏ nhất lớn hơn nó trong snapshot hiện tại, hết danh sách thì quay về đầu. Với tập ổn định `[a,b]`: a,b,a,b. Nếu b rời sau khi chọn a, request sau quay về a; member mới xuất hiện tham gia ngay snapshot sau. ID so sánh theo thứ tự ký tự, độc lập thứ tự phản hồi registry. Mỗi client process có cursor riêng; đây không phải cân bằng tải toàn cụm hay theo trọng số. Request đồng thời có thứ tự chọn theo lúc discovery hoàn tất, không theo lúc caller gửi.

## Hợp đồng HTTP và lỗi

Tất cả JSON response có `cache-control: no-store`. Registry write nhận `Content-Type: application/json`, body tối đa 8192 byte qua helper chung.

| Endpoint | Body / response thành công | Lỗi chính |
| --- | --- | --- |
| Registry `GET /services/catalog` | 200 `{members:[{id,url}]}` | Danh sách có thể rỗng |
| Registry `POST /registrations` | `{id,url,lease}` → 201 `{id,url,owner,expires}` | 400 dữ liệu sai; 409 ID đang sống; 503 đầy |
| Registry `POST /renew` | `{id,owner,lease}` → 200 `{ok:true}` | 409 hết lease hoặc sai owner |
| Registry `POST /remove` | `{id,owner}` → 200 `{ok:true}` | 409 hết lease hoặc sai owner |
| Catalog `GET /product` | 200 `{instance,product,price}` | 404 route/method khác |
| Client `GET /product` | 200 response Catalog đã chọn | 503 `discovery_unavailable` |

Route/method không hỗ trợ trả 404; JSON hỏng trả 400, media type sai 415, quá lớn 413. `expires` chỉ là mốc đơn điệu nội bộ registry, không phải timestamp UTC để client diễn giải. ID hoặc owner không hợp lệ không có quyền thay đổi membership.

Mỗi outbound fetch có deadline **400 ms**, bao gồm đọc body, và không follow redirect. Client tuần tự thực hiện discovery rồi một Catalog call: ngân sách outbound tối đa khoảng 800 ms cộng xử lý/lập lịch. Hết membership, registry outage, response registry sai, Catalog chết/treo hoặc non-2xx đều cho 503 rõ ràng; không thử member thứ hai trong cùng request. Không retry write, không giữ stale registry cache vô hạn. Helper HTTP chung đặt timeout request/header 5 giây và đóng connection sau shutdown tối đa khoảng 1 giây. Đây là deadline thực hành, không bảo đảm hard realtime khi event loop bị nghẽn.

## Kiểm thử và bằng chứng

Chạy kiểm tra không mở listener:

```bash
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/21-service-discovery/test/lesson.test.mts
```

Các unit assertion được viết trước implementation: đã quan sát sai số lượng member `0 !== 1`, thiếu exception validation và thứ tự chọn b thay vì a; sau triển khai chúng pass. Đồng hồ tiêm vào kiểm tra đúng biên expiry, renewal, capacity, removal, token cũ và membership đổi, không chờ thời gian thực. Import test tạo child với cấu hình cố ý sai, yêu cầu exit 0 và stdout/stderr rỗng cho cả ba entrypoint. Tất cả config, listener, signal handler và timer chỉ chạy trong `main()` được chặn bằng `import.meta.main`.

Trong môi trường cho phép HTTP loopback, controller chạy:

```bash
node --test --test-timeout=15000 lessons/21-service-discovery/test/lesson.test.mts
npm run check
make test
git diff --check
```

Integration test dùng `test/support.mts`: child riêng, cổng 0 và cleanup trong `finally`. Test chờ membership qua polling có deadline 5 giây, không dùng sleep để giả định đăng ký/hết hạn đã xong. Nó kiểm tra a/b luân phiên, kill a không deregister, request lỗi hữu hạn trong lúc lease còn sống, expiry loại a, incarnation thay thế có URL mới được sử dụng, b shutdown được loại, và registry outage trả 503. Test HTTP còn kiểm tra rỗng, capacity, remove đúng owner và stale renew/remove không xóa incarnation mới. Fixture lỗi dùng ID/URL/lease hợp lệ; không dùng validation sai làm bằng chứng cho ownership hay capacity.

Không có SQLite hoặc file fixture nên không cần thư mục tạm. Nếu mở rộng fixture cần file, dùng `node:os.tmpdir()` và cleanup, không ghi vào source read-only của Docker. Worker mạng bị chặn chỉ chạy typecheck/unit; **integration và full HTTP suite chưa chạy trong worker**, controller phải xác minh trước công bố.

## Giới hạn và đánh đổi

Lease **không chứng minh sức khỏe**. Catalog vẫn có registration sống sau khi chết, treo, hoặc mất mạng, đến khi lease hết hạn. Client có thể nhận 503 trong cửa sổ đó. Ngược lại, instance khỏe nhưng renewal thất bại bị loại hoặc tự đóng để tránh tiếp tục phục vụ với quyền sở hữu không rõ ràng. Lease ngắn giảm stale window nhưng tăng traffic renewal và nhạy với event-loop pause.

Registry là single point of failure, bộ nhớ mất hết sau restart. Không cache giúp hành vi dễ hiểu và không đi stale vô hạn, nhưng mọi request phụ thuộc registry và thêm một round trip. Registry restart làm Catalog nhận lỗi renewal và dừng; phải khởi động lại Catalog. Không có persistence, replication, fencing với tài nguyên ngoài, health probing, service namespace đa tenant hay bảo vệ người dùng loopback độc hại. Loopback-only giảm phạm vi demo, không biến local process thành bên đáng tin trong máy dùng chung.

Đây là registry dạy học, **không phải DNS, Consul hoặc Kubernetes**. Production cần mô hình bảo mật, discovery có sẵn của nền tảng, chính sách stale cache hữu hạn, quan sát lỗi và lựa chọn fail-open/fail-closed phù hợp. Không dùng registry này làm control plane thực tế.

## Bài tập

1. Với chuỗi member `[a,c] → [a,b,c] → [b]`, viết bảng lựa chọn và unit assertion trước khi thay thuật toán. Đánh giá độ công bằng khi nhiều client cùng khởi động.
2. Thiết kế cache tối đa 200 ms: chỉ ra lúc nào trả 503 nếu registry outage, không cho phép stale fallback vô hạn. Viết test đồng hồ giả trước.
3. Phân biệt liveness probe, readiness và lease; giải thích vì sao một lần `/product` timeout chưa đủ quyền xóa registration của tiến trình khác.
4. Mô phỏng registry restart và so sánh việc restart Catalog có kiểm soát với tự động replay registration sau một response bị mất. Điều gì cần thêm để replay an toàn?

## Tham khảo

- [Client-side service discovery — microservices.io](https://microservices.io/patterns/client-side-discovery.html)
- [Service registry — microservices.io](https://microservices.io/patterns/service-registry.html)
- [Node.js performance.now](https://nodejs.org/api/perf_hooks.html#performancenow)
- [Node.js AbortSignal.timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)
