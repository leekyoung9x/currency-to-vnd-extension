# FIX-1: CHUYỂN CONTENT SCRIPTS & SHARED SANG CHUẨN CLASSIC IIFE (CHỐNG LỖI CÚ PHÁP TRÊN CHROME MV3)

## 1. Vấn đề thực tế trên Chrome MV3
- Trong Chrome MV3, content scripts (`manifest.json` -> `content_scripts.js`) được Chrome thực thi ở dạng **Classic Scripts** (không phải ES Modules).
- Hiện tại `shared/currency.js`, `shared/rates.js`, và `content/content.js` đang dùng `import` và `export` tĩnh.
- Khi người dùng cài đặt extension unpacked trên Chrome thực tế, Chrome sẽ văng lỗi ngay:
  `Uncaught SyntaxError: Cannot use import statement outside a module`
  hoặc `Unexpected token 'export'`, khiến extension không thể chạy trên các tab trình duyệt.

## 2. Giải pháp kỹ thuật chuẩn
1. **Chuyển `shared/currency.js`, `shared/rates.js`, `content/content.js` sang UMD / IIFE pattern:**
   - Không dùng `import` hay `export` top-level trong 3 file này.
   - `shared/currency.js` đóng gói trong IIFE: gán đối tượng vào `globalThis.CurrencyUtils` (hoặc `root.CurrencyUtils`).
   - `shared/rates.js` đóng gói trong IIFE: gán đối tượng vào `globalThis.RateUtils` (hoặc `root.RateUtils`).
   - `content/content.js` đóng gói trong IIFE: đọc helpers từ `globalThis.CurrencyUtils` và `globalThis.RateUtils`, đồng thời xuất các hàm quét/restore vào `globalThis.CurrencyContent` để test suite và các trang có thể gọi.
2. **Cập nhật `background.js` & `manifest.json`:**
   - Trong `background.js`: Dùng `importScripts('shared/currency.js', 'shared/rates.js');` và truy xuất qua `self.CurrencyUtils`, `self.RateUtils`.
   - Trong `manifest.json`: background không cần `"type": "module"` nữa (hoặc giữ classic service worker chuẩn).
3. **Cập nhật các trang UI (`popup/popup.html`, `options/options.html`, `verify/verify.html`):**
   - Nạp theo thứ tự thẻ script:
     `<script src="../shared/currency.js"></script>`
     `<script src="../shared/rates.js"></script>`
     `<script src="popup.js"></script>` (hoặc options.js, verify.js).
   - Xóa bỏ `import ... from '../shared/...'` trong `popup.js`, `options.js`, `verify.js`, thay bằng việc đọc từ `window.CurrencyUtils` và `window.RateUtils`.
4. **Cập nhật bộ test (`tests/currency.test.mjs`, `tests/dom_scan.test.mjs`):**
   - Đọc nội dung file bằng `fs.readFileSync` và nạp vào global scope qua `(0, eval)(...)` hoặc `vm.runInThisContext`.
   - Đảm bảo toàn bộ logic test không bị suy giảm.
   - Thêm test static assertion: `assert(!/^import\s+/m.test(contentJs))` và `assert(!/^export\s+/m.test(contentJs))` để chứng minh không còn ESM keyword trong content scripts.

## 3. Tiêu chí nghiệm thu
- `node tests/run_all.mjs` đạt 100% PASS, exit code 0.
- Không còn bất kỳ từ khóa `import ` hay `export ` top-level nào trong `content/content.js`, `shared/currency.js`, `shared/rates.js`.
