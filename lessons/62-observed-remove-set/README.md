# 62 — OR-set: add-wins, xóa phần đã thấy và tombstone không hồi sinh

Một tập hợp phân tán không thể mô tả đủ bằng danh sách phần tử hiện có. Nếu A thêm `red` trong lúc B xóa `red`, ta phải biết B đã thấy **lần thêm nào**. Bài này xây một observed-remove set giữ lịch sử trong SQLite, hai replica độc lập và relay đồng bộ HTTP. Không cần đồng hồ vật lý, leader hay bộ đếm dùng chung.

## Theo dấu một lịch sử cụ thể

Mỗi lần thêm tạo một tag bất biến `(actor, seq)`. Viết `a1` cho `(a,1)`:

1. A thêm `red`: adds có `a1 → red`.
2. B nhận snapshot A, rồi xóa `red`: removed có `a1`.
3. Trong khi chưa nhận lần xóa đó, A thêm `red` lần nữa: adds có cả `a1 → red`, `a2 → red`.
4. Hợp hai snapshot: removed chỉ có `a1`; `a2` còn sống nên `red` hiện diện.
5. B nhận hợp này rồi xóa tiếp: removed có `a1,a2`; `red` biến mất.
6. Phát lại snapshot cũ không xóa tombstone nên không thể hồi sinh `a1,a2`. Một lần thêm mới `a3 → red` lại làm `red` xuất hiện.

Đây là **add-wins đối với thao tác đồng thời**: remove chỉ xóa các tag đã quan sát, không xóa một lần thêm chưa từng thấy. Nếu remove xảy ra sau khi đã thấy add thì remove có hiệu lực. Gọi `A` là ánh xạ tag → phần tử, `R` là tập tag bị xóa:

```text
present(e) ⇔ tồn tại t: A[t] = e và t ∉ R
join((A₁,R₁),(A₂,R₂)) = (A₁ ∪ A₂, R₁ ∪ R₂)
```

Hợp chỉ xác định khi cùng tag luôn mang cùng phần tử. Với các trạng thái hợp lệ có thể đạt được, union giao hoán, kết hợp, lũy đẳng. Vì vậy gửi lặp và đổi thứ tự đồng bộ vẫn hội tụ sau khi các thay đổi được trao đổi đầy đủ. Không có đồng bộ tự động trong bài; phân vùng mạng có thể khiến hai replica khác nhau vô hạn nếu người vận hành không gọi sync.

## Kiến trúc, lưu trữ và giới hạn

```text
replica a + DB riêng ← GET /state ─ sync ─ POST /merge → replica b + DB riêng
replica a + DB riêng ← POST /merge ─ sync ─ GET /state → replica b + DB riêng
```

`replica.mts` phục vụ API; `state.mts` kiểm tra schema và thực hiện phép hợp. `sync.mts` chỉ dùng hai origin cố định được chuẩn hóa khi khởi động. Cả hai phải là HTTP origin `127.0.0.1`, khác nhau; không credentials, path ngoài `/`, query hoặc fragment. Caller chọn `from`, không đưa URL. Snapshot có thể chứa tag của cả A và B; relay không suy diễn actor của tag từ origin đang chuyển tiếp. Bài dùng trao đổi toàn bộ state, không có event endpoint hoặc identity hop bổ sung.

SQLite giữ identity và toàn bộ snapshot. Mỗi add/remove/merge chạy trong transaction `BEGIN IMMEDIATE`, cập nhật snapshot rồi `COMMIT`; lỗi rollback. WAL và `synchronous=FULL` bật khi mở DB. Counter riêng được suy ra từ lịch sử add liên tục đã lưu, không suy ra từ các phần tử còn sống. Đổi `REPLICA_ID` trên DB cũ bị từ chối trước khi listen; dữ liệu ứng dụng không đổi. Không xóa file DB để “sửa” identity.

