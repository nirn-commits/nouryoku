// 汎用の能力：キャラクターのデータ（JSON）に書かれた「部品」を組み合わせて効果を出す。
// ジョジョのスタンドに限らず、魔法・忍術・異能などを、コードを書かずに追加できるようにするための仕組み。
// 書式は docs/character-format.md を参照
import { dist, angleTo, angDiff, clamp } from './vec.js';
import { isWalkablePoint, buildingAt } from './world.js';
import { interruptStep } from './plan.js';

const fail = reason => ({ ok: false, reason });
const rad = deg => (deg * Math.PI) / 180;

// 効果が当たる人を集める（形：single / circle / cone / line / self）
function hitSet(b, c, ed, res, center) {
  const hit = ed.hit || {};
  const shape = hit.shape || (res.self ? 'self' : res.char ? 'single' : 'circle');
  const foes = b.chars.filter(o => o.alive && o !== c && o.floor === c.floor && (hit.allies ? o.team === c.team : o.team !== c.team));
  if (shape === 'self') return hit.allies ? [c, ...b.alliesOf(c).filter(a => a.alive && dist(a.x, a.y, c.x, c.y) <= (hit.radius || 0))] : [c];
  if (shape === 'single') return res.char && res.char.alive ? [res.char] : [];
  if (shape === 'circle') {
    const r = hit.radius || 2;
    return foes.filter(o => dist(o.x, o.y, center.x, center.y) <= r + o.r);
  }
  const a0 = res.angle ?? angleTo(c.x, c.y, center.x, center.y);
  if (shape === 'cone') {
    const r = hit.radius || 3, half = rad((hit.angle || 70) / 2);
    return foes.filter(o => dist(o.x, o.y, c.x, c.y) <= r + o.r && Math.abs(angDiff(a0, angleTo(c.x, c.y, o.x, o.y))) <= half);
  }
  if (shape === 'line') {
    const len = hit.length || 6, w = (hit.width || 1) / 2;
    return foes.filter(o => {
      const dx = o.x - c.x, dy = o.y - c.y;
      const along = dx * Math.cos(a0) + dy * Math.sin(a0);
      const side = Math.abs(-dx * Math.sin(a0) + dy * Math.cos(a0));
      return along >= 0 && along <= len && side <= w + o.r;
    });
  }
  return [];
}

