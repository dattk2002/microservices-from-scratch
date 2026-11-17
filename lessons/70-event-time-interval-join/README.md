# 70 — Join hai luồng theo event-time, watermark và đóng kết quả có giới hạn

Hai tiến trình HTTP độc lập: `ingress.mts` kiểm tra request và relay đến origin cố định; `join.mts` sở hữu SQLite riêng, ghép hai luồng, giữ receipt và kết quả qua restart. Node **24.12+ dòng 24**, built-in `node:sqlite`, không thư viện runtime, broker, credentials hay hệ thống thanh toán thật. Cần các dev dependencies đã cài ở root. Nên đọc bài 05 (idempotency), 37 (thứ tự sự kiện) và 47 (event-time/watermark).

## Ví dụ: impression và click đến đảo thứ tự

Quy ước `left` là impression, `right` là click; `key=a|b` biểu diễn hai chiến dịch quảng cáo mô phỏng. `time` là mốc logic do producer ghi vào dữ liệu, không phải thời điểm HTTP đến. `value` là số nguyên 0..9 minh họa dữ liệu đi kèm; join không cộng hoặc nhân trường này.

Ghép mọi cặp cùng key thỏa **left.time <= right.time <= left.time + 3**, gồm cả hai biên. Impression `l10` tại 10 ghép click `r13` tại 13 dù click đến trước. Click tại 14 không ghép impression 10. Đây là khoảng **bất đối xứng**, không phải `abs(left.time-right.time)<=3`: click trước impression không đủ điều kiện.

Đây là **symmetric inner interval join**: mỗi bên mới đến đều tìm đối tác đã lưu ở bên kia. Một event có thể tham gia nhiều cặp; chỉ xuất cặp có đủ hai bên. Khác aggregation, kết quả không phải một tổng/count. Khác tumbling window, không chia trục thời gian thành các bucket cố định: khoảng ghép gắn với từng impression. Không phát dòng unmatched như outer join.

## Watermark là lời hứa của từng bên

Ban đầu `{left:-1,right:-1}`. Producer chỉ nâng watermark sau khi phối hợp với mọi dữ liệu đang trên đường truyền, hàng đợi và retry. Watermark `right=12` hứa rằng sẽ không có **event mới được chấp nhận** bên right với time <=12. Bài học thực thi lời hứa bằng 409 `late_event`; không có allowed lateness, correction hay retraction. Một lời hứa quá sớm gây mất dữ liệu nghiệp vụ không thể phục hồi trong database này bằng id mới. Retry receipt đã có vẫn được nhận.

Với pair `(leftTime=L,rightTime=R)`, `final` chỉ được bật khi đồng thời:

- `right watermark >= L+3`: đã đóng hết khoảng click có thể ghép impression đó.
- `left watermark >= R`: không còn impression mới được chấp nhận với time <=R có thể ghép click đó.

Ví dụ L=10, R=13: right=12 chưa đóng; right=13 vẫn chưa đủ nếu left=12; right=13 và left=13 thì final. Với L=10, R=11, right=13 và left=11 đã đủ. Lấy duy nhất `min(left,right)` rồi so một biên sẽ làm sai điều kiện bất đối xứng. Pair hiện hữu có thể lộ ra sớm với `final:false`; cờ final thể hiện cả hai endpoint đã hết cơ hội nhận thêm đối tác, không phải cam kết về một transactional sink bên ngoài.

Không tự tăng watermark theo wallclock, không phát hiện idle, không timeout để xóa event. Bên im lặng có thể giữ pair provisional vô hạn. Chỉ request tường minh thay đổi trạng thái.

## Chạy từ repository root

Terminal 1, chọn file dữ liệu riêng và giữ nguyên khi restart:

```bash
DB_PATH=/tmp/lesson70-join.sqlite STORE_ID=adexample HOST=127.0.0.1 PORT=7070 node lessons/70-event-time-interval-join/join.mts
```

