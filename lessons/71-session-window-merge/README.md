# 71 — Session window: gộp phiên đến lệch thứ tự, đóng theo watermark

Một phiên không có ranh giới đồng hồ cố định. Với cùng `key`, các sự kiện có khoảng
cách liên tiếp **không quá 3** thuộc cùng một thành phần liên thông. Sự kiện đến
sau có thể nối hai phiên tạm thời. Bài này dùng hai tiến trình HTTP độc lập và
SQLite để quan sát việc gộp, chặn dữ liệu trễ và khôi phục sau restart.

## Điều kiện và cách chạy

Cần Node.js **24.12.0 trở lên trong nhánh 24**, npm và các gói phát triển đã ghim
ở root (`npm ci` nếu chưa cài). Runtime chỉ dùng built-in Node; không cần dịch vụ
đám mây, tài khoản hay Docker cho các lệnh native dưới đây. Chạy từ root repo.
Nên đọc bài về HTTP, idempotency, SQLite và watermark trước bài này.

Tạo thư mục riêng một lần, rồi giữ đường dẫn được in ra:

```sh
mktemp -d /tmp/session71.XXXXXX
```

Giả sử kết quả là `/tmp/session71.ABCDEF`. Terminal thứ nhất:

```sh
HOST=127.0.0.1 PORT=7072 DB_PATH=/tmp/session71.ABCDEF/sessions.sqlite SOURCE_ID=demo71 node lessons/71-session-window-merge/sessions.mts
```

Terminal thứ hai:

```sh
HOST=127.0.0.1 PORT=7073 SESSION_ORIGIN=http://127.0.0.1:7072 node lessons/71-session-window-merge/ingress.mts
```

Mỗi tiến trình in một dòng readiness JSON, ví dụ
`{"service":"session-windows","port":7072}`. `PORT=0` chọn cổng ephemeral;
đọc cổng thật từ readiness rồi đặt `SESSION_ORIGIN` tương ứng. `HOST` chỉ nhận
`127.0.0.1`; mặc định cổng service/ingress là 7072/7073. `SESSION_ORIGIN` là cấu
hình bắt buộc, chỉ nhận HTTP origin loopback, không userinfo, path, query hay
fragment; dấu `/` cuối được chuẩn hóa. Hai origin phải khác nhau. Không có URL
đích trong payload của caller.

`DB_PATH` phải là đường dẫn tuyệt đối tới file riêng, trong thư mục đã tồn tại.
Service tạo file mới với mode `0600`, từ chối symlink hoặc file cho phép group/other
truy cập. Mỗi instance sở hữu DB riêng; không dùng chung file giữa các service.
`SOURCE_ID` mặc định `lesson71`, dài 1–64 ký tự ASCII chữ/số/`_`/`-`. Nó và phiên
bản hợp đồng được lưu trong DB; thay identity khi mở lại làm startup thất bại
**trước khi listen**. Giữ cùng DB và identity khi restart; SQLite WAL/SHM cũng thuộc
dữ liệu của instance. Gửi Ctrl-C để đóng HTTP rồi đóng DB. Import entrypoint không
đọc cấu hình, không mở DB và không listen; SQLite chỉ được dynamic import trong
`main`, nên import cũng im lặng trên Node24.12.

## Thử việc nối hai phiên

Terminal thứ ba:

```sh
curl -sS -i http://127.0.0.1:7073/events -H 'content-type: application/json' -d '{"id":"first","key":"a","time":0,"value":1}'
curl -sS -i http://127.0.0.1:7073/events -H 'content-type: application/json' -d '{"id":"last","key":"a","time":6,"value":2}'
curl -sS http://127.0.0.1:7072/state
curl -sS -i http://127.0.0.1:7073/events -H 'content-type: application/json' -d '{"id":"bridge","key":"a","time":3,"value":4}'
curl -sS http://127.0.0.1:7072/state
curl -sS -i http://127.0.0.1:7073/watermark -H 'content-type: application/json' -d '{"time":8}'
curl -sS http://127.0.0.1:7072/state
curl -sS -i http://127.0.0.1:7073/watermark -H 'content-type: application/json' -d '{"time":9}'
curl -sS http://127.0.0.1:7072/state
```

