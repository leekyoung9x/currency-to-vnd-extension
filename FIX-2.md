# FIX-2: XÓA `default_locale` TRONG `manifest.json` ĐỂ KHẮC PHỤC LỖI LOAD TRÊN CHROME

## 1. Lỗi gặp phải khi người dùng nạp extension vào Chrome:
```
Failed to load extension
File: ~/Downloads/currency-to-vnd-extension
Error: Default locale was specified, but _locales subtree is missing.
Could not load manifest.
```

## 2. Nguyên nhân
- Trong `manifest.json` có khai báo `"default_locale": "en"`, nhưng thư mục `_locales/` không tồn tại (và extension không dùng hệ thống i18n/`__MSG_...__`).
- Theo quy định của Chrome MV3, khi có `"default_locale"` thì bắt buộc phải có thư mục `_locales/<default_locale>/messages.json`. Nếu không có, Chrome sẽ từ chối load manifest.

## 3. Việc cần làm
1. Trong `manifest.json`: Xóa trường `"default_locale": "en"`.
2. Chạy lại `npm test` hoặc `node tests/run_all.mjs` để đảm bảo 100% test PASS (56/56 tests).
3. Đóng gói lại file `/home/thtung/Downloads/currency-to-vnd-extension.zip`.
