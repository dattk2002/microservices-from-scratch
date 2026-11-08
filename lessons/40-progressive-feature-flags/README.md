# 40 — Feature flags, cohort ổn định và cấu hình rollout có hạn dùng

Deploy đưa mã canary lên máy; release quyết định bao nhiêu routing key được dùng mã đó. Bài này tách hai thao tác bằng đúng **một flag**. Hai gateway là hai tiến trình riêng, không chia sẻ bộ nhớ. Control lưu SQLite; mỗi gateway chỉ giữ một snapshot và thời điểm refresh thành công. Không cần package runtime, tài khoản hay dịch vụ bên ngoài.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (nhánh 24) và các dev package đã pin ở root. Chạy từ root repository. Kiến thức trước: HTTP deadline, SQLite, optimistic concurrency và cache-aside. Mỗi lệnh server bên dưới chạy ở một terminal riêng:

```sh
HOST=127.0.0.1 PORT=4040 DB_PATH=/tmp/lesson40-flags.sqlite TEACHING_CONTROLS=1 node lessons/40-progressive-feature-flags/control.mts
HOST=127.0.0.1 PORT=4041 VARIANT=stable node lessons/40-progressive-feature-flags/backend.mts
HOST=127.0.0.1 PORT=4042 VARIANT=canary node lessons/40-progressive-feature-flags/backend.mts
HOST=127.0.0.1 PORT=4043 CONTROL_ORIGIN=http://127.0.0.1:4040 STABLE_ORIGIN=http://127.0.0.1:4041 CANARY_ORIGIN=http://127.0.0.1:4042 TEACHING_CONTROLS=1 node lessons/40-progressive-feature-flags/gateway.mts
HOST=127.0.0.1 PORT=4044 CONTROL_ORIGIN=http://127.0.0.1:4040 STABLE_ORIGIN=http://127.0.0.1:4041 CANARY_ORIGIN=http://127.0.0.1:4042 TEACHING_CONTROLS=1 node lessons/40-progressive-feature-flags/gateway.mts
```

`PORT=0` được hỗ trợ: đọc một dòng JSON `{service,port}` trên stdout để biết cổng được cấp. `HOST` mặc định `127.0.0.1`. Dừng bằng Ctrl-C; server đóng connection và control đóng database. Không cấu hình runtime, mở SQLite, listen, gắn signal hoặc chạy nền khi import module. `DB_PATH` mặc định `flags.sqlite` tại working directory, nên ví dụ chọn đường dẫn `/tmp` rõ ràng.

```sh
curl -s http://127.0.0.1:4043/hello?subject=alice
curl -s -H 'content-type: application/json' -d '{"expectedVersion":0,"enabled":true,"rollout":3000,"salt":"demo"}' http://127.0.0.1:4040/config
curl -s -X POST http://127.0.0.1:4043/refresh
curl -s -X POST http://127.0.0.1:4044/refresh
curl -s http://127.0.0.1:4043/hello?subject=alice
curl -s http://127.0.0.1:4044/hello?subject=alice
```

Database mới bắt đầu ở version 0, disabled. Nếu dùng lại database, đọc `GET /config` và dùng version hiện tại cho `expectedVersion`; không giả định ví dụ luôn bắt đầu ở 0.

## Kiến trúc và hợp đồng

```text
                       SQLite (một hàng)
                              |
                       control /config
                         ^          ^
                  POST /refresh  POST /refresh
                         |          |
                    gateway A    gateway B
                         \          /
                       stable / canary
                       GET /hello
```

Control `GET /config` trả `{version,enabled,rollout,salt}`. `version` là safe integer không âm; `enabled` phải là boolean thật; `rollout` là số nguyên 0..10000 (basis points), `salt` là chuỗi 1..64 UTF-16 code units. Không nhận trường dư và **không có URL đích** trong config. `POST /config` nhận đúng `{expectedVersion,enabled,rollout,salt}`. SQLite `BEGIN IMMEDIATE` kiểm tra expectedVersion và ghi một lần; thành công 200 với version tăng một, conflict 409, sai primitive/schema hoặc version hết miền tăng an toàn 400. Database hỏng không được dùng để định tuyến.

