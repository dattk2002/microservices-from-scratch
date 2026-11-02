# 16 — Cache-aside, TTL và chống cache stampede

Bài này thêm một bản sao tạm thời trước Catalog: đọc nhanh khi dữ liệu còn hạn,
nhưng vẫn coi Catalog là chủ sở hữu dữ liệu. Ví dụ ba sản phẩm `a`, `b`, `c` có
giá nguyên không âm (đơn vị quy ước) và phiên bản tăng sau mỗi cập nhật.
Không có thanh toán, tài khoản hoặc dịch vụ bên ngoài.

## Chuẩn bị và chạy

Cần Node.js **24.12+ thuộc dòng 24**, npm và các development dependency đã ghim
ở root. Đọc bài về HTTP contract, deadline và bulkhead trước bài này.
Từ root repository, mở hai terminal:

```sh
PORT=4611 node lessons/16-cache-aside/catalog.mts
CATALOG_URL=http://127.0.0.1:4611 PORT=4612 node lessons/16-cache-aside/reader.mts
```

Mỗi process in một dòng JSON chứa `service` và `port` khi sẵn sàng; Ctrl-C dừng
process. Có thể đặt `PORT=0` để OS cấp cổng và dùng cổng được in cho `CATALOG_URL`.
Các lệnh sau minh họa stale read (thực hiện hai lần GET gần nhau, trong 2 giây):

```sh
curl http://127.0.0.1:4612/products/a
curl -X PUT http://127.0.0.1:4611/products/a \
  -H 'content-type: application/json' -d '{"price":250}'
curl http://127.0.0.1:4612/products/a
# Chờ hơn 2 giây rồi đọc lại: price=250, version=2.
curl http://127.0.0.1:4612/products/a
```

Catalog ban đầu trả `{"id":"a","price":100,"version":1}`. PUT thành công trả
bản mới; cached-reader không có API cập nhật hay kho dữ liệu dùng chung với Catalog.
Các file `.mts` chạy trực tiếp bằng khả năng type stripping của Node, không cần build.

## Kiến trúc và chính sách dữ liệu

```text
Client ──GET──> cached-reader process
                  │ cache còn hạn → trả bản sao immutable
                  │ miss → join load cùng khóa, hoặc dành một slot mới
                  └──── HTTP + deadline ──> Catalog process → source Map riêng
Client ─────────────────── PUT ───────────> Catalog
```

1. Hit khi `now < expires`; đúng tại `now === expires` là miss. Clock runtime là
   `performance.now()` đơn điệu, không phụ thuộc chỉnh giờ hệ thống.
2. TTL bắt đầu **sau khi tải và kiểm tra thành công**. Hit không kéo dài TTL.
   Khi hết hạn không trả stale, kể cả lúc Catalog hỏng: request nhận lỗi tải mới.
3. Entry được truy cập gần nhất chuyển về cuối Map. Khi lưu mà đầy, loại entry
   ít được dùng gần đây nhất (LRU). Lúc ghi cũng quét bỏ entry hết hạn; không có
   timer quét nền. Entry hết hạn chưa truy cập có thể vẫn chiếm bộ nhớ nhưng tổng
   số entry luôn bị chặn. Eviction có thể khiến dữ liệu được làm mới sớm hơn TTL.
4. Nhiều miss cùng khóa dùng chung promise. Khóa mới vượt `MAX_LOADS` nhận 503
   ngay, không xếp hàng. Join cùng khóa vẫn được nhận khi hết slot. `finally`
   giải phóng slot cả thành công lẫn lỗi; exception không trở thành cache value.
5. Mỗi upstream load có deadline bao gồm fetch và toàn bộ body. Body tối đa
   8192 byte; chỉ nhận HTTP thành công, JSON, đúng id, giá nguyên an toàn >=0,
   version nguyên an toàn >=1. Chỉ giữ các trường đã kiểm tra và đóng băng object.

Nguồn có thể đổi ngay sau một lần tải: reader có thể stale đến hết TTL tính từ
lúc hoàn tất tải, cộng thời gian truyền response. Đây không phải cam kết dữ liệu
mới nhất hay snapshot đồng bộ giữa các khóa. PUT Catalog không tự invalidation.
Catalog demo và cache đều ở RAM **riêng từng process**; restart reader mất cache,
restart Catalog đặt dữ liệu về seed. Không gọi cache là nguồn authoritative.

## Cấu hình và HTTP contract

| Biến | Mặc định | Phạm vi |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Địa chỉ bind của từng process |
| `PORT` | Catalog 4611, reader 4612 | 0..65535 |
| `CATALOG_URL` | `http://127.0.0.1:4611` | HTTP origin không credential/path/query/hash |
| `TTL_MS` | 2000 | 1..100000 |
| `CACHE_ENTRIES` | 2 | 1..1000 |
| `MAX_LOADS` | 2 | 1..1000 khóa đang tải |
| `DEADLINE_MS` | 800 | 1..10000 |
| `TEST_CONTROLS` | tắt | Chỉ `1` mở control/stats để kiểm thử |

Các biến số dùng số nguyên thập phân; cấu hình reader sai bị từ chối trước listen.
Catalog/reader hỗ trợ GET `/products/a`, `/products/b`, `/products/c`; Catalog
thêm PUT cùng đường dẫn với JSON `{ "price": 250 }`. PUT đọc tối đa 8192 byte,
đòi content-type JSON, trả 200. Trường thừa bị bỏ qua. Không hỗ trợ query sản phẩm.

