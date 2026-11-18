# 🦀 Đếm cua trong lỗ

Web game nhiều người chơi: bạn ngồi trên miệng hố, cua bò ra con nào bấm đếm con đó.
Mỗi người đếm mỗi con 1 lần, người khác vẫn đếm được con đó. Bảng xếp hạng hiện những người đang online.

## Chạy trên máy

Cần Node.js 18 trở lên. Không cần cài thêm thư viện.

```
node server.js
```

Mở http://localhost:3000. Mỗi tab trình duyệt là một người chơi.

## Đưa lên Render (miễn phí)

New → Web Service → chọn repo này, rồi điền:

- Build Command: `npm install`
- Start Command: `node server.js`
- Instance Type: Free

## Các file

| File | Việc |
| --- | --- |
| `server.js` | Thả cua, chấm điểm, bảng xếp hạng. Mục `CONFIG` ở đầu file chứa các con số của lối chơi |
| `public/game.js` | Vẽ hố và cua, xử lý cú bấm |
| `public/index.html` | Khung trang |
| `public/style.css` | Màu sắc, bố cục máy tính và điện thoại |
