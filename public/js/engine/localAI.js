// Gemini が使えない・間に合わない時の CPU 思考（ルールベース）。
// 使う情報は本人の知覚（perceivedEnemy・記憶・見えている物）だけで、相手の行動計画は参照しない
import { ABILITIES, RULES } from './data.js';
import { ITEM_KINDS, meleeWith } from './items.js';
import { dist, distToRect, pointInRect, angleTo } from './vec.js';
import { nearestWalkable, isWalkablePoint, findPath, hasLOS, buildingAt } from './world.js';
import { lookaheadPlan, lookaheadPlanAsync } from './lookahead.js';
import { chooseLine } from './persona.js';
import { abilityCombos, nanamiCombos } from './combos.js';

function incomingProjectile(b, c) {
  return b.world.projectiles.find(p => p.owner !== c.id && b.canSee(c, p.x, p.y) && dist(c.x, c.y, p.x, p.y) < 6);
}

// 近くに落ちている、殴る武器として素手より強い物
function nearbyItem(b, c, range) {
  return b.world.items
    .filter(i => (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) <= range && meleeWith(c, i.kind) > c.def.power)
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
  // 開けた所で叩きつける面が無ければ、真上に打ち上げて落下させ、落ちた所を殴る
  if (ready && d <= 2 && !slamTarget(b, c, e) && !b.buildingOf(e) && b.rng() < 0.6) {
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'uplift', targetType: 'enemy' });
    steps.push({ action: 'wait', targetType: 'none', duration: 2, condition: { kind: 'enemy_prone' } });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）真上に打ち上げて、落ちた所を殴る', speech: say(0.3) || '10m、落ちるまで1.8秒', steps };
  }
  const slam = ready && d <= 2 ? slamTarget(b, c, e) : null;
  if (slam) {
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: `（CPU・ローカル）${slam.o.name}まで${slam.d.toFixed(1)}m、叩きつける`, speech: `${slam.o.name}まで${slam.d.toFixed(1)}m。届くな`, steps };
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
  // 開けた場所では戦わない：物陰（遮蔽物のそば）へ移ってから待ち構える（遠距離の相手には待たずに詰める）
  if (!surface && d > 4 && d < 10 && e.def.role !== 'ranged' && b.rng() < 0.15) {
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
    steps.push({ action: 'wait', targetType: 'none', duration: 1, condition: { kind: 'enemy_within', value: 2 } });
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）有利な地形で待ち構える', speech: say(0.4), steps };
  }
  // 詰めて殴る。叩きつけられる物が相手の後ろにあれば、弾き出しで決める
  steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
  const off = globalThis.AI_OFF || new Set();
  if (ready && slamTarget(b, c, e)) steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
  else if (ready && !off.has('sogocombo') && !b.buildingOf(e)) {
    // 詰めたら真上に打ち上げ、落ちて倒れた所を殴る（倒れた相手には1.3倍）
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'uplift', targetType: 'enemy' });
    steps.push({ action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_prone', timeout: 2.5 } });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' });
  } else steps.push({ action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' });
  return { interpretation: '（CPU・ローカル）詰めて殴る', speech: say(0.3), steps };
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
      if (pe && pe.visible && d <= 1.6 && b.rng() < 0.5) {
        steps.push({ action: 'ability', ability: 'hotel', effect: 'flame_slam', targetType: 'enemy' });
        steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
        steps.push({ action: 'melee', targetType: 'enemy' });
        return { interpretation: '（CPU・ローカル）外壁へ叩きつける', speech: say(0.3), steps };
      }
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
  // 誘い込み：自分が建物の中にいて敵が近くにいるなら、入ってきた瞬間に出口を閉める（待ち伏せ）
  if (bd && !bd.sealed && pe && pe.visible && dist(c.x, c.y, pe.x, pe.y) < 14 && bd.w * bd.h * bd.floors <= 200) {
    const exits = openExits(bd);
    if (exits.length) {
      steps.push({ action: 'stand_out', targetType: 'none' });
      for (const [i, o] of exits.slice(0, 3).entries()) steps.push({ action: 'close', targetType: 'object', targetId: o.id, ...(i === exits.length - 1 || i === 2 ? { condition: { kind: 'enemy_inside' } } : {}) });
      steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
      return { interpretation: '（CPU・ローカル）部屋に誘い込み、入ってきたら閉める', speech: say(0.3) || (b.rng() < 0.4 ? '……入れ' : null), steps };
    }
  }
  // 誘い込み：外で敵と向き合ったら、近くの家へ入って待つ（敵が追ってきたら閉じ込める）
  if (!bd && pe && pe.visible && dist(c.x, c.y, pe.x, pe.y) > 5 && dist(c.x, c.y, pe.x, pe.y) < 16 && pe.char.def.role !== 'ranged' && b.rng() < 0.3) {
    const house = b.world.buildings
      .filter(x => x.w * x.h * x.floors <= 200 && x.exits.some(id => b.objectById(id)?.kind === 'door'))
      .map(x => ({ x, d: dist(c.x, c.y, x.x + x.w / 2, x.y + x.h / 2) }))
      .filter(h => h.d < 12)
      .sort((p, q) => p.d - q.d)[0];
    if (house) {
      steps.push({ action: 'move', mode: 'run', targetType: 'object', targetId: house.x.id });
      steps.push({ action: 'look', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）家に入って誘い込む', speech: b.rng() < 0.3 ? '来い' : null, steps };
    }
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
  if (loud >= RULES.roarLoud && pe && dist(c.x, c.y, pe.x, pe.y) < 45) {
    steps.push({ action: 'ability', ability: 'echo', effect: 'roar', targetType: 'enemy' });
    steps.push({ action: 'wait', targetType: 'none', duration: 1.5 });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）集めた轟音を敵の耳元で鳴らして仕留める', speech: say(0.3), steps };
  }
  // 近づかれたら、無音の結界を張ってその中を通って静かに離れる
  if (visible && d < 7 && alive.filter(u => u.state === 'home' || (u.state === 'deployed' && !u.sound)).length >= 6 && b.rng() < 0.4) {
    steps.push({ action: 'ability', ability: 'echo', effect: 'silence_zone', targetType: 'self' });
    steps.push(retreatStep(b, c, pe, 8));
    return { interpretation: '（CPU・ローカル）無音の結界を張って静かに離れる', speech: null, steps };
  }
  // 見失われている間に、足音の行列で別の方向へ誘導する
  if (!visible && pe && b.t - pe.t < 8 && alive.some(u => u.sound && u.sound.kind.startsWith('footsteps')) && b.rng() < 0.35) {
    steps.push({ action: 'ability', ability: 'echo', effect: 'decoy_walk', targetType: 'direction', direction: 'away_from_enemy', distance: 14 });
    steps.push({ action: 'move', mode: 'walk', targetType: 'direction', direction: 'cover' });
    return { interpretation: '（CPU・ローカル）足音の行列で誘導する', speech: null, steps };
  }
  if (visible && d < 7) {
    // 近づかれたら囮の足音を反対側に置いて離れる
    if (alive.some(u => u.sound && u.sound.kind.startsWith('footsteps'))) steps.push({ action: 'ability', ability: 'echo', effect: 'place', sound: 'footsteps', targetType: 'direction', direction: 'toward_enemy', distance: 14 });
    steps.push(retreatStep(b, c, pe, 8));
    return { interpretation: '（CPU・ローカル）囮の足音を置いて身を隠す', speech: null, steps };
  }
  // 敵が近くにいない・居場所が分からない間に、物を叩いて轟音の材料を自分で作っておく
  if (!(visible && d < 14) && (!pe || b.t - pe.t > 6 || dist(c.x, c.y, pe.x, pe.y) > 22) && loud < RULES.roarLoud) {
    const col = nanamiCombos(b, c, pe && !pe.visible ? null : pe)[0];
    if (col) return { ...col, steps: [...steps, ...col.steps].slice(0, 5) };
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
    const it = b.world.items.filter(i => (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) < 12 && meleeWith(c, i.kind) > c.def.power + 2)
      .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y))[0];
    if (it && !(visible && d < 9)) {
      steps.push({ action: 'pickup', targetType: 'object', targetId: it.id, mode: 'walk' });
      return { interpretation: `（CPU・ローカル）${it.name}を拾っておく`, speech: null, steps };
    }
  }
  // 大きな音を集める：自分で立てた音は材料にならない。敵がこちらへ駆けてくる通り道に個体を並べ、駆ける足音や戦いの音を拾う
  const freeUnits = alive.filter(u => u.state === 'home' || (u.state === 'deployed' && !u.sound)).length;
  // 自分の周り（半径2.5m）に個体を輪に並べる：駆け寄ってくる敵の足音や、そばで起きた戦いの音を拾う
  const ringed = alive.filter(u => u.state === 'deployed' && Math.abs(dist(u.x, u.y, c.x, c.y) - 2.5) < 1.2).length;
  if (pe && freeUnits >= 6 && ringed < 6) {
    const a0 = angleTo(c.x, c.y, pe.x, pe.y);
    for (let i = 0; i < 3; i++) {
      const a = a0 + (i - 1) * 0.9;
      steps.push({ action: 'ability', ability: 'echo', effect: 'deploy', targetType: 'point', x: c.x + Math.cos(a) * 2.5, y: c.y + Math.sin(a) * 2.5, count: 3 });
    }
    steps.push({ action: 'look', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）周りに個体を輪に並べ、駆け寄る足音を拾う', speech: say(0.2), steps };
  }
  return steps.length ? { interpretation: '（CPU・ローカル）静かに機をうかがう', speech: null, steps } : null;
}

// 鷺沼 玲司：距離を保ち、硬い面を使った跳弾で撃つ。読みにくい高反射を好む悪癖あり
function saginumaPlan(b, c, pe, say) {
  const steps = [];
  const inFlight = b.world.projectiles.filter(p => p.kind === 'ball' && p.owner === c.id).length;
  if (!pe) return null;
  const d = dist(c.x, c.y, pe.x, pe.y);
  // 追われている：足元に玉を撒いて逃げる（走って追ってくれば転ぶ）
  const chaser = pe.visible && pe.char.def.role !== 'ranged';
  if (pe.visible && d < 8 && c.balls >= 8 && !b.world.zones.some(z => z.kind === 'caltrops' && z.owner === c.id) && b.rng() < (chaser ? 0.9 : 0.4)) {
    steps.push({ action: 'ability', ability: 'seventh', effect: 'caltrops', targetType: 'self' });
    steps.push(retreatStep(b, c, pe, 8));
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 });
    return { interpretation: '（CPU・ローカル）玉を撒いて足止めし、離れて撃つ', speech: say(0.2), steps };
  }
  if (pe.visible && d >= 8 && d < 18 && inFlight === 0 && c.balls >= 10 && b.rng() < 0.2) {
    steps.push({ action: 'ability', ability: 'seventh', effect: 'suppress', targetType: 'enemy' });
    steps.push(retreatStep(b, c, pe, 8));
    return { interpretation: '（CPU・ローカル）牽制射撃しながら物陰へ', speech: null, steps };
  }
  if (pe.visible && d < 6) {
    // 近づかれたら、まず跳んで走って距離を取ってから撃つ（足は相手より速い）
    if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
    steps.push(retreatStep(b, c, pe, 9));
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 1 });
    steps.push(retreatStep(b, c, pe, 6));
    return { interpretation: '（CPU・ローカル）走って距離を取ってから撃つ', speech: say(0.2), steps };
  }
  // 間合いの内側に詰めてくる相手：1発撃ったら下がって、もう1発（撃ち合いながら引く）
  const off = globalThis.AI_OFF || new Set();
  if (!off.has('kite') && chaser && d < c.def.keepDistance && inFlight < 2) {
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 });
    steps.push(retreatStep(b, c, pe, c.def.keepDistance - d + 4));
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 });
    return { interpretation: '（CPU・ローカル）撃っては下がる', speech: say(0.2), steps };
  }
  if (inFlight < 3 && b.t - pe.t < 10) {
    const bounces = 2 + Math.floor(b.rng() * 3); // 2〜4回。高反射を好む
    if (b.rng() < 0.3) steps.push({ action: 'ability', ability: 'seventh', effect: 'spread', targetType: 'enemy', bounces });
    else {
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces });
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: bounces + 1 });
      steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: Math.max(1, bounces - 1) });
    }
    // 撃ったら間合いを保つ：近い相手からは下がる
    if (pe.visible && d < c.def.keepDistance) steps.push(retreatStep(b, c, pe, c.def.keepDistance - d + 3));
    else steps.push({ action: 'wait', targetType: 'none', duration: 0.6 });
    return { interpretation: `（CPU・ローカル）${bounces}回前後の跳弾で撃つ`, speech: say(0.25), steps };
  }
  return null;
}

