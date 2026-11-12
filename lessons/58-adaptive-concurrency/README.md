# 58 — Concurrency thích nghi bằng phản hồi độ trễ và giảm tải AIMD

Gateway giới hạn số lookup đang chạy, rồi điều chỉnh giới hạn bằng phản hồi từ worker. Đây là **thuật toán giảng dạy tự thiết kế**: ban đầu 2, tối thiểu 1, tối đa 4; ngưỡng nhanh 100 ms; bốn thành công nhanh tăng một; một phản hồi nghẽn chia đôi và làm tròn xuống. Các số này không phải mặc định Netflix, cũng không phải hướng dẫn tinh chỉnh production.

## Chuẩn bị và chạy

Cần Node.js 24.12+ (nhánh 24) và các dev dependency đã khóa ở root. Không có runtime package, credential, database hay dịch vụ bên ngoài. Chạy từ root repository trong hai terminal:

```sh
HOST=127.0.0.1 PORT=3058 node lessons/58-adaptive-concurrency/worker.mts
HOST=127.0.0.1 PORT=3059 WORKER_ORIGIN=http://127.0.0.1:3058 node lessons/58-adaptive-concurrency/gateway.mts
```

Mỗi process in một dòng JSON `{service,port}` khi đã listen. Dùng `PORT=0` để hệ điều hành chọn cổng, rồi lấy cổng worker từ readiness trước khi khởi động gateway. `WORKER_ORIGIN` bắt buộc là origin HTTP loopback 127.0.0.1, không credentials/path/query/fragment. Gateway giữ nguyên origin đã chuẩn hóa trong suốt vòng đời. Không có origin do caller cung cấp.

```sh
curl -i http://127.0.0.1:3059/work -H 'content-type: application/json' -d '{"id":"a"}'
curl http://127.0.0.1:3059/state
```

Mọi entrypoint inert khi import: đọc cấu hình, listener, timer và đăng ký signal chỉ xảy ra trong `main()`, có guard `import.meta.main`. Không có replica hay trạng thái bền vững trong kiến trúc này, nên không có REPLICA_ID/SQLite cần khôi phục; restart bắt đầu lại controller.

## Kiến trúc và hợp đồng

`caller → gateway POST /work → worker POST /lookup`. Worker là phép tra cứu thuần: a→10, b→20,…, h→80. Request chính xác `{id:string}`, URL-safe `[A-Za-z0-9_-]`, dài 1..16. ID hợp lệ nhưng không thuộc a..h trả 404 `{error:{code:"not_found",message:"Unknown id"}}`. Thành công 200 `{id,value}`. Null, array, primitive, thiếu/thừa trường hoặc sai kiểu trả 400 trước admission. Shared HTTP reader giới hạn input 8192 byte, JSON hỏng trả 400, thiếu content type JSON trả 415, quá byte trả 413. Route/method ngoài hợp đồng trả 404.

Gateway trả nguyên 200/404 hợp lệ; 503 worker hợp lệ trả502 cho caller và vẫn là tín hiệu nghẽn để chia đôi limit. 503 worker chỉ được công nhận với envelope `{error:{code:"unavailable",message:"Worker unavailable"}}`. Sai schema, sai ID/value, code lỗi bất ngờ (kể cả `internal_error` hình thức hợp lệ), transport error và redirect trả 502. Không lấy HTTP status làm bằng chứng về ý nghĩa ứng dụng. 503 có envelope hỏng là 502 trung tính.

GET `/state` trả chính xác `{limit,active,fastStreak,epoch,admitted,rejected}`. Đầy capacity trả 429 và `Retry-After: 1`, không chuyển tới worker. Caller tự quyết định bước tiếp theo; gateway không queue/retry/coalescing/cache. Đây là giới hạn **đồng thời**, không phải rate limit đếm request theo cửa sổ thời gian. Khác bulkhead tĩnh, capacity thay đổi theo feedback; tốc độ phục vụ nhanh hơn vẫn có thể cho nhiều request/giây hơn.

## Controller và epoch

Admission chỉ khi `active < limit`; tăng active ngay, lưu identity epoch và thời điểm bắt đầu. Settlement luôn giảm active đúng một lần:

| Kết quả thuộc epoch hiện tại | Điều chỉnh |
| --- | --- |
| 200 đúng schema, elapsed ≤100 ms | fastStreak +1; đủ 4 thì tăng limit tối đa 4, streak về 0 |
| 200 đúng schema, elapsed >100 ms | limit = max(1, floor(limit/2)), streak =0, epoch +1 |
| 503 đúng envelope hoặc deadline 300 ms | giảm giống trên |
| 404, lỗi transport/schema/status khác, caller hủy | trung tính, không đổi streak/limit |
| Feedback epoch cũ | chỉ giải phóng permit |

Giảm limit không hủy những caller đã được nhận. Ví dụ limit 3, active 3: một phản hồi chậm làm limit 1 và active 2; request mới vẫn bị từ chối cho tới khi active xuống dưới 1. Không “bù” thêm permit khi đang vượt giới hạn mới. Closure settlement có cờ chống gọi hai lần. Counter admitted/rejected/epoch bão hòa 65535; active luôn bị chặn bởi tối đa 4 permit, streak 0..3. Identity object riêng đổi sau mỗi lần giảm, kể cả epoch số đã bão hòa; ticket cũ không thể sống lại vì so sánh số bằng nhau. Chỉ ticket chưa hết vòng đời giữ identity cũ, không có lịch sử request được lưu.

