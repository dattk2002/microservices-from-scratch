# 08 — Correlation ID và log có cấu trúc

Khi gateway báo lỗi nhưng catalog vẫn đang xử lý, tìm theo thời gian thường không đủ: nhiều request có thể xen kẽ. Bài này gắn một ID vào mỗi luồng HTTP và ghi từng sự kiện thành một dòng JSON, để nối các bản ghi từ hai tiến trình độc lập.

## Điều kiện và chạy thử

Cần Node.js **24.12+ thuộc dòng 24**, npm và các gói phát triển đã cài tại thư mục gốc. Runtime chỉ dùng built-in Node; không cần tài khoản, dịch vụ ngoài hay thư viện logging. Các lệnh sau chạy từ gốc repository. Bài dùng lại `lib/http.mts` cho HTTP/lifecycle và `test/support.mts` cho tiến trình test; không cần chạy bài trước.

Terminal 1:

```sh
HOST=127.0.0.1 PORT=4801 DELAY_MS=200 node lessons/08-correlation-logging/catalog.mts
```

Terminal 2:

```sh
HOST=127.0.0.1 PORT=4800 CATALOG_URL=http://127.0.0.1:4801 TIMEOUT_MS=1000 node lessons/08-correlation-logging/gateway.mts
```

Terminal 3:

```sh
curl -i -H 'x-correlation-id: basket-42' http://127.0.0.1:4800/quote
curl -i -H 'x-correlation-id: invalid,id' http://127.0.0.1:4800/quote
curl -i http://127.0.0.1:4800/quote
```

Request đầu trả `200`, header `x-correlation-id: basket-42` và body:

```json
{"priceCents":125,"correlationId":"basket-42"}
```

Hai request sau được cấp UUID mới, mỗi request một ID. Dừng cả hai server bằng Ctrl-C. Helper đóng listener và cưỡng chế đóng kết nối còn lại sau một giây.

## Kiến trúc và ranh giới

```text
caller -> gateway :4800 -> catalog :4801
           |                 |
        JSON stdout       JSON stdout
```

`gateway.mts` gọi HTTP thật, truyền duy nhất header ứng dụng `x-correlation-id`. Authorization, cookie, query và body của caller không được chuyển tiếp. Catalog sở hữu giá mẫu 125 cent; gateway kiểm tra status, header và body rồi trả các trường được phép. Không chia sẻ biến ngữ cảnh giữa hai tiến trình.

`service.mts` tạo scope bằng `AsyncLocalStorage.run()` ở đầu mỗi request. `context.mts` đọc ID từ scope khi tạo log. Promise, timer và `fetch` được tạo trong scope giữ đúng ngữ cảnh qua `await`. Listener `finish` được bind rõ ràng bằng `AsyncLocalStorage.bind()`, ghi status khi response hoàn tất. Khi callback kết thúc, scope của caller được khôi phục. Không dùng biến toàn cục kiểu `currentId` hoặc `enterWith()` cho mọi request.

AsyncLocalStorage chỉ truyền ngữ cảnh **trong tiến trình**. Bước sang catalog phải gửi header HTTP và mở scope mới từ header đó. Nếu quên header, catalog vẫn hoạt động nhưng sinh ID khác, khiến chuỗi log bị đứt.

## Hợp đồng ID và HTTP

Header được chấp nhận nếu là một chuỗi khớp **`^[A-Za-z0-9_-]{1,64}$`**, phân biệt hoa thường. Thiếu, rỗng, quá dài, dấu phẩy, khoảng trắng nội bộ, ký tự Unicode hoặc giá trị mảng đều bị thay bằng `randomUUID()`. Không trim hay sửa một phần ID trong ứng dụng. HTTP parser có thể loại khoảng trắng ngoài trước khi ứng dụng nhận header; header trùng tên thường được Node gộp bằng dấu phẩy và do đó bị loại. Ký tự điều khiển có thể bị HTTP parser từ chối trước handler; không hứa trả ID cho HTTP sai cú pháp.

