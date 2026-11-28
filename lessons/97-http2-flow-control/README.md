# 97. Kiểm soát luồng HTTP/2 và backpressure theo stream

Gateway tải một đối tượng nhị phân từ provider mà vẫn giới hạn bộ nhớ và thời gian khi bên nhận đọc chậm. Mỗi lần tải thành công trả đúng 262144 byte. Provider sinh dữ liệu theo từng khối 4096 byte với công thức `(i ^ (i >>> 8)) & 255` cho byte tại vị trí `i`.

SHA-256 của đối tượng là `fe94555a98997280a2f45c43c8ef2a8aa1cf173f0f5c995d1a9d752d876b792c`.

## Chạy thử

Cần Node.js 24.12 đến hết nhánh 24.x. Chạy từ thư mục gốc repository. Hai tiến trình chỉ dùng thư viện chuẩn Node.js.

Terminal 1

```sh
HOST=127.0.0.1 PORT=9797 node lessons/97-http2-flow-control/provider.mts
```

Terminal 2

```sh
HOST=127.0.0.1 PORT=9798 PROVIDER_ORIGIN=http://127.0.0.1:9797 \
  node lessons/97-http2-flow-control/gateway.mts
```

Terminal 3

```sh
curl --max-time 3 --fail --silent --show-error http://127.0.0.1:9798/blob |
  sha256sum
curl --max-time 3 --fail --silent --show-error http://127.0.0.1:9798/health
curl --max-time 3 --fail --silent --show-error http://127.0.0.1:9798/stats
node --test lessons/97-http2-flow-control/test/lesson.test.mts
```

Bash `set -o pipefail` giúp lệnh kiểm tra SHA-256 báo lỗi nếu `curl` nhận thiếu dữ liệu. `PORT=0` yêu cầu hệ điều hành cấp cổng tạm. Mỗi tiến trình in một dòng JSON chứa cổng thực tế khi sẵn sàng. Gateway chấp nhận một origin HTTP cho h2c qua `PROVIDER_ORIGIN`. Provider dùng HTTP/2 rõ văn bản với prior knowledge, phù hợp cho loopback trong bài này.

## Đường đi của dữ liệu

```text
HTTP/1 client  ── GET /blob ──> gateway  ── GET /blob (h2c) ──> provider
               <── 200 + DATA ──         <── 200 + DATA + trailer ──
```

Provider kiểm tra chỗ trống trước khi sinh byte. Khi `stream.write()` trả `false`, chính khối đó đã được giao cho writable của Node. Vòng lặp giữ tối đa khối 4096 byte hiện tại và dừng lấy khối kế tiếp tới `drain` hoặc hủy. Các khối đã giao trước đó vẫn có thể nằm trong bộ đệm của Node. Gateway cũng dừng lấy chunk từ iterator của upstream khi `res.write()` trả `false`. Việc dừng áp dụng cho stream, không gọi `pause()` trên socket. Một phiên upstream dành riêng cho mỗi lượt tải giúp hủy phiên mà không làm gián đoạn lượt tải khác. Đổi lại, mỗi lượt phải thiết lập phiên mới.

Ba giới hạn tác động ở các tầng khác nhau.

- HTTP/2 `initialWindowSize=16384` là cửa sổ ban đầu **theo stream**, do bên nhận quảng bá để giới hạn DATA được gửi cho mình. Gateway quảng bá giá trị này cho hướng tải xuống. Provider cũng quảng bá giá trị này cho hướng request, dù các route trong bài không nhận body. Client thử nghiệm có thể quảng bá cửa sổ 4096 byte.
- Cửa sổ **theo phiên** chia sẻ tín dụng giữa các stream. Giá trị ban đầu theo RFC là 65535 byte. DATA cần tín dụng ở cả hai cửa sổ. `WINDOW_UPDATE` trên stream ID 0 cấp lại tín dụng theo phiên, còn ID khác 0 cấp tín dụng cho stream tương ứng.
- `writableHighWaterMark` là ngưỡng bộ đệm ghi cục bộ của Node. Đây là tín hiệu yêu cầu producer chờ `drain`, không phải kích thước cửa sổ trên dây hay giới hạn cứng của toàn bộ bộ nhớ. Một stream dừng tiêu thụ có thể vẫn giữ DATA đã đến và sẽ giảm tín dụng khi không đọc tiếp.

## API và giới hạn

| Route GET | Provider h2c | Gateway HTTP/1 |
| --- | --- | --- |
| `/blob` | 200, `application/octet-stream`, `Content-Length: 262144`, trailer hoàn tất | 200, cùng kiểu và độ dài, byte cuối chỉ phát sau xác thực |
| `/health` | 200 và `{"status":"ok"}` | 200 và `{"status":"ok"}`, kể cả khi hết slot tải |
| `/stats` | `active`, `sessions`, `generatedBytes`, `backpressureWaits`, `blocked` | `active` là số lượt tải đang chiếm slot |

