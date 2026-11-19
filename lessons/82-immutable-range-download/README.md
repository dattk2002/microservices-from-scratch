# Tải tiếp đối tượng bất biến bằng HTTP Range và If-Range

Khi một lần tải bị gián đoạn, client có thể giữ những byte đã nhận và yêu cầu phần còn lại bằng `Range`. Nếu phần đã lưu thuộc một biểu diễn khác, ghép nó với phần mới có thể tạo ra nội dung sai mà số byte vẫn khớp. Bài này dùng `If-Range` để gắn yêu cầu tải tiếp với một biểu diễn cụ thể và dùng SHA-256 để kiểm tra kết quả sau khi ghép.

## Chạy hai dịch vụ

Cần Node.js 24.12 trở lên trong dòng 24.x và `curl`. Chạy các lệnh từ thư mục gốc của repo. Hai dịch vụ chỉ dùng thư viện tích hợp của Node.js.

Terminal A mở kho đối tượng với một tệp SQLite riêng. Giữ shell này nếu muốn dừng rồi khởi động lại tiến trình để kiểm tra độ bền của dữ liệu.

```bash
DEMO_DB_DIR=$(mktemp -d)
trap 'rm -rf -- "$DEMO_DB_DIR"' EXIT
HOST=127.0.0.1 PORT=8082 DB_PATH="$DEMO_DB_DIR/objects.sqlite" \
  node lessons/82-immutable-range-download/object.mts
```

Terminal B chạy downloader với origin cố định.

```bash
HOST=127.0.0.1 PORT=8083 OBJECT_ORIGIN=http://127.0.0.1:8082 \
  node lessons/82-immutable-range-download/downloader.mts
```

Mỗi dịch vụ in một dòng JSON gồm `service` và `port` khi sẵn sàng. `HOST` mặc định là `127.0.0.1`. Cổng mặc định của kho là `8082`, của downloader là `8083`. Với `PORT=0`, hệ điều hành chọn cổng và bạn lấy cổng thật từ dòng JSON. Nếu đổi cổng của kho, dùng cổng đó trong `OBJECT_ORIGIN` và các lệnh tương ứng. `DB_PATH` phải trỏ tới một tệp SQLite riêng trong thư mục đã tồn tại. `OBJECT_ORIGIN` nhận URL HTTP của `127.0.0.1` với cổng tùy chọn và có thể có một dấu `/` cuối. URL được chuẩn hóa khi khởi động.

## Thử giao thức

Trong terminal C, tạo đối tượng gồm ba byte ASCII `abc`. Gọi lại cùng lệnh sẽ cho `200` với cùng ETag và kích thước. Thử đổi `abc` thành nội dung khác sẽ cho `409 immutable_conflict`.

```bash
curl -i -X PUT http://127.0.0.1:8082/objects/o0 \
  -H 'Content-Type: application/json' --data '{"text":"abc"}'
```

Lần tạo đầu tiên trả `201` với dữ liệu sau. ETag mạnh của bài là dấu ngoặc kép bao quanh 64 chữ số hex viết thường của SHA-256 trên toàn bộ byte UTF-8. Trong JSON, hai dấu ngoặc kép của ETag được escape.

```json
{"etag":"\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\"","size":3}
```

Xem toàn bộ đối tượng, rồi yêu cầu byte thứ hai đến hết. Chỉ số bắt đầu từ 0. Phản hồi thứ hai có trạng thái `206`, `Content-Range: bytes 1-2/3`, `Content-Length: 2` và body `bc`.

```bash
curl -i http://127.0.0.1:8082/objects/o0
curl -i http://127.0.0.1:8082/objects/o0 \
  -H 'Range: bytes=1-' \
  -H 'If-Range: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"'
```

Giả lập client đã giữ byte đầu tiên. Downloader gửi cùng yêu cầu tải tiếp, ghép `a` với `bc`, rồi chỉ trả nội dung sau khi hash khớp. Kết quả có `text: "abc"` và `resumed: true`.

```bash
curl -i http://127.0.0.1:8083/resume \
  -H 'Content-Type: application/json' \
  --data '{"id":"o0","prefix":"a","etag":"\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\""}'
```

Đổi `prefix` thành `abc` với cùng ETag. Kho trả `416` vì offset 3 đã bằng kích thước. Downloader đối chiếu kích thước, ETag, phong bì lỗi và hash của prefix rồi trả `200` với `resumed: true`. Lệnh dưới đây giả lập một checkpoint có ETag cũ. Kho bỏ qua `Range`, trả toàn bộ `abc` và downloader trả `resumed: false`.

```bash
curl -i http://127.0.0.1:8083/resume \
  -H 'Content-Type: application/json' \
  --data '{"id":"o0","prefix":"old","etag":"\"0000000000000000000000000000000000000000000000000000000000000000\""}'
```

## Hợp đồng HTTP

