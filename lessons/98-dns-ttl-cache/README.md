# DNS cache theo TTL và thay đổi địa chỉ dịch vụ

Gateway tra tên cố định `provider.lesson.test` qua một DNS server chạy trên
loopback. DNS đổi bản ghi A từ `127.0.0.1` sang `127.0.0.2` trong lúc gateway
đang chạy. Nếu bản ghi cũ còn hạn, yêu cầu kế tiếp vẫn đến provider A. Sau khi
hết hạn, yêu cầu tiếp theo phát sinh tra cứu DNS mới và đi đến B.

## Chạy thử

Cần Node.js 24.12 trở lên trong dòng 24, một hệ thống có IPv4 loopback cho cả
`127.0.0.1` và `127.0.0.2` (ví dụ Linux), và `curl` để gọi API. Chạy từ thư mục
gốc repo, mỗi lệnh dịch vụ trong một terminal riêng. Chọn cổng trống nếu các
cổng ví dụ đang được dùng.

```sh
PORT=8098 DNS_PORT=5398 node lessons/98-dns-ttl-cache/resolver.mts
INSTANCE=a PORT=7098 node lessons/98-dns-ttl-cache/provider.mts
INSTANCE=b PORT=7098 node lessons/98-dns-ttl-cache/provider.mts
PORT=8198 DNS_PORT=5398 PROVIDER_PORT=7098 node lessons/98-dns-ttl-cache/gateway.mts
```

Resolver in ra JSON chứa `port` cho HTTP admin và `dnsPort` cho UDP. Provider và
gateway in `port` cho HTTP. `PORT=0` lấy cổng rảnh từ hệ điều hành. Resolver
cũng hỗ trợ `DNS_PORT=0`. Hai provider phải dùng cùng cổng TCP trên hai IP
khác nhau, vì vậy có thể chạy A với cổng 0 rồi truyền cổng A đã in cho B và
gateway. Gateway yêu cầu `PROVIDER_PORT` và `DNS_PORT` khác 0.

```sh
curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:8198/value
curl --noproxy '*' --max-time 2 -fsS -H 'content-type: application/json' \
  -d '{"instance":"b"}' http://127.0.0.1:8098/target
curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:8198/value
sleep 1
curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:8198/value
curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:8198/stats
```

Nếu ba lệnh đầu hoàn thành trong TTL một giây, hai lần đọc đầu trả
`{"instance":"a"}`. Lần đọc sau khi nghỉ một giây trả `{"instance":"b"}`.
Dừng resolver bằng Ctrl+C rồi gọi `/health` của gateway để quan sát liveness
độc lập với DNS. Dừng các tiến trình còn lại bằng Ctrl+C.

## Luồng yêu cầu và hạn dùng

```text
POST /target ─── HTTP ──► resolver (admin trên 127.0.0.1)
                              ▲
                      UDP DNS │ resolve4 với TTL
                              │
GET /value ───── HTTP ──► gateway ───── HTTP :7098 ───► A 127.0.0.1
                              │
                              └──────── HTTP :7098 ───► B 127.0.0.2
```

Resolver trả một A record TTL một giây. Gateway kiểm tra toàn bộ tập kết quả
(1–8 record, TTL nguyên không dấu 32 bit, địa chỉ đúng một trong hai IP ví dụ).
Gateway chọn record đầu tiên rồi giữ đúng địa chỉ đó cho yêu cầu hiện tại.
Cổng provider thuộc cấu hình của gateway, còn DNS chỉ ánh xạ tên sang IP.
Trong bài 21, service registry/discovery mô hình hóa danh sách instance của
dịch vụ để client tra cứu. Ví dụ DNS này minh họa ánh xạ IP theo TTL và độ
trễ quan sát thay đổi tại client.

Cache tính thời gian từ lúc nhận kết quả thành công bằng đồng hồ đơn điệu
`performance.now()`. Hạn là TTL nhỏ nhất trong các record, tối đa 30 giây.
TTL bằng 0 chỉ dùng cho lượt tra cứu hiện tại. Cache hit giữ nguyên hạn dùng.
Tại đúng thời điểm hết hạn, yêu cầu mới tham gia một lần tra cứu dùng chung.
Mỗi yêu cầu giữ thời hạn riêng, tính cả tra cứu DNS và đọc response HTTP đến
EOF. Khi waiter cuối cùng rời đi, gateway hủy `Resolver` dành riêng cho lượt
tra cứu đó. Lần tra cứu lỗi để cache trống, nên yêu cầu sau có thể thử lại.

## Hợp đồng HTTP và giới hạn

