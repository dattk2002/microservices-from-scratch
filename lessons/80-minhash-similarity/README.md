# MinHash, ước lượng Jaccard và chữ ký hợp nhất theo từng vị trí

Hai tiến trình `signature.mts` nhận giá trị cho hai tập độc lập. Mỗi tiến trình
lưu một chữ ký MinHash trong SQLite riêng. Tiến trình thứ ba, `compare.mts`, đọc
hai chữ ký qua HTTP để ước lượng độ tương đồng Jaccard và trả về chữ ký của hợp
hai tập. Dịch vụ so sánh không ghi dữ liệu.

## Chạy thử

Dùng Node.js 24.12.0 trở lên trong nhánh 24.x và chạy các lệnh từ thư mục gốc của
repository. Runtime chỉ dùng mô-đun có sẵn của Node.js và mã trong repository.
Node.js 24.12 có thể in cảnh báo thử nghiệm của `node:sqlite` khi khởi động dịch
vụ ghi. Import hai entrypoint không mở SQLite hay khởi động listener.

Terminal 1 mở tập A.

```bash
A_DIR=$(mktemp -d)
SET_ID=a DB_PATH="$A_DIR/a.sqlite" HOST=127.0.0.1 PORT=8081 \
  node lessons/80-minhash-similarity/signature.mts
```

Terminal 2 mở tập B.

```bash
B_DIR=$(mktemp -d)
SET_ID=b DB_PATH="$B_DIR/b.sqlite" HOST=127.0.0.1 PORT=8082 \
  node lessons/80-minhash-similarity/signature.mts
```

Terminal 3 chạy dịch vụ so sánh.

```bash
SOURCE_A_ORIGIN=http://127.0.0.1:8081 SOURCE_B_ORIGIN=http://127.0.0.1:8082 \
  HOST=127.0.0.1 PORT=8083 node lessons/80-minhash-similarity/compare.mts
```

`HOST` mặc định là `127.0.0.1`. Cổng mặc định của dịch vụ ghi là `8081` và của
dịch vụ so sánh là `8083`. Có thể đặt `PORT=0` để hệ điều hành cấp cổng. Sau khi
listen thành công, mỗi tiến trình in một dòng JSON gồm `service` và `port`. Hai
origin cấu hình chỉ nhận HTTP tới `127.0.0.1`, có thể có dấu `/` cuối. Chúng phải
khác nhau sau khi chuẩn hóa, kể cả khi một bên viết cổng mặc định `:80`.

Terminal 4 gửi các giá trị và quan sát kết quả.

```bash
for value in v0 v1; do
  curl -fsS -H 'Content-Type: application/json' \
    -d "{\"value\":\"$value\"}" http://127.0.0.1:8081/values
  printf '\n'
done
for value in v2 v1; do
  curl -fsS -H 'Content-Type: application/json' \
    -d "{\"value\":\"$value\"}" http://127.0.0.1:8082/values
  printf '\n'
done
curl -fsS http://127.0.0.1:8081/signature
printf '\n'
curl -fsS http://127.0.0.1:8083/similarity
printf '\n'
```

Với A = {v0, v1} và B = {v1, v2}, Jaccard thật là 1/3. Chỉ hàng 2 có cùng
minimum nên bản demo trả `matches=1` và `similarity=0.125`. Gửi lại `v0` cho A,
hoặc gửi `v63` lần đầu cho A ở trạng thái trên, đều trả `{"changed":false}`.
Để thử phục hồi, dừng A bằng Ctrl+C rồi chạy lại lệnh Terminal 1 từ dòng
`SET_ID=a`, giữ nguyên `A_DIR`. Dịch vụ so sánh vẫn dùng được cùng origin sau
khi A sẵn sàng. Sau khi dừng các tiến trình, có thể xóa hai thư mục tạm nếu
không cần giữ dữ liệu.

Chạy kiểm tra riêng bài học từ thư mục gốc. Nhóm `integration:` cần môi trường
cho phép tiến trình con bind cổng loopback và ghi thư mục tạm.

