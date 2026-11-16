# 69 — CDC bằng trigger SQLite, snapshot nhất quán và chuyển sang change log

Một replica mới cần ảnh chụp ban đầu và những thay đổi xảy ra sau ảnh chụp ấy. Nếu đọc danh sách item trước, rồi đọc cursor sau bằng hai giao dịch khác nhau, một thay đổi chen giữa có thể nằm ngoài danh sách nhưng lại bị cursor đánh dấu đã xử lý. Bài này giữ `items` và `through` trong cùng một giao dịch đọc SQLite, rồi chuyển sang change log được giữ nguyên vĩnh viễn trong giới hạn của ví dụ.

## Điều kiện và chạy thử

Cần Node.js **24.12+ thuộc nhánh 24**, có `node:sqlite`, `fetch` và khả năng chạy `.mts` trực tiếp. Các lệnh dưới đây chạy từ gốc repository; runtime chỉ dùng built-in. TypeScript và kiểu Node là dependency phát triển được ghim tại gốc. Không cần Docker, broker, tài khoản hay dịch vụ bên ngoài để chạy native.

Mỗi service là một tiến trình độc lập, sở hữu một file riêng. Tạo thư mục mới cho mỗi lần thực hành, ví dụ `/tmp/cdc69-demo`; dùng lại cùng file khi muốn minh họa restart. Trong terminal 1:

```sh
mkdir -p /tmp/cdc69-demo
HOST=127.0.0.1 PORT=3069 DB_PATH=/tmp/cdc69-demo/source.sqlite \
  node lessons/69-cdc-snapshot-handoff/source.mts
```

Terminal 2:

```sh
HOST=127.0.0.1 PORT=3070 DB_PATH=/tmp/cdc69-demo/replica.sqlite \
  SOURCE_ORIGIN=http://127.0.0.1:3069 \
  node lessons/69-cdc-snapshot-handoff/replica.mts
```

`HOST` chỉ nhận `127.0.0.1`. `PORT` nhận 0..65535; giá trị 0 chọn cổng tạm và in một dòng readiness JSON `{service,port}`. Cổng mặc định source/replica là 3069/3070. `DB_PATH` bắt buộc, phải là file lưu bền; entrypoint từ chối `:memory:`. Unit dùng SQLite trong bộ nhớ. `SOURCE_ORIGIN` bắt buộc cho replica, phải là origin HTTP loopback, không credentials, path, query hay fragment. Dấu `/` cuối và cổng mặc định được chuẩn hóa. Origin của replica và source phải khác nhau; cấu hình cổng cố định trùng nhau bị từ chối trước listen. Khi replica dùng `PORT=0`, hệ điều hành cấp một cổng chưa bị source chiếm.

Replica lưu identity gồm phiên bản, vai trò và origin source đã chuẩn hóa trong SQLite. Restart replica với origin khác hoặc dùng nhầm file của vai trò khác sẽ thất bại trước listen. Khi source dùng cổng tạm, restart nó trên **cổng cũ** nếu muốn tiếp tục identity đó. File và các file SQLite `-wal`/`-shm` cùng thuộc service tương ứng; replica không mở file source. Các module chỉ chạy khi là entrypoint, import không đọc cấu hình, mở DB hay listen.

Terminal 3 thực hiện từng lệnh, không có vòng lặp nền:

```sh
curl -sS -X PUT http://127.0.0.1:3069/items/k0 \
  -H 'content-type: application/json' -d '{"value":"old"}'
curl -sS -X PUT http://127.0.0.1:3069/items/k1 \
  -H 'content-type: application/json' -d '{"value":"erase"}'
curl -sS -X POST http://127.0.0.1:3070/bootstrap \
  -H 'content-type: application/json' -d '{}'
curl -sS -X PUT http://127.0.0.1:3069/items/k0 \
  -H 'content-type: application/json' -d '{"value":"new"}'
curl -sS -X DELETE http://127.0.0.1:3069/items/k1
curl -sS -X PUT http://127.0.0.1:3069/items/k2 \
  -H 'content-type: application/json' -d '{"value":"born"}'
curl -sS 'http://127.0.0.1:3069/changes?after=2'
curl -sS -X POST http://127.0.0.1:3070/pump \
  -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:3070/state
```

