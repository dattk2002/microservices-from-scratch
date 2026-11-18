# 76. Phân trang keyset qua nhiều shard và cursor gắn với vector snapshot

Bài 75 lấy một lần top-k của một vector snapshot. Bài này duyệt tiếp cùng một tập kết quả theo thứ tự `score DESC, id ASC`. Mỗi lần gọi, client gửi lại vector revision của hai shard và mốc của hàng cuối trang trước. Với dữ liệu trùng điểm, `id` xác định chính xác hàng nào nằm sau mốc.

## Chạy bằng Node.js

Cần Node.js 24.12.0 trở lên trong dòng 24.x, Bash và `curl`. Chạy từ thư mục gốc của repository. Runtime dùng các module tích hợp của Node.js, gồm `node:sqlite`. Hai shard chạy ở hai tiến trình với hai tệp SQLite riêng. Tiến trình query chỉ đọc API của hai shard.

```bash
lesson_dir=$(mktemp -d)
lesson_pids=()
cleanup_lesson() {
  for pid in "${lesson_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${lesson_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$lesson_dir"
}
trap cleanup_lesson EXIT

HOST=127.0.0.1 PORT=3076 SHARD_ID=a DB_PATH="$lesson_dir/a.db" \
  node lessons/76-sharded-keyset-pagination/shard.mts &
lesson_pids+=("$!")
HOST=127.0.0.1 PORT=3077 SHARD_ID=b DB_PATH="$lesson_dir/b.db" \
  node lessons/76-sharded-keyset-pagination/shard.mts &
lesson_pids+=("$!")
HOST=127.0.0.1 PORT=3176 \
  SHARD_A_ORIGIN=http://127.0.0.1:3076 SHARD_B_ORIGIN=http://127.0.0.1:3077 \
  node lessons/76-sharded-keyset-pagination/query.mts &
lesson_pids+=("$!")
```

Đợi ba dòng JSON readiness có `service` và `port`, rồi chạy các lệnh sau trong cùng phiên Bash. `PORT=0` để hệ điều hành chọn cổng và in cổng thực trong readiness. `HOST` mặc định là `127.0.0.1`. Cổng mặc định của shard là 3076 và của query là 3176, nên cần chọn cổng riêng cho shard thứ hai. Hai biến origin của query phải là origin HTTP khác nhau tại `127.0.0.1` sau khi chuẩn hóa, kể cả khi đầu vào khác nhau về dấu `/` cuối hoặc cổng mặc định.

```bash
curl -fsS -X PUT -H 'content-type: application/json' -d '{"score":90}' http://127.0.0.1:3076/items/a0
curl -fsS -X PUT -H 'content-type: application/json' -d '{"score":90}' http://127.0.0.1:3076/items/a1
curl -fsS -X PUT -H 'content-type: application/json' -d '{"score":90}' http://127.0.0.1:3077/items/b0
curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3076/publish
curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3077/publish

curl -fsS 'http://127.0.0.1:3176/page?limit=2&a=2&b=1'
curl -fsS 'http://127.0.0.1:3176/page?limit=2&a=2&b=1&afterScore=90&afterId=a1'
curl -fsS 'http://127.0.0.1:3176/page?limit=2&a=2&b=1&afterScore=90&afterId=b0'
```

Các trang lần lượt trả `[a0, a1]`, `[b0]` và `[]`. Trang thứ hai có `next={"id":"b0","score":90}` dù chỉ có một hàng. Trang rỗng có `next=null`. Có thể dừng shard và chạy lại cùng `DB_PATH` và `SHARD_ID` để thử độ bền. Thoát phiên Bash sẽ dừng các tiến trình đã lưu và dọn thư mục tạm.

## Hợp đồng HTTP

