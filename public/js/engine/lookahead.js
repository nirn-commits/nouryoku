// 先読み：いくつかの計画の候補を、盤面の写しの上で数秒先まで試し、結果の良いものを選ぶ。
// 公平さのため、写しの中の敵は「自分が知っている場所」に置く（見えていない敵の本当の位置は使わない）。
// 相手が何をするかは分からないので、相手の出方を何通りか想定し（いつもどおり／一気に詰める／離れる／能力で攻める）、
// 平均と最悪の場合の両方で良い案を選ぶ。
// さらに戦いながら学ぶ：
//  ・相手の癖（詰めてくる・離れる・能力をよく使う）を見て、想定する出方の重みを変える
//  ・選んだ案の「見込み」と「実際の結果」の差を覚えておき、見込み違いだった型の案は割り引く
import { compilePlan } from './plan.js';
import { dist } from './vec.js';
import { scoreWeights } from './persona.js';

const HORIZON = 6; // 何秒先まで試すか
const BUDGET_MS = 2000; // 1回の判断にかける時間の上限（普段は候補を全部試し切る）

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

// 体力のやり取り（与えた・受けた・倒した・倒された）の点
function hpScore(c, before, after, w) {
  let s = 0;
  for (const o of before) {
    const fo = after.find(x => x.id === o.id);
    if (!fo) continue;
    const lost = o.hp - fo.hp;
    if (o.team === c.team) {
      s -= lost * (o.id === c.id ? w.taken : 1);
      if (o.alive && !fo.alive) s -= 60;
    } else {
      s += lost * w.dealt;
      if (o.alive && !fo.alive) s += 45;
    }
  }
  return s;
}

// 終わった時の形勢（間合い・体勢・安全地帯・エネルギー）の点
function positionScore(c, f, fc) {
  if (!fc.alive) return 0;
  let s = 0;
  if (f.outsideZone(fc, f.t + 5)) s -= 8;
  const down = x => x.status.proneUntil > f.t || x.status.stunUntil > f.t || x.air || x.launch;
  if (down(fc)) s -= 3;
  const foes = f.enemiesOf(fc).filter(e => e.alive);
  if (foes.length) {
    const near = foes.reduce((m, e) => (dist(fc.x, fc.y, e.x, e.y) < dist(fc.x, fc.y, m.x, m.y) ? e : m));
    const d = dist(fc.x, fc.y, near.x, near.y);
    const role = c.def.role;
    // 遠距離型：間合いを保つほど良く、4mより内側に入られているのは大きく減点
    if (role === 'ranged') s += 0.6 * Math.min(d, c.def.keepDistance || 10) - (d < 4 ? 4 * (4 - d) : 0);
    else if (role === 'mid') s -= 0.3 * Math.abs(d - (c.def.keepDistance || 4.5));
    else s -= 0.25 * Math.min(d, 15);
    // 倒れている・痺れている敵がそばにいれば、次の手で殴れる
    if (down(near)) s += role === 'ranged' ? 1.5 : d < 3 ? 4 : 2;
  }
  s += 0.04 * fc.sp;
  return s;
}

// 能力の仕込み具合：すぐにはダメージにならないが、次の手で能力が生きる形になっているか。
// （数秒先までの試しでは見えない「能力の生かし方」を点にする。相手の仕込みは同じだけ減点）
function setupValue(f, x) {
  if (!x.alive) return 0;
  let v = 0;
  const foes = f.enemiesOf(x).filter(e => e.alive);
  const ab = x.def.abilities;
  if (ab.includes('hotel')) {
    // 錠二：相手と同じ建物の中で、出口を閉めていくほど良い。密室が成立していれば大きく加点
    const bd = f.buildingOf(x);
    if (bd && foes.some(e => f.buildingOf(e) === bd)) {
      const closed = bd.exits.filter(id => !f.exitOpen(id)).length / Math.max(1, bd.exits.length);
      v += bd.sealed && bd.sealed.by === x.id ? 14 : 5 * closed;
    }
  }
  if (ab.includes('echo') && x.units) {
    // 七海：集めた大きな音（決め技の材料）と、自分の足音を消す個体
    const loud = x.units.filter(u => u.state !== 'dead' && f.isLoud(u.sound)).length;
    v += 2.5 * Math.min(loud, 5);
    if (x.units.some(u => u.state === 'attached' && u.attachedTo === x.id)) v += 2;
  }
  if (x.mouths) {
    // 御厨：敵の体に残した口（噛みつき続けられる）
    v += 7 * Math.min(2, x.mouths.filter(m => foes.some(e => e.id === m.on)).length);
  }
  if (ab.includes('vacant')) {
    // 蛇穴院：仕込んだ床（踏めば抜ける）
    v += 2 * Math.min(2, f.world.zones.filter(z => z.kind === 'powder_trap' && z.owner === x.id).length);
  }
  if (ab.includes('seventh')) {
    // 鷺沼：撃つ玉が残っているか（尽きたら何もできない）
    v += 0.15 * Math.min(x.balls ?? 0, 20);
  }
  if (ab.includes('perpendicular')) {
    // 十河：叩きつけられる面のそばに相手がいる（弾き出しが決まる形）
    for (const e of foes) {
      if (dist(x.x, x.y, e.x, e.y) > 3) continue;
      if (f.world.objects.some(o => o.blocksMove && o.floor === e.floor && Math.abs(o.x + o.w / 2 - e.x) < o.w / 2 + 6 && Math.abs(o.y + o.h / 2 - e.y) < o.h / 2 + 6)) { v += 2; break; }
    }
  }
  // データで追加した能力：かかっている強化
  if (x.buffs && x.buffs.length) v += 1.5 * x.buffs.filter(bf => bf.until > f.t).length;
  return v;
}

