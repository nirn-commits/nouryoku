// Gemini が使えない・間に合わない時の CPU 思考（ルールベース）。
// 使う情報は本人の知覚（perceivedEnemy・記憶・見えている物）だけで、相手の行動計画は参照しない
import { ABILITIES, RULES } from './data.js';
import { ITEM_KINDS, meleeWith } from './items.js';
import { dist, distToRect, pointInRect, angleTo } from './vec.js';

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
      if (pe && pe.visible && d <= 1.6 && b.rng() < 0.5) {
        steps.push({ action: 'ability', ability: 'hotel', effect: 'flame_slam', targetType: 'enemy' });
        steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
        steps.push({ action: 'melee', targetType: 'enemy' });
        return { interpretation: '（CPU・ローカル）炎の壁へ叩きつける', speech: say(0.3), steps };
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
  if (!bd && pe && pe.visible && dist(c.x, c.y, pe.x, pe.y) < 16 && b.rng() < 0.45) {
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
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
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
  if (pe.visible && d < 8 && d > 3 && c.balls >= 8 && !b.world.zones.some(z => z.kind === 'caltrops' && z.owner === c.id) && b.rng() < 0.5) {
    steps.push({ action: 'ability', ability: 'seventh', effect: 'caltrops', targetType: 'self' });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 8 });
    steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 });
    return { interpretation: '（CPU・ローカル）玉を撒いて足止めし、離れて撃つ', speech: say(0.2), steps };
  }
  if (pe.visible && d >= 8 && d < 18 && inFlight === 0 && c.balls >= 10 && b.rng() < 0.2) {
    steps.push({ action: 'ability', ability: 'seventh', effect: 'suppress', targetType: 'enemy' });
    steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
    return { interpretation: '（CPU・ローカル）牽制射撃しながら物陰へ', speech: null, steps };
  }
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
    steps.push({ action: 'melee', targetType: 'enemy' });
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

export function localCpuPlan(b, c) {
  const healing = healPlan(b, c);
  if (healing && b.t < RULES.timeLimit - 20) return healing;
  const plan = hurry(b, c, basePlan(b, c));
  if (!c.def.standRange || !plan.steps) return plan;
  const steps = plan.steps;
  const melee = steps.some(st => st.action === 'melee' && (st.targetType || 'enemy') === 'enemy');
  const usesSp = c.def.abilities.some(id => id === 'perpendicular' || id === 'seventh');
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
  if (c.def.abilities.includes('vacant')) {
    const vp = saragiinPlan(b, c, pe, line);
    if (vp) return vp;
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
