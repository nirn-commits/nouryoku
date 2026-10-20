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

export function localCpuPlan(b, c) {
  const rnd = b.rng;
  const pe = b.perceivedEnemy(c);
  const steps = [];
  let speech = null;
  const say = p => { if (!speech && rnd() < p) speech = c.def.lines[Math.floor(rnd() * c.def.lines.length)]; };

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
      steps.push({ action: 'move', mode: 'walk', targetType: 'enemy', distance: 1.5 });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）足元を崩してから攻撃', speech, steps };
    }

    if (ready(b, c, 'hush') && d > 8 && rnd() < 0.4) {
      steps.push({ action: 'ability', ability: 'hush', effect: 'deafen', targetType: 'enemy' });
    }

    if (c.knives > 0 && d > 3 && d < 14 && hasLOS(b.world, c.x, c.y, e.x, e.y) && rnd() < 0.55) {
      steps.push({ action: 'throw', targetType: 'enemy' });
      steps.push({ action: 'move', mode: 'run', targetType: 'enemy', distance: 1.5 });
      steps.push({ action: 'melee', targetType: 'enemy' });
      return { interpretation: '（CPU・ローカル）ナイフで牽制して接近', speech, steps };
    }
    if (ready(b, c, 'masonry') && d > 4 && d < 8 && rnd() < 0.3) {
      steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'direction', direction: 'toward_enemy' });
    }
    steps.push({ action: 'move', mode: d > 6 ? 'run' : 'walk', targetType: 'enemy', distance: 1.5 });
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

