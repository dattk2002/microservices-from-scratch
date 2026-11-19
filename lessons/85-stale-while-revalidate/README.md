# Cache stale-while-revalidate, single-flight và giới hạn độ cũ

Khi một bản cache vừa hết hạn, client có thể dùng bản cũ trong lúc cache đọc lại
origin. Nếu mọi client đều tự khởi động một lượt đọc, đợt truy cập đông vẫn dồn
tải về origin đúng lúc TTL hết hạn. Bài này dùng chung một lượt đọc đang chạy
(single-flight) và đặt giới hạn riêng cho việc trả bản cũ khi refresh thất bại.

## Chạy hai tiến trình

Cần Node.js 24.12 trở lên trong dòng 24.x và hai terminal ở thư mục gốc của repo.
Hai tiến trình chỉ dùng API tích hợp sẵn của Node.js. Chạy `npm ci` ở thư mục
gốc nếu cần cài công cụ phát triển để kiểm tra kiểu.

Terminal 1 chạy origin với một tệp SQLite riêng. Biến `db_dir` còn trong shell
sau khi dừng Node bằng Ctrl+C. Chạy lại lệnh cuối với cùng `DB_PATH` để giữ
phiên bản đã ghi. Thoát shell sẽ dọn thư mục tạm của ví dụ.

```bash
db_dir=$(mktemp -d) || exit 1
trap 'rm -rf -- "$db_dir"' EXIT
HOST=127.0.0.1 PORT=3085 DB_PATH="$db_dir/origin.sqlite" node lessons/85-stale-while-revalidate/origin.mts
```

Terminal 2 chạy cache. Dừng và chạy lại cache sẽ làm trống bản lưu trong RAM.

```bash
HOST=127.0.0.1 PORT=4085 ORIGIN_ORIGIN=http://127.0.0.1:3085 node lessons/85-stale-while-revalidate/cache.mts
```

| Biến | Origin | Cache |
| --- | --- | --- |
| `HOST` | Mặc định `127.0.0.1` | Mặc định `127.0.0.1` |
| `PORT` | Mặc định `3085` | Mặc định `4085` |
| `DB_PATH` | Mặc định `swr-origin.sqlite`. Mỗi origin dùng tệp riêng. | |
| `ORIGIN_ORIGIN` | | Bắt buộc. Dùng `http://127.0.0.1` với cổng tùy chọn và có thể có dấu `/` cuối. |

`PORT=0` yêu cầu hệ điều hành chọn cổng trống. Khi listener sẵn sàng, mỗi tiến
trình in một dòng JSON như `{"service":"swr-origin","port":3085}`. Dùng cổng
origin nhận được để cấu hình cache. Cache chuẩn hóa URL một lần lúc khởi động
và chỉ gọi đường dẫn `/value` của origin đó. Cấu hình được đọc trong `main()`,
nên import entrypoint không mở tệp SQLite, mở listener hay đăng ký signal.

## API và ví dụ

| Tiến trình | Yêu cầu | Phản hồi thành công |
| --- | --- | --- |
| Origin | `GET /value` | `200 {"version":0,"value":0}` lúc khởi tạo |
| Origin | `PUT /value` với JSON có đúng một trường `value`, số nguyên từ 0 đến 100 | `200 {"version":1,"value":42}` sau lần đổi đầu tiên sang 42 |
| Origin | `GET /stats` | `200 {"reads":N}`, số lượt origin phục vụ `GET /value` kể từ lúc khởi động |
| Cache | `GET /value` | `200 {"version":1,"value":42,"state":"fresh"}`, với `state` là `fresh`, `stale` hoặc `stale-if-error` |

Mỗi lần giá trị thực sự đổi, SQLite cập nhật giá trị và tăng `version` trong
cùng một câu lệnh có điều kiện. Origin đọc hết kết quả `RETURNING` để SQLite
hoàn tất commit trước khi trả 200. Nếu commit lỗi, origin trả
`500 internal_error`. Ghi lại giá trị hiện tại giữ nguyên `version`,
kể cả ở phiên bản 16. Yêu cầu đổi sang giá trị khác sau mốc đó trả
`409 revision_exhausted`. Với cùng tệp DB, restart giữ nguyên cặp
`{version,value}`. Bộ đếm `reads` ở RAM, không đếm PUT hay các lần đọc từ RAM
của cache và bão hòa tại `Number.MAX_SAFE_INTEGER`.

```bash
origin=http://127.0.0.1:3085
cache=http://127.0.0.1:4085

curl -sS "$cache/value"; printf '\n'
curl -sS -X PUT "$origin/value" -H 'Content-Type: application/json' -d '{"value":42}'; printf '\n'
curl -sS "$origin/value"; printf '\n'
curl -sS "$cache/value"; printf '\n'
curl -sS "$origin/stats"; printf '\n'
```