// 案の「型」（数字を除いた説明）。見込み違いを覚える単位
const planKey = raw => (raw.interpretation || '').replace(/（先読みで選んだ案）/g, '').replace(/[0-9.]+/g, '#');

// 前の判断からの間に、相手が何をしてきたかを見て癖を覚える
function observe(b, c, pe, w) {
  const m = c.aiLook || (c.aiLook = { style: { rush: 0, away: 0, ability: 0 }, err: {}, prev: null });
  const prev = m.prev;
  if (prev) {
    // 相手の動き：自分の方へ寄ってきたか、離れたか
    if (pe && pe.visible && prev.foe && prev.foe.id === pe.char.id) {
      const ux = prev.me.x - prev.foe.x, uy = prev.me.y - prev.foe.y, ul = Math.hypot(ux, uy) || 1;
      const toward = ((pe.x - prev.foe.x) * ux + (pe.y - prev.foe.y) * uy) / ul;
      for (const k of Object.keys(m.style)) m.style[k] *= 0.8;
      if (toward > 2) m.style.rush += 1;
      else if (toward < -2) m.style.away += 1;
    }
    const used = b.log.filter(l => l.t > prev.t && l.kind === 'ability' && l.actor && l.actor !== c.id && l.visibleTo.has(c.id) && b.enemiesOf(c).some(e => e.id === l.actor)).length;
    if (used) m.style.ability += Math.min(2, used);
    // 見込み違い：選んだ案の体力のやり取りの見込みと、実際の結果の差
    const elapsed = Math.max(0.5, b.t - prev.t);
    const actual = hpScore(c, prev.hp, b.chars, prev.w) * Math.min(1, HORIZON / elapsed);
    const e = actual - prev.predicted;
    const old = m.err[prev.key];
    m.err[prev.key] = old === undefined ? e : old * 0.5 + e * 0.5;
  }
  return m;
}

function remember(b, c, m, pe, best, w) {
  m.prev = {
    t: b.t,
    key: best ? planKey(best.raw) : '',
    predicted: best ? best.hp : 0,
    hp: b.chars.map(o => ({ id: o.id, team: o.team, hp: o.hp, alive: o.alive })),
    w: { dealt: w.dealt, taken: w.taken },
    me: { x: c.x, y: c.y },
    foe: pe && pe.visible ? { id: pe.char.id, x: pe.x, y: pe.y } : null,
  };
}

const rushPlan = { interpretation: '詰めてくる', speech: null, steps: [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] };
const awayPlan = { interpretation: '離れる', speech: null, steps: [{ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 8 }, { action: 'look', targetType: 'enemy' }] };