| Tiến trình | Đường dẫn | Kết quả thành công |
| --- | --- | --- |
| Cả ba | `GET /health` | `{"ok":true}` |
| Resolver | `GET /stats` | `dnsQueries` (số câu hỏi hợp lệ được trả lời), `dnsPort` |
| Resolver | `POST /target` | Nhận và trả đúng `{"instance":"a"}` hoặc `{"instance":"b"}` |
| Provider và gateway | `GET /value` | Đối tượng chỉ có trường `instance`, giá trị `"a"` hoặc `"b"` |
| Gateway | `GET /stats` | `cacheHits`, `dnsQueries` (số lượt tra cứu bắt đầu), `active` |

Mọi phản hồi của ứng dụng dùng JSON UTF-8. Lỗi có dạng
`{"error":{"code":"bad_request","message":"bad_request"}}`; tại mỗi lỗi,
`message` bằng `code`. Route sai trả 404, method sai trả 405 kèm `Allow`,
query string và framing không hợp lệ trả 400. JSON admin giới hạn 8192 byte,
UTF-8 hợp lệ, khóa duy nhất trong mỗi đối tượng sau khi giải mã escape, độ
sâu tối đa 64 và kiểu dữ liệu đúng, với 500 ms để đọc hết body. Vượt kích
thước trả 413, hết hạn body admin trả 408. Lỗi parser HTTP có thể nhận phản
hồi do Node tạo.

Gateway nhận tối đa tám thao tác phụ thuộc đồng thời, dư trả 503 `busy`.
Gateway trả 502 `upstream_failure` cho NXDOMAIN, bản ghi ngoài allowlist,
kết nối bị từ chối, HTTP status khác 200 (kể cả 1xx, redirect và 421), hoặc
dữ liệu HTTP không hợp lệ. Nếu provider gửi 101, gateway đóng socket được
chuyển giao và giải phóng slot. Hết ngân sách DNS + HTTP + EOF 500 ms trả 504 `timeout`.
Gateway đọc tối đa 8192 byte body, giới hạn header 8192 byte, kiểm tra header
biểu diễn/framing bị lặp, áp dụng cùng quy tắc JSON như HTTP admin và từ chối
trailer. Gateway mở đúng một kết nối HTTP
trực tiếp cho mỗi thao tác có địa chỉ hợp lệ. Đổi DNS không buộc gateway bỏ
cache và lỗi provider không làm gateway mở kết nối thứ hai.

Server DNS chỉ phục vụ UDP trên loopback. Nó xử lý datagram tối đa 512 byte,
một câu hỏi IN A cho tên cố định, QNAME không nén và tùy chọn một bản ghi
OPT rỗng của client hoặc OPT chứa một DNS COOKIE. Nó bỏ qua gói sai hoặc ngoài phạm vi. Compression
pointer trong câu trả lời trỏ đến QNAME đã xác minh. Đây là demo authoritative
nhỏ với hai địa chỉ đã biết. Phạm vi dừng ở một record mẫu, không có
recursive resolution, TCP DNS server, DNSSEC, negative cache hay cơ chế
health-based failover. TTL ngắn giúp đổi địa chỉ nhanh hơn, nhưng tăng tần
suất tra cứu. TTL dài giảm tải DNS, nhưng giữ địa chỉ cũ lâu hơn khi chuyển
dịch vụ.

## Kiểm thử và bài tập

Từ gốc repo, với các gói dev đã cài:

```sh
node --test --test-name-pattern=unit: lessons/98-dns-ttl-cache/test/lesson.test.mts
node --test --test-timeout=15000 lessons/98-dns-ttl-cache/test/lesson.test.mts
npm run typecheck
```

Các test unit dùng đồng hồ giả và gói DNS dạng byte. Test integration mở
socket thật trên cổng ngẫu nhiên và chạy các tiến trình độc lập. Hãy thử dự
đoán số lần tra cứu khi đọc liên tục quanh biên TTL, rồi kiểm tra `/stats`.
Sau đó dừng A trong lúc cache còn hạn và quan sát số lần tra cứu. Cuối cùng,
thử trả TTL 0 từ resolver và so sánh số lượt tra cứu giữa yêu cầu tuần tự
và yêu cầu đồng thời.

- [Node.js 24.12 DNS API](https://nodejs.org/download/release/v24.12.0/docs/api/dns.html)
- [RFC 1035 — Định dạng thông điệp DNS](https://www.rfc-editor.org/rfc/rfc1035.html)
- [RFC 2181 §8 — TTL](https://www.rfc-editor.org/rfc/rfc2181.html#section-8)
