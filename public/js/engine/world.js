// 戦場の部品（環境オブジェクト・建物）と、視線・経路探索。マップの配置は maps.js
import { segRect, segRectRange, pointInRect, distToRect, rectsOverlap } from './vec.js';

const WALL_T = 0.3;
export const FLOOR_H = 3; // 1階分の高さ（m）
export const EYE_H = 1.6; // 目の高さ
export const BODY_H = 1.2; // 見られる側の体の中心の高さ

let objSeq = 0;

// 物体の種類ごとの性質
const KINDS = {
  wall: { height: 3, blocksMove: true, blocksSight: true, movable: false, hp: 70, soundDamp: 0.5 },
  window: { height: 3, blocksMove: true, blocksSight: false, movable: false, hp: 6, soundDamp: 0.8, openable: true, open: false },
  // 扉：閉まっていると通れず見通せない。歩いてぶつかると開ける
  door: { height: 3, blocksMove: true, blocksSight: true, movable: false, hp: 40, soundDamp: 0.7, openable: true, open: false },
  crate: { height: 1.0, kg: 20, blocksMove: true, blocksSight: true, movable: true, hp: 28, mass: 1, soundDamp: 1 },
  table: { height: 0.75, kg: 25, blocksMove: true, blocksSight: false, movable: true, hp: 30, mass: 1.6, soundDamp: 1 },
  shelf: { height: 1.8, kg: 60, blocksMove: true, blocksSight: true, movable: true, hp: 40, mass: 2.5, soundDamp: 0.9 },
  vending: { height: 1.9, kg: 300, blocksMove: true, blocksSight: true, movable: true, hp: 60, mass: 3, soundDamp: 0.9 },
  drum: { height: 0.9, kg: 180, blocksMove: true, blocksSight: false, movable: true, hp: 35, mass: 1.2, soundDamp: 1 },
  cone: { height: 0.7, kg: 3, blocksMove: true, blocksSight: false, movable: true, hp: 5, mass: 0.3, soundDamp: 1 },
  car: { height: 1.5, blocksMove: true, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 0.8 },
  steel: { height: 1.2, blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  hole: { height: 0.05, blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  tree: { height: 5, blocksMove: true, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 0.9 },
  pole: { height: 8, blocksMove: true, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  // 植え込み：通れる（遅くなる）。外から中は近くでないと見えない
  bush: { height: 1.3, blocksMove: false, blocksSight: true, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
  // 階段：通れる。上り下りに約1秒かかる
  stairs: { height: 0, blocksMove: false, blocksSight: false, movable: false, hp: 999, indestructible: true, soundDamp: 1 },
};

const STYLE_HEIGHT = { block: 1.8, panel: 3, concrete: 6 };

export function resetObjSeq() {
  objSeq = 0;
}

export function makeObj(kind, props) {
  const base = KINDS[kind];
  const o = {
    id: props.id || `${kind}_${++objSeq}`,
    kind,
    vx: 0, vy: 0, slickUntil: 0,
    indestructible: false,
    floor: 0,
    ...base,
    ...props,
    maxHp: props.hp || base.hp,
  };
  // 高さの範囲（z0〜z1）：何階にあるか＋種類ごとの高さ
  if (props.height === undefined && o.style && STYLE_HEIGHT[o.style]) o.height = STYLE_HEIGHT[o.style];
  o.z0 = o.floor * FLOOR_H;
  o.z1 = o.z0 + o.height;
  return o;
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
    objects: [], buildings: [], areas: [], ground: [], zones: [], rubble: [], projectiles: [], items: [], effects: [],
    spawns: { player: { x: 2.5, y: h - 3 }, cpu: { x: w - 2.5, y: 3 } },
    navDirty: true, nav: null,
  };
  // 外周（破壊不可）
  const b = 0.5;
  world.objects.push(
    makeObj('wall', { id: 'outer_n', name: '外壁', x: 0, y: 0, w, h: b, indestructible: true, height: 50 }),
    makeObj('wall', { id: 'outer_s', name: '外壁', x: 0, y: h - b, w, h: b, indestructible: true, height: 50 }),
    makeObj('wall', { id: 'outer_w', name: '外壁', x: 0, y: 0, w: b, h, indestructible: true, height: 50 }),
    makeObj('wall', { id: 'outer_e', name: '外壁', x: w - b, y: 0, w: b, h, indestructible: true, height: 50 }),
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
  const floors = h.floors || 1;
  const building = { id, name, kind: h.kind || 'house', aliases: h.aliases || [], x: h.x, y: h.y, w: h.w, h: h.h, floors, doors: [], windows: [], exits: [], stairs: null, sealed: null };
  addWalls(world, building, h, 0, h.openings);
  if (floors >= 2) {
    addWalls(world, building, h, 1, h.upper?.openings || []);
    // 階段（1階と2階の同じ位置）。2階の床として区域も登録する
    const st = h.stairs;
    building.stairs = { id: `${id}_stairs`, name: `${name}の階段`, x: st.x, y: st.y, w: st.w, h: st.h };
    world.objects.push(makeObj('stairs', { id: `${id}_stairs`, name: `${name}の階段`, building: id, floor: 0, ...building.stairs }));
    world.areas.push({ id: `${id}_2f`, name: `${name}の2階`, floor: 1, building: id, x: h.x + WALL_T, y: h.y + WALL_T, w: h.w - WALL_T * 2, h: h.h - WALL_T * 2 });
  }
  world.buildings.push(building);
  return building;
}

function addWalls(world, building, h, floor, openings) {
  const { id, name } = building;
  const fl = floor ? '2階の' : '';
  const sides = {
    N: { horiz: true, x: h.x, y: h.y, len: h.w, label: '北' },
    S: { horiz: true, x: h.x, y: h.y + h.h - WALL_T, len: h.w, label: '南' },
    W: { horiz: false, x: h.x, y: h.y, len: h.h, label: '西' },
    E: { horiz: false, x: h.x + h.w - WALL_T, y: h.y, len: h.h, label: '東' },
  };
  for (const [key, s] of Object.entries(sides)) {
    const ops = openings.filter(o => o.side === key).sort((a, b) => a.a - b.a);
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
          id: `${id}_${floor ? 'f2_' : ''}wall_${key}${seg}`,
          name: `${name}の${fl}${s.label}壁${seg}`,
          building: id,
          floor,
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
        world.objects.push(makeObj('window', { id: o.id, name: o.name, building: id, floor, side: key, ...(o.hp ? { hp: o.hp } : {}), ...(o.fixed ? { openable: false } : {}), ...rect }));
        building.windows.push(o.id);
      } else {
        world.objects.push(makeObj('door', { id: o.id, name: o.name, building: id, floor, side: key, ...rect }));
        building.doors.push({ id: o.id, name: o.name, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
      }
      // 扉・窓はすべてこの建物（部屋）の出口
      building.exits.push(o.id);
      cursor = o.b;
    }
    if (cursor < s.len) pushWall(cursor, s.len);
  }
}

export function objectById(world, id) {
  return world.objects.find(o => o.id === id) || null;
}

export function buildingAt(world, x, y) {
  return world.buildings.find(b => pointInRect(x, y, b)) || null;
}

// 視線（立体）：目の高さ z0 から対象の高さ z1 への線が、物体の高さの範囲や床・天井を横切るか
export function hasLOS(world, x0, y0, x1, y1, ignoreId = null, z0 = EYE_H, z1 = BODY_H) {
  for (const o of world.objects) {
    if (!o.blocksSight || o.id === ignoreId) continue;
    const r = segRectRange(x0, y0, x1, y1, o);
    if (!r || r[1] <= 1e-4 || r[0] >= 1 - 1e-4) continue;
    // 始点・終点が物体内にある（壁に密着・植え込みの中）場合は除外
    if (pointInRect(x0, y0, o) || pointInRect(x1, y1, o)) continue;
    const za = z0 + (z1 - z0) * r[0], zb = z0 + (z1 - z0) * r[1];
    if (Math.max(za, zb) < o.z0 || Math.min(za, zb) > o.z1) continue; // 上か下を通り抜ける
    return false;
  }
  return !crossesSlab(world, x0, y0, z0, x1, y1, z1);
}

// 建物の床・天井（各階の高さの面）を、建物の内側で横切るか
export function crossesSlab(world, x0, y0, z0, x1, y1, z1) {
  for (const bd of world.buildings) {
    for (let k = 1; k <= bd.floors; k++) {
      const zs = k * FLOOR_H;
      if ((z0 - zs) * (z1 - zs) >= 0) continue;
      const t = (zs - z0) / (z1 - z0);
      if (pointInRect(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, bd)) return true;
    }
  }
  return false;
}

// 音の減衰：間にある壁の数で届く距離が縮む
export function soundFactor(world, x0, y0, x1, y1, z0 = EYE_H, z1 = EYE_H) {
  let f = 1;
  for (const o of world.objects) {
    if (o.soundDamp >= 1 || o.open || o.broken) continue; // 開いた扉・窓、割れた窓は音を遮らない
    const r = segRectRange(x0, y0, x1, y1, o);
    if (!r || r[1] <= 1e-4 || r[0] >= 1 - 1e-4) continue;
    const za = z0 + (z1 - z0) * r[0], zb = z0 + (z1 - z0) * r[1];
    if (Math.max(za, zb) < o.z0 || Math.min(za, zb) > o.z1) continue;
    f *= o.soundDamp;
  }
  // 階をまたぐ音は床で弱まる
  if (crossesSlab(world, x0, y0, z0, x1, y1, z1)) f *= 0.6;
  return f;
}

// ---------- 経路探索（内部的な航行グリッド。キャラクターの位置・移動は連続座標） ----------

const CELL = 0.4;

// 2階の床がある場所（2階建ての建物の内側）
export function upperFloorAt(world, x, y) {
  return world.buildings.find(bd => bd.floors >= 2 && x > bd.x + WALL_T && x < bd.x + bd.w - WALL_T && y > bd.y + WALL_T && y < bd.y + bd.h - WALL_T) || null;
}

export function rebuildNav(world, radius = 0.42) {
  const cols = Math.ceil(world.w / CELL);
  const rows = Math.ceil(world.h / CELL);
  world.navs = [0, 1].map(floor => {
    const blocked = new Uint8Array(cols * rows);
    const slow = new Float32Array(cols * rows).fill(1);
    if (floor === 1) {
      // 2階は建物の内側だけ歩ける
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!upperFloorAt(world, (c + 0.5) * CELL, (r + 0.5) * CELL)) blocked[r * cols + c] = 1;
        }
      }
    }
    for (const o of world.objects) {
      if (!o.blocksMove || o.floor !== floor || o.kind === 'door') continue;
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
    const slowRects = floor === 0 ? world.rubble.concat(world.objects.filter(o => o.kind === 'bush')) : [];
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
    return { cols, rows, blocked, slow };
  });
  world.nav = world.navs[0];
  world.navDirty = false;
}

function navOf(world, floor = 0) {
  if (world.navDirty || !world.navs) rebuildNav(world);
  return world.navs[floor] || world.navs[0];
}

export function isWalkablePoint(world, x, y, floor = 0) {
  const nav = navOf(world, floor);
  const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
  if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return false;
  return !nav.blocked[r * nav.cols + c];
}

function walkableLine(world, x0, y0, x1, y1, floor = 0) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(d / 0.15);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!isWalkablePoint(world, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, floor)) return false;
  }
  return true;
}

