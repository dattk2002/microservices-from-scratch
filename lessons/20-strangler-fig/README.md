# 20 — Strangler Fig và chuyển quyền sở hữu từng bước

Bài này chuyển một chức năng nhỏ: **ghi chú đóng gói theo mã công việc**. Khách hàng
luôn dùng `GET /notes` và `POST /notes` qua facade. Ban đầu ứng dụng legacy sở hữu
ghi chú; sau một khoảng dừng có chủ đích, dịch vụ extracted sở hữu toàn bộ chức năng.
Không có cơ sở dữ liệu chung, không dual-write một thay đổi nghiệp vụ.

## Chuẩn bị và ranh giới

Cần Node.js **24.12+ thuộc dòng 24**, npm và các development dependency đã pin của
kho. Runtime chỉ dùng built-in: HTTP, SQLite, crypto, child_process. Nên đọc bài 03
(service-owned persistence), 04 (deadline) và 09 (gateway aggregation) trước.
Chạy tất cả lệnh từ gốc repository. TypeScript `.mts` dùng cú pháp erasable, Node
chạy trực tiếp; không cần biên dịch hay cài runtime package.

```text
client → facade :4020 ─── legacy :4021 ─── legacy.sqlite
                     └── extracted :4022 ─── extracted.sqlite
         │
         └── facade.sqlite (chỉ chính sách sở hữu, không phải dữ liệu nghiệp vụ)
```

Ba tiến trình độc lập. Mỗi provider tự mở database của mình. Facade chỉ chuyển
HTTP; không mở database nghiệp vụ của provider. `application_id` khác nhau chặn
việc vô tình dùng chung file; `user_version=1` chặn schema không được hỗ trợ.
Database dùng transaction SQLite và `synchronous=FULL`. Thư mục cha phải có sẵn.
Mỗi database chỉ có **một tiến trình sở hữu đang chạy**; đây không phải giải pháp
leader election hay migration nhiều replica.

Khác bài gateway aggregation, facade không gọi cả hai provider để ghép kết quả.
Nó chọn **một chủ sở hữu cho cả đọc lẫn ghi**. Strangler migration là thay dần
chức năng của ứng dụng cũ; ví dụ này chỉ chuyển một chức năng nguyên khối nhỏ,
không cố xây một gateway đa năng.

## Chính sách một chiều

| Pha bền vững tại facade | GET và POST nghiệp vụ | Hành động migration |
| --- | --- | --- |
| `legacy-only` | Chỉ legacy | `POST /migrate` ghi barrier xuống đĩa trước |
| `copy-cutover` | Cả hai trả 503 `cutover_barrier` | Freeze → drain → snapshot → copy → validate → activate |
| `extracted-owner` | Chỉ extracted | Lặp `/migrate` trả pha hiện tại, không copy lại |

Chỉ được đi theo thứ tự trên hoặc lặp lại chính pha hiện tại. Không được nhảy
thẳng từ legacy sang extracted; không có lệnh tự động đi lùi.

1. Facade ghi `copy-cutover` trước bất kỳ HTTP migration nào. Một request đang đọc
   body chưa được admission sẽ kiểm tra lại pha khi body đã hợp lệ.
2. Legacy ghi `frozen` **trước khi await**. Admission và tăng bộ đếm write là đoạn
   đồng bộ sau khi parse body. Write đã được nhận tiếp tục hoàn tất; write mới
   bị từ chối. Legacy đợi bộ đếm về 0 rồi mới đọc snapshot. Các read mới cũng bị
   fence. Request read đã nhận trước barrier có thể hoàn tất theo owner cũ.
3. Snapshot tối đa 30 ghi chú được chuẩn hóa theo ID, kiểm tra kiểu, độ dài và ID
   trùng. Extracted đang `passive` thay dữ liệu trong một transaction, đọc lại và
   đối chiếu SHA-256. Facade kiểm tra hash với nguồn trước khi yêu cầu activate.
   Hash phát hiện khác dữ liệu; nó không xác thực người gửi.
