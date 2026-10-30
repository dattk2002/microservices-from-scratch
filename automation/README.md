# Vận hành lịch học Microservices

Chủ repo đã cho phép lịch09:15 Asia/Ho_Chi_Minh làm một bài tiếp theo trong
`curriculum.json`, có PR và squash merge sau test/review/CI đạt. Lộ trình hữu
hạn12 bài; không tự gia hạn, không tạo bài để đủ quota. Không sửa repo thuật toán
hoặc cron09:00. Máy tắt vào giờ chạy thì bỏ lỡ lượt đó, không chạy bù hàng loạt.

## Bản đã cài

```text
~/.local/share/microservices-from-scratch/daily.py
~/.local/share/microservices-from-scratch/checkout/
~/.local/share/microservices-from-scratch/state.json
~/.local/share/microservices-from-scratch/daily.log
```

Controller là bản đã review, **không tự cập nhật từ repo**. Máy cần Linux,
bubblewrap, Docker daemon, Node24/npm, Python, git, gh và Codex CLI0.165.0+
đã đăng nhập (cần hỗ trợ named permissions profiles).
Cron được cài PATH trỏ đến Node của máy; khi chuyển/xóa phiên bản Node cần cập
nhật PATH của job. Codex dùng đăng nhập ChatGPT hiện có và tiêu thụ hạn mức của
tài khoản; không cần đặt API key trong repo/crontab.

## Trình tự một lượt

1. Lấy khóa, kiểm tra trạng thái lần trước; thành công cùng ngày thì bỏ qua.
2. Xác minh tài khoản `dattk2002`, mọi fetch/push URL, checkout sạch và main
   đúng base mới fetch. Gặp bài dở/PR hằng ngày còn mở thì dừng.
3. Chọn một bài chưa làm. Worker chỉ thêm README/manifest/.mts trong thư mục
   mới, không thay package, workflow, bài cũ hay curriculum; có giới hạn file/byte.
4. Trước worker, controller chạy guard tests với cache Python riêng. Worker Codex
   chạy trong PID namespace; filesystem mặc định từ chối đọc, chỉ cấp đọc repo và
   toolchain, chỉ ghi thư mục bài mới. Repo còn được mount chỉ đọc ngoài thư mục
   đó; không thể cấy bytecode vào controller/tests. Công cụ không được đọc
   auth.json, cấu hình gh hay SSH, không có mạng và không nhận token qua env.
   TDD unit test không dùng socket; log được giới hạn ngay trong lúc chạy.
5. Controller chạy tsc + toàn bộ HTTP integration trong Docker
   non-root, source/root chỉ đọc, network none (loopback riêng), không home,
   token hoặc Docker socket, có giới hạn memory/CPU/PID. Container theo UUID được
   dọn trong finally nếu Docker CLI timeout; không dọn container của ứng dụng khác.
6. Codex read-only review thực tế file mới. Chưa được duyệt thì không publish.
7. Ghi state bền trước push/tạo PR/merge, chờ CI đúng head và base chưa đổi,
   squash giữ trailer `Co-authored-by: OpenAI Codex <codex@openai.com>`.
8. Xác minh PR thật sự MERGED rồi ghi thành công. Bất kỳ trạng thái dở/không
   chắc chắn nào cũng được giữ lại để kiểm tra, không tự phát lại thao tác ghi.

## Kiểm tra và dừng

```sh
python3 ~/.local/share/microservices-from-scratch/daily.py --check
crontab -l
```

`--check` không gọi Codex hoặc ghi GitHub; có thể tạo thư mục state/file khóa.
Nếu hôm nay đã hoàn tất, lệnh báo bỏ qua. Để dừng, dùng `crontab -e`, chỉ xóa dòng
có nhãn `microservices-from-scratch-daily`, giữ các job khác.

## Khi có lỗi

Đọc `daily.log`, `YYYY-MM-DD-implementation.log`, `YYYY-MM-DD-review.log`,
`YYYY-MM-DD-review.json` và `state.json`. Đối chiếu branch/PR/head/merge commit
trên GitHub trước khi quyết định tiếp tục. Không xóa state rồi chạy lại mù quáng,
không reset hard hoặc xóa bài dở. Base thay đổi, CI lỗi hay review từ chối đều
để nguyên công việc; sửa trong phiên có giám sát rồi mới khôi phục lịch.

Kiểm thử controller và runner từ repo:

```sh
make test
```

Hai test Docker thật kiểm tra source chỉ đọc/mạng ngoài bị chặn/loopback dùng
được và cleanup container khi timeout. Node HTTP tests chạy ở tiến trình riêng,
không phải chỉ kiểm tra mock của client.
