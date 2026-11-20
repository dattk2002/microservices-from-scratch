# Long polling theo phiên bản tài liệu

Client ghi nhớ phiên bản (`revision`) của tài liệu đang hiển thị. Khi client hỏi với phiên bản đó, origin có thể giữ yêu cầu tối đa 250 ms để trả snapshot mới ngay khi có thay đổi. Nếu hết thời gian chờ, client nhận `204` và có thể gửi yêu cầu tiếp theo với cùng phiên bản. Một lần poll chỉ trả về một kết quả.

## Chạy thử

Cần Node.js từ 24.12.0 đến hết dòng 24.x và `curl`. Các tiến trình chỉ dùng module tích hợp của Node.js. Chạy các lệnh từ thư mục gốc của repo.

Terminal 1 chạy tiến trình giữ tài liệu trong SQLite.

```sh
export DEMO_DIR="$(mktemp -d)"
trap 'rm -rf "$DEMO_DIR"' EXIT
DB_PATH="$DEMO_DIR/document.sqlite" PORT=3088 node lessons/88-revision-long-poll/origin.mts
```

Terminal 2 chạy observer.

```sh
ORIGIN_ORIGIN=http://127.0.0.1:3088 PORT=4088 node lessons/88-revision-long-poll/observer.mts
```

Mỗi tiến trình in một dòng JSON `{"service":"origin","port":3088}` hoặc `{"service":"observer","port":4088}` sau khi mở cổng. Cả hai chỉ lắng nghe trên `127.0.0.1`. Đặt `PORT=0` để hệ điều hành chọn cổng và dùng cổng origin được in ra trong `ORIGIN_ORIGIN`. Observer mặc định gọi `http://127.0.0.1:3088`. Giá trị cấu hình này chỉ chấp nhận origin HTTP loopback với cổng tùy chọn từ 1 đến 65535 và dấu gạch chéo cuối tùy chọn. Origin mặc định dùng `revision-document.sqlite` trong thư mục hiện hành. Giữ nguyên `DB_PATH` khi khởi động lại để đọc tài liệu đã commit.

Terminal 3 đọc tài liệu ban đầu và thử nhánh hết thời gian chờ.

```sh
curl -i http://127.0.0.1:3088/document
curl -i 'http://127.0.0.1:4088/changes?after=1'
curl -i 'http://127.0.0.1:4088/changes?after=0'
```

Ba lệnh lần lượt trả snapshot `{"revision":0,"value":0}`, lỗi `409 future_revision`, và `204` sau khoảng 250 ms. Trên một database mới, đoạn dưới đợi origin xác nhận có yêu cầu đang chờ rồi mới đổi giá trị. Nếu muốn lặp lại đoạn này, thay `after=0` bằng revision hiện tại và chọn một giá trị khác giá trị đã lưu.

```sh
curl -si --max-time 2 'http://127.0.0.1:4088/changes?after=0' &
poll_pid=$!
while kill -0 "$poll_pid" 2>/dev/null; do
  if [ "$(curl -fsS --max-time 1 http://127.0.0.1:3088/stats)" = '{"waiting":1}' ]; then
    curl -i --max-time 2 -X PUT http://127.0.0.1:3088/document \
      -H 'Content-Type: application/json' --data '{"value":25}'
    break
  fi
  sleep 0.01
done
wait "$poll_pid"
```

Cả PUT và poll đang chờ đều trả `{"revision":1,"value":25}` khi PUT commit trước hạn chờ. Client dùng `after=1` ở lần poll sau. Dừng tiến trình bằng Ctrl+C. Thoát terminal 1 để chạy lệnh dọn thư mục demo.

## Hợp đồng HTTP

