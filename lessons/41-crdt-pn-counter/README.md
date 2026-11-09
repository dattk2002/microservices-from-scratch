# 41 — CRDT PN-counter: cập nhật độc lập và hội tụ khi trao đổi trạng thái

Ba quầy ghi nhận biến động độc lập: a ghi +7, b ghi −10, c ghi +2. Khi mất liên lạc, mỗi quầy chỉ thấy số của mình. Sau khi chuyển đủ trạng thái, cả ba hiển thị −1. Gửi lại một ảnh chụp không cộng thêm lần nữa.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (<25), npm và các gói phát triển đã khóa ở gốc kho. Runtime chỉ dùng built-in, gồm `node:sqlite`. Chạy từ gốc kho, mỗi lệnh dịch vụ ở một terminal riêng:

```sh
ACTOR_ID=a DB_PATH=/tmp/pn-a.db HOST=127.0.0.1 PORT=4141 node lessons/41-crdt-pn-counter/replica.mts
ACTOR_ID=b DB_PATH=/tmp/pn-b.db HOST=127.0.0.1 PORT=4142 node lessons/41-crdt-pn-counter/replica.mts
ACTOR_ID=c DB_PATH=/tmp/pn-c.db HOST=127.0.0.1 PORT=4143 node lessons/41-crdt-pn-counter/replica.mts
REPLICA_A_ORIGIN=http://127.0.0.1:4141 REPLICA_B_ORIGIN=http://127.0.0.1:4142 REPLICA_C_ORIGIN=http://127.0.0.1:4143 HOST=127.0.0.1 PORT=4144 node lessons/41-crdt-pn-counter/sync.mts
```

Dùng ba đường dẫn DB mới, khác nhau; không xóa DB để “reset” actor đang tồn tại. `PORT=0` chọn cổng trống; dòng JSON `{service,port}` báo sẵn sàng. Mặc định host là loopback, replica port 4141, sync port 4144. `ACTOR_ID`, `DB_PATH` và ba origin là bắt buộc. Origin chỉ có scheme HTTP và host/port, không userinfo, path, query hay fragment. `SYNC_TIMEOUT_MS` mặc định 1000, miền 10..5000 ms. Không có gossip nền hoặc teaching controls.

```sh
curl -s http://127.0.0.1:4141/changes -H 'content-type: application/json' -d '{"id":"sale-a","delta":7}'
curl -s http://127.0.0.1:4142/changes -H 'content-type: application/json' -d '{"id":"sale-b","delta":-10}'
curl -s http://127.0.0.1:4143/changes -H 'content-type: application/json' -d '{"id":"sale-c","delta":2}'
curl -s http://127.0.0.1:4144/sync -H 'content-type: application/json' -d '{"from":"a","to":"b"}'
curl -s http://127.0.0.1:4144/sync -H 'content-type: application/json' -d '{"from":"b","to":"c"}'
curl -s http://127.0.0.1:4144/sync -H 'content-type: application/json' -d '{"from":"c","to":"a"}'
curl -s http://127.0.0.1:4144/sync -H 'content-type: application/json' -d '{"from":"a","to":"b"}'
curl -s http://127.0.0.1:4141/state
```

## Mô hình và kiến trúc

```text
local command → replica a → SQLite a
local command → replica b → SQLite b
local command → replica c → SQLite c
                     ↑          ↑
caller → sync → GET source/state → POST destination/merge
```

`model.mts` chứa phép tính thuần và parser; `store.mts` sở hữu transaction; hai entrypoint chỉ đọc cấu hình, mở DB, đăng ký signal và listener trong `main`. Import không khởi động dịch vụ.

Trạng thái đầy đủ có đúng hai vector `p`, `n`, mỗi vector đúng ba tọa độ `a,b,c`, số nguyên 0..1.000.000. Giá trị là tổng p trừ tổng n. Lệnh dương tăng p của actor cục bộ; lệnh âm tăng n của actor đó. Tọa độ luôn tăng dù giá trị hiển thị có thể giảm, kể cả âm.

Merge lấy max từng tọa độ. Với max, đổi thứ tự, đổi cách nhóm hay lặp lại cùng trạng thái đều cho cùng kết quả. Vì thế một snapshot cũ đến sau snapshot mới không xóa cập nhật. Merge không cộng hai vector: cộng sẽ đếm lại snapshot trùng. Ba actor cố định là giới hạn mô hình; không có join/leave hay reset.

## Hợp đồng HTTP và lưu trữ

- `GET /state` → 200 `{actor,state,value}`.
- `POST /changes` nhận đúng `{id,delta}`. ID là 1..64 ký tự ASCII chữ/số/`_`/`-`. Delta là số nguyên khác 0 trong −1000..1000. Trả 200 envelope ngay sau lệnh.
- Cùng ID và delta trả lại **envelope gốc**, có thể cũ hơn `/state`. Cùng ID khác delta → 409. Receipt là cục bộ: a và b dùng cùng ID vẫn là hai lệnh độc lập.
- Tối đa 16 ID mới trong suốt đời DB. Receipt không bị đẩy ra để nhận ID mới: ID thứ 17 → 409; replay cũ vẫn được nhận. Tràn tọa độ → 409. Cả hai không đổi state hay tiêu tốn receipt.
- `POST /merge` nhận trực tiếp state đầy đủ, không nhận envelope. Parser kiểm tra toàn bộ trước transaction rồi max và trả envelope 200. Thiếu/thừa actor, chuỗi thay số, số lẻ, âm, vượt biên, null, array → 400.
- `POST /sync` nhận đúng `{from,to}`, hai ID khác nhau thuộc a/b/c. Không nhận URL từ caller. Đọc nguồn một lần, parse envelope và kiểm tra actor/value, gửi merge một lần, parse cả phản hồi đích. Trả 200 `{from,to}` khi thành công; 502 nếu upstream lỗi, redirect, quá lớn, sai schema hoặc hết deadline. Input sai → 400.

