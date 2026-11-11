# HTK Gateway — Cửa ngõ API có số liệu thật

Cấp API key, giới hạn token bucket theo key và endpoint, chặn hạn mức tháng, rồi hiển thị throughput, error rate và p95 trên cùng một dashboard — log ghi bất đồng bộ nên không nằm trên đường nóng.

## Demo

- Live: https://htk-api-gateway.vercel.app
- Tài khoản demo: `gateway@htk.dev` / `Demo12345!`
- API key demo: `htk_live_demo_orders_7f3a91c2` (chỉ dùng cho endpoint `orders` của workspace demo)
- Dữ liệu seed: 2 key (một đã thu hồi), 3 endpoint sandbox, 96 request log trong 14 phút gần nhất.

Chạy thử trong 3 bước:

```bash
npm install
npm run dev
# mở http://localhost:3000/login, bấm "Điền tài khoản demo" rồi đăng nhập
```

Gọi thử qua gateway:

```bash
curl -i -X POST http://localhost:3000/api/gw/orders \
  -H "Authorization: Bearer htk_live_demo_orders_7f3a91c2" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"A-1029","total":480000}'
```

## Bài toán

Một API công khai thường chết ở ba chỗ: key bị lộ vẫn dùng được mãi, client bắn quá nhanh làm sập backend, và không ai biết request nào chậm hay lỗi. Dựng một lớp cửa ngõ đủ nhỏ để đọc hết trong một buổi, nhưng đủ thật để thấy các đánh đổi: key lưu dạng hash, giới hạn hai tầng (burst và hạn mức tháng), log bất đồng bộ có hàng đợi giới hạn, và một dashboard đọc từ chính log đó.

## Tính năng

1. **API key một lần hiển thị** — secret `htk_live_<base64url>` chỉ trả về khi tạo; server lưu SHA-256, hiển thị 13 ký tự đầu để nhận diện. Thu hồi xoá cache ngay trên instance đang phục vụ nên request kế tiếp trả 401.
2. **Token bucket theo từng cặp key + endpoint** — capacity cho phép burst, refill mỗi giây cho tốc độ bền. Request bị từ chối không tiêu token, nên client backoff đúng một khoảng `retry-after` là gọi lại được. Header `x-ratelimit-limit/remaining/reset` trả về cả khi thành công lẫn khi 429.
3. **Hạn mức tháng theo UTC** — mỗi key có hạn mức riêng, cộng dồn theo kỳ `YYYY-MM`. Chạm hạn trả 429 `quota_exceeded` kèm `x-quota-remaining`, tách hẳn khỏi logic bucket.
4. **Log bất đồng bộ có giới hạn** — request đẩy vào buffer bộ nhớ (tối đa 8.000 dòng), flush theo lô 500 dòng, tối đa 20 lô mỗi lượt và tự hẹn lượt tiếp nếu còn tồn. Khi buffer đầy thì bỏ dòng cũ nhất và đếm vào `droppedLogs` hiển thị trên dashboard thay vì im lặng.
5. **Dashboard vận hành** — request/phút, RPS, error rate, p50/p95, biểu đồ 15 phút, quota từng key, top endpoint và 20 request gần nhất với status, latency, bucket còn lại, `x-request-id`.
6. **Upstream sandbox và live** — `sandbox://echo`, `sandbox://slow`, `sandbox://fail` để thử ngay không cần backend; live upstream bắt buộc HTTPS, chặn localhost và dải IP nội bộ, giới hạn body 128 KB, timeout 100–30.000 ms theo endpoint, không chuyển tiếp `Authorization`/`Cookie` của client.
7. **Workspace nhiều tài khoản** — key, endpoint và log tách theo user; đăng nhập scrypt + session httpOnly; rate limit cho login, đăng ký, tạo key và tạo endpoint.

## Tech stack và đánh đổi

- **Next.js 15 App Router + React 19 + TypeScript** — route `/api/gw/[slug]` là một catch-all nhận mọi method, UI và control plane trong cùng repo.
- **PGlite (PostgreSQL WASM) + Vercel Blob** — chạy PostgreSQL thật mà không cần dịch vụ ngoài; production lưu snapshot JSON vào Blob riêng tư và đồng bộ theo ETag, local dùng `./.data/pg`.
- **Token bucket và quota thuần TypeScript** — không Redis, không phụ thuộc mạng; logic nằm trong `lib/tokens.ts` và được test riêng.

Ba đánh đổi có chủ ý:

1. **Trạng thái giới hạn nằm trong bộ nhớ từng instance.** Với một instance, bucket chính xác tuyệt đối. Trên Vercel nhiều lambda, mỗi instance đếm riêng nên giới hạn thực tế có thể cao hơn cấu hình. Muốn chính xác toàn cụm phải thay bằng Redis hoặc token bucket phân tán; phần còn lại (key, endpoint, log, dashboard) giữ nguyên.
2. **Log bất đồng bộ đổi độ bền lấy throughput.** Đường nóng chỉ push vào mảng và trả response, nên p95 không phụ thuộc tốc độ ghi DB. Cái giá là một cửa sổ mất log khi instance bị kill trước lần flush; `droppedLogs` chỉ đếm phần bị đẩy khỏi buffer, không cứu được phần đã mất theo tiến trình.
3. **Quota ghi sau (write-behind).** Bộ đếm tháng cộng trong bộ nhớ rồi flush theo lô; snapshot có thể trễ vài giây. Đổi lại mỗi request không phải UPDATE một hàng, thứ sẽ thành điểm nghẽn ngay khi có burst.

## Chạy local

Yêu cầu Node.js 20+.

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 32 test
npm run build && npm start
```

Biến môi trường (xem `.env.example`):

| Biến | Ý nghĩa |
| --- | --- |
| `PGLITE_DIR` | Thư mục dữ liệu PGlite local, mặc định `./.data/pg` |
| `BLOB_READ_WRITE_TOKEN` | Token Blob riêng tư khi chạy trên Vercel; để trống ở local |

Docker:

```bash
docker build -t htk-api-gateway .
docker run -p 3000:3000 -v htk-gateway-data:/data htk-api-gateway
```

Deploy Vercel:

```bash
vercel link
vercel blob create-store htk-gateway-data --access private
vercel deploy --prod
```

Gắn `BLOB_READ_WRITE_TOKEN` của store vào project trước khi deploy production.

## Kiểm thử

`npm test` chạy 32 test, tất cả pass:

- **8 test token bucket và quota** — burst đúng capacity, refill theo thời gian, từ chối không tiêu token, retry-after, cost lớn hơn capacity, quota cuộn kỳ tháng, quota không âm.
- **8 test gateway** — băm key ổn định, sinh key đúng tiền tố, parse Bearer, chặn SSRF với localhost/IP nội bộ/http, chấp nhận HTTPS công khai, so khớp slug.
- **16 test tích hợp PGlite** — seed 2 key/3 endpoint/96 log, tạo key trả secret một lần, thu hồi key 401, tách dữ liệu giữa hai tài khoản, endpoint slug trùng trả 409, upstream không hợp lệ trả 400, metrics tính đúng p50/p95 và error rate, log bất đồng bộ flush vào DB, retention 3.000 dòng/user giữ log demo, hạn mức tháng chặn ở ngưỡng, rate limit.

## Metrics và đánh giá

Đo trên máy local (Windows, Node 24, `next start` production build):

| Phép đo | Kết quả |
| --- | --- |
| Tải 20.000 request, concurrency 200 | **1.009,6 req/s**, 19,81 giây, **0 lỗi** |
| Latency dưới tải | p50 **196,6 ms**, p95 **241,0 ms**, p99 **267,8 ms** |
| Log sau tải | 3.596 dòng, `droppedLogs = 0`, retention cắt về 3.000/user |
| Seed dashboard | 96 request/14 phút, 9 lỗi 503, 6 lần 429, top endpoint `orders` |
| Login sai liên tiếp | 10 × 401 rồi 2 × 429 |

Con số tải đến từ `scripts/stress.mjs`: script tự đăng ký user, tạo endpoint `stress-<timestamp>` và key riêng, chạy warmup 400 request rồi đo, sau đó thu hồi key và xoá endpoint. Không dùng chung key demo nên không làm bẩn dữ liệu mẫu. Đây là dev machine một instance; chưa đo trên Vercel với nhiều lambda, nơi giới hạn bucket là theo từng instance.

## Cấu trúc

```
app/
  api/gw/[slug]/  route catch-all nhận mọi method qua gateway
  api/            auth, me, keys, endpoints, metrics, health
  workspace/      dashboard vận hành
  login, register, landing
components/       AuthForm, Workspace (metrics, keys, endpoints, playground, logs)
lib/
  gateway.ts      runtime: cache key/endpoint, bucket, quota, log async, SSRF
  tokens.ts       token bucket và quota thuần, không I/O
  keys.ts         sinh key, băm SHA-256, parse Bearer
  data.ts         truy vấn workspace, CRUD key/endpoint, metrics
  db.ts           PGlite + Vercel Blob snapshot
  migrations.ts   schema từ số 0
scripts/stress.mjs tải thật, tự dọn dữ liệu
```

## Giới hạn đã biết

- Bucket và quota là bộ nhớ từng instance; nhiều lambda thì giới hạn hiệu dụng cao hơn cấu hình.
- Log async có thể mất tối đa một lô khi instance bị kill đột ngột.
- PGlite một writer; phù hợp demo và tải nhỏ, không phù hợp ghi đồng thời quy mô lớn.
- Chưa có OAuth cho control plane, chưa phân quyền nhiều vai trò.
- Rate limit theo instance, chưa dùng Redis dùng chung.
- Dashboard đọc log đã flush; request trong vài trăm ms gần nhất có thể chưa xuất hiện.

## Tác giả

HTK 0396241674 — dự án 09/10 trong portfolio full-stack.
