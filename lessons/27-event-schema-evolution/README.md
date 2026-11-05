# 27 — Tiến hóa schema sự kiện và upcasting không sửa lịch sử

Cần Node.js 24.12+ (nhánh 24), npm và kiến thức HTTP, SQLite, transaction,
checkpoint, idempotency từ các bài trước. Không cần dịch vụ ngoài hoặc package runtime.
Chạy mọi lệnh dưới đây tại gốc repository; development dependencies đã được pin ở gốc.

Mục tiêu: đổi định dạng integration event mà không sửa dữ liệu producer đã phát.
Ví dụ gốc là sự kiện ghi nhận doanh thu của một đơn hàng. Mỗi sự kiện là một
khoản đóng góp độc lập, không phải bản snapshot để cộng lại sau mỗi lần cập nhật đơn.
Bài này không triển khai event sourcing cho aggregate hoặc framework CQRS.

## Ba loại số khác nhau

| Trường | Ý nghĩa | Ví dụ |
| --- | --- | --- |
| `position` | Thứ tự toàn cục của nguồn duy nhất | 1 rồi 2 |
| `revision` | Phiên bản định dạng integration event | 1 hoặc 2 |
| `payload.resourceVersion` | Phiên bản nghiệp vụ của đơn tại thời điểm phát | 7 hoặc 3 |

`id` là danh tính event, độc lập với cả ba số trên. `orderId` không phải khóa dedup.
Position liên tục, không phải timestamp. Không dùng resourceVersion làm checkpoint.

Revision 1 có `totalCents` nguyên dương. **Hợp đồng lịch sử của nguồn v1 luôn là
USD**: nguồn này chưa từng phát tiền khác USD. Vì thế upcaster gán USD có bằng
chứng nghiệp vụ; không đoán từ locale, ngày, quốc gia hay cấu hình hiện tại.
Revision 2 chuyển sang `amount: {amountMinor, currency}`. Bài chỉ chấp nhận USD:
thêm EUR sẽ cần chính sách nghiệp vụ mới, không được cộng lẫn đơn vị vào một tổng.
Cả hai vào canonical model có amountMinor/currency, giữ nguyên id/position và
resourceVersion. Upcaster thuần, đồng bộ, không I/O, không sửa đầu vào.

## Kiến trúc và transaction

```text
POST /events → owner.mts → owner.sqlite (raw, append-only)
                               ↓ GET /events?after=N (tối đa 10)
POST /sync → consumer.mts → parse → upcast v1/v2 → consumer.sqlite
                                                  effect + SHA256 + checkpoint
```

Hai process, hai DB riêng. Không mở SQLite, đọc cấu hình, đăng ký signal hoặc
listen khi import. Tất cả nằm trong main, được gọi dưới `import.meta.main`.
Không có poller; mỗi lần `/sync` là một batch có giới hạn, dễ quan sát và lặp lại.

Owner giữ JSON đúng định dạng revision đã nhận, không chuyển lịch sử thành v2.
Trigger SQLite cấm UPDATE/DELETE; API không cung cấp đường sửa/xóa. Không giữ
nguyên whitespace JSON HTTP vì body đã được parse. Tối đa 100 event, từ chối
append tiếp (`retention_full`) thay vì âm thầm xóa lịch sử/checkpoint cũ. Đây là
retention hữu hạn phục vụ bài học, không phải chiến lược lưu trữ production.

Consumer dùng BEGIN IMMEDIATE. Kiểm tra fingerprint raw envelope đã chuẩn hóa
thứ tự key, kiểm tra position kế tiếp, ghi effect, ghi checkpoint, COMMIT cùng
một transaction. Lỗi sẽ ROLLBACK. Event trùng hoàn toàn trả applied=false;
cùng id nhưng khác payload, position hoặc revision là `identity_conflict`, kể cả
hai payload có cùng canonical meaning. SHA256 là nhận dạng nội dung, không phải
chữ ký xác thực. Dedup bền vững qua restart. Tổng tối đa 100 × 10^9 vẫn an toàn
cho integer JavaScript với nguồn giới hạn này.

