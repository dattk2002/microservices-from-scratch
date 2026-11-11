# 52 — Phân quyền theo quan hệ, nhóm lồng nhau và revision của policy

Yêu cầu Node.js 24.12+ và các gói phát triển đã cài ở gốc repo. Runtime chỉ dùng built-in; SQLite thuộc riêng policy. Không cần tài khoản hay mạng ngoài.

```sh
HOST=127.0.0.1 PORT=5252 DB_PATH=/tmp/lesson52.sqlite node lessons/52-relationship-authorization/policy.mts
HOST=127.0.0.1 PORT=5253 POLICY_ORIGIN=http://127.0.0.1:5252 node lessons/52-relationship-authorization/documents.mts
```

Mỗi lệnh chạy trong terminal riêng. PORT=0 chọn cổng tạm; dòng JSON `{service,port}` báo sẵn sàng. POLICY_ORIGIN được chốt khi khởi động documents. Đổi cổng policy cần khởi động lại documents. SIGTERM đóng listener và database. Import module không đọc cấu hình, mở database hay đăng ký signal.

## Mô hình và hợp đồng

Policy lưu tối đa 32 tuple hiện tại, không lưu lịch sử. Danh tính công khai cố định: alice, bob, carol; nhóm eng, ops, leads; tài liệu plan, runbook. Tuple gồm chính xác các trường cần thiết:

```json
{"objectType":"group","object":"eng","relation":"member","subjectType":"user","subject":"alice"}
```

Group chỉ nhận member; document chỉ nhận viewer/editor. Subject là user hoặc group thuộc miền tương ứng. Trường mở rộng không có ý nghĩa. Các trường bắt buộc phải đúng primitive, không ép kiểu. API này cố ý không xác thực: caller tự khai user. Chứng minh danh tính đáng tin cậy là điều kiện tiên quyết trước mọi triển khai thật; không đưa API admin này ra Internet.

POST /tuples nhận `{operation:"add"|"remove",tuple}`; trả 200 `{changed,revision}`. Tuple trùng hay xóa tuple vắng là no-op, không tăng revision. Thay đổi thật tăng global revision đúng một, từ 0 đến 64. Vượt revision hoặc thêm khi đã đủ 32 trả 409, không thay đổi gì. No-op vẫn hợp lệ khi chạm giới hạn. GET /state trả `{revision,tuples}`; thứ tự tăng theo khóa `JSON.stringify([objectType,object,relation,subjectType,subject])`, so sánh lexical.

POST /check nhận `{user,document,permission:"view"|"edit",minRevision?:number}`. Minimum mặc định 0, phải là safe integer 0..64. Minimum tương lai trả 409 ngay, không chờ. Trả 200 `{allowed,revision}` cho minimum đã có. Editor bao hàm view; viewer không cho edit. Không có grant trả false. Graph đi từ document qua các nhóm member đến user; visited set theo từng đường chặn chu trình, vẫn tìm nhánh khác tới user thật. Số đỉnh/tuple hữu hạn giới hạn công việc. Diamond không làm mất quyền; cycle tự nó không tạo quyền.

POST /read nhận `{user,document,minRevision?}`. Documents tự đặt permission=view và không nhận origin từ caller. Policy denial trả 403; future minimum trả 409; upstream lỗi/malformed/quá lớn/chậm/redirect trả 502. Chỉ khi allowed=true mới trả `{document,text,policyRevision}`. Nội dung hư cấu cố định chính xác:

- plan: `Kế hoạch giả tưởng: trồng cây trên Mặt Trăng.`
- runbook: `Sổ tay giả tưởng: kiểm tra đèn của trạm Mây.`

Mọi lỗi không kèm nội dung tài liệu. Body request tối đa 8192 byte qua helper chung. Payload tuple lớn nhất dù escape mọi ký tự ASCII bằng sáu byte vẫn dưới 1024 byte; check/read còn nhỏ hơn. Reply policy tối đa 1024 byte (decision thật dưới 40 byte), kể cả chunked. Một AbortSignal 700ms bao cả header và đọc body. redirect:error giữ nguyên biên origin; fixture redirect kiểm tra target không nhận request. Không có policy cache, controls runtime, credentials hay tích hợp auth ngoài.

## Thử bằng HTTP

```sh
curl -H 'content-type: application/json' localhost:5252/tuples -d '{"operation":"add","tuple":{"objectType":"group","object":"eng","relation":"member","subjectType":"user","subject":"alice"}}'
curl -H 'content-type: application/json' localhost:5252/tuples -d '{"operation":"add","tuple":{"objectType":"document","object":"plan","relation":"editor","subjectType":"group","subject":"eng"}}'
curl -H 'content-type: application/json' localhost:5253/read -d '{"user":"alice","document":"plan","minRevision":2}'
```

Xóa tuple member bằng operation=remove, rồi đọc tiếp với minRevision=3: nhận 403. Bob không có quyền ngay từ đầu. Restart policy với cùng DB_PATH giữ tuple và revision.

## Snapshot, giới hạn và TOCTOU

Mutation dùng BEGIN IMMEDIATE, kiểm tra giới hạn trước ghi, commit cả tuple lẫn revision. Check dùng một transaction đọc đồng bộ; revision và tuple thuộc cùng SQLite snapshot. Không có await trong các transaction. Mỗi quyết định gắn đúng revision đã đánh giá.

minRevision chỉ nói policy cục bộ này đã đạt ít nhất mốc đó; không cung cấp lịch sử ở mốc đó, không liên kết nhân quả toàn cục giữa nhiều vùng hay database. Sau quyết định cho phép, revoke có thể xảy ra trước khi bytes tài liệu tới caller: đây là TOCTOU. Revoke chặn lần đọc kế tiếp; không thu hồi tức thời một lần đọc đang bay. Đây không phải authentication, triển khai tương thích Zanzibar hay global causal consistency. Giới hạn 64 mutation cố ý giữ bài học hữu hạn; database mới là một demo mới, không phải cách reset an toàn trong production.

## Kiểm chứng và bài tập

```sh
npm run typecheck
npm run test:unit
node --test --test-isolation=none --test-name-pattern=unit: lessons/52-relationship-authorization/test/lesson.test.mts
node --test lessons/52-relationship-authorization/test/lesson.test.mts
npm run check
make test
git diff --check
```

Unit dùng SQLite memory: nhóm lồng nhau, diamond, cycle, implication, no-op, capacity, overflow, minimum và import inert. Integration dùng tiến trình Node độc lập, cổng tạm, database trong os.tmpdir(), deadline và finally cleanup; fixture upstream được tái sử dụng cho lỗi schema, size, delay và redirect. Fixture chỉ dành cho test, không phải entrypoint bài học. Worker không chạy HTTP trong sandbox không mạng; controller chạy suite thật trong Docker cô lập.

Bài tập: giải thích vì sao visited set toàn cục có thể khó suy luận hơn visited theo đường; thiết kế identity boundary đáng tin; phân tích tradeoff giữa check mỗi lần đọc và cache quyền; đề xuất giao thức khi cần đồng bộ revision qua nhiều policy replica mà không hứa instant revocation.

Tham khảo: [Zanzibar: Google’s Consistent, Global Authorization System](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/). Bài này chỉ minh họa quan hệ và revision cục bộ, không tái tạo hệ thống trong nghiên cứu.