// 蛇穴院 麗音：喋って気を引きながら、5m前後の距離でスタンドに足場・得物を崩させ、倒れた所を殴る
function saragiinPlan(b, c, pe, say) {
  if (!pe) return null;
  const steps = [];
  const e = pe.char || b.enemyOf(c);
  const d = dist(c.x, c.y, pe.x, pe.y);
  const traps = b.world.zones.filter(z => z.kind === 'powder_trap' && z.owner === c.id).length;
  // 殴り合いの間合いに詰められた：足元に床を仕込んで下がる（追って踏めば抜ける）
  if (pe.visible && d < 2.2 && e.def.power >= 12 && traps < 2 && b.rng() < 0.6) {
    steps.push({ action: 'ability', ability: 'vacant', effect: 'powder_trap', targetType: 'self' });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 4 });
    steps.push({ action: 'ability', ability: 'vacant', effect: 'powder_floor', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）足元に床を仕込んで下がる', speech: say(0.5), steps };
  }
  if (pe.visible && d <= 9) {
    if (d > 4.5) steps.push({ action: 'chase', targetType: 'enemy', mode: d > 7 ? 'run' : 'walk' });
    const armed = e.held && meleeWith(e, e.held.kind) > e.def.power;
    if ((armed && b.rng() < 0.7) || ((e.balls ?? 0) >= 10 && b.rng() < 0.35)) {
      steps.push({ action: 'ability', ability: 'vacant', effect: 'powder_weapon', targetType: 'enemy' });
    }
    steps.push({ action: 'ability', ability: 'vacant', effect: 'powder_floor', targetType: 'enemy' });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    // 殴り合いで格上の相手（錠二など）とは打ち合わない：一発入れたら間合いへ下がり、また崩す
    if (e.def.power > c.def.power * 1.3) steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 4 }, { action: 'ability', ability: 'vacant', effect: 'powder_floor', targetType: 'enemy' });
    else steps.push({ action: 'melee', targetType: 'enemy' });
    // 話しかけて気を引いている間に崩す
    return { interpretation: '（CPU・ローカル）話しかけて気を引き、足場を崩して殴る', speech: say(0.8), steps };
  }
  // 見失っている：通り道に床を仕込んでおき、物陰で待つ
  if (!pe.visible && traps < 2 && b.rng() < 0.3) {
    steps.push({ action: 'ability', ability: 'vacant', effect: 'powder_trap', targetType: 'direction', direction: 'toward_enemy', distance: 4 });
    steps.push({ action: 'move', mode: 'walk', targetType: 'direction', direction: 'cover' });
    return { interpretation: '（CPU・ローカル）通り道の床を仕込んで待つ', speech: null, steps };
  }
  return null;
}