Terminal 2:

```bash
JOIN_ORIGIN=http://127.0.0.1:7070 HOST=127.0.0.1 PORT=7071 node lessons/70-event-time-interval-join/ingress.mts
```

`DB_PATH` bắt buộc với join. `STORE_ID` mặc định `lesson70`, 1..64 ký tự ASCII chữ/số/`_`/`-`. Identity cùng phiên bản hợp đồng (khoảng 0..3, giới hạn receipt/pair) được lưu trong SQLite; đổi identity trên cùng file làm startup thất bại **trước listen**. Ingress stateless, không mở hay chia sẻ file SQLite. HOST chỉ nhận `127.0.0.1`; PORT mặc định 7070/7071 và hỗ trợ 0. Với PORT=0, đọc dòng readiness JSON `{service,port}` rồi cấu hình ingress bằng port thực của join.

JOIN_ORIGIN bắt buộc, được chuẩn hóa bằng URL: HTTP loopback `127.0.0.1`, không credentials, path phụ, query hay fragment; port upstream không được là 0. Hai origin phải khác nhau; ingress từ chối origin chính nó trước listen khi PORT cố định (so sánh sau chuẩn hóa, kể cả port 80). Với PORT=0, hệ điều hành cấp listener khác port join đang hoạt động. Không nhận URL từ caller. Mọi entrypoint inert khi import, kể cả cấu hình sai. SIGTERM/SIGINT đóng server rồi đóng database.

Gửi click trước impression, đọc trực tiếp state ở join:

```bash
curl -s http://127.0.0.1:7071/events -H 'content-type: application/json' -d '{"id":"r13","side":"right","key":"a","time":13,"value":2}'
curl -s http://127.0.0.1:7071/events -H 'content-type: application/json' -d '{"id":"l10","side":"left","key":"a","time":10,"value":7}'
curl -s http://127.0.0.1:7070/state
curl -s http://127.0.0.1:7071/watermark -H 'content-type: application/json' -d '{"side":"right","time":12}'
curl -s http://127.0.0.1:7071/watermark -H 'content-type: application/json' -d '{"side":"left","time":13}'
curl -s http://127.0.0.1:7070/state
curl -s http://127.0.0.1:7071/watermark -H 'content-type: application/json' -d '{"side":"right","time":13}'
curl -s http://127.0.0.1:7070/state
```

Pair cuối là `{"leftId":"l10","rightId":"r13","key":"a","leftTime":10,"rightTime":13,"final":true}`. Trước right=13 nó còn provisional. Dừng join rồi chạy lại đúng lệnh/file/identity: events, watermarks và pairs giữ nguyên. Tiếp tục:

```bash
curl -s http://127.0.0.1:7071/events -H 'content-type: application/json' -d '{"id":"r13","side":"right","key":"a","time":13,"value":2}'
curl -s http://127.0.0.1:7071/events -H 'content-type: application/json' -d '{"id":"new13","side":"right","key":"a","time":13,"value":2}'
curl -s http://127.0.0.1:7071/events -H 'content-type: application/json' -d '{"id":"r13","side":"right","key":"a","time":13,"value":3}'
```

Lần lượt nhận 200 duplicate, 409 late_event, 409 id_conflict. Không có background HTTP loop hoặc tự retry.

## Hợp đồng HTTP chính xác

Cả hai service nhận POST `/events` và `/watermark`; chỉ join có GET `/state`. JSON phải có **đúng** các field, đúng primitive, không nhận array/null/string/number/boolean thay object, không coercion. Request body tối đa 8192 byte, content-type `application/json` (có thể kèm charset).

