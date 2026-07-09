/* ============================================================
   Service Worker — Software Pro Store (javaweb.pro)

   MỤC TIÊU: người dùng KHÔNG cần xoá lịch sử/cache trình duyệt
   mỗi khi web được cập nhật nội dung mới.

   Cách làm:
   1. self.skipWaiting() — SW mới được kích hoạt NGAY khi cài xong,
      không phải chờ user đóng hết các tab đang mở.
   2. self.clients.claim() — SW mới chiếm quyền điều khiển các tab
      đang mở NGAY LẬP TỨC (không cần load lại thủ công).
   3. Chiến lược NETWORK-FIRST cho mọi request cùng domain:
      luôn thử lấy bản mới nhất từ server trước; chỉ dùng cache
      khi mất mạng (offline fallback). Vì vậy khi có mạng, người
      dùng luôn thấy đúng bản mới nhất — không bị "kẹt" ở bản cũ.
   4. Dọn sạch cache của các phiên bản SW cũ mỗi khi activate.

   LƯU Ý: chỉ cần đổi CACHE_VERSION khi bạn muốn ép buộc dọn sạch
   toàn bộ cache cũ (ví dụ đổi hẳn cấu trúc site) — bình thường
   KHÔNG cần đổi, vì network-first đã tự động lấy bản mới rồi.
============================================================ */

const CACHE_VERSION = "javawebpro-v2";
const RUNTIME_CACHE = CACHE_VERSION;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Chỉ can thiệp GET, và chỉ với tài nguyên cùng domain
  // (bỏ qua CDN ngoài, Google Drive, TikTok... để tránh lỗi CORS)
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request, { cache: "no-store" });
    if (fresh && fresh.status === 200) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Mất mạng -> dùng bản đã lưu trước đó (nếu có) để app vẫn chạy offline
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