ID thuộc tập `o0` đến `o7`. Nội dung chỉ gồm ký tự ASCII in được từ `0x20` đến `0x7e`, kể cả khoảng trắng đầu và cuối. Các route từ chối query string. Hai route ghi nhận JSON với đúng các khóa được liệt kê.

| Dịch vụ và route | Đầu vào | Kết quả |
| --- | --- | --- |
| Kho · `PUT /objects/{id}` | `{text}`, dài 1–128 byte | `201 {etag,size}` khi tạo, `200` cùng kết quả khi phát lại đúng byte, `409 immutable_conflict` khi đổi nội dung |
| Kho · `GET /objects/{id}` | Header `Range` và `If-Range` tùy chọn | `200` toàn bộ hoặc `206` một đoạn, có `ETag`, `Accept-Ranges: bytes`, `Content-Length` và kiểu `application/octet-stream` |
| Downloader · `POST /resume` | `{id,prefix,etag}`, prefix dài 0–128 byte, ETag mạnh hoặc `null` nếu prefix rỗng | `200 {text,etag,resumed}` khi xác minh xong, `404 unknown_object` khi kho báo thiếu đối tượng đúng hợp đồng |

Kho hỗ trợ một đoạn `bytes=start-end` hoặc `bytes=start-`. Hai offset là số thập phân không âm ở dạng chuẩn, với chữ số 0 đứng một mình. Nếu `end` vượt kích thước, kho giảm nó xuống byte cuối. `Content-Range` dùng đầu cuối bao gồm cả hai biên, còn `Buffer.subarray(start, end + 1)` dùng chỉ số kết thúc loại trừ. ASCII làm số byte và độ dài chuỗi trùng nhau trong miền dữ liệu này. Mã cắt và ghép trên buffer để phép tính vẫn diễn ra theo byte.

Khi có `Range`, kho kiểm tra cú pháp của nó trước rồi kiểm tra `If-Range`. Bài chấp nhận ETag đúng dạng đã mô tả và dạng yếu có tiền tố `W/`. ETag mạnh khớp hoặc thiếu `If-Range` cho phép áp dụng đoạn. ETag khác hoặc validator yếu khiến kho gửi toàn bộ đối tượng. Chẳng hạn, với ba byte `abc`, `bytes=999-` cho `416` khi ETag khớp hoặc khi thiếu `If-Range`, còn ETag cũ cho `200`. Khi thiếu `Range`, kho bỏ qua `If-Range`.

`416` có ETag mạnh, `Content-Range: bytes */size` và body JSON `{"error":{"code":"range_not_satisfiable","message":"range_not_satisfiable"}}`. Kho dùng trạng thái này khi đoạn được áp dụng nhưng điểm bắt đầu nằm ngoài đối tượng hoặc điểm cuối nhỏ hơn điểm đầu. Cú pháp sai cho `400 invalid_range` hoặc `400 invalid_if_range`. Đây là tập con phục vụ bài học của RFC 9110. Cú pháp suffix như `bytes=-10`, nhiều khoảng trong một header, phản hồi multipart và ngày HTTP trong `If-Range` nằm ngoài tập con.

Các lỗi API có dạng `{"error":{"code":"<code>","message":"<code>"}}`. Đối tượng hợp lệ chưa tồn tại cho `404 unknown_object`. JSON sai cú pháp hoặc sai schema cho `400`, JSON vượt 8.192 byte cho `413`, kiểu nội dung đầu vào khác JSON cho `415`, và phương thức không hỗ trợ cho `405`.

## Quyết định ở downloader

Kho là tiến trình duy nhất mở tệp SQLite. Mỗi ID chứa một BLOB. Một câu lệnh `INSERT … ON CONFLICT DO NOTHING` xác định lần tạo đầu tiên mà không ghi đè dòng cũ. Nếu ID đã có, kho so chính xác byte với nội dung hiện tại để quyết định phát lại hay xung đột. Khi khởi động lại với cùng `DB_PATH`, byte được giữ nguyên và ETag được tính lại từ chính các byte đó.

Downloader nhận checkpoint qua JSON và gọi đúng một lần đến đường dẫn của ID tại origin đã cấu hình. Prefix rỗng gửi GET thường, kể cả khi caller đưa ETag. Prefix có byte gửi `Range: bytes=<số byte của prefix>-` và `If-Range: <etag>`. Downloader coi prefix do caller gửi là dữ liệu chưa xác minh.

| Kho trả về | Downloader làm gì |
| --- | --- |
| `200` | Dùng toàn bộ body mới và bỏ prefix cũ. Kiểm tra độ dài, kiểu byte và SHA-256 trước khi trả `resumed: false`. |
| `206` | Yêu cầu ETag đúng của prefix và khoảng chính xác từ `prefixByteLength` đến `total - 1`. Kiểm tra độ dài hậu tố, ghép và kiểm tra hash toàn bộ trước khi trả `resumed: true`. |
| `416` | Yêu cầu cùng ETag, tổng kích thước đúng bằng độ dài prefix và phong bì lỗi đúng hợp đồng. Sau khi hash của prefix khớp, trả `resumed: true`. |
| `404` | Chỉ chuyển tiếp `404 unknown_object` khi JSON có đúng mã lỗi, thông điệp và các trường được định nghĩa. |
| Lỗi kết nối, redirect, hết hạn, phản hồi sai hợp đồng | Trả `502 upstream_failure`. |

