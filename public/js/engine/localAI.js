// Gemini が使えない・間に合わない時の CPU 思考（ルールベース）。
// 使う情報は本人の知覚（perceivedEnemy・記憶・見えている物）だけで、相手の行動計画は参照しない
import { ABILITIES, RULES } from './data.js';
import { ITEM_KINDS } from './items.js';
import { dist, distToRect, pointInRect } from './vec.js';

function incomingProjectile(b, c) {
  return b.world.projectiles.find(p => p.owner !== c.id && b.canSee(c, p.x, p.y) && dist(c.x, c.y, p.x, p.y) < 6);
}

// 近くに落ちている、殴る武器として素手より強い物
function nearbyItem(b, c, range) {
  return b.world.items
    .filter(i => (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) <= range && ITEM_KINDS[i.kind].melee > c.def.power)
    .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y))[0] || null;
}

// 触れている（すぐそばの）面
function touchingSurface(b, c) {
  return b.world.objects.find(o => o.blocksMove && o.floor === c.floor && distToRect(c.x, c.y, o) <= c.r + 0.6) || null;
}

// 敵を自分から離れる向きへ10m弾き出した時、途中に叩きつけられる物があるか
function slamTarget(b, c, e) {
  const a = Math.atan2(e.y - c.y, e.x - c.x);
  for (let d = 0.6; d <= 10; d += 0.3) {
    const x = e.x + Math.cos(a) * d, y = e.y + Math.sin(a) * d;
    const o = b.world.objects.find(ob => ob.blocksMove && x >= ob.x - e.r && x <= ob.x + ob.w + e.r && y >= ob.y - e.r && y <= ob.y + ob.h + e.r);
    if (o) return { o, d };
  }
  return null;
}

// 十河 矩比呂：有利な地形（壁・柱・物のそば）でしか戦わず、不利なら逃げる
function sogoPlan(b, c, pe, say) {
  if (!pe || !pe.visible) return null;
  const e = pe.char;
  const d = dist(c.x, c.y, e.x, e.y);
  const ready = !c.cd.perpendicular && c.sp >= ABILITIES.perpendicular.cost;
  const surface = touchingSurface(b, c);
  const steps = [];
  if (ready && e.windup && d < 2.6) {
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'self' });
    return { interpretation: '（CPU・ローカル）面を蹴って攻撃をかわす', speech: say(0.3), steps };
  }
  if (ready && d <= 2) {
    const slam = slamTarget(b, c, e);
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: `（CPU・ローカル）${slam ? `${slam.o.name}まで${slam.d.toFixed(1)}m、叩きつける` : '弾き出して距離を取る'}`, speech: slam ? `${slam.o.name}まで${slam.d.toFixed(1)}m。届くな` : say(0.3), steps };
  }
  if (c.hp < c.maxHp * 0.35 && d < 6) {
    if (ready && surface) steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'self' });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
    return { interpretation: '（CPU・ローカル）不利なので離脱する', speech: say(0.5), steps };
  }
  if (ready && c.held && d > 3 && d <= 9.5) {
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch_held', targetType: 'enemy' });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    return { interpretation: `（CPU・ローカル）${c.held.name}を10m弾き出す`, speech: say(0.3), steps };
  }
  if (!c.held && d > 5) {
    const it = nearbyItem(b, c, 6);
    if (it) {
      steps.push({ action: 'pickup', targetType: 'object', targetId: it.id, mode: 'run' });
      return { interpretation: `（CPU・ローカル）${it.name}を拾っておく`, speech: null, steps };
    }
  }
  // 開けた場所では戦わない：物陰（遮蔽物のそば）へ移ってから待ち構える
  if (!surface && d > 4 && b.rng() < 0.5) {
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
    steps.push({ action: 'wait', targetType: 'none', duration: 1, condition: { kind: 'enemy_within', value: 2 } });
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）有利な地形で待ち構える', speech: say(0.4), steps };
  }
  steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
  steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
  return { interpretation: '（CPU・ローカル）接近して弾き出す', speech: say(0.3), steps };
}