// 部品を1つずつ適用する。targets はその部品が当たる人
function applyParts(b, c, parts, { targets, center, res, ab, label }) {
  for (const p of parts || []) {
    switch (p.type) {
      case 'damage':
        for (const o of targets) if (o.team !== c.team || p.friendly) b.damage(o, p.amount, { source: c, kind: p.melee ? 'melee' : 'ability', from: c, label });
        break;
      case 'heal':
        for (const o of targets) if (o.team === c.team) b.heal(o, p.amount, label);
        break;
      case 'knockback':
        for (const o of targets) {
          if (o.team === c.team || !o.alive) continue;
          const from = p.from === 'center' ? center : c;
          const a = angleTo(from.x, from.y, o.x, o.y);
          const v = Math.sqrt(28 * (p.distance || 3)); // 毎秒14m/sずつ減速して、ちょうど distance m 進む速さ
          o.kbx = Math.cos(a) * v; o.kby = Math.sin(a) * v;
          o.kbSlam = p.slam ? { damage: p.slam, source: c } : null;
          interruptStep(b, o, `${label}で吹き飛ばされた`, true);
        }
        break;
      case 'status':
        for (const o of targets) {
          const self = p.self || o === c;
          if (!self && o.team === c.team) continue;
          const who = self ? c : o;
          const until = b.t + (p.seconds || 1);
          const s = who.status;
          if (p.status === 'stun') { s.stunUntil = Math.max(s.stunUntil, until); interruptStep(b, who, `${label}で動けない`, true); }
          else if (p.status === 'prone') { s.proneUntil = Math.max(s.proneUntil, until); interruptStep(b, who, `${label}で倒れた`, true); }
          else if (p.status === 'slow') { s.slowUntil = until; s.slowMult = clamp(p.amount ?? 0.5, 0.1, 1); }
          else if (p.status === 'deaf') s.deafUntil = Math.max(s.deafUntil, until);
          else if (p.status === 'invuln') s.invulnUntil = Math.max(s.invulnUntil, until);
          else if (p.status === 'guard') s.guardUntil = Math.max(s.guardUntil, until);
          else if (p.status === 'hide') s.hideUntil = Math.max(s.hideUntil, until);
        }
        break;
      case 'buff': {
        const who = targets.length && targets.every(o => o.team === c.team) ? targets : [c];
        for (const o of who) (o.buffs ||= []).push({ stat: p.stat, mult: p.mult ?? 1.3, until: b.t + (p.seconds || 5) });
        break;
      }
      case 'dash': {
        // 自分が素早く移動する（壁で止まる）
        // 離れる時は、自分に向けた技なら知っている敵（いなければ前）から、そうでなければ狙った所から遠ざかる
        const ref = res.self ? (b.perceivedEnemy(c) || { x: c.x + Math.cos(c.facing), y: c.y + Math.sin(c.facing) }) : center;
        const tgt = p.toward === 'away' ? { x: c.x * 2 - ref.x, y: c.y * 2 - ref.y } : center;
        const a = res.angle !== undefined && p.toward !== 'away' ? res.angle : angleTo(c.x, c.y, tgt.x, tgt.y);
        const d = Math.min(p.distance || 4, p.toward === 'target' ? Math.max(0, dist(c.x, c.y, tgt.x, tgt.y) - 0.9) : Infinity);
        const v = Math.sqrt(28 * Math.max(0, d)); // 毎秒14m/sずつ減速して、ちょうど d m 進む速さ
        c.kbx = Math.cos(a) * v; c.kby = Math.sin(a) * v;
        c.facing = a;
        if (p.invuln) c.status.invulnUntil = Math.max(c.status.invulnUntil, b.t + p.invuln);
        break;
      }
      case 'teleport': {
        // 狙った場所（歩ける所）へ一瞬で移る
        const tx = center.x, ty = center.y;
        if (!isWalkablePoint(b.world, tx, ty, c.floor)) return fail('そこへは移れない（歩ける場所ではない）');
        c.x = tx; c.y = ty; c.vx = c.vy = 0;
        break;
      }
      case 'projectile': {
        const n = Math.max(1, Math.min(7, p.count || 1));
        const spread = rad(p.spread || 0);
        // 動いている敵には、弾が届くまでに進む分を見越して撃つ（見えている時だけ）
        let aim = center;
        if (res.char && res.char.alive && b.canSee(c, res.char.x, res.char.y)) {
          const e = res.char, sp = p.speed || 16;
          const tt = dist(c.x, c.y, e.x, e.y) / sp;
          aim = { x: e.x + e.vx * tt, y: e.y + e.vy * tt };
        }
        const a0 = res.angle ?? angleTo(c.x, c.y, aim.x, aim.y);
        for (let i = 0; i < n; i++) {
          const a = a0 + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0);
          b.spawnBolt(c, a, { speed: p.speed || 16, damage: p.damage || 6, range: p.range || ab.range || 15, radius: p.radius || 0, onHit: p.onHit || [], name: p.name || label, color: p.color });
        }
        break;
      }
      case 'zone': {
        const z = { kind: p.kind || 'hazard', x: center.x, y: center.y, r: p.radius || 2, floor: center.floor ?? c.floor, until: b.t + (p.seconds || 6), owner: c.id, team: c.team, dps: p.dps || 3, mult: p.mult ?? 0.5, label: p.name || label };
        b.addZone(z);
        break;
      }
      case 'noise':
        b.noise({ x: center.x, y: center.y, floor: c.floor }, p.radius || 10, 'impact');
        break;
      case 'reveal': {
        // 周りの敵の居場所を感じ取る（自分と味方に伝わる）
        for (const e of b.enemiesOf(c)) {
          if (!e.alive || dist(e.x, e.y, c.x, c.y) > (p.radius || 15)) continue;
          const rec = { id: e.id, name: e.name, x: e.x, y: e.y, floor: e.floor, t: b.t, facing: e.facing, via: label };
          c.memory.seen[e.id] = rec;
          for (const a of b.alliesOf(c)) if (a.alive) a.memory.seen[e.id] = { ...rec, via: `${c.name}の${label}` };
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

// 使える条件（requires）：屋内だけ・屋外だけ・物を持っている時だけ・体力が◯以下の時だけ
function checkRequires(b, c, req) {
  for (const r of req || []) {
    if (r === 'indoors' && !buildingAt(b.world, c.x, c.y)) return '屋内でしか使えない';
    if (r === 'outdoors' && buildingAt(b.world, c.x, c.y)) return '屋外でしか使えない';
    if (r === 'holding' && !c.held) return '何かを持っていないと使えない';
    if (typeof r === 'object' && r.hpBelow && c.hp > r.hpBelow) return `体力が${r.hpBelow}以下の時しか使えない`;
  }
  return null;
}

export function applyGeneric(b, c, effect, res, ab, step) {
  const ed = ab.effects[effect];
  if (!ed) return fail('不明な効果');
  const req = checkRequires(b, c, ed.requires);
  if (req) return fail(req);
  if (res.error && !res.self) return fail(res.error);
  const range = ed.range ?? ab.range ?? 5;
  let center = res.self ? { x: c.x, y: c.y, floor: c.floor } : { x: res.x, y: res.y, floor: res.f ?? c.floor };
  // 敵を狙う効果：見えていて射程内であること（飛び道具は見えていなくても推定位置へ撃てる）
  const shoots = (ed.do || []).some(p => p.type === 'projectile');
  if (step.target.type === 'enemy') {
    if (!res.char && !shoots) return fail('敵の姿が見えていない');
    if (!shoots && dist(c.x, c.y, res.x, res.y) > range + 0.5) return fail(`敵が射程外（${dist(c.x, c.y, res.x, res.y).toFixed(1)}m > ${range}m）`);
  } else if (!res.self && step.target.type !== 'direction' && dist(c.x, c.y, center.x, center.y) > range + 0.5) {
    return fail(`射程外（${dist(c.x, c.y, center.x, center.y).toFixed(1)}m > ${range}m）`);
  }
  if (step.target.type === 'direction' && res.angle !== undefined) {
    center = { x: c.x + Math.cos(res.angle) * Math.min(range, 6), y: c.y + Math.sin(res.angle) * Math.min(range, 6), floor: c.floor };
  }
  if (!res.self) c.facing = angleTo(c.x, c.y, center.x, center.y);
  const targets = hitSet(b, c, ed, res, center);
  const label = ed.name;
  const tName = targets.filter(o => o !== c).map(o => o.name).join('・');
  const text = (ed.text || `『${ab.name}』— ${ed.name}！`).replace('{name}', c.name).replace('{target}', tName || '相手');
  b.emit({ text, obsText: ed.observedText || `${c.name} が『${ab.name}』を使った！`, kind: 'ability', actor: c, pos: center, sound: ed.sound ?? ab.soundRadius ?? 6, soundKind: 'impact', hint: ab.observedHint });
  const err = applyParts(b, c, ed.do, { targets, center, res, ab, label });
  if (err) return err;
  return { ok: true };
}

// 飛び道具が当たった時の部品（爆発の範囲があれば、その範囲の敵にも）
export function boltHit(b, owner, p, hitChar, at) {
  const label = p.name;
  let targets = hitChar ? [hitChar] : [];
  if (p.radius > 0) targets = b.chars.filter(o => o.alive && owner && o.team !== owner.team && o.floor === (at.floor ?? o.floor) && dist(o.x, o.y, at.x, at.y) <= p.radius + o.r);
  for (const o of targets) b.damage(o, p.damage, { source: owner, kind: 'ability', from: { x: at.x - p.vx, y: at.y - p.vy }, label });
  if (owner && p.onHit && p.onHit.length) applyParts(b, owner, p.onHit, { targets, center: at, res: {}, ab: { range: 0 }, label });
}

// 使える部品の種類（検証用）
export const GENERIC_PARTS = ['damage', 'heal', 'knockback', 'status', 'buff', 'dash', 'teleport', 'projectile', 'zone', 'noise', 'reveal'];
