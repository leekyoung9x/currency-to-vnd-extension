# FIX-4: Khắc phục triệt để xô lệch UI và đè mất thông tin trong bảng (Table-Safe Layout & Anti-Clipping)

## 1. Vấn đề người dùng phản ánh
> "với cái extension làm xô hỏng UI màn đè mất 1 số thông tin trong bảng làm mất thông tin đó luôn"

Kèm tài liệu thực tế: `Budgets_InferHub.html` (trang quản lý budget mô hình của InferHub) và `Usage_logs_Dashboard_InferHub.html`.

## 2. Phân tích nguyên nhân cốt lõi (Root Causes)
1. **Phình ngang dữ liệu trong bảng (`whitespace-nowrap`)**:
   - Ở chế độ `append`, extension chèn badge dạng pill ` (≈ 260.000 ₫)` ngay cạnh mỗi số tiền.
   - Trong bảng tính (`Budgets_InferHub.html`), các cột như `Official in/out` (`$10 / $50`) và `Cap in/out` (`$0.01<br>$0.05`, `floor $0.018 / $0.09`, `$0.435–$1.74 / $0.87–$3.48`) có class Tailwind `whitespace-nowrap`.
   - Chuỗi gốc chỉ 9–15 ký tự nhưng sau khi chèn 2 đến 4 badge to (với padding, margin) thì phình lên 40–80 ký tự (tăng 400%–500% chiều rộng).
   - Vì bảng nằm trong container `<div class="overflow-x-auto">` và cột `Max discount` có độ rộng `w-[42%]`:
     + Khi các cột tiền tệ phình to, cột `Max discount` bị bóp nghẹt khiến thanh trượt (slider), biểu đồ SVG và ô nhập `% off` bị đè bẹp, xô lệch lên nhau.
     + Các cột bên phải ngoài cùng (cột `Cap in/out` và đặc biệt là cột nút hành động `Save` / `Clear`) bị đẩy văng ra ngoài khung nhìn (bị tràn vào vùng scroll ngang). Người dùng không nhìn thấy nút Save/Clear nữa và tưởng rằng "bị đè mất làm mất thông tin đó luôn".
2. **Chèn badge rời rạc phá vỡ cấu trúc cụm tiền tệ**:
   - Với cặp giá token dạng `$10 / $50` hay khoảng giá `$0.435–$1.74 / $0.87–$3.48`, extension chèn badge vào giữa dấu gạch chéo `/` và gạch ngang `–`, biến thành `$10 (≈ 260.000 ₫) / $50 (≈ 1.300.000 ₫)`. Chuỗi bị xé vụn và tăng kích thước bất thường.
3. **Đội chiều cao hàng (Line-height inflation)**:
   - `.vnd-badge` có `line-height: 1.5; padding: 1px 7px;` làm chiều cao dòng của ô `<td>` tăng vọt, làm các ô có `align-middle` bên cạnh bị giật vị trí theo chiều dọc.
4. **Không tương thích Dark Mode**:
   - `.vnd-badge` dùng màu cứng `#e6f4f1` và viền `#bfe3dd` gây chói mắt trên giao diện tối (Dark mode) của InferHub (`bg-zinc-950`).
5. **Chế độ hiển thị mặc định chưa tối ưu cho bảng biểu**:
   - `append` là chế độ dễ gây vỡ layout nhất trên các dashboard phức tạp nếu không có cơ chế `Table-Safe`. Chế độ `hover` (tooltip) hoặc `replace` (thay thế trực tiếp) an toàn hơn rất nhiều cho bảng tính vì không làm thay đổi kích thước ô.

---

## 3. Yêu cầu kỹ thuật chi tiết

### A. Cơ chế Table-Safe thông minh trong `content/content.js`
1. **Nhận diện ngữ cảnh bảng (`isInsideTable`)**:
   - Kiểm tra xem text node cần chuyển đổi có nằm trong `<td>`, `<th>`, `[role="cell"]`, `[role="gridcell"]`, `[role="row"]`, hoặc phần tử con của `table` hay không.