Atomicity theo **từng event**, không theo toàn trang: nếu position 2 hỏng thì
position 1 đã commit, checkpoint=1. Không skip position 2 và không áp dụng 3.
Retry đọc lại từ 1, gặp lại 2 và dừng. Chưa hỗ trợ revision không có nghĩa là
sự kiện độc hại; cần triển khai reader phù hợp, không tự tải schema/code từ mạng.

## Chạy thủ công

Hai terminal; dùng đường DB khác nhau:

```sh
HOST=127.0.0.1 PORT=3027 DB_PATH=/tmp/schema-owner.sqlite node lessons/27-event-schema-evolution/owner.mts
HOST=127.0.0.1 PORT=3028 DB_PATH=/tmp/schema-consumer.sqlite OWNER_URL=http://127.0.0.1:3027 PROFILE=legacy node lessons/27-event-schema-evolution/consumer.mts
```

Mỗi process in một dòng JSON `{service,port}` khi sẵn sàng. PORT=0 cho port ngẫu
nhiên: lấy port owner từ dòng readiness rồi truyền vào OWNER_URL của consumer.
HOST mặc định 127.0.0.1, PORT mặc định 3027/3028; DB_PATH mặc định owner.sqlite /
consumer.sqlite trong working directory. PROFILE chỉ `legacy` hoặc `current`
(mặc định current). SIGTERM/SIGINT đóng server rồi DB.

```sh
curl -sS --max-time 3 -H 'content-type: application/json' http://127.0.0.1:3027/events -d '{"id":"sale_a","position":1,"revision":1,"payload":{"orderId":"order_a","resourceVersion":7,"totalCents":150}}'
curl -sS --max-time 3 -H 'content-type: application/json' http://127.0.0.1:3027/events -d '{"id":"sale_b","position":2,"revision":2,"payload":{"orderId":"order_b","resourceVersion":3,"amount":{"amountMinor":150,"currency":"USD"}}}'
curl -sS --max-time 3 -H 'content-type: application/json' http://127.0.0.1:3028/sync -d '{}'
curl -sS --max-time 3 http://127.0.0.1:3028/state
```

Legacy dừng ở revision 2 với 422 và state `{checkpoint:1,totalMinor:150,count:1}`.
Dừng consumer, chạy lại cùng DB_PATH với PROFILE=current, rồi POST /sync: state
thành `{checkpoint:2,totalMinor:300,count:2}`. GET owner `/events` vẫn chứa v1/v2
như ban đầu. POST sync lần nữa không cộng thêm. Dữ liệu demo không tự xóa;
dùng tên DB mới cho lần thực hành khác.

## Hợp đồng và giới hạn

- Owner POST `/events`: envelope chính xác id/payload/position/revision; 201 khi
  append thành công. Id/orderId: 1..64 ký tự chữ ASCII, số, `_` hoặc `-`.
- GET `/events?after=0`: mảng tối đa 10 event tăng dần; after 0..10^9. POST không
  tự cấp position: một writer cung cấp position liên tục. Nhiều producer cần
  sequencer riêng, nằm ngoài bài.
- Consumer POST `/sync` body `{}`: 200 với state, 409 khi sync đang chạy. Một lần
  chỉ đọc tối đa một trang. GET `/state`: checkpoint, tổng USD minor units, count.
- Sai shape/type, integer không an toàn, âm/0, currency không phải string USD,
  revision không hỗ trợ, gap hoặc trùng id xung đột: 422 với error.code cụ thể.
  Currency dạng `["USD"]` hay object luôn bị từ chối, không ép String().
- Body HTTP tối đa 8192 byte; payload tối đa 2048 byte; upstream body tối đa
  32768 byte và 10 phần tử. Position/resourceVersion/amount tối đa 10^9, revision
  envelope 1..100. Reader chỉ hỗ trợ 1/2. Key lạ bị từ chối.
- Deadline fetch nguồn 2 giây gồm đọc body; request/header timeout server 5 giây;
  SQLite busy timeout 1 giây; test request 2/5 giây, startup 5 giây và teardown
  cưỡng bức sau 1,5 giây. API không hỗ trợ gọi nguồn tùy ý: OWNER_URL chỉ HTTP
  loopback 127.0.0.1 không credential, path gốc. Không có retry nền vô hạn.
