// CPU 思考ルーチン：到達可能マスごとに「その場で取れる最善行動＋位置評価」を採点する
function enemyDistanceField(u) {
  const field = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(Infinity));
  const queue = [];
  for (const e of G.units) {
    if (canTarget(u, e)) {
      field[e.y][e.x] = 0;
      queue.push([e.x, e.y]);
    }
  }
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx, ny = y + dy;
      if (isWalkable(nx, ny) && field[ny][nx] === Infinity) {
        field[ny][nx] = field[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }
  return field;
}

function bestActionAt(u, fx, fy) {
  let best = null;
  const consider = c => { if (c && (!best || c.score > best.score)) best = c; };

  const targets = attackTargets(u, fx, fy);
  for (const t of targets) {
    const dist = manhattan(fx, fy, t.x, t.y);
    const hitRate = u.status.empower ? 1 : Math.min(1, (u.hit - Math.max(0, dist - 1) * 3) / 100);
    const mult = u.status.empower ? 1.6 : 1;
    consider({ kind: 'attack', score: estDamage(u, t, mult) * hitRate, x: t.x, y: t.y });
    if (u.gauge >= 100) consider({ kind: 'rush', score: estDamage(u, t, 2.4) + 4, x: t.x, y: t.y });
  }

  if (u.cd <= 0) {
    const ab = ABILITIES[u.char.ability.id].ai(u, fx, fy);
    if (ab) consider({ kind: 'ability', ...ab });
  }
  return best;
}

function planAI(u) {
  const reach = reachable(u);
  const field = enemyDistanceField(u);
  const threats = G.units.filter(e => canTarget(u, e));
  let best = null;

  for (const k of reach.dist.keys()) {
    const [x, y] = k.split(',').map(Number);
    const act = bestActionAt(u, x, y);
    let score = act ? act.score : 0;

    const item = itemAt(x, y);
    if (item) {
      if (item.type === 'heal' && u.hp < u.maxHp - 10) score += 12 + (u.hp < u.maxHp * 0.4 ? 10 : 0);
      if (item.type === 'shard' && u.gauge < 100) score += 9;
    }

    let danger = 0;
    for (const e of threats) {
      if (manhattan(x, y, e.x, e.y) <= e.move + e.range) danger += e.dmg * 0.15;
    }
    const caution = u.hp < u.maxHp * 0.35 ? 2 : 1;
    score -= danger * caution;

    const d = field[y][x];
    const approach = d === Infinity ? 0 : Math.max(0, d - u.range);
    score -= Math.min(approach, 40) * 1.2;

    score += Math.random() * 0.5;
    if (!best || score > best.score) best = { score, x, y };
  }
  return best;
}

async function runAI(u) {
  await sleep(300);
  const plan = planAI(u);
  if (plan && (plan.x !== u.x || plan.y !== u.y)) {
    await moveUnit(u, plan.x, plan.y);
    await sleep(150);
  }
  if (!u.alive || G.over) return;

  // 移動後（罠などで位置が変わる可能性あり）の位置で改めて最善行動を選ぶ
  const act = bestActionAt(u, u.x, u.y);
  if (!act) return;
  if (act.kind === 'attack') await basicAttack(u, unitAt(act.x, act.y));
  else if (act.kind === 'rush') await rushAttack(u, unitAt(act.x, act.y));
  else await useAbility(u, act.x, act.y);
  await sleep(250);
  checkGameOver();
}
