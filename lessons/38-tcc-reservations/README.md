# 38 — Try–Confirm–Cancel: giữ tài nguyên, quyết định bền vững

Bài này dùng inventory và ví **điểm demo**, không thanh toán thật. Mỗi participant là một tiến trình với SQLite riêng; coordinator cũng có SQLite riêng. Cần Node.js 24.12+ (nhánh 24), kiến thức HTTP, idempotency và saga ở bài 12. Runtime chỉ dùng module built-in; chạy lệnh từ thư mục gốc repository sau khi cài development dependencies đã ghim.

## Chạy ba tiến trình

Mỗi lệnh chạy ở terminal riêng. Chọn đường dẫn DB khác nhau; không dùng chung DB giữa dịch vụ. Các file SQLite được tạo khi khởi động, cùng WAL/SHM nếu cần.

```sh
RESOURCE=inventory CAPACITY=10 DB_PATH=/tmp/tcc-inventory.sqlite HOST=127.0.0.1 PORT=3831 node lessons/38-tcc-reservations/participant.mts
RESOURCE=wallet CAPACITY=20 DB_PATH=/tmp/tcc-wallet.sqlite HOST=127.0.0.1 PORT=3832 node lessons/38-tcc-reservations/participant.mts
INVENTORY_ORIGIN=http://127.0.0.1:3831 WALLET_ORIGIN=http://127.0.0.1:3832 DB_PATH=/tmp/tcc-coordinator.sqlite HOST=127.0.0.1 PORT=3830 node lessons/38-tcc-reservations/coordinator.mts
```

`PORT=0` chọn cổng tạm; dòng JSON `{service,port}` báo sẵn sàng. `HOST` mặc định loopback. `RESOURCE` bắt buộc là `inventory` hoặc `wallet`; `CAPACITY` mặc định 10, nguyên 1..1000000. Khởi động lại participant phải giữ nguyên capacity và DB. Origin bắt buộc HTTP thuần, không credentials, path, query hoặc fragment. Ví dụ chỉ chạy cục bộ, không có xác thực hay bảo vệ cho mạng công cộng.

```sh
curl -sS -H 'content-type: application/json' -d '{"id":"order-38","quantity":3,"amount":7}' http://127.0.0.1:3830/transactions
curl -sS http://127.0.0.1:3830/transactions/order-38
curl -sS http://127.0.0.1:3831/state
curl -sS -H 'content-type: application/json' -d '{"id":"order-38"}' http://127.0.0.1:3830/recover
```

Kết quả thành công: coordinator `committed`; inventory consumed=3, ví consumed=7. Gửi lại payload giữ nguyên không tiêu thụ lần hai. Dùng id mới và amount=21 để thấy ví từ chối Try; inventory được Cancel và trở lại available trước đó.

## Hợp đồng

Tất cả POST cần `application/json`. Id là chuỗi dài 1..64 UTF-16 code units, được so sánh nguyên dạng, kể cả ký tự cần escape; units/quantity/amount là số nguyên 1..1000000. Không ép chuỗi thành số. Field bổ sung được bỏ qua. JSON đầu vào tối đa 8192 byte; payload hợp lệ do bài sinh ra lớn nhất dưới 512 byte: 64 ký tự escape `\uXXXX` dùng 384 byte cộng tên field và hai số 7 chữ số. Vì vậy cả id escape cực đại vẫn hợp lệ.

| Dịch vụ / route | Payload / kết quả |
| --- | --- |
| Participant `POST /try` | `{id,units}` → `{resource,id,units,status}`; giữ chỗ nếu đủ available |
| Participant `POST /confirm` | Cùng payload; held → confirmed, tiêu thụ đúng một lần |
| Participant `POST /cancel` | Cùng payload; held → cancelled, giải phóng đúng một lần; chưa có id thì ghi tombstone |
| Participant `GET /state` | `{resource,capacity,available,held,consumed}` |
| Coordinator `POST /transactions` | `{id,quantity,amount}`; bind trước mọi Try |
| Coordinator `GET /transactions/:id` | Record gồm payload, decision, hai acknowledgement và status |
| Coordinator `POST /recover` | `{id}`; phục hồi có giới hạn ngay trong request |

Try replay của confirmed trả confirmed; Try của cancelled bị 409. Confirm/cancel replay cùng trạng thái terminal trả 200. Confirm chưa Try, đổi payload, đổi terminal hoặc quá 16 identities trả 409. Thiếu tài nguyên cũng 409. Id bị từ chối do thiếu tài nguyên chưa được giữ lại cho đến khi Cancel ghi tombstone. Không xoá tombstone hay tự hết hạn hold. Tổng luôn thỏa `available + held + consumed = capacity`.

Coordinator trả 200 cho committed/aborted, 202 cho pending, 404 nếu recovery/GET không biết id. Payload sai 400, media type sai 415, body quá lớn 413. Một thao tác POST đang chạy chiếm admission; POST khác nhận 503 `busy`, không xếp hàng nền. GET vẫn đọc được quyết định đã ghi. Giới hạn 16 giao dịch giữ vĩnh viễn; cần DB mới cho đợt thử khác, chỉ khi đã xử lý mọi pending. Không dùng xóa dữ liệu để “sửa” giao dịch đang treo.

## Quyết định và sự cố

