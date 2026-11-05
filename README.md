# Home Clean Makeover

Web remake (PixiJS + Spine) of the Unity game, created with GameKit. One folder = one game.

| Command | What it does |
|---|---|
| `npm install` | install the tool chain (Vite, TypeScript, PixiJS, Spine) |
| `npm run dev` | dev server on http://127.0.0.1:5210 (the GameKit preview runs this for you) |
| `npm run build` | type-check, then build `dist/` (index.html + assets + data) |
| `npm run typecheck` | type-check only |

Pages: `./` home · `?room=Kitchen` a room · `?level=L_Sink` one object · add `&debug=1` or `&auto=1` for testing.
See `CLAUDE.md` for how the engine and data are organised.

---

# Home Clean Makeover (Tiếng Việt)

Bản web (PixiJS + Spine) của game Unity, tạo bằng GameKit. Một thư mục = một game.

- `npm run dev` chạy server thử ở http://127.0.0.1:5210 (khung xem trước của GameKit tự chạy lệnh này).
- `npm run build` kiểm tra kiểu rồi build ra `dist/` (index.html + assets + data, không phải 1 file vì dữ liệu ~175 MB).
- Trang: `./` trang chủ · `?room=Kitchen` căn phòng · `?level=L_Sink` một món đồ · thêm `&debug=1` hoặc `&auto=1` để test.
- Nút 🛠 trong game mở bảng cheat (bỏ qua bước, nhảy bước, tự chơi, mở khoá, xoá tiến trình).