Giả định: hai peer đáng tin, mỗi actor có đúng một writer và DB riêng. Không clone DB rồi cho hai tiến trình cùng cấp tag của một actor. Schema validation không chứng minh nguồn gốc lịch sử; không có xác thực, chống Byzantine, membership động hoặc cam kết sản xuất.

Các lựa chọn giáo dục cố định:

- Actor chỉ `a|b`; phần tử chỉ `red|green|blue`.
- Mỗi actor cấp seq `1..8`, liên tục từ 1 đến highest; highest ban đầu bằng 0.
- Giữ tối đa 16 add và 16 removed. Adds giữ cả tag đã xóa; removed luôn là tập con các add đã biết và chỉ tăng.
- Add thứ chín của actor trả 429, kể cả tất cả phần tử đã bị xóa. Remove không cấp số và không giải phóng slot.
- Mỗi body upstream và body POST outbound tối đa **8192 byte**. Snapshot lớn nhất vẫn nằm trong giới hạn khi mọi ký tự trong JSON string được viết thành `\uXXXX`; số nguyên giữ nguyên cú pháp JSON.
- Relay có **một deadline tổng 500 ms**, gồm header và toàn bộ body của cả hai hop. Không cấp lại 500 ms cho hop thứ hai; không retry, `redirect: 'error'` ở cả hai hop.
- Mỗi lần sync kết thúc đều hủy fetch bằng AbortController và dọn timer, kể cả khi Content-Type sai khiến relay từ chối trước khi đọc body chưa kết thúc.

Các entrypoint chỉ đọc cấu hình, mở DB, listen và đăng ký signal bên trong `main()` được chặn bằng `import.meta.main`. Import để kiểm thử không gây side effect, kể cả khi biến môi trường không hợp lệ.

## Hợp đồng HTTP

Snapshot chính xác, không trường thừa:

```json
{"adds":[{"actor":"a","seq":1,"element":"red"},{"actor":"b","seq":1,"element":"blue"}],"removed":[{"actor":"a","seq":1}]}
```

Hai mảng đều sắp actor trước rồi seq tăng dần, không trùng tag. Mảng adds phải chứa mọi seq từ 1 đến highest của từng actor. Không chấp nhận khoảng trống, tag ngoài giới hạn, removed không có add tương ứng, kiểu sai hoặc trường thừa. `null`, array và primitive không thay thế được object. Giữ schema chuẩn giúp phát hiện dữ liệu hỏng sớm; không tự sắp xếp đầu vào sai rồi chấp nhận.

| Route | Request | Kết quả |
| --- | --- | --- |
| `GET /state` | Không body | 200 snapshot, không wrapper |
| `GET /values` | Không body | 200 `{"values":["blue","red"]}`, thứ tự từ điển |
| `POST /add` | `{"element":"red"}` | 200 snapshot; luôn cấp tag mới, kể cả phần tử đang hiện diện |
| `POST /remove` | `{"element":"red"}` | 200 snapshot; đánh dấu đúng các tag đã thấy của phần tử, absent vẫn thành công |
| `POST /merge` | Snapshot hoàn chỉnh | 200 snapshot đã hợp; 409 nếu cùng tag đổi phần tử, không đổi state |
| Relay `POST /sync` | `{"from":"a"}` hoặc `{"from":"b"}` | GET nguồn, kiểm tra snapshot, POST đích, kiểm tra reply |

Request JSON sai schema trả 400. Helper chung trả 400 cho JSON hỏng, 413 nếu POST vượt 8192 byte, 415 nếu không dùng `application/json`. Route/method không hỗ trợ trả 404. Lỗi có dạng `{"error":{"code":"…","message":"…"}}`. Hết lịch sử: 429 `exhausted`, message `Actor add history exhausted`.

Relay trả 200 chỉ với snapshot đích hợp lệ. Chỉ target 409 với **đúng** envelope sau được giữ 409:

