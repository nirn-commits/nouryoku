// 戦場の部品（環境オブジェクト・建物）と、視線・経路探索。マップの配置は maps.js
import { segRect, pointInRect, distToRect, rectsOverlap } from './vec.js';

const WALL_T = 0.3;

let objSeq = 0;

// 物体の種類ごとの性質
const KINDS = {
  wall: { blocksMove: true, blocksSight: true, movable: false, hp: 70, soundDamp: 0.5 },
  window: { blocksMove: true, blocksSight: false, movable: false, hp: 6, soundDamp: 0.8 },
  crate: { kg: 20, blocksMove: true, blocksSight: true, movable: true, hp: 28, mass: 1, soundDamp: 1 },
  table: { kg: 25, blocksMove: true, blocksSight: false, movable: true, hp: 30, mass: 1.6, soundDamp: 1 },
  shelf: { kg: 60, blocksMove: true, blocksSight: true, movable: true, hp: 40, mass: 2.5, soundDamp: 0.9 },
  vending: { kg: 300, blocksMove: true, blocksSight: true, movable: true, hp: 60, mass: 3, soundDamp: 0.9 },
  drum: { kg: 180, blocksMove: true, blocksSight: false, movable: true, hp: 35, mass: 1.2, soundDamp: 1 },
  cone: { kg: 3, blocksMove: true, blocksSight: false, movable: true, hp: 5, mass: 0.3, soundDamp: 1 },
  car: { blocksMove: true, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 0.8 },
  steel: { blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  hole: { blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  tree: { blocksMove: true, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 0.9 },
  pole: { blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  // 植え込み：通れる（遅くなる）。外から中は近くでないと見えない
  bush: { blocksMove: false, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
};

export function resetObjSeq() {
  objSeq = 0;
}

export function makeObj(kind, props) {
  const base = KINDS[kind];
  return {
    id: props.id || `${kind}_${++objSeq}`,
    kind,
    vx: 0, vy: 0, slickUntil: 0,
    indestructible: false,
    ...base,
    ...props,
    maxHp: props.hp || base.hp,
  };
}

export function addObj(world, kind, props) {
  const o = makeObj(kind, props);
  world.objects.push(o);
  return o;
}

export function newWorld(w, h, seed) {
  resetObjSeq();
  const world = {
    w, h, seed,
    objects: [], buildings: [], areas: [], ground: [], zones: [], rubble: [], projectiles: [], pickups: [], effects: [],
    spawns: { player: { x: 2.5, y: h - 3 }, cpu: { x: w - 2.5, y: 3 } },
    navDirty: true, nav: null,
  };
  // 外周（破壊不可）
  const b = 0.5;
  world.objects.push(
    makeObj('wall', { id: 'outer_n', name: '外壁', x: 0, y: 0, w, h: b, indestructible: true }),
    makeObj('wall', { id: 'outer_s', name: '外壁', x: 0, y: h - b, w, h: b, indestructible: true }),
    makeObj('wall', { id: 'outer_w', name: '外壁', x: 0, y: 0, w: b, h, indestructible: true }),
    makeObj('wall', { id: 'outer_e', name: '外壁', x: w - b, y: 0, w: b, h, indestructible: true }),
  );
  return world;
}

// 一直線の塀・仮囲いを、隙間（門）を空けて約3mずつに分けて作る
export function addFence(world, { id, name, x, y, len, horiz, t = 0.25, gaps = [], hp = 50, style = 'block' }) {
  const sorted = gaps.slice().sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  let seg = 0;
  const piece = (from, to) => {
    const n = Math.max(1, Math.round((to - from) / 3));
    const step = (to - from) / n;
    for (let i = 0; i < n; i++) {
      const a = from + step * i, b = from + step * (i + 1);
      seg++;
      addObj(world, 'wall', {
        id: `${id}_${seg}`, name: `${name}${seg}`, style, hp,
        ...(horiz ? { x: x + a, y, w: b - a, h: t } : { x, y: y + a, w: t, h: b - a }),
      });
    }
  };
  for (const [a, b] of sorted) {
    if (a > cursor) piece(cursor, a);
    cursor = b;
  }
  if (cursor < len) piece(cursor, len);
}

// 建物の外周を、扉（隙間）と窓を挟んだ壁セグメントに分割して作る
export function addHouse(world, h) {
  const { id, name } = h;
  const building = { id, name, kind: h.kind || 'house', aliases: h.aliases || [], x: h.x, y: h.y, w: h.w, h: h.h, doors: [], windows: [] };
  const sides = {
    N: { horiz: true, x: h.x, y: h.y, len: h.w, label: '北' },
    S: { horiz: true, x: h.x, y: h.y + h.h - WALL_T, len: h.w, label: '南' },
    W: { horiz: false, x: h.x, y: h.y, len: h.h, label: '西' },
    E: { horiz: false, x: h.x + h.w - WALL_T, y: h.y, len: h.h, label: '東' },
  };
  for (const [key, s] of Object.entries(sides)) {
    const ops = h.openings.filter(o => o.side === key).sort((a, b) => a.a - b.a);
    let cursor = 0;
    let seg = 0;
    const pushWall = (from, to) => {
      // 長い壁は約3mごとに分割（部分的に壊せるように）
      const n = Math.max(1, Math.round((to - from) / 3));
      const step = (to - from) / n;
      for (let i = 0; i < n; i++) {
        const a = from + step * i, b = from + step * (i + 1);
        seg++;
        const rect = s.horiz
          ? { x: s.x + a, y: s.y, w: b - a, h: WALL_T }
          : { x: s.x, y: s.y + a, w: WALL_T, h: b - a };
        world.objects.push(makeObj('wall', {
          id: `${id}_wall_${key}${seg}`,
          name: `${name}の${s.label}壁${seg}`,
          building: id,
          ...(h.wallHp ? { hp: h.wallHp } : {}),
          ...rect,
        }));
      }
    };
    for (const o of ops) {
      if (o.a > cursor) pushWall(cursor, o.a);
      const rect = s.horiz
        ? { x: s.x + o.a, y: s.y, w: o.b - o.a, h: WALL_T }
        : { x: s.x, y: s.y + o.a, w: WALL_T, h: o.b - o.a };
      if (o.type === 'window') {
        world.objects.push(makeObj('window', { id: o.id, name: o.name, building: id, ...(o.hp ? { hp: o.hp } : {}), ...rect }));
        building.windows.push(o.id);
      } else {
        building.doors.push({ id: o.id, name: o.name, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
      }
      cursor = o.b;
    }
    if (cursor < s.len) pushWall(cursor, s.len);
  }
  world.buildings.push(building);
  return building;
}

export function objectById(world, id) {
  return world.objects.find(o => o.id === id) || null;
}

export function buildingAt(world, x, y) {
  return world.buildings.find(b => pointInRect(x, y, b)) || null;
}

// 視線：blocksSight の物体で遮られるか
export function hasLOS(world, x0, y0, x1, y1, ignoreId = null) {
  for (const o of world.objects) {
    if (!o.blocksSight || o.id === ignoreId) continue;
    const t = segRect(x0, y0, x1, y1, o);
    if (t !== null && t > 1e-4 && t < 1 - 1e-4) {
      // 始点が物体内にある（壁に密着している）場合は除外
      if (pointInRect(x0, y0, o) || pointInRect(x1, y1, o)) continue;
      return false;
    }
  }
  return true;
}

// 音の減衰：間にある壁の数で届く距離が縮む
export function soundFactor(world, x0, y0, x1, y1) {
  let f = 1;
  for (const o of world.objects) {
    if (o.soundDamp >= 1) continue;
    const t = segRect(x0, y0, x1, y1, o);
    if (t !== null && t > 1e-4 && t < 1 - 1e-4) f *= o.soundDamp;
  }
  return f;
}

// ---------- 経路探索（内部的な航行グリッド。キャラクターの位置・移動は連続座標） ----------

const CELL = 0.4;

export function rebuildNav(world, radius = 0.42) {
  const cols = Math.ceil(world.w / CELL);
  const rows = Math.ceil(world.h / CELL);
  const blocked = new Uint8Array(cols * rows);
  const slow = new Float32Array(cols * rows).fill(1);
  for (const o of world.objects) {
    if (!o.blocksMove) continue;
    const c0 = Math.max(0, Math.floor((o.x - radius) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((o.x + o.w + radius) / CELL));
    const r0 = Math.max(0, Math.floor((o.y - radius) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((o.y + o.h + radius) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * CELL, cy = (r + 0.5) * CELL;
        if (distToRect(cx, cy, o) < radius) blocked[r * cols + c] = 1;
      }
    }
  }
  // 瓦礫・砂利・植え込みは通れるが遠回りの方が好まれるように重みを付ける
  const slowRects = world.rubble.concat(world.objects.filter(o => o.kind === 'bush'));
  for (const rb of slowRects) {
    const c0 = Math.max(0, Math.floor(rb.x / CELL) - 1), c1 = Math.min(cols - 1, Math.ceil((rb.x + rb.w) / CELL) + 1);
    const r0 = Math.max(0, Math.floor(rb.y / CELL) - 1), r1 = Math.min(rows - 1, Math.ceil((rb.y + rb.h) / CELL) + 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * CELL, cy = (r + 0.5) * CELL;
        if (pointInRect(cx, cy, rb, 0.2)) slow[r * cols + c] = 1.6;
      }
    }
  }
  world.nav = { cols, rows, blocked, slow };
  world.navDirty = false;
}

function navOf(world) {
  if (world.navDirty || !world.nav) rebuildNav(world);
  return world.nav;
}

export function isWalkablePoint(world, x, y) {
  const nav = navOf(world);
  const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
  if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return false;
  return !nav.blocked[r * nav.cols + c];
}

function walkableLine(world, x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(d / 0.15);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!isWalkablePoint(world, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

// 最寄りの歩行可能点
export function nearestWalkable(world, x, y, maxR = 3) {
  if (isWalkablePoint(world, x, y)) return { x, y };
  for (let r = CELL; r <= maxR; r += CELL / 2) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
      const py = y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (isWalkablePoint(world, px, py)) return { x: px, y: py };
    }
  }
  return null;
}

// A* で経路を求め、視線の通る点を間引いて滑らかにする。
// 到達不能なら最も近づける点までの経路を partial=true で返す
export function findPath(world, sx, sy, tx, ty) {
  const nav = navOf(world);
  const { cols, rows, blocked, slow } = nav;
  const idx = (c, r) => r * cols + c;
  const start = nearestWalkable(world, sx, sy, 1.5);
  const goal = nearestWalkable(world, tx, ty, 2.5);
  if (!start) return null;
  const sc = Math.floor(start.x / CELL), sr = Math.floor(start.y / CELL);
  let partial = !goal;
  const gx = goal ? goal.x : tx, gy = goal ? goal.y : ty;
  const gc = Math.floor(gx / CELL), gr = Math.floor(gy / CELL);

  const g = new Float32Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const heap = [];
  const push = (f, i) => {
    heap.push([f, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const h = (c, r) => Math.hypot(c - gc, r - gr);
  const s = idx(sc, sr);
  g[s] = 0;
  push(h(sc, sr), s);
  let best = s, bestH = h(sc, sr);
  let found = false;
  let iter = 0;
  while (heap.length && iter++ < 80000) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % cols, r = (cur - c) / cols;
    const hh = h(c, r);
    if (hh < bestH) { bestH = hh; best = cur; }
    if (c === gc && r === gr) { found = true; best = cur; break; }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = idx(nc, nr);
        if (blocked[ni] || closed[ni]) continue;
        if (dc && dr && (blocked[idx(c + dc, r)] || blocked[idx(c, r + dr)])) continue;
        const ng = g[cur] + (dc && dr ? Math.SQRT2 : 1) * slow[ni];
        if (ng < g[ni]) {
          g[ni] = ng;
          came[ni] = cur;
          push(ng + h(nc, nr), ni);
        }
      }
    }
  }
  if (!found) partial = true;
  const cells = [];
  for (let k = best; k !== -1; k = came[k]) cells.push(k);
  cells.reverse();
  const pts = cells.map(k => ({ x: ((k % cols) + 0.5) * CELL, y: (Math.floor(k / cols) + 0.5) * CELL }));
  if (found && goal) pts.push({ x: goal.x, y: goal.y });
  else if (!pts.length) return null;

  // 間引き（ストリングプリング）
  const out = [];
  let i = 0;
  let cx = sx, cy = sy;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !walkableLine(world, cx, cy, pts[j].x, pts[j].y)) j--;
    out.push(pts[j]);
    cx = pts[j].x; cy = pts[j].y;
    i = j + 1;
  }
  let length = 0;
  let px = sx, py = sy;
  for (const p of out) { length += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y; }
  return { points: out, partial, length };
}

export function markNavDirty(world) {
  world.navDirty = true;
}

export { rectsOverlap };
