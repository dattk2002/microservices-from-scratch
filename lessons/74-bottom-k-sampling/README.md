# 74 — Lấy mẫu bottom-k có thể hợp nhất

Hai dịch vụ nhận các ID độc lập, mỗi dịch vụ chỉ giữ bốn ID có độ ưu tiên nhỏ nhất. Một dịch vụ tổng hợp đọc hai mẫu rồi lấy bottom-4 của hợp mẫu. Kết quả bằng bottom-4 của hợp các tập ID đã nhận, dù các shard có kích thước khác nhau, có ID trùng nhau hoặc nhận theo thứ tự khác nhau.

Điểm cần phân biệt: đây là mẫu của **ID phân biệt**, không phải mẫu của các lần xuất hiện sự kiện. Gửi `a` một triệu lần vẫn chỉ đóng góp một ứng viên `a`.

## Chuẩn bị và chạy

Cần Node.js **24.12.0 trở lên, thuộc dòng 24**, hỗ trợ chạy trực tiếp `.mts`, `fetch` và SQLite tích hợp. Runtime chỉ dùng built-in; không cần Docker, dịch vụ ngoài, khóa truy cập hay gói npm runtime. Các gói phát triển đã được ghim ở gốc repository. Chạy lệnh từ gốc repository. Mỗi nguồn phải có file SQLite riêng, nằm trong thư mục riêng tư; không chia sẻ DB giữa tiến trình.

Tạo thư mục dữ liệu một lần:

```sh
install -d -m 700 /tmp/bottom74-demo
```

Terminal 1:

```sh
HOST=127.0.0.1 PORT=7074 SAMPLE_ID=a DB_PATH=/tmp/bottom74-demo/a.sqlite \
  node lessons/74-bottom-k-sampling/sampler.mts
```

Terminal 2:

```sh
HOST=127.0.0.1 PORT=7075 SAMPLE_ID=b DB_PATH=/tmp/bottom74-demo/b.sqlite \
  node lessons/74-bottom-k-sampling/sampler.mts
```

Terminal 3:

```sh
HOST=127.0.0.1 PORT=7076 \
  SOURCE_A_ORIGIN=http://127.0.0.1:7074 SOURCE_B_ORIGIN=http://127.0.0.1:7075 \
  node lessons/74-bottom-k-sampling/aggregate.mts
```

Mỗi tiến trình in một dòng JSON readiness, ví dụ `{"service":"bottom4-sampler","port":7074}`. `PORT=0` yêu cầu hệ điều hành chọn cổng tạm; lấy cổng thực từ dòng readiness rồi cấu hình aggregate. `HOST` chỉ nhận `127.0.0.1`. Cổng mặc định của sampler là 7074 và aggregate là 7076; hai sampler trên cùng máy phải đặt cổng khác nhau hoặc dùng `0`.

`SAMPLE_ID` bắt buộc là `a` hoặc `b`. `DB_PATH` bắt buộc là đường dẫn tuyệt đối tới file riêng tư: file mới có mode `0600`; file có quyền cho group/other, symlink hoặc file không thông thường bị từ chối. Thư mục cha phải tồn tại. DB ghi cố định identity và algorithm; khởi động lại với identity khác hoặc algorithm không khớp sẽ lỗi **trước khi listen**. SQLite chỉ được dynamic import trong `main()`, vì vậy import entrypoint không đọc env, không mở DB, không listen và không phát cảnh báo SQLite trên Node 24.12. Chạy trực tiếp sampler có thể phát cảnh báo experimental của Node 24.12.

Gửi dữ liệu và đọc kết quả:

```sh
curl -sS http://127.0.0.1:7074/events -H 'content-type: application/json' -d '{"id":"a"}'
curl -sS http://127.0.0.1:7075/events -H 'content-type: application/json' -d '{"id":"a"}'
curl -sS http://127.0.0.1:7074/events -H 'content-type: application/json' -d '{"id":"j"}'
curl -sS http://127.0.0.1:7074/snapshot
curl -sS http://127.0.0.1:7076/sample
```

Hai lần nhận `a` chỉ tạo một phần tử trong kết quả tổng hợp. Dùng Ctrl-C để dừng; khởi động lại với cùng DB và identity giữ nguyên mẫu. Bài không cung cấp API xóa hay reset tập ID.

## Kiến trúc và hợp đồng HTTP

