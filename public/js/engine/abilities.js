// スタンド能力の効果処理。射程・視線・対象の妥当性はここで最終確認し、ルールに沿った効果だけを発生させる
import { ABILITIES, RULES } from './data.js';
import { dist, angleTo, nearestPointOnRect, distToRect, circleRectPush, rectCenter, clamp } from './vec.js';
import { buildingAt, FLOOR_H } from './world.js';
import { interruptStep } from './plan.js';


function fail(reason) {
  return { ok: false, reason };
}

function inRange(c, x, y, range) {
  return dist(c.x, c.y, x, y) <= range;
}

function enemyTarget(b, c, res, range) {
  const e = b.enemyOf(c);
  if (res.error) return { err: res.error };
  if (!res.char || !b.canSee(c, e.x, e.y)) return { err: '敵の姿が見えていない' };
  if (!inRange(c, e.x, e.y, range)) return { err: `敵が射程外（${dist(c.x, c.y, e.x, e.y).toFixed(1)}m > ${range}m）` };
  return { e };
}

const IMPL = {
  perpendicular(b, c, effect, res, ab, step) {
    // 接触点の直角記号「∟」
    const mark = (x, y) => b.fx.push({ kind: 'mark', x, y, t: b.t, visibleTo: b.visibleSet({ x, y }) });
    const ok = (text, obsText, pos, affected = null) => {
      b.emit({ text, obsText, kind: 'ability', actor: c, affected, pos, sound: ab.soundRadius, hint: ab.observedHint });
      return { ok: true };
    };

    if (effect === 'self_launch') {
      if (b.isAirborne(c)) {
        // 空中：手に持った物（ナイフ）を接触面として、水平方向に弾き出す
        if (c.knives <= 0) return fail('空中で何にも触れていない（基準にできる物を持っていない）');
        if (step.target.type !== 'direction' || res.error) return fail('空中では弾き出す方向（direction）の指定が必要');
        const a = res.angle;
        b.launchChar(c, Math.cos(a), Math.sin(a), { source: c, kind: 'aerial' });
        mark(c.x, c.y);
        return ok(`『${ab.name}』— 手のナイフを基準に、空中で直角に方向転換！`, `${c.name} が空中で、直角に軌道を変えた！`, c);
      }
      const surfaces = b.world.objects.filter(o => o.blocksMove && o.floor === c.floor && distToRect(c.x, c.y, o) <= c.r + 0.6);
      let surface = null;
      if (step.target.type === 'object') {
        if (res.error) return fail(res.error);
        surface = surfaces.find(o => o === res.obj);
        if (!surface) return fail(`${res.obj ? res.obj.name : '対象'}に触れていない（0.6m以内まで近づく必要がある）`);
      } else if (step.target.type === 'direction' && !res.error) {
        // 望む方向に最も近い向きの面を選ぶ（なければ真上）
        let best = -1;
        for (const o of surfaces) {
          const n = nearestPointOnRect(c.x, c.y, o);
          const a = angleTo(n.x, n.y, c.x, c.y);
          const dot = Math.cos(a - res.angle);
          if (dot > 0.5 && dot > best) { best = dot; surface = o; }
        }
      } else {
        let bestD = Infinity;
        for (const o of surfaces) {
          const d = distToRect(c.x, c.y, o);
          if (d < bestD) { bestD = d; surface = o; }
        }
      }
      if (surface) {
        const n = nearestPointOnRect(c.x, c.y, surface);
        let nx = c.x - n.x, ny = c.y - n.y;
        let l = Math.hypot(nx, ny);
        if (l < 1e-6) {
          const cc = rectCenter(surface);
          nx = c.x - cc.x; ny = c.y - cc.y; l = Math.hypot(nx, ny) || 1;
        }
        b.launchChar(c, nx / l, ny / l, { source: c, kind: 'self' });
        mark(n.x, n.y);
        return ok(`『${ab.name}』— ${surface.name}を蹴って、面の正面へ10m弾き出た！`, `${c.name} が${surface.name}から直角に弾け飛んだ！`, c);
      }
      // 開けた場所：床から真上へ。屋内なら天井にぶつかって止まる
      mark(c.x, c.y);
      if (buildingAt(b.world, c.x, c.y)) {
        const room = (FLOOR_H - 1.9);
        c.air = { since: b.t, landAt: b.t + 0.7, top: room, rise: 0.08 };
        b.launchDone(c.x, c.y, room);
        b.emit({ text: `『${ab.name}』— 真上へ弾けたが、${room.toFixed(2)}mで天井に激突した！`, obsText: `${c.name} が真上に弾けて天井に激突した！`, kind: 'ability', actor: c, pos: c, sound: 10, soundKind: 'impact', hint: ab.observedHint });
        b.launchImpact({ char: c }, c, '天井への激突');
        return { ok: true };
      }
      c.air = { landAt: b.t + 1.8, since: b.t };
      b.launchDone(c.x, c.y, 10);
      const note = step.target.type === 'direction' ? '（その方向に触れている面がないため）' : '';
      return ok(`『${ab.name}』— 床から真上へ10m跳び上がった${note}`, `${c.name} が真上へ高く跳び上がった！`, c);
    }

    if (effect === 'launch') {
      const reach = ab.effects.launch.range;
      if (step.target.type === 'object') {
        const o = res.obj;
        if (!o || !b.world.objects.includes(o) || !o.movable) return fail('動かせる物体ではない');
        if (o.floor !== c.floor) return fail(`${o.name}は別の階にある`);
        if ((o.kg ?? 0) > 100) return fail(`${o.name}は重すぎる（約${o.kg}kg、上限100kg）`);
        if (distToRect(c.x, c.y, o) > reach) return fail(`${o.name}に手が届かない（${distToRect(c.x, c.y, o).toFixed(1)}m > ${reach}m）`);
        const n = nearestPointOnRect(c.x, c.y, o);
        const cc = rectCenter(o);
        const a = angleTo(c.x, c.y, cc.x, cc.y);
        b.launchObject(o, Math.cos(a), Math.sin(a), c);
        mark(n.x, n.y);
        return ok(`『${ab.name}』— ${o.name}を手から離れる方向へ10m弾き出した！`, `${o.name}が直角に弾き出された！`, cc);
      }
      const t = enemyTarget(b, c, res, reach);
      if (t.err) return fail(t.err);
      const e = t.e;
      if (b.isAirborne(e)) return fail('空中の相手には触れられない');
      if (e.floor !== c.floor) return fail('相手が別の階にいる');
      if ((e.def.kg ?? 60) > 100) return fail(`${e.name}は重すぎる（上限100kg）`);
      const a = angleTo(c.x, c.y, e.x, e.y);
      mark((c.x + e.x) / 2, (c.y + e.y) / 2);
      b.emit({ text: `『${ab.name}』— ${e.name}に触れ、手から離れる方向へ10m弾き出す！`, obsText: `${c.name} の手が触れた瞬間、${e.name}が直角に弾き出された！`, kind: 'ability', actor: c, affected: e, pos: e, sound: ab.soundRadius, hint: ab.observedHint });
      b.damage(e, RULES.launchTouch, { source: c, kind: 'melee', from: c, label: '接触の打撃' });
      if (e.alive) {
        interruptStep(b, e, '直角に弾き出された', true);
        b.launchChar(e, Math.cos(a), Math.sin(a), { source: c, kind: 'target' });
      }
      return { ok: true };
    }

    // launch_held：手に持ったナイフを10m先まで
    if (c.knives <= 0) return fail('飛ばす物（ナイフ）を持っていない');
    if (res.error) return fail(res.error);
    const a = res.angle ?? angleTo(c.x, c.y, res.x, res.y);
    c.knives--;
    const tz = res.char ? b.baseZ(res.char) + 1.2 : undefined;
    b.spawnKnife(c, c.x, c.y, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, { speed: 30, damage: 12, maxRange: 10, tz });
    mark(c.x + Math.cos(a) * 0.5, c.y + Math.sin(a) * 0.5);
    return ok(`『${ab.name}』— 手のナイフを10m先まで弾き出した！（残り${c.knives}本）`, `${c.name} の手からナイフが一直線に弾き出された！`, c);
  },
};

export function applyAbility(b, c, step, res) {
  const ab = ABILITIES[step.ability];
  return IMPL[step.ability](b, c, step.effect, res, ab, step);
}