const clampW = (b, v, k) => Math.max(1, Math.min((k === 'w' ? b.world.w : b.world.h) - 1, v));

// 御厨 しずく：本体は離れて隠れ、車両を敵の体の上に走らせて口を残し、食いしばって噛み続ける
function mikuriyaPlan(b, c, pe, say) {
  const steps = [];
  const e = b.enemyOf(c);
  const onFoe = c.mouths.some(m => m.on === e.id);
  const onSelf = c.mouths.some(m => m.on === c.id);
  const d = pe ? dist(c.x, c.y, pe.x, pe.y) : 99;
  // 詰め寄られた：腕の口で受け止めながら下がる
  if (pe && pe.visible && d < 3.5) {
    if (!onSelf) steps.push({ action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'self' });
    steps.push({ action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 3 });
    if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
    steps.push(retreatStep(b, c, pe, 8));
    return { interpretation: '（CPU・ローカル）腕の口で受け止めながら距離を取る', speech: null, steps };
  }
  if (onFoe) {
    // 噛みついたまま、物陰へ静かに離れる
    if (!c.clench) steps.push({ action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 6 });
    steps.push({ action: 'move', mode: 'walk', targetType: 'direction', direction: d < 12 ? 'away_from_enemy' : 'cover', distance: 5 });
    steps.push({ action: 'hide', targetType: 'none', duration: 3 });
    return { interpretation: '（CPU・ローカル）食いしばって噛みつかせたまま隠れる', speech: null, steps };
  }
  if (pe && d < 45) {
    if (!onSelf && b.rng() < 0.5) steps.push({ action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'self' });
    const fresh = pe.visible || b.t - pe.t < 1.5;
    const backOff = pe.visible && d < c.def.keepDistance;
    if (fresh) steps.push({ action: 'stand_move', targetType: 'enemy', ...(backOff ? { duration: 0.3 } : {}) });
    else {
      // 位置が古い：最後に分かった所の周りを車両で走り回って探す（体に乗り上げれば手応えで分かる）
      for (let i = 0; i < 2; i++) {
        const a = b.rng() * Math.PI * 2, r = 1.5 + b.rng() * 3.5;
        steps.push({ action: 'stand_move', targetType: 'point', x: clampW(b, pe.x + Math.cos(a) * r, 'w'), y: clampW(b, pe.y + Math.sin(a) * r, 'h') });
      }
    }
    // 見えている敵には体に口を付ける。位置が古い時は、車両が走り回った所に口を残して罠にする（踏み込んだら噛む）
    if (fresh) steps.push({ action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'enemy' });
    else {
      const last = steps[steps.length - 1];
      steps.push({ action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'point', x: last.x, y: last.y }, { action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 4 });
    }
    // 車両を走らせている間も、本体は距離を取る（口を付けるのは離れてから）
    if (backOff) steps.splice(steps.length - 1, 0, retreatStep(b, c, pe, Math.min(10, c.def.keepDistance - d + 3)));
    return { interpretation: fresh ? '（CPU・ローカル）車両を敵の体の上に走らせて口を残す' : '（CPU・ローカル）車両で敵のいそうな所を走り回って探す', speech: c.clench ? null : say(0.3), steps };
  }
  // 敵が分からない：音のした方へ車両を走らせて探る
  const h = [...c.memory.heard].reverse().find(x => b.t - x.t < 10);
  if (h) {
    steps.push({ action: 'stand_move', targetType: 'point', x: h.x, y: h.y });
    steps.push({ action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'point', x: h.x, y: h.y });
    steps.push({ action: 'hide', targetType: 'none', duration: 3 });
    return { interpretation: '（CPU・ローカル）物音のした所に口を仕掛ける', speech: null, steps };
  }
  return null;
}