```json
{"error":{"code":"conflicting_tag","message":"Tag already names another element"}}
```

Mọi status khác, 409 có code/message khác hoặc trường thừa, JSON/schema sai, body quá lớn, redirect, hết deadline hoặc lỗi transport đều thành 502 `bad_upstream` / `Upstream exchange failed`. Source 404 không mang ý nghĩa “không có phần tử”; state rỗng hợp lệ phải là snapshot rỗng kèm 200. Relay không dùng status để thay cho kiểm tra contract.

Một 502 có thể xảy ra **sau khi đích đã commit** nhưng reply mất hoặc chậm. Nó không chứng minh merge thất bại. Gửi lại snapshot an toàn nhờ tính lũy đẳng; gọi lại `/add` lại tạo tag khác, nên add không có bảo đảm retry tương tự.

## Chạy native

Yêu cầu Node **24.12+**, dev dependencies đã pin ở root; runtime chỉ dùng Node built-ins, gồm `node:sqlite`. Chạy từ root repo:

```bash
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/62-observed-remove-set/test/lesson.test.mts
npm run test:unit
node --test --test-name-pattern=integration: lessons/62-observed-remove-set/test/lesson.test.mts
```

Full checks trong môi trường cho phép loopback: `npm run check`, `make test`, `git diff --check`. Worker không có mạng chỉ chạy typecheck và unit; controller chạy HTTP trong Docker cô lập. Các ca integration không được coi là pass trước khi thực sự chạy.

Khởi động theo thứ tự A, B, sync trong ba terminal, dùng hai DB mới và riêng biệt:

```bash
HOST=127.0.0.1 PORT=0 REPLICA_ID=a DB_PATH=/tmp/orset-a.sqlite node lessons/62-observed-remove-set/replica.mts
HOST=127.0.0.1 PORT=0 REPLICA_ID=b DB_PATH=/tmp/orset-b.sqlite node lessons/62-observed-remove-set/replica.mts
# Ví dụ readiness của A/B là 41001/41002; thay bằng port thực vừa nhận.
HOST=127.0.0.1 PORT=0 A_ORIGIN=http://127.0.0.1:41001 B_ORIGIN=http://127.0.0.1:41002 node lessons/62-observed-remove-set/sync.mts
```

Mỗi service in JSON `{service,port}` khi sẵn sàng. Không đặt biến môi trường có tiền tố dành riêng `NODE_`, `LD_`, `DYLD_`. Ví dụ sync in port 41003:

```bash
curl -sS -H 'content-type: application/json' -d '{"element":"red"}' http://127.0.0.1:41001/add
curl -sS -H 'content-type: application/json' -d '{"from":"a"}' http://127.0.0.1:41003/sync
curl -sS -H 'content-type: application/json' -d '{"element":"red"}' http://127.0.0.1:41002/remove
curl -sS -H 'content-type: application/json' -d '{"element":"red"}' http://127.0.0.1:41001/add
curl -sS -H 'content-type: application/json' -d '{"from":"b"}' http://127.0.0.1:41003/sync
curl -sS http://127.0.0.1:41001/values
```

Kết quả cuối là `{"values":["red"]}`. Gọi sync từ A để B cũng thấy `a2`, remove tại B rồi sync từ B để cả hai rỗng. Dừng bằng Ctrl-C, khởi động lại cùng identity/DB để quan sát tombstone và seq còn nguyên. Thí nghiệm độc lập nên dùng tên DB mới; không dùng DB mới để giả vờ một actor cũ đã quên lịch sử mà vẫn merge với peer cũ.

## Kiểm thử và các biến thể dễ sai

Unit đầu tiên bắt lỗi xóa concurrent add: A có `a1,a2`, B mới xóa `a1`, nên hợp phải còn `red`. Các unit khác dùng literal tự suy ra cho giao hoán/kết hợp/lũy đẳng, replay snapshot cũ, conflict rollback, exhaustion, schema primitive, origin chuẩn hóa và import im lặng trong child process với cấu hình cố ý sai.

