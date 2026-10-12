# BRIEF DỰ ÁN: CHROME MV3 EXTENSION QUY ĐỔI TIỀN TỆ SANG VND CHUẨN

## 1. Thông tin chung
- Thư mục làm việc: `/home/thtung/Downloads/currency-to-vnd-extension`
- Mục tiêu: Xây dựng hoàn chỉnh Chrome Extension Manifest V3 (MV3) tự động quét giao diện trang web, đọc tất cả các loại tiền tệ nước ngoài (USD, EUR, GBP, JPY, CNY, KRW...) và quy đổi sang chuẩn Việt Nam Đồng (VND).
- Fixture test thực tế đã có sẵn tại: `fixtures/Usage_logs_Dashboard_InferHub.html` (chính là trang dashboard log API thực tế của người dùng với các dạng giá tiền: `$3.30`, `$0.0889`, micro-cost `$0.000021`, rate input/output `$0.070/$0.350`, v.v.).

## 2. Cấu trúc tệp cần tạo và bàn giao
```
currency-to-vnd-extension/
├── manifest.json              # Chrome MV3 manifest (permissions, host_permissions, content_scripts, action, background)
├── background.js              # Service worker: quản lý tỷ giá, fetch live rate, storage cache, badge
├── shared/
│   ├── currency.js            # Pure functions: regex nhận diện, parse số tiền, tính toán, format VND chuẩn
│   └── rates.js               # Quản lý tỷ giá offline mặc định & fetch online
├── content/
│   ├── content.js             # Quét DOM, TreeWalker, xử lý text node, MutationObserver, toggle mode, restore
│   └── content.css            # Style cho thẻ VND kèm theo, tooltip hover, highlight
├── popup/
│   ├── popup.html             # Giao diện popup rộng rãi (>= 440px), giao diện hiện đại, rõ ràng
│   ├── popup.css              # Style popup
│   └── popup.js               # Logic điều khiển: switch On/Off, chọn Display Mode, xem/sửa tỷ giá, thống kê node đã convert
├── options/
│   ├── options.html           # Trang cài đặt chi tiết
│   ├── options.css
│   └── options.js
├── verify/
│   ├── verify.html            # Trang web tự kiểm tra độc lập (standalone self-check) với các mẫu tiền tệ đa dạng
│   └── verify.js              # Script tự kiểm tra & in kết quả đo kiểm
├── fixtures/
│   └── Usage_logs_Dashboard_InferHub.html # DOM thật của người dùng
└── tests/
    ├── currency.test.mjs      # Unit test cho hàm parse, regex, convert, format
    ├── dom_scan.test.mjs      # Integration test dùng JSDOM quét DOM thật trên fixture InferHub
    └── run_all.mjs            # Runner chạy toàn bộ test, in bảng đo kiểm chuẩn và exit != 0 nếu có lỗi
```

## 3. Đặc tả chi tiết từng chức năng

### 3.1. Nhận diện và quy đổi tiền tệ (`shared/currency.js`)
1. **Ký hiệu tiền tệ hỗ trợ:**
   - Ký hiệu: `$`, `€`, `£`, `¥` (JPY/CNY), `₩` (KRW), `C$`, `A$`, `AU$`, `S$`, `₹`, `฿`, `NT$`, `HK$`...
   - Mã ISO: `USD`, `EUR`, `GBP`, `JPY`, `CNY`, `KRW`, `CAD`, `AUD`, `SGD`, `INR`, `THB`, `TWD`, `HKD`... (hỗ trợ cả đứng trước và đứng sau: `$10`, `10 USD`, `USD 10`, `€15.5`, `15.5 EUR`).
2. **Các dạng đặc biệt trên dashboard/bảng giá:**
   - Dạng kép/tỷ lệ token: `$0.070/$0.350` hoặc `$0.020 / $0.100` -> Phải nhận diện và quy đổi cả 2 vế.
   - Dạng khoảng (range): `$10 - $20` hoặc `$10 ~ $20`.
   - Tiền âm hoặc có tiền tố: `-$3.30`, `+$10.00`, `~$5.00`.
   - Dấu phân cách số: hỗ trợ chuẩn US (`1,234.56`) và EU (`1.234,56`).
3. **Format VND chuẩn (RẤT QUAN TRỌNG VỚI AI LOGS):**
   - Tỷ giá mặc định USD: `26,000` VND.
   - Với số tiền thông thường (VND >= 100): định dạng dấu chấm phân cách hàng nghìn, kết thúc bằng `₫` (hoặc `đ`, `VNĐ`). Ví dụ: `$3.30` * 26000 = `85.800 ₫`.
   - Với số tiền nhỏ từ 1 đến < 100 VND: giữ 1-2 chữ số thập phân (dấu phẩy hoặc chấm). Ví dụ: `14,50 ₫`.
   - **Với micro-cents (< 1 VND) như `$0.000021`:**
     - `$0.000021` * 26000 = `0.546 ₫` -> Format thành `0,55 ₫` (hoặc `0,546 ₫`).
     - **Tuyệt đối KHÔNG làm tròn thành `0 ₫`** vì trên log AI, chi phí micro-requests rất quan trọng!