Một deadline đơn điệu 500 ms bao trùm kết nối, header, đọc hết body và xác minh. Timer hủy I/O đang chờ và các lần kiểm tra đồng hồ loại phản hồi đến muộn ngay cả khi callback timer chưa chạy. Mỗi body nhị phân có `Content-Length` và bị giới hạn ở 128 byte. Body lỗi JSON có trần riêng 8.192 byte, kể cả khi truyền từng chunk. Chỉ chấp nhận encoding vắng mặt hoặc `identity`. Redirect bị chặn trước khi gửi yêu cầu tới đích mới.

Downloader chấp nhận tham số `Content-Type` hợp lệ, với quy ước của bài là toàn bộ giá trị header không chứa dấu phẩy, kể cả trong tham số có ngoặc kép. Fetch có thể nối các trường `Content-Type` lặp bằng dấu phẩy, làm hai giá trị sai trông giống một tham số hợp lệ. Kho của bài luôn phát `Content-Type` không có dấu phẩy.

Đánh đổi của ví dụ là giữ cả checkpoint lẫn nội dung đã ghép trong bộ nhớ để kiểm tra nhanh và dễ đọc mã. Kho giới hạn tám ID, không có xóa hoặc ghi đè, và dùng SQLite đồng bộ. Downloader trả text trong JSON. Những lựa chọn đó phù hợp cho ví dụ 128 byte. Một thiết kế dành cho tệp lớn sẽ cần lưu phần tải xuống theo luồng, xử lý backpressure, phục hồi checkpoint trên đĩa và xác minh byte gia tăng. ETag xác nhận sự nhất quán với biểu diễn của kho. Nếu cần xác thực nguồn dữ liệu trong môi trường thực, nguồn hash và kết nối cũng phải được xác thực.

## Kiểm thử

Cài các dependency phát triển của repo bằng `npm ci`. Chạy các lệnh sau từ thư mục gốc.

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/82-immutable-range-download/test/lesson.test.mts
node --test --test-timeout=15000 lessons/82-immutable-range-download/test/lesson.test.mts
```

Unit test kiểm tra cú pháp, hợp đồng phản hồi, digest, ranh giới byte và deadline bằng đồng hồ tiêm vào hàm tải. Một lỗi SQLite được tạo trong bộ nhớ để kiểm tra tính nguyên tử. Integration test chạy dịch vụ trong các tiến trình độc lập với cổng tạm và SQLite trong thư mục tạm. Fixture HTTP kiểm tra upstream treo sau khi đã gửi một phần body, lỗi đúng cú pháp JSON nhưng sai mã, phản hồi quá lớn và bộ đếm yêu cầu tại origin đích của redirect.

## Bài tập

1. Dùng nội dung có hai dấu cách ở đầu và một dấu cách ở cuối. Viết ra byte, offset và header mong đợi trước khi thử `bytes=0-0`, `bytes=1-2` và đoạn có điểm cuối rất lớn.
2. Giữ nguyên ETag nhưng sửa một byte trong prefix. Quan sát việc xác minh khi kho trả `206` và khi kho trả `416`.
3. Dừng riêng tiến trình kho, chạy lại với cùng `DB_PATH` và đối chiếu byte cùng ETag. Thử dự đoán kết quả nếu khởi động bằng một tệp SQLite mới.
4. Phác thảo checkpoint bền vững cho tệp lớn. Xác định lúc nào ghi offset xuống đĩa, lúc nào xác minh digest và lúc nào công bố tệp hoàn chỉnh.

## Tài liệu tham khảo

- RFC 9110 mô tả Range, If-Range, Content-Range và phản hồi từng phần. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)
- Node.js mô tả API băm chuỗi byte và API SQLite đồng bộ. [Node.js Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) · [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)

Client mặc định dùng `node:http.request` với đúng một HTTP attempt, agent riêng, không proxy môi trường, không retry 421, không redirect hoặc tự giải nén. Header upstream có giới hạn 8 KiB và giữ toàn bộ trường trong giới hạn đó; Content-Type/Encoding/Length, ETag và Content-Range lặp bị từ chối trước khi tạo Response. Body vẫn được đọc theo stream bằng cầu nối tích hợp `Readable.toWeb` dưới deadline và giới hạn riêng đã nêu. Dịch vụ giữ toàn bộ header inbound trong giới hạn byte của HTTP parser, tránh mất metadata trên Node 24.12.