| Endpoint | Đầu vào | Kết quả 200 |
| --- | --- | --- |
| Shard `PUT /items/{id}` | JSON đúng một trường `{"score":N}`, với `N` là số nguyên từ 0 đến 100. Shard A sở hữu `a0`–`a7`, shard B sở hữu `b0`–`b7`. | `{"revision":R}` của dữ liệu live. Bắt đầu ở 0 và chỉ tăng khi dữ liệu thay đổi. |
| Shard `POST /publish` | JSON `{}`. | `{"revision":R}`. Chụp toàn bộ dữ liệu live tại revision hiện hành. Snapshot rỗng 0 có sẵn. Publish lại cùng revision trả cùng kết quả. |
| Shard `GET /snapshots/{rev}/page?limit=L[&afterScore=S&afterId=I]` | `rev` từ 0 đến 16, `L` từ 1 đến 4. | `{"shard":"a","revision":R,"items":[{"id":"a0","score":90}]}`. Tối đa `L` hàng của shard, theo thứ tự toàn phần và nằm sau cursor nếu có. |
| Query `GET /page?limit=L&a=A&b=B[&afterScore=S&afterId=I]` | Hai revision `A` và `B` từ 0 đến 16, cùng quy tắc `L` và cursor như shard. | `{"snapshots":{"a":A,"b":B},"items":[...],"next":...}`. `next` là `{score,id}` của hàng cuối, hoặc `null` khi trang rỗng. |

Gửi hai trường cursor cùng nhau hoặc bỏ cả hai. `afterScore` là số nguyên từ 0 đến 100 và `afterId` thuộc một trong hai shard, kể cả khi gọi trực tiếp shard còn lại. Có thể dùng một mốc hợp lệ về cú pháp mà không có hàng tương ứng trong snapshot. Các số trên URL dùng chữ số thập phân dạng chuẩn, ví dụ `0` hoặc `16`, và tên tham số xuất hiện đúng một lần. Những dạng như `01`, `1.0`, `%31` và tham số dư trả 400. Hai endpoint ghi nhận `Content-Type: application/json`, không nhận tham số URL, và từ chối JSON có trường dư hoặc sai kiểu.

Lỗi có dạng `{"error":{"code":"unknown_snapshot","message":"unknown_snapshot"}}` với `message` bằng `code`.

| Nơi phát lỗi | HTTP và mã | Điều kiện |
| --- | --- | --- |
| Shard hoặc query | `400 invalid_request` | Giá trị, tham số hoặc cấu trúc JSON sai. JSON không giải mã được trả `400 invalid_json`. |
| Shard | `409 revision_exhausted` | Ghi một thay đổi ở revision 16. Ghi lại cùng điểm vẫn trả 200 với revision 16. |
| Shard | `429 snapshot_capacity` | Đã có 4 snapshot, tính cả 0, và revision hiện hành chưa được publish. |
| Shard | `404 unknown_snapshot` | Revision hợp lệ về cú pháp nhưng chưa được publish. |
| Query | `502 upstream_failure` | Một shard thiếu snapshot, trả status khác 200 hoặc trả body sai, vượt giới hạn, redirect, mất kết nối hay quá hạn. |

## Thứ tự, snapshot và cách hợp nhất trang

1. **Shard ghi live và publish.** Ghi điểm và tăng revision diễn ra trong cùng transaction SQLite. Khi publish, transaction tạo bản ghi revision và sao chép tất cả hàng live của shard sang các hàng snapshot. Tệp lưu cả danh tính shard. Nếu khởi động cùng tệp với `SHARD_ID` khác, tiến trình từ chối trước khi mở cổng.
2. **Shard dùng điều kiện keyset.** Sau mốc `(S, I)`, SQLite lấy các hàng thỏa `score < S OR (score = S AND id > I)` của đúng revision. ID ASCII chuẩn và duy nhất toàn cục, nên phép so sánh ở SQLite và TypeScript cho cùng tie-break. Ví dụ sau `(90, a1)`, hàng `(90, b0)` vẫn nằm trong tập kết quả.
3. **Query gửi cùng mốc cho cả hai shard.** Hai HTTP GET chạy song song với một ngân sách 500 ms chung, bao gồm đọc hết body. Query không theo redirect, giới hạn mỗi body JSON ở 8192 byte, và kiểm tra schema, shard, revision, quyền sở hữu ID, số lượng, ID trùng và thứ tự sau mốc. Lỗi của một shard làm hỏng cả trang.
4. **Query hợp nhất và lấy tối đa `L` hàng.** Một hàng đứng sau `L` ứng viên của chính shard đã có ít nhất `L` hàng đứng trước nó trong hợp toàn cục. Vì vậy mỗi shard chỉ cần gửi tối đa `L` hàng. Query sắp xếp tối đa `2L` ứng viên rồi tạo mốc duy nhất từ hàng cuối đã trả. Nếu A chiếm hết trang đầu, dùng cursor riêng của B hoặc bỏ qua B có thể làm trang tiếp theo lặp hay bỏ qua hàng.