```text
client ──POST /events──> sampler a ── a.sqlite (config + tối đa 4 hàng sample)
client ──POST /events──> sampler b ── b.sqlite (config + tối đa 4 hàng sample)
client ──GET /sample───> aggregate
                           ├──GET /snapshot──> a
                           └──GET /snapshot──> b
```

`contracts.mts` chứa hàm thuần cho hash, thứ tự, bottom-4, merge và validation. `store.mts` dùng transaction SQLite đồng bộ để cập nhật mẫu; `sampler.mts` sở hữu vòng đời kết nối. `aggregate.mts` không có DB, fetch song song hai snapshot trong cùng một ngân sách thời gian. `runtime.mts` dùng lại `lib/http.mts` và chuẩn hóa error envelope.

| Dịch vụ / route | Request chính xác | Response thành công |
| --- | --- | --- |
| sampler `POST /events` | JSON object chỉ có `id`, chuỗi ASCII `[a-z0-9]{1,16}` | `200 {"retained":true}` hoặc `200 {"retained":false}` |
| sampler `GET /snapshot` | Không có query hay body nghiệp vụ | `200 {"id":"a","algorithm":"bottom4-sha256-v1","sample":[{"id":"…","priority":"…"}]}`; nguồn b trả `id:"b"` |
| aggregate `GET /sample` | Không có URL hay query do caller cung cấp | `200 {"algorithm":"bottom4-sha256-v1","sample":[{"id":"…","priority":"…"}]}` |

`retained` nghĩa là ID **đang nằm trong mẫu sau thao tác này**. Nó không phải cờ “đã nhận lần đầu”, “đã từng nhận”, hay xác nhận ID sẽ được giữ mãi. Replay ID đang giữ trả `true`; replay ID đã bị đẩy ra trả `false` và không thay đổi mẫu. Mẫu rỗng hoặc có dưới bốn phần tử đều hợp lệ.

Mọi object JSON nghiệp vụ phải đúng tập trường; `null`, array, primitive, trường thừa và sai kiểu bị từ chối, không ép kiểu bằng `String(...)`. Chuỗi priority phải gồm đúng 64 ký tự hex thường và khớp SHA-256 tính lại từ ID. Mẫu phải tăng nghiêm ngặt theo `(priority, id)`, không có ID lặp và có tối đa bốn phần tử.

| Trường hợp | Status / code |
| --- | --- |
| Sai schema request | `400 invalid_request` |
| JSON hỏng | `400 invalid_json` |
| Body request vượt 8192 byte | `413 body_too_large` |
| Content-Type request khác `application/json` | `415 unsupported_media_type` |
| Sai method trên route đã biết | `405 method_not_allowed`, có header `Allow` |
| Route/query không được hỗ trợ | `404 not_found` |
| Lỗi xử lý nội bộ | `500 internal_error` |
| Bất kỳ lỗi upstream nào ở aggregate | `502 upstream_failure` |

Mọi error dùng `{"error":{"code":"…","message":"…"}}` với `message` bằng `code`. Response có Content-Type JSON và `Cache-Control: no-store`. Server dùng giới hạn headers/request 5 giây của helper chung; client/test cũng đặt deadline. Không có retry hay vòng polling nền.

Hai origin upstream phải là **HTTP origin loopback `127.0.0.1`**, không chứa credentials, path khác `/`, query hay fragment, không dùng cổng 0. Chúng được chuẩn hóa bằng URL rồi so sánh để từ chối hai origin giống nhau, kể cả cách viết cổng mặc định khác nhau. Aggregate cũng từ chối cấu hình trỏ tới chính cổng listen đã chỉ định. Origin không được lấy từ caller.

Mỗi lần `GET /sample` có **một deadline tổng 500 ms** cho cả hai fetch, từ trước khi gửi request đến khi đọc xong mọi byte và kiểm tra snapshot. Không cấp lại 500 ms sau headers hoặc cho nguồn thứ hai. Mỗi response JSON có giới hạn **8192 byte thực đọc**, kể cả whitespace; `8192` hợp lệ, `8193` bị từ chối. Redirect bị chặn bằng `redirect:'error'`. HTTP khác 200, transport lỗi, timeout, JSON hỏng, Content-Type sai, envelope thừa trường, sai identity/algorithm/hash, trùng ID hoặc sai thứ tự đều thành `502 upstream_failure`. Không chuyển tiếp 404/409/422/429 như lỗi nghiệp vụ vì nguồn chỉ có hợp đồng thành công 200 cho snapshot; ngay cả error có cấu trúc đẹp vẫn không phải snapshot hợp lệ. Khi một nguồn thất bại, hủy nguồn còn lại và không trả kết quả một phần.

