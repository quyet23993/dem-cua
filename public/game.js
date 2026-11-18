/**
 * ĐẾM CUA TRONG LỖ — phần chạy trên trình duyệt
 * ------------------------------------------------------------
 * File này làm 4 việc:
 *   1. Vào game: gửi biệt danh lên server, nhận "vé" (token).
 *   2. Nghe server: nhận cua mới, ai vừa đếm, bảng xếp hạng.
 *   3. Vẽ: cái hố, các lỗ cua, từng con cua đang bò (60 lần mỗi giây).
 *   4. Bấm: kiểm tra cú bấm có trúng cua không, trúng thì báo server.
 */
'use strict';

// ============================================================
// 1. TRẠNG THÁI
// ============================================================
const S = {
  token: null, id: null, name: '', score: 0, rank: null,
  joined: false, es: null,
  world: { size: 1000, pitRadius: 470, crabBaseR: 34, emergeMs: 450, sinkMs: 450 },
  holes: [],
  crabs: new Map(),        // id -> con cua (kèm đường bò đã tính sẵn)
  effects: [],             // chữ "+1" bay lên, vòng tròn khi bấm trượt...
  seats: [],               // 3 người điểm cao nhất (không tính bạn) ngồi ở 3 góc còn lại
  flash: new Map(),        // id người chơi -> lúc họ vừa đếm trúng (để nháy +1)
  bubbles: new Map(),      // id người chơi -> bong bóng chat đang hiện trên hố
  timeSamples: [],         // để đồng bộ đồng hồ với server
  offset: 0,               // giờ server = Date.now() + offset
  muted: store('crab-muted') === '1',
};

const $ = (id) => document.getElementById(id);
const canvas = $('pit');
const ctx = canvas.getContext('2d');
const bg = document.createElement('canvas'); // nền (hố + lỗ) vẽ sẵn 1 lần cho nhẹ máy
const bgCtx = bg.getContext('2d');
let pxPerUnit = 1;   // số điểm ảnh của canvas cho mỗi đơn vị thế giới game
let cssPerUnit = 1;  // số "pixel CSS" cho mỗi đơn vị (dùng để chữ không bị quá nhỏ)

// localStorage có thể bị chặn (chế độ ẩn danh...) nên bọc lại cho an toàn
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}
function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch { return null; }
}

// ============================================================
// 2. VÀO GAME VÀ NGHE SERVER
// ============================================================
async function join(name) {
  const btn = $('join-btn');
  btn.disabled = true;
  $('join-error').textContent = '';
  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token: session('crab-token') }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Không vào được game');

    S.token = data.token; S.id = data.id; S.name = data.name; S.score = data.score;
    S.joined = true;
    session('crab-token', data.token);   // tải lại trang vẫn giữ điểm
    store('crab-name', data.name);
    $('join').hidden = true;
    updateHud();
    connect();
  } catch (err) {
    $('join').hidden = false;
    $('join-error').textContent = 'Không kết nối được server. ' + (err.message || '');
  } finally {
    btn.disabled = false;
  }
}

function connect() {
  if (S.es) S.es.close();
  setStatus('Đang kết nối…');
  const es = new EventSource('/api/events?token=' + encodeURIComponent(S.token));
  S.es = es;
  es.onopen = () => setStatus(null);
  es.onerror = () => {
    setStatus('Mất kết nối, đang nối lại…');
    // trình duyệt tự nối lại; nếu nó bỏ cuộc thì mình vào lại từ đầu
    if (es.readyState === EventSource.CLOSED) setTimeout(rejoin, 2000);
  };
  es.onmessage = (e) => handleMessage(JSON.parse(e.data));
}

function rejoin() {
  if (S.es) S.es.close();
  session('crab-token', null);
  join(S.name);
}

function handleMessage(m) {
  if (m.now) syncClock(m.now);
  switch (m.type) {
    case 'init':
      S.world = m.world;
      S.holes = m.holes;
      S.crabs.clear();
      m.crabs.forEach(addCrab);
      S.score = m.me.score;
      resize();
      updateHud();
      renderChatHistory(m.chat || []);
      break;
    case 'crab':
      addCrab(m.crab);
      break;
    case 'count': {
      const c = S.crabs.get(m.crab);
      if (c) {
        c.n = m.n;
        if (m.by !== S.id && c.pose && countOthersEffects() < 8) {
          addText(c.pose.x, c.pose.y + c.r * 1.2, '+1 ' + m.name, '#ffffff', 12);
        }
      }
      // người vừa đếm đang ngồi quanh hố -> cập nhật điểm và nháy +1
      const seat = S.seats.find((s) => s.id === m.by);
      if (seat) {
        seat.score = m.score;
        seatFlash(seat.id);
      }
      break;
    }
    case 'board':
      renderBoard(m);
      break;
    case 'chat':
      addChatLine(m.msg);
      showBubble(m.msg);
      break;
    case 'rejoin':
      rejoin();
      break;
  }
}

// Đồng hồ máy người chơi có thể lệch với server. Mỗi tin nhắn có giờ server;
// lấy mức chênh lớn nhất trong 12 lần gần nhất (lần ít bị trễ mạng nhất).
function syncClock(serverNow) {
  S.timeSamples.push(serverNow - Date.now());
  if (S.timeSamples.length > 12) S.timeSamples.shift();
  S.offset = Math.max(...S.timeSamples);
}
const serverNow = () => Date.now() + S.offset;