Cả hai service đều kiểm tra ID tại ranh giới vào và trả ID đã chọn qua response header, kể cả lỗi route hoặc timeout. Một ID hợp lệ do caller cấp được giữ nguyên, nên caller có thể cố ý tái sử dụng nó. ID không phải chứng cứ danh tính, token xác thực, khóa idempotency hay bảo đảm duy nhất. Không đặt dữ liệu cá nhân/bí mật trong ID: ID hợp lệ vẫn được ghi log nguyên văn.

| Trường hợp | Status / body |
| --- | --- |
| `GET /quote` thành công | `200`, `{priceCents, correlationId}` |
| Đường dẫn khác | `404`, `{error:"not_found"}` |
| Phương thức khác tại `/quote` | `405`, `{error:"method_not_allowed"}`, `Allow: GET` |
| Catalog không đáp ứng trước deadline | Gateway `504`, `{error:"upstream_timeout"}` |
| Lỗi kết nối hoặc không đọc được JSON | Gateway `502`, `{error:"upstream_unavailable"}` |
| JSON đọc được nhưng sai status/header/schema | Gateway `502`, `{error:"upstream_invalid_response"}` |
| Lỗi ngoài dự kiến trong handler | `500`, `{error:"internal_error"}` |

Query được bỏ qua khi chọn route; không ghi raw URL. Giá phải là số nguyên an toàn không âm; body/header catalog phải mang đúng ID đã gửi. Body lỗi dùng mã cố định, không trả raw exception. Response JSON đặt `Cache-Control: no-store`. Không retry để tránh lẫn bài với chính sách retry; timeout không đồng nghĩa catalog đã ngừng xử lý.

## Cấu hình

| Biến | Mặc định | Giới hạn / ý nghĩa |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Địa chỉ bind; giữ loopback khi học |
| `PORT` | Catalog 4801, gateway 4800 | Số nguyên 0..65535; 0 để OS chọn port |
| `CATALOG_URL` | `http://127.0.0.1:4801` | Origin HTTP, không credentials/path/query/hash; gateway đọc lúc khởi động |
| `TIMEOUT_MS` | 1000 | 1..5000; deadline fetch gồm cả đọc body |
| `DELAY_MS` | 0 | 0..3000; catalog đợi trước khi trả giá để thấy xen kẽ/timeout |

Biến số sai làm startup thất bại. HTTP helper giới hạn thời gian nhận request/header ở 5000 ms; đây khác deadline gateway chờ catalog. Dòng stdout đầu `{service,port}` là readiness của helper, không phải log request. Không cung cấp `CATALOG_URL` từ input người dùng; demo chỉ gọi service loopback đáng tin.

## Đọc log và tìm một request

Mỗi log request là một JSON object trên một dòng, chỉ gồm `timestamp` ISO UTC, `level`, `service`, `event`, `correlationId` và `status` nếu đã có kết quả. `request_started` không có status; `upstream_finished` ghi kết quả gọi dependency; `request_finished` ghi status response. Status từ 500 trở lên dùng level `error`, các status khác dùng `info`.

Ví dụ rút gọn hai bản ghi từ hai terminal:

```json
{"timestamp":"2026-11-01T02:15:00.000Z","level":"info","service":"gateway","event":"request_started","correlationId":"basket-42"}
{"timestamp":"2026-11-01T02:15:00.210Z","level":"info","service":"catalog","event":"request_finished","correlationId":"basket-42","status":200}
```