// 最寄りの歩行可能点
export function nearestWalkable(world, x, y, maxR = 3, floor = 0) {
  if (isWalkablePoint(world, x, y, floor)) return { x, y };
  for (let r = CELL; r <= maxR; r += CELL / 2) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
      const py = y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (isWalkablePoint(world, px, py, floor)) return { x: px, y: py };
    }
  }
  return null;
}

// 階をまたぐ経路：階段を経由する区間に分けて、それぞれの階で探索する。
// 返す点には階（f）が付き、階段の上り下りの点には stairTo が付く
export function findPath(world, sx, sy, tx, ty, sf = 0, tf = sf) {
  if (sf === tf && (sf === 0 || upperFloorAt(world, sx, sy) === upperFloorAt(world, tx, ty))) {
    return floorPath(world, sx, sy, tx, ty, sf);
  }
  const legs = [];
  let cur = { x: sx, y: sy, f: sf };
  if (sf === 1) {
    const bd = upperFloorAt(world, sx, sy);
    if (!bd || !bd.stairs) return null;
    const st = { x: bd.stairs.x + bd.stairs.w / 2, y: bd.stairs.y + bd.stairs.h / 2 };
    legs.push({ from: cur, to: { ...st, f: 1 }, stairTo: 0 });
    cur = { ...st, f: 0 };
  }
  if (tf === 1) {
    const bd = upperFloorAt(world, tx, ty);
    if (!bd || !bd.stairs) return floorPath(world, cur.x, cur.y, tx, ty, cur.f);
    const st = { x: bd.stairs.x + bd.stairs.w / 2, y: bd.stairs.y + bd.stairs.h / 2 };
    legs.push({ from: cur, to: { ...st, f: 0 }, stairTo: 1 });
    cur = { ...st, f: 1 };
  }
  legs.push({ from: cur, to: { x: tx, y: ty, f: tf } });
  const points = [];
  let partial = false;
  let length = 0;
  for (const leg of legs) {
    const p = floorPath(world, leg.from.x, leg.from.y, leg.to.x, leg.to.y, leg.from.f);
    if (!p) return points.length ? { points, partial: true, length } : null;
    points.push(...p.points);
    length += p.length;
    if (p.partial) { partial = true; break; }
    if (leg.stairTo !== undefined) points.push({ x: leg.to.x, y: leg.to.y, f: leg.from.f, stairTo: leg.stairTo });
  }
  return { points, partial, length };
}

// 1つの階の中の経路。A* で求め、視線の通る点を間引いて滑らかにする。
// 到達不能なら最も近づける点までの経路を partial=true で返す
function floorPath(world, sx, sy, tx, ty, floor = 0) {
  const nav = navOf(world, floor);
  const { cols, rows, blocked, slow } = nav;
  const idx = (c, r) => r * cols + c;
  const start = nearestWalkable(world, sx, sy, 1.5, floor);
  const goal = nearestWalkable(world, tx, ty, 2.5, floor);
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
  const pts = cells.map(k => ({ x: ((k % cols) + 0.5) * CELL, y: (Math.floor(k / cols) + 0.5) * CELL, f: floor }));
  if (found && goal) pts.push({ x: goal.x, y: goal.y, f: floor });
  else if (!pts.length) return null;

  // 間引き（ストリングプリング）
  const out = [];
  let i = 0;
  let cx = sx, cy = sy;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !walkableLine(world, cx, cy, pts[j].x, pts[j].y, floor)) j--;
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
