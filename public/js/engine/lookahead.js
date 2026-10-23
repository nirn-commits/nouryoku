// 先読み：いくつかの計画の候補を、盤面の写しの上で数秒先まで試し、結果の良いものを選ぶ。
// 公平さのため、写しの中の敵は「自分が知っている場所」に置く（見えていない敵の本当の位置は使わない）。
// 相手が何をするかは分からないので、相手の出方を何通りか想定し（いつもどおり／一気に詰める・離れる／能力で攻める）、
// 平均と最悪の場合の両方で良い案を選ぶ
import { compilePlan } from './plan.js';
import { dist } from './vec.js';

const HORIZON = 6; // 何秒先まで試すか
const BUDGET_MS = 1500; // 1回の判断にかける時間の上限（普段は候補を全部試し切る）

// 自分の知識だけで作った写し
function imagine(b, c, seed) {
  const f = b.fork(seed);
  const fc = f.chars.find(x => x.id === c.id);
  for (const e of b.enemiesOf(c)) {
    if (!e.alive) continue;
    const fe = f.chars.find(x => x.id === e.id);
    if (b.canSee(c, e.x, e.y)) continue;
    const rec = c.memory.seen[e.id];
    let p = rec && b.t - rec.t < 15 ? rec : null;
    if (!p) {
      // 居場所の見当がつかない敵は、遠くにいるものとして扱う
      const corners = [[2, 2], [f.world.w - 2, 2], [2, f.world.h - 2], [f.world.w - 2, f.world.h - 2]];
      const [x, y] = corners.sort((a, z) => dist(z[0], z[1], fc.x, fc.y) - dist(a[0], a[1], fc.x, fc.y))[0];
      p = { x, y, floor: 0 };
    }
    fe.x = p.x; fe.y = p.y; fe.floor = p.floor ?? 0;
    fe.vx = fe.vy = fe.kbx = fe.kby = 0;
    fe.air = null; fe.launch = null; fe.climb = null;
    if (fe.standBody) { fe.standBody.x = fe.x; fe.standBody.y = fe.y; fe.standBody.floor = fe.floor; }
  }
  return { f, fc };
}

function score(b, c, f, fc) {
  let s = 0;
  for (const o of b.chars) {
    const fo = f.chars.find(x => x.id === o.id);
    const lost = o.hp - fo.hp;
    if (o.team === c.team) {
      s -= lost * (o.id === c.id ? 1.2 : 1);
      if (o.alive && !fo.alive) s -= 60;
    } else {
      s += lost;
      if (o.alive && !fo.alive) s += 45;
    }
  }
  if (!fc.alive) return s;
  if (f.outsideZone(fc, f.t + 5)) s -= 8;
  const foes = f.enemiesOf(fc).filter(e => e.alive);
  if (foes.length) {
    const d = Math.min(...foes.map(e => dist(fc.x, fc.y, e.x, e.y)));
    const role = c.def.role;
    // 遠距離型：間合いを保つほど良く、4mより内側に入られているのは大きく減点
    if (role === 'ranged') s += 0.6 * Math.min(d, c.def.keepDistance || 10) - (d < 4 ? 4 * (4 - d) : 0);
    else if (role === 'mid') s -= 0.3 * Math.abs(d - (c.def.keepDistance || 4.5));
    else s -= 0.25 * Math.min(d, 15);
  }
  s += 0.04 * fc.sp;
  return s;
}

// planner(b, c) は簡易思考。alternatives(b, c) は試してみる別案の一覧。
// 候補を1つ試すごとに yieldFn を呼ぶ（画面を止めないよう、非同期版では一息つく）
function* search(b, c, planner, alternatives) {
  const pe = b.perceivedEnemy(c);
  const base = planner(b, c);
  if (!pe || !base.steps || b.isSim) return base;
  const t0 = performance.now();
  const seed = 104729 + Math.floor(b.t * 10);
  // 自分以外の動きは一度だけ考えて、どの候補にも同じものを使う。
  // 敵の出方は何通りか想定する：いつもどおり（簡易思考）／一気に詰める（遠距離型なら離れる）／能力で攻める
  const { f: f0 } = imagine(b, c, seed);
  const others = new Map(f0.chars.filter(o => o.alive && o.id !== c.id).map(o => [o.id, planner(f0, o)]));
  const models = [others];
  const nModels = globalThis.LOOK_MODELS ?? 3;
  const foes = f0.chars.filter(o => o.alive && o.team !== c.team);
  if (nModels >= 2 && foes.length) {
    const m = new Map(others);
    for (const o of foes) {
      m.set(o.id, o.def.role === 'ranged'
        ? { interpretation: '離れる', speech: null, steps: [{ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 8 }, { action: 'look', targetType: 'enemy' }] }
        : { interpretation: '詰めてくる', speech: null, steps: [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] });
    }
    models.push(m);
  }
  if (nModels >= 3 && foes.length) {
    const m = new Map(others);
    let changed = false;
    for (const o of foes) {
      const ope = f0.perceivedEnemy(o);
      const alt = ope && alternatives(f0, o, ope).find(a => a.steps.some(st => st.action === 'ability'));
      if (alt) { m.set(o.id, alt); changed = true; }
    }
    if (changed) models.push(m);
  }
  const cands = [base];
  // 同じ考え方でも乱数で変わる別の案と、型どおりの別案
  for (let k = 1; k <= 2; k++) {
    const { f, fc } = imagine(b, c, 7919 * k + Math.floor(b.t * 10));
    const alt = planner(f, fc);
    if (alt.steps && alt.steps.length) cands.push(alt);
  }
  for (const alt of alternatives(b, c, pe)) cands.push(alt);
  let best = null;
  const budget = globalThis.LOOK_BUDGET ?? BUDGET_MS;
  for (const raw of cands) {
    if (best && performance.now() - t0 > budget) break;
    const scores = [];
    for (const model of models) {
      const { f, fc } = imagine(b, c, seed);
      for (const o of f.chars) if (o.alive && o !== fc && model.has(o.id)) f.setPlan(o, compilePlan(f, o, model.get(o.id), 'local'));
      const plan = compilePlan(f, fc, raw, 'local');
      if (!plan.steps.length) break;
      f.setPlan(fc, plan);
      const end = f.t + HORIZON;
      // 早く終わる案が得をしないよう、どの案も同じ秒数だけ進める（終わった人はその場で待つ）
      while (f.t < end && !f.over) f.step();
      scores.push(score(b, c, f, fc));
      yield;
    }
    if (scores.length < models.length) continue;
    // 平均と最悪の場合を半々で見る（読みが外れても大崩れしない案を選ぶ）
    const mean = scores.reduce((a, z) => a + z, 0) / scores.length;
    const sc = models.length > 1 ? 0.5 * mean + 0.5 * Math.min(...scores) : mean;
    if (!best || sc > best.sc) best = { raw, sc };
  }
  if (best && best.raw !== base) best.raw.interpretation = `${best.raw.interpretation}（先読みで選んだ案）`;
  return best ? best.raw : base;
}

export function lookaheadPlan(b, c, planner, alternatives) {
  const it = search(b, c, planner, alternatives);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// 非同期版：候補を1つ試すごとに描画へ譲る（ブラウザで入力中に考える時に使う）
export async function lookaheadPlanAsync(b, c, planner, alternatives) {
  const it = search(b, c, planner, alternatives);
  let r = it.next();
  while (!r.done) {
    await new Promise(res => setTimeout(res, 0));
    r = it.next();
  }
  return r.value;
}