```bash
node --test --test-name-pattern='unit:' lessons/80-minhash-similarity/test/lesson.test.mts
node --test --test-name-pattern='integration:' lessons/80-minhash-similarity/test/lesson.test.mts
```

## Hợp đồng HTTP

| Endpoint | Phản hồi thành công |
| --- | --- |
| `POST /values` | `200` với `{"changed":boolean}`. Body phải là JSON object có đúng trường `value`, chuỗi chính tắc từ `v0` tới `v255`. |
| `GET /signature` | `200` với đúng ba trường `id`, `algorithm`, `slots`. `id` là `a` hoặc `b`, và `algorithm` là `minhash-sha256-8-v1`. |
| `GET /similarity` | `200` với đúng bốn trường `algorithm`, `matches` (0–8), `similarity` (0–1) và `unionSlots`. |

Mảng slot luôn có tám phần tử. Chữ ký rỗng có tám `null`. Chữ ký có dữ liệu
gồm tám chuỗi hex thường dài đúng 64 ký tự. `changed` có nghĩa ít nhất một
minimum vừa giảm, kể cả chuyển từ `null` sang hash. Chữ ký có thể giữ nguyên
khi một giá trị mới có ưu tiên cao hơn cả tám minimum hiện tại.

Các endpoint trên từ chối query string. JSON sai cú pháp hoặc sai schema trả
`400`. Body gửi vào `/values` lớn hơn 8192 byte trả `413` và media type khác
`application/json` trả `415`. Đường dẫn lạ trả `404`, phương thức sai trả
`405` kèm `Allow`. Các lỗi dùng `{"error":{"code":"…","message":"…"}}` với
`message` bằng `code`.

Dịch vụ so sánh gửi song song hai yêu cầu `GET /signature` tới các origin đã
cấu hình. Một deadline 500 ms bao trùm cả hai lần fetch, đọc body, kiểm tra
schema và tính kết quả. Timer hủy các lượt đọc đang chờ. Đồng hồ đơn điệu
xác nhận kết quả hoàn tất trước deadline, kể cả khi callback của timer chạy
muộn. Mỗi body upstream có giới hạn 8192 byte, kể cả whitespace, và bị hủy
ngay khi vượt giới hạn. Dịch vụ chỉ chấp nhận `Content-Encoding` vắng mặt
hoặc `identity`, đồng thời kiểm tra `Content-Length` nếu header này có mặt.
Dịch vụ từ chối redirect và kiểm tra status `200`, media type JSON, kiểu dữ
liệu, trường thừa, algorithm và đúng identity của mỗi phía. Timeout, lỗi kết
nối, redirect, status ngoài hợp đồng, JSON lỗi, sai schema, encoding khác
hoặc giới hạn byte bị vượt đều trả
`502` với mã `upstream_failure`. Dịch vụ không trả kết quả từ một phía khi
phía còn lại lỗi.

## Thuật toán và bất biến

- Với hàng `r` từ 0 đến 7 và giá trị `v`, lấy SHA-256 của chuỗi UTF-8
  `r:v`, chẳng hạn `2:v1`. Chuỗi hex thường cùng độ dài cho phép so sánh
  thứ tự từ điển. Mỗi hàng giữ hash nhỏ nhất của riêng hàng đó.
- Hợp nhất chữ ký lấy minimum ở từng vị trí, coi `null` là vô cực. Kết quả
  bằng chữ ký dựng từ hợp các giá trị gốc. Vì minimum có tính kết hợp, giao
  hoán và lũy đẳng, có thể hợp nhất theo nhiều cây hoặc thứ tự khác nhau. Gửi
  trùng và đảo thứ tự nhập cho kết quả cuối giống nhau.
- Chỉ so sánh hai minimum ở **cùng chỉ số hàng**. Số hàng bằng nhau chia tám
  là ước lượng Jaccard ( |A ∩ B| / |A ∪ B| ). Khi cả hai tập rỗng, bài học
  chọn Jaccard bằng 1 và trả tám hàng khớp. Khi đúng một tập rỗng, trả 0 và
  không có hàng khớp. Điểm tương đồng giữa các cặp tập không cộng được.
