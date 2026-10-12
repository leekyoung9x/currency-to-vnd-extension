# FIX-3: SỬA TRIỆT ĐỂ LỖI BẬT/TẮT EXTENSION TẠI TRANG (TOGGLE ON/OFF KHÔNG HOẠT ĐỘNG)

## 1. Vấn đề thực tế
Khi người dùng gạt nút switch Bật/Tắt trong Popup trên trang web, extension không tắt và không hoàn trả DOM về ban đầu.

## 2. Nguyên nhân cốt lõi đã phát hiện
1. **Lỗi nghiêm trọng trong `background.js`:**
   - Tại dòng 103 và 131: Gọi `store().then(function (area) { ... })`.
   - Trong Chrome, `chrome.storage.local` là một object `StorageArea`, **KHÔNG PHẢI Promise** (không có hàm `.then`).
   - Kết quả: Mỗi khi `background.js` nhận message `vnd:set-enabled`, nó văng exception: `TypeError: store(...).then is not a function`.
2. **Lỗi chuỗi trong `popup/popup.js`:**
   - Trong event handler `$('enabled').addEventListener('change', ...)`:
     Gọi `await chrome.runtime.sendMessage({ type: 'vnd:set-enabled', enabled: ... })`.
     Vì background văng lỗi, promise bị reject -> nhảy vào `catch (_) {}` -> dòng gọi `chrome.tabs.sendMessage(tab.id, { type: 'vnd:restore' })` phía sau **KHÔNG BAO GIỜ ĐƯỢC CHẠY**!
   - Popup không lưu trực tiếp vào `chrome.storage.local` nên storage `vnd_enabled` không hề đổi.
3. **Thiếu cập nhật trạng thái trong `content/content.js`:**
   - Khi nhận `vnd:restore`, content script chỉ gọi `restoreConverted(document)` nhưng **không gán `currentState.enabled = false`**.
   - Do đó, khi `MutationObserver` phát hiện DOM thay đổi lúc restore, nó tưởng extension vẫn đang bật và quét chuyển đổi ngược lại!

## 3. Các yêu cầu sửa đổi chi tiết
1. **Trong `background.js`:**
   - Sửa toàn bộ chỗ gọi `store().then(...)`. `store()` trả về `area` (hoặc null), dùng trực tiếp:
     ```js
     var area = store();
     if (!area) { sendResponse({ ok: false, error: 'no storage' }); return; }
     ```
   - Xử lý các message `vnd:get-state`, `vnd:set-enabled`, `vnd:set-mode`, `vnd:report-count` một cách an toàn không bị crash.
   - Khi nhận `vnd:set-enabled`:
     - Cập nhật `area.set({ [STORAGE_KEYS.ENABLED]: !!msg.enabled })`.
     - Đồng thời broadcast tới các tab đang mở:
       ```js
       if (chrome.tabs && chrome.tabs.query) {
         chrome.tabs.query({}, function (tabs) {
           (tabs || []).forEach(function (tab) {
             if (tab.id) {
               chrome.tabs.sendMessage(tab.id, {
                 type: msg.enabled ? 'vnd:rescan' : 'vnd:restore',
                 enabled: !!msg.enabled
               }).catch(function () {});
             }
           });
         });
       }
       ```
     - Nếu `msg.enabled === false`, xóa badge text trên extension action: `chrome.action.setBadgeText({ text: '' })`.
2. **Trong `popup/popup.js`:**
   - Trong sự kiện thay đổi của `$('enabled')`:
     - Lưu trực tiếp vào `chrome.storage.local`:
       `chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: isEnabled }).catch(() => null);`
     - Gửi message cho background (không block):
       `chrome.runtime.sendMessage({ type: 'vnd:set-enabled', enabled: isEnabled }).catch(() => null);`
     - Query active tab và gửi lệnh trực tiếp:
       `chrome.tabs.sendMessage(tab.id, { type: isEnabled ? 'vnd:rescan' : 'vnd:restore', enabled: isEnabled }).catch(() => null);`
     - Cập nhật hiển thị thống kê: nếu tắt, hiện `'Đã tắt extension trên trang'`.
3. **Trong `content/content.js`:**
   - Khi nhận message `vnd:restore`:
     - Gán `currentState.enabled = false`.
     - Gọi `restoreConverted(document)`.
     - Báo cáo số đếm về 0: `reportCount(0)`.
   - Khi nhận message `vnd:rescan`:
     - Cập nhật `currentState.enabled = msg.enabled !== false`.
     - Nếu `currentState.enabled === false`: gọi `restoreConverted(document); reportCount(0);`
     - Nếu `currentState.enabled === true`: gọi `restoreConverted(document); var r = scanAndConvert(document); reportCount(r.count);`
   - Trong `MutationObserver` (`scheduleRescan`): nếu `currentState.enabled === false` thì thoát ngay, không làm gì.
   - Trong `chrome.storage.onChanged`: khi `changes[STORAGE_KEYS.ENABLED]` đổi thành `false`, gọi `restoreConverted(document)` và `reportCount(0)`.
4. **Kiểm thử & Đóng gói:**
   - Viết test kiểm tra:
     - Tắt enabled -> `restoreConverted` phục hồi 100% DOM gốc.
     - Sau khi tắt, trigger DOM mutation không được phép tự động convert lại.
   - Đảm bảo toàn bộ test trong `node tests/run_all.mjs` PASS 100%.
   - Đóng gói lại `/home/thtung/Downloads/currency-to-vnd-extension.zip`.
