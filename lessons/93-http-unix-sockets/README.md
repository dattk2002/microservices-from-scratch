# HTTP qua Unix domain socket và vòng đời đường dẫn

Trong bài này, gateway nhận HTTP qua TCP loopback. Provider cũng xử lý HTTP/1, nhưng hai tiến trình trao đổi qua Unix domain socket có tên trong filesystem. Dòng yêu cầu, header và JSON vẫn là HTTP. Địa chỉ đích của chặng thứ hai là một đường dẫn thay vì cặp IP và cổng.

```text
curl ── HTTP/TCP 127.0.0.1:8093 ──► gateway
                                     │ GET /value
                                     │ HTTP qua Unix domain socket
                                     ▼
                            SOCKET_DIR/provider.sock ──► provider
```

## Chạy bài học

Dùng Linux với Node.js 24.12 trở lên trong dòng 24.x, một shell POSIX và curl. Các lệnh sau chạy từ thư mục gốc repo. Đoạn lệnh quản lý hai tiến trình nền trong một subshell. Gateway có thể sẵn sàng trước provider, nên hãy đợi cả hai dòng JSON báo sẵn sàng trước khi so sánh kết quả.

```sh
(
  set -eu
  SOCKET_DIR="$(mktemp -d /tmp/uds93.XXXXXXXX)"
  PORT=8093
  export SOCKET_DIR PORT
  provider_pid=
  gateway_pid=
  cleanup() {
    if [ -n "$gateway_pid" ]; then
      kill -TERM "$gateway_pid" 2>/dev/null || true
      wait "$gateway_pid" || true
    fi
    if [ -n "$provider_pid" ]; then
      kill -TERM "$provider_pid" 2>/dev/null || true
      wait "$provider_pid" || true
    fi
    rmdir -- "$SOCKET_DIR"
  }
  trap cleanup EXIT
  node lessons/93-http-unix-sockets/provider.mts &
  provider_pid=$!
  node lessons/93-http-unix-sockets/gateway.mts &
  gateway_pid=$!
  printf 'SOCKET_DIR=%s\nNhấn Enter sau khi chạy xong các lệnh curl ở terminal khác.\n' "$SOCKET_DIR"
  read -r _
)
```

Provider in `{"socketPath":"/tmp/uds93.…/provider.sock"}`. Gateway in `{"port":8093}`. Có thể đặt `PORT=0` để hệ điều hành cấp cổng, rồi dùng cổng trong thông báo của gateway.

Chạy từ terminal khác và thay đường dẫn ở dòng đầu bằng giá trị thật đã in ra.

```sh
SOCKET_DIR=/tmp/uds93.REPLACE_ME
curl --max-time 2 -i http://127.0.0.1:8093/health
curl --max-time 2 -i http://127.0.0.1:8093/value
curl --max-time 2 -i --unix-socket "$SOCKET_DIR/provider.sock" http://localhost/value
curl --max-time 2 -i -X POST http://127.0.0.1:8093/value
```

`GET /health` trả 200 và `{"ok":true}` ngay cả khi provider chưa chạy. `GET /value` trả 200 và `{"value":"local-only"}` qua cả hai đường truy cập trên. Với route đã biết, phương thức sai trả 405 kèm `Allow: GET`. Route lạ trả 404 `not_found`. GET có query, kể cả dấu `?` rỗng, trả 400 `invalid_query`. Các route đều không nhận body. Content-Length dương hoặc khai báo Transfer-Encoding bị từ chối ngay ở header với 400 `invalid_body`. HTTP parser có thể tự từ chối thông điệp sai cú pháp trước khi route xử lý.

Ứng dụng trả `application/json;charset=utf-8`. Lỗi ứng dụng có dạng `{"error":{"code":"not_found","message":"not_found"}}`, với `message` bằng `code`.

## Giới hạn mỗi lượt gọi

Gateway giữ đường dẫn đã xác minh lúc khởi động và gọi `http.request` đúng một lần với `socketPath` đó và `path: "/value"`. Một lượt gọi phải nhận trọn phản hồi trong 500 ms tính theo đồng hồ đơn điệu, từ trước khi kết nối đến khi HTTP parser xác nhận hết body. Giới hạn header và body mỗi phần là 8192 byte. Gateway kiểm tra các trường quan trọng trên danh sách header thô để phát hiện bản sao trước khi Node gộp trường. Phản hồi phải có status 200, đúng một Content-Type JSON (charset UTF-8 nếu khai báo), coding identity hoặc vắng mặt, framing rõ ràng, không có trailer và JSON đúng một trường `value` mang chuỗi `local-only`. UTF-8 lỗi và khóa JSON lặp bị từ chối.

