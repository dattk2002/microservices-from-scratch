# 79. Welford và hợp nhất mean, variance khi các shard có kích thước khác nhau

Hai tiến trình nhận hai luồng quan sát độc lập. Mỗi tiến trình duy trì số
quan sát `n`, trung bình `mean` và mômen trung tâm bậc hai `m2`. Tiến trình
truy vấn hợp nhất hai bộ ba này để tính phương sai cho toàn bộ dữ liệu.

## Chạy trên máy

Cần Node.js 24.12.0 trở lên trong dòng 24, Bash và curl. Dịch vụ dùng
TypeScript chạy trực tiếp bằng Node, với HTTP và SQLite tích hợp sẵn.
Node 24.12.0 có thể in cảnh báo SQLite ở tiến trình nguồn khi khởi động.

Từ thư mục gốc repository, chạy khối lệnh sau với các cổng 3079, 3080 và 3179
đang trống. Ba tiến trình và hai tệp SQLite có vòng đời giới hạn trong khối lệnh.

```bash
(
  set -e
  lesson=lessons/79-mergeable-variance
  work="$(mktemp -d)"
  pids=()
  cleanup() {
    for pid in "${pids[@]}"; do
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
    rm -rf -- "$work"
  }
  trap cleanup EXIT

  HOST=127.0.0.1 PORT=3079 MOMENTS_ID=a DB_PATH="$work/a.db" node "$lesson/moments.mts" &
  pids+=("$!")
  HOST=127.0.0.1 PORT=3080 MOMENTS_ID=b DB_PATH="$work/b.db" node "$lesson/moments.mts" &
  pids+=("$!")
  HOST=127.0.0.1 PORT=3179 SOURCE_A_ORIGIN=http://127.0.0.1:3079 \
    SOURCE_B_ORIGIN=http://127.0.0.1:3080 node "$lesson/query.mts" &
  pids+=("$!")

  for origin in http://127.0.0.1:3079 http://127.0.0.1:3080; do
    curl -fsS --max-time 2 --retry 8 --retry-delay 1 --retry-connrefused "$origin/snapshot" > /dev/null
  done
  curl -fsS --max-time 2 --retry 8 --retry-delay 1 --retry-connrefused http://127.0.0.1:3179/statistics > /dev/null

  curl -fsS -H 'Content-Type: application/json' -d '{"id":"e1","value":0}' http://127.0.0.1:3079/events
  printf '\n'
  for id in e1 e2 e3; do
    curl -fsS -H 'Content-Type: application/json' -d "{\"id\":\"$id\",\"value\":10}" http://127.0.0.1:3080/events
    printf '\n'
  done
  curl -fsS http://127.0.0.1:3179/statistics
  printf '\n'
)
```

Kết quả truy vấn là `{"n":4,"mean":7.5,"populationVariance":18.75,"sampleVariance":25}`.

Cả hai entrypoint mặc định dùng `HOST=127.0.0.1`. `PORT` mặc định là
3079 cho nguồn và 3179 cho truy vấn. Với `PORT=0`, hệ điều hành cấp một
cổng trống và tiến trình in một dòng JSON chứa `service` và `port` sau
khi đã lắng nghe. Cấu hình origin của truy vấn bằng các cổng nguồn thực tế.
Hai origin phải là HTTP tại `127.0.0.1`, chỉ có host, cổng tùy chọn và
dấu `/` cuối tùy chọn. Giá trị được chuẩn hóa trước khi kiểm tra hai origin
có khác nhau hay không.

`MOMENTS_ID` phải là `a` hoặc `b`. Mỗi nguồn cần `DB_PATH` riêng trong
thư mục riêng tư. Giữ tệp nếu muốn kiểm tra khởi động lại. Nguồn kiểm tra
định danh đã lưu trước khi lắng nghe. Import các entrypoint chỉ nạp mã,
không mở SQLite hay cổng HTTP.

Từ thư mục gốc, sau khi đã cài bộ công cụ kiểm thử của repository bằng
`npm ci`, có thể chạy từng nhóm:

```bash
npm run typecheck
node --test --test-name-pattern=unit: lessons/79-mergeable-variance/test/lesson.test.mts
node --test --test-timeout=15000 --test-name-pattern=integration: lessons/79-mergeable-variance/test/lesson.test.mts
```

## Hợp đồng HTTP

| Đường dẫn | Kết quả |
| --- | --- |
| `POST /events` tại nguồn | `201 {"id":"e1","duplicate":false}` cho ID mới. Gửi lại đúng ID và giá trị nhận `200 {"id":"e1","duplicate":true}`. |
| `GET /snapshot` tại nguồn | `200` với đúng năm trường `id`, `algorithm`, `n`, `mean`, `m2`. Ví dụ nguồn rỗng trả `{"id":"a","algorithm":"welford-v1","n":0,"mean":0,"m2":0}`. |
| `GET /statistics` tại truy vấn | `200` với đúng bốn trường `n`, `mean`, `populationVariance`, `sampleVariance`. |