// 計画が早く終わると、相手の計画が終わるまで棒立ちになる。最後に「待ちながらの反応」を足しておく
// 遠距離型：近づかれたら離れる／近接型：殴り終えても追って殴り続ける
function reactTail(b, c, plan) {
  const steps = plan.steps;
  if (!steps || !steps.length || steps.length >= 5) return plan;
  const pe = b.perceivedEnemy(c);
  if (!pe || b.t - pe.t > 6) return plan;
  const endsInMelee = steps[steps.length - 1].action === 'melee';
  if ((c.def.role === 'ranged' || c.def.role === 'mid') && !endsInMelee) {
    if (steps[steps.length - 1].condition) return plan;
    // 締めの待機は反応つきの待機に置き換え、離れる手順の分の枠を空ける
    if (steps[steps.length - 1].action === 'wait') steps.pop();
    while (steps.length > 3) steps.pop();
    const keep = c.def.keepDistance || 10;
    steps.push({ action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_within', value: Math.max(c.def.role === 'mid' ? 3 : 5, keep - 4), timeout: 6 } });
    // 逃げ先は今の位置で選んでおく（角や安全地帯の外へ追い詰められない場所）
    if (steps.length < 5) steps.push(c.def.role === 'mid' ? { action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 3 } : retreatStep(b, c, pe, 8));
  } else if (endsInMelee && steps.length <= 4) {
    // 殴り終えても、追って殴り続ける
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    if (steps.length < 5) steps.push({ action: 'melee', targetType: 'enemy' });
  }
  return plan;
}

// データで追加したキャラ（汎用の能力）：技の中身（ダメージ・回復・強化・場）を見て使い分ける
function effectValue(ed) {
  let dmg = 0;
  for (const p of ed.do || []) {
    if (p.type === 'damage') dmg += p.amount;
    if (p.type === 'projectile') dmg += (p.damage || 0) * (p.count || 1);
    if (p.type === 'zone' && p.kind === 'hazard') dmg += (p.dps || 3) * Math.min(4, p.seconds || 4);
    if (p.type === 'status' && (p.status === 'stun' || p.status === 'prone')) dmg += 4;
    if (p.type === 'knockback') dmg += 2;
  }
  return dmg;
}

function genericPlan(b, c, pe, say) {
  const ready = id => !c.cd[id] && c.sp >= ABILITIES[id].cost;
  const effects = c.def.abilities.filter(ready).flatMap(id => Object.entries(ABILITIES[id].effects).map(([eff, ed]) => ({ id, eff, ed, ab: ABILITIES[id] })));
  const steps = [];
  // 体力が少ない：回復や守りの技があれば先に使う
  if (c.hp < c.maxHp * 0.45) {
    const guard = effects.find(x => x.ed.targets.includes('self') && (x.ed.do || []).some(p => p.type === 'heal' || (p.type === 'buff' && p.stat === 'defense') || (p.type === 'status' && p.status === 'invuln')));
    if (guard) steps.push({ action: 'ability', ability: guard.id, effect: guard.eff, targetType: 'self' });
  }
  if (!pe) return steps.length ? { interpretation: '（CPU・ローカル）身を守る', speech: null, steps } : null;
  const d = dist(c.x, c.y, pe.x, pe.y);
  // 敵に向けて使える技のうち、一番効きそうなもの（射程内か、飛び道具なら見えていなくても撃てる）
  const attacks = effects
    .filter(x => x.ed.targets.includes('enemy') || x.ed.targets.includes('point'))
    .map(x => ({ ...x, value: effectValue(x.ed), shoots: (x.ed.do || []).some(p => p.type === 'projectile'), range: x.ed.range ?? x.ab.range }))
    .filter(x => x.value > 0)
    .sort((p, q) => q.value - p.value);
  const usable = attacks.find(x => (pe.visible || x.shoots) && d <= x.range + (c.def.role === 'ranged' ? 0 : 1.5));
  if (usable) {
    const tgt = usable.ed.targets.includes('enemy') ? { targetType: 'enemy' } : { targetType: 'point', x: Math.round(pe.x * 10) / 10, y: Math.round(pe.y * 10) / 10 };
    if (c.def.role !== 'ranged' && d > usable.range - 0.5) steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    steps.push({ action: 'ability', ability: usable.id, effect: usable.eff, ...tgt });
    if (c.def.role === 'ranged') { if (d < (c.def.keepDistance || 10)) steps.push(retreatStep(b, c, pe, 6)); }
    else steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' });
    return { interpretation: `（CPU・ローカル）『${usable.ab.name}：${usable.ed.name}』を狙う`, speech: say(0.3), steps };
  }
  // 届く技が無い：近接型・中距離型は詰め、遠距離型は間合いを保つ（共通の考え方に任せる）
  return steps.length ? { interpretation: '（CPU・ローカル）身を守る', speech: null, steps } : null;
}

// どのキャラにも共通の反射的な判断（キャラごとの作戦より先に見る）
function reflexPlan(b, c, pe, say) {
  // 列車の警報が鳴っている（または通過中）のに線路の上にいる：近い側へ走って出る
  for (const tr of b.world.trains || []) {
    if (!(tr.warned || tr.active) || c.floor !== 0) continue;
    if (c.y < tr.y - 0.6 || c.y > tr.y + tr.h + 0.6) continue;
    const up = c.y < tr.y + tr.h / 2;
    const ty = up ? tr.y - 1.6 : tr.y + tr.h + 1.6;
    const p = nearestWalkable(b.world, c.x, ty, 3) || { x: c.x, y: ty };
    // 柵で出られない所なら、近い踏切の外へ
    const path = findPath(b.world, c.x, c.y, p.x, p.y, 0, 0);
    const steps = [{ action: 'move', mode: 'run', targetType: 'point', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }];
    if (!path || path.partial || (path.length ?? 0) > 12) continue;
    return { interpretation: `（CPU・ローカル）${tr.name}が来るので線路から出る`, speech: null, steps };
  }
  // 体に何か付いている（エコー・ビーチの個体・コルベットの口）→ 払う
  if (c.memory.suspectAttached) {
    return { interpretation: '（CPU・ローカル）体についた何かを払う', speech: null, steps: [{ action: 'swat', targetType: 'self' }, ...(pe && pe.visible && c.def.role !== 'ranged' ? [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] : [])] };
  }
  // 足元を走り回る小さな車両（リトル・レッド・コルベット）が見えたら叩き落とす
  for (const e of b.enemiesOf(c)) {
    const car = e.alive && e.def.standBlind && e.standBody;
    if (car && car.floor === c.floor && dist(c.x, c.y, car.x, car.y) < 3 && b.canSee(c, car.x, car.y, car.floor * 3 + 0.2)) {
      const steps = [];
      if (dist(c.x, c.y, car.x, car.y) > 1.2) steps.push({ action: 'move', mode: 'run', targetType: 'point', x: car.x, y: car.y, floor: car.floor });
      steps.push({ action: 'swat', targetType: 'self' });
      return { interpretation: '（CPU・ローカル）足元の小さな車両を叩き落とす', speech: null, steps };
    }
  }
  return kitoTrapEscape(b, c, pe);
}

// 錠二と同じ建物の中にいる（まだ密室になっていない）なら、閉じ込められる前に外へ出る
function kitoTrapEscape(b, c, pe) {
  if (c.def.abilities.includes('hotel')) return null;
  const bd = b.buildingOf(c);
  if (!bd || bd.sealed) return null;
  const kito = b.enemiesOf(c).find(e => {
    if (!e.alive || !e.def.abilities.includes('hotel')) return false;
    const r = b.canSee(c, e.x, e.y) ? e : c.memory.seen[e.id];
    return r && b.t - (r.t ?? b.t) < 6 && dist(r.x, r.y, bd.x + bd.w / 2, bd.y + bd.h / 2) < Math.max(bd.w, bd.h) / 2 + 4;
  });
  if (!kito) return null;
  // 開いている出口のうち、錠二から遠いもの
  const exits = bd.exits.map(id => b.objectById(id)).filter(o => o && (o.open || o.broken) && o.floor === 0);
  if (!exits.length) return null;
  const kr = b.canSee(c, kito.x, kito.y) ? kito : c.memory.seen[kito.id];
  const ex = exits.sort((p, q) => (dist(c.x, c.y, p.x, p.y) - dist(kr.x, kr.y, p.x, p.y) * 0.8) - (dist(c.x, c.y, q.x, q.y) - dist(kr.x, kr.y, q.x, q.y) * 0.8))[0];
  const cx = ex.x + ex.w / 2, cy = ex.y + ex.h / 2;
  const nx = cx < bd.x + 0.5 ? -1 : cx > bd.x + bd.w - 0.5 ? 1 : 0, ny = cy < bd.y + 0.5 ? -1 : cy > bd.y + bd.h - 0.5 ? 1 : 0;
  const out = nearestWalkable(b.world, cx + nx * 2, cy + ny * 2, 2) || { x: cx + nx * 2, y: cy + ny * 2 };
  return { interpretation: `（CPU・ローカル）閉じ込められる前に${ex.name}から外へ出る`, speech: null, steps: [{ action: 'move', mode: 'run', targetType: 'point', x: Math.round(out.x * 10) / 10, y: Math.round(out.y * 10) / 10, floor: 0 }] };
}

// 逃げ先を選ぶ：敵から遠く、敵の横をすり抜けず、回り道にならず、10秒後も安全地帯の中で、
// 角や壁際に追い詰められない場所。敵から見えない場所なら加点
function retreatPoints(b, c, e, want = 8) {
  const ea = Math.atan2(e.y - c.y, e.x - c.x);
  const zr = b.zoneRadius(b.t + 10), z = b.safeZone;
  const found = [];
  for (let i = 0; i < 10; i++) {
    const a = ea + Math.PI + ((i - 4.5) / 10) * Math.PI * 2;
    if (Math.cos(a - ea) > 0.35) continue; // 敵の方へ向かう逃げ道は使わない
    for (const r of [want, want * 0.6]) {
      const x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
      if (x < 1 || y < 1 || x > b.world.w - 1 || y > b.world.h - 1 || !isWalkablePoint(b.world, x, y, c.floor)) continue;
      const path = findPath(b.world, c.x, c.y, x, y, c.floor, c.floor);
      if (!path || path.partial) continue;
      const len = path.length ?? r;
      if (len > r * 1.8) continue;
      const edge = Math.min(x, y, b.world.w - x, b.world.h - y);
      let score = dist(x, y, e.x, e.y) - len * 0.25 - (edge < 3 ? 4 : 0);
      if (z && dist(x, y, z.x, z.y) > zr - 1) score -= 30;
      if (!hasLOS(b.world, e.x, e.y, x, y)) score += 3;
      found.push({ x, y, score, a });
      break;
    }
  }
  return found.sort((p, q) => q.score - p.score);
}

function retreatPoint(b, c, e, want = 8) {
  return retreatPoints(b, c, e, want)[0] || null;
}

function retreatStep(b, c, e, want = 8) {
  const p = retreatPoint(b, c, e, want);
  return p
    ? { action: 'move', mode: 'run', targetType: 'point', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, floor: c.floor }
    : { action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: want };
}

// 遠距離型の間合い：近すぎれば離れ、遠すぎれば間合いまで寄り、ちょうど良ければ様子を見る
function keepDistance(b, c, e, d, speech, steps = []) {
  const keep = c.def.keepDistance || 10;
  if (d < keep - 1.5) {
    if (d < 2.5 && !c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
    steps.push(retreatStep(b, c, e, Math.min(12, keep - d + 3)));
    steps.push({ action: 'look', targetType: 'enemy' });
    return { interpretation: `（CPU・ローカル）近すぎる（${d.toFixed(1)}m）ので間合いを取る`, speech, steps };
  }
  // 遠い相手：近接型なら向こうから来るので寄らない。遠距離型どうしなら間合いまで寄る（近づかれたら止まる）
  if (d > keep + 8 && e.def.role === 'ranged') {
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'walk', distance: keep, duration: 3 });
    return { interpretation: '（CPU・ローカル）間合いまで寄る', speech, steps };
  }
  steps.push({ action: 'look', targetType: 'enemy' });
  steps.push({ action: 'wait', targetType: 'none', duration: 1, condition: { kind: 'enemy_within', value: Math.max(3, keep - 3) } });
  return { interpretation: '（CPU・ローカル）間合いを保って様子を見る', speech, steps };
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
  if (b.t < RULES.policeWarn - 15 || b.teamDealt(c.team) > b.rivalDealt(c.team)) return plan;
  const attacks = (plan.steps || []).some(st => ['melee', 'throw', 'ability'].includes(st.action) && st.effect !== 'silence_self' && st.effect !== 'recall' && st.effect !== 'deploy');
  if (attacks) return plan;
  const ab = c.def.abilities;
  const steps = ab.includes('seventh')
    ? [{ action: 'chase', targetType: 'enemy', mode: 'run', distance: 7, duration: 4 }, { action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 }]
    : ab.includes('echo')
      ? [{ action: 'chase', targetType: 'enemy', mode: 'run', distance: 10, duration: 3 }, { action: 'ability', ability: 'echo', effect: 'scratch', targetType: 'enemy', count: 8 }]
      : ab.includes('corvette')
        ? [{ action: 'stand_move', targetType: 'enemy' }, { action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'enemy' }, { action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 5 }]
        : [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }];
  return { interpretation: '（CPU・ローカル）警察が来る前に判定を取り返すため攻める', speech: null, steps };
}