Kết nối thiếu socket, bị từ chối hoặc thiếu quyền, quá hạn, body quá lớn, header trùng và phản hồi sai hợp đồng đều trả 502 `upstream_failure`. Redirect và 421 cũng trả 502 ngay trên lượt gọi đó. Không có fallback TCP, proxy, giải nén tự động hay retry. Gateway giữ tối đa tám lượt đang xử lý; lượt thứ chín nhận 503 `busy` ngay và health vẫn hoạt động. Slot được trả trong `finally`, kể cả khi client ngắt và gateway hủy yêu cầu sang provider.

## Quyền truy cập và vòng đời đường dẫn

Cả hai tiến trình yêu cầu `SOCKET_DIR` là đường dẫn tuyệt đối dạng chuẩn đến thư mục có sẵn, thuộc UID đang chạy và có mode `0700`. Startup dùng `lstat` và `realpath` để phát hiện symlink và đường dẫn alias. Tên socket cố định là `provider.sock` và toàn bộ đường dẫn tối đa 100 byte UTF-8 để chừa khoảng an toàn dưới giới hạn địa chỉ socket trên Linux. Yêu cầu HTTP không thể chọn đường dẫn.

Provider từ chối khởi động nếu đường dẫn đã có socket của tiến trình khác, file thường, symlink hoặc thư mục. Nó cũng để kernel kiểm tra xung đột trong lúc bind. Khi nhận SIGTERM hoặc SIGINT, server ngừng nhận kết nối, đóng các kết nối HTTP còn lại và Node dọn đường dẫn do chính listener đã bind. Provider không xóa thư mục. Nếu tiến trình bị SIGKILL hoặc crash, socket có thể còn trên đĩa. Người vận hành cần xác nhận provider đã dừng, kiểm tra đúng thư mục tin cậy và xác định mục còn lại là socket cũ (dùng `ls -ld -- "$SOCKET_DIR/provider.sock"` và kiểm tra listener bằng `ss -xl`). Chỉ sau khi xác nhận mới chạy `unlink -- "$SOCKET_DIR/provider.sock"` rồi khởi động lại provider. Kiểm tra thất bại từ curl riêng lẻ không đủ để kết luận socket đã cũ.

Unix domain socket là IPC cục bộ trên Linux/POSIX. Linux kiểm tra quyền filesystem khi đi qua thư mục và kết nối tới socket theo đường dẫn. Quyền đó giới hạn các UID có thể chạm tới socket; HTTP Host hay IP loopback không định danh tiến trình gửi. Bài học giả định thư mục cha tin cậy và tiến trình cùng UID hợp tác. Kiểm tra một lần lúc startup không ngăn tiến trình có quyền ghi đổi tên hoặc thay thế mục giữa hai thao tác filesystem. TCP loopback của gateway là một ranh giới riêng: tiến trình trên máy có thể truy cập cổng, và gateway không xác thực người gọi.

IPC theo đường dẫn đòi hỏi chung kernel và cùng nhìn thấy socket trong filesystem. Khi tách provider sang máy khác, cần cơ chế vận chuyển, định tuyến và xác thực phù hợp với mạng. Đường dẫn dùng chung trên một máy không thực hiện discovery cho dịch vụ từ xa.

## Kiểm thử và bài tập

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/93-http-unix-sockets/test/lesson.test.mts
node --test --test-timeout=15000 lessons/93-http-unix-sockets/test/lesson.test.mts
```

Lệnh thứ hai cần quyền tạo Unix domain socket trong thư mục tạm và bind cổng TCP loopback. Các test tạo thư mục riêng, chạy provider và gateway thành hai tiến trình, rồi kiểm tra dọn socket khi dừng, khôi phục sau restart và cách gateway xử lý peer trả HTTP bất thường.

- Dừng provider bằng SIGTERM, gọi lại cả hai route gateway, rồi khởi động lại provider trong cùng thư mục. Ghi lại chuỗi status của mỗi route.
- Trong một thư mục thử riêng, tạo trước file thường tên `provider.sock` rồi chạy provider. So sánh nội dung file trước và sau lần khởi động thất bại.
- Thử đường dẫn chứa ký tự nhiều byte và so sánh độ dài theo byte với số ký tự. Giải thích vì sao giới hạn đường dẫn theo byte.

## Tài liệu gốc

- [Node.js 24.12.0, IPC support](https://nodejs.org/download/release/v24.12.0/docs/api/net.html#ipc-support)
- [Node.js 24.12.0, http.request](https://nodejs.org/download/release/v24.12.0/docs/api/http.html#httprequestoptions-callback)
- [Linux unix(7), quyền và địa chỉ Unix domain socket](https://man7.org/linux/man-pages/man7/unix.7.html)