2. **Xử lý hiển thị an toàn trong bảng khi ở chế độ `append`**:
   - **Tùy chọn A (Subline / Dòng phụ không giãn ngang cột)**: Trong ô `<td>` / `<th>`:
     - Thay vì chèn badge inline to bè làm giãn chiều ngang, đặt giá trị quy đổi thành dòng phụ nhỏ gọn bên dưới:
       `<span class="vnd-subline">≈ 260.000 ₫</span>` (hoặc `≈ 260k / 1.3M ₫` cho cặp giá).
       Với CSS: `display: block; font-size: 0.75em; line-height: 1.2; opacity: 0.85; margin-top: 1px; white-space: normal;`.
       Dòng phụ này xuống dòng tự nhiên, **giữ nguyên 100% chiều rộng của cột ban đầu**, không đẩy các cột bên cạnh và không đẩy nút Save/Clear ra ngoài màn hình!
   - **Gộp cụm tiền tệ (Compound currency handling)**:
     - Khi trong một text node có dạng cặp `$A / $B` hoặc khoảng `$A–$B`:
       Không chèn badge chen giữa dấu `/` hay `–`. Gom lại thành 1 nhãn quy đổi duy nhất ở cuối hoặc phía dưới: ví dụ `$10 / $50` kèm `(≈ 260k / 1.3M ₫)` hoặc `≈ 260.000 / 1.300.000 ₫`.
3. **Bảo vệ các phần tử có `truncate` / `overflow: hidden`**:
   - Với các thẻ có class `truncate` hoặc style `overflow: hidden`: Dùng badge siêu nhỏ gọn hoặc fallback sang tooltip hover để không làm thẻ bị cắt ngắn hiển thị dấu `...`.

### B. Nâng cấp CSS trong `content/content.css`
1. Cấu trúc `.vnd-badge` gọn gàng hơn:
   - Giảm padding: `padding: 0 5px;`
   - Font-size vừa vặn: `font-size: 0.8em;`
   - `line-height: normal;` để không làm đội chiều cao hàng table.
2. Thêm class `.vnd-subline` chuyên dụng cho bảng:
   ```css
   .vnd-subline {
     display: block;
     font-size: 0.75em;
     line-height: 1.2;
     color: #0b6b5f;
     font-weight: 500;
     margin-top: 1px;
     white-space: normal;
   }
   ```
3. Hỗ trợ toàn diện **Dark Mode**:
   ```css
   @media (prefers-color-scheme: dark) {
     .vnd-badge {
       background: rgba(16, 185, 129, 0.18);
       color: #34d399;
       border-color: rgba(16, 185, 129, 0.35);
     }
     .vnd-subline {
       color: #34d399;
     }
     .vnd-replace {
       color: #34d399;
     }
   }
   .dark .vnd-badge, [data-theme="dark"] .vnd-badge {
     background: rgba(16, 185, 129, 0.18);
     color: #34d399;
     border-color: rgba(16, 185, 129, 0.35);
   }
   .dark .vnd-subline, [data-theme="dark"] .vnd-subline {
     color: #34d399;
   }
   .dark .vnd-replace, [data-theme="dark"] .vnd-replace {
     color: #34d399;
   }
   ```
4. Tooltip hover (`.vnd-hover`):
   - Đảm bảo tooltip không bị che khuất bởi các container có `overflow-x-auto`.

### C. Nâng cấp Popup (`popup/popup.html`, `popup/popup.js`, `background.js`)
1. Thêm tùy chọn toggle: **"Bảo vệ bảng (Table-safe mode)"** (mặc định: `true`, lưu vào storage `vnd_table_safe`).
   - Khi bật (mặc định): Tự động áp dụng cơ chế không làm giãn cột trong mọi bảng tính.
2. Cập nhật giải thích rõ ràng cho 3 chế độ trong popup để người dùng hiểu:
   - `hover`: **Tooltip khi hover** — *Giữ nguyên 100% layout gốc (khuyên dùng cho bảng tính, dashboard)*.
   - `replace`: **Thay thế trực tiếp** — *Gọn gàng, rê chuột xem giá gốc*.
   - `append`: **Kèm theo (Table-safe)** — *Hiện song song, tối ưu không vỡ cột*.

### D. Kiểm thử tự động (Test Suite)
1. Thêm fixture `fixtures/Budgets_InferHub.html` vào bộ test.
2. Tạo test `tests/layout_safety.test.mjs`:
   - Quét `Budgets_InferHub.html` ở chế độ `append`: kiểm tra chiều rộng/số ký tự các cột trong bảng không bị phình to làm vỡ layout, các nút Save/Clear không bị mất.
   - Quét `Budgets_InferHub.html` ở chế độ `replace` và `hover`.
   - Kiểm tra `restoreConverted`: khôi phục sạch 100% DOM gốc ban đầu sau khi quét trên fixture `Budgets_InferHub.html`.
3. Tích hợp vào `tests/run_all.mjs`, đảm bảo **100% test PASS** (toàn bộ test cũ + test mới).
4. Đóng gói lại `currency-to-vnd-extension.zip`.
