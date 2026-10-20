// Gemini が使えない・間に合わない時の CPU 思考（ルールベース）。
// 使う情報は本人の知覚（perceivedEnemy・記憶・見えている物）だけで、相手の行動計画は参照しない
import { ABILITIES } from './data.js';
import { dist, distToRect, pointInRect } from './vec.js';

function incomingProjectile(b, c) {
  return b.world.projectiles.find(p => p.owner !== c.id && b.canSee(c, p.x, p.y) && dist(c.x, c.y, p.x, p.y) < 6);
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
  if (ready && c.knives > 0 && d > 3 && d <= 9.5) {
    steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch_held', targetType: 'enemy' });
    steps.push({ action: 'chase', targetType: 'enemy', mode: 'run' });
    return { interpretation: '（CPU・ローカル）ナイフを10m弾き出す', speech: say(0.3), steps };
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

export function localCpuPlan(b, c) {
  const rnd = b.rng;
  const pe = b.perceivedEnemy(c);
  const steps = [];
  let speech = null;
  const line = p => (rnd() < p ? c.def.lines[Math.floor(rnd() * c.def.lines.length)] : null);
  const say = p => { if (!speech) speech = line(p); };

  if (c.def.abilities.includes('perpendicular')) {
    const sp = sogoPlan(b, c, pe, line);
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
    if (c.knives > 0 && d > 3 && d < 14 && b.canSee(c, e.x, e.y) && rnd() < 0.55) {
      steps.push({ action: 'throw', targetType: 'enemy' });
      steps.push({ action: 'chase', mode: 'run', targetType: 'enemy' });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）ナイフで牽制して接近', speech, steps };
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