Coordinator tuần tự Try inventory rồi ví. Khi cả hai reply hợp lệ, coordinator ghi **commit xuống SQLite trước Confirm đầu tiên**. Mọi lỗi Try, kể cả timeout không biết bên kia đã giữ chỗ chưa, dẫn đến quyết định abort bền vững, rồi Cancel **cả hai**. Reply phải khớp resource/id/units và trạng thái primitive hợp lệ trước khi được dùng. Fetch có deadline 700ms bao gồm đọc body, giới hạn reply 1024 byte và `redirect: error`; không chuyển payload qua redirect sang origin khác. Request server có giới hạn thời gian 5 giây. Hai phase delivery lỗi vẫn được thử độc lập; pending yêu cầu gọi recover tiếp.

Crash trước quyết định: record undecided có thể đi kèm hold ở một hoặc hai participant. Recover ghi abort rồi Cancel cả hai; tombstone chặn Try đến muộn. Crash sau commit: chỉ Confirm, tuyệt đối không chuyển abort. Nếu participant đã confirm mà reply mất, replay confirm trả cùng kết quả. Acknowledgement lưu bền vững nên có thể đã nhận hoặc chưa nhận reply mà không tiêu thụ hai lần. Crash sau abort cũng chỉ tiếp tục Cancel. SQLite dùng synchronous FULL và WAL; bảo đảm còn phụ thuộc filesystem/phần cứng thực hiện fsync đúng. Demo giả định một tiến trình sở hữu mỗi DB, không có hai coordinator cùng thao tác DB.

Không có bộ quét nền hay expiry. Hold treo phải được operator khôi phục từ coordinator có DB còn nguyên. Tự hết hạn sau commit có thể bán mất tài nguyên đã hứa; mất DB quyết định là tình huống cần xử lý vận hành, bài không tự suy diễn quyết định mới. Restart participant giữ trạng thái; cấu hình đổi capacity bị từ chối.

TCC đặt giữ trước rồi kết thúc reservation; saga thường thực hiện tác động nghiệp vụ trước rồi gọi compensation. Cancel ở đây chỉ giải phóng phần đang held, không “hoàn tiền” phần đã confirmed. **Không có khả năng nhìn thấy all-or-nothing tức thời giữa các store độc lập**: inventory có thể confirmed trong khi ví còn held. Đây không phải giao thức consensus hay giao dịch ACID phân tán; partition có thể để pending vô hạn. Giới hạn id giúp demo hữu hạn nhưng không phải chiến lược retention production.

## Playground và lỗi có kiểm soát

Khởi động participant với `TEACHING_CONTROLS=1` để bật route giáo dục cục bộ:

```sh
curl -sS -H 'content-type: application/json' -d '{"phase":"confirm","enabled":true}' http://127.0.0.1:3832/teaching/failure
```

Phase chỉ nhận chuỗi `try`, `confirm`, `cancel`; enabled là boolean thật. Khi bật, phase trả 503 **trước mutation**; không bỏ qua invariants. Gửi enabled=false để sửa lỗi; control không lưu qua restart. Không bật flag thì route trả 404. Ví dụ: chặn Confirm ví, tạo giao dịch thấy 202/commit và ví held; dừng rồi khởi động coordinator với cùng DB; tắt lỗi và gọi recover để roll forward. Chặn Try ví và Cancel ví để thấy abort pending; sửa Cancel rồi recover. Chỉ bật trên loopback phục vụ học tập.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/38-tcc-reservations/test/lesson.test.mts
node --test --test-timeout=15000 lessons/38-tcc-reservations/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite memory, kiểm tra bảo toàn, replay, xung đột, tombstone, giới hạn và quyết định. Test import chạy child với cấu hình cố ý sai, yêu cầu exit 0 và im lặng. Integration dùng tiến trình độc lập, cổng loopback tạm và DB dưới `tmpdir()`, cleanup trong finally; có restart, recovery undecided/commit/abort, capacity, disabled controls, id escape cực đại, reply malformed/oversized và redirect. Barrier upstream báo đã nhận Try rồi mới gửi request cạnh tranh, để chứng minh busy từ trạng thái quan sát được thay vì dựa vào thời gian ngủ. Fixture oversized có payload/schema đúng ngoại trừ byte budget; bỏ gate sẽ cho Try được chấp nhận và commit, làm test thất bại. HTTP tests cần môi trường cho phép listen; worker hạn chế mạng chỉ chạy typecheck và unit, outer controller chạy HTTP trong Docker cô lập.

Bài tập: mô phỏng mất reply Confirm sau mutation; giải thích vì sao phải giữ id terminal lâu hơn cửa sổ retry. Thiết kế retention có bằng chứng không còn thông điệp muộn. Thảo luận operator làm gì khi mất DB coordinator nhưng hai participant vẫn giữ hold. Phân tích tại sao retry vô hạn trong request không cải thiện partition.

Nguồn: [Seata TCC](https://www.seata.io/blog/seata-tcc/) và [TCC fence, empty rollback và hanging](https://www.seata.io/blog/seata-tcc-fence/). Mã trong bài là triển khai học tập riêng, không mô phỏng đầy đủ Seata.

ID phải gồm 1–64 UTF-16 code units well-formed. Boundary kiểm tra round-trip UTF-8 trước khi đưa vào SQLite: surrogate đơn lẻ sẽ bị thay bằng U+FFFD khi mã hóa và có thể làm hai ID khác nhau trùng khóa. Vì vậy chúng trả400 trước khi ghi; NUL hợp lệ, emoji đủ cặp surrogate và U+FFFD thật vẫn được giữ nguyên. Đường GET có percent encoding sai cũng trả400 thay vì lỗi nội bộ. Test unit và HTTP kiểm tra không có hiệu ứng tài nguyên với ID lỗi, và replay ID emoji vẫn idempotent.