// スタンドの出し入れ：殴り合いの前に出して間合いを伸ばし、エネルギーが減ったら戻す
// 傷ついていて敵が近くにいなければ、回復アイテムを使う（無ければ近くの物を拾う・自販機で買う）
function healPlan(b, c) {
  if (c.hp > c.maxHp * 0.55) return null;
  const pe = b.perceivedEnemy(c);
  if (pe && pe.visible && dist(c.x, c.y, pe.x, pe.y) < 8) return null;
  const healKinds = ['drink', 'onigiri', 'bandage', 'first_aid'];
  if (c.held && healKinds.includes(c.held.kind)) return { interpretation: '（CPU・ローカル）回復する', speech: null, steps: [{ action: 'use_item', targetType: 'self' }] };
  const it = b.world.items.filter(i => healKinds.includes(i.kind) && (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) < 15)
    .sort((p, q) => dist(c.x, c.y, p.x, p.y) - dist(c.x, c.y, q.x, q.y))[0];
  if (it) return { interpretation: `（CPU・ローカル）${it.name}で回復する`, speech: null, steps: [{ action: 'pickup', targetType: 'object', targetId: it.id, mode: 'run' }, { action: 'use_item', targetType: 'self' }] };
  const v = b.world.objects.filter(o => o.kind === 'vending' && (o.stock ?? 3) > 0 && distToRect(c.x, c.y, o) < 15).sort((p, q) => distToRect(c.x, c.y, p) - distToRect(c.x, c.y, q))[0];
  if (v && !c.held) return { interpretation: '（CPU・ローカル）自販機で飲み物を買って回復する', speech: null, steps: [{ action: 'interact', targetType: 'object', targetId: v.id, mode: 'run' }, { action: 'use_item', targetType: 'self' }] };
  return null;
}