Kết quả cuối: `checkpoint:5`, `phase:"ready"`, `items:[{"key":"k0","value":"new"},{"key":"k2","value":"born"}]`. Gửi lại bootstrap sẽ trả trạng thái hiện tại mà không gọi source. Dừng bằng Ctrl-C; chạy lại hai lệnh service với đúng file và origin để tiếp tục. Không xóa DB để “sửa” một lỗi cursor.

## Hợp đồng HTTP

Mọi object JSON đều kiểm tra chính xác tập field và kiểu primitive. Array, null, primitive thay object, field thừa, giá trị bị ép kiểu đều bị từ chối. Request có JSON dùng `content-type: application/json`; body tối đa 8192 byte trên dây. PUT/bootstrap/pump đọc body với hạn 500ms; request quá chậm nhận 408 `request_timeout`. JSON hỏng: 400 `invalid_json`; sai schema: 400 `invalid_body`; sai media type: 415; quá lớn: 413. DELETE không nhận body. Route không có trong hợp đồng: 404 `not_found`.

| Service, lệnh | Thành công | Biên và lỗi nghiệp vụ |
| --- | --- | --- |
| Source `PUT /items/{key}` `{"value":"..."}` | 200 `{key,value}` | Key `k0`..`k7`; value 1..24 chữ ASCII `A-Z/a-z`. Update bằng giá trị cũ không tạo sự kiện. |
| Source `DELETE /items/{key}` | 200 `{key,value:null}` | Thiếu key: 404 `absent`, message `Item is absent`; không tạo sự kiện. |
| Source `GET /snapshot` | 200 `{through,items:[{key,value}]}` | Key tăng dần, mỗi key một lần. `through` và items cùng giao dịch đọc. |
| Source `GET /changes?after=N` | 200 `{after,through,changes:[{seq,key,value}]}` | N là số nguyên dạng thập phân chuẩn 0..32. Thiếu/thừa/trùng query hoặc ngoài miền: 400. N lớn hơn highwater: 409 `cursor_ahead`, message `Cursor exceeds source highwater`. |
| Replica `POST /bootstrap` `{}` | 200 `{checkpoint,phase,items}` | Chỉ trạng thái `empty` mới gọi source; replay ở `ready` trả state hiện tại. |
| Replica `POST /pump` `{}` | 200 state | Chưa bootstrap: 409 `not_bootstrapped`. Chỉ một batch tối đa 4 sự kiện mỗi lệnh. |
| Replica `GET /state` | 200 `{checkpoint,phase:"empty"\|"ready",items}` | Luôn đọc local; không gọi source. |

Change log chứa tối đa 32 bản ghi, seq liên tục 1..32. Cả insert mới, update thực sự và delete đều nhận 429 `capacity` với message `Change log is full` nếu cần sự kiện thứ 33. Kiểm tra giới hạn ở trigger BEFORE nằm cùng giao dịch với dữ liệu và trigger AFTER. Lỗi không thay đổi item hoặc log. No-op vẫn thành công khi log đầy. Không tái sử dụng cursor, không reset và không thu gom log.

Mọi lỗi dùng `{error:{code,message}}`. Replica trả 503 `busy` cho bootstrap/pump chồng nhau, bao gồm lúc đang nhận request body. Source không truy cập được, JSON/schema sai, mã lỗi lạ, content type sai, redirect và body vượt giới hạn đều thành 502 `upstream_failure`. Hạn **500ms tổng cộng** tính từ lúc handler replica nhận lệnh, bao gồm request body, fetch, header và toàn bộ response body; hết hạn downstream trả 504 `upstream_timeout`. GET state vẫn hoạt động khi một lệnh đang chờ HTTP. Đây là deadline ứng dụng, không phải cam kết realtime của bộ lập lịch hoặc ổ đĩa.

Replica chỉ giữ nguyên một lỗi source đã biết: 409 từ `/changes` với đúng envelope `cursor_ahead` và message cố định ở bảng trên. 409 `internal_error`, error object có field thừa, primitive hoặc message sai đều thành 502. Snapshot không có lỗi nghiệp vụ status-preserving; 404/409/422/429 từ endpoint ấy cũng là 502. Mọi response lỗi vẫn phải đọc đầy đủ trong cùng deadline và giới hạn byte trước khi xét ý nghĩa status. Không suy luận nghiệp vụ chỉ từ HTTP status.

## Ranh giới snapshot → log