Gateway chỉ dùng ba origin cố định từ môi trường `CONTROL_ORIGIN`, `STABLE_ORIGIN`, `CANARY_ORIGIN`: HTTP origin không credentials, path, query hay fragment. Refresh thủ công `POST /refresh` trả 200 `{version}` hoặc 502 `refresh_failed`. Không có polling hay refresh ngầm khi gọi hello. Mỗi snapshot được parse trước khi thay thế; version cũ hoặc nội dung khác ở cùng version bị từ chối. Cùng version và cùng nội dung chuẩn hóa được phép gia hạn tuổi. Refresh lỗi, JSON hỏng, quá byte budget, quá deadline hay redirect giữ nguyên snapshot **và mốc tuổi cũ**.

`GET /hello?subject=ID` chỉ nhận một tham số, ID ASCII `[A-Za-z0-9_-]`, dài 1..64. Sai input trả 400. Đây là demo routing key do caller tự chọn, không phải danh tính xác thực hoặc quyền truy cập. Gateway không gửi ID, authorization, signed context hoặc body đến backend/control. Request target tối đa 512 ký tự, authorization tối đa 256; Node còn giới hạn tổng request header theo mặc định 16 KiB. Không lưu map theo subject.

Bucket lấy 4 byte đầu SHA-256 dạng big-endian, modulo 10000:

```text
SHA-256(UTF8(salt) || byte 0 || UTF8(subject)) → uint32BE → % 10000
```

Ví dụ `salt=demo, subject=alice` có bucket 6066: rollout 6000 chọn stable, 7000 chọn canary. Với cùng salt, tăng rollout chỉ thêm cohort, không đẩy người đang ở canary về stable. Salt thay đổi sẽ xáo lại cohort. Modulo có bias rất nhỏ vì 2^32 không chia hết cho 10000; mẫu subject thực tế cũng có thể thiên lệch, và caller có thể dò ID để chọn variant. Không dùng cách này làm hàng rào bảo mật.

Response hello 200 gồm `{variant,reason,version,backend}`. `reason` là `cold` khi chưa có config, `expired` khi tuổi **>= TTL**, `disabled` khi flag tắt, hoặc `configured`. Cold/expired/disabled luôn chọn stable; disabled thắng rollout 10000. `version` là version cache hoặc null khi cold, không ngụ ý một config expired vẫn được áp dụng. Backend phải trả đúng `{variant}` khớp lựa chọn; lỗi status, schema, deadline hoặc redirect trả 502 `backend_failed` kèm quyết định, không tạo dữ liệu nghiệp vụ thành công giả và không tự thử stable sau lỗi canary.

TTL mặc định 10000 ms; `TTL_MS` nhận số nguyên 1..60000. Tuổi dùng `performance.now()` monotonic, không phụ thuộc đổi giờ hệ thống. Snapshot chỉ sống trong RAM; gateway restart trở về cold, control restart giữ version và nội dung SQLite. Hai gateway cùng config/subject chọn cùng variant; khác thời điểm refresh có thể khác config và khác lựa chọn.

Tất cả outbound fetch dùng `redirect:error`, không chuyển origin theo Location. Deadline tổng 500 ms bao gồm đọc body. Budget reply 1024 byte: salt tối đa 64 units × 6 byte escape JSON + dưới 128 byte metadata vừa đủ; backend chỉ trả variant. Giới hạn này tính theo byte nhận thực tế, kể cả whitespace. Request JSON control dùng helper giới hạn 8192 byte, dư cho expectedVersion và salt escape tối đa. Input lỗi Content-Type trả 415, JSON sai 400, body quá lớn 413. Các route không khớp trả 404.

## Playground: outage và kill switch

Các route dưới đây chỉ mở nếu `TEACHING_CONTROLS=1`, dành cho mô phỏng local. Không đặt biến này trên một server public. Không có auth trong bài học.