Offset mô tả vị trí, chẳng hạn bỏ qua 4 hàng, còn keyset mô tả một mốc trong thứ tự. Với dữ liệu đang thay đổi, một hàng có thể chen trước offset làm thay đổi vị trí của các hàng tiếp theo. Keyset tránh đếm lại theo vị trí, nhưng bản thân mốc vẫn chưa cố định tập dữ liệu. Nếu điểm của một hàng di chuyển qua mốc giữa hai lần gọi, hàng đó có thể xuất hiện hai lần hoặc bị bỏ sót. Vector snapshot cố định giới hạn mỗi lần gọi vào cùng tập hàng đã publish. Client giữ nguyên `a` và `b` trong suốt lượt duyệt. Chọn vector khác sẽ đọc một phiên bản hợp khác.

Mỗi snapshot được tạo nguyên tử trong một tệp SQLite. Hai shard publish độc lập và vector có thể ghép các revision từ hai thời điểm khác nhau. Bài này không cung cấp snapshot nguyên tử toàn cục, cơ chế chọn vector tự động, xác thực hay phân quyền. Cursor là dữ liệu điều hướng do client cung cấp. Việc sao chép snapshot đơn giản cho tối đa tám hàng mỗi shard, đổi lại cần thêm dung lượng theo số snapshot và không có xóa hay thu hồi snapshot. Với dữ liệu lớn, cần đo truy vấn theo index, thiết kế thời hạn lưu snapshot và cách client xử lý mốc hết hạn.

## Kiểm tra và bài tập

Chạy `npm ci` ở thư mục gốc để cài các gói phát triển đã khóa phiên bản trước khi chạy typecheck.

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/76-sharded-keyset-pagination/test/lesson.test.mts
node --test --test-timeout=15000 lessons/76-sharded-keyset-pagination/test/lesson.test.mts
```

Lệnh cuối cần môi trường cho phép tiến trình con mở cổng loopback. Các ca HTTP dùng cổng động và tệp SQLite tạm, duyệt hết 16 ID có nhiều điểm trùng nhau, rồi so sánh các trang sau khi ghi live và khởi động lại. Fixture HTTP kiểm tra cả body JSON hợp lệ vượt 8192 byte và bộ đếm ở đích redirect.

- Đổi `limit` thành 1 và theo `next` qua nhóm điểm 90. Ghi lại vector cùng với cursor ở từng lần gọi.
- Hạ điểm `a0` xuống 20 rồi publish A. Duyệt lại vector cũ và vector mới từ đầu, sau đó thử cố ý đổi vector giữa chừng. Giải thích hàng bị lặp hoặc bị bỏ qua theo vị trí của nó so với mốc.
- Thêm ca kiểm thử cho cursor có điểm bằng 0 và ID `b7`. Giải thích vì sao cả hai shard đều phải trả trang rỗng.

## Tài liệu tham khảo

- PostgreSQL mô tả yêu cầu sắp xếp xác định khi dùng `LIMIT` và chi phí bỏ qua hàng bằng `OFFSET`. [LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)
- SQLite mô tả cách transaction cô lập các thay đổi trên cùng một database. [Isolation In SQLite](https://www.sqlite.org/isolation.html)

Upstream chỉ dùng JSON không nén (`Content-Encoding` vắng mặt hoặc `identity`). Giới hạn 8192 byte áp dụng cho body; query kiểm tra deadline monotonic trước khi chấp nhận kết quả để timer bị trễ không biến phản hồi muộn thành thành công.
