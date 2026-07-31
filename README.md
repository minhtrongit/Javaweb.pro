# Hồ sơ Hộ gia đình BHXH — Tra cứu dữ liệu (.db)

Ứng dụng web tĩnh (không cần backend) để nạp, tìm kiếm, lọc và đối chiếu dữ liệu hộ gia đình BHXH từ file SQLite `.db`, chạy hoàn toàn trên trình duyệt.

## Cấu trúc thư mục

```
.
├── index.html          # Khung giao diện (HTML thuần)
├── css/
│   └── style.css       # Toàn bộ style/giao diện
├── js/
│   └── app.js           # Toàn bộ logic (đọc .db bằng sql.js, tìm kiếm, lọc, đối chiếu Excel...)
└── DLHGDCV93.db         # (tuỳ chọn) đặt cùng thư mục để trang tự động nạp khi mở
```

Các thư viện ngoài (sql.js, xlsx.js) vẫn được tải qua CDN trong `index.html`, không cần cài đặt gì thêm.

## ⚠️ Vì sao chỉ tải mỗi `index.html` về máy sẽ KHÔNG chạy được?

Sau khi tách file, `index.html` **chỉ là bộ khung** — nó tham chiếu tới:

```html
<link rel="stylesheet" href="css/style.css">
...
<script src="js/app.js"></script>
```

Nếu chỉ tải/copy riêng `index.html` mà thiếu 2 file `css/style.css` và `js/app.js` (đặt đúng cấu trúc thư mục ở trên), trang sẽ mất giao diện và không có logic nào chạy — vì trình duyệt không tìm thấy các file đó.

➡️ **Muốn dùng, phải tải/clone nguyên cả bộ 3 file + đúng cấu trúc thư mục** (`index.html`, `css/style.css`, `js/app.js`), không thể tách rời `index.html` ra dùng một mình.

Ngoài ra, do trang dùng `fetch()` để tự động nạp `DLHGDCV93.db`, nếu mở trực tiếp bằng cách double-click file (`file://...`) trên Chrome/Edge, tính năng tự nạp file mặc định có thể bị chặn bởi trình duyệt (CORS). Khi đó dùng nút **"Chọn file dữ liệu"** trong trang để chọn file `.db` thủ công, hoặc chạy qua một web server cục bộ / GitHub Pages (xem bên dưới).

## ✅ Cách chạy

### Cách 1 — Đưa lên GitHub Pages (khuyến nghị)
1. Tạo repository mới trên GitHub, đẩy (push) toàn bộ nội dung thư mục này lên (giữ nguyên cấu trúc `index.html`, `css/`, `js/`).
2. Vào **Settings → Pages**, chọn nhánh (branch) chứa code (thường là `main`) và thư mục gốc (`/root`).
3. GitHub sẽ cấp một đường dẫn dạng `https://<username>.github.io/<repo>/` — mở link đó là dùng được ngay, kể cả tính năng tự nạp `DLHGDCV93.db` nếu bạn có đưa file này lên cùng repo.

### Cách 2 — Chạy local qua web server đơn giản
Mở terminal tại thư mục này rồi chạy (cần có Python):
```bash
python3 -m http.server 8000
```
Sau đó mở trình duyệt vào `http://localhost:8000`.

### Cách 3 — Mở trực tiếp bằng file:// 
Vẫn mở được `index.html` bằng cách double-click, giao diện/CSS/JS vẫn tải bình thường (vì đây là các thẻ `<link>`/`<script src>` thông thường, không bị chặn bởi CORS) — chỉ riêng tính năng **tự động nạp `DLHGDCV93.db`** có thể không hoạt động; khi đó hãy dùng nút "Chọn file dữ liệu" để chọn file `.db` thủ công.

## Toàn bộ dữ liệu được xử lý ngay trên trình duyệt của người dùng, không tải lên server nào.