`generatedBytes` và `backpressureWaits` là bộ đếm tích lũy, bão hòa tại số nguyên an toàn lớn nhất. `blocked` đếm các producer đang chờ `drain`. Các số liệu dùng để quan sát tiến độ và không thay đổi hành vi dịch vụ.

Gateway có tám slot đồng thời và không xếp hàng. Provider giữ tối đa tám phiên, tám lượt sinh blob toàn cục, và bốn lượt sinh blob mỗi phiên. Phiên vượt giới hạn bị đóng. Stream gửi yêu cầu tải khi hết slot nhận 503 `busy` trước khi sinh dữ liệu. Giới hạn giao thức cho tổng số stream mỗi phiên cao hơn giới hạn sinh blob, để còn trả được lỗi và phục vụ health. Phiên provider chờ preface/header ban đầu hoặc rảnh quá 500 ms sẽ bị đóng. Khi đang có blob, thời hạn từng stream vẫn giới hạn thời gian giữ phiên nếu một header khác chưa hoàn tất.

Mỗi lượt blob có ngân sách 2000 ms theo đồng hồ đơn điệu. Gateway tính thời gian từ trước khi kết nối tới khi kiểm tra EOF và hoàn tất ghi. Provider hủy stream khi hết hạn. Hủy lượt tải hoặc ngắt client làm gateway đóng phiên upstream và giải phóng slot. HTTP/1 giới hạn header ở 8192 byte và 500 ms. JSON trả về có giới hạn 8192 byte và thời hạn 500 ms. Tất cả route HTTP/1 đều không nhận body, nên gateway từ chối framing có body ngay mà không đọc hay giải mã JSON từ caller. Health và stats là cục bộ. Hop phụ thuộc duy nhất dùng HTTP/2 và gateway không chuyển tiếp JSON do provider gửi.

Query không hỗ trợ trả 400 `invalid_request`, đường dẫn lạ trả 404 `not_found`, sai phương thức cho route đã biết trả 405 `method_not_allowed` với `Allow: GET`. JSON dùng `application/json;charset=utf-8`; lỗi có dạng `{"error":{"code":"busy","message":"busy"}}` với `message` bằng `code`. Trình phân tích HTTP có thể tự từ chối framing hoặc cú pháp không hợp lệ.

## Tại sao phải giữ byte cuối?

Provider gọi `respond` với `waitForTrailers: true`. Sau khi ghi hết blob và nhận `wantTrailers`, provider gửi trailer duy nhất `x-blob-complete: 1`. Gateway kiểm tra status, header thô, đúng độ dài và kiểu nội dung, không có coding. Sau đó gateway yêu cầu đúng một sự kiện `trailers` chứa đúng trường trên và cờ `END_STREAM`, số byte chính xác, và phía đọc kết thúc sạch. Đặt marker vào header ban đầu sẽ bị từ chối. `rstCode === 0` và sự kiện `end` riêng lẻ không đủ vì Node có thể biểu diễn `RST_STREAM(NO_ERROR)` như kết thúc phía đọc.

Nếu lỗi xảy ra trước khi gửi header nhị phân, gateway trả 502 `upstream_failure`, hoặc 504 `upstream_timeout` nếu hết hạn. Sau khi bắt đầu phản hồi nhị phân, gateway đóng kết nối để HTTP/1 client thấy body thiếu so với `Content-Length`. Byte cuối được giữ lại đến khi kiểm tra hoàn tất, kể cả khi đã nhận hết DATA mà upstream vẫn chưa kết thúc. Gateway không nối JSON vào dữ liệu nhị phân, không retry, không theo redirect và không nén. 421 cũng được xử lý như lỗi upstream.

Trailer xác nhận ranh giới kết thúc của giao thức ứng dụng trong mô hình nguồn tin cậy. Bài tập kiểm tra SHA-256 ở client để xác thực byte quan sát được. Giới hạn tài nguyên của bài là theo một tiến trình và giao thức giữa hai dịch vụ này không có TLS hay xác thực danh tính.

## Bài tập

1. Chạy kiểm thử với cửa sổ client 4096 rồi 16384 byte. So sánh `generatedBytes` khi `blocked` ổn định và giải thích vì sao số byte đã sinh có thể lớn hơn cửa sổ stream.
2. Đổi fixture để gửi đủ DATA nhưng gửi sai trailer. Quan sát `response.complete` và so sánh với bản hợp lệ.
3. Thử gửi tám lượt tải đang chờ và một lượt thứ chín. Đo xem khi hủy một lượt thì slot có sẵn lại lúc nào.

## Tài liệu gốc

- [Node.js 24.12 HTTP/2](https://nodejs.org/download/release/v24.12.0/docs/api/http2.html)
- [Node.js 24.12 Stream](https://nodejs.org/download/release/v24.12.0/docs/api/stream.html)
- [RFC 9113 §5.2 về flow control](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.2)