// 鬼頭 錠二：相手を建物に追い込み、出口をすべて自分で閉めて密室にしてから殴る
function kitoPlan(b, c, pe, say) {
  const bd = b.buildingOf(c);
  const steps = [];
  const openExits = room => room.exits
    .map(id => b.objectById(id))
    .filter(o => o && o.open && o.openable)
    .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y));
  const enemyInside = room => {
    if (pe && pe.visible) return pointInRect(pe.x, pe.y, room);
    return pe && b.t - pe.t < 8 && pointInRect(pe.x, pe.y, room);
  };
  if (bd && enemyInside(bd)) {
    const exits = openExits(bd);
    if (bd.sealed) {
      // 開けられた出口は、相手が離れていれば閉め直す
      const d = pe ? dist(c.x, c.y, pe.x, pe.y) : 99;
      if (exits.length && d > 3) steps.push({ action: 'close', targetType: 'object', targetId: exits[0].id });
      steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）密室の中で仕留める', speech: say(0.3), steps };
    }
    // 開いている出口を近い順に閉めていく。最後の1つを閉めた瞬間に密室が成立する
    for (const o of exits.slice(0, 3)) steps.push({ action: 'close', targetType: 'object', targetId: o.id });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）出口を閉めて密室にする', speech: say(0.4) || (exits.length <= 1 ? '閉めるぞ' : null), steps };
  }
  if (pe && pe.visible) {
    // 相手が建物に入ったら追って入る。外なら追いかけて殴る
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）追い詰めて殴る', speech: say(0.25), steps };
  }
  return null;
}

// 七海 灯：姿を見せず、足音を消し、大きな音を集めてから決め技。囮の足音で敵を引き離す
function nanamiPlan(b, c, pe, say) {
  const alive = c.units.filter(u => u.state !== 'dead');
  const steps = [];
  const onSelf = alive.some(u => u.state === 'attached' && u.attachedTo === c.id);
  const loud = alive.filter(u => b.isLoud(u.sound)).length;
  const e = b.enemyOf(c);
  const visible = pe && pe.visible;
  const d = visible ? dist(c.x, c.y, e.x, e.y) : 99;
  if (!onSelf) steps.push({ action: 'ability', ability: 'echo', effect: 'silence_self', targetType: 'self' });
  if (loud >= 3 && pe && dist(c.x, c.y, pe.x, pe.y) < 45) {
    steps.push({ action: 'ability', ability: 'echo', effect: 'roar', targetType: 'enemy' });
    steps.push({ action: 'wait', targetType: 'none', duration: 1.5 });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）集めた轟音を敵の耳元で鳴らして仕留める', speech: say(0.3), steps };
  }
  if (visible && d < 7) {
    // 近づかれたら囮の足音を反対側に置いて離れる
    if (alive.some(u => u.sound && u.sound.kind.startsWith('footsteps'))) steps.push({ action: 'ability', ability: 'echo', effect: 'place', sound: 'footsteps', targetType: 'direction', direction: 'toward_enemy', distance: 14 });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
    return { interpretation: '（CPU・ローカル）囮の足音を置いて身を隠す', speech: null, steps };
  }
  // 見えている敵には、空いている個体を群がらせて引っかく（音集めの合間のけん制）
  const spare = alive.filter(u => u.state === 'home' || (u.state === 'deployed' && !u.sound)).length;
  if (visible && d < 30 && spare >= 8 && !alive.some(u => u.state === 'scratch')) {
    steps.push({ action: 'ability', ability: 'echo', effect: 'scratch', targetType: 'enemy', count: 6 });
  }
  // 大きな音を集める：個体を配置して、近くの物（窓・木箱・車）を叩いて鳴らす
  const deployedFree = alive.filter(u => u.state === 'deployed' && !u.sound && dist(u.x, u.y, c.x, c.y) < 1.5).length;
  // 武器（包丁・鉄パイプなど）を持っていなければ拾う
  if (!c.held) {
    const it = b.world.items.filter(i => (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) < 12 && ITEM_KINDS[i.kind].melee >= 11)
      .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y))[0];
    if (it && !(visible && d < 9)) {
      steps.push({ action: 'pickup', targetType: 'object', targetId: it.id, mode: 'walk' });
      return { interpretation: `（CPU・ローカル）${it.name}を拾っておく`, speech: null, steps };
    }
  }
  // 大きな音を集める：個体を自分のそばに配置して、近くの物（木箱・車・ドラム缶など）を叩いて鳴らす
  const target = b.world.objects
    .filter(o => o.floor === c.floor && ['crate', 'car', 'drum', 'vending', 'steel', 'shelf'].includes(o.kind) && (o.kind !== 'car' || !(o.alarmUntil > b.t)))
    .sort((a, z) => distToRect(c.x, c.y, a) - distToRect(c.x, c.y, z))[0];
  if (target && distToRect(c.x, c.y, target) < 20) {
    steps.push({ action: 'move', mode: 'walk', targetType: 'object', targetId: target.id });
    if (deployedFree < 2) steps.push({ action: 'ability', ability: 'echo', effect: 'deploy', targetType: 'self', count: 3 });
    steps.push({ action: 'melee', targetType: 'object', targetId: target.id });
    steps.push({ action: 'melee', targetType: 'object', targetId: target.id });
    return { interpretation: '（CPU・ローカル）大きな音を集める', speech: null, steps };
  }
  return steps.length ? { interpretation: '（CPU・ローカル）静かに機をうかがう', speech: null, steps } : null;
}