### 3.2. Chế độ hiển thị trên trang (`content/content.js` & `content/content.css`)
Cung cấp 3 chế độ (lưu vào `chrome.storage.local`, mặc định là Mode 1):
1. **Mode 1 - Kèm theo (Append/Beside - Mặc định):**
   - Giữ nguyên số tiền gốc, chèn thêm giá trị VND bên cạnh trong thẻ badge nhỏ hoặc dấu ngoặc.
   - Ví dụ: `$3.30` -> `$3.30 (≈ 85.800 ₫)` hoặc `$0.000021 (≈ 0,55 ₫)`.
2. **Mode 2 - Thay thế trực tiếp (Replace):**
   - Thay thế số tiền gốc bằng VND (ví dụ `85.800 ₫`).
   - Có style gạch chân mờ (dashed border-bottom). Khi người dùng rê chuột vào (hover), hiển thị tooltip chứa giá tiền gốc ban đầu (`Gốc: $3.30`).
3. **Mode 3 - Tooltip khi hover (Hover only):**
   - Giữ nguyên giao diện 100% không làm xô lệch bất kỳ layout nào.
   - Khi rê chuột vào số tiền, hiển thị tooltip nổi đẹp mắt: `≈ 85.800 ₫ (Tỷ giá: 26.000)`.

### 3.3. Xử lý DOM & Hiệu năng
- Dùng `TreeWalker` (lọc `NodeFilter.SHOW_TEXT`) để duyệt text nodes.
- **Bỏ qua các thẻ cấm:** `SCRIPT`, `STYLE`, `NOSCRIPT`, `TEXTAREA`, `INPUT`, `CODE`, `PRE`, hoặc phần tử có thuộc tính `contenteditable="true"` / `isContentEditable`.
- Đánh dấu các phần tử đã xử lý bằng class/attribute (ví dụ `class="vnd-converted"` hoặc `data-vnd-converted="true"`, lưu `data-original-text`) để:
  - Tránh lặp vô tận (infinite loop).
  - Có thể hoàn nguyên (restore) 100% DOM gốc khi người dùng tắt extension hoặc chuyển mode.
- Dùng `MutationObserver` có debounce (~200ms) để tự động quét các phần tử mới xuất hiện khi người dùng cuộn trang, chuyển trang phân trang (pagination), SPA routing.

### 3.4. Quản lý tỷ giá (`background.js` & `shared/rates.js`)
- Tỷ giá offline tích hợp sẵn:
  - USD: 26,000
  - EUR: 28,200
  - GBP: 33,000
  - JPY: 175
  - CNY: 3,600
  - KRW: 19
  - AUD: 17,200
  - CAD: 19,000
  - SGD: 19,800
  - THB: 750
- Service worker định kỳ hoặc khi người dùng bấm nút sẽ fetch tỷ giá online mới nhất từ API miễn phí (ví dụ `https://open.er-api.com/v6/latest/USD`), cập nhật vào storage.
- Cho phép người dùng tự nhập tỷ giá tùy chỉnh trong Popup/Options (override).

### 3.5. Giao diện Popup & Options (`popup/`, `options/`)
- Tuân thủ gu thiết kế: rộng rãi (chiều rộng tối thiểu 440px), font chữ rõ ràng (>= 13px), padding thoáng đãng.
- Công tắc bật/tắt tiện ích toàn trang.
- Lựa chọn 3 chế độ hiển thị (Radio buttons hoặc pills).
- Hiển thị tỷ giá hiện tại kèm thời gian cập nhật, nút "Cập nhật online", ô cho phép tự nhập tỷ giá theo ý muốn.
- Badge / Dòng thống kê số lượng giá tiền đã quét và quy đổi trên tab hiện tại (VD: "Đã quy đổi 89 giá tiền trên trang này").
- Nút "Quét lại trang" (Re-scan).

### 3.6. Bộ Test Suite Chặt Chẽ (Gate 1)
1. `tests/currency.test.mjs`:
   - Test parse đầy đủ các dạng: `$3.30`, `$0.0889`, micro `$0.000021`, rate `$0.070/$0.350`, `15.50 EUR`, `100 JPY`, âm `-$5`.
   - Test format VND: chuẩn dấu chấm, micro < 1đ không bị về 0.
2. `tests/dom_scan.test.mjs`:
   - Đọc DOM thật từ `fixtures/Usage_logs_Dashboard_InferHub.html` qua `jsdom`.
   - Chạy hàm quét và chuyển đổi.
   - Đo số lượng node tiền tệ được chuyển đổi: phải đạt >= 80 điểm tiền tệ trên fixture thật.
   - Kiểm tra kết quả chuyển đổi trên các node cụ thể: `$3.30` -> `85.800 ₫`, `$0.000021` -> `0,55 ₫`, v.v.
   - Kiểm tra hàm `restore` khôi phục lại đúng DOM gốc.
3. `tests/run_all.mjs`:
   - In bảng kết quả: `TEST | EXPECTED | ACTUAL | PASS/FAIL`.
   - Thoát với exit code `0` khi 100% test PASS, exit code `1` nếu có bất kỳ FAIL nào.

## 4. Yêu cầu nghiệm thu (Acceptance Criteria)
1. Tất cả các file trong cấu trúc mục 2 phải được tạo đầy đủ, không thiếu file nào.
2. Bộ test chạy bằng lệnh `npm test` hoặc `node tests/run_all.mjs` phải PASS 100% với exit code 0.
3. Chạy kiểm tra thực tế trên fixture `Usage_logs_Dashboard_InferHub.html` phát hiện và quy đổi đúng toàn bộ các giá tiền.
