# FIX-5: Giá tiền trong bảng không chuyển đổi (số tiền bị xé thành nhiều text node + bản sao `sr-only`)

## 1. Vấn đề người dùng phản ánh
> "hiện nó đang k chuyển đổi được giá tiền các cột trong table trong khi credit lại được"
> — https://www.surplusintelligence.ai/app/activity/requests?side=bought&range=30d

Các cột `INPUT PRICE/M`, `OUTPUT PRICE/M`, `COST` giữ nguyên `$0.003375`… trong khi số Credit trên header chuyển đổi bình thường.

## 2. Nguyên nhân cốt lõi (đã kiểm chứng từ bundle thật của trang)

Bundle `app/(shell)/activity/requests/page-374ecca9f6c4907c.js` của Surplus, component render tiền (`function ev` / `ej`):

```jsx
<>
  <span class="sr-only">$0.003375</span>               {/* bản sao cho screen-reader, ẩn thị giác */}
  <span aria-hidden="true" class="select-none">        {/* bản hiển thị thật */}
    {lead && <span class="invisible">…</span>}          {/* padding căn cột số */}
    {prefix}{"$"}
    {commaPad && <span class="invisible">,</span>}      {/* padding dấu phẩy */}
    {intPad}{int}{"."}{frac}{fracPad}                   {/* mỗi mảnh = 1 text node riêng */}
  </span>
</>
```

Extension quét **từng text node độc lập** (`collectTextNodes` + regex trên `nodeValue`), nên:

1. **Số tiền hiển thị bị xé vụn** thành các text node `"$"`, `"0"`, `"."`, `"003375"` (React tạo 1 text node cho mỗi biểu thức trong mảng children) xen span `invisible` → không node nào chứa đủ `"$0.003375"` → regex không match → bảng không đổi.
2. **Text node duy nhất chứa đủ chuỗi lại nằm trong `span.sr-only`** (Tailwind: `position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0)`) → extension *có* chuyển đổi được nhưng chèn badge vào vùng vô hình → người dùng không thấy gì. Đếm `count` vẫn tăng nên nhìn từ popup tưởng đã chạy.
3. **Credit** render nguyên chuỗi trong 1 text node hiển thị (component khác) → match bình thường.

Pattern "bản sao `sr-only` + bản hiển thị `aria-hidden` bị xé node để căn cột" rất phổ biến ở dashboard React hiện đại — đây là lỗi tổng quát, không riêng Surplus.

## 3. Cách khắc phục (chỉ sửa `content/content.js`)

1. **Bỏ qua phần tử ẩn thị giác** — `isVisuallyHiddenEl()`: class `sr-only` / `visually-hidden` / `visuallyhidden` / `screen-reader-only`, thuộc tính `hidden`, inline `display:none`. `isSkipped()` dùng nó khi duyệt tổ tiên → không còn chèn badge vào bản sao a11y.
   - `aria-hidden` **không** bị coi là ẩn: pattern này đánh dấu chính bản *hiển thị* là `aria-hidden="true"`.
2. **Pass 2 — gộp node kề nhau** (`scanSplitAmounts()`), chạy sau pass text-node trong `scanAndConvert()`:
   - Với mỗi phần tử ứng viên (2–24 child node, có text node trực tiếp): dựng các "run" gồm text node + phần tử inline lá (`SPAN/B/I/EM/STRONG…`) kề nhau; comment node của React trong suốt; phần tử `invisible`/`visibility:hidden` (padding) giữ vị trí nhưng đóng góp `''`.
   - Match regex trên chuỗi đã gộp; chỉ nhận match **trải qua ≥ 2 node** (match trong 1 node là việc của pass 1) → tránh đếm trùng.
   - Giới hạn an toàn: chuỗi gộp ≤ 120 ký tự, phải chứa ký hiệu/mã tiền tệ.
3. **Áp dụng theo mode, tối thiểu xâm lấn DOM gốc:**
   - `append`: **không đụng vào node gốc** — chỉ chèn badge/subline (`data-vnd-inserted="1"`) ngay sau node cuối của match, đánh dấu parent `data-vnd-converted="cluster"`. Trong bảng + table-safe → subline như FIX-4.
   - `hover`: bọc đúng dãy node của match vào wrapper `data-vnd-unwrap="1"`; restore unwrap trả lại nguyên văn.
   - `replace`: bọc wrapper như `convertTextNode`, lưu chuỗi hiển thị đã gộp để restore.
4. **`restoreConverted()`** thêm 2 nhánh: `cluster` (gỡ node đã chèn + gỡ mark) và unwrap (tháo `.vnd-hover` trong rồi wrapper ngoài) → restore trả DOM về **nguyên trạng byte-for-byte** với mode `append`/`hover`.

## 4. Kiểm thử

- Fixture mới `fixtures/Surplus_Requests.html`: mô phỏng đúng DOM bảng Surplus (bản sao `sr-only` + bản hiển thị xé node bằng `<!-- -->` + padding `invisible`, kèm Credit 1-node làm đối chứng).
- Test mới `tests/split_nodes.test.mjs` (21 test): chuyển đổi đủ 6 ô giá, subline nằm ở span hiển thị, 0 badge trong `sr-only`, padding `invisible` không lọt vào số, cả 3 mode, rescan idempotent, restore byte-for-byte.
- Toàn bộ suite: **139/139 PASS** (118 test cũ không vỡ).
- Dọn kèm: repo từng commit symlink `node_modules` trỏ vào máy cá nhân (chết trên máy khác) → gỡ khỏi git, khai báo `jsdom` vào `devDependencies` để `npm i && npm test` chạy được ở bất cứ đâu.

## 5. Giới hạn còn lại

- Nếu site tự re-render *tại chỗ* các text node đã đánh dấu `cluster` (đổi giá trị nhưng giữ nguyên phần tử cha), badge cũ không tự cập nhật — cùng giới hạn sẵn có của pass 1. Phân trang/thay hàng (thay cả DOM) thì MutationObserver quét lại bình thường.
- Phát hiện ẩn dựa vào class/inline-style (không dùng `getComputedStyle` ở hot path vì chi phí): site tự chế class ẩn không theo chuẩn Tailwind/Bootstrap có thể lọt — khi đó pass 2 vẫn xử lý được nếu số tiền bị xé node.