```text
client --PUT/DELETE--> source process --transaction--> source.sqlite
                           ^                           items + triggers + changes
                           |
                  GET /snapshot hoặc /changes
                           |
operator --bootstrap/pump--> replica process --transaction--> replica.sqlite
                                                            items + progress + identity
```

1. Trigger INSERT/UPDATE/DELETE tạo log trong giao dịch business. `AFTER UPDATE ... WHEN OLD.value<>NEW.value` bỏ no-op; UPDATE/DELETE trên log bị trigger chặn. Nếu trigger hoặc business statement thất bại, toàn bộ giao dịch rollback.
2. Snapshot dùng `BEGIN`, đọc highwater rồi items, `COMMIT`. SQLite giữ cùng một góc nhìn cho hai SELECT. Ví dụ `through=2` có `k0=old`; các sự kiện 3 update, 4 delete, 5 insert xảy ra sau đó vẫn còn trong log.
3. Bootstrap kiểm tra toàn bộ snapshot: field chính xác, cursor 0..32, tối đa 8 item, key tăng dần không trùng, value hợp lệ và số item không vượt số sự kiện đã xảy ra. Một giao dịch local thay dictionary, đặt checkpoint=through, chuyển sang ready. Reply mất sau commit được xử lý bằng bootstrap replay, không tải lại ảnh cũ.
4. Pump yêu cầu `after` khớp checkpoint, tối đa 4 event liên tục bắt đầu ở checkpoint+1, `through>=lastSeq`, các seq nằm trong 1..32. Batch rỗng **khi và chỉ khi** checkpoint bằng through. Lỗi ở record cuối khiến cả batch bị từ chối trước khi ghi.
5. Một giao dịch local áp dụng tất cả thay đổi và checkpoint. Checkpoint chỉ đến **seq cuối đã áp dụng**, không nhảy đến through. Với checkpoint=2, highwater=9, batch đầu có seq 3..6: checkpoint mới là 6; pump tiếp mới lấy 7..9. Delete là tombstone `value:null`, không phải chuỗi `"null"`.

Engine chỉ gọi origin cố định, GET các path cố định, `redirect:'error'`; caller không truyền URL. Reader đếm byte UTF-8 thực tế của response stream, bao gồm whitespace/escape, thay vì độ dài object sau parse. Timer bao trùm cả body; nhận header sớm không giải phóng deadline. Single-flight được giải phóng trong `finally` để lỗi mạng không giữ service ở busy mãi.

Nếu reply source bị mất, replica chưa commit sẽ gọi lại từ checkpoint cũ và nhận lại log còn giữ. Nếu reply replica bị mất sau commit, lần pump tiếp đọc checkpoint đã lưu. Áp dụng batch cũ trực tiếp có `after` không khớp bị từ chối; HTTP retry tạo yêu cầu mới từ cursor hiện tại. SQLite rollback giữ cursor và dictionary đi cùng nhau, kể cả khi SQL lỗi sau khi đã ghi một phần dictionary. Không có giao dịch phân tán giữa hai DB.

## Kiểm chứng

```sh
# Unit tập trung, không mở listener:
node --test --test-isolation=none --test-name-pattern=unit: \
  lessons/69-cdc-snapshot-handoff/test/lesson.test.mts
npm run typecheck
npm run test:unit

# HTTP: chạy ở môi trường cho phép loopback; outer controller chạy trong Docker cô lập:
node --test --test-timeout=15000 --test-name-pattern=integration: \
  lessons/69-cdc-snapshot-handoff/test/lesson.test.mts

# Kiểm tra toàn repository của controller:
npm run check
make test
git diff --check
```

Unit đầu tiên được viết trước implementation và đã quan sát assertion RED ở snapshot seq 2. Các unit dùng `:memory:` kiểm tra handoff, replay, lỗi record cuối, giới hạn/no-op, schema primitive và identity. Trigger lỗi được cài bằng SQL trong test: lỗi sau INSERT log phải rollback business; lỗi UPDATE progress phải rollback dictionary cùng checkpoint/phase. Không có hook fault-injection trong service production. Unit import subprocess với cấu hình sai xác nhận entrypoint hoàn toàn inert.