// 安全地帯の外にいる（もうすぐ外になる）：内側へ走って戻る
function zonePlan(b, c) {
  const z = b.safeZone;
  if (!z) return null;
  const d = dist(c.x, c.y, z.x, z.y);
  const soon = b.zoneRadius(b.t + 10);
  if (d <= soon - 1) return null;
  const k = Math.max(0, soon - 3) / Math.max(d, 0.1);
  const p = nearestWalkable(b.world, z.x + (c.x - z.x) * k, z.y + (c.y - z.y) * k, 4) || z;
  return {
    interpretation: `（CPU・ローカル）安全地帯の${b.outsideZone(c) ? '外にいる' : '縁にいる'}ので内側へ戻る`, speech: null,
    steps: [{ action: 'move', mode: 'run', targetType: 'point', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }],
  };
}

// CPU の思考：簡易思考の案と別案を、先読みで比べて選ぶ
export function localCpuPlan(b, c) {
  const off = globalThis.AI_OFF;
  if (b.isSim || (off && off.has('look')) || !b.fork) return heuristicPlan(b, c);
  return voice(b, c, lookaheadPlan(b, c, heuristicPlan, alternativePlans));
}

// 選んだ作戦と、その場の気分・出来事に合わせた一言を付ける（言わない方がいい時は黙る）
function voice(b, c, plan) {
  const line = chooseLine(b, c, plan);
  plan.speech = line ? line.text : null;
  plan.lineInfo = line ? { key: line.key, mood: line.mood } : null;
  return plan;
}