Sau hai event đầu có `[0,0]` và `[6,6]`, đều provisional. Event `a@3` tạo chuỗi
`0 → 3 → 6`, gộp thành `{key:"a",start:0,end:6,count:3,sum:7,final:false}` bất kể
thứ tự ba lần đến. Watermark 8 vẫn provisional; 9 làm `final:true`. `start`/`end`
là thời gian **event đầu/cuối**, không phải thời điểm hết khoảng im lặng.
Thêm event mới ở time 9 bị `late_event`; gửi lại nguyên event `bridge` vẫn được
ACK duplicate. Đổi `value` của `bridge` bị `id_conflict`.

## Hợp đồng HTTP

Mọi JSON object phải có **đúng** các trường đã liệt kê, đúng primitive type;
không nhận null, array, extra field hay ép kiểu từ string/object. Body request
và body JSON upstream tối đa 8192 byte. Response luôn có `cache-control: no-store`.
Mọi lỗi có dạng `{"error":{"code":"…","message":"…"}}`, với `message = code`.

| Endpoint | Input / output | Status |
| --- | --- | --- |
| `POST /events` | `{id,key,time,value}`; id `[a-z0-9]{1,16}`, key `a` hoặc `b`, integer time 0..100, integer value 0..9 | Mới: 201 `{id,duplicate:false}`; replay y hệt: 200 `{id,duplicate:true}` |
| `POST /events` | Receipt id đã có nội dung khác | 409 `id_conflict` |
| `POST /events` | Id mới, time ≤ watermark | 409 `late_event` |
| `POST /events` | Id mới hợp lệ, receipt toàn cục đã đủ 32 | 429 `capacity` |
| `POST /watermark` | Chính xác `{time}`, integer 0..103 | 200 `{watermark:time}`; cho phép bằng giá trị hiện tại |
| `POST /watermark` | time nhỏ hơn watermark đã lưu | 409 `watermark_regression` |
| `GET /state` trên sessions | `{watermark,sessions:[{key,start,end,count,sum,final}]}` | 200; watermark ban đầu -1; sort theo key rồi start |

Ingress chỉ có hai route POST; đọc `/state` trực tiếp trên sessions. Schema sai:
400 `invalid_request`; JSON hỏng: 400 `invalid_json`; content type sai: 415
`unsupported_media_type`; body quá lớn: 413 `body_too_large`; route lạ: 404
`not_found`; method sai: 405 `method_not_allowed` kèm `Allow`. Lỗi DB bất ngờ:
500 `internal_error`. Lỗi upstream của ingress luôn là 502 `upstream_failure`.

Receipt được kiểm tra trước lateness/capacity: một replay vẫn thành công sau khi
watermark vượt event hoặc sau khi DB đầy. Id là toàn cục, kể cả giữa hai key.
Receipt không bao giờ được tái sử dụng hay xóa bởi watermark.

## Kiến trúc và các bất biến

```text
caller → ingress.mts ── POST /events, /watermark ──→ sessions.mts → SQLite riêng
                                                      ↑
                                               GET /state trực tiếp
```

`core.mts` sort event theo key, time rồi id, sau đó duyệt để gộp khoảng cách liên
tiếp ≤3; cùng time nhưng khác id vẫn tăng count và sum. Gap 4 tách phiên; hai key
không gộp. `store.mts` giữ receipts, watermark và identity. Mỗi thay đổi dùng
`BEGIN IMMEDIATE`/COMMIT; lỗi SQL dẫn tới ROLLBACK. `GET /state` đọc một transaction
snapshot rồi tính lại tối đa 32 receipt, không lưu session ID tạm thời đã lỗi thời.
Sự kiện được nhận và ACK chỉ sau commit; mất ACK có thể retry cùng id.

Watermark là lời hứa do caller cung cấp: không nhận thêm event mới có time ≤ nó.
Một phiên final khi `watermark >= end + 3`. Event tương lai được nhận có time >
watermark, nên cách `end` ít nhất 4 đơn vị; nó không thể nối hay thay đổi phiên
final. Đẩy watermark quá sớm sẽ từ chối dữ liệu tới muộn; restart giữ nguyên lời
hứa này. Miền watermark tới 103 đủ đóng event cuối ở time100.

Ingress giữ một origin cố định và không follow redirect (`redirect: error`). Một
operation chỉ có **một deadline 500ms**, tính cả kết nối, headers và toàn bộ body;
không reset clock theo chunk và không retry. Body đọc theo stream với giới hạn
8192 byte. Ingress chỉ giữ status sau khi xác minh đầy đủ ACK hoặc semantic error:
201/200 event ACK phải khớp id và duplicate; watermark ACK phải khớp time;
409/429 chỉ chấp nhận code được route đó định nghĩa và message đúng code. Body là
JSON hợp lệ nhưng có `internal_error`, array, primitive, sai field hoặc status lạ
vẫn thành 502. Transport lỗi, redirect, timeout (kể cả body treo), sai content type,
JSON hỏng/quá lớn cũng thành 502. Timeout là kết quả không chắc chắn: upstream có
thể đã commit, vì thế retry event phải giữ cùng id và nội dung.

