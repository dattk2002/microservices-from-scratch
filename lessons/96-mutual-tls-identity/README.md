# 96. Xác thực hai chiều TLS và danh tính dịch vụ

Hai tiến trình Node.js trao đổi qua HTTPS nội bộ. Gateway xuất một API HTTP trên loopback để quan sát kết quả. Provider dùng TLS 1.3 để xác thực chứng chỉ client, rồi dùng dấu vân tay SHA-256 của chính chứng chỉ trên kết nối để quyết định quyền đọc dữ liệu.

```text
Client ── HTTP ──> Gateway ── TLS 1.3 hai chiều ──> Provider
                   xác minh provider.local          xác minh client qua CA
                   gửi chứng chỉ gateway             đối chiếu pin SHA-256
```

## Chạy tại máy

Cần Node.js 24.12 trở lên trong dòng 24.x và shell POSIX. Các lệnh sau chạy từ thư mục gốc repository. Mỗi lần thực hành tạo một bộ khóa EC P-256 mới bằng các API có sẵn trong Node.js.

```bash
lesson="$PWD/lessons/96-mutual-tls-identity"
pki="$(mktemp -d)"
node "$lesson/pki.mts" "$pki"
printf 'Thư mục PKI: %s\n' "$pki"
```

Trong các terminal còn lại, gán `pki` bằng đường dẫn thư mục vừa in và chạy lệnh từ thư mục gốc repository. Chạy provider ở terminal thứ nhất.

```bash
PORT=9443 TLS_CA="$pki/ca.pem" TLS_CERT="$pki/server.pem" \
TLS_KEY="$pki/server.key" GATEWAY_PIN_CERT="$pki/gateway.pem" \
node lessons/96-mutual-tls-identity/provider.mts
```

Chạy gateway ở terminal thứ hai.

```bash
PORT=9080 PROVIDER_ORIGIN=https://127.0.0.1:9443 \
TLS_CA="$pki/ca.pem" TLS_CERT="$pki/gateway.pem" TLS_KEY="$pki/gateway.key" \
node lessons/96-mutual-tls-identity/gateway.mts
```

Cả hai tiến trình chỉ bind `127.0.0.1` và in một dòng JSON chứa cổng khi sẵn sàng. `PORT=0` hoặc không đặt biến này để hệ điều hành chọn cổng. Nếu đổi cổng provider, cập nhật `PROVIDER_ORIGIN` trước khi chạy gateway. Giá trị này nhận origin HTTPS với đúng IP `127.0.0.1` và cổng tường minh. Các tệp TLS là PEM độc lập và khóa dùng định dạng PKCS#8.

Có thể dùng Node.js để gọi gateway từ terminal thứ ba.

```bash
node --input-type=module -e '
for (const route of ["/health", "/value"]) {
  const res = await fetch("http://127.0.0.1:9080" + route, {signal: AbortSignal.timeout(2500)});
  console.log(res.status, await res.text());
}'
```

Kết quả ban đầu là `200 {"status":"ok"}` và `200 {"value":"trusted"}`. Dừng provider bằng Ctrl+C rồi gọi lại để thấy gateway vẫn khỏe và `/value` trả 502. Khi kết thúc, dừng gateway và xóa thư mục PKI đã tạo. Không đưa các tệp PEM hoặc khóa sinh ra vào Git.

## Ranh giới xác thực và hợp đồng

Gateway kết nối tới IP cấu hình sẵn, gửi SNI `provider.local` và xác minh chứng chỉ server theo CA cục bộ cùng DNS SAN `provider.local`. Chứng chỉ đối chứng `legacyCnOnly.pem` có CN `provider.local` và chữ ký CA hợp lệ. Gateway từ chối chứng chỉ này trước HTTP vì thiếu DNS SAN. TCP dùng IP literal nên không cần phân giải tên này trong DNS. Provider yêu cầu chứng chỉ client hợp lệ qua đúng CA cục bộ. Client thiếu chứng chỉ, do CA khác ký hoặc đã hết hạn bị từ chối trước khi provider xử lý HTTP.

Ở provider, cả hai route yêu cầu `TLSSocket.authorized` và dấu vân tay khớp với chứng chỉ trong `GATEWAY_PIN_CERT`. Khi được cấp quyền, `GET /health` trả `{"status":"ok"}`. Pin ánh xạ đúng một chứng chỉ sang danh tính `gateway`. Chứng chỉ `alternate.pem` có cùng CA, CN và SAN với gateway nhưng nhận `403 forbidden` ở `/value`. Giá trị trong header không có vai trò trong quyết định này.

Gateway HTTP trả `200 {"status":"ok"}` ở `GET /health` kể cả khi provider bị ngắt. `GET /value` chỉ trả 200 khi provider gửi HTTP 200 với đúng nội dung JSON `{"value":"trusted"}`. Gateway tạo yêu cầu mới và không truyền header của caller. Tối đa tám yêu cầu đi provider đồng thời. Yêu cầu tiếp theo nhận `503 busy`. Khi caller đóng kết nối, gateway hủy yêu cầu phụ thuộc và giải phóng chỗ.

| Tình huống | Kết quả ứng dụng |
| --- | --- |
| Query hoặc body trên route nhận GET | 400 `bad_request` |
| GET yêu cầu chuyển giao thức HTTP Upgrade | 400 `bad_request` |
| Đường dẫn không tồn tại | 404 `not_found` |
| Phương thức sai trên route có sẵn | 405 `method_not_allowed`, `Allow: GET` |
| Client hợp lệ qua CA nhưng sai pin ở provider | 403 `forbidden` |
| TLS lỗi, quá hạn, HTTP status khác 200 hoặc phản hồi không hợp lệ ở gateway | 502 `upstream_failure` |