## Vì sao chỉ cần giữ bốn ID?

Với mỗi ID `x`, đặt `p(x) = SHA256(UTF8(x))`, biểu diễn hex thường. Thứ tự so sánh là priority tăng dần, rồi ID ASCII tăng dần nếu priority bằng nhau. Hex cùng độ dài giữ đúng thứ tự giá trị hash; không dùng locale. Hai ID khác nhau vẫn được phân thứ tự khi hash đụng nhau.

Gọi `B(S)` là bốn ID đầu của tập `S` theo thứ tự này, hoặc toàn bộ nếu `|S| < 4`. Bất biến của từng nguồn là:

```text
sample = B(tất cả ID phân biệt đã nhận thành công)
```

Nếu `x` đã bị loại, đã có ít nhất bốn ID nhỏ hơn `x` trong tập logic. Tập logic chỉ tăng nên điều đó không thể mất đi. Gửi lại `x` vì thế không thể đưa nó trở lại bottom-4. Không cần lưu receipts hay toàn bộ tập đã thấy để nhớ quyết định này. Khi cập nhật, chương trình chỉ xét tối đa năm ứng viên: mẫu hiện tại và ID vừa đến.

Với `x ∉ B(A)`, có ít nhất bốn phần tử của `A` nhỏ hơn `x`; các phần tử này cũng nằm trong `A ∪ B`. Vì vậy `x` không thể thuộc bottom-4 toàn cục. Suy ra:

```text
B(B(A) ∪ B(B)) = B(A ∪ B)
merge(X,Y) = B(X ∪ Y)
```

Sau khi loại ID trùng, merge có tính giao hoán, kết hợp và lũy đẳng. Shard lớn không được “một phiếu” ngang shard nhỏ; chúng đóng góp ứng viên theo cùng một thứ tự toàn cục. Không nối hai mảng rồi cắt bốn theo vị trí đến, không lấy số lượng bằng nhau từ mỗi shard.

SQLite lưu đúng hai bảng: `config(singleton,id,algorithm)` và `sample(id,priority)`. Không có tổng sự kiện, số distinct, log receipts hay exact distinct set. Mỗi transaction có `BEGIN IMMEDIATE`, thay mẫu rồi commit với `synchronous=FULL`; nếu một insert lỗi, cả eviction và insertion rollback. Việc bỏ hàng khỏi **mẫu lưu trữ** là eviction; tập ID **logic** vẫn chỉ được thêm. Không có thao tác xóa ID logic hoặc thay seed/hash. Sau commit luôn tối đa bốn hàng mẫu. Giới hạn này nói về trạng thái logic và số hàng, không cam kết kích thước file SQLite đúng bằng kích thước JSON; SQLite còn có pages, schema và rollback journal.

## Giới hạn và đánh đổi

- Hash cố định cho replay, thứ tự nhận và merge kết quả ổn định. Đây là **độ ưu tiên giả ngẫu nhiên tất định**, không phải một lượt bốc thăm mới mỗi lần đọc.
- Nếu các priority độc lập và phân bố đều, trong mô hình collision có xác suất không đáng kể, mỗi ID có cơ hội vào mẫu như nhau. SHA-256 cố định trên ID do caller chọn không tự chứng minh các giả thiết đó. Người biết hash có thể thử nhiều ID để chọn priority nhỏ và chi phối mẫu. Bài không phải xổ số mật mã bảo đảm không thiên lệch.
- Tần suất lặp không tăng trọng số. Không phải reservoir Algorithm R, không phải weighted sampling; không suy ra count estimate từ output này.
- Bốn phần tử là mẫu rất nhỏ, có phương sai lớn nếu dùng để khảo sát dữ liệu. Không thay được truy vấn đầy đủ hay nhật ký audit. Không thể trả lời chính xác “ID này đã từng xuất hiện chưa?”.
- Hai snapshot được đọc song song nhưng không phải snapshot phân tán nguyên tử. Kết quả tương ứng với hợp hai tập tại hai thời điểm đọc; khi có ghi đồng thời, nó có thể chưa chứa ID vừa tới sau một lần đọc. Khi các nguồn ngừng ghi và đều đọc thành công, merge cho bottom-4 toàn cục ổn định.
- Sửa algorithm hoặc cho phép xóa logic phá vỡ chứng minh replay và merge. Muốn đổi hash/seed phải xây lại từ dữ liệu gốc; chỉ bốn phần tử cũ không đủ. DB mất/hỏng cũng không tự phục hồi từ những ID đã bị bỏ.
- Chỉ chạy loopback trong môi trường học; không có authentication, replication DB hay cơ chế khôi phục thảm họa. Dịch vụ synchronous SQLite phù hợp minh họa transaction nhỏ, không phải thiết kế chịu throughput tùy ý.

