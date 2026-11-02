# 12 — Saga và hành động bù trừ

Một đơn đặt sách `book-12` cần giữ hàng rồi thu tiền mô phỏng. Inventory và
Payment chạy trong hai tiến trình riêng, mỗi bên sở hữu SQLite riêng. Orchestrator
lưu tiến độ trước khi gửi HTTP. Đây là saga điều phối, **không phải giao dịch ACID
phân tán**: người quan sát có thể thấy hàng đang giữ trong khi chưa có thanh toán.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (bao gồm `node:sqlite`, có thể có cảnh báo experimental), npm,
và các dev dependency đã cài ở root. Không cần package runtime, tài khoản, Docker
hay dịch vụ bên ngoài. Chạy từ root repository. Các file DB mặc định tạo tại thư
mục làm việc; chọn đường dẫn khác bằng `DB_PATH`. Không dùng chung một DB cho
nhiều tiến trình. Thư mục chứa DB phải tồn tại và có quyền ghi.

Mở ba terminal:

```sh
ROLE=inventory PORT=3012 DB_PATH=/tmp/saga-inventory.sqlite node lessons/12-saga-compensation/participant.mts
ROLE=payment PORT=3013 DB_PATH=/tmp/saga-payment.sqlite node lessons/12-saga-compensation/participant.mts
PORT=3014 DB_PATH=/tmp/saga-orders.sqlite INVENTORY_URL=http://127.0.0.1:3012 PAYMENT_URL=http://127.0.0.1:3013 node lessons/12-saga-compensation/orchestrator.mts
```

Gửi yêu cầu bằng built-in fetch (không gọi Internet):

```sh
node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3014/sagas",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"book-12",refusal:false}),signal:AbortSignal.timeout(5000)}); console.log(r.status,await r.json())'
```

`refusal:true` mô phỏng Payment từ chối chắc chắn, không phải thẻ thật. Mỗi ví dụ
mới dùng ID mới; đổi payload của cùng ID trả 409.

## Kiến trúc và trạng thái

```text
Client → Orchestrator (orders SQLite)
             ├── POST /reserve → Inventory (effects SQLite)
             ├── POST /charge  → Payment   (effects SQLite)
             └── POST /release → Inventory khi Payment từ chối

reserving → charging → completed
                └── compensating → cancelled
                          └── compensation_failed → /recover → compensating
```

`reserving` và `charging` là ý định bền vững. Ghi trạng thái kế tiếp chỉ sau phản
hồi hợp lệ. Nếu tiến trình chết sau hiệu ứng từ xa nhưng trước ghi nhận cục bộ,
recovery gửi lại thao tác với cùng ID. Participant lưu kết quả theo ID bằng một
SQL statement autocommit; khóa duy nhất và bản ghi hiệu ứng cùng là dữ liệu kinh
doanh mô phỏng. Reserve lặp không giữ thêm hàng; charge lặp không thu thêm tiền;
release lặp không hoàn thêm hàng. Một reservation đã released không bị reserve
lặp làm sống lại. Dữ liệu refusal cũng được kiểm tra để phát hiện ID xung đột.

Mỗi tiến trình dùng SQLite WAL và synchronous FULL. Đây là độ bền trên ổ đĩa cục
bộ theo bảo đảm của SQLite và filesystem, không chịu được mất toàn bộ ổ đĩa.
Không lưu DB trong thư mục tạm nếu muốn phục hồi sau khi máy dọn thư mục đó.
Orchestrator tuần tự hóa POST qua một queue để tránh hai retry cùng đổi tiến độ;
GET vẫn đọc được trạng thái đang xử lý. Chỉ chạy một orchestrator cho mỗi DB.

## Hợp đồng HTTP

Tất cả POST cần `Content-Type: application/json`, body
`{"id":"book-12","refusal":false}`. ID gồm 1–64 chữ ASCII, số hoặc dấu gạch ngang;
refusal bắt buộc là boolean. Giới hạn JSON 8192 byte từ helper chung.

| Tiến trình | Route | Kết quả |
| --- | --- | --- |
| Inventory | POST /reserve | 200, state reserved hoặc kết quả cũ released |
| Inventory | POST /release | 200 released; ID chưa tồn tại là no-op |
| Payment | POST /charge | 200 charged hoặc 402 refused, quyết định lưu bền vững |
| Participant | GET /state | 200, mảng bản ghi mô phỏng để quan sát |
| Orchestrator | POST /sagas | Tạo hoặc tiếp tục ID đã có |
| Orchestrator | POST /recover | Tiếp tục ID đã tồn tại, không tạo mới |
| Orchestrator | GET /sagas/:id | 200 bản ghi hoặc 404 |

