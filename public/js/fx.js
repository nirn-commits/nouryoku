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
export const AURA_OF = { sogo: 'yellow', kito: 'red', nanami: 'green', saginuma: 'purple' };

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

// 背景が透過されていない画像（市松模様が描き込まれた画像）は、各コマの縁の色を背景として抜く
function keyOutChecker(ctx, w, h, scale) {
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let opaque = true;
  for (let i = 3; i < px.length; i += 4 * 97) if (px[i] < 250) { opaque = false; break; }
  if (!opaque) return false;
  const rects = [];
  for (const v of Object.values(ATLAS)) for (const r of Array.isArray(v) ? v : Object.values(v)) rects.push(r);
  const keep = new Uint8Array(w * h);
  for (const [bx, by, bw, bh] of rects) {
    const x0 = Math.max(0, Math.floor(bx * scale)), y0 = Math.max(0, Math.floor(by * scale));
    const x1 = Math.min(w, Math.ceil((bx + bw) * scale)), y1 = Math.min(h, Math.ceil((by + bh) * scale));
    // 縁の画素で多い2色を背景色とみなす
    const counts = new Map();
    const sample = (x, y) => {
      const i = (y * w + x) * 4;
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      const e = counts.get(key) || { n: 0, r: px[i], g: px[i + 1], b: px[i + 2] };
      e.n++;
      counts.set(key, e);
    };
    for (let x = x0; x < x1; x++) { sample(x, y0); sample(x, y1 - 1); }
    for (let y = y0; y < y1; y++) { sample(x0, y); sample(x1 - 1, y); }
    const bgs = [...counts.values()].sort((a, z) => z.n - a.n).slice(0, 2);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        let dmin = 999;
        for (const c of bgs) dmin = Math.min(dmin, Math.abs(px[i] - c.r) + Math.abs(px[i + 1] - c.g) + Math.abs(px[i + 2] - c.b));
        if (dmin < 18) px[i + 3] = 0;
        else if (dmin < 40) px[i + 3] = Math.min(px[i + 3], Math.round(((dmin - 18) / 22) * 255));
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
