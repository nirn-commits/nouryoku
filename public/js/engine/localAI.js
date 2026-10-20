// Gemini が使えない・間に合わない時の CPU 思考（ルールベース）。
// 使う情報は本人の知覚（perceivedEnemy・記憶・見えている物）だけで、相手の行動計画は参照しない
import { ABILITIES } from './data.js';
import { dist, distToRect } from './vec.js';
import { hasLOS } from './world.js';

function ready(b, c, id) {
  return c.def.abilities.includes(id) && !c.cd[id] && c.sp >= ABILITIES[id].cost;
}

function incomingProjectile(b, c) {
  return b.world.projectiles.find(p => p.owner !== c.id && b.canSee(c, p.x, p.y) && dist(c.x, c.y, p.x, p.y) < 6);
}

// 触れている（すぐそばの）面
function touchingSurface(b, c) {
  return b.world.objects.find(o => o.blocksMove && distToRect(c.x, c.y, o) <= c.r + 0.6) || null;
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

export function localCpuPlan(b, c) {
  const rnd = b.rng;
  const pe = b.perceivedEnemy(c);
  const steps = [];
  let speech = null;
  const say = p => { if (!speech && rnd() < p) speech = c.def.lines[Math.floor(rnd() * c.def.lines.length)]; };

  if (c.def.abilities.includes('perpendicular')) {
    const sp = sogoPlan(b, c, pe, p => (rnd() < p ? c.def.lines[Math.floor(rnd() * c.def.lines.length)] : null));
    if (sp) return sp;
  }

  const proj = incomingProjectile(b, c);
  if (proj) {
    if (ready(b, c, 'vector') && dist(c.x, c.y, proj.x, proj.y) < 4.5) steps.push({ action: 'ability', ability: 'vector', effect: 'redirect', targetType: 'projectile', targetId: proj.id, direction: 'toward_enemy' });
    else if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: rnd() < 0.5 ? 'left' : 'right', distance: 3 });
    else steps.push({ action: 'guard', targetType: 'enemy', duration: 0.8 });
  }

  if (pe && pe.visible) {
    const e = pe.char;
    const d = dist(c.x, c.y, e.x, e.y);
    const lowHp = c.hp < c.maxHp * 0.3;
    say(0.25);

    if (lowHp && d < 6 && rnd() < 0.6) {
      if (ready(b, c, 'hush')) steps.push({ action: 'ability', ability: 'hush', effect: 'silence_zone', targetType: 'self' });
      if (ready(b, c, 'masonry') && d > 2) steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'enemy' });
      steps.push({ action: 'move', mode: 'run', targetType: 'direction', direction: 'cover' });
      return { interpretation: '（CPU・ローカル）劣勢のため身を隠す', speech, steps };
    }

    if (e.windup && d < 2.5) {
      if (ready(b, c, 'vector')) steps.push({ action: 'ability', ability: 'vector', effect: 'repel', targetType: 'enemy' });
      else if (!c.cd.dodge) steps.push({ action: 'dodge', targetType: 'direction', direction: 'away_from_enemy' });
      else steps.push({ action: 'guard', targetType: 'enemy', duration: 1 });
    }

    // 壁際の敵には棘
    if (ready(b, c, 'masonry')) {
      const wall = b.world.objects.find(o => o.kind === 'wall' && distToRect(e.x, e.y, o) < 1.2 && distToRect(c.x, c.y, o) < 7.5);
      if (wall) {
        steps.push({ action: 'ability', ability: 'masonry', effect: wall.indestructible || rnd() < 0.6 ? 'spike' : 'breach', targetType: 'object', targetId: wall.id });
        steps.push({ action: 'melee', targetType: 'enemy' });
        return { interpretation: '（CPU・ローカル）壁際の敵を壁で攻撃', speech, steps };
      }
    }

    if (d < 2.2) {
      if (ready(b, c, 'vector') && rnd() < 0.4) steps.push({ action: 'ability', ability: 'vector', effect: 'repel', targetType: 'enemy' });
      else steps.push({ action: 'melee', targetType: 'enemy' });
      if (rnd() < 0.5) steps.push({ action: 'dodge', targetType: 'direction', direction: rnd() < 0.5 ? 'left' : 'right' });
      return { interpretation: '（CPU・ローカル）接近戦', speech, steps };
    }

    if (ready(b, c, 'friction') && d < 9 && rnd() < 0.7) {
      steps.push({ action: 'ability', ability: 'friction', effect: rnd() < 0.75 ? 'slick' : 'grip', targetType: 'enemy' });
      steps.push({ action: 'chase', mode: 'walk', targetType: 'enemy' });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）足元を崩してから攻撃', speech, steps };
    }

    if (ready(b, c, 'hush') && d > 8 && rnd() < 0.4) {
      steps.push({ action: 'ability', ability: 'hush', effect: 'deafen', targetType: 'enemy' });
    }

    if (c.knives > 0 && d > 3 && d < 14 && hasLOS(b.world, c.x, c.y, e.x, e.y) && rnd() < 0.55) {
      steps.push({ action: 'throw', targetType: 'enemy' });
      steps.push({ action: 'chase', mode: 'run', targetType: 'enemy' });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）ナイフで牽制して接近', speech, steps };
    }
    if (ready(b, c, 'masonry') && d > 4 && d < 8 && rnd() < 0.3) {
      steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'direction', direction: 'toward_enemy' });
    }
    steps.push({ action: 'chase', mode: d > 6 ? 'run' : 'walk', targetType: 'enemy' });
    steps.push({ action: 'melee', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）接近して攻撃', speech, steps };
  }

  // 敵が見えない：最後に見た位置 → 聞こえた音 → 巡回
  const heard = c.memory.heard.filter(h => b.t - h.t < 6).pop();
  if (pe && b.t - pe.t < 12 && dist(c.x, c.y, pe.x, pe.y) > 1.5) {
    if (ready(b, c, 'hush') && rnd() < 0.3) steps.push({ action: 'ability', ability: 'hush', effect: 'silence_zone', targetType: 'self' });
    steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: pe.x, y: pe.y });
    steps.push({ action: 'look', targetType: 'enemy' });
    return { interpretation: '（CPU・ローカル）最後に見た位置へ忍び寄る', speech, steps };
  }
  if (heard) {
    steps.push({ action: 'look', targetType: 'point', x: heard.x, y: heard.y });
    steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: heard.x, y: heard.y });
    return { interpretation: '（CPU・ローカル）物音のした方へ向かう', speech, steps };
  }
  const tx = 6 + rnd() * (b.world.w - 12), ty = 4 + rnd() * (b.world.h - 8);
  steps.push({ action: 'move', mode: 'walk', targetType: 'point', x: tx, y: ty });
  steps.push({ action: 'look', targetType: 'direction', direction: 'forward' });
  return { interpretation: '（CPU・ローカル）索敵のため移動', speech, steps };
}