Lần đọc cache sau PUT có thể vẫn trả phiên bản 0. Trong 100 ms đầu bản đó
mang trạng thái `fresh`. Một GET trong cửa sổ kế tiếp lên lịch refresh và
trả ngay bản `stale`. GET sau khi refresh hoàn tất có thể thấy phiên bản 1.
Nếu tương tác bằng tay bỏ qua cửa sổ stale, GET sẽ chờ refresh và trả thẳng
phiên bản 1. Các unit test dùng đồng hồ giả để tái hiện cả hai đường đi.

Endpoint từ chối query string. GET không nhận body. PUT yêu cầu
`application/json` và giới hạn body ở 8192 byte. Query thừa, JSON sai cú pháp
hoặc body sai cấu trúc tạo lỗi `400`. Content type sai trả `415`, body quá
lớn trả `413`, đường dẫn không tồn tại trả `404` và method không hỗ trợ trả
`405`. Mọi lỗi ứng dụng dùng cùng envelope, ví dụ
`{"error":{"code":"upstream_failure","message":"upstream_failure"}}`.

## Luồng đọc và các mốc tuổi

```text
PUT /value ───────────────► origin ──► SQLite riêng
                               ▲
                               │ GET /value
                               │ tối đa một lượt đang chạy mỗi cache
GET /value ───────────────► cache ───► một bản lưu trong RAM
```

Tuổi bản lưu bằng thời gian monotonic hiện tại trừ thời điểm lượt lấy thành
công gần nhất đã đọc xong toàn bộ body và xác thực snapshot. Với
`freshFor = 100 ms`, `staleWhileRevalidate = 400 ms` và
`staleIfError = 1000 ms` tính từ cuối thời gian fresh, giới hạn trên của mỗi
cửa sổ là mốc loại trừ.

| Tuổi của bản lưu | Hành vi |
| --- | --- |
| `0 ≤ tuổi < 100 ms` | Trả `200 fresh` ngay từ RAM. |
| `100 ≤ tuổi < 500 ms` | Trả `200 stale` ngay, khởi động hoặc dùng chung refresh nền. |
| `tuổi ≥ 500 ms` | Chờ một lượt refresh, kể cả khi lượt đó bắt đầu ở nhánh nền. Thành công trả `200 fresh`. |
| Khi refresh đang được chờ thất bại và tuổi **lúc thất bại** `< 1100 ms` | Có thể trả `200 stale-if-error` nếu lỗi cho phép fallback. |
| Khi refresh đang được chờ thất bại và tuổi **lúc thất bại** `≥ 1100 ms` | Trả `502 upstream_failure`. |

Ở đúng 100 ms, GET trả `stale`. Ở đúng 500 ms, GET phải chờ. Nếu GET bắt
đầu ở 1099 ms nhưng refresh thất bại ở 1100 ms, bản cũ đã quá giới hạn và GET
trả 502. Cache rỗng luôn chờ origin. Cache không lưu kết quả lỗi. Nếu bản
cũ còn trong RAM sau mốc 1100 ms, nó vẫn được dùng để đối chiếu phiên bản,
còn muốn trả dữ liệu thì phải refresh thành công.

`value-cache.mts` nhận hàm fetch và hàm đọc đồng hồ. Trong tiến trình thật,
`performance.now()` cung cấp thời gian monotonic nên việc chỉnh giờ hệ thống
không làm dịch các mốc tuổi. Các GET cùng dùng một promise đang chạy. Promise
được xóa sau cả thành công lẫn thất bại. Nhánh nền gắn xử lý rejection để
GET đã trả xong không tạo unhandled rejection. Refresh thất bại giữ nguyên
bản lưu và mốc thành công trước đó. Timer duy nhất của mỗi lượt lấy dùng
để giới hạn thời gian I/O. Mọi refresh xuất phát từ một GET.

## Ranh giới với origin và khi dừng tiến trình

Một lượt fetch chỉ có một ngân sách 500 ms từ trước khi gửi đến khi đã đọc
và xác thực toàn bộ JSON. Cache dùng cả timer hủy fetch lẫn so sánh
monotonic khi quan sát tiến độ. Đúng 500 ms đã hết hạn, kể cả khi callback
của timer chưa chạy. Cache chặn redirect, yêu cầu `Accept-Encoding: identity`
và từ chối encoding khác. Nó đọc tối đa 8192 byte JSON, yêu cầu HTTP 200
với media type `application/json`, UTF-8 hợp lệ và đúng hai trường số nguyên
`version` (0–16) và `value` (0–100).

Lỗi kết nối, deadline, status ngoài hợp đồng hoặc body sai làm lượt lấy thất
bại. Với bản cũ đủ điều kiện, cache có thể trả `stale-if-error`. Cache rỗng
hoặc hết cửa sổ fallback trả 502. Nếu origin trả phiên bản thấp hơn bản đang
giữ, hoặc trả cùng phiên bản với giá trị khác, cache từ chối snapshot. GET đang
chờ lượt đó nhận 502 ngay cả khi còn thời gian fallback. Một GET đã lấy bản
`stale` vẫn giữ phản hồi đã gửi. Cùng phiên bản và cùng giá trị là một
refresh thành công và bắt đầu lại thời gian fresh.