Gửi sự kiện với `Content-Type: application/json` và đúng hai trường
`{"id":"e1","value":10}`. `id` dài 1–16 ký tự thuộc `a-z` hoặc `0-9`;
`value` là số nguyên hữu hạn từ 0 đến 1.000.000.000. Hợp đồng của cả ba
đường dẫn không có tham số truy vấn.

Lỗi có dạng `{"error":{"code":"id_conflict","message":"id_conflict"}}`.
`message` bằng `code`.

| HTTP | Mã lỗi | Khi nào |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json` | Sai lược đồ, có tham số truy vấn hoặc JSON sai cú pháp. |
| 404 / 405 | `not_found` / `method_not_allowed` | Sai đường dẫn hoặc HTTP method. Phản hồi 405 kèm `Allow`. |
| 409 | `id_conflict` | ID đã được ghi nhận với giá trị khác. |
| 413 / 415 | `body_too_large` / `unsupported_media_type` | Thân yêu cầu vượt 8.192 byte hoặc media type khác JSON. |
| 429 | `capacity` | Có 64 receipt và ID yêu cầu là ID mới. |
| 500 | `internal_error` | Lỗi nội bộ, chẳng hạn lỗi ghi SQLite. |
| 502 | `upstream_failure` | Một nguồn mất kết nối, chuyển hướng, quá hạn hoặc trả phản hồi ngoài hợp đồng. |

## Cập nhật và hợp nhất mômen

`m2` biểu diễn tổng bình phương độ lệch quanh trung bình hiện hành.
Khi thêm một quan sát `x`, Welford dùng trung bình trước và sau lần cập nhật:

```text
n     = n + 1
delta = x - mean
mean  = mean + delta / n
m2    = m2 + delta * (x - mean)
```

Tính phương sai bằng `E[x²] - E[x]²` có thể bị triệt tiêu số
(*catastrophic cancellation*). Chẳng hạn với `999999998, 999999999,
1000000000`, mỗi số hạng trong phép trừ cỡ 10¹⁸, còn kết quả toán học
chỉ là 2/3. Ở cỡ 10¹⁸, khoảng cách giữa hai số binary64 liên tiếp lớn
hơn 2/3 rất nhiều. Các số hạng có thể mất thông tin về độ phân tán ngay
khi làm tròn, trước cả phép trừ. Welford tính từ các độ lệch nhỏ trong
ví dụ này, cho phương sai tổng thể xấp xỉ 2/3 và phương sai mẫu bằng 1.

Nếu một shard rỗng, dùng trực tiếp trạng thái shard kia. Với hai shard
có dữ liệu:

```text
delta = meanB - meanA
n     = nA + nB
mean  = meanA + delta * nB / n
m2    = m2A + m2B + delta² * nA * nB / n
```

Hạng cuối của `m2` đo phần độ phân tán do hai trung bình cục bộ cách
nhau. Với A = [0] và B = [10, 10, 10], trung bình của bốn quan sát là
7,5; lấy trung bình đơn giản của hai trung bình shard cho 5. Mỗi shard
đều có phương sai tổng thể bằng 0, trong khi hợp nhất cho `m2 = 75` và
phương sai tổng thể 18,75.

| Số quan sát | Mean | Phương sai tổng thể | Phương sai mẫu |
| --- | --- | --- | --- |
| 0 | `null` | `null` | `null` |
| 1 | Trung bình quan sát | 0 | `null` |
| Từ 2 | Trung bình gộp | `m2 / n` | `m2 / (n - 1)` |

Hiệu chỉnh Bessel dùng `n - 1` vì đã ước lượng một trung bình từ chính
mẫu, làm mất một bậc tự do. Với các quan sát độc lập cùng phân phối có
phương sai hữu hạn, công thức đó cho ước lượng phương sai không chệch.
API trả số hữu hạn theo binary64, không áp dụng bước làm tròn thập phân.
Thứ tự cập nhật và cách chia shard có thể dẫn đến sai khác do làm tròn.
Tính kết hợp đúng trong đại số không bảo đảm kết quả binary64 giống
nhau từng bit.

## Quyền sở hữu dữ liệu và đường đọc

```text
POST /events -> moments (a) -> SQLite riêng a
POST /events -> moments (b) -> SQLite riêng b

GET /statistics -> query --+-> GET /snapshot tại a
                           +-> GET /snapshot tại b