| Tiến trình | Yêu cầu | Kết quả |
| --- | --- | --- |
| Origin | `GET /document` | `200` với snapshot hiện tại. |
| Origin | `PUT /document` | Body JSON chứa duy nhất `value`, số nguyên từ 0 đến 100. Trả `200` với snapshot đã commit. Cùng giá trị giữ nguyên revision. Đổi giá trị khi revision đã là 16 trả `409 revision_exhausted`. |
| Origin | `GET /changes?after=N` | Client đi trước nhận `409 future_revision`. Client đi sau nhận snapshot mới nhất với `200`. Khi bằng nhau, origin giữ yêu cầu tối đa 250 ms. Hết hạn trả `204`. Nếu đã đủ tám lượt đang chờ, yêu cầu cần chờ tiếp theo nhận `503 busy`. |
| Origin | `GET /stats` | `200 {"waiting":N}` với `N` từ 0 đến 8. Dùng để quan sát số lượt đang chờ hoặc đồng bộ bài kiểm thử. |
| Observer | `GET /changes?after=N` | Kiểm tra yêu cầu rồi gọi origin một lần trong tối đa 500 ms. Trả `200` nếu snapshot hợp lệ và revision lớn hơn `N`, `204` hợp lệ, `409 future_revision` hợp lệ khi `N > 0`, hoặc `503 busy` hợp lệ từ origin. Trả `503 busy` tại chỗ nếu đã có tám cuộc gọi đi. |

`after` phải xuất hiện đúng một lần, từ `after=0` đến `after=16`, với chữ số thập phân nguyên dạng. Những dạng như `after=01`, `after=%31` và query có khóa bổ sung đều bị từ chối. `204` không có byte payload hay các trường `Content-Type`, `Transfer-Encoding`, `Content-Length`. Snapshot chứa đúng hai trường số nguyên `revision` và `value`.

Các lỗi của ứng dụng có dạng `{"error":{"code":"future_revision","message":"future_revision"}}` với `message` bằng `code`. Route lạ trả `404 not_found`. Sai phương thức trên route đã biết trả `405 method_not_allowed` kèm `Allow`. Query sai trả `400 invalid_query`. Body trên route chỉ nhận GET hoặc schema PUT sai trả `400 invalid_body`. PUT yêu cầu `application/json` với tham số duy nhất `charset=utf-8` nếu có, và coding vắng mặt hoặc một `identity`. Media hoặc coding sai, thiếu media hay trường liên quan bị lặp trả `415 unsupported_media_type`. JSON hoặc UTF-8 sai trả `400 invalid_json`. Body vượt 8192 byte trả `413 body_too_large`, chưa đọc hết sau 500 ms kể từ khi vào handler trả `408 body_timeout`. Lỗi framing hoặc header vượt giới hạn ngay tại bộ phân tích HTTP có thể nhận lỗi HTTP gốc hoặc đóng kết nối.

## Luồng đọc, đăng ký và đánh thức

1. Origin đọc snapshot từ SQLite. Với revision bằng `after`, origin kiểm tra còn chỗ, ghi nhận thời điểm bắt đầu chờ, đăng ký waiter rồi đọc SQLite lần nữa. Lần đọc thứ hai bắt được một commit xảy ra giữa lần đọc đầu và lúc đăng ký, kể cả khi thông báo đã đi qua.
2. Một PUT đổi giá trị dùng một câu lệnh SQLite để cập nhật giá trị và tăng revision. Origin bước câu lệnh `RETURNING` đến khi hoàn tất để giao dịch ngầm có thể commit. Sau đó origin báo cho các waiter đọc lại trạng thái bền vững, rồi trả snapshot của PUT. PUT cùng giá trị trả snapshot hiện tại và giữ nguyên waiter.
3. Sau một lần đọc lại thành công, nếu đã đủ 250 ms thì deadline được ưu tiên, kể cả khi dữ liệu mới vừa xuất hiện. Nếu lần đọc thất bại, origin trả `500 internal_error`. Callback của timer tại deadline có thể trả `204` mà không đọc thêm. Lần poll sau có thể thấy snapshot mới nhất.
4. Mỗi waiter chỉ kết thúc một lần. Khi trả kết quả, quá hạn, mất kết nối, tắt tiến trình hay lỗi đọc, waiter nhả slot, hủy timer và tháo listener abort. Origin gắn hủy vào việc đóng response chưa hoàn thành để GET vẫn chờ được sau khi đã gửi xong yêu cầu.