Để lưu và lọc thử, khởi động lại hai lệnh server với stdout lần lượt chuyển hướng `> /tmp/correlation-catalog.jsonl` và `> /tmp/correlation-gateway.jsonl`. Sau khi gửi request, chạy:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
for (const file of process.argv.slice(1)) {
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.correlationId === "basket-42") console.log(JSON.stringify(row));
  }
}' /tmp/correlation-gateway.jsonl /tmp/correlation-catalog.jsonl
```

Bộ lọc gom theo ID, không bảo đảm thứ tự thời gian giữa các process. Logger không nhận request object, headers, URL, body, stack hoặc thông báo exception. Schema allowlist giúp tránh vô tình dump secret. JSON encoding ngăn một giá trị tạo thêm dòng log; validation ID còn giới hạn kích thước và ký tự. Đây không phải bộ lọc bí mật tổng quát cho mọi log tương lai.

## Kiểm thử và giới hạn xác minh

```sh
npm run typecheck
npm run test:unit
node --test --test-name-pattern='integration:' --test-timeout=15000 lessons/08-correlation-logging/test/lesson.test.mts
```

Unit test kiểm tra ranh giới ID, tạo UUID riêng, schema log và xen kẽ hai scope bằng barrier Promise xác định, không cần listener. Test còn kiểm tra context khôi phục sau lỗi. Integration test spawn hai child process qua helper, dùng `HOST=127.0.0.1`, `PORT=0`, fetch có deadline, thu stdout thực và đăng ký cleanup trước startup. Nó đối chiếu header/body với log cả hai service, kiểm tra hai request catalog cùng bắt đầu trước khi hoàn tất, ID thiếu/sai, route/method và timeout. Không có listener ở top-level test module.

Worker không chạy HTTP integration trong sandbox không có mạng. Controller chạy lệnh integration trong môi trường Docker cô lập với loopback riêng; worker không yêu cầu mạng hay chạy Docker. Khi cần xem từng assertion unit trong môi trường hạn chế subprocess, có thể chạy bổ sung:

```sh
node --test --test-isolation=none --test-name-pattern='unit:' lessons/08-correlation-logging/test/lesson.test.mts
```

## Tradeoff và giới hạn

Đây là nối log theo ID, **chưa phải hệ thống distributed tracing đầy đủ**. Không có trace/span ID riêng, quan hệ parent-child, sampling, exporter, biểu đồ thời lượng hay W3C Trace Context. Một request gọi nhiều dependency sẽ tạo nhiều dòng cùng ID mà chưa diễn tả rõ quan hệ nhân quả. Đồng hồ hai máy có thể lệch; không suy ra thứ tự toàn cục từ timestamp.

`finish` cho biết Node đã giao response cho tầng gửi, không bảo đảm caller đã nhận. Nếu caller ngắt kết nối, có thể chỉ còn log bắt đầu; bài chưa ghi sự kiện `close`/cancellation. Catalog có thể tiếp tục sau khi gateway đã trả 504. Không chuyển deadline hoặc hủy công việc nghiệp vụ trong bài này.

Stdout chưa có lưu trữ bền vững, rotation, kiểm soát truy cập hay backpressure policy cho lưu lượng lớn. Upstream tin cậy trong bài trả body nhỏ; gateway chưa có giới hạn byte đọc response. Log có ID vẫn có thể bị lạm dụng để liên kết hoạt động người dùng; production cần retention và chính sách riêng tư. Cần chính sách sinh ID tại edge nếu không muốn caller kiểm soát nhãn log.

## Bài tập

1. Bỏ header forwarding và quan sát ID gateway/catalog khác nhau; thêm test phát hiện chuỗi bị đứt.
2. Thêm sự kiện ngắt kết nối với cleanup listener, bảo đảm mỗi request chỉ có một kết quả cuối.
3. Thêm giới hạn byte body upstream và test lỗi 502 mà không log payload.
4. Thiết kế span ID riêng cho từng lời gọi con; giải thích vì sao một correlation ID không đủ mô tả fan-out.

## Tham khảo

- [Node.js 24 — Async context tracking, AsyncLocalStorage](https://nodejs.org/docs/latest-v24.x/api/async_context.html): scope, `run`, `bind` và các trường hợp mất context.
- [Node.js 24 — HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html): xử lý header, lifecycle response và sự kiện `finish`.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/): đối chiếu với chuẩn propagation trace, không xem header tự định nghĩa của bài là chuẩn này.