4. Extracted ghi `active` bền vững; legacy vẫn `frozen`. Chỉ khi activate trả thành
   công facade mới ghi `extracted-owner`. Chỉ có một provider được phép ghi.

Mỗi HTTP từ facade có deadline 4 giây, không redirect, không retry. Drain mặc định
1.200 ms, cấu hình tối đa 3.000 ms. Một lần `/migrate` thực hiện tối đa ba HTTP
call tuần tự, nên phần chờ downstream có ngân sách tối đa khoảng 12 giây. Khối
lượng copy cũng có giới hạn cứng. **Lỗi hoặc mất tiến trình không mở lại barrier**;
thời gian gián đoạn tổng cộng có thể dài hơn ngân sách một lần thử, đến khi người
vận hành sửa lỗi và tiếp tục. Đây là lựa chọn fail-closed, không phải cam kết zero
downtime.

## Khôi phục khi bị ngắt

| Điểm ngắt | Trạng thái sau restart | Cách tiếp tục |
| --- | --- | --- |
| Trước barrier | Legacy vẫn sở hữu | Phục vụ như cũ |
| Đã ghi barrier, chưa freeze | Facade vẫn chặn nghiệp vụ | Gọi lại `/migrate`, freeze trước khi lấy snapshot |
| Đang drain/copy hoặc đã copy | Legacy frozen, target passive | Gọi lại `/migrate`, drain lại và copy transaction mới |
| Target active, facade chưa lưu owner | Facade vẫn ở barrier | Copy cùng hash chỉ xác nhận, **không thay dữ liệu**, activate idempotent rồi lưu owner |
| Đã lưu owner | Chỉ extracted | Restart không quay lại legacy |

Khôi phục pha `copy-cutover` dùng thao tác lặp từ freeze; không lưu một con trỏ
bước dễ lệch với provider. Nếu snapshot không khớp hash đã activate, dừng để người
vận hành điều tra, không ghi đè target. Sau activate, retry copy so với hash gốc
đã lưu chứ không so với dữ liệu có thể đã được owner mới sửa.

Nếu legacy chết khi có write đang chờ, các tác vụ chưa commit không sống lại sau
restart; các write đã commit nằm trong snapshot. Không hứa rằng một request chỉ
mới được nhận mà chưa trả kết quả đã thành công. Nếu response mất sau commit,
kết quả đối với client là **chưa biết**. Facade trả 503 `owner_unavailable`, không
thử legacy hoặc tự phát lại POST. Client có thể đọc lại theo ID; cần chính sách
idempotency/version riêng nếu muốn retry chống ghi đè thay đổi mới hơn.

Không được khôi phục một backup cũ của `facade.sqlite` hay mở khóa legacy thủ
công sau cutover: việc đó phá invariant sở hữu. Rollback sau khi extracted có
write mới cần fence extracted, drain, đối soát và reverse-copy dữ liệu mới về
legacy, kiểm tra rồi mới chuyển owner. Bài này **không triển khai rollback đó**.

## Chạy thủ công

Tạo thư mục runtime một lần:

```sh
mkdir -p lessons/20-strangler-fig/demo
```

Mở ba terminal, đều ở gốc repository:

```sh
DB_PATH=lessons/20-strangler-fig/demo/legacy.sqlite PORT=4021 \
  node lessons/20-strangler-fig/legacy.mts
```

```sh
DB_PATH=lessons/20-strangler-fig/demo/extracted.sqlite PORT=4022 \
  node lessons/20-strangler-fig/extracted.mts
```

```sh
DB_PATH=lessons/20-strangler-fig/demo/facade.sqlite PORT=4020 \
  LEGACY_URL=http://127.0.0.1:4021 EXTRACTED_URL=http://127.0.0.1:4022 \
  node lessons/20-strangler-fig/facade.mts
```

Terminal thứ tư, trên môi trường có loopback được phép:

```sh
curl -i -H 'content-type: application/json' \
  -d '{"id":"packing","text":"Đóng gói trước 17 giờ"}' http://127.0.0.1:4020/notes
curl -i http://127.0.0.1:4020/notes
curl -i -X POST http://127.0.0.1:4020/migrate
curl -i http://127.0.0.1:4020/migration
curl -i -H 'content-type: application/json' \
  -d '{"id":"packing","text":"Đã đổi nhãn vận chuyển"}' http://127.0.0.1:4020/notes
curl -i http://127.0.0.1:4020/notes
```