ACK của bài này **không có trường source identity**: ingress kiểm tra chính xác
hợp đồng ACK và origin cấu hình, không tự thêm source vào ACK. Identity bền vững
chỉ bảo vệ việc mở nhầm DB ở startup; đây không phải cơ chế xác thực mạng.

## Kiểm tra

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/71-session-window-merge/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-timeout=15000 lessons/71-session-window-merge/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit test chứng minh sáu thứ tự arrival, gap 3/4, cùng time/khác key, finality,
replay/conflict, capacity và rollback bằng SQLite trigger. HTTP tests dùng child
process độc lập, PORT=0 và temp DB riêng: bridge, late/replay, restart trước/sau
final, persist capacity và identity mismatch. Fixture hostile upstream kiểm tra
schema/status/code, JSON hợp lệ quá 8192 byte, deadline headers+body và destination
redirect có thể truy cập nhưng request counter vẫn **0 trước khi đổi mode**.
Các tài nguyên được bảo vệ bằng cleanup ngay khi acquire, gồm cả startup thất bại.
Worker không chạy listeners; các lệnh HTTP/full suite do outer controller thực hiện.

## Đánh đổi, giới hạn và bài tập

Tumbling window chia thời gian thành ô cố định: event0 và event3 có thể khác ô,
và event cầu nối không đổi ranh giới ô. Session window dựa vào liên thông theo gap;
nó có thể dài hơn gap rất nhiều, vì mỗi cặp kề nhau vẫn cách ≤3. State provisional
có thể thay đổi cả số phiên lẫn ranh giới; consumer cần đọc snapshot mới. Bài này
không có streaming sink, retraction, exactly-once delivery hay session ID ổn định.

Giữ toàn bộ receipt khiến bộ nhớ/DB hữu hạn và tính lại đơn giản: O(n log n),
n≤32. Đổi lại, DB đầy sẽ từ chối id mới mãi, kể cả mọi phiên đã final. Muốn retention
thực tế phải thiết kế lại replay horizon, compact receipt và hợp đồng duplicate;
chỉ xóa receipt cũ sẽ làm mất bảo đảm hiện tại. Không có watermark tự động,
multi-partition minimum, allowed lateness, phân tán DB hay quản lý producer.
SQLite đồng bộ chặn event loop một đoạn ngắn; miền dữ liệu nhỏ và một owner là
ràng buộc của mô hình, không phải công thức scale vô hạn.

1. Thử `a@0,a@4`, rồi `a@2` trước watermark: giải thích vì sao hai phiên gộp được.
2. Tính finality của các phiên key b độc lập khi cùng watermark tiến lên.
3. Thiết kế retention có replay horizon rõ ràng; chỉ ra retry nào không còn được ACK.
4. Nếu có nhiều partition, vì sao watermark của một partition nhanh chưa đủ để đóng
   phiên toàn cục? Mô tả cách xử lý partition im lặng mà không phá lời hứa event-time.

## Nguồn chính

- [Apache Flink — Session windows](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/#session-windows): mô hình gap và việc gộp window. Bài này tự triển khai miền hữu hạn, không dùng Flink và không sao chép ngữ nghĩa trigger của nó.
- [Node.js — SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): DatabaseSync và vòng đời connection.
- [SQLite — Transactions](https://www.sqlite.org/lang_transaction.html): BEGIN IMMEDIATE, COMMIT và ROLLBACK.
- [Node.js — fetch](https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch): HTTP client và AbortController.

Relay kiểm tra thêm cổng listener thực tế từ socket của mỗi request trước khi chuyển tiếp. Với `PORT=0`, nếu origin nguồn vô tình trùng cổng vừa được hệ điều hành cấp cho ingress, request trả `502 upstream_failure` ngay; không gửi HTTP đệ quy vào chính relay. Guard cấu hình cổng cố định vẫn từ chối khởi động khi hai origin trùng nhau. Regression dùng listener cổng ngẫu nhiên và counter để chứng minh không có request tự chuyển tiếp.
