// 先読み：いくつかの計画の候補を、盤面の写しの上で数秒先まで試し、結果の良いものを選ぶ。
// 公平さのため、写しの中の敵は「自分が知っている場所」に置く（見えていない敵の本当の位置は使わない）。
// 相手が何をするかは分からないので、相手の出方を何通りか想定し（いつもどおり／一気に詰める／離れる／能力で攻める）、
// 平均と最悪の場合の両方で良い案を選ぶ。
// さらに戦いながら学ぶ：
//  ・相手の癖（詰めてくる・離れる・能力をよく使う）を見て、想定する出方の重みを変える
//  ・選んだ案の「見込み」と「実際の結果」の差を覚えておき、見込み違いだった型の案は割り引く
import { compilePlan } from './plan.js';
import { dist } from './vec.js';
import { nearestWalkable } from './world.js';
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
    // 見失ってから少しの間は、最後に見た時の動きのまま進んだと考える（2秒分まで・歩ける所に）
    if (p.vx !== undefined && !globalThis.LOOK_NOEXTRA) {
      const k = Math.min(2, b.t - p.t);
      const q = nearestWalkable(f.world, p.x + p.vx * k, p.y + p.vy * k, 1.5, p.floor ?? 0);
      if (q) p = { ...p, x: q.x, y: q.y };
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
  // 安全地帯の外：その後も削られ続けるので、狭まるほど重く減点し、縁からの距離でも減点する
  if (f.safeZone && f.outsideZone(fc, f.t + 5)) {
    const over = dist(fc.x, fc.y, f.safeZone.x, f.safeZone.y) - f.zoneRadius(f.t + 5);
    s -= 10 + 4 * f.zonePhaseAt() + Math.min(20, Math.max(0, over) * 1.5);
  }
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
    // 近接型：近いほど良い。遠距離型の相手から離れるのは、撃たれ続けるだけなので遠くまで減点する
    else s -= near.def.role === 'ranged' ? 0.35 * Math.min(d, 35) : 0.25 * Math.min(d, 15);
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

// 案に手を加えた別案（磨き上げ）：走りに変える・先にかわす／構える・最後に待ち構えを足す・最後の手を削る
function mutations(b, c, raw, pe) {
  const out = [];
  const steps = raw.steps || [];
  const d = dist(c.x, c.y, pe.x, pe.y);
  const ranged = c.def.role === 'ranged';
  const tag = t => ({ interpretation: `${raw.interpretation}（${t}）`, speech: raw.speech, steps: null });
  if (steps.some(s => s.mode === 'walk')) out.push({ ...tag('走って'), steps: steps.map(s => (s.mode === 'walk' ? { ...s, mode: 'run' } : s)) });
  if (pe.visible && d < 4 && !c.cd.dodge && steps[0]?.action !== 'dodge') out.push({ ...tag('先にかわして'), steps: [{ action: 'dodge', targetType: 'direction', direction: ranged ? 'away_from_enemy' : 'left' }, ...steps].slice(0, 5) });
  if (pe.visible && d < 3 && !ranged && steps[0]?.action !== 'guard') out.push({ ...tag('構えてから'), steps: [{ action: 'guard', targetType: 'enemy', duration: 0.6 }, ...steps].slice(0, 5) });
  if (steps.length < 5 && !steps[steps.length - 1]?.condition) {
    out.push({
      ...tag('最後に待ち構え'),
      steps: [...steps, { action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_within', value: ranged ? Math.max(4, (c.def.keepDistance || 10) - 4) : 2.5, timeout: 3 } },
        ranged ? { action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 6 } : { action: 'melee', targetType: 'enemy' }].slice(0, 5),
    });
  }
  if (steps.length >= 3) out.push({ ...tag('手短に'), steps: steps.slice(0, -1) });
  return out.filter(m => m.steps && m.steps.length);
}

// 相手の立場での点（相手の最善手を読む時に使う）
function foeView(f, o0, fo, b) {
  return hpScore(o0, b.chars, f.chars, { dealt: 1, taken: 1.2 }) + positionScore(o0, f, fo);
}

// planner(b, c) は簡易思考。alternatives(b, c) は試してみる別案の一覧。
// 候補を1つ試すごとに yieldFn を呼ぶ（画面を止めないよう、非同期版では一息つく）。
// 読み方は4段階：
//  1. 相手の最善手を読む：自分がいつもどおり動いた時、近くの敵にとって一番良い手はどれか（相手の別案を試して選ぶ）
//  2. ふるい分け：すべての候補を、いつもどおりの相手と、相手の最善手の2通りで手早く試す
//  3. 本読み：上位の候補だけを、相手の出方すべて（詰める・離れる・能力・癖）で試す
//  4. 磨き上げ：一番良い案に手を加えた別案（走る・先にかわす・待ち構えを足す…）も試し、良ければ差し替える
function* search(b, c, planner, alternatives) {
  const pe = b.perceivedEnemy(c);
  const base = planner(b, c);
  if (b.isSim) return base;
  if (!pe || !base.steps) { if (c.aiLook) c.aiLook.prev = null; return base; }
  const t0 = performance.now();
  const budget = globalThis.LOOK_BUDGET ?? BUDGET_MS;
  const over = () => performance.now() - t0 > budget;
  const seed = 104729 + Math.floor(b.t * 10);
  const horizon = globalThis.LOOK_H ?? HORIZON;
  // 性格と今の気分で採点の重みを変える（攻め気・用心深さ・博打好き）
  const w = globalThis.LOOK_NOPERSONA ? { dealt: 1, taken: 1.2, gamble: 0.5 } : scoreWeights(b, c);
  const mem = observe(b, c, pe, w);
  const st = mem.style;
  const { f: f0 } = imagine(b, c, seed);
  // 味方がこの手番で先に決めた作戦は分かっている（連絡を取り合っている）のでそれを使い、ほかは簡易思考で見積もる
  const intents = b.intents && b.intents.t === b.t ? b.intents.plans : null;
  const others = new Map(f0.chars.filter(o => o.alive && o.id !== c.id).map(o => [o.id, (o.team === c.team && intents && intents[o.id]) || planner(f0, o)]));
  // 想定を変えるのは近くの敵だけ（大人数の戦いで、遠くの敵まで一斉に詰めてくる想定にはしない）
  const foes = f0.chars.filter(o => o.alive && o.team !== c.team && dist(o.x, o.y, c.x, c.y) < 20);

  // 写しの上で、自分の案 raw と、相手の出方 plans を同時に動かして採点する
  const run = (raw, plans) => {
    const { f, fc } = imagine(b, c, seed);
    for (const o of f.chars) if (o.alive && o !== fc && plans.has(o.id)) f.setPlan(o, compilePlan(f, o, plans.get(o.id), 'local'));
    const plan = compilePlan(f, fc, raw, 'local');
    if (!plan.steps.length) return null;
    f.setPlan(fc, plan);
    const end = f.t + horizon;
    // 早く終わる案が得をしないよう、どの案も同じ秒数だけ進める（終わった人はその場で待つ）
    while (f.t < end && !f.over) f.step();
    const hp = hpScore(c, b.chars, f.chars, w);
    const setup = globalThis.LOOK_NOSETUP ? 0 : setupValue(f, fc) - 0.7 * f.enemiesOf(fc).reduce((a, e) => a + setupValue(f, e), 0);
    if (globalThis.LOOK_DEBUG > 1) console.log('      run', raw.interpretation.slice(0, 30), 'hp', hp.toFixed(1), 'pos', positionScore(c, f, fc).toFixed(1), 'setup', setup.toFixed(1));
    return { hp, sc: hp + positionScore(c, f, fc) + setup, f };
  };

  // 1. 相手の最善手：近くの敵（近い順に2人まで）それぞれについて、自分がいつもどおり動いた時に相手が一番得をする手
  const models = [{ plans: others, weight: 1, key: 'usual' }];
  const nModels = globalThis.LOOK_MODELS ?? 5;
  const byNear = [...foes].sort((p, q) => dist(p.x, p.y, c.x, c.y) - dist(q.x, q.y, c.x, c.y)).slice(0, 2);
  if (nModels >= 5 && byNear.length && !globalThis.LOOK_NOBR) {
    const brPlans = new Map(others);
    let changed = false;
    for (const o of byNear) {
      const ope = f0.perceivedEnemy(o);
      if (!ope) continue;
      const opts = [others.get(o.id), rushPlan, awayPlan, ...alternatives(f0, o, ope)].filter(x => x && x.steps && x.steps.length).slice(0, 8);
      let bestO = null;
      for (const alt of opts) {
        if (bestO && over()) break;
        const { f, fc } = imagine(b, c, seed);
        const plans = new Map(others); plans.set(o.id, alt);
        for (const x of f.chars) if (x.alive && x !== fc && plans.has(x.id)) f.setPlan(x, compilePlan(f, x, plans.get(x.id), 'local'));
        f.setPlan(fc, compilePlan(f, fc, base, 'local'));
        const end = f.t + horizon;
        while (f.t < end && !f.over) f.step();
        const fo = f.chars.find(x => x.id === o.id);
        const v = foeView(f, o, fo, b);
        yield;
        if (!bestO || v > bestO.v) bestO = { alt, v };
      }
      if (bestO && bestO.alt !== others.get(o.id)) { brPlans.set(o.id, bestO.alt); changed = true; }
    }
    if (changed) models.push({ plans: brPlans, weight: 1.2, key: 'best' });
  }
  if (nModels >= 2 && foes.length) {
    const m = new Map(others);
    for (const o of foes) m.set(o.id, o.def.role === 'ranged' ? awayPlan : rushPlan);
    models.push({ plans: m, weight: 0.6 + (foes.some(o => o.def.role === 'ranged') ? st.away : st.rush), key: 'rush' });
  }
  if (nModels >= 3 && foes.length) {
    const m = new Map(others);
    let changed = false;
    for (const o of foes) {
      const ope = f0.perceivedEnemy(o);
      const alt = ope && alternatives(f0, o, ope).find(a => a.steps.some(s => s.action === 'ability'));
      if (alt) { m.set(o.id, alt); changed = true; }
    }
    if (changed) models.push({ plans: m, weight: 0.6 + st.ability, key: 'ability' });
  }
  // 癖として見えてきた逆の出方（遠距離型が詰めてくる・近接型が離れる）も想定に入れる
  if (nModels >= 4 && foes.length) {
    const ranged = foes.some(o => o.def.role === 'ranged');
    const k = ranged ? st.rush : st.away;
    if (k > 0.9) {
      const m = new Map(others);
      for (const o of foes) m.set(o.id, ranged ? rushPlan : awayPlan);
      models.push({ plans: m, weight: 0.3 + k, key: 'habit' });
    }
  }

  const cands = [base];
  // 同じ考え方でも乱数で変わる別の案と、型どおりの別案（同じ手順の案は1つにまとめる）
  for (let k = 1; k <= 2; k++) {
    const { f, fc } = imagine(b, c, 7919 * k + Math.floor(b.t * 10));
    const alt = planner(f, fc);
    if (alt.steps && alt.steps.length) cands.push(alt);
  }
  for (const alt of alternatives(b, c, pe)) cands.push(alt);
  const seen = new Set();
  const fresh = r => {
    const k = JSON.stringify(r.steps);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  const uniq = cands.filter(fresh);

  const learn = !globalThis.LOOK_NOLEARN;
  // 候補ごとの、相手の出方ごとの結果（同じ組み合わせは2度試さない）
  const results = new Map(uniq.map(r => [r, []]));
  const evalOn = function* (raw, idxs) {
    if (!results.has(raw)) results.set(raw, []);
    const res = results.get(raw);
    for (const i of idxs) {
      if (res[i] !== undefined) continue;
      res[i] = run(raw, models[i].plans);
      yield;
    }
  };
  // 試した分の結果から点を出す（平均は相手の癖で重みづけ、博打好きほど平均を、用心深いほど最悪の場合を重く見る）
  const scoreOf = raw => {
    const res = results.get(raw) || [];
    const got = models.map((m, i) => [m, res[i]]).filter(([, r]) => r);
    if (!got.length || got.some(([, r]) => r === null)) return null;
    const ws = got.reduce((a, [m]) => a + m.weight, 0);
    const mean = got.reduce((a, [m, r]) => a + r.sc * m.weight, 0) / ws;
    let sc = got.length > 1 ? w.gamble * mean + (1 - w.gamble) * Math.min(...got.map(([, r]) => r.sc)) : mean;
    // 前に同じ型の案で見込み違いがあれば、その分を差し引く（うまく行った型は少し上乗せ）
    const err = learn ? mem.err[planKey(raw)] : undefined;
    if (err !== undefined) sc += Math.max(-25, Math.min(10, err * 0.6));
    return { sc, hp: got.reduce((a, [m, r]) => a + r.hp * m.weight, 0) / ws, n: got.length };
  };

  // 2. ふるい分け：いつもどおりの相手と、相手の最善手（無ければ詰める・離れる）の2通り
  const quick = [0, models.findIndex(m => m.key === 'best') >= 0 ? models.findIndex(m => m.key === 'best') : models.length > 1 ? 1 : 0].filter((v, i, a) => a.indexOf(v) === i);
  for (const raw of uniq) {
    if (raw !== base && over()) break;
    yield* evalOn(raw, quick);
  }
  const all = models.map((_, i) => i);
  const ranked = () => [...results.keys()].map(r => ({ r, s: scoreOf(r) })).filter(x => x.s).sort((p, q) => q.s.sc - p.s.sc);
  // 3. 本読み：上位5案を、相手の出方すべてで
  for (const { r } of ranked().slice(0, 5)) {
    if (over() && r !== base) break;
    yield* evalOn(r, all);
  }
  // 4. 磨き上げ：上位2案に手を加えた別案（同じ相手の出方すべてで比べる）
  if (!globalThis.LOOK_NOREFINE) {
    for (const { r } of ranked().filter(x => x.s.n === models.length).slice(0, 2)) {
      for (const m of mutations(b, c, r, pe)) {
        if (over()) break;
        if (!fresh(m)) continue;
        yield* evalOn(m, all);
      }
    }
  }
  // 決める：相手の出方すべてで試した案の中から（足りなければ試せた分で）
  const final = ranked();
  const full = final.filter(x => x.s.n === models.length);
  const pick = (full.length ? full : final)[0];
  const best = pick ? { raw: pick.r, sc: pick.s.sc, hp: pick.s.hp } : null;
  if (globalThis.LOOK_DEBUG) for (const x of final.slice(0, +(globalThis.LOOK_DEBUG_N || 8))) console.log('    ', c.charId, x.s.sc.toFixed(1), `n${x.s.n}`, x.r.interpretation);
  remember(b, c, mem, pe, best, w);
  // 決めた作戦を味方に伝える（後から考える味方が、それを前提に動ける）
  if (best) {
    if (!b.intents || b.intents.t !== b.t) b.intents = { t: b.t, plans: {} };
    b.intents.plans[c.id] = { interpretation: best.raw.interpretation, speech: null, steps: best.raw.steps };
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