Integration chạy process riêng và port loopback tạm, DB trong `node:os.tmpdir()`, cleanup cả khi startup lỗi. Các fixture có `/control` chỉ khi `TEACHING_CONTROLS=1`, mặc định 404, kiểm tra kiểu trước khi chọn mode. Fixture dùng lại process qua nhiều biến thể thay vì tạo process cho từng lỗi. Redirect trỏ tới một origin loopback khác thực sự đang listen; test so bộ đếm request **trước khi đổi mode** để chứng minh payload không bị gửi theo redirect. Oversize fixture vẫn là snapshot hợp lệ; maximal escaping chỉ biến đổi JSON string token đã decode, không làm hỏng number/boolean/null. Test body chậm và hai hop mỗi hop 300 ms phân biệt deadline tổng với timeout riêng từng hop.

Unit thay fetch tạm thời (khôi phục trong finally) để kiểm tra signal đã abort khi nguồn hoặc đích trả Content-Type sai và body chưa kết thúc. Integration tương ứng dùng fixture gửi `text/plain` cùng một chunk rồi không kết thúc; `/pending` chỉ bật cùng teaching controls, đếm response đang mở và đã đóng (tối đa 16 response đang mở; số đã đóng bão hòa ở 16). Sự kiện `res.close` giảm số đang mở. Test quan sát response đóng sau 502, trước deadline 500 ms, trước khi đổi mode hoặc dừng process.

## Vì sao chưa thể thu gom tombstone?

Remove-wins chọn kết quả ngược lại cho add/remove đồng thời và cần mô hình metadata khác; thay phép đọc trong bài không đủ. Two-phase set giữ hai tập phần tử đã add/đã remove, nên phần tử đã xóa không bao giờ được thêm lại. OR-set này xóa **tag**, vì vậy một tag mới vẫn thêm lại phần tử được.

Nếu bỏ tombstone `a1` trong khi peer offline còn snapshot chứa `a1`, lần hợp sau sẽ làm `red` sống lại. Muốn GC cần chứng minh causal stability: mọi replica được phép quay lại đều đã thấy removal, hoặc dùng protocol membership/epoch để loại hẳn replica cũ cùng chính sách phục hồi rõ ràng. Việc “đã qua một ngày” hay “hai replica hiện đang online” không tự cung cấp bằng chứng đó. Bài giữ tombstone suốt đời DB và báo hết lịch sử; không cài tối ưu ORSWOT, compaction vector hay membership tùy ý.

## Bài tập

1. Viết tay snapshot sau lịch sử `a1:red`, `b1:red`, remove tại A chỉ thấy `a1`; kiểm tra bằng hai process và đảo chiều sync.
2. Chứng minh invariant `removed ⊆ tags(adds)` được giữ qua local remove và join. Tại sao conflict phải rollback toàn bộ?
3. Mô tả lỗi khi xóa tag đã remove khỏi cả hai mảng mà peer B vẫn offline với snapshot cũ.
4. Thiết kế trên giấy bằng chứng causal stability cho ba replica, bao gồm trường hợp một replica bị loại rồi mang backup cũ quay lại. Nêu rõ giả định trước khi đề xuất GC.

## Nguồn gốc khái niệm

- [Shapiro và cộng sự — A comprehensive study of Convergent and Commutative Replicated Data Types](https://pages.lip6.fr/Marc.Shapiro/papers/Comprehensive-CRDTs-RR7506-2011-01.pdf): mô hình CRDT và các tập hợp phân tán.
- [Shapiro và cộng sự — RR-8083](https://www.lip6.fr/Marc.Shapiro/papers/RR-8083.pdf): thiết kế observed-remove set và các tối ưu metadata. Bài này cố ý giữ lịch sử nhỏ, tường minh để học semantics trước khi tối ưu.
