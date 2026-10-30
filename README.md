# microservices-from-scratch

Học Microservices từ nền tảng bằng **TypeScript/Node.js**, qua từng bài thực hành
chạy được, có kiểm thử tự động và giải thích tiếng Việt.

## Bắt đầu

- Node.js24.12+ thuộc nhánh24, npm, Python3.9+, Make.
- Docker đang chạy và tài khoản hiện tại dùng được Docker.
- Linux với bubblewrap và util-linux cho `make test`/lịch tự động; test dịch vụ chạy trong Docker.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check                 # Typecheck nghiêm ngặt + unit/HTTP integration
make test                     # Guard tests + tất cả bài trong Docker cô lập
```

Không có dependency runtime: dịch vụ dùng HTTP, fetch và test runner tích hợp.
TypeScript được **kiểm tra kiểu bằng tsc**, rồi Node chạy `.mts` bằng type stripping.

## Bài học

- [01 — Ranh giới dịch vụ và HTTP](lessons/01-service-boundaries-http/README.md)
- [Lộ trình hữu hạn12 bài](curriculum.json): hợp đồng API, dữ liệu riêng,
  deadline, idempotency, retry, circuit breaker, correlation log, gateway,
  graceful shutdown, outbox và saga. Bài hoàn chỉnh được thêm lần lượt trong `lessons/`.

Mỗi bài có `lesson.json`, mã nguồn, test gọi HTTP giữa các tiến trình thật,
hướng dẫn chạy, ví dụ, phân tích lỗi/đánh đổi và bài tự luyện. Không cần chạy
các bài trước để chạy một bài sau. Xem lịch sử PR để theo dõi từng phần thực hành.

## Chạy bài01 bằng Docker Compose

```sh
docker compose -f compose/01-service-boundaries.yaml up --build --wait
curl http://127.0.0.1:3101/products/pencil
curl -i http://127.0.0.1:3102/orders \
  -H 'Content-Type: application/json' \
  -d '{"productId":"pencil","quantity":2}'
docker compose -f compose/01-service-boundaries.yaml down
```

Catalog và Orders là hai container riêng. Chỉ mở cổng trên loopback của máy;
không có tài nguyên cloud hoặc dịch vụ trả phí. Bài01 lưu dữ liệu trong RAM,
chưa có lưu bền, xác thực hay idempotency; các bài sau giải quyết từng phần.

## Lịch học09:15

Lịch **09:15 Asia/Ho_Chi_Minh** dùng Codex đã đăng nhập để làm tối đa một bài
tiếp theo trong curriculum, chạy test cô lập, review độc lập, tạo PR, chờ CI
đúng commit rồi merge. Giữ trailer đồng tác giả Codex. Nếu có lỗi hoặc bài dở,
giữ nguyên công việc để kiểm tra; hết lộ trình thì dừng.

Máy cài lịch cần bật/có mạng, Docker chạy và Codex/GitHub CLI còn đăng nhập.
Lượt chạy dùng hạn mức Codex hiện có; không lưu token trong repo hoặc crontab.
Lịch mới độc lập với repo thuật toán lúc09:00; không chạy bù hàng loạt khi máy tắt.

Xem [vận hành, dừng lịch và khôi phục](automation/README.md).