JSON đầu vào tối đa 8192 byte qua helper chung (quá lớn → 413, sai content-type → 415). ID tối đa nếu escape từng ký tự vẫn chỉ 384 byte; toàn bộ lệnh nhỏ hơn 512 byte. State/envelope có số lượng khóa và tọa độ cố định; kể cả escape mỗi ký tự khóa/actor vẫn dưới 512 byte. Bộ đọc upstream giới hạn 2048 byte trên từng response, không tin `Content-Length`. Khoảng trắng dư có thể làm JSON hợp lệ vượt giới hạn. Deadline bao trùm đọc nguồn, body, gửi merge và body đích. `redirect:error` giữ cố định origin cho cả hai fetch.

SQLite chỉ có một hàng state kèm danh tính và tối đa 16 receipts, không có lịch sử operation tăng vô hạn. `BEGIN IMMEDIATE` bảo vệ state và receipt trong cùng transaction; lỗi rollback. Mở lại DB với actor khác bị từ chối. Shutdown đóng listener trước DB. Route không biết → 404.

Một 502 có thể xảy ra **sau khi đích đã commit** nhưng trước khi sync đọc được phản hồi. Không thể hứa “zero effects” trong trường hợp đó; caller có thể lặp merge an toàn. Ngược lại, nguồn sai schema/identity/value/quá lớn/redirect/timeout bị chặn trước mọi write ở đích.

## Giả định và giới hạn

Mỗi actor có đúng một writer đáng tin và kho bền vững riêng. Hai tiến trình tự nhận cùng actor rồi tăng từ cùng mốc sẽ mất một cập nhật khi max: đây không phải cơ chế phân phát danh tính. Xóa hoặc phục hồi DB từ bản cũ cũng có thể mất cập nhật và receipts. Không dùng DB chung cho nhiều actor.

Hội tụ cần eventual delivery: phải có đường trao đổi mang mọi cập nhật đến mọi replica. Dừng trao đổi có thể giữ phân kỳ mãi. Không có auth; người gọi có thể giả tọa độ 1.000.000, làm sai giá trị hoặc khiến actor hết khả năng tăng. Giới hạn byte bảo vệ bộ nhớ, không xác thực nguồn.

PN-counter không bảo đảm stock không âm, uniqueness toàn cục hay linearizability. Ví dụ hai quầy cùng thấy còn 1 vẫn có thể bán tổng cộng 2. [Bài 33 fencing](../33-leader-lease-fencing/README.md) tập trung ngăn writer cũ thực thi sau khi mất lease; [bài 38 reservations](../38-tcc-reservations/README.md) dùng giữ chỗ và quyết định giao dịch. Không thể thay những giao thức đó bằng max nếu nghiệp vụ yêu cầu không vượt tồn kho.

## Kiểm chứng và bài tập

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/41-crdt-pn-counter/test/lesson.test.mts
node --test --test-timeout=15000 lessons/41-crdt-pn-counter/test/lesson.test.mts
npm run check
make test
```

Unit dùng SQLite `:memory:` để kiểm tra đại số, receipt, overflow và rejection nguyên tử. Integration tạo process độc lập, DB trong `node:os.tmpdir()`, ephemeral port, request deadlines và cleanup trong `finally`: mất liên lạc, snapshot cũ, duplicate sync, restart, sai actor, đầy receipts, malformed input, nguồn giả sai schema/identity/value/byte limit, redirect, deadline và import im lặng với cấu hình sai. Fixture quá lớn vẫn là JSON đúng schema và đúng giá trị; fixture escape tối đa vẫn được chấp nhận. Worker không chạy HTTP integration do sandbox không có network; controller chạy chúng trong Docker cô lập. Không suy ra kết quả HTTP từ unit.

1. Sau ví dụ −1, chụp state a, thêm −3 ở b rồi phát tán cả snapshot mới và cũ theo thứ tự đảo. Dự đoán sáu tọa độ và giá trị cuối trước khi chạy.
2. Thử ID thứ 17 rồi replay ID đầu. Vì sao tự động xóa receipt cũ sẽ thay đổi hợp đồng?
3. Lập phản ví dụ cho hai writer cùng actor. Vì sao UUID của command không sửa được phép max trong mô hình này?
4. Thiết kế chính sách khi gần 1.000.000. Vì sao reset tọa độ tại một replica không an toàn?

Nguồn: [Preguiça, Conflict-free Replicated Data Types: An Overview](https://arxiv.org/abs/1805.06358), [Node SQLite](https://nodejs.org/api/sqlite.html), [Node test runner](https://nodejs.org/api/test.html).