Các lỗi ứng dụng có dạng `{"error":{"code":"forbidden","message":"forbidden"}}` với giá trị `message` bằng `code`. Phản hồi JSON dùng `application/json;charset=utf-8`. Lỗi từ bộ phân tích HTTP của Node có thể dùng phản hồi gốc của Node.

## Ngân sách và giới hạn của ví dụ

- Gateway thực hiện đúng một lần gọi bằng `node:https.request` với `agent:false`. Redirect và 421 kết thúc bằng 502. Ngân sách 500 ms dùng đồng hồ đơn điệu và tính cả TCP, handshake TLS, header, thân phản hồi và kết thúc thông điệp HTTP. Với chunked encoding, đã đọc đủ JSON vẫn chưa đủ nếu chunk cuối chưa đến.
- Mỗi vùng header và thân phản hồi có giới hạn 8.192 byte. Các header biểu diễn và framing trùng, `Connection` lặp thành nhiều dòng, trailer, cách nén và UTF-8 lỗi bị từ chối. Hợp đồng hẹp này yêu cầu một dòng `Connection`, dù HTTP nói chung cho phép ghép danh sách token từ nhiều dòng. Route đầu vào không nhận body và có hạn đọc 500 ms. Provider giới hạn toàn bộ vòng đời mỗi kết nối ở 500 ms từ lúc nhận TCP, kể cả khi client nhỏ giọt ClientHello. Phản hồi đóng kết nối. Gateway giữ ngân sách 500 ms riêng cho lời gọi phụ thuộc. Khi dừng, tiến trình hủy các socket còn mở và xóa bộ hẹn giờ, kể cả khi TLS chưa bắt tay xong.
- Bộ sinh chứng chỉ là mã giáo dục với một profile DER/X.509 hẹp. Nó tạo CA tự ký dùng `keyCertSign`, leaf thông thường có DNS SAN và EKU theo vai trò, cùng các chứng chỉ đối chứng. Trên POSIX, tệp được tạo độc quyền với quyền 0600 trong thư mục riêng do UID hiện tại sở hữu. Bộ sinh kiểm tra từng thành phần đường dẫn từ gốc, từ chối symlink, chủ sở hữu ngoài root và UID hiện tại, cùng thư mục cho nhóm hoặc người khác ghi nếu thiếu sticky bit. Sticky bit ở thư mục như `/tmp` bảo vệ thành phần con đã kiểm tra khỏi người dùng khác đổi tên. Mô hình này giả định root và các tiến trình cùng UID đáng tin cậy. Ví dụ không triển khai quy trình vận hành CA, thu hồi chứng chỉ, bảo vệ khóa bằng HSM hoặc phân phối bí mật.
- Khi cấp lại chứng chỉ, dấu vân tay đổi dù dùng lại khóa và tên. Vì provider chỉ nhận một pin, hai phiên bản gateway không thể cùng được phép trong lúc triển khai xen kẽ. Một hệ thống dùng pin trong sản xuất cần chính sách ánh xạ và khoảng chồng lấn có thời hạn nếu muốn xoay vòng không gián đoạn.
- Mỗi cuộc gọi tạo kết nối TLS riêng để thể hiện giới hạn và hủy kết nối rõ ràng. Hệ thống tải cao có thể dùng pooling với chính sách riêng cho đổi chứng chỉ và vòng đời của kết nối. Cổng HTTP của gateway dành cho bài thực hành trên loopback, chưa xác thực người dùng.

## Kiểm thử và bài tập

```bash
node --test --test-name-pattern=unit: lessons/96-mutual-tls-identity/test/lesson.test.mts
node --test --test-timeout=15000 lessons/96-mutual-tls-identity/test/lesson.test.mts
```

Unit test dùng chứng chỉ mới sinh và thư mục tạm để kiểm tra quyền đường dẫn. Đồng hồ giả lập kiểm tra việc đóng kết nối đúng hạn và việc chủ động hủy socket khi dừng. Integration test chạy tiến trình thật, tạo PKI trong thư mục riêng và chọn cổng loopback tạm thời. Các fixture cố ý gửi chứng chỉ sai hoặc thiếu SAN, gửi ClientHello dở dang và HTTP Upgrade, trả redirect, lặp header và trì hoãn kết thúc thân phản hồi để kiểm tra ranh giới.

1. Chỉ thay cặp chứng chỉ và khóa gateway bằng `alternate.pem` và `alternate.key`. Giải thích vì sao bắt tay TLS thành công nhưng provider từ chối `/value`, và vì sao caller của gateway thấy 502.
2. Gửi cùng một header tự xưng danh tính từ hai client khác nhau. Đối chiếu kết quả với dấu vân tay mà provider đọc từ TLS.
3. Thiết kế chính sách xoay vòng hỗ trợ hai pin có hạn dùng. Nêu cách rút pin cũ và kiểm tra rằng pin cũ bị từ chối sau khi hết hạn.

## Tài liệu tham khảo

- Tùy chọn TLS, xác minh hostname và `TLSSocket`. [Node.js TLS](https://nodejs.org/download/release/v24.12.0/docs/api/tls.html)
- Tạo HTTPS server và HTTPS request. [Node.js HTTPS](https://nodejs.org/download/release/v24.12.0/docs/api/https.html)
- Hồ sơ X.509, Key Usage, Extended Key Usage và SAN. [RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html)