// planner(b, c) は簡易思考。alternatives(b, c) は試してみる別案の一覧。
// 候補を1つ試すごとに yieldFn を呼ぶ（画面を止めないよう、非同期版では一息つく）
function* search(b, c, planner, alternatives) {
  const pe = b.perceivedEnemy(c);
  const base = planner(b, c);
  if (b.isSim) return base;
  if (!pe || !base.steps) { if (c.aiLook) c.aiLook.prev = null; return base; }
  const t0 = performance.now();
  const seed = 104729 + Math.floor(b.t * 10);
  // 性格と今の気分で採点の重みを変える（攻め気・用心深さ・博打好き）
  const w = globalThis.LOOK_NOPERSONA ? { dealt: 1, taken: 1.2, gamble: 0.5 } : scoreWeights(b, c);
  const mem = observe(b, c, pe, w);
  const st = mem.style;
  // 自分以外の動きは一度だけ考えて、どの候補にも同じものを使う。
  // 敵の出方は何通りか想定する：いつもどおり（簡易思考）／一気に詰める／離れる／能力で攻める。
  // 想定の重みは、ここまでに見た相手の癖で変える
  const { f: f0 } = imagine(b, c, seed);
  const others = new Map(f0.chars.filter(o => o.alive && o.id !== c.id).map(o => [o.id, planner(f0, o)]));
  const models = [{ plans: others, weight: 1 }];
  // 想定を変えるのは近くの敵だけ（大人数の戦いで、遠くの敵まで一斉に詰めてくる想定にはしない）
  const foes = f0.chars.filter(o => o.alive && o.team !== c.team && dist(o.x, o.y, c.x, c.y) < 20);
  const nModels = globalThis.LOOK_MODELS ?? 4;
  if (nModels >= 2 && foes.length) {
    const m = new Map(others);
    for (const o of foes) m.set(o.id, o.def.role === 'ranged' ? awayPlan : rushPlan);
    models.push({ plans: m, weight: 0.6 + (foes.some(o => o.def.role === 'ranged') ? st.away : st.rush) });
  }
  if (nModels >= 3 && foes.length) {
    const m = new Map(others);
    let changed = false;
    for (const o of foes) {
      const ope = f0.perceivedEnemy(o);
      const alt = ope && alternatives(f0, o, ope).find(a => a.steps.some(s => s.action === 'ability'));
      if (alt) { m.set(o.id, alt); changed = true; }
    }
    if (changed) models.push({ plans: m, weight: 0.6 + st.ability });
  }
  // 癖として見えてきた逆の出方（遠距離型が詰めてくる・近接型が離れる）も想定に入れる
  if (nModels >= 4 && foes.length) {
    const ranged = foes.some(o => o.def.role === 'ranged');
    const k = ranged ? st.rush : st.away;
    if (k > 0.9) {
      const m = new Map(others);
      for (const o of foes) m.set(o.id, ranged ? rushPlan : awayPlan);
      models.push({ plans: m, weight: 0.3 + k });
    }
  }
  const wsum = models.reduce((a, z) => a + z.weight, 0);

  const cands = [base];
  // 同じ考え方でも乱数で変わる別の案と、型どおりの別案（同じ手順の案は1つにまとめる）
  for (let k = 1; k <= 2; k++) {
    const { f, fc } = imagine(b, c, 7919 * k + Math.floor(b.t * 10));
    const alt = planner(f, fc);
    if (alt.steps && alt.steps.length) cands.push(alt);
  }
  for (const alt of alternatives(b, c, pe)) cands.push(alt);
  const seen = new Set();
  const uniq = cands.filter(r => {
    const k = JSON.stringify(r.steps);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let best = null;
  const budget = globalThis.LOOK_BUDGET ?? BUDGET_MS;
  const learn = !globalThis.LOOK_NOLEARN;
  for (const raw of uniq) {
    if (best && performance.now() - t0 > budget) break;
    const scores = [], hps = [];
    for (const model of models) {
      const { f, fc } = imagine(b, c, seed);
      for (const o of f.chars) if (o.alive && o !== fc && model.plans.has(o.id)) f.setPlan(o, compilePlan(f, o, model.plans.get(o.id), 'local'));
      const plan = compilePlan(f, fc, raw, 'local');
      if (!plan.steps.length) break;
      f.setPlan(fc, plan);
      const end = f.t + HORIZON;
      // 早く終わる案が得をしないよう、どの案も同じ秒数だけ進める（終わった人はその場で待つ）
      while (f.t < end && !f.over) f.step();
      const hp = hpScore(c, b.chars, f.chars, w);
      hps.push(hp);
      const setup = globalThis.LOOK_NOSETUP ? 0 : setupValue(f, fc) - 0.7 * f.enemiesOf(fc).reduce((a, e) => a + setupValue(f, e), 0);
      scores.push(hp + positionScore(c, f, fc) + setup);
      yield;
    }
    if (scores.length < models.length) continue;
    // 平均（相手の癖で重みづけ）と最悪の場合をあわせて見る（博打好きほど平均を、用心深いほど最悪の場合を重く見る）
    const mean = scores.reduce((a, z, i) => a + z * models[i].weight, 0) / wsum;
    let sc = models.length > 1 ? w.gamble * mean + (1 - w.gamble) * Math.min(...scores) : mean;
    // 前に同じ型の案で見込み違いがあれば、その分を差し引く（うまく行った型は少し上乗せ）
    const err = learn ? mem.err[planKey(raw)] : undefined;
    if (err !== undefined) sc += Math.max(-25, Math.min(10, err * 0.6));
    if (globalThis.LOOK_DEBUG) console.log('    ', c.charId, sc.toFixed(1), scores.map(x => x.toFixed(0)).join(','), raw.interpretation);
    if (!best || sc > best.sc) best = { raw, sc, hp: hps.reduce((a, z, i) => a + z * models[i].weight, 0) / wsum };
  }
  remember(b, c, mem, pe, best, w);
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