```

Mỗi nguồn giữ một dòng trạng thái `(id, algorithm, n, mean, m2)`, cùng
bảng receipt ánh xạ ID sang giá trị đã chấp nhận để nhận biết replay
và conflict. Công thức cập nhật chỉ đọc bộ ba mômen và giá trị mới.
Receipt phục vụ tính lũy đẳng, và phép hợp nhất chỉ dùng hai snapshot.
`BEGIN IMMEDIATE` mở giao dịch chứa cả việc đọc receipt, cập nhật mômen
và chèn receipt. SQLite dùng WAL và `synchronous=FULL` khi commit. Nếu một
câu lệnh lỗi, rollback giữ cả hai bảng ở trạng thái trước giao dịch. Tra receipt trước khi kiểm tra
sức chứa giúp replay vẫn thành công ở giới hạn 64. Cùng một chuỗi ID
trên hai luồng được tính hai lần vì định danh sự kiện có phạm vi theo
nguồn. Việc phân luồng phải bảo đảm một quan sát logic chỉ đến nguồn
sở hữu nó.

Mỗi truy vấn mới đọc hai snapshot đồng thời với một thời hạn chung
500 ms, tính từ lúc bắt đầu lấy dữ liệu đến khi kiểm tra xong hai snapshot
và tính kết quả. Truy vấn kiểm tra đồng hồ đơn điệu trước khi chấp nhận
kết quả, kể cả khi callback của bộ hẹn giờ chạy trễ. Thân JSON của từng
nguồn được đọc theo luồng với giới hạn 8.192 byte. Nếu có
`Content-Length`, giá trị phải hợp lệ và nằm trong giới hạn. Nguồn gửi
JSON không nén. Truy vấn chỉ nhận phản hồi thiếu `Content-Encoding`
hoặc có giá trị `identity`, vì Fetch có thể tự giải nén trước khi cho
đọc thân phản hồi. Redirect bị từ chối. Truy vấn kiểm tra đúng status 200,
media type, UTF-8, JSON, trường và kiểu dữ liệu, định danh nguồn và nhãn
`welford-v1`. Một snapshot có `n` nguyên trong 0–64, `mean` hữu hạn trong
0–10⁹, `m2` hữu hạn trong 0–`n × 10¹⁸`. Snapshot rỗng có ba số 0 chuẩn.
Snapshot một quan sát có `m2 = 0` và trung bình nguyên. Khi `m2 = 0`,
mọi quan sát có cùng giá trị nguyên. Khi trung bình ở một trong hai
biên 0 hoặc 10⁹, mọi quan sát phải bằng giá trị biên đó, nên `m2 = 0`.
Nếu một nguồn lỗi, truy vấn hủy công việc đọc còn lại và trả 502 cho
toàn bộ yêu cầu.

Mỗi snapshot là một lần đọc nguyên tử của nguồn tương ứng. Hai lần
đọc có thể quan sát các điểm commit khác nhau. Nếu có ghi đồng thời,
vector snapshot ghép từ A và B không có bảo đảm là một lát cắt giao
dịch chung. Query giữ cấu hình origin và không lưu kết quả các lần
đọc trước. Một yêu cầu lặp có thể thấy dữ liệu mới.

Giới hạn 64 receipt giữ trạng thái minh họa nhỏ và giữ được ngữ nghĩa
replay suốt vòng đời tệp. Hệ thống dòng dữ liệu dài hạn cần quyết định
thời hạn idempotency hoặc cơ chế lưu receipt khác. Bài học giả định hai
nguồn đáng tin trên loopback và không có xác thực, watermark hay giao
dịch phân tán.

## Bài tập

1. Chia `[0, 2, 4, 4, 10]` theo nhiều cách, đổi thứ tự nhập và so kết
   quả với trung bình 4, phương sai tổng thể 11,2 và phương sai mẫu 14.
2. Gửi lại cùng một ID khi nguồn đã đầy, rồi gửi cùng ID với giá trị
   khác. Dự đoán status và kiểm tra `n` trước và sau.
3. Thiết kế truy vấn theo một epoch bất biến cho cả hai nguồn. Xác định
   khi nào epoch đủ dữ liệu để công bố và cách xử lý một nguồn bị trễ.
4. Tìm một thứ tự hoặc cách chia shard làm thay đổi các bit thấp của
   kết quả. Giải thích cách chọn sai số chấp nhận được cho một unit test.

## Tài liệu gốc

- Công thức một lượt và hợp nhất mômen. [OSTI, báo cáo 1028931](https://www.osti.gov/biblio/1028931)
- Chan, Golub và LeVeque phân tích các thuật toán tính phương sai mẫu. [Algorithms for Computing the Sample Variance](https://doi.org/10.1080/00401706.1983.10487846)

Decoder còn kiểm tra các chặn trên phụ thuộc mean cho dữ liệu trong `[0, 1e9]`, với khoảng đệm cho phép tính binary64. Ví dụ `n=2, mean=5` không thể có `m2` vượt 50 trong số học chính xác. Đây là điều kiện cần về tính nhất quán, không chứng minh summary khớp dữ liệu thật của shard.
