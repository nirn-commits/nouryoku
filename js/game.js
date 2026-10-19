// ゲーム本体：状態管理・移動・戦闘処理
// 中断されたバトルの非同期処理を打ち切るため、待機明けにゲームが変わっていたら例外を投げる
class BattleAborted extends Error {}

function sleep(ms) {
  const game = G;
  return new Promise((resolve, reject) => setTimeout(() => {
    if (game && (game !== G || game.aborted)) reject(new BattleAborted());
    else resolve();
  }, ms));
}

window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof BattleAborted) e.preventDefault();
});

// UI 側で差し替える演出フック
const FX = {
  render() {},
  log() {},
  float() {},
  async cutin() {},
  async banner() {},
  onGameOver() {},
};

let G = null;

function deriveUnit(char, slot) {
  const s = {};
  for (const k in char.stats) s[k] = GRADE[char.stats[k]];
  const rangeTable = [0, 1, 2, 3, 4, 6];
  return {
    id: `u${slot.index}`,
    slot: slot.index,
    charId: char.id,
    char,
    name: char.name,
    stand: char.stand,
    color: char.color,
    glyph: char.glyph,
    isCPU: slot.isCPU,
    team: slot.team,
    s,
    maxHp: 70 + s.stamina * 10,
    hp: 70 + s.stamina * 10,
    move: 2 + Math.floor((s.speed + 1) / 2),
    range: rangeTable[s.range],
    dmg: 6 + s.power * 4,
    hit: 65 + s.precision * 6,
    crit: 3 + s.precision * 3,
    growthMul: 0.6 + s.growth * 0.2,
    gauge: 0,
    cd: 0,
    status: { stun: 0, invis: 0, reflect: 0, empower: false },
    alive: true,
    kills: 0,
    x: 0,
    y: 0,
  };
}

function newGame(slots, mode) {
  const map = generateMap();
  const units = slots.map(slot => deriveUnit(CHARACTERS.find(c => c.id === slot.charId), slot));
  const spawnOrder = shuffle(map.spawns.slice(0, 4));
  if (mode === 'team') {
    // チーム戦では味方同士を近い角に配置（0,2 / 1,3 が隣接する角）
    const byTeam = [units.filter(u => u.team === 0), units.filter(u => u.team === 1)];
    const cornerSets = Math.random() < 0.5 ? [[0, 2], [1, 3]] : [[1, 3], [0, 2]];
    byTeam.forEach((team, t) => team.forEach((u, i) => {
      const sp = map.spawns[cornerSets[t][i]];
      u.x = sp.x; u.y = sp.y;
    }));
  } else {
    units.forEach((u, i) => { u.x = spawnOrder[i].x; u.y = spawnOrder[i].y; });
  }

  G = {
    tiles: map.tiles,
    mode,
    units,
    items: [],
    traps: [],
    round: 1,
    order: [],
    turnIndex: -1,
    cur: null,
    over: false,
  };
  for (let i = 0; i < 4; i++) spawnItem();
  buildOrder();
  return G;
}

function buildOrder() {
  G.order = G.units
    .filter(u => u.alive)
    .map(u => ({ u, r: u.s.speed + Math.random() }))
    .sort((a, b) => b.r - a.r)
    .map(o => o.u);
}

function unitAt(x, y) {
  return G.units.find(u => u.alive && u.x === x && u.y === y) || null;
}

function itemAt(x, y) {
  return G.items.find(i => i.x === x && i.y === y) || null;
}

function trapAt(x, y) {
  return G.traps.find(t => t.x === x && t.y === y) || null;
}

function isEnemy(a, b) {
  if (a === b) return false;
  return G.mode === 'team' ? a.team !== b.team : true;
}

function isWalkable(x, y) {
  return inBounds(x, y) && G.tiles[y][x] !== 'wall';
}

function isEmptyTile(x, y) {
  return isWalkable(x, y) && !unitAt(x, y) && !itemAt(x, y) && !trapAt(x, y);
}

function spawnItem() {
  const cands = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (G.tiles[y][x] === 'floor' && isEmptyTile(x, y)) cands.push([x, y]);
    }
  }
  if (!cands.length) return;
  const [x, y] = cands[randInt(cands.length)];
  G.items.push({ x, y, type: Math.random() < 0.55 ? 'heal' : 'shard' });
}