## Ranh giới giữa hai tiến trình

Chỉ origin mở SQLite. Observer xác thực route và query trước khi lấy permit, dùng một kết nối HTTP/1 cho mỗi lần gọi, và hủy kết nối đi khi caller ngắt response. Permit được giữ đến khi kết quả qua kiểm tra đầy đủ hoặc bị hủy, sau đó được trả lại. Tám permit của observer và tám lượt chờ ở origin là hai giới hạn độc lập. Đọc `/document`, đọc `/stats` và poll có thể trả ngay ở origin vẫn hoạt động khi tất cả waiter đã được dùng.

Observer đo 500 ms từ lúc bắt đầu cuộc gọi đi đến hết bản tin HTTP, gồm thời gian bắt tay TCP, thời gian origin giữ yêu cầu và thời gian nhận đủ body. Cả hai phía giới hạn header HTTP/1 ở 8192 byte và kiểm tra các trường thô trước khi dùng giá trị. Observer xác thực đúng mã lỗi lẫn thông điệp trong envelope, cùng các giới hạn media, coding, kích thước và schema. Status lạ, redirect, lỗi transport, hết deadline, peer đóng sớm hoặc body sai hợp đồng đều cho `502 upstream_failure`. Cuộc gọi đi dùng đích cố định và thực hiện đúng một lần.

Mỗi poll đang chờ giữ một kết nối và một timer. Giới hạn nhỏ giúp quan sát khi nào hệ thống từ chối thêm việc. Mô hình một writer và waiter trong bộ nhớ phù hợp với một tiến trình origin. Khi origin khởi động lại, chỉ snapshot đã commit được giữ. Nếu nhiều PUT xảy ra giữa hai lần poll thì client nhận snapshot mới nhất, nên cách này phù hợp khi giao diện cần trạng thái hiện tại. Nhu cầu đọc đủ từng thay đổi sẽ cần một lịch sử sự kiện và quy tắc phát lại riêng.

## Kiểm thử và bài tập

Cài công cụ phát triển của repo bằng `npm ci`. Các lệnh sau chạy từ thư mục gốc.

```sh
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/88-revision-long-poll/test/lesson.test.mts
node --test --test-timeout=15000 lessons/88-revision-long-poll/test/*.test.mts
```

Unit test dùng đồng hồ giả để thử chính xác 249 ms và 250 ms, mô phỏng cập nhật giữa hai lần đọc và kiểm tra việc thu hồi tài nguyên. Integration test mở hai tiến trình thật bằng cổng trống, dùng `/stats` làm điểm đồng bộ và thử origin giả với phản hồi HTTP thô.

- Gửi hai PUT liên tiếp rồi poll bằng revision cũ. Dự đoán snapshot trả về và kiểm tra bằng `curl`.
- Dùng tám poll cùng revision hiện tại để quan sát `/stats` và `503`. Tắt một client đang chờ rồi thử nhận một slot mới.
- Thiết kế vòng lặp ở client chỉ cập nhật `after` khi nhận `200`. Thử thêm backoff có jitter cho lỗi `503` và `502`, đồng thời giữ nguyên một lần gọi đi cho mỗi yêu cầu mà observer nhận.

## Tham khảo

- [RFC 6202, Known Issues and Best Practices for the Use of Long Polling and Streaming in Bidirectional HTTP](https://www.rfc-editor.org/rfc/rfc6202.html)
- [Tài liệu SQLite trong Node.js 24.12.0](https://nodejs.org/download/release/v24.12.0/docs/api/sqlite.html)