| Route | Request | Kết quả |
| --- | --- | --- |
| POST `/events` | `{id,side,key,time,value}`; id `[a-z0-9]{1,16}`, side `left|right`, key `a|b`, time nguyên 0..100, value nguyên 0..9 | 201 `{id,duplicate:false}` khi mới; 200 `{id,duplicate:true}` khi retry chính xác |
| POST `/watermark` | `{side,time}`; side `left|right`, time nguyên 0..104 | 200 `{watermarks:{left,right}}`, ACK nhỏ; cùng mốc cũng thành công |
| GET `/state` tại join | Không query | 200 `{watermarks:{left,right},events:[...],pairs:[...]}`; receipt đủ 5 field; pair đủ 6 field như ví dụ |

Events sắp theo id ASCII; pairs theo leftId rồi rightId ASCII. Watermark ban đầu -1 chỉ xuất ở state/ACK, POST không nhận -1. Id là **toàn cục**, không tách namespace theo side. Thứ tự kiểm tra event trong một transaction: tìm receipt → xung đột/duplicate → late so **watermark của chính side** → capacity của side → insert event và mọi pair. Conflict/replay được xét trước late/capacity, do đó retry sau closure không thêm pair và không đổi state.

Mọi lỗi có dạng `{error:{code,message}}`:

| Status/code | Message cố định / nguyên nhân |
| --- | --- |
| 409 `late_event` | `Event is behind its side watermark` — event mới time <= own watermark |
| 409 `id_conflict` | `Event id already has different content` — id cũ nhưng bất kỳ field khác |
| 409 `watermark_regression` | `Watermark cannot move backwards` — giảm watermark của side |
| 429 `capacity` | `Retained event capacity reached` — side đã giữ 16 receipt |
| 400 `invalid_request` | `Invalid request` — sai schema |
| 400 `invalid_json` | JSON không parse được |
| 413 `body_too_large` / 415 `unsupported_media_type` | body quá byte / content-type sai |
| 404 `not_found` / 405 `method_not_allowed` | route/query không khai báo / method sai; 405 kèm Allow |
| 500 `internal_error` tại join | lỗi SQLite bất ngờ, transaction rollback |
| 502 `upstream_failure` tại ingress | `Join reply unavailable or invalid` |

Ingress validate request trước relay. Chỉ chuyển tiếp success đúng schema/status/id/duplicate hoặc ACK có hai watermark nguyên -1..104 và đúng mốc side vừa gửi. Chỉ giữ nguyên 409/429 nếu envelope **đúng field**, đúng code được phép cho route/status, đúng message cố định trên. `internal_error` dưới status 409 cũng là 502, dù code/message đều là string. Không suy ra business rejection chỉ từ HTTP status.

Mỗi relay có **một deadline 500 ms** cho fetch, headers và toàn bộ body, `redirect:'error'`, kiểm tra content-type và tối đa **8192 byte thực đọc** trước parse. Transport đứt, redirect, JSON/schema sai, body chậm hoặc quá byte đều 502. Không forward payload tới Location. 502 không chứng minh request chưa được join commit: response có thể mất sau commit; caller có thể retry cùng payload/id để phân biệt qua receipt. Watermark retry cùng mốc cũng idempotent.

Không proxy `/state`: 16×16 cặp hợp lệ đã có thể vượt 8192 byte. Chỉ state direct join được đọc đầy đủ; watermark ACK luôn nhỏ. Escaped string và whitespace vẫn tính vào byte budget. Fixture quá byte vẫn parse được và đúng schema; chỉ biến đổi token STRING đã decode rồi encode lại, không thay đổi token false/true/null/số.

## Lưu bền và giới hạn tài nguyên

SQLite dùng WAL, synchronous FULL và BEGIN IMMEDIATE. Receipt/pair insert cùng transaction; watermark update và mọi chuyển `final=1` cùng transaction. Lỗi giữa chừng rollback hết; restart thấy trạng thái trước hoặc sau commit. Tests dùng trigger gây lỗi insert/update để kiểm tra không có receipt mồ côi hay watermark vượt trước finalization. Không có final retraction và không delete receipt/output.