// ダイクストラで到達可能マスを計算（瓦礫はコスト2、他ユニットは通れない）
function reachable(u, budget = u.move, ox = u.x, oy = u.y) {
  const dist = new Map();
  const prev = new Map();
  const key = (x, y) => `${x},${y}`;
  dist.set(key(ox, oy), 0);
  const open = [[0, ox, oy]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, x, y] = open.shift();
    if (d > dist.get(key(x, y))) continue;
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx, ny = y + dy;
      if (!isWalkable(nx, ny)) continue;
      const other = unitAt(nx, ny);
      if (other && other !== u) continue;
      const nd = d + (G.tiles[ny][nx] === 'rubble' ? 2 : 1);
      if (nd > budget) continue;
      const k = key(nx, ny);
      if (!dist.has(k) || nd < dist.get(k)) {
        dist.set(k, nd);
        prev.set(k, key(x, y));
        open.push([nd, nx, ny]);
      }
    }
  }
  return { dist, prev };
}

function pathTo(reach, x, y) {
  const path = [];
  let k = `${x},${y}`;
  while (reach.prev.has(k)) {
    const [px, py] = k.split(',').map(Number);
    path.unshift({ x: px, y: py });
    k = reach.prev.get(k);
  }
  return path;
}

function canTarget(attacker, target) {
  return target.alive && isEnemy(attacker, target) && target.status.invis <= 0;
}

function attackTargets(u, fx = u.x, fy = u.y) {
  return G.units.filter(t =>
    canTarget(u, t) &&
    manhattan(fx, fy, t.x, t.y) <= u.range &&
    hasLOS(G.tiles, fx, fy, t.x, t.y));
}

// ---------- ダメージ処理 ----------

function addGauge(u, amount) {
  if (!u.alive) return;
  u.gauge = Math.min(100, u.gauge + Math.floor(amount));
}

async function dealDamage(src, tgt, amount, opts = {}) {
  if (!tgt.alive) return 0;
  let dmg = Math.max(1, Math.round(amount));
  if (tgt.charId === 'go') dmg = Math.max(1, Math.round(dmg * 0.8));

  let reflected = 0;
  if (tgt.status.reflect > 0 && src && src !== tgt && !opts.noReflect) {
    reflected = dmg;
    dmg = Math.max(1, Math.round(dmg / 2));
  }

  tgt.hp = Math.max(0, tgt.hp - dmg);
  FX.float(tgt.x, tgt.y, `-${dmg}${opts.crit ? '!!' : ''}`, opts.crit ? 'crit' : 'dmg');
  if (src && src !== tgt) addGauge(src, dmg * 0.5 * src.growthMul);
  addGauge(tgt, dmg * 0.7 * tgt.growthMul);

  if (tgt.hp <= 0) {
    tgt.alive = false;
    if (src && src !== tgt) src.kills++;
    FX.log(`<b style="color:${tgt.color}">${tgt.name}</b> は再起不能（リタイヤ）！`, 'ko');
    FX.float(tgt.x, tgt.y, '再起不能', 'ko');
  }
  FX.render();

  if (reflected && src.alive) {
    FX.log(`『リバース・ペイン』！ 痛みが ${src.name} に返る！`);
    await sleep(250);
    await dealDamage(tgt, src, reflected, { noReflect: true });
  }
  return dmg;
}

function revealIfHidden(u) {
  if (u.status.invis > 0) {
    u.status.invis = 0;
    FX.log(`${u.name} の姿が現れた！`);
  }
}

// ---------- 行動 ----------

async function moveUnit(u, x, y) {
  const reach = reachable(u);
  if (!reach.dist.has(`${x},${y}`)) return false;
  const path = pathTo(reach, x, y);
  G.cur.moved = true;
  for (const step of path) {
    u.x = step.x; u.y = step.y;
    FX.render();
    await sleep(110);
    if (await checkTrap(u)) break;
  }
  pickupItem(u);
  FX.render();
  return true;
}

async function checkTrap(u) {
  const trap = trapAt(u.x, u.y);
  if (!trap || !u.alive) return false;
  const owner = G.units.find(o => o.id === trap.owner);
  if (owner && !isEnemy(owner, u)) return false;
  G.traps = G.traps.filter(t => t !== trap);
  FX.log(`${u.name} は『見えざる糸』に絡め取られた！`);
  await FX.cutin('見えざる糸', owner ? owner.color : '#fff');
  u.status.stun = Math.max(u.status.stun, 1);
  await dealDamage(owner, u, 18, { noReflect: true });
  return true;
}