Gateway dùng đồng hồ đơn điệu `performance.now()` trong chế độ thường. Một timer **tổng 300 ms**, bắt đầu ngay sau admission, bao gồm fetch và đọc hết body; không đặt lại deadline khi có headers/chunk. Đọc upstream tối đa 512 byte, đủ JSON escape cực đại của schema nhỏ này. `redirect: 'error'` ngăn payload đi sang origin khác. Body sai hoặc quá byte bị hủy; timer và stream được dọn trong finally. Response close từ caller abort fetch và settle trung tính ngay, không gửi trả khi caller đã mất kết nối, không biến cancellation thành nghẽn.

## Thí nghiệm xác định, không ngủ để tạo độ trễ

Khởi động **cả hai** process với `TEACHING_CONTROLS=1`. Không bật flag thì tất cả teaching routes trả 404. Chế độ này thay toàn bộ clock gateway bằng logical milliseconds bắt đầu **0**, không cộng offset vào thời gian thực:

| Service, route | Body/kết quả |
| --- | --- |
| Gateway POST `/teaching/advance` | `{milliseconds:integer 1..1000}` → `{now}`; tổng không vượt 10000 |
| Worker POST `/teaching/hold` | `{enabled:boolean}` → `{ok:true}` |
| Worker POST `/teaching/behavior` | `{mode:"normal"\|"unavailable"}` → `{ok:true}` |
| Worker GET `/teaching/state` | `{calls,active,maxConcurrent}` |

Các body chỉ chấp nhận đúng trường và primitive đã ghi; không ép kiểu chuỗi sang số/boolean. Worker giữ tối đa bốn request, mỗi hold tối đa 800 ms thực. Tắt hold giải phóng tất cả; caller close giải phóng riêng request đó. Shutdown có grace hữu hạn và đóng connection; hold tự hết hạn ngay cả khi startup/shutdown lỗi. Counter quan sát bão hòa 65535.

Ví dụ: chạy bốn lookup tuần tự để limit 2→3; bật hold; gửi ba request; poll teaching state tới active=3; request thứ tư phải 429 mà calls không tăng. Advance logical clock 101; tắt hold: một completion giảm 3→1, các completion cũ trung tính. Bốn success mới tăng 1→2. Chờ barrier quan sát active trước khi advance quan trọng hơn việc đoán thời gian bằng sleep. Deadline và hard hold vẫn dùng thời gian thực, nên teaching clock không thể vô hiệu hóa cleanup.

## Kiểm chứng

```sh
node --test --test-isolation=none --test-name-pattern=unit: lessons/58-adaptive-concurrency/test/lesson.test.mts
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=integration: lessons/58-adaptive-concurrency/test/lesson.test.mts
npm run check
make test
git diff --check
```

Worker môi trường không network chỉ chạy typecheck/unit; outer controller chạy integration HTTP thực trong Docker cô lập. Không coi unit xanh là bằng chứng HTTP xanh. Unit có RED assertion thực trước implementation: bốn success phải tăng từ 2 lên 3. Tests bao gồm epoch bão hòa và silent import với cấu hình cố ý sai. Integration dùng child process độc lập, ephemeral loopback, barrier state, cleanup lồng nhau ngay sau từng acquisition; một fixture upstream tái sử dụng nhiều mode. Redirect có destination loopback khác thật sự reachable, assert calls=0 trước thay mode. Fixture escape chỉ các JSON string token, giữ number/boolean/null hợp lệ; fixture quá byte vẫn đúng schema/identity để chứng minh byte gate.

## Giới hạn, đánh đổi và bài tập

Một limit chung làm các ID dùng chung capacity; không phân biệt tenant/priority. Không có hàng đợi giúp bộ nhớ hữu hạn nhưng có thể bỏ công việc hữu ích lúc burst. Success mẫu chỉ phản ánh caller đã được nhận, không phản ánh nhu cầu bị từ chối. 404 trung tính không tăng capacity. Nhiễu độ trễ có thể tạo dao động; không có smoothing, jitter hay probe chuyên dụng. Restart mất trạng thái. Deadline 300 ms cố định có thể quá ngắn hoặc quá dài cho môi trường khác. Teaching controls chỉ dành cho máy local, không phải cơ chế quản trị có xác thực.

Bài tập: vẽ tay state khi hai success epoch cũ về sau một 503; so sánh số request/giây của static bulkhead 2 với controller này khi worker nhanh/chậm; giải thích tại sao tăng epoch số mà không đổi identity sai ở saturation; đề xuất test cho fairness trước khi thiết kế controller theo tenant. Không suy ra bảo đảm production từ ví dụ này.

Tham khảo nguồn chính: [Netflix AIMDLimit.java](https://github.com/Netflix/concurrency-limits/blob/main/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/AIMDLimit.java) và [concurrency-limits README](https://github.com/Netflix/concurrency-limits/blob/main/README.md). Đọc để so sánh cơ chế và giả định; thuật toán, ngưỡng và ví dụ ở đây là lựa chọn giáo dục riêng.
