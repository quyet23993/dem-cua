/**
 * ĐẾM CUA TRONG LỖ — máy chủ (server)
 * ------------------------------------------------------------
 * Chạy:  node server.js    rồi mở trình duyệt vào http://localhost:3000
 *
 * Không cần cài thêm thư viện nào: file này chỉ dùng các mô-đun
 * có sẵn trong Node.js (http, fs, path, crypto, os).
 *
 * Server làm 4 việc:
 *   1. Phát các file giao diện trong thư mục public/ cho trình duyệt.
 *   2. "Thả" cua: quyết định con cua nào bò ra, từ lỗ nào, bò đường nào.
 *      Mọi người chơi đều nhận cùng một danh sách cua => cùng thấy một hố.
 *   3. Nhận click của người chơi, kiểm tra và cộng điểm
 *      (mỗi người chỉ được đếm mỗi con cua 1 lần).
 *   4. Gửi bảng xếp hạng những người đang online cho tất cả.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================================
// 1. CẤU HÌNH — chỉnh các con số ở đây để thay đổi lối chơi
// ============================================================
const CONFIG = {
  PORT: Number(process.env.PORT) || 3000, // Render tự đặt biến PORT

  WORLD: 1000,             // thế giới game là hình vuông 1000 x 1000 đơn vị
  PIT_RADIUS: 470,         // bán kính miệng hố
  HOLE_COUNT: 6,           // số lỗ cua dưới đáy hố

  MAX_CRABS: 14,           // số cua tối đa trong hố cùng lúc
  SPAWN_MS: 700,           // bao nhiêu mili-giây thả 1 con cua (khi có 1 người chơi)
  SPAWN_MS_MIN: 300,       // càng đông người cua ra càng dày, nhưng không dày hơn mức này

  CRAB_BASE_R: 34,         // bán kính thân cua cỡ chuẩn
  CRAB_SIZE_MIN: 0.6,      // cua nhỏ nhất = 0.6 lần cỡ chuẩn
  CRAB_SIZE_MAX: 1.5,      // cua to nhất  = 1.5 lần cỡ chuẩn
  CRAB_SPEED: 170,         // tốc độ bò chuẩn (đơn vị/giây). Cua nhỏ bò nhanh hơn
  ESCAPE_CHANCE: 0.35,     // tỉ lệ cua bò thoát lên miệng hố thay vì chui lại lỗ
  EMERGE_MS: 450,          // thời gian cua ngoi lên khỏi lỗ
  SINK_MS: 450,            // thời gian cua chui lại vào lỗ

  CLICK_GRACE_MS: 1000,    // vẫn tính điểm nếu click tới trễ một chút do mạng chậm
  MAX_CLICKS_PER_SEC: 10,  // chống spam / auto-click
  OFFLINE_KEEP_MS: 15000,  // mất kết nối quá 15 giây thì rời bảng xếp hạng
  NAME_MAX: 16,            // độ dài tối đa của biệt danh
  TOP_N: 10,               // số người hiện trên bảng xếp hạng
  SEATS: 3,                // số người khác được vẽ ngồi quanh hố (3 góc còn lại)
  MAX_PLAYERS: 500,        // giới hạn số người cùng lúc
};

const CRAB_COLORS = [
  '#e8432e', // đỏ
  '#f07b1f', // cam
  '#d9a21b', // vàng
  '#3b8fd9', // xanh dương
  '#7a4fd6', // tím
  '#d94c8f', // hồng
  '#2fa37a', // xanh lá
  '#8b5a2b', // nâu
];

// ============================================================
// 2. HÀM TIỆN ÍCH NHỎ
// ============================================================
const CENTER = CONFIG.WORLD / 2;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round = (n) => Math.round(n);
const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);

// ============================================================
// 3. TRẠNG THÁI GAME (lưu trong bộ nhớ, tắt server là mất)
// ============================================================
const holes = makeHoles();          // vị trí các lỗ cua, cố định suốt lúc server chạy
const crabs = new Map();            // id cua -> con cua
const players = new Map();          // token bí mật -> người chơi
let crabSeq = 0;                    // bộ đếm để đặt id cho cua
let lastSpawn = 0;
let totalCount = 0;                 // tổng số lượt đếm của cả hố
let boardDirty = false;             // có thay đổi điểm cần gửi lại bảng xếp hạng không

// Đặt các lỗ cua ngẫu nhiên dưới đáy hố, không cho lỗ nào nằm quá sát lỗ nào.
// Nếu nhiều lỗ quá không đủ chỗ, khoảng cách tối thiểu sẽ tự nới nhỏ dần.
function makeHoles() {
  const list = [];
  let minGap = 190;
  for (let tries = 1; list.length < CONFIG.HOLE_COUNT && tries < 20000; tries++) {
    if (tries % 1000 === 0) minGap *= 0.9;
    const a = Math.random() * Math.PI * 2;
    const d = CONFIG.PIT_RADIUS * rand(0.12, 0.72);
    const x = CENTER + Math.cos(a) * d;
    const y = CENTER + Math.sin(a) * d;
    if (list.every((h) => dist(h.x, h.y, x, y) > minGap)) {
      list.push({ x: round(x), y: round(y), r: randInt(36, 46) });
    }
  }
  return list;
}

// ============================================================
// 4. TẠO CUA — mỗi con có kích cỡ, màu, tốc độ và đường bò riêng
// ============================================================
// Đường bò là danh sách điểm [x, y, dừng]: cua bò thẳng từ điểm này sang điểm
// kia, tới nơi thì đứng lại "dừng" mili-giây. Trình duyệt của mọi người tính
// ra cùng một vị trí từ cùng dữ liệu này, nên ai cũng thấy cua ở cùng chỗ.
function makeCrab(now) {
  const size = rand(CONFIG.CRAB_SIZE_MIN, CONFIG.CRAB_SIZE_MAX);
  const speed = (CONFIG.CRAB_SPEED / Math.sqrt(size)) * rand(0.85, 1.2);
  const start = pick(holes);

  const pts = [[start.x, start.y, 0]];
  let cur = { x: start.x, y: start.y };
  const steps = randInt(2, 4);
  for (let i = 0; i < steps; i++) {
    cur = randomStep(cur);
    const pause = Math.random() < 0.4 ? randInt(250, 900) : 0;
    pts.push([round(cur.x), round(cur.y), pause]);
  }

  const escape = Math.random() < CONFIG.ESCAPE_CHANCE;
  if (escape) {
    // bò ra xa khỏi tâm hố, vượt qua miệng hố rồi ra khỏi màn hình
    const a = Math.atan2(cur.y - CENTER, cur.x - CENTER) + rand(-0.6, 0.6);
    const far = CONFIG.WORLD * 0.78;
    pts.push([round(CENTER + Math.cos(a) * far), round(CENTER + Math.sin(a) * far), 0]);
  } else {
    const end = pick(holes);
    pts.push([end.x, end.y, 0]);
  }

  const walk = walkTime(pts, speed);
  return {
    id: ++crabSeq,
    t0: now + 250,                 // bắt đầu ngoi lên sau 0,25 giây để mọi máy kịp nhận
    size: Math.round(size * 100) / 100,
    color: pick(CRAB_COLORS),
    speed: round(speed),
    pts,
    escape,
    dur: CONFIG.EMERGE_MS + walk + (escape ? 0 : CONFIG.SINK_MS),
    countedBy: new Set(),          // id những người đã đếm con này
  };
}

// Một bước ngẫu nhiên dài 90–260 đơn vị, không ra ngoài đáy hố
function randomStep(from) {
  for (let k = 0; k < 30; k++) {
    const a = Math.random() * Math.PI * 2;
    const d = rand(90, 260);
    const x = from.x + Math.cos(a) * d;
    const y = from.y + Math.sin(a) * d;
    if (dist(x, y, CENTER, CENTER) < CONFIG.PIT_RADIUS * 0.85) return { x, y };
  }
  return { x: CENTER + rand(-80, 80), y: CENTER + rand(-80, 80) };
}

// Tổng thời gian bò (mili-giây) = quãng đường / tốc độ + các lần dừng lại
// (trình duyệt dùng đúng công thức này trong game.js)
function walkTime(pts, speed) {
  let t = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1, pause] = pts[i + 1];
    t += (dist(x0, y0, x1, y1) / speed) * 1000 + pause;
  }
  return t;
}

// Phần thông tin cua gửi cho trình duyệt (không gửi danh sách người đã đếm)
function publicCrab(c, player) {
  return {
    id: c.id, t0: c.t0, size: c.size, color: c.color, speed: c.speed,
    pts: c.pts, escape: c.escape,
    n: c.countedBy.size,                              // đã có bao nhiêu người đếm
    mine: player ? c.countedBy.has(player.id) : false, // người này đếm chưa
  };
}

// ============================================================
// 5. GỬI DỮ LIỆU THỜI GIAN THỰC (Server-Sent Events)
// ============================================================
// Mỗi người chơi giữ một kết nối mở tới /api/events. Server viết từng dòng
// "data: {...}" vào kết nối đó mỗi khi có chuyện mới (cua mới, ai đó vừa đếm...).
function send(res, msg) {
  res.write('data: ' + JSON.stringify(msg) + '\n\n');
}

function broadcast(msg) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const p of players.values()) if (p.res) p.res.write(line);
}

function onlinePlayers() {
  return [...players.values()].filter((p) => p.res);
}

// Bảng xếp hạng: điểm cao đứng trên; bằng điểm thì ai đạt điểm đó trước đứng trên.
// Mỗi người còn nhận "seats": 3 người điểm cao nhất (không tính chính họ)
// để vẽ ngồi ở 3 góc còn lại của hố.
function sendBoards() {
  const ranked = onlinePlayers().sort((a, b) => b.score - a.score || a.scoreAt - b.scoreAt);
  const brief = (p) => ({ id: p.id, name: p.name, score: p.score });
  const top = ranked.slice(0, CONFIG.TOP_N).map(brief);
  const best4 = ranked.slice(0, CONFIG.SEATS + 1);
  ranked.forEach((p, i) => {
    const seats = best4.filter((q) => q !== p).slice(0, CONFIG.SEATS).map(brief);
    send(p.res, { type: 'board', top, seats, rank: i + 1, score: p.score, online: ranked.length, total: totalCount });
  });
}

// ============================================================
// 6. XỬ LÝ YÊU CẦU TỪ TRÌNH DUYỆT
// ============================================================

// POST /api/join  { name, token? }  -> vào game (hoặc vào lại nếu vừa tải lại trang)
async function handleJoin(req, res) {
  const body = await readJson(req);
  const name = cleanName(body.name);
  let p = typeof body.token === 'string' ? players.get(body.token) : null;

  if (p) {
    if (name) p.name = name;
  } else {
    if (players.size >= CONFIG.MAX_PLAYERS) {
      return sendJson(res, 503, { error: 'Hố đông quá, bạn thử lại sau ít phút nhé!' });
    }
    p = {
      id: crypto.randomBytes(4).toString('hex'),     // id công khai (hiện trên bảng xếp hạng)
      token: crypto.randomBytes(16).toString('hex'), // mã bí mật, chỉ người chơi đó biết
      name: name || 'Cua thủ ' + randInt(100, 999),
      score: 0,
      scoreAt: Date.now(),
      res: null,                 // kết nối thời gian thực (khi đang online)
      offlineSince: Date.now(),
      clicks: [],                // thời điểm các lần click gần đây (chống spam)
    };
    players.set(p.token, p);
  }
  boardDirty = true;
  sendJson(res, 200, { token: p.token, id: p.id, name: p.name, score: p.score });
}

// GET /api/events?token=...  -> mở kết nối thời gian thực
function handleEvents(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const p = players.get(url.searchParams.get('token'));
  if (!p) {
    // token không còn (ví dụ server vừa khởi động lại) -> bảo trình duyệt vào lại
    send(res, { type: 'rejoin' });
    return res.end();
  }
  if (p.res) p.res.end();        // người này mở tab mới -> đóng kết nối cũ
  p.res = res;
  p.offlineSince = 0;

  res.write('retry: 2000\n\n');   // mất kết nối thì 2 giây sau trình duyệt tự nối lại
  const now = Date.now();
  send(res, {
    type: 'init',
    now,
    world: {
      size: CONFIG.WORLD, pitRadius: CONFIG.PIT_RADIUS, crabBaseR: CONFIG.CRAB_BASE_R,
      emergeMs: CONFIG.EMERGE_MS, sinkMs: CONFIG.SINK_MS,
    },
    holes,
    crabs: [...crabs.values()].filter((c) => now < c.t0 + c.dur).map((c) => publicCrab(c, p)),
    me: { id: p.id, name: p.name, score: p.score },
  });
  boardDirty = true;

  req.on('close', () => {
    if (p.res === res) {
      p.res = null;
      p.offlineSince = Date.now();
      boardDirty = true;
    }
  });
}

// POST /api/click  { token, crabId }  -> người chơi báo vừa click trúng một con cua
async function handleClick(req, res) {
  const body = await readJson(req);
  const p = players.get(body.token);
  if (!p) return sendJson(res, 401, { ok: false, reason: 'rejoin' });

  const now = Date.now();
  p.clicks = p.clicks.filter((t) => now - t < 1000);
  if (p.clicks.length >= CONFIG.MAX_CLICKS_PER_SEC) {
    return sendJson(res, 429, { ok: false, reason: 'spam', score: p.score });
  }
  p.clicks.push(now);

  const c = crabs.get(Number(body.crabId));
  const alive = c && now >= c.t0 - 300 && now <= c.t0 + c.dur + CONFIG.CLICK_GRACE_MS;
  if (!alive) return sendJson(res, 200, { ok: false, reason: 'gone', score: p.score });
  if (c.countedBy.has(p.id)) return sendJson(res, 200, { ok: false, reason: 'counted', score: p.score });

  // Hợp lệ: cộng 1 điểm. Con cua vẫn bò tiếp để người khác đếm.
  c.countedBy.add(p.id);
  p.score += 1;
  p.scoreAt = now;
  totalCount += 1;
  boardDirty = true;
  broadcast({ type: 'count', crab: c.id, by: p.id, name: p.name, score: p.score, n: c.countedBy.size });
  sendJson(res, 200, { ok: true, score: p.score });
}

// ============================================================
// 7. VÒNG LẶP GAME — chạy đều đặn để thả cua, dọn cua, dọn người chơi
// ============================================================
setInterval(() => {
  const now = Date.now();

  // dọn cua đã chui vào lỗ / bò mất
  for (const [id, c] of crabs) {
    if (now > c.t0 + c.dur + CONFIG.CLICK_GRACE_MS + 500) crabs.delete(id);
  }

  // thả cua mới (chỉ khi có người đang chơi)
  const online = onlinePlayers().length;
  if (online > 0) {
    const every = Math.max(CONFIG.SPAWN_MS_MIN, CONFIG.SPAWN_MS - 40 * (online - 1));
    let alive = 0;
    for (const c of crabs.values()) if (now < c.t0 + c.dur) alive++;
    if (now - lastSpawn >= every && alive < CONFIG.MAX_CRABS) {
      lastSpawn = now;
      const c = makeCrab(now);
      crabs.set(c.id, c);
      broadcast({ type: 'crab', crab: publicCrab(c) });
    }
  }

  // người chơi mất kết nối quá lâu -> xoá khỏi game
  for (const [token, p] of players) {
    if (!p.res && now - p.offlineSince > CONFIG.OFFLINE_KEEP_MS) players.delete(token);
  }
}, 100);

// Bảng xếp hạng gửi tối đa 2 lần/giây (khi có thay đổi) cho đỡ tốn mạng
setInterval(() => {
  if (boardDirty) {
    boardDirty = false;
    sendBoards();
  }
}, 500);

// 5 giây "ping" một lần: giữ kết nối không bị cắt và để trình duyệt đồng bộ đồng hồ
setInterval(() => broadcast({ type: 'ping', now: Date.now() }), 5000);

// ============================================================
// 8. PHÁT FILE GIAO DIỆN (thư mục public/)
// ============================================================
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

function serveStatic(req, res, pathname) {
  let file;
  try {
    file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  } catch {
    return res.writeHead(400).end();
  }
  // không cho đọc file nằm ngoài thư mục public/
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end();
  if (pathname.endsWith('/')) file = path.join(file, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Không tìm thấy');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ============================================================
// 9. KHỞI ĐỘNG SERVER
// ============================================================
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2048) req.destroy(); // chặn dữ liệu quá lớn
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Làm sạch biệt danh: bỏ ký tự lạ, gộp khoảng trắng, cắt độ dài
function cleanName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, CONFIG.NAME_MAX).join('');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/join') return await handleJoin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/click') return await handleClick(req, res);
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, online: onlinePlayers().length, crabs: crabs.size });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Lỗi server' });
  }
});

server.listen(CONFIG.PORT, () => {
  console.log('🦀 Đếm cua trong lỗ đang chạy!');
  console.log(`   Mở trên máy này:      http://localhost:${CONFIG.PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   Bạn bè cùng Wi-Fi:    http://${net.address}:${CONFIG.PORT}`);
      }
    }
  }
  console.log('   Nhấn Ctrl + C để tắt server.');
});