| Kết quả | HTTP / code |
| --- | --- |
| Đọc thành công, cả hit và miss | 200 / `{id,price,version}` |
| Khóa/route không tồn tại | 404 / `not_found` |
| Method không hỗ trợ | 405 và header `Allow` |
| Query không hỗ trợ, PUT sai dữ liệu/JSON | 400 |
| PUT sai content-type / body quá lớn | 415 / 413 |
| Vượt số khóa đang tải | 503 / `cache_busy`, `Retry-After: 1` |
| Catalog trả non-2xx | 502 / `upstream_failed` |
| Catalog mất kết nối, sai JSON/schema/content-type, redirect, body quá lớn | 502 / `invalid_upstream` |
| Hết deadline tải | 504 / `deadline_exceeded` |

Lỗi có dạng `{"error":{"code":"…","message":"…"}}`; response dùng
`Cache-Control: no-store` để trình duyệt/proxy không thêm tầng cache ngoài bài.
Không retry tự động. Client bỏ kết nối không hủy shared load: các waiter khác
vẫn cần nó; load tiếp tục đến thành công hoặc deadline riêng của nó.

## Kiểm chứng

Từ root, worker không cần mở listener để chạy:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern='unit:' lessons/16-cache-aside/test/lesson.test.mts
```

Unit test dùng clock tiêm vào và deferred promise để kiểm tra đúng biên TTL,
TTL từ thời điểm hoàn tất, LRU, gộp miss, đầy slot, giải phóng sau lỗi async/sync,
không cache lỗi, validation và cấu hình giới hạn. Bản khung không cache đã được
chạy trước implementation và thất bại assertion hit `2 !== 1`.

Controller có môi trường loopback riêng chạy HTTP thật:

```sh
node --test --test-timeout=15000 lessons/16-cache-aside/test/lesson.test.mts
npm run check
make test
git diff --check
```

Test integration chỉ khởi động service bên trong callback test, dùng child process
độc lập, `HOST=127.0.0.1`, `PORT=0`, deadline cho request, và teardown dừng mọi
child kể cả khi assertion lỗi. Barrier poll trạng thái có hạn thời gian: Catalog
`active=1` chứng minh upstream đang giữ request; reader `joined=1` chứng minh
request thứ hai đã join trước khi mở barrier. Không suy luận concurrency chỉ từ
việc gọi `Promise.all`. Kiểm tra hit không tăng `calls`, overload không vào Catalog,
PUT vẫn stale trước TTL và reload sau TTL, lỗi/schema sai phục hồi, deadline hủy
upstream và trả slot. Chờ hơn TTL ở test HTTP chỉ kích hoạt expiry; tính đúng tại
biên đã được kiểm tra bằng clock giả.

Chỉ khi `TEST_CONTROLS=1`: POST Catalog `/control?mode=hold|open|fail|malformed`,
GET Catalog `/stats` trả `{calls,active}`; GET reader `/stats` trả
`{entries,inFlight,joined}`. `hold` giữ đến open, socket close hoặc tối đa 10 giây;
`fail` trả 503; `malformed` trả JSON sai schema. Đây là cơ chế test, không phải API
quản trị production; không bật nó trên môi trường có client không tin cậy.
Worker sandbox không chạy HTTP integration, `npm run check` hay `make test` vì
các lệnh đó mở listener; kết quả HTTP phải do controller xác minh.

## Đánh đổi, giới hạn và bài tập

- Cache và single-flight chỉ có hiệu lực trên **một instance**. Hai reader lạnh
  có thể cùng tải một khóa; triển khai nhiều replica hoặc restart đồng loạt vẫn
  tạo stampede. TTL jitter, prewarm có kiểm soát hoặc phối hợp distributed có
  thêm độ phức tạp và không được triển khai trong bài.
- Giới hạn entry không tương đương giới hạn byte cho mọi kiểu `T`; ở đây schema
  nhỏ cố định và chỉ có ba khóa. Giới hạn load không giới hạn số waiter/connection
  đến cùng khóa. Production cần admission tổng, giới hạn kết nối và quan sát tài
  nguyên, bên cạnh deadline. Cache lớp thuần yêu cầu loader tự có deadline;
  HTTP loader của reader thực hiện yêu cầu đó.
- Write-through/invalidation sự kiện có thể giảm stale nhưng tăng coupling,
  rủi ro mất sự kiện và race load cũ ghi lại sau invalidation. Không thêm endpoint
  xóa cache rồi mặc nhiên hứa consistency. Version và cơ chế invalidation phải
  được thiết kế cùng nhau nếu yêu cầu mạnh hơn.
- Không dùng cache này để quyết định tồn kho cuối cùng, phân quyền, số dư, hay
  nghiệp vụ không chấp nhận stale. Với dữ liệu ít đọc lại hoặc thay đổi liên tục,
  chi phí vận hành cache có thể lớn hơn lợi ích. Catalog vẫn cần persistence và
  kiểm soát đồng thời riêng nếu tiến tới production.
- Bài tập: chạy hai reader và đo hai miss độc lập; thêm thống kê hit/miss/eviction
  không chứa dữ liệu nhạy cảm; thiết kế test cho invalidation trùng với load;
  thử TTL jitter bằng nguồn ngẫu nhiên tiêm vào để unit test vẫn xác định.

Tham khảo chính thức: [Microsoft Azure Architecture — Cache-Aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside).
Đọc phần consistency và lifetime để đối chiếu với chính sách cụ thể trong bài,
không xem pattern như bảo đảm dữ liệu luôn mới.
