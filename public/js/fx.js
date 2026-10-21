// エフェクト素材（1枚のスプライトシート）の読み込みと切り出し
// 座標は横幅 1316px のシートを基準にした値。実際の画像の横幅に合わせて拡大縮小して使う
// 置き場所：public/fx/effects.png（またはタイトル画面から選んだ画像。ブラウザの IndexedDB に保存）

export const FX_BASE_W = 1316;

const row = (n, x0, y, w, h) => Array.from({ length: n }, (_, i) => [x0 + i * w, y, w, h]);

export const ATLAS = {
  hitBig: row(6, 0, 0, 115.5, 122), // 打撃の閃光（大）：広がって消える6コマ
  hitSmall: row(4, 700, 0, 115.5, 122), // 打撃の閃光（小）
  speedLines: [[0, 128, 180, 180]], // 集中線
  // 擬音（1語1コマ）
  ono: {
    ドゴォ: [0, 322, 185, 135], バキィ: [188, 322, 180, 135], ボゴッ: [378, 322, 185, 135], ドスッ: [563, 322, 185, 135],
    ガッ: [755, 322, 185, 135], ドギュン: [940, 322, 185, 135], ビシッ: [1125, 322, 191, 135],
    ガシャァン: [0, 460, 185, 165], ゴッ: [188, 460, 180, 165], ゴォォン: [375, 460, 190, 165], ジュウッ: [563, 460, 185, 165],
    ドサッ: [755, 460, 185, 165], ドグシャァ: [940, 460, 190, 165], ガラガラ: [1130, 460, 186, 165],
  },
  gogogo: [[0, 632, 160, 345]], // 「ゴゴゴ」（縦書き）
  retire: [[0, 983, 368, 138]], // 「再起不能（リタイヤ）」
  spark: row(4, 0, 1127, 130, 135), // 跳弾の火花
  trail: { blue: [0, 1268, 238, 38], yellow: [238, 1268, 238, 38], red: [476, 1268, 238, 38], white: [714, 1268, 238, 38] }, // 弾・投げた物の軌跡
  glass: row(6, 0, 1311, 116.5, 122), // ガラスの破片
  flame: [[0, 1440, 212, 135]], // 白い炎の壁
  shock: row(8, 0, 1582, 129, 136), // 衝撃波の輪（轟音）
  aura: { blue: [0, 1724, 110, 110], yellow: [110, 1724, 110, 110], green: [220, 1724, 110, 110], purple: [330, 1724, 110, 110], red: [440, 1724, 110, 110], white: [550, 1724, 110, 110] }, // 能力発動のオーラ
  dust: row(6, 0, 1840, 104, 110), // 砂ぼこり
};

// キャラごとのオーラの色
export const AURA_OF = { sogo: 'yellow', kito: 'red', nanami: 'green', saginuma: 'purple', saragiin: 'white' };