// 鷺沼 玲司：距離を保ち、硬い面を使った跳弾で撃つ。読みにくい高反射を好む悪癖あり
function saginumaPlan(b, c, pe, say) {
  const steps = [];
  const inFlight = b.world.projectiles.filter(p => p.kind === 'ball' && p.owner === c.id).length;
  if (!pe) return null;
  const d = dist(c.x, c.y, pe.x, pe.y);
  if (pe.visible && d < 6) {
    // 近づかれたら跳んで距離を取り、近距離の跳弾で迎え撃つ
    if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 1 });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 8 });
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 });
    return { interpretation: '（CPU・ローカル）距離を取りながら撃つ', speech: say(0.2), steps };
  }
  if (inFlight < 3 && b.t - pe.t < 10) {
    const bounces = 2 + Math.floor(b.rng() * 3); // 2〜4回。高反射を好む
    if (b.rng() < 0.3) steps.push({ action: 'ability', ability: 'seventh', effect: 'spread', targetType: 'enemy', bounces });
    else {
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces });
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: bounces + 1 });
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: Math.max(1, bounces - 1) });
    }
    steps.push({ action: 'wait', targetType: 'none', duration: 0.6 });
    return { interpretation: `（CPU・ローカル）${bounces}回前後の跳弾で撃つ`, speech: say(0.25), steps };
  }
  return null;
}

// 2対2：知っている敵の中から狙いを決める（近さと弱り具合。味方が狙っている敵にやや寄せる）
function chooseFocus(b, c) {
  const foes = b.enemiesOf(c).filter(e => e.alive);
  if (foes.length < 2) { c.focusId = null; return; }
  const allyTargets = b.alliesOf(c).filter(a => a.alive).map(a => b.enemyOf(a).id);
  let best = null;
  for (const e of foes) {
    const vis = b.canSee(c, e.x, e.y);
    const rec = vis ? e : c.memory.seen[e.id];
    if (!rec) continue;
    const age = vis ? 0 : b.t - rec.t;
    const score = dist(c.x, c.y, rec.x, rec.y) + age * 0.8 + (e.hp / e.maxHp) * 8 - (allyTargets.includes(e.id) ? 4 : 0);
    if (!best || score < best.score) best = { e, score };
  }
  c.focusId = best ? best.e.id : null;
}

// 警察が近づいていて判定で負けている（同点含む）なら、攻撃の無い計画を攻めの計画に差し替える
function hurry(b, c, plan) {
  if (b.t < RULES.policeWarn - 15 || b.teamDealt(c.team) > b.teamDealt(1 - c.team)) return plan;
  const attacks = (plan.steps || []).some(st => ['melee', 'throw', 'ability'].includes(st.action) && st.effect !== 'silence_self' && st.effect !== 'recall' && st.effect !== 'deploy');
  if (attacks) return plan;
  const ab = c.def.abilities;
  const steps = ab.includes('seventh')
    ? [{ action: 'chase', targetType: 'enemy', mode: 'run', distance: 7, duration: 4 }, { action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 }]
    : ab.includes('echo')
      ? [{ action: 'ability', ability: 'echo', effect: 'scratch', targetType: 'enemy', count: 8 }, { action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }]
      : [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }];
  return { interpretation: '（CPU・ローカル）警察が来る前に判定を取り返すため攻める', speech: null, steps };
}

// スタンドの出し入れ：殴り合いの前に出して間合いを伸ばし、エネルギーが減ったら戻す
export function localCpuPlan(b, c) {
  const plan = hurry(b, c, basePlan(b, c));
  if (!c.def.standRange || !plan.steps) return plan;
  const steps = plan.steps;
  const melee = steps.some(st => st.action === 'melee' && (st.targetType || 'enemy') === 'enemy');
  const usesSp = c.def.abilities.some(id => id === 'perpendicular' || id === 'seventh');
  if (melee && !c.standBody && steps.length < 5 && !usesSp && b.rng() < 0.5) steps.unshift({ action: 'stand_out', targetType: 'none' });
  else if (c.standBody && (!melee || (usesSp && c.sp < 40)) && steps.length < 5) steps.unshift({ action: 'stand_in', targetType: 'none' });
  return plan;
}