Khi nhận SIGINT hoặc SIGTERM, cache ngừng nhận kết nối, abort lượt lấy đang
chạy và đợi nó kết thúc. Kết quả đến sau abort không thể cập nhật RAM. Origin
đóng SQLite khi listener dừng. Nếu khởi động listener thất bại sau khi mở
database, origin dọn SQLite ngay từ nhánh lỗi.

## Giới hạn và đánh đổi

RFC 5861 mô tả hai phần mở rộng HTTP `stale-while-revalidate` và
`stale-if-error`. Bài này áp dụng ý tưởng
cho tuổi của một bản lưu ứng dụng. Phản hồi API dùng `Cache-Control: no-store`.
Một shared HTTP cache theo chuẩn còn phải xét độ tuổi HTTP, chỉ thị cache,
khóa biến thể và các quy tắc tái xác thực. Trạng thái `fresh` ở đây biểu thị
độ tuổi cục bộ và vẫn có thể đi sau một PUT vừa thành công.

Single-flight giảm số lần đọc đồng thời trong một tiến trình. Mỗi replica tự
điều phối lượt đọc, nên N replica có thể tạo N lượt đọc song song và giữ N
bản ở các thời điểm refresh khác nhau. Điều phối giữa các tiến trình bằng
distributed lock và bảo đảm đồng bộ tức thời cần cơ chế riêng cho từng mục
tiêu. Khi origin đọc lỗi nhanh, nhiều GET liên tiếp có thể bắt đầu nhiều
lượt thử lại tuần tự. Giới hạn stale không tự tạo backoff hay giới hạn tổng
lưu lượng. Với dữ liệu phân quyền, trả bản cũ có thể tiếp tục cho phép truy
cập đã bị thu hồi. Với giao dịch hoặc số dư, một snapshot cũ có thể khiến
client quyết định sai. Chính sách stale cần dựa trên hậu quả của sai lệch
và yêu cầu nhất quán của dữ liệu.

## Kiểm chứng và bài tập

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/85-stale-while-revalidate/test/lesson.test.mts
node --test --test-timeout=15000 lessons/85-stale-while-revalidate/test/lesson.test.mts
```

Unit test ghìm lần fetch bằng promise do test điều khiển, kiểm tra các mốc
99/100/499/500/1099/1100 ms và xác nhận thời gian fresh bắt đầu sau khi refresh
hoàn tất. Bộ HTTP test chạy các tiến trình riêng trên cổng tạm, kiểm tra lỗi
commit và đọc bản ghi từ kết nối SQLite khác trước khi dừng origin. Sau khi
restart, cache phải lấy được phiên bản thấp hơn từ fixture vì tiến trình mới
không còn bản lưu để đối chiếu. Để kiểm tra single-flight khi origin lỗi,
fixture giữ phản hồi đầu tiên mở đến deadline. Mười GET đồng thời phải nhận
502 từ cùng một lượt đọc. Bộ test cũng kiểm tra outage, redirect và các body
JSON hợp lệ có kích thước vượt giới hạn hoặc chưa kết thúc.

1. Dùng đồng hồ giả và một fetcher thất bại nhanh để đo số lượt thử khi nhiều
   GET đến liên tiếp. Thử thêm backoff và giữ nguyên mốc 1100 ms.
2. Chạy hai cache với hai cổng khác nhau trỏ về cùng origin. So sánh `state`
   và `reads` khi cả hai vừa hết thời gian fresh.
3. Tạo trường hợp một client PUT xong rồi GET qua cache. Nêu cách API có thể
   biểu đạt yêu cầu đọc ít nhất một phiên bản mà vẫn giữ số lượt fetch hữu hạn.

## Tài liệu gốc

- IETF RFC 5861 về các phần mở rộng điều khiển độ cũ của HTTP cache. [RFC 5861](https://www.rfc-editor.org/rfc/rfc5861.html)
- Node.js Performance Hooks về thời gian tương đối của tiến trình. [`performance.now()`](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#performancenow)
- Node.js SQLite về `DatabaseSync` và prepared statement. [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

Client mặc định dùng `node:http.request` với đúng một HTTP attempt, agent riêng, không proxy môi trường, không retry 421, không redirect hoặc tự giải nén. Header upstream có giới hạn 8 KiB và giữ toàn bộ trường trong giới hạn đó; Content-Type/Encoding/Length, ETag và Content-Range lặp bị từ chối trước khi tạo Response. Body vẫn được đọc theo stream bằng cầu nối tích hợp `Readable.toWeb` dưới deadline và giới hạn riêng đã nêu. Dịch vụ giữ toàn bộ header inbound trong giới hạn byte của HTTP parser, tránh mất metadata trên Node 24.12.
