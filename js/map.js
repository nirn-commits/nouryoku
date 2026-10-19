// ランダムマップ生成（セルオートマトン＋連結チェック）
const MAP_W = 16;
const MAP_H = 12;

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}

function isBorder(x, y) {
  return x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
}

function countWalls8(tiles, x, y) {
  let n = 0;
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny) || tiles[ny][nx] === 'wall') n++;
  }
  return n;
}

function largestRegion(tiles) {
  const seen = tiles.map(row => row.map(() => false));
  let best = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (seen[y][x] || tiles[y][x] === 'wall') continue;
      const region = [];
      const stack = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx, ny = cy + dy;
          if (inBounds(nx, ny) && !seen[ny][nx] && tiles[ny][nx] !== 'wall') {
            seen[ny][nx] = true;
            stack.push([nx, ny]);
          }
        }
      }
      if (region.length > best.length) best = region;
    }
  }
  return best;
}

function generateMap() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let tiles = [];
    for (let y = 0; y < MAP_H; y++) {
      const row = [];
      for (let x = 0; x < MAP_W; x++) {
        row.push(isBorder(x, y) || Math.random() < 0.4 ? 'wall' : 'floor');
      }
      tiles.push(row);
    }

    for (let i = 0; i < 3; i++) {
      tiles = tiles.map((row, y) => row.map((_, x) => {
        if (isBorder(x, y)) return 'wall';
        return countWalls8(tiles, x, y) >= 5 ? 'wall' : 'floor';
      }));
    }

    const region = largestRegion(tiles);
    const interior = (MAP_W - 2) * (MAP_H - 2);
    if (region.length < interior * 0.6) continue;

    const keep = new Set(region.map(([x, y]) => `${x},${y}`));
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (!keep.has(`${x},${y}`)) tiles[y][x] = 'wall';
      }
    }

    // 瓦礫（移動コスト2・視線は通す）を散らす
    for (const [x, y] of region) {
      if (Math.random() < 0.08) tiles[y][x] = 'rubble';
    }

    const spawns = pickSpawns(tiles, region);
    return { tiles, spawns, region };
  }
  throw new Error('マップ生成に失敗しました');
}

// 四隅に最も近い床マスを出現地点にする
function pickSpawns(tiles, region) {
  const corners = [[1, 1], [MAP_W - 2, MAP_H - 2], [MAP_W - 2, 1], [1, MAP_H - 2]];
  const used = new Set();
  return corners.map(([cx, cy]) => {
    let best = null, bestD = Infinity;
    for (const [x, y] of region) {
      const key = `${x},${y}`;
      if (used.has(key) || tiles[y][x] !== 'floor') continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
    used.add(`${best[0]},${best[1]}`);
    return { x: best[0], y: best[1] };
  });
}

// ブレゼンハムで視線判定（壁のみ遮る）
function hasLOS(tiles, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === x1 && y === y1) break;
    if (tiles[y][x] === 'wall') return false;
  }
  return true;
}

function manhattan(x0, y0, x1, y1) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}