Orchestrator trả 200 khi completed/cancelled; trả 202 khi còn pending hoặc
compensation_failed. Body gồm id, refusal (SQLite 0/1), state. 202 không hứa tác vụ
nền sẽ tự chạy: người vận hành phải gọi recover hoặc gửi lại cùng yêu cầu.
Input sai 400, JSON sai 400, media type sai 415, ID xung đột 409, route sai 404;
lỗi nội bộ 500. Helper HTTP đặt request/header timeout 5 giây. Mỗi HTTP outbound
có deadline 1 giây; một lượt tối đa ba thao tác liên tiếp. Client nên chờ ít nhất
5 giây. Client timeout không hủy một hiệu ứng đã thực hiện ở participant.

HOST mặc định 127.0.0.1, PORT mặc định Inventory 3012, Payment 3013, saga 3014;
PORT=0 chọn ephemeral port. ROLE chỉ nhận inventory/payment. INVENTORY_URL và
PAYMENT_URL chỉ nhận HTTP tới 127.0.0.1. Không thiết kế endpoint proxy ra ngoài.
Đây là demo tin cậy trên loopback, chưa có auth/TLS.

## Bù trừ thất bại và phục hồi tường minh

Dừng Inventory, chạy lại với cùng DB và `FAIL_RELEASE=1`. Tạo ID mới với
refusal=true: reserve thành công, Payment trả 402, release trả 503. Saga trả 202
với compensation_failed, hàng vẫn reserved. Có thể dừng và khởi động lại
orchestrator bằng cùng DB: trạng thái còn nguyên, không tự retry.

Sửa Inventory bằng cách bỏ FAIL_RELEASE và restart với cùng DB. Nếu đổi port,
restart orchestrator với INVENTORY_URL mới. Gửi body ban đầu tới `/recover`:

```sh
node --input-type=module -e 'const r=await fetch("http://127.0.0.1:3014/recover",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"book-failed",refusal:true}),signal:AbortSignal.timeout(5000)}); console.log(r.status,await r.json())'
```

Dùng đúng ID đã tạo (ví dụ book-failed). Kết quả cancelled nghĩa là bù trừ đã được
xác nhận; không có nghĩa mọi quan sát trước đó bị xóa. Payment refused không cần
refund vì chưa charge. Không có thao tác sau charge trong bài này; nếu thêm bước
vận chuyển thì cần thiết kế refund riêng, không dùng release thay refund.

Timeout/lỗi 5xx ở charge là **kết quả chưa biết**, không coi là refusal. Giữ
charging và retry cùng ID sau khi dịch vụ hoạt động lại. Lỗi reserve cũng giữ
reserving. Phản hồi sai schema/status không cho chuyển tiếp. Lỗi release giữ
compensation_failed; thao tác có thể đã thành công từ xa, nên retry phải idempotent.
Không tự động lặp vô hạn hay suy đoán thành công khi dịch vụ mất kết nối.

## Kiểm thử và giới hạn

```sh
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/12-saga-compensation/test/lesson.test.mts
```

Lệnh cuối cần môi trường cho phép HTTP loopback. Integration test khởi động các
child process độc lập, PORT=0, DB tạm riêng; đăng ký cleanup khi tạo mỗi tài nguyên.
Chúng kiểm tra thành công và replay, refusal và release, lỗi bù trừ rồi restart
hai service và recover. Test cửa sổ crash dựng trạng thái xác định khi orchestrator
đã dừng: intent charging cùng hiệu ứng remote đã commit, rồi khởi động lại và
retry. Đây là fixture mô phỏng cửa sổ crash, không phải thử cắt điện ngẫu nhiên.
Unit test không mở listener, kiểm tra quyết định recovery, reopen DB và dedup.

Worker chỉ chạy typecheck và unit; controller chạy HTTP integration trong Docker
cô lập. Không suy ra integration pass từ unit pass.

Bài học cố ý không có số lượng tồn kho, tiền tệ, nhà cung cấp thanh toán, queue,
lịch retry tự động, leader election, TTL/dọn dedup, nhiều orchestrator hay dashboard
vận hành. SQLite và queue toàn cục giới hạn throughput. Dedup giữ vô thời hạn;
xóa quá sớm có thể cho phép hiệu ứng lặp. ID là định danh nghiệp vụ ổn định, không
phải ID mới cho mỗi lần retry. Trong hệ thống thực cần cảnh báo saga tồn đọng,
kiểm soát quyền recovery, audit và quy trình can thiệp nghiệp vụ.

## Bài tập

1. Thêm số lượng và kiểm tra cùng ID khác số lượng trả 409 ở cả ba service.
2. Thêm bước giao hàng sau charge; thiết kế refund với idempotency riêng và test
   refund thất bại qua restart trước khi triển khai.
3. Thiết kế retry có backoff, deadline nghiệp vụ và cảnh báo; giải thích vì sao
   hết deadline không tự chứng minh remote operation thất bại.

## Nguồn

- [Saga pattern — microservices.io](https://microservices.io/patterns/data/saga.html):
  chuỗi giao dịch cục bộ và hành động bù trừ, thiếu isolation toàn cục.
- [Node.js SQLite](https://nodejs.org/api/sqlite.html): DatabaseSync và prepared statements.
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html): phạm vi bảo đảm
  commit cục bộ, không mở rộng thành ACID qua HTTP.