- Lỗi nguồn non-2xx: 502; JSON nguồn không hợp lệ/lỗi nội bộ: 500; route sai: 404;
  media type sai: 415; body quá lớn: 413. Không có silent success cho dữ liệu hỏng.

## Teaching controls / Playground

Chỉ bật cục bộ bằng `TEACHING_CONTROLS=1` ở process tương ứng:
owner POST `/teaching/raw` nhận envelope hợp lệ nhưng bỏ kiểm tra schema payload;
consumer POST `/teaching/deliver` đưa trực tiếp một event qua cùng transaction
apply. Route vẫn giới hạn body, payload và revision envelope. Khi tắt trả 404.
Đây là đường điều khiển giáo dục, không có auth, không triển khai công khai.
Dùng raw để thêm revision 3 hoặc payload revision 2 sai kiểu giữa hai envelope
hợp lệ; dùng deliver để phát lại v1 và kiểm chứng dedup/conflict. Không có công
cụ sửa lịch sử. Thay PROFILE bằng restart minh họa nâng cấp reader thực sự.

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/27-event-schema-evolution/test/lesson.test.mts
# Trong môi trường controller cho phép loopback:
node --test --test-timeout=15000 lessons/27-event-schema-evolution/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit đã được chạy RED với assertion khác biệt thực (null thay canonical model,
false thay apply=true), rồi GREEN sau triển khai. SQLite unit dùng :memory:.
Unit import spawn child với PORT/DB_PATH/PROFILE/OWNER_URL cố ý sai, phải exit 0
và stdout/stderr rỗng (chỉ tắt ExperimentalWarning của SQLite).
HTTP integration dùng process thật, ephemeral loopback, DB dưới node:os tmpdir,
try/finally dọn child và thư mục; không tạo fixture dưới source. Test legacy
restart giữ DB, mixed meaning, history không đổi, duplicate và conflict; hai
fixture khác kiểm tra revision lạ và payload sai giữa envelope hợp lệ, xác nhận
error.code và checkpoint sau retry. Worker không chạy HTTP integration vì sandbox
cấm mạng; controller phải chạy các lệnh HTTP/full check ở môi trường cô lập.

## Thiết kế khi thay đổi tiếp

Thêm field tùy chọn có thể additive nếu reader cũ cho phép key mới và định nghĩa
rõ thiếu field. Reader strict trong bài này không cho key lạ: ngay cả thêm field
cũng phải nâng revision hoặc thay hợp đồng reader. Đổi đơn vị, cấu trúc, currency
hoặc ý nghĩa field là breaking; không chỉ đổi TypeScript interface.

Rollout: deploy consumer đọc được cũ+mới trước, kiểm chứng, rồi bật producer phát
mới. Giữ reader cũ trong test để thấy hậu quả rollout ngược. Khi reader đã phát
hiện revision mới, rollback về legacy không thể tiếp tục đọc; phải dừng writer
mới hoặc nâng reader. Không đổi checkpoint để vượt record lỗi.

Nếu có v3, giữ parser cho từng revision và chuỗi upcaster rõ v1→v2→v3 hoặc các
adapter vào canonical mới. Giữ golden fixtures lịch sử và kiểm tra tính xác định,
không mutation, bảo toàn identity/position. Không bỏ upcaster cũ khi event cũ còn
có thể replay. Chuỗi dài tăng chi phí và trách nhiệm kiểm chứng; bản canonical
không thay thế raw lịch sử. Bài bỏ qua multi-source, authentication, archival,
crash injection và metric; dedup không bảo đảm exactly-once cho side effect ngoài DB.

Bài tập: thêm v3 có field thuế với invariant lịch sử có bằng chứng; viết test
upcast nhiều bước. Thiết kế retention archive không làm mất dữ liệu consumer
chậm. Thử thay resourceVersion=99 và chứng minh checkpoint vẫn theo position.
Giải thích vì sao đổi totalCents thành EUR mà giữ revision=1 làm hỏng nghĩa lịch sử.

Nguồn tham khảo (đọc khái niệm, ví dụ của bài được viết riêng):

- [Axon event versioning và upcasting](https://docs.axoniq.io/axon-framework-reference/4.11/events/event-versioning/)
- [Microsoft: Event Sourcing pattern và các đánh đổi](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