1. Publish enabled 10000, refresh cả hai gateway, kiểm tra cả hai dùng canary.
2. Publish disabled với expectedVersion mới. Chỉ refresh A: A chọn stable/disabled nhưng B vẫn dùng canary trong TTL. Kill switch **không tức thì toàn fleet**.
3. `POST /teaching/failure` ở control với JSON `{"failed":true}` làm GET config trả 503. Publish vẫn hoạt động; route chỉ mô phỏng đường đọc bị lỗi. Body phải là object JSON có `failed` boolean; body null, mảng hay primitive trả 400 và không đổi trạng thái outage.
4. Refresh B thất bại nhưng B còn dùng last-known-good khi chưa hết hạn.
5. `POST /teaching/advance` ở B với JSON `{"ms":10000}` cộng clock offset monotonic. Mỗi lần nhận số nguyên 0..60000, giúp quan sát stable/expired ngay mà không ngủ chờ. Offset có thể cộng nhiều lần; không đổi version hay gia hạn config.
6. Khôi phục control bằng `{"failed":false}`, refresh B; B nhận disabled. Cùng config refresh thành công cũng đặt lại tuổi.

Ví dụ điều khiển:

```sh
curl -s -H 'content-type: application/json' -d '{"failed":true}' http://127.0.0.1:4040/teaching/failure
curl -s -X POST http://127.0.0.1:4044/refresh
curl -s -H 'content-type: application/json' -d '{"ms":10000}' http://127.0.0.1:4044/teaching/advance
curl -s http://127.0.0.1:4044/hello?subject=alice
```

## Kiểm chứng

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/40-progressive-feature-flags/test/lesson.test.mts
node --test --test-timeout=15000 lessons/40-progressive-feature-flags/test/lesson.test.mts
npm run check
make test
```

Unit kiểm tra vector hash độc lập, 0/100%, tính đơn điệu rollout, primitive, version/conflict, TTL chính xác và tuổi không gia hạn khi reject; SQLite in-memory; import child với môi trường cố tình sai và không có app output. HTTP tests tạo tiến trình độc lập và port loopback tạm, database dưới `node:os.tmpdir()`, dọn child/database trong finally. Kiểm tra hai gateway trên mẫu hữu hạn, rollout/salt, restart, kill switch, outage/TTL, input sai, reply escape tối đa, config oversize hợp lệ chỉ dư whitespace, deadline và redirect đến sink quan sát được. Sink phải không nhận request, gồm cả khi caller gửi context/body nhạy cảm giả lập.

Worker không có quyền mạng nên chỉ chạy typecheck và unit; controller chạy HTTP và toàn bộ check trong Docker cô lập. Không coi chưa chạy HTTP là đã pass.

## Đánh đổi và bài tập

TTL đổi độ mới lấy khả năng phục vụ khi control hỏng; stable fallback cũng có thể gây thay đổi trải nghiệm giữa phiên. Không có bằng chứng stable ít lỗi hơn canary trong mọi tình huống. Fixed origin tránh config biến thành SSRF nhưng vẫn cần chính sách mạng thật khi triển khai. Không có HA control, authentication, audit log, flag targeting theo thuộc tính, analytics, thống kê A/B hay đồng bộ tức thì. Đây không phải nền tảng thử nghiệm A/B: thiếu exposure events, đo outcome, randomization theo đơn vị thống kê và phân tích sai lệch.

Flag là nợ cấu hình: ghi chủ sở hữu, hạn xóa và điều kiện hoàn tất release trong quy trình thật; sau rollout ổn định xóa nhánh cũ, flag, cấu hình và test không còn cần thiết. TTL của snapshot chỉ là hạn tin cậy cache, không tự xóa flag nghiệp vụ.

Bài tập: chọn TTL theo thời gian tối đa chấp nhận kill switch chậm; giải thích vì sao salt phải giữ ổn định khi đo cohort; thiết kế xác thực riêng cho control; đề xuất giao thức chống rollback qua gateway restart (hiện tại cold restart mất lịch sử version); cân nhắc hash không modulo bias và đối chiếu chi phí. Chưa triển khai các mở rộng này trong bài.

Tham khảo: [Martin Fowler — Feature Toggles](https://martinfowler.com/articles/feature-toggles.html), [Node.js SQLite](https://nodejs.org/api/sqlite.html), [Node.js performance.now](https://nodejs.org/api/perf_hooks.html#performancenow).