// ---------- 保存（IndexedDB） ----------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nouryoku', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFxBlob(blob) {
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    blob ? tx.objectStore('files').put(blob, 'effects') : tx.objectStore('files').delete('effects');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFxBlob() {
  try {
    const db = await idb();
    return await new Promise(resolve => {
      const req = db.transaction('files').objectStore('files').get('effects');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------- 読み込み ----------

// 背景が透過されていない画像（市松模様が描き込まれた画像）は、背景を抜いて透過にする
// 市松の2色と升目の位置をコマごとに割り出し、各画素の「本来の背景色」からの差を不透明度にする（半透明の煙や光も残る）
function keyOutChecker(ctx, w, h, scale) {
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let opaque = true;
  for (let i = 3; i < px.length; i += 4 * 97) if (px[i] < 250) { opaque = false; break; }
  if (!opaque) return false;
  const rects = [];
  for (const v of Object.values(ATLAS)) for (const r of Array.isArray(v) ? v : Object.values(v)) {
    rects.push([Math.max(0, Math.floor(r[0] * scale)), Math.max(0, Math.floor(r[1] * scale)), Math.min(w, Math.ceil((r[0] + r[2]) * scale)), Math.min(h, Math.ceil((r[1] + r[3]) * scale))]);
  }
  const at = (x, y) => (y * w + x) * 4;
  const key = i => (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
  // 市松の2色：コマの中で最も多い2色
  const counts = new Map();
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) {
      const k = key(at(x, y));
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const [ka, kb] = [...counts.entries()].sort((a, z) => z[1] - a[1]).slice(0, 2).map(e => e[0]);
  if (ka === undefined || kb === undefined) return false;
  const rgb = k => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
  const A = rgb(ka), B = rgb(kb);
  // シートの地の色（コマの外の暗い色）：コマの縁に入り込んだ区切り線を消すのに使う
  const inRect = (x, y) => rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
  let D = null;
  for (let y = h - 1; y > 0 && !D; y -= 7) for (let x = w - 1; x > 0; x -= 7) if (!inRect(x, y)) { const i = (y * w + x) * 4; D = [px[i], px[i + 1], px[i + 2]]; break; }
  const near = (i, c) => Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]) <= 4;
  const keep = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    // 升目の境目（2色が入れ替わる位置）の x・y の余りを数えて、升目の位置と大きさ（既定16px）を決める
    const cell = Math.max(4, Math.round(16 * scale));
    const hx = new Array(cell).fill(0), hy = new Array(cell).fill(0);
    for (let y = y0; y < y1; y += 2) for (let x = x0 + 1; x < x1; x++) {
      const i = at(x, y), j = at(x - 1, y);
      if ((near(i, A) && near(j, B)) || (near(i, B) && near(j, A))) hx[x % cell]++;
    }
    for (let x = x0; x < x1; x += 2) for (let y = y0 + 1; y < y1; y++) {
      const i = at(x, y), j = at(x, y - 1);
      if ((near(i, A) && near(j, B)) || (near(i, B) && near(j, A))) hy[y % cell]++;
    }
    const ox = hx.indexOf(Math.max(...hx)), oy = hy.indexOf(Math.max(...hy));
    const par = (x, y) => (Math.floor((x - ox) / cell) + Math.floor((y - oy) / cell)) & 1;
    // どちらの偶奇が A か
    let agree = 0, total = 0;
    for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
      const i = at(x, y);
      const isA = near(i, A), isB = near(i, B);
      if (!isA && !isB) continue;
      total++;
      if ((par(x, y) === 0) === isA) agree++;
    }
    const flip = agree < total / 2;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = at(x, y);
        const bg = (par(x, y) === 0) !== flip ? A : B;
        // コマの縁の2px は区切り線が入りやすいので抜く
        if (x - x0 < 2 || x1 - 1 - x < 2 || y - y0 < 2 || y1 - 1 - y < 2) { px[i + 3] = 0; keep[y * w + x] = 1; continue; }
        if (D && Math.abs(px[i] - D[0]) + Math.abs(px[i + 1] - D[1]) + Math.abs(px[i + 2] - D[2]) <= 6) { px[i + 3] = 0; keep[y * w + x] = 1; continue; }
        // 色を不透明度に変換（GIMP の「色を透明度に」と同じ考え方）
        let a = 0;
        for (let c = 0; c < 3; c++) {
          const p = px[i + c], q = bg[c];
          const ac = p > q ? (p - q) / (255 - q) : p < q ? (q - p) / q : 0;
          if (ac > a) a = ac;
        }
        a = Math.min(1, a * 1.5);
        if (a < 0.06) { px[i + 3] = 0; keep[y * w + x] = 1; continue; }
        for (let c = 0; c < 3; c++) px[i + c] = Math.max(0, Math.min(255, Math.round(bg[c] + (px[i + c] - bg[c]) / a)));
        px[i + 3] = Math.round(a * 255);
        keep[y * w + x] = 1;
      }
    }
  }
  // どのコマにも入らない所（コマの間の余白）も消す
  for (let p = 0; p < w * h; p++) if (!keep[p]) px[p * 4 + 3] = 0;
  ctx.putImageData(data, 0, 0);
  return true;
}

// 素材を読み込む。見つからなければ null（プログラム描画のまま）
export async function loadFxSheet() {
  let img = null, source = '';
  const blob = await loadFxBlob();
  if (blob) {
    const url = URL.createObjectURL(blob);
    try { img = await loadImage(url); source = 'ブラウザに保存した画像'; } catch { img = null; }
  }
  if (!img) {
    for (const name of ['fx/effects.png', 'fx/effects.webp', 'fx/effects.jpg']) {
      try { img = await loadImage(name); source = `public/${name}`; break; } catch { /* 次を試す */ }
    }
  }
  if (!img) return null;
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const scale = w / FX_BASE_W;
  const keyed = keyOutChecker(ctx, w, h, scale);
  return { canvas, scale, source, keyed, w, h };
}

// コマの矩形（実画像の座標）
export function frameRect(sheet, rect) {
  const s = sheet.scale;
  return [rect[0] * s, rect[1] * s, rect[2] * s, rect[3] * s];
}

// ---------- キャラチップ ----------
// public/chips/<id>.png：48px のコマ。1段目＝待機の8方向（南・南東・東・北東・北・北西・西・南西）、
// 2〜5段目（あれば）＝走りの8コマ（南・東・北・西）。スタンドは <id>_stand.png（1段目のみ）
export async function loadChips(ids) {
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      const img = await loadImage(`chips/${id}.png`);
      out[id] = { img, rows: Math.floor(img.naturalHeight / 48) };
    } catch { /* 無ければ従来の描き方 */ }
  }));
  return out;
}