Dừng extracted bằng Ctrl-C rồi POST một ghi chú **hợp lệ** qua facade: kết quả là
503, không có write vào legacy. Khởi động lại với cùng file để đọc dữ liệu cũ.
Dùng Ctrl-C để dừng các tiến trình còn lại; không đưa file SQLite runtime vào Git.

### Cấu hình

| Biến | Ý nghĩa |
| --- | --- |
| `DB_PATH` | Bắt buộc, file bền vững riêng của từng tiến trình; cấm `:memory:` |
| `HOST` | Mặc định `127.0.0.1`; giữ loopback trong bài thực hành |
| `PORT` | Mặc định facade 4020, legacy 4021, extracted 4022; `0` cấp cổng ephemeral |
| `LEGACY_URL`, `EXTRACTED_URL` | Facade bắt buộc nhận hai HTTP origin loopback khác nhau |
| `DRAIN_MS` | Provider: 100..3000, mặc định 1200 |
| `TEST_CONTROL=1` | Chỉ test: bật các gate `/control/hold`, `/control/hold-reply`, `/control/release` |

Tất cả environment read, store, listener, signal handler và tác vụ chờ đều được
khởi tạo trong `main`/`startProvider`. Entrypoint có guard `import.meta.main`.
Import module với PORT/URL/DB_PATH sai vẫn thoát im lặng, không mở tài nguyên.

## Hợp đồng HTTP

| Route | Thành công | Lỗi chủ đích |
| --- | --- | --- |
| Facade `GET /notes` | 200, mảng `{id,text}` tăng theo ID | 503 barrier hoặc owner lỗi |
| Facade `POST /notes` | 200, `{id,text}` đã ghi; ID cũ được cập nhật | 400 payload, 409 đầy 30 ID, 415 content type, 413 body >8192 byte, 503 barrier/owner |
| Facade `GET /migration` | 200 `{phase,migrating}` | Pha không hợp lệ không được phục vụ |
| Facade `POST /migrate` | 200 `{phase:"extracted-owner"}` | 409 đang migrate; 503 downstream lỗi/drain timeout; lỗi validation nội bộ 500, barrier giữ nguyên |
| Provider `GET /status` | 200 `{state,active,committed}` | Dùng quan sát trong test |
| Legacy `POST /freeze` | 200 snapshot sau drain | 503 `drain_timeout`, legacy vẫn frozen |
| Extracted `POST /copy` | 200 `{hash}` | Từ chối snapshot sai hoặc thay một copy active khác hash |
| Extracted `POST /activate` | 200 `{state:"active"}` | Từ chối hash chưa được validate |

`POST /notes` chỉ chấp nhận đúng hai trường: `id` gồm 1..24 ký tự `[a-z0-9-]`,
`text` không chỉ khoảng trắng, 1..64 UTF-16 code unit và không có control character
U+0000..U+001F hoặc surrogate đứng lẻ. Giới hạn này cũng giữ snapshot trong body limit 8192 byte.
Provider có cùng `/notes` contract, nhưng chỉ phục vụ khi là owner. Lỗi dùng
`{error:{code,message}}`; facade chuyển nguyên status/body nghiệp vụ của owner.
Route hoặc method không có trong bài trả 404. `committed` là bộ đếm quan sát của
lần chạy hiện tại, **không** là log migration hay nguồn sự thật bền vững.

Các route migration/provider là control plane tin cậy trên loopback, không có
xác thực. Client chỉ được dùng facade. Không expose trực tiếp chúng ra mạng;
triển khai thật cần quyền truy cập control plane và giới hạn tài nguyên. Gate test
không bật trong ví dụ chạy thủ công. Không có credential hay API bên ngoài.

## Kiểm thử và bằng chứng