- Một hàng chỉ chọn một minimum. Cùng một giá trị có thể thắng ở nhiều hàng.
  Bottom-k dùng một hàm hash rồi giữ k phần tử có ưu tiên thấp nhất của hàm
  ấy. Quy tắc đếm các vị trí bằng nhau ở đây dựa vào việc từng vị trí dùng
  cùng quy tắc xếp hạng ở cả hai tập.

SQLite giữ đúng một hàng chứa danh tính, algorithm và mảng tám minimum.
`BEGIN IMMEDIATE` bảo vệ thao tác đọc, cập nhật và commit trong cùng
transaction. SQLite dùng `synchronous=FULL`. Nếu việc ghi thất bại, SQLite
rollback cả cập nhật. Khi khởi động lại, identity, algorithm và chữ ký đã
lưu được kiểm tra trước khi cổng mở. Mỗi nguồn cần một đường dẫn `DB_PATH` đến
tệp riêng trên đĩa. Dịch vụ từ chối `:memory:` và URI `file:` khi khởi động.
Demo không lưu tập gốc, từng request hay đếm phần tử chính xác. Dung lượng
trạng thái logic là cố định, còn dung lượng tệp có thêm pages và metadata
của SQLite. Giá trị có thể đến trong lúc so sánh, nên hai chữ ký hợp lệ vẫn có
thể được chụp ở hai thời điểm khác nhau.

## Giả định và giới hạn

Với một hoán vị minwise lý tưởng và hai tập có hợp khác rỗng, mỗi phần tử
trong hợp có cùng xác suất đứng đầu. Hai minimum chọn cùng phần tử nếu phần
tử đứng đầu nằm trong giao. Vì thế xác suất khớp của một hàng bằng Jaccard.
Nếu tám hàng còn độc lập, phương sai của trung bình tám chỉ báo khớp là
`J(1-J)/8`. Tám cách băm SHA-256 theo tiền tố hàng trong bài học cho kết quả
tất định. Chúng minh họa cách xây dựng chữ ký, không bảo đảm tám hoán vị minwise
độc lập hay mức tin cậy thống kê, đặc biệt khi dữ liệu được chọn có chủ đích.

Kiểm thử xét đủ 256 giá trị và xác nhận hash trong mỗi hàng không trùng,
nên hai tập rời nhau trong miền này không thể có hàng khớp. Chiều ngược lại
không đúng. Hai tập {v0, v2} và {v0, v3} có giao {v0} nhưng chữ ký không khớp
hàng nào. Chữ ký ước lượng Jaccard theo bước nhảy 1/8. Nó không cung cấp số
phần tử giao, cosine hay phép kiểm tra thành viên chính xác. Không có thao tác
xóa. Nếu xóa một minimum, trạng thái hiện tại thiếu các ứng viên tiếp theo để
sửa chữ ký. Miền đầu vào nhỏ cũng cho phép dò trước hash, nên chữ ký không
phải cơ chế bảo mật dữ liệu.

## Bài tập

1. Đổi thứ tự gửi, chèn bản sao, rồi kiểm tra lại chữ ký và điểm tương đồng.
2. Tìm một cặp tập khác có giao khác rỗng nhưng không có hàng khớp, rồi tính
   Jaccard thật từ hai tập gốc.
3. Giả sử cần 64 hàng. Đề xuất cách định phiên bản algorithm và đổi cấu hình
   hai nguồn đồng bộ. Giải thích nguồn dữ liệu nào cần để dựng đủ 64 minimum.
4. Thử dừng một nguồn trong lúc so sánh. Phân tích lý do giữ cùng kiểu lỗi
   khi nguồn vắng mặt và khi nguồn trả algorithm không tương thích.

## Tài liệu tham khảo

- Tài liệu MinHash của datasketch, gồm ví dụ ước lượng Jaccard và hợp nhất chữ ký. [MinHash](https://ekzhu.com/datasketch/minhash.html)
- Công trình của Andrei Z. Broder về độ tương đồng và bao hàm giữa các tài liệu. [On the Resemblance and Containment of Documents](https://doi.org/10.1109/SEQUEN.1997.666900)