// ============================================================
// 3. CUA: TÍNH VỊ TRÍ THEO THỜI GIAN
// ============================================================
// Server chỉ gửi "kịch bản" (điểm bắt đầu, các điểm đi qua, tốc độ).
// Ở đây ta chia kịch bản thành từng chặng để biết lúc nào cua ở đâu.
function addCrab(raw) {
  const W = S.world;
  const legs = [];
  let t = W.emergeMs;
  let cum = 0;
  for (let i = 0; i < raw.pts.length - 1; i++) {
    const [x0, y0] = raw.pts[i];
    const [x1, y1, pause] = raw.pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const d = (len / raw.speed) * 1000;
    legs.push({ t0: t, t1: t + d, x0, y0, x1, y1, len, cum, dir: Math.atan2(y1 - y0, x1 - x0) });
    t += d; cum += len;
    if (pause) { legs.push({ t0: t, t1: t + pause, x0: x1, y0: y1, x1, y1, len: 0, cum, dir: null }); t += pause; }
  }
  const firstDir = (legs.find((l) => l.dir !== null) || { dir: 0 }).dir;
  S.crabs.set(raw.id, {
    ...raw,
    r: W.crabBaseR * raw.size,
    legs,
    walkEnd: t,
    end: t + (raw.escape ? 0 : W.sinkMs),
    angle: firstDir + (raw.id % 2 ? Math.PI : 0),
    dark: shade(raw.color, -0.38),
    light: shade(raw.color, 0.4),
    n: raw.n || 0,
    mine: !!raw.mine,
    pose: null,
  });
}

// Vị trí của con cua ở thời điểm "now" (giờ server)
function poseAt(c, now) {
  const W = S.world;
  const age = now - c.t0;
  if (age < 0 || age > c.end) return null;
  const first = c.legs[0];
  const last = c.legs[c.legs.length - 1];

  if (age < W.emergeMs) {                       // đang ngoi lên khỏi lỗ
    return { x: first.x0, y: first.y0, scale: easeOutBack(age / W.emergeMs), dir: null, moving: false, traveled: 0 };
  }
  if (age >= c.walkEnd) {                       // đang chui xuống lỗ (hoặc đã bò mất)
    const k = c.escape ? 0 : (age - c.walkEnd) / W.sinkMs;
    return { x: last.x1, y: last.y1, scale: 1 - k * k, dir: null, moving: false, traveled: last.cum + last.len };
  }
  for (const leg of c.legs) {                   // đang bò trên chặng nào?
    if (age < leg.t1) {
      const k = (age - leg.t0) / (leg.t1 - leg.t0);
      return {
        x: leg.x0 + (leg.x1 - leg.x0) * k,
        y: leg.y0 + (leg.y1 - leg.y0) * k,
        scale: 1, dir: leg.dir, moving: leg.len > 0, traveled: leg.cum + leg.len * k,
      };
    }
  }
  return null;
}

// Cua bò ngang! Nó có thể bò sang trái hoặc sang phải mà không cần quay người,
// nên ta chọn hướng thân gần với hướng hiện tại nhất, rồi xoay từ từ cho mượt.
function steer(c, p, dt) {
  if (p.dir === null) return;
  let target = p.dir;
  if (Math.abs(angleDiff(target + Math.PI, c.angle)) < Math.abs(angleDiff(target, c.angle))) target += Math.PI;
  c.angle += angleDiff(target, c.angle) * Math.min(1, dt * 8);
}
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function easeOutBack(k) {
  const s = 1.7;
  return 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
}