Tối đa **16 receipt mỗi side**, 32 tổng, tối đa **256 pair**. Capacity trả 429 và không đổi state; không tái sử dụng slot dù đã final. Implementation quét receipt hữu hạn của bên kia (tối đa 16), không duy trì active index thứ hai. Có thể tối ưu active index bằng cách bỏ left L khi right watermark >=L+3, bỏ right R khi left watermark >=R; bỏ sớm hơn có thể mất match out-of-order hợp lệ. Receipt để replay và pair output vẫn phải giữ, nên eviction index **không** giải phóng capacity receipt.

Đây là giới hạn hữu hạn của một phiên dữ liệu, không phải GC cho stream vô hạn. Kể cả tất cả pair đã final, database này không nhận vô tận id mới. Muốn vô hạn phải thiết kế riêng archive, thời hạn deduplication, checkpoint/source offsets và hợp đồng dữ liệu muộn. WAL/checkpoint có chi phí đĩa riêng; giới hạn số row không phải quota đĩa chính xác. Không có distributed checkpoint, watermark authentication, transactional sink, broker exactly-once, replication hay HA. Chạy một join owner cho file riêng; không chia sẻ SQLite như database mạng.

## Kiểm tra

Từ repository root, không cần HTTP cho hai lệnh đầu:

```bash
node --test --test-isolation=none --test-name-pattern=unit: lessons/70-event-time-interval-join/test/lesson.test.mts
npm run typecheck
npm run test:unit
```

Trên môi trường cho phép loopback HTTP (outer controller chạy trong Docker cô lập):

```bash
node --test --test-timeout=15000 lessons/70-event-time-interval-join/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite in-memory và logical time từ input; có bằng chứng assertion RED cho right-first boundary trước implementation. Tests kiểm tra hai biên, watermark riêng, replay sau closure, global conflict, capacity không recycle, rollback và import im lặng. HTTP tests spawn service độc lập với port ephemeral, thư mục `node:os.tmpdir()`, chờ readiness thay vì sleep, finally bảo vệ cleanup kể cả startup fail. Kiểm tra restart trước advancement/sau finalization, dense join, schema/semantic reply sai, deadline cả body, oversized JSON hợp lệ và redirect tới origin reachable khác với counter phải bằng 0 **trước đổi fixture mode**. Test fixture chỉ chạy khi gọi trực tiếp; không listener ở top-level import.

Worker không chạy HTTP trong sandbox không có network. Việc có tests không đồng nghĩa integration đã pass; outer controller phải chạy và review độc lập trước publication.

## Bài tập

1. Lập bảng L=10, R=11 cho các watermark (left=10,right=13), (11,12), (11,13). Giải thích từng cờ final và event mới nào còn được nhận.
2. Thêm test cho click time=9 khi impression time=10 để minh họa khoảng bất đối xứng; thay key và chứng minh không match.
3. Thiết kế active index có eviction đúng biên nhưng giữ toàn bộ receipt/output. Đo số lần so sánh, kiểm chứng mọi thứ tự arrival vẫn cho cùng pair.
4. Đề xuất hợp đồng archive/dedup hữu hạn cho stream dài. Nêu dữ liệu nào có thể quên và retry sau thời hạn được xử lý ra sao, trước khi viết GC.

## Nguồn chính

- [Apache Flink — Interval join](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/joining/#interval-join): mô hình ghép cùng key theo khoảng event-time. Bài này dùng hợp đồng watermark/final riêng nêu rõ ở trên.
- [Apache Flink — Time and watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/): event-time, processing time và tiến độ qua watermark.
- [Node.js SQLite](https://nodejs.org/api/sqlite.html): DatabaseSync và statement APIs.
- [SQLite — Atomic commit](https://www.sqlite.org/atomiccommit.html), [WAL](https://www.sqlite.org/wal.html): ranh giới transaction và lưu bền cục bộ.