function pickupItem(u) {
  const item = itemAt(u.x, u.y);
  if (!item || !u.alive) return;
  G.items = G.items.filter(i => i !== item);
  if (item.type === 'heal') {
    const before = u.hp;
    u.hp = Math.min(u.maxHp, u.hp + 30);
    FX.float(u.x, u.y, `+${u.hp - before}`, 'heal');
    FX.log(`${u.name} は包帯を拾い HP が ${u.hp - before} 回復した。`);
  } else {
    addGauge(u, 50);
    FX.float(u.x, u.y, 'ゲージ+50', 'heal');
    FX.log(`${u.name} は矢のかけらを拾い、ラッシュゲージが高まった！`);
  }
}

function rollHit(u, t, guaranteed) {
  if (guaranteed) return true;
  const chance = u.hit - Math.max(0, manhattan(u.x, u.y, t.x, t.y) - 1) * 3;
  return Math.random() * 100 < chance;
}

async function basicAttack(u, t) {
  G.cur.acted = true;
  const empowered = u.status.empower;
  u.status.empower = false;
  revealIfHidden(u);
  if (!rollHit(u, t, empowered)) {
    FX.float(t.x, t.y, 'MISS', 'miss');
    FX.log(`${u.name} の攻撃は ${t.name} に外れた。`);
    FX.render();
    return;
  }
  const crit = empowered || Math.random() * 100 < u.crit;
  const dmg = u.dmg * (0.85 + Math.random() * 0.3) * (crit ? 1.6 : 1);
  FX.log(`${u.name} の『${u.stand}』が ${t.name} を攻撃！${crit ? ' 会心！' : ''}`);
  await dealDamage(u, t, dmg, { crit });
}

async function rushAttack(u, t) {
  G.cur.acted = true;
  u.gauge = 0;
  u.status.empower = false;
  revealIfHidden(u);
  await FX.cutin(`${u.stand}・ラッシュ`, u.color, true);
  FX.log(`${u.name} のラッシュ！！`);
  for (let i = 0; i < 4 && t.alive && u.alive; i++) {
    const crit = Math.random() * 100 < u.crit;
    await dealDamage(u, t, u.dmg * 0.6 * (crit ? 1.6 : 1), { crit });
    await sleep(160);
  }
}

async function useAbility(u, x, y) {
  const ab = ABILITIES[u.char.ability.id];
  G.cur.acted = true;
  u.cd = u.char.ability.cooldown;
  await FX.cutin(u.char.ability.name, u.color);
  await ab.execute(u, x, y);
  FX.render();
}

function abilityTargets(u, fx = u.x, fy = u.y) {
  return ABILITIES[u.char.ability.id].targets(u, fx, fy);
}

// ---------- ターン進行 ----------

function aliveSides() {
  const alive = G.units.filter(u => u.alive);
  if (G.mode === 'team') return new Set(alive.map(u => u.team));
  return new Set(alive.map(u => u.id));
}

function checkGameOver() {
  if (G.over) return true;
  const sides = aliveSides();
  if (sides.size <= 1) {
    G.over = true;
    const winners = G.units.filter(u => u.alive);
    FX.onGameOver(winners);
    return true;
  }
  return false;
}

function currentUnit() {
  return G.order[G.turnIndex];
}

async function nextTurn() {
  if (checkGameOver()) return;
  G.turnIndex++;
  if (G.turnIndex >= G.order.length) {
    G.round++;
    G.turnIndex = 0;
    buildOrder();
    if (G.items.length < 4 && Math.random() < 0.6) spawnItem();
    FX.log(`―― 第${G.round}ラウンド ――`, 'round');
  }
  const u = currentUnit();
  if (!u || !u.alive) return nextTurn();

  G.cur = { unit: u, moved: false, acted: false };
  if (u.status.invis > 0) u.status.invis--;
  if (u.status.reflect > 0) u.status.reflect--;
  FX.render();

  if (u.status.stun > 0) {
    u.status.stun--;
    await FX.banner(u, '行動不能…！');
    FX.log(`${u.name} は動けない！`);
    return endTurn();
  }

  await FX.banner(u);
  if (u.isCPU) {
    await runAI(u);
    if (!G.over) await endTurn();
  }
}

async function endTurn() {
  const u = G.cur && G.cur.unit;
  if (u && u.cd > 0) u.cd--;
  G.cur = null;
  FX.render();
  if (checkGameOver()) return;
  await sleep(200);
  await nextTurn();
}