// ============================================================
// 4. VẼ
// ============================================================
function resize() {
  const stage = canvas.parentElement;
  const size = Math.floor(Math.min(stage.clientWidth, stage.clientHeight));
  if (size <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = canvas.height = Math.round(size * dpr);
  bg.width = bg.height = canvas.width;
  pxPerUnit = canvas.width / S.world.size;
  cssPerUnit = size / S.world.size;
  drawBackground();
}

// Bộ số ngẫu nhiên "có hạt giống": lần nào vẽ lại cũng ra đúng những viên sỏi cũ
function seeded(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawBackground() {
  const g = bgCtx;
  const W = S.world.size, C = W / 2, R = S.world.pitRadius;
  const rnd = seeded(7);
  g.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);

  // Bãi cát quanh miệng hố
  g.fillStyle = '#e4c58a';
  g.fillRect(0, 0, W, W);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(130,90,40,0.18)' : 'rgba(255,248,220,0.4)';
    g.beginPath(); g.arc(rnd() * W, rnd() * W, 1 + rnd() * 2.2, 0, Math.PI * 2); g.fill();
  }

  // Đáy hố: sẫm dần ra phía thành hố cho có chiều sâu
  const floor = g.createRadialGradient(C, C, R * 0.1, C, C, R);
  floor.addColorStop(0, '#b88c54');
  floor.addColorStop(0.7, '#a77b46');
  floor.addColorStop(0.93, '#86602f');
  floor.addColorStop(1, '#6a4722');
  g.fillStyle = floor;
  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.fill();

  // Bóng đổ phía trong thành hố
  g.save();
  g.beginPath(); g.arc(C, C, R, 0, Math.PI * 2); g.clip();
  g.shadowColor = 'rgba(30,15,0,0.6)';
  g.shadowBlur = 50 * pxPerUnit;
  g.shadowOffsetX = 14 * pxPerUnit;
  g.shadowOffsetY = 22 * pxPerUnit;
  g.beginPath();
  g.rect(-W, -W, W * 3, W * 3);
  g.arc(C, C, R + 4, 0, Math.PI * 2, true);
  g.fillStyle = '#000';
  g.fill();
  g.restore();

  // Sỏi, vỏ ốc dưới đáy
  const pebbles = ['#8d6a3e', '#c9a26a', '#6f5130', '#dcc08c'];
  for (let i = 0; i < 260; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * R * 0.93;
    g.globalAlpha = 0.55;
    g.fillStyle = pebbles[Math.floor(rnd() * pebbles.length)];
    g.beginPath(); g.arc(C + Math.cos(a) * d, C + Math.sin(a) * d, 1.5 + rnd() * 3.5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2, d = R * (0.2 + rnd() * 0.65);
    drawShell(g, C + Math.cos(a) * d, C + Math.sin(a) * d, 6 + rnd() * 5, rnd() * Math.PI * 2);
  }

  // Miệng hố
  g.lineWidth = 12; g.strokeStyle = '#f0dcac';
  g.beginPath(); g.arc(C, C, R + 2, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2; g.strokeStyle = 'rgba(90,60,30,0.45)';
  g.beginPath(); g.arc(C, C, R - 5, 0, Math.PI * 2); g.stroke();

  // Các lỗ cua
  for (const h of S.holes) {
    const mound = g.createRadialGradient(h.x, h.y, h.r * 0.8, h.x, h.y, h.r * 1.7);
    mound.addColorStop(0, 'rgba(225,192,135,0.95)');
    mound.addColorStop(1, 'rgba(225,192,135,0)');
    g.fillStyle = mound;
    g.beginPath(); g.ellipse(h.x, h.y + 4, h.r * 1.7, h.r * 1.4, 0, 0, Math.PI * 2); g.fill();

    const hole = g.createRadialGradient(h.x, h.y + h.r * 0.2, 2, h.x, h.y, h.r);
    hole.addColorStop(0, '#0b0602');
    hole.addColorStop(0.7, '#25170a');
    hole.addColorStop(1, '#4a3015');
    g.fillStyle = hole;
    g.beginPath(); g.ellipse(h.x, h.y, h.r, h.r * 0.8, 0, 0, Math.PI * 2); g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(60,35,15,0.7)'; g.stroke();
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,236,190,0.45)';
    g.beginPath(); g.ellipse(h.x, h.y, h.r, h.r * 0.8, 0, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  }
}

function drawShell(g, x, y, s, rot) {
  g.save();
  g.translate(x, y); g.rotate(rot);
  g.fillStyle = '#f4e8d2'; g.strokeStyle = '#c4aa82'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, s * 0.6);
  g.arc(0, 0, s, Math.PI * 1.05, Math.PI * 1.95);
  g.closePath(); g.fill(); g.stroke();
  for (let i = -2; i <= 2; i++) {
    g.beginPath(); g.moveTo(0, s * 0.6); g.lineTo(Math.sin(i * 0.35) * s * 0.9, -Math.cos(i * 0.35) * s * 0.9); g.stroke();
  }
  g.restore();
}

// Vẽ 1 con cua nhìn từ trên xuống. Trong hệ toạ độ riêng của con cua:
// trục x = hướng bò ngang, phía y âm = phía trước (càng và mắt).
function drawCrab(c, p, now) {
  const g = ctx, r = c.r, TAU = Math.PI * 2;

  // Bóng đổ
  g.save();
  g.translate(p.x + r * 0.15 * p.scale, p.y + r * 0.22 * p.scale);
  g.rotate(c.angle); g.scale(p.scale, p.scale);
  g.fillStyle = 'rgba(40,20,5,0.28)';
  g.beginPath(); g.ellipse(0, 0, r * 1.3, r * 1.0, 0, 0, TAU); g.fill();
  g.restore();

  g.save();
  g.translate(p.x, p.y); g.rotate(c.angle); g.scale(p.scale, p.scale);
  g.lineCap = 'round'; g.lineJoin = 'round';

  // 8 cái chân, mỗi bên 4 chân, đung đưa so le khi bò
  const walk = p.traveled / (r * 0.28);
  g.strokeStyle = c.dark; g.lineWidth = r * 0.14;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const swing = p.moving
        ? Math.sin(walk + i * 1.6 + (side > 0 ? 0 : Math.PI)) * 0.32
        : Math.sin(now / 300 + i + c.id) * 0.04;
      const base = -0.55 + i * 0.36 + swing;
      const a1 = side > 0 ? base : Math.PI - base;
      const a2 = a1 + side * 0.95;
      const x0 = side * r * 0.72, y0 = -r * 0.28 + i * r * 0.2;
      const x1 = x0 + Math.cos(a1) * r * 0.62, y1 = y0 + Math.sin(a1) * r * 0.62;
      const x2 = x1 + Math.cos(a2) * r * 0.55, y2 = y1 + Math.sin(a2) * r * 0.55;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
  }

  // 2 cái càng, khép mở liên tục
  const pinch = 0.25 + 0.22 * Math.sin(now / 180 + c.id * 1.7);
  for (const side of [-1, 1]) {
    const ax = side * r * 0.42, ay = -r * 0.5;
    const cx = side * r * 0.78, cy = -r * 1.12;
    g.strokeStyle = c.dark; g.lineWidth = r * 0.26;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(cx, cy); g.stroke();
    g.strokeStyle = c.color; g.lineWidth = r * 0.13;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(cx, cy); g.stroke();

    g.save();
    g.translate(cx, cy); g.rotate(side * 0.35);
    g.fillStyle = c.color; g.strokeStyle = c.dark; g.lineWidth = r * 0.06;
    g.beginPath(); g.ellipse(0, -r * 0.08, r * 0.3, r * 0.4, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = c.dark;                       // khe giữa 2 ngàm càng
    g.beginPath();
    g.moveTo(0, -r * 0.02);
    g.lineTo(-r * 0.3 * pinch, -r * 0.52);
    g.lineTo(r * 0.3 * pinch, -r * 0.52);
    g.closePath(); g.fill();
    g.restore();
  }

  // Mai cua
  const shell = g.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.1);
  shell.addColorStop(0, c.light);
  shell.addColorStop(0.55, c.color);
  shell.addColorStop(1, c.dark);
  g.fillStyle = shell; g.strokeStyle = c.dark; g.lineWidth = r * 0.07;
  g.beginPath(); g.ellipse(0, 0, r, r * 0.74, 0, 0, TAU); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = r * 0.05;
  g.beginPath(); g.ellipse(0, r * 0.08, r * 0.6, r * 0.4, 0, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.22)';
  for (const [sx, sy] of [[-0.38, 0.12], [0.34, 0.16], [0, 0.38]]) {
    g.beginPath(); g.arc(sx * r, sy * r, r * 0.08, 0, TAU); g.fill();
  }

  // 2 con mắt trên cuống
  for (const side of [-1, 1]) {
    g.strokeStyle = c.dark; g.lineWidth = r * 0.08;
    g.beginPath(); g.moveTo(side * r * 0.16, -r * 0.6); g.lineTo(side * r * 0.2, -r * 0.84); g.stroke();
    g.fillStyle = '#fff'; g.lineWidth = r * 0.04;
    g.beginPath(); g.arc(side * r * 0.2, -r * 0.9, r * 0.13, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#111';
    g.beginPath(); g.arc(side * r * 0.2, -r * 0.94, r * 0.065, 0, TAU); g.fill();
  }
  g.restore();
}

// Nhãn số người đã đếm con cua (xanh lá + dấu ✓ nếu bạn đã đếm).
// Vẽ sau khi đã vẽ hết cua để nhãn không bị con khác che mất.
function drawBadge(c, p) {
  const g = ctx, r = c.r;
  if (c.n > 0 && p.scale > 0.6) {
    const fs = Math.max(18, 11 / cssPerUnit);
    const label = c.mine ? '✓ ' + c.n : String(c.n);
    g.font = `700 ${fs}px system-ui, sans-serif`;
    const w = g.measureText(label).width + fs * 0.9, h = fs * 1.4;
    const bx = p.x + r * 0.95, by = p.y - r * 1.05;
    g.fillStyle = c.mine ? 'rgba(22,163,74,0.95)' : 'rgba(20,20,20,0.6)';
    roundRect(g, bx - w / 2, by - h / 2, w, h, h / 2); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, bx, by + fs * 0.05);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Hiệu ứng: chữ bay lên và mờ dần, vòng tròn khi bấm trượt
function addText(x, y, text, color, minPx, own = false) {
  S.effects.push({ kind: 'text', x, y, text, color, minPx, own, born: performance.now(), life: 900 });
}
function addRing(x, y) {
  S.effects.push({ kind: 'ring', x, y, born: performance.now(), life: 350 });
}
function addReticle(x, y) {
  S.effects.push({ kind: 'reticle', x, y, born: performance.now(), life: 380 });
}
function countOthersEffects() {
  return S.effects.filter((e) => e.kind === 'text' && !e.own).length;
}
function drawEffects() {
  const t = performance.now();
  S.effects = S.effects.filter((e) => t - e.born < e.life);
  for (const e of S.effects) {
    const k = (t - e.born) / e.life;
    ctx.globalAlpha = 1 - k;
    if (e.kind === 'ring') {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, 8 + k * 26, 0, Math.PI * 2); ctx.stroke();
    } else if (e.kind === 'reticle') {
      drawReticle(e.x, e.y, 14 / cssPerUnit);
    } else {
      const fs = Math.max(e.own ? 30 : 18, e.minPx / cssPerUnit);
      ctx.font = `800 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = fs * 0.18; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(e.text, e.x, e.y - k * 60);
      ctx.fillStyle = e.color;
      ctx.fillText(e.text, e.x, e.y - k * 60);
    }
  }
  ctx.globalAlpha = 1;
}

// Điểm ngắm (vòng tròn + chữ thập đỏ) — giống con trỏ chuột trong style.css
function drawReticle(x, y, r) {
  const g = ctx;
  g.save();
  g.translate(x, y);
  g.lineCap = 'round';
  for (const [color, width] of [['#ffffff', r * 0.3], ['#e11d2e', r * 0.15]]) {
    g.strokeStyle = color; g.lineWidth = width;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(0, -r * 1.42); g.lineTo(0, -r * 0.67);
    g.moveTo(0, r * 0.67); g.lineTo(0, r * 1.42);
    g.moveTo(-r * 1.42, 0); g.lineTo(-r * 0.67, 0);
    g.moveTo(r * 0.67, 0); g.lineTo(r * 1.42, 0);
    g.stroke();
  }
  g.fillStyle = '#e11d2e'; g.strokeStyle = '#ffffff'; g.lineWidth = r * 0.12;
  g.beginPath(); g.arc(0, 0, r * 0.2, 0, Math.PI * 2); g.fill(); g.stroke();
  g.restore();
}

// ============================================================
// 4b. NGƯỜI NGỒI QUANH MIỆNG HỐ (4 góc)
// ============================================================
// Góc trên trái luôn là bạn. 3 góc còn lại là 3 người điểm cao nhất
// (server gửi kèm bảng xếp hạng): trên phải = cao nhất, dưới trái = nhì, dưới phải = ba.
const CORNERS = [
  { sx: -1, sy: -1 }, // trên trái  (bạn)
  { sx: 1, sy: -1 },  // trên phải
  { sx: -1, sy: 1 },  // dưới trái
  { sx: 1, sy: 1 },   // dưới phải
];
const SHIRTS = ['#2563eb', '#16a34a', '#db2777', '#f59e0b', '#7c3aed', '#0891b2', '#dc2626', '#475569'];
const SKINS = ['#f6d0a8', '#eab98a', '#d39a6a', '#a8714a'];
const HAIRS = ['#1f140c', '#3b2414', '#5a3418', '#111111', '#8a5a2b'];

// Mỗi người có màu áo, màu da, màu tóc cố định, chọn theo id
function lookFor(id) {
  const n = parseInt(String(id).slice(0, 8), 16) || 0;
  return {
    shirt: SHIRTS[n % SHIRTS.length],
    skin: SKINS[(n >>> 4) % SKINS.length],
    hair: HAIRS[(n >>> 8) % HAIRS.length],
  };
}

// Vị trí chỗ ngồi của góc thứ i: trên đường chéo, sát miệng hố, quay mặt vào tâm
function seatSpot(i) {
  const W = S.world.size, C = W / 2;
  const { sx, sy } = CORNERS[i];
  const d = (S.world.pitRadius + 88) / Math.SQRT2;
  return { x: C + sx * d, y: C + sy * d, face: Math.atan2(-sy, -sx) };
}

function seatList() {
  if (!S.id) return [];
  return [{ id: S.id, name: 'Bạn', score: S.score, me: true }, ...S.seats.slice(0, 3)];
}

// Ai đó đang ngồi quanh hố vừa đếm trúng: giơ tay chỉ + nháy "+1"
function seatFlash(id) {
  const i = seatList().findIndex((s) => s.id === id);
  if (i < 0) return;
  S.flash.set(id, performance.now());
  const s = seatSpot(i);
  const hx = s.x + Math.cos(s.face) * 125, hy = s.y + Math.sin(s.face) * 125;
  addText(hx, hy, '+1', i === 0 ? '#ffd23f' : '#ffffff', 16, true);
}

// Vẽ 1 người ngồi nhìn từ trên xuống. Hệ toạ độ riêng: trục x hướng vào tâm hố.
function drawPerson(seat, i, t) {
  const g = ctx, TAU = Math.PI * 2;
  const s = seatSpot(i);
  const look = lookFor(seat.id);
  const k = Math.max(0, 1 - (t - (S.flash.get(seat.id) || -1e9)) / 450); // 1 lúc vừa đếm, giảm về 0

  g.save();
  g.translate(s.x, s.y); g.rotate(s.face); g.scale(1.45, 1.45);
  g.lineCap = 'round';

  if (seat.me) {                                  // vầng sáng vàng dưới chỗ bạn ngồi
    g.fillStyle = 'rgba(255,183,3,0.32)';
    g.beginPath(); g.ellipse(4, 0, 64, 60, 0, 0, TAU); g.fill();
  }
  g.fillStyle = '#c9a66b';                        // tấm chiếu để ngồi
  g.strokeStyle = '#9c7a45'; g.lineWidth = 2;
  roundRect(g, -46, -44, 70, 88, 8); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(120,85,40,0.35)'; g.lineWidth = 1.5;
  for (let yy = -36; yy <= 36; yy += 8) {
    g.beginPath(); g.moveTo(-42, yy); g.lineTo(20, yy); g.stroke();
  }
  g.fillStyle = 'rgba(40,20,5,0.25)';             // bóng
  g.beginPath(); g.ellipse(8, 5, 48, 40, 0, 0, TAU); g.fill();

  for (const side of [-1, 1]) {                   // 2 chân thả xuống miệng hố
    g.strokeStyle = '#334155'; g.lineWidth = 17;
    g.beginPath(); g.moveTo(6, side * 12); g.lineTo(54, side * 13); g.stroke();
    g.fillStyle = '#6b3f1a';
    g.beginPath(); g.ellipse(63, side * 13, 8, 7, 0, 0, TAU); g.fill();
  }

  g.fillStyle = look.shirt;                       // thân (áo)
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
  g.beginPath(); g.ellipse(-6, 0, 21, 33, 0, 0, TAU); g.fill(); g.stroke();

  for (const side of [-1, 1]) {                   // 2 tay; tay phải chỉ vào hố khi vừa đếm
    const point = side > 0 ? k : 0;
    const hx = 30 + 42 * point, hy = side * (24 - 14 * point);
    const ex = -2 + (hx + 2) * 0.5, ey = side * 28 + (hy - side * 28) * 0.5;
    g.strokeStyle = look.shirt; g.lineWidth = 13;
    g.beginPath(); g.moveTo(-4, side * 27); g.lineTo(ex, ey); g.stroke();
    g.strokeStyle = look.skin; g.lineWidth = 9;
    g.beginPath(); g.moveTo(ex, ey); g.lineTo(hx, hy); g.stroke();
    g.fillStyle = look.skin;
    g.beginPath(); g.arc(hx, hy, 6.5, 0, TAU); g.fill();
    if (point > 0.05) {                           // ngón trỏ
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + 12, hy - side * 1); g.stroke();
    }
  }

  g.fillStyle = look.skin;                        // đầu: mặt + tai, tóc phủ phía sau
  g.beginPath(); g.arc(-4, 0, 17, 0, TAU); g.fill();
  g.beginPath(); g.arc(-5, -16, 4.5, 0, TAU); g.arc(-5, 16, 4.5, 0, TAU); g.fill();
  g.fillStyle = look.hair;
  g.beginPath(); g.arc(-9, 0, 16, 0, TAU); g.fill();
  g.restore();
}

// Nhãn tên + điểm ở sát góc; nảy lên một chút khi người đó vừa đếm
function drawSeatLabel(seat, i, t) {
  const g = ctx, W = S.world.size, { sx, sy } = CORNERS[i];
  const k = Math.max(0, 1 - (t - (S.flash.get(seat.id) || -1e9)) / 450);
  const fs = Math.max(20, 12 / cssPerUnit);
  const chars = Array.from(seat.name);
  const name = chars.length > 10 ? chars.slice(0, 9).join('') + '…' : seat.name;
  const score = String(seat.score);
  g.font = `700 ${fs}px system-ui, sans-serif`;
  const nw = g.measureText(name).width;
  g.font = `800 ${fs}px system-ui, sans-serif`;
  const sw = g.measureText(score).width;
  const padX = fs * 0.6, gap = fs * 0.45, h = fs * 1.6;
  const w = padX * 2 + nw + gap + sw;
  const x0 = sx < 0 ? 14 : W - 14 - w;
  const y0 = sy < 0 ? 14 : W - 14 - h;

  g.save();
  g.translate(x0 + w / 2, y0 + h / 2);
  g.scale(1 + 0.15 * k, 1 + 0.15 * k);
  g.translate(-w / 2, -h / 2);
  g.fillStyle = seat.me ? 'rgba(255,183,3,0.96)' : 'rgba(16,35,42,0.85)';
  roundRect(g, 0, 0, w, h, h / 2); g.fill();
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.fillStyle = seat.me ? '#3a2400' : '#f6ecd9';
  g.fillText(name, padX, h / 2 + fs * 0.05);
  g.font = `800 ${fs}px system-ui, sans-serif`;
  g.fillStyle = seat.me ? '#3a2400' : '#ffb703';
  g.fillText(score, padX + nw + gap, h / 2 + fs * 0.05);
  g.restore();
}

// Vòng lặp vẽ: trình duyệt gọi hàm này khoảng 60 lần mỗi giây
let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  const now = serverNow();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, 0, 0);
  ctx.setTransform(pxPerUnit, 0, 0, pxPerUnit, 0, 0);

  const pt = performance.now();
  const seats = seatList();
  seats.forEach((s, i) => drawPerson(s, i, pt));   // người ngồi quanh hố (vẽ dưới cua)

  for (const c of S.crabs.values()) {
    const p = poseAt(c, now);
    c.pose = p;
    if (!p) {
      if (now - c.t0 > c.end + 2000) S.crabs.delete(c.id);  // cua đã đi hẳn
      continue;
    }
    steer(c, p, dt);
    drawCrab(c, p, now);
  }
  for (const c of S.crabs.values()) if (c.pose) drawBadge(c, c.pose);
  seats.forEach((s, i) => drawSeatLabel(s, i, pt)); // nhãn tên + điểm ở 4 góc
  seats.forEach((s, i) => drawBubble(s, i, pt));    // bong bóng chat của người ngồi quanh hố
  drawEffects();
  requestAnimationFrame(frame);
}

// ============================================================
// 5. BẤM ĐẾM CUA
// ============================================================
canvas.addEventListener('pointerdown', (e) => {
  if (!S.joined) return;
  e.preventDefault();
  unlockAudio();

  // đổi vị trí bấm trên màn hình -> toạ độ trong thế giới game
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * S.world.size;
  const y = ((e.clientY - rect.top) / rect.height) * S.world.size;
  const pad = e.pointerType === 'touch' ? 24 : 8;   // ngón tay to hơn chuột nên nới rộng vùng trúng
  if (e.pointerType !== 'mouse') addReticle(x, y);  // điện thoại không có con trỏ: hiện điểm ngắm chỗ chạm

  // tìm con cua gần chỗ bấm nhất, ưu tiên con bạn chưa đếm
  let best = null, bestScore = Infinity;
  for (const c of S.crabs.values()) {
    const p = c.pose;
    if (!p || p.scale < 0.35) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    const hitR = c.r * 1.3 * p.scale + pad;
    if (d > hitR) continue;
    const score = d / hitR + (c.mine ? 1 : 0);
    if (score < bestScore) { bestScore = score; best = c; }
  }

  if (!best) { addRing(x, y); return; }
  if (best.mine) {
    addText(best.pose.x, best.pose.y - best.r, 'Đếm rồi!', '#ffe9a8', 13, true);
    beep(200, 0.06, 'square', 0.04);
    return;
  }

  // Trúng con mới: hiện +1 ngay cho sướng tay, rồi báo server xác nhận
  best.mine = true;
  best.n += 1;
  S.score += 1;
  updateHud();
  addText(best.pose.x, best.pose.y - best.r, '+1', '#ffd23f', 22, true);
  seatFlash(S.id);
  beep(640 + Math.random() * 220, 0.09, 'triangle', 0.14);
  sendClick(best);
});

async function sendClick(c) {
  try {
    const res = await fetch('/api/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: S.token, crabId: c.id }),
    });
    const d = await res.json();
    if (res.status === 401) return rejoin();
    if (typeof d.score === 'number') S.score = d.score;  // điểm thật do server quyết định
    if (!d.ok && d.reason !== 'counted') {
      c.mine = false;
      c.n = Math.max(0, c.n - 1);
      if (c.pose) addText(c.pose.x, c.pose.y - c.r, d.reason === 'spam' ? 'Chậm thôi!' : 'Trễ mất rồi!', '#ffb4a8', 13, true);
    }
    updateHud();
  } catch {
    c.mine = false;
    S.score = Math.max(0, S.score - 1);
    updateHud();
  }
}

// ============================================================
// 6. BẢNG XẾP HẠNG, THANH ĐIỂM, TRẠNG THÁI
// ============================================================
function renderBoard(m) {
  S.rank = m.rank;
  S.seats = m.seats || [];
  $('online').textContent = m.online;
  $('total').textContent = m.total.toLocaleString('vi-VN');

  const medals = ['🥇', '🥈', '🥉'];
  const ol = $('top');
  ol.replaceChildren();
  m.top.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === S.id) li.className = 'is-me';
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = medals[i] || String(i + 1);
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (p.id === S.id ? ' (bạn)' : '');   // textContent: an toàn với tên lạ
    const score = document.createElement('b');
    score.className = 'pscore';
    score.textContent = p.score;
    li.append(rank, name, score);
    ol.append(li);
  });

  const mine = $('my-rank');
  const inTop = m.top.some((p) => p.id === S.id);
  mine.hidden = inTop || !m.rank;
  if (!inTop && m.rank) {
    mine.replaceChildren();
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = m.rank;
    const name = document.createElement('span'); name.className = 'pname'; name.textContent = S.name + ' (bạn)';
    const score = document.createElement('b'); score.className = 'pscore'; score.textContent = m.score;
    mine.append(rank, name, score);
  }
  updateHud();
}

function updateHud() {
  $('me-name').textContent = S.name;
  $('me-score').textContent = S.score;
  $('me-rank').textContent = S.rank ? '#' + S.rank : '–';
}

function setStatus(text) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
}

// ============================================================
// 6b. CHAT
// ============================================================
// Khung chat được tạo bằng JavaScript (không cần sửa index.html):
// máy tính nằm dưới bảng xếp hạng, điện thoại nằm ngay dưới hố (xem style.css).
function buildChatBox() {
  const box = document.createElement('section');
  box.className = 'chat';
  box.innerHTML =
    '<h2>Trò chuyện</h2>' +
    '<ol id="chat-list" class="chat-list" aria-live="polite"></ol>' +
    '<form id="chat-form" class="chat-form" autocomplete="off">' +
    '  <input id="chat-input" maxlength="120" placeholder="Nhắn gì đó cho cả hố…" aria-label="Tin nhắn">' +
    '  <button type="submit">Gửi</button>' +
    '</form>' +
    '<p id="chat-note" class="chat-note" role="status"></p>';
  $('app').append(box);
  $('chat-form').addEventListener('submit', sendChat);
}

function renderChatHistory(list) {
  const ol = $('chat-list');
  ol.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = 'Chưa có tin nhắn nào. Chào cả hố một câu đi!';
    ol.append(li);
  }
  list.forEach((msg) => addChatLine(msg));
  ol.scrollTop = ol.scrollHeight;
}

// Thêm 1 dòng chat. Dùng textContent nên tin nhắn có ký tự lạ cũng không phá được trang.
function addChatLine(msg) {
  const ol = $('chat-list');
  ol.querySelector('.chat-empty')?.remove();
  const nearBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  const mine = msg.by === S.id;

  const li = document.createElement('li');
  if (mine) li.className = 'mine';
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = new Date(msg.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const name = document.createElement('b');
  name.className = 'chat-name';
  name.textContent = mine ? 'Bạn' : msg.name;
  name.style.color = shade(lookFor(msg.by).shirt, 0.45);   // cùng màu áo người đó ngồi quanh hố
  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = msg.text;
  li.append(time, name, text);
  ol.append(li);

  while (ol.children.length > 100) ol.firstChild.remove();
  if (nearBottom || mine) ol.scrollTop = ol.scrollHeight;
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !S.joined) return;
  input.value = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: S.token, text }),
    });
    if (res.status === 401) return rejoin();
    if (res.status === 429) {
      input.value = text;
      chatNote('Gửi chậm thôi, mỗi giây 1 tin nhé!');
    }
  } catch {
    input.value = text;
    chatNote('Chưa gửi được, bạn thử lại nhé.');
  }
}

let chatNoteTimer = 0;
function chatNote(text) {
  $('chat-note').textContent = text;
  clearTimeout(chatNoteTimer);
  chatNoteTimer = setTimeout(() => { $('chat-note').textContent = ''; }, 2500);
}

// Người nhắn đang ngồi quanh hố (kể cả bạn) -> hiện bong bóng lời nói vài giây
function showBubble(msg) {
  if (!seatList().some((s) => s.id === msg.by)) return;
  const len = Array.from(msg.text).length;
  S.bubbles.set(msg.by, { text: msg.text, born: performance.now(), life: Math.min(8000, 3500 + 60 * len) });
}

function drawBubble(seat, i, t) {
  const b = S.bubbles.get(seat.id);
  if (!b) return;
  const age = t - b.born;
  if (age > b.life) { S.bubbles.delete(seat.id); return; }

  const g = ctx, W = S.world.size, { sx } = CORNERS[i], s = seatSpot(i);
  const fs = Math.max(18, 12 / cssPerUnit);
  const pad = fs * 0.6, lh = fs * 1.3;
  const maxW = Math.min(470, Math.max(330, fs * 14));
  g.font = `600 ${fs}px system-ui, sans-serif`;
  const lines = wrapText(g, b.text, maxW - pad * 2, 3);
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
  const h = lines.length * lh + pad * 1.2;
  // bong bóng nằm bên cạnh người ngồi, phía trong hố, không tràn ra ngoài khung
  const x0 = sx < 0 ? s.x + 72 : s.x - 72 - w;
  const y0 = Math.min(Math.max(s.y - h / 2, 60), W - 60 - h);
  const cy = Math.min(Math.max(s.y, y0 + h * 0.3), y0 + h * 0.7);

  g.save();
  g.globalAlpha = Math.min(1, age / 150, (b.life - age) / 400);
  g.fillStyle = seat.me ? '#fff4d1' : '#ffffff';
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 2;
  g.beginPath();                                   // đuôi bong bóng chỉ về phía người nói
  const edge = sx < 0 ? x0 : x0 + w;
  g.moveTo(edge, cy - fs * 0.45);
  g.lineTo(s.x - sx * 34, s.y);
  g.lineTo(edge, cy + fs * 0.45);
  g.closePath(); g.fill(); g.stroke();
  roundRect(g, x0, y0, w, h, fs * 0.6); g.fill(); g.stroke();
  g.fillRect(edge - (sx < 0 ? 0 : 3), cy - fs * 0.45 + 2, 3, fs * 0.9 - 4); // che đường viền chỗ nối đuôi
  g.fillStyle = '#1d2b30';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  lines.forEach((line, k) => g.fillText(line, x0 + pad, y0 + pad * 0.6 + lh * (k + 0.5)));
  g.restore();
}

// Ngắt chữ thành nhiều dòng vừa chiều rộng; quá số dòng thì thêm "…"
function wrapText(g, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (let word of words) {
    while (g.measureText(word).width > maxWidth) {   // từ quá dài: cắt bớt từng ký tự
      let cut = Array.from(word);
      while (cut.length > 1 && g.measureText(cut.join('')).width > maxWidth) cut.pop();
      if (line) { lines.push(line); line = ''; }
      lines.push(cut.join(''));
      word = Array.from(word).slice(cut.length).join('');
    }
    const test = line ? line + ' ' + word : word;
    if (g.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && g.measureText(last + '…').width > maxWidth) last = Array.from(last).slice(0, -1).join('');
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

// ============================================================
// 7. ÂM THANH (tự tạo bằng Web Audio, không cần file mp3)
// ============================================================
let audio = null;
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
function beep(freq, dur, type, vol) {
  if (S.muted || !audio) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur);
}
function updateSoundButton() {
  $('sound').textContent = S.muted ? '🔇' : '🔊';
}
$('sound').addEventListener('click', () => {
  S.muted = !S.muted;
  store('crab-muted', S.muted ? '1' : '0');
  updateSoundButton();
  unlockAudio();
});

// Làm sáng / làm tối một màu dạng #rrggbb (amount từ -1 đến 1)
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// ============================================================
// 8. KHỞI ĐỘNG
// ============================================================
$('name').value = store('crab-name') || '';
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  join($('name').value);
});
updateSoundButton();
buildChatBox();
new ResizeObserver(resize).observe(canvas.parentElement);
resize();
requestAnimationFrame(frame);

// Vừa tải lại trang trong cùng tab -> vào lại luôn, giữ nguyên điểm
if (session('crab-token') && store('crab-name')) {
  $('join').hidden = true;
  join(store('crab-name'));
}
