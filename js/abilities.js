// スタンド能力：対象マス列挙・実行・CPU評価
function tilesWithin(fx, fy, r, pred) {
  const out = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const d = manhattan(fx, fy, x, y);
      if (d > 0 && d <= r && pred(x, y)) out.push({ x, y });
    }
  }
  return out;
}

function enemiesAround8(u, x, y) {
  return DIRS8
    .map(([dx, dy]) => unitAt(x + dx, y + dy))
    .filter(t => t && t.alive && isEnemy(u, t));
}

// 指定方向へ壁まで（最大 len マス）の直線マス
function lineTiles(fx, fy, dx, dy, len) {
  const out = [];
  for (let i = 1; i <= len; i++) {
    const x = fx + dx * i, y = fy + dy * i;
    if (!inBounds(x, y) || G.tiles[y][x] === 'wall') break;
    out.push({ x, y });
  }
  return out;
}

function estDamage(u, t, mult) {
  let d = u.dmg * mult;
  if (t.charId === 'go') d *= 0.8;
  return d + (d >= t.hp ? 30 : 0);
}

// 敵が見えない（透明）かどうかを考慮した、敵ユニット判定
function hitsEnemy(u, t, self) {
  return t && t !== self && t.alive && isEnemy(u, t);
}

const ABILITIES = {
  silentFist: {
    targets(u, fx, fy) {
      return G.units.filter(t => canTarget(u, t) && manhattan(fx, fy, t.x, t.y) === 1)
        .map(t => ({ x: t.x, y: t.y }));
    },
    async execute(u, x, y) {
      const t = unitAt(x, y);
      revealIfHidden(u);
      await dealDamage(u, t, u.dmg * 1.5);
      if (!t.alive) return;
      const dx = Math.sign(t.x - u.x), dy = Math.sign(t.y - u.y);
      let pushed = 0;
      for (let i = 0; i < 2; i++) {
        const nx = t.x + dx, ny = t.y + dy;
        if (!isWalkable(nx, ny) || unitAt(nx, ny)) {
          FX.log(`${t.name} は激突した！`);
          await dealDamage(u, t, 10);
          const other = unitAt(nx, ny);
          if (other && t.alive) await dealDamage(u, other, 10);
          break;
        }
        t.x = nx; t.y = ny; pushed++;
        FX.render();
        await sleep(120);
        if (await checkTrap(t)) break;
      }
      if (t.alive) pickupItem(t);
      if (pushed) FX.log(`${t.name} は ${pushed} マス吹き飛ばされた！`);
    },
    ai(u, fx, fy) {
      let best = null;
      for (const p of this.targets(u, fx, fy)) {
        const t = unitAt(p.x, p.y);
        const score = estDamage(u, t, 1.5) + 6;
        if (!best || score > best.score) best = { score, ...p };
      }
      return best;
    },
  },

  glassBullet: {
    targets(u, fx, fy) {
      return DIRS4.flatMap(([dx, dy]) => lineTiles(fx, fy, dx, dy, 7));
    },
    async execute(u, x, y) {
      const dx = Math.sign(x - u.x), dy = Math.sign(y - u.y);
      revealIfHidden(u);
      const line = lineTiles(u.x, u.y, dx, dy, 7);
      let hitAny = false;
      for (const p of line) {
        FX.float(p.x, p.y, '◆', 'shot');
        const t = unitAt(p.x, p.y);
        if (t && canTarget(u, t)) {
          hitAny = true;
          await dealDamage(u, t, u.dmg * 1.1);
        }
        await sleep(50);
      }
      if (!hitAny) FX.log('硝子の弾丸は誰にも当たらなかった。');
    },
    ai(u, fx, fy) {
      let best = null;
      for (const [dx, dy] of DIRS4) {
        const line = lineTiles(fx, fy, dx, dy, 7);
        let score = 0;
        for (const p of line) {
          const t = unitAt(p.x, p.y);
          if (hitsEnemy(u, t, u) && canTarget(u, t)) score += estDamage(u, t, 1.1);
        }
        if (score > 0 && line.length && (!best || score > best.score)) {
          best = { score: score + 4, ...line[0] };
        }
      }
      return best;
    },
  },

  stoneWall: {
    targets(u, fx, fy) {
      return tilesWithin(fx, fy, 4, (x, y) => {
        if (isBorder(x, y)) return false;
        if (G.tiles[y][x] === 'wall') return true;
        return !unitAt(x, y) && !itemAt(x, y) && !(x === fx && y === fy);
      });
    },
    async execute(u, x, y) {
      if (G.tiles[y][x] === 'wall') {
        G.tiles[y][x] = 'rubble';
        FX.log(`${u.name} は岩壁を粉砕した！`);
      } else {
        G.tiles[y][x] = 'wall';
        G.traps = G.traps.filter(t => !(t.x === x && t.y === y));
        FX.log(`${u.name} の足元から岩壁が隆起する！`);
      }
      FX.float(x, y, 'ドゴォ', 'sfx');
      FX.render();
      for (const t of enemiesAround8(u, x, y)) {
        await dealDamage(u, t, 14);
      }
    },
    ai(u, fx, fy) {
      let best = null;
      for (const p of this.targets(u, fx, fy)) {
        const hits = enemiesAround8(u, p.x, p.y);
        if (!hits.length) continue;
        const score = hits.reduce((s, t) => s + estDamage({ dmg: 14 }, t, 1), 0) + 2;
        if (!best || score > best.score) best = { score, ...p };
      }
      return best;
    },
  },

  nightVeil: {
    targets(u, fx, fy) {
      return [{ x: fx, y: fy }];
    },
    async execute(u) {
      u.status.invis = 2;
      u.status.empower = true;
      FX.log(`${u.name} は闇に溶けて姿を消した……`);
    },
    ai(u, fx, fy) {
      if (u.status.invis > 0 || u.status.empower) return null;
      return { score: 13, x: fx, y: fy };
    },
  },

  delay: {
    targets(u, fx, fy) {
      return G.units
        .filter(t => canTarget(u, t) && manhattan(fx, fy, t.x, t.y) <= 4 && hasLOS(G.tiles, fx, fy, t.x, t.y))
        .map(t => ({ x: t.x, y: t.y }));
    },
    async execute(u, x, y) {
      const t = unitAt(x, y);
      revealIfHidden(u);
      t.status.stun = Math.max(t.status.stun, 1);
      FX.float(t.x, t.y, '遅延', 'sfx');
      FX.log(`${t.name} の時間が遅れる！ 次のターンは動けない！`);
      await dealDamage(u, t, 6);
    },
    ai(u, fx, fy) {
      let best = null;
      for (const p of this.targets(u, fx, fy)) {
        const t = unitAt(p.x, p.y);
        if (t.status.stun > 0) continue;
        const score = 10 + t.dmg * 0.8 + estDamage({ dmg: 6 }, t, 1);
        if (!best || score > best.score) best = { score, ...p };
      }
      return best;
    },
  },

  reversePain: {
    targets(u, fx, fy) {
      return [{ x: fx, y: fy }];
    },
    async execute(u) {
      u.status.reflect = 2;
      FX.log(`${u.name} の身体を茨が覆う。痛みは全て返される！`);
    },
    ai(u, fx, fy) {
      if (u.status.reflect > 0) return null;
      const near = G.units.filter(t => t.alive && isEnemy(u, t) && manhattan(fx, fy, t.x, t.y) <= 7);
      if (!near.length) return null;
      return { score: 10 + near.length * 4 + (u.hp < u.maxHp * 0.7 ? 6 : 0), x: fx, y: fy };
    },
  },

  ghostWire: {
    targets(u, fx, fy) {
      return tilesWithin(fx, fy, 5, (x, y) => isEmptyTile(x, y));
    },
    async execute(u, x, y) {
      const mine = G.traps.filter(t => t.owner === u.id);
      if (mine.length >= 3) G.traps = G.traps.filter(t => t !== mine[0]);
      G.traps.push({ x, y, owner: u.id });
      FX.log(`${u.name} はどこかに糸を張った……`);
    },
    ai(u, fx, fy) {
      let best = null;
      const enemies = G.units.filter(t => t.alive && isEnemy(u, t));
      for (const p of this.targets(u, fx, fy)) {
        // 敵に近い通り道ほど高評価
        let score = 0;
        for (const e of enemies) {
          const d = manhattan(p.x, p.y, e.x, e.y);
          if (d >= 1 && d <= 2) score += 5 - d;
        }
        if (score > 0) {
          score += 4;
          if (!best || score > best.score) best = { score, ...p };
        }
      }
      return best;
    },
  },

  mirrorSwap: {
    targets(u, fx, fy) {
      return G.units
        .filter(t => t.alive && t !== u && manhattan(fx, fy, t.x, t.y) <= 6 && (!isEnemy(u, t) || t.status.invis <= 0))
        .map(t => ({ x: t.x, y: t.y }));
    },
    async execute(u, x, y) {
      const t = unitAt(x, y);
      const [ux, uy] = [u.x, u.y];
      u.x = t.x; u.y = t.y;
      t.x = ux; t.y = uy;
      FX.float(u.x, u.y, '⇄', 'sfx');
      FX.float(t.x, t.y, '⇄', 'sfx');
      FX.log(`${u.name} と ${t.name} の位置が入れ替わった！`);
      FX.render();
      if (isEnemy(u, t)) {
        revealIfHidden(u);
        await dealDamage(u, t, 10);
      }
      if (t.alive) await checkTrap(t);
    },
    ai(u, fx, fy) {
      let best = null;
      for (const p of this.targets(u, fx, fy)) {
        const t = unitAt(p.x, p.y);
        if (!isEnemy(u, t)) continue;
        // 入れ替え後の自分の位置から攻撃できる敵がいるか
        const after = G.units.filter(o => o !== t && canTarget(u, o) && manhattan(p.x, p.y, o.x, o.y) <= u.range);
        const score = estDamage({ dmg: 10 }, t, 1) + after.length * 3;
        if (!best || score > best.score) best = { score, ...p };
      }
      return best;
    },
  },
};