Ba integration test có tên `integration:` khởi động child process độc lập, dùng cổng tạm, SQLite trong `node:os.tmpdir()` và cleanup stack đăng ký ngay sau mỗi acquisition; startup lỗi cũng được helper cleanup. Test đầu ghi sau snapshot trước pump, kiểm tra nhiều hơn 4 event, bỏ body reply sau header, restart cả hai process và tiếp tục delete. Test thứ hai dừng owner trước khi cài trigger lỗi vào file DB, rồi xác nhận qua HTTP không có CDC event khi rollback và không mất dữ liệu lúc đầy log.

Test thứ ba chỉ dùng một fixture source cấu hình được và một replica. Fixture còn mở một origin loopback độc lập `/capture`, với `/health` để xác nhận đích reachable. Bộ đếm `/capture` phải bằng 0 ngay sau từng redirect, trước khi đổi mode; không có reset để xóa bằng chứng. Fixture có lỗi final record/gap, semantic error sai code/message, JSON hợp lệ được escape string token rồi thêm whitespace đến hơn 8192 byte, reply bị ngắt, header/body chậm và hai pha 200ms+400ms để chứng minh chung deadline. Đồng bộ busy bằng bộ đếm request source, không sleep trong test.

Worker không có network chỉ chạy typecheck và unit; các lệnh HTTP, `npm run check` và `make test` thuộc controller. Việc liệt kê các lệnh trên không có nghĩa worker đã chạy hay xác nhận chúng.

## Đánh đổi và giới hạn

Trigger CDC ghi nhận thay đổi hàng lưu trữ. Nó phù hợp khi cần mirror bảng nhỏ, nhưng phụ thuộc schema, tăng chi phí ghi và không tự diễn đạt ý định nghiệp vụ. Transactional outbox thường được application ghi có chủ đích cùng business transaction, với envelope và ngữ nghĩa sự kiện riêng; domain event như “đơn được xác nhận” không suy ra chắc chắn chỉ từ một UPDATE cột.

Các sản phẩm đọc WAL/transaction log như connector PostgreSQL của Debezium có cơ chế snapshot, vị trí log, replication slot và vận hành retention riêng. `PRAGMA journal_mode=WAL` ở đây hỗ trợ SQLite; bài **không đọc/giải mã WAL** và không triển khai Debezium. Log CDC là bảng riêng được trigger append.

Origin cố định đại diện cho **một source và một epoch được tin cậy**, file source không bị thay mới phía sau cùng origin. Identity origin phát hiện nhầm cấu hình, không phát hiện việc người vận hành tráo file source. Khi restore source cũ hơn checkpoint, `cursor_ahead` dừng đồng bộ; không tự bỏ cursor. Không có retention/GC, multiwriter, failover epoch, auth, chống sửa file, lịch pump nền hoặc guarantee exactly-once networking. Trần 32 làm giao thức hữu hạn và quan sát được, không phải thiết kế log production. Domain logic khác nhau có thể cần event schema/version và quy tắc migration riêng.

## Bài tập

1. Ghi thêm ít nhất 5 thay đổi sau snapshot. Ghi lại `after`, `through`, seq cuối và checkpoint từng pump; giải thích bản ghi nào mất nếu gán checkpoint=through ngay ở batch đầu.
2. Giữ nguyên source DB, restart replica rồi gửi bootstrap nhiều lần. Dừng source và chứng minh bootstrap ready vẫn trả state local, pump thất bại nhưng state không lùi.
3. Thiết kế source epoch riêng lưu bền và một hợp đồng từ chối epoch mismatch. Vì sao origin cố định chưa đủ khi source DB bị thay thế?
4. Phác thảo retention có watermark từ nhiều replica và hạn sử dụng snapshot; chỉ ra lúc nào cần bootstrap lại và vì sao không thể xóa tùy tiện những seq cũ.
5. So sánh ba payload: hàng `items` thay đổi, outbox event `ItemRenamed`, domain event có actor. Hệ downstream nào cần từng loại, và trigger có biết được actor đáng tin cậy không?

## Tài liệu gốc

- [SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html): BEFORE/AFTER, WHEN và RAISE trong transaction.
- [SQLite isolation](https://www.sqlite.org/isolation.html): snapshot isolation và giao dịch đọc khi dùng WAL.
- [Debezium PostgreSQL snapshots](https://debezium.io/documentation/reference/stable/connectors/postgresql.html#postgresql-snapshots): snapshot gắn với vị trí log trong một connector vận hành thực tế.