Unit test được viết trước implementation. Stub đầu tiên làm sai owner ở barrier,
cho phép chuyển pha trái phép và trả policy recovery sai. Đã quan sát assertion
thất bại trong cả script unit và lệnh tập trung, không chỉ lỗi import/typecheck.
Sau implementation chạy:

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/20-strangler-fig/test/lesson.test.mts
git diff --check
```

Unit bao gồm chuyển pha hợp lệ/bất hợp lệ, route ownership, validation snapshot,
hash canonical, reopen SQLite sau interruption, retry không phá write mới và
subprocess import entrypoint với runtime configuration cố ý sai. Test file có
các test `integration:` thật; không có listener khi import test module.

Controller hoặc môi trường được phép mở loopback chạy:

```sh
node --test --test-timeout=15000 --test-isolation=none lessons/20-strangler-fig/test/lesson.test.mts
npm run check
make test
```

HTTP integration khởi động child process riêng và các cổng ephemeral trên
`127.0.0.1`, database trong thư mục tạm của hệ điều hành và được dọn sau test. Các test:

- Đồng bộ gate với `active=1` ở legacy trước khi migrate; chứng minh barrier từ
  chối payload hợp lệ và snapshot chứa write đã nhận sau khi release.
- So API trước/sau, restart cả ba tiến trình với file cũ, chứng minh owner mới
  vẫn giữ dữ liệu và quyền sở hữu.
- Giữ response sau commit ở extracted, quan sát `committed=1`, SIGKILL owner;
  facade trả 503 vì kết quả chưa biết. Restart target thấy dữ liệu đã commit;
  snapshot legacy không có write đó. Khi target tiếp tục ngừng, cả đọc/ghi qua
  facade lỗi mà không fallback.
- SIGKILL facade trong drain rồi restart legacy và facade: barrier vẫn đóng,
  `/migrate` tiếp tục từ snapshot đã drain.
- Drain timeout hữu hạn giữ target passive và barrier đóng; release rồi retry
  mới hoàn tất và bảo toàn dữ liệu.

Mọi request test có deadline; gate có deadline 3 giây. Cleanup dừng child process
trước khi xóa thư mục tạm, kể cả khi assertion thất bại. Worker sandbox không
chạy HTTP integration, `npm run check` hay `make test` vì chúng cần listener;
controller chạy phần đó trong Docker cô lập. Không diễn giải unit pass thành
HTTP integration pass.

## Giới hạn và bài tập

Facade là điểm nghẽn và điểm lỗi đơn. Full-copy có downtime đọc lẫn ghi, giới hạn
30 ghi chú, không phù hợp dữ liệu lớn. Copy JSON và transaction SQLite đơn giản
đổi hiệu năng lấy khả năng giải thích và kiểm tra. Không có CDC, schema evolution,
leader fencing nhiều replica, distributed transaction, tự phục hồi background hay
cam kết exactly-once. Không mở rộng volume bằng cách chỉ tăng timeout: cần đo
thời gian drain, copy, validation, dung lượng và thiết kế một chiến lược khác.

1. Thêm một test interruption ngay sau activate nhưng trước facade commit bằng
   gate rõ ràng; vẫn phải giữ một owner, không dùng sleep phỏng đoán.
2. Thiết kế rollback sau write mới: định nghĩa reverse-copy và cách kiểm tra mọi
   phiên bản dữ liệu, trước khi thêm bất kỳ lệnh mở khóa nào.
3. Đo thời gian copy ở nhiều kích thước, rồi giải thích khi nào snapshot có
   downtime nên được thay bằng seed + CDC + cutover. Đừng triển khai dual-write
   nghiệp vụ để né bài toán nhất quán.
4. Nếu facade có hai replica, bộ đếm local và biến `migrating` còn đủ không?
   Đề xuất leader/fencing token và kiểm thử coordinator cũ sống lại.

## Tham khảo

- [Microsoft Azure — Strangler Fig pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig): bối cảnh chuyển đổi dần và chi phí facade.
- [Martin Fowler — Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html): thay thế chức năng quanh hệ thống cũ theo từng bước.
- [Node.js SQLite](https://nodejs.org/api/sqlite.html) và [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html): phạm vi bảo đảm của transaction cục bộ.