function basePlan(b, c) {
  const rnd = b.rng;
  chooseFocus(b, c);
  const pe = b.perceivedEnemy(c);
  const steps = [];
  let speech = null;
  const line = p => (rnd() < p ? c.def.lines[Math.floor(rnd() * c.def.lines.length)] : null);
  const say = p => { if (!speech) speech = line(p); };

  if (c.def.abilities.includes('perpendicular')) {
    const sp = sogoPlan(b, c, pe, line);
    if (sp) return sp;
  }
  // 体に何か付いている気がする → 払う
  if (c.memory.suspectAttached) {
    const sw = [{ action: 'swat', targetType: 'self' }];
    return { interpretation: '（CPU・ローカル）体についた何かを払う', speech: null, steps: sw };
  }
  if (c.def.abilities.includes('echo')) {
    const np = nanamiPlan(b, c, pe, line);
    if (np) return np;
  }
  if (c.def.abilities.includes('seventh')) {
    const sp = saginumaPlan(b, c, pe, line);
    if (sp) return sp;
  }
  if (c.def.abilities.includes('hotel')) {
    const kp = kitoPlan(b, c, pe, line);
    if (kp) return kp;
  }

  const proj = incomingProjectile(b, c);
  if (proj) {
    if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: rnd() < 0.5 ? 'left' : 'right', distance: 3 });
    else steps.push({ action: 'guard', targetType: 'enemy', duration: 0.8 });
  }

  if (pe && pe.visible) {
    const e = pe.char;
    const d = dist(c.x, c.y, e.x, e.y);
    say(0.25);
    if (c.hp < c.maxHp * 0.3 && d < 6 && rnd() < 0.6) {
      steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
      return { interpretation: '（CPU・ローカル）劣勢のため身を隠す', speech, steps };
    }
    if (e.windup && d < 2.5) {
      if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
      else steps.push({ action: 'guard', targetType: 'enemy', duration: 1 });
    }
    if (d < 2.2) {
      steps.push({ action: 'melee', targetType: 'enemy' });
      if (rnd() < 0.5) steps.push({ action: 'dodge', targetType: 'direction', direction: rnd() < 0.5 ? 'left' : 'right' });
      return { interpretation: '（CPU・ローカル）接近戦', speech, steps };
    }
    if (c.held && d > 4 && d < 12 && rnd() < 0.35) {
      steps.push({ action: 'throw', targetType: 'enemy' });
      steps.push({ action: 'chase', mode: 'run', targetType: 'enemy' });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: `（CPU・ローカル）${c.held.name}を投げて接近`, speech, steps };
    }
    // 武器になる物が近くにあれば拾ってから向かう
    if (!c.held && d > 4) {
      const it = nearbyItem(b, c, Math.min(8, d - 2));
      if (it) {
        steps.push({ action: 'pickup', targetType: 'object', targetId: it.id, mode: 'run' });
        steps.push({ action: 'chase', mode: 'run', targetType: 'enemy' });
        steps.push({ action: 'melee', targetType: 'enemy' });
        return { interpretation: `（CPU・ローカル）${it.name}を拾って殴りに行く`, speech, steps };
      }
    }
    steps.push({ action: 'chase', mode: d > 6 ? 'run' : 'walk', targetType: 'enemy' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）接近して攻撃', speech, steps };
  }

  // 敵が見えない：最後に見た位置 → 聞こえた音 → 巡回
  const heard = c.memory.heard.filter(h => b.t - h.t < 6).pop();
  if (pe && b.t - pe.t < 12 && (dist(c.x, c.y, pe.x, pe.y) > 1.5 || (pe.floor ?? 0) !== c.floor)) {
    steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: pe.x, y: pe.y, floor: pe.floor ?? 0 });
    steps.push({ action: 'look', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）最後に見た位置へ向かう', speech, steps };
  }
  if (heard) {
    steps.push({ action: 'look', targetType: 'point', x: heard.x, y: heard.y });
    steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: heard.x, y: heard.y, floor: heard.floor ?? 0 });
    return { interpretation: '（CPU・ローカル）物音のした方へ向かう', speech, steps };
  }
  const tx = 6 + rnd() * (b.world.w - 12), ty = 4 + rnd() * (b.world.h - 8);
  steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: tx, y: ty });
  steps.push({ action: 'look', targetType: 'direction', direction: 'forward' });
  return { interpretation: '（CPU・ローカル）索敵のため移動', speech, steps };
}