## Kiểm chứng

Từ gốc repository:

```sh
npm run typecheck
node --test --test-isolation=none --test-name-pattern=unit: lessons/74-bottom-k-sampling/test/lesson.test.mts
npm run test:unit
node --test --test-concurrency=1 lessons/74-bottom-k-sampling/test/lesson.test.mts
```

Lệnh cuối bao gồm HTTP thật và cần môi trường cho phép listen loopback. Quy trình đầy đủ của repository còn dùng `npm run check`, `make test` và `git diff --check`; controller tin cậy sở hữu việc chạy HTTP trong Docker khi worker bị chặn mạng/listener.

Unit dùng golden SHA-256 literal: với `a` đến `l`, thứ tự kết quả là `j,d,f,c`. Chúng kiểm tra permutations, replay đã eviction, empty/short/overlap/disjoint/unequal shards, merge nhiều lần, tính kết hợp/giao hoán/lũy đẳng, và comparator với fixture hai priority bằng nhau để kiểm tra tie-break theo ID. SQL trigger gây lỗi thật giữa replacement để xác nhận rollback; nhiều ID hơn bốn vẫn chỉ giữ bốn hàng. Response/stream trong unit deadline là transport thay thế để không mở listener; logic parse, đọc byte, validation và timer của aggregate vẫn chạy thật.

Integration dùng `test/support.mts` để spawn ba service process độc lập, cổng tạm và DB trong thư mục tạm. Chúng đọc nhiều lần, gửi ID trùng giữa hai nguồn, restart một nguồn cùng cổng, từ chối identity khác, gửi thêm 96 ID rồi kiểm tra golden toàn cục và DB bốn hàng. Fixture đối kháng kiểm tra cả a lẫn b: headers/body chậm, JSON hỏng, schema sai, status không mong đợi, wire 8192/8193 byte vẫn parse đúng schema, disconnect và redirect. Redirect trỏ sang một origin `127.0.0.1` khác đang listen; test đọc counter bằng 0 **trước** khi đổi fixture mode. Một response 502 riêng lẻ không đủ làm bằng chứng chặn redirect. Mọi lần acquire process/listener/DB đều nằm trong phạm vi cleanup, kể cả startup lỗi.

## Bài tập

1. Dùng cùng một tập ID, thay cách chia shard từ 1/11 sang 6/6 và đảo mọi thứ tự gửi. Giải thích vì sao kết quả cuối vẫn là `j,d,f,c`.
2. Gửi lại một ID đã bị eviction nhiều lần. So sánh ý nghĩa `retained:false` với một API idempotency có receipts vĩnh viễn.
3. Chứng minh công thức merge cho ba shard và trường hợp hash collision; giải thích vai trò của total order.
4. Thiết kế kế hoạch tăng k hoặc thay algorithm mà không giả định có thể tái tạo dữ liệu đã bỏ. Dữ liệu nào cần được giữ bên ngoài sampler?
5. Tạo nhiều ID offline rồi chọn các hash nhỏ nhất. Thí nghiệm này minh họa loại thiên lệch nào, và vì sao SHA-256 không tự ngăn được nó?

## Tài liệu gốc

- [Apache DataSketches — Theta Sketches](https://datasketches.apache.org/docs/Theta/ThetaSketches.html): bối cảnh về sketch tập hợp và phép toán hợp. Bài này chỉ triển khai mẫu bottom-4 với priority cố định; không triển khai toàn bộ Theta Sketch hay bộ ước lượng cardinality của thư viện.
- [Node.js 24 — Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html): `createHash`, `update` với UTF-8 và `digest('hex')` dùng để tạo priority.
- [Node.js 24 — SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): kết nối đồng bộ, prepared statement và các giới hạn runtime SQLite tích hợp.
