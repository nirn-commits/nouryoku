// 2D ベクトル・幾何ユーティリティ（単位はメートル）
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const angleTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

export function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function pointInRect(px, py, r, pad = 0) {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}

export function nearestPointOnRect(px, py, r) {
  return { x: clamp(px, r.x, r.x + r.w), y: clamp(py, r.y, r.y + r.h) };
}

export function distToRect(px, py, r) {
  const n = nearestPointOnRect(px, py, r);
  return dist(px, py, n.x, n.y);
}

// 線分と矩形の交差（スラブ法）。最初に触れる位置の t (0..1) を返す
export function segRect(x0, y0, x1, y1, r, pad = 0) {
  let tmin = 0, tmax = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [r.x - pad, r.y - pad];
  const hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - p[i]) / d[i];
      let t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// 線分と矩形が重なる区間 [t入, t出]（0..1 に切り詰め）。重ならなければ null
export function segRectRange(x0, y0, x1, y1, r, pad = 0) {
  let tmin = 0, tmax = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [r.x - pad, r.y - pad];
  const hi = [r.x + r.w + pad, r.y + r.h + pad];
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - p[i]) / d[i];
      let t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return [tmin, tmax];
}

// 線分と円の交差。最初に触れる t を返す
export function segCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0, dy = y1 - y0;
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return fx * fx + fy * fy <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t1 < 0 && t2 >= 0) return 0;
  return null;
}

// 円を矩形から押し出すベクトル（重なっていなければ null）
export function circleRectPush(cx, cy, cr, r) {
  if (cx + cr <= r.x || cx - cr >= r.x + r.w || cy + cr <= r.y || cy - cr >= r.y + r.h) return null; // 明らかに離れている
  const n = nearestPointOnRect(cx, cy, r);
  let dx = cx - n.x, dy = cy - n.y;
  const d = Math.hypot(dx, dy);
  if (d >= cr) return null;
  if (d < 1e-6) {
    // 中心が矩形内：最短の辺へ押し出す
    const left = cx - r.x, right = r.x + r.w - cx, top = cy - r.y, bottom = r.y + r.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: -(left + cr), y: 0, nx: -1, ny: 0 };
    if (m === right) return { x: right + cr, y: 0, nx: 1, ny: 0 };
    if (m === top) return { x: 0, y: -(top + cr), nx: 0, ny: -1 };
    return { x: 0, y: bottom + cr, nx: 0, ny: 1 };
  }
  dx /= d; dy /= d;
  return { x: dx * (cr - d), y: dy * (cr - d), nx: dx, ny: dy };
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// 再現可能な乱数
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