// 同じ思考の非同期版（考えている間も画面が止まらない）
export async function localCpuPlanAsync(b, c) {
  const off = globalThis.AI_OFF;
  if (b.isSim || (off && off.has('look')) || !b.fork) return heuristicPlan(b, c);
  return voice(b, c, await lookaheadPlanAsync(b, c, heuristicPlan, alternativePlans));
}

// 先読みで比べる型どおりの別案
function alternativePlans(b, c, pe) {
  // 能力を生かす連携の案を先に入れる（数が多い時に削られないように）
  const alts = globalThis.AI_OFF && globalThis.AI_OFF.has('combos') ? [] : abilityCombos(b, c, pe);
  const tag = t => `（CPU・ローカル）${t}`;
  const d = dist(c.x, c.y, pe.x, pe.y);
  const ranged = c.def.role === 'ranged';
  const pt = p => ({ action: 'move', mode: 'run', targetType: 'point', x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, floor: c.floor });
  // 逃げ道は向きの違うものを2つまで試す（1つ目が塞がれる・回り込まれる時のため）
  const outs = retreatPoints(b, c, pe, 8);
  const second = outs.find(p => Math.abs(Math.atan2(Math.sin(p.a - outs[0].a), Math.cos(p.a - outs[0].a))) > 0.9);
  alts.push({ interpretation: tag('距離を取る'), speech: null, steps: [outs[0] ? pt(outs[0]) : retreatStep(b, c, pe, 8), { action: 'look', targetType: 'enemy' }] });
  if (second) alts.push({ interpretation: tag('別の向きへ距離を取る'), speech: null, steps: [pt(second), { action: 'look', targetType: 'enemy' }] });
  // 張り付かれている：まず跳んでかわしてから走って離れる
  if (pe.visible && d < 3.5 && !c.cd.dodge) alts.push({ interpretation: tag('跳んでかわして離れる'), speech: null, steps: [{ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' }, retreatStep(b, c, pe, 8), { action: 'look', targetType: 'enemy' }] });
  // 遠距離型に殴り合いの案は出さない（武器を持っていて張り付かれた時だけ、殴り返す案も試す）
  if (!ranged) alts.push({ interpretation: tag('詰めて殴り続ける'), speech: null, steps: [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] });
  else if (pe.visible && d < 2.5 && c.held) alts.push({ interpretation: tag('得物で殴り返す'), speech: null, steps: [{ action: 'melee', targetType: 'enemy' }, retreatStep(b, c, pe, 8)] });
  if (!ranged && pe.visible && d > 3 && d < 12) {
    // 待ち構える：向こうから来るなら、間合いに入った所で先に殴る
    alts.push({ interpretation: tag('待ち構えて、来た所を殴る'), speech: null, steps: [{ action: 'look', targetType: 'enemy' }, { action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_within', value: 2, timeout: 3 } }, { action: 'melee', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] });
  }
  if (c.mouths) {
    // コルベット：車両を走らせて口を付け、離れながら噛む
    alts.push({ interpretation: tag('車両で口を付けて噛む'), speech: null, steps: [{ action: 'stand_move', targetType: 'enemy', duration: 0.3 }, retreatStep(b, c, pe, 6), { action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'enemy' }, { action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 5 }] });
    if (c.mouths.some(m => m.on && m.on !== c.id)) alts.push({ interpretation: tag('食いしばって噛み続ける'), speech: null, steps: [{ action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 6 }, retreatStep(b, c, pe, 6)] });
  }
  if (pe.visible && d < 4 && !ranged) {
    alts.push({ interpretation: tag('構えて受けてから殴る'), speech: null, steps: [{ action: 'guard', targetType: 'enemy', duration: 1.2 }, { action: 'melee', targetType: 'enemy' }] });
    // 殴りかかってくる相手には、受け流してから殴り返す
    alts.push({ interpretation: tag('受け流して殴り返す'), speech: null, steps: [{ action: 'counter', targetType: 'none' }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] });
    // 近接の読み合い：受け流し・ガードで待つ相手には掴み、構えを誘うならフェイントを挟む
    alts.push({ interpretation: tag('掴んでから殴る'), speech: null, steps: [{ action: 'grab', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] });
    alts.push({ interpretation: tag('フェイントを入れて殴る'), speech: null, steps: [{ action: 'feint', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] });
  }
  for (const id of c.def.abilities) {
    const ab = ABILITIES[id];
    for (const [eff, ed] of Object.entries(ab.effects)) {
      // データで追加した能力：自分にかける技（強化・回復・守り）や、地点に置く技も試す
      if (ABILITIES[id].generic && !ed.targets.includes('enemy')) {
        if (ed.targets.includes('self')) alts.push({ interpretation: tag(`『${ab.name}：${ed.name}』を使う`), speech: null, steps: [{ action: 'ability', ability: id, effect: eff, targetType: 'self' }, ...(ranged ? [retreatStep(b, c, pe, 6)] : [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }])] });
        else if (ed.targets.includes('point')) alts.push({ interpretation: tag(`『${ab.name}：${ed.name}』を敵の所へ`), speech: null, steps: [{ action: 'ability', ability: id, effect: eff, targetType: 'point', x: Math.round(pe.x * 10) / 10, y: Math.round(pe.y * 10) / 10 }] });
        continue;
      }
      if (!ed.targets.includes('enemy') || id === 'corvette' || (id === 'hotel' && eff === 'seal')) continue;
      // 前提が満たされていない技は試さない（持っていない物を飛ばす・密室の外での叩きつけ）
      if ((eff === 'launch_held' && !c.held) || (eff === 'flame_slam' && !(b.buildingOf(c)?.sealed?.by === c.id))) continue;
      // 轟音の決め技は、大きな音がそろっている時だけ
      if (eff === 'roar' && (c.units || []).filter(u => u.state !== 'dead' && b.isLoud(u.sound)).length < RULES.roarLoud) continue;
      const range = ed.range ?? ab.range;
      const near = range < 6;
      alts.push({ interpretation: tag(`『${ab.name}：${ed.name}』を狙う`), speech: null, steps: [...(near ? [{ action: 'chase', targetType: 'enemy', mode: 'run' }] : []), { action: 'ability', ability: id, effect: eff, targetType: 'enemy' }, ...(ranged ? [retreatStep(b, c, pe, 6)] : [{ action: 'melee', targetType: 'enemy' }])] });
      // 遠くから撃てる技：近すぎるなら、先に離れてから撃つ
      if (ranged && !near && pe.visible && d < Math.min(range, c.def.keepDistance || 10) - 2) {
        alts.push({ interpretation: tag(`離れてから『${ab.name}：${ed.name}』`), speech: null, steps: [retreatStep(b, c, pe, 6), { action: 'ability', ability: id, effect: eff, targetType: 'enemy' }, { action: 'look', targetType: 'enemy' }] });
      }
    }
  }
  return alts.slice(0, 16);
}

function heuristicPlan(b, c) {
  const zp = zonePlan(b, c);
  if (zp) return zp;
  const healing = healPlan(b, c);
  if (healing && b.t < RULES.timeLimit - 20) return healing;
  const plan = reactTail(b, c, hurry(b, c, basePlan(b, c)));
  if (!c.def.standRange || c.def.standBlind || !plan.steps) return plan;
  const steps = plan.steps;
  const melee = steps.some(st => st.action === 'melee' && (st.targetType || 'enemy') === 'enemy');
  // 能力でエネルギーを使うキャラは、殴る時にスタンドを出しっぱなしにしない（能力の分を残す）
  const usesSp = c.def.abilities.some(id => id === 'perpendicular' || id === 'seventh' || id === 'vacant');
  // 近接の読み合い：相手がガードを固めていれば掴み、殴りかかってくるなら受け流しを混ぜる
  const pe = b.perceivedEnemy(c);
  if (pe && pe.visible && c.def.power >= 10) {
    const e = pe.char, d = dist(c.x, c.y, e.x, e.y);
    const r = b.rng();
    if ((e.status.guardUntil > b.t || e.status.counterUntil > b.t) && d < 3 && r < 0.7) {
      steps.unshift({ action: 'grab', targetType: 'enemy' });
    } else if (e.windup && e.windup.kind === 'melee' && d < 2.5 && r < 0.35) {
      plan.steps = [{ action: 'counter', targetType: 'none' }, { action: 'melee', targetType: 'enemy' }];
      return plan;
    } else if (melee && d > 2.2 && d < 4.2 && r < 0.2) {
      steps.unshift({ action: 'tackle', targetType: 'enemy' });
    } else if (melee && d < 2.5 && r < 0.12) {
      steps.unshift({ action: 'feint', targetType: 'enemy' });
    }
  }
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

  const rx = reflexPlan(b, c, pe, line);
  if (rx) return rx;
  if (c.def.abilities.includes('perpendicular')) {
    const sp = sogoPlan(b, c, pe, line);
    if (sp) return sp;
  }
  if (c.def.abilities.includes('echo')) {
    const np = nanamiPlan(b, c, pe, line);
    if (np) return np;
  }
  if (c.def.abilities.includes('seventh')) {
    const sp = saginumaPlan(b, c, pe, line);
    if (sp) return sp;
  }
  if (c.def.abilities.includes('corvette')) {
    const mp = mikuriyaPlan(b, c, pe, line);
    if (mp) return mp;
  }
  if (c.def.abilities.includes('vacant')) {
    const vp = saragiinPlan(b, c, pe, line);
    if (vp) return vp;
  }
  if (c.def.custom) {
    const gp = genericPlan(b, c, pe, line);
    if (gp) return gp;
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
    // 遠距離・中距離型は殴り合わない：間合いを保つ
    if (c.def.role === 'ranged' || c.def.role === 'mid') return keepDistance(b, c, e, d, speech, steps);
    if (e.windup && d < 2.5) {
      // 近接型は下がらない：構えて受けるか、横へかわして殴り返す
      if (rnd() < 0.5 || c.cd.dodge) steps.push({ action: 'guard', targetType: 'enemy', duration: 0.8 });
      else steps.push({ action: 'dodge', targetType: 'direction', direction: rnd() < 0.5 ? 'left' : 'right', distance: 1.5 });
    }
    if (d < 2.2) {
      steps.push({ action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' });
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
