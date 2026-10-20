// スタンド能力の効果処理。射程・視線・対象の妥当性はここで最終確認し、ルールに沿った効果だけを発生させる
import { ABILITIES, RULES } from './data.js';
import { dist, angleTo, nearestPointOnRect, distToRect, circleRectPush, rectCenter, clamp } from './vec.js';
import { hasLOS, markNavDirty } from './world.js';
import { interruptStep } from './plan.js';

let raisedSeq = 0;

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

function pointTarget(b, c, res, range, ab) {
  if (res.error) return { err: res.error };
  const { x, y } = res;
  if (!inRange(c, x, y, range)) return { err: `作用地点が射程外（${dist(c.x, c.y, x, y).toFixed(1)}m > ${range}m）` };
  if (!hasLOS(b.world, c.x, c.y, x, y)) return { err: `作用地点が遮蔽物の向こうで見えない（${ab.name}は視界内のみ）` };
  return { x, y };
}

function wallTarget(b, c, res, range) {
  if (res.error) return { err: res.error };
  const o = res.obj;
  if (!o || !b.world.objects.includes(o)) return { err: '対象の壁が存在しない' };
  const n = nearestPointOnRect(c.x, c.y, o);
  if (dist(c.x, c.y, n.x, n.y) > range) return { err: `${o.name}が射程外` };
  if (!hasLOS(b.world, c.x, c.y, n.x, n.y, o.id)) return { err: `${o.name}が見えない位置にある` };
  return { o };
}

const IMPL = {
  friction(b, c, effect, res, ab, step) {
    if (step.target.type === 'object') {
      const o = res.obj;
      if (!o || !o.movable) return fail('動かせる物体ではない');
      const cc = rectCenter(o);
      if (!inRange(c, cc.x, cc.y, ab.range)) return fail(`${o.name}が射程外`);
      if (!hasLOS(b.world, c.x, c.y, cc.x, cc.y, o.id)) return fail(`${o.name}が見えない`);
      o.slickUntil = b.t + 8;
      b.emit({
        text: `『${ab.name}』— ${o.name}の摩擦を奪った（8秒間、押すと勢いよく滑る）`,
        obsText: `${o.name}の表面が一瞬、青白く光った`,
        kind: 'ability', actor: c, pos: cc, sound: ab.soundRadius, hint: ab.observedHint,
      });
      return { ok: true };
    }
    let x, y;
    if (step.target.type === 'enemy') {
      const t = enemyTarget(b, c, res, ab.range);
      if (t.err) return fail(t.err);
      x = t.e.x; y = t.e.y;
    } else {
      const t = pointTarget(b, c, res, ab.range, ab);
      if (t.err) return fail(t.err);
      x = t.x; y = t.y;
    }
    b.world.zones.push({ kind: effect === 'grip' ? 'grip' : 'slick', x, y, r: ab.radius, until: b.t + ab.duration, owner: c.id });
    b.emit({
      text: `『${ab.name}：${ab.effects[effect].name}』— 地面の摩擦を${effect === 'grip' ? '増やした' : '奪った'}`,
      obsText: effect === 'grip' ? '地面が一瞬、鈍く光った' : '地面が一瞬、青白く光沢を帯びた',
      kind: 'ability', actor: c, pos: { x, y }, sound: ab.soundRadius, hint: ab.observedHint,
    });
    return { ok: true };
  },

  vector(b, c, effect, res, ab, step) {
    if (effect === 'redirect') {
      if (res.error) return fail(res.error);
      const p = res.projectile;
      if (!p || !b.world.projectiles.includes(p)) return fail('飛来物が既にない');
      if (!inRange(c, p.x, p.y, ab.range)) return fail(`飛来物が射程外（${dist(c.x, c.y, p.x, p.y).toFixed(1)}m）`);
      const sp = Math.hypot(p.vx, p.vy) * 1.1;
      let a;
      const pe = b.perceivedEnemy(c);
      const aim = step.aim || 'toward_enemy';
      if (aim === 'toward_enemy' && pe) a = angleTo(p.x, p.y, pe.x, pe.y);
      else if (aim === 'left') a = Math.PI;
      else if (aim === 'right') a = 0;
      else if (aim === 'up') a = -Math.PI / 2;
      else if (aim === 'down') a = Math.PI / 2;
      else a = Math.atan2(-p.vy, -p.vx);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.owner = c.id;
      p.born = b.t;
      p.traveled = 0;
      b.emit({
        text: `『${ab.name}：軌道変更』— 飛来物の向きを書き換えた！`,
        obsText: '飛んでいたナイフが空中で急に向きを変えた！',
        kind: 'ability', actor: c, pos: p, sound: ab.soundRadius, hint: ab.observedHint,
      });
      return { ok: true };
    }
    // repel
    if (step.target.type === 'object') {
      const o = res.obj;
      if (!o || !o.movable || !b.world.objects.includes(o)) return fail('動かせる物体ではない');
      if (distToRect(c.x, c.y, o) > ab.range) return fail(`${o.name}が射程外`);
      const cc = rectCenter(o);
      const a = angleTo(c.x, c.y, cc.x, cc.y);
      const sp = 10 / (o.mass || 1) * (o.slickUntil > b.t ? 1.4 : 1);
      o.vx = Math.cos(a) * sp; o.vy = Math.sin(a) * sp;
      o.pushedBy = c.id;
      b.emit({
        text: `『${ab.name}：弾き飛ばし』— ${o.name}を弾き飛ばした！`,
        obsText: `${o.name}が見えない力で弾き飛ばされた！`,
        kind: 'ability', actor: c, pos: cc, sound: ab.soundRadius, hint: ab.observedHint,
      });
      return { ok: true };
    }
    const t = enemyTarget(b, c, res, ab.range);
    if (t.err) return fail(t.err);
    const e = t.e;
    const a = angleTo(c.x, c.y, e.x, e.y);
    e.kbx = Math.cos(a) * 10; e.kby = Math.sin(a) * 10;
    e.kbSlam = { damage: 8, source: c };
    interruptStep(b, e, '見えない力で弾き飛ばされた', true);
    b.emit({
      text: `『${ab.name}：弾き飛ばし』— ${e.name}を弾き飛ばした！`,
      obsText: `${e.name}が見えない力で弾き飛ばされた！`,
      kind: 'ability', actor: c, affected: e, pos: e, sound: ab.soundRadius, hint: ab.observedHint,
    });
    return { ok: true };
  },

  masonry(b, c, effect, res, ab, step) {
    if (effect === 'raise') {
      if (res.error) return fail(res.error);
      let x = res.x, y = res.y;
      if (step.target.type === 'enemy') {
        const t = enemyTarget(b, c, res, ab.range + 1.5);
        if (t.err) return fail(t.err);
        const a = angleTo(t.e.x, t.e.y, c.x, c.y);
        x = t.e.x + Math.cos(a) * 1.2; y = t.e.y + Math.sin(a) * 1.2;
      } else if (step.target.type === 'direction') {
        const a = angleTo(c.x, c.y, res.x, res.y);
        x = c.x + Math.cos(a) * 1.6; y = c.y + Math.sin(a) * 1.6;
      }
      const t = pointTarget(b, c, { x, y }, ab.range, ab);
      if (t.err) return fail(t.err);
      const dx = Math.abs(x - c.x), dy = Math.abs(y - c.y);
      const rect = dx > dy ? { x: x - 0.25, y: y - 1.2, w: 0.5, h: 2.4 } : { x: x - 1.2, y: y - 0.25, w: 2.4, h: 0.5 };
      rect.x = clamp(rect.x, 0.5, b.world.w - 0.5 - rect.w);
      rect.y = clamp(rect.y, 0.5, b.world.h - 0.5 - rect.h);
      for (const ch of b.chars) {
        if (ch.alive && circleRectPush(ch.x, ch.y, ch.r, rect)) return fail('人がいる場所には壁を生やせない');
      }
      raisedSeq++;
      const o = {
        id: `raised_${raisedSeq}`, kind: 'wall', name: `隆起した壁${raisedSeq}`, ...rect,
        blocksMove: true, blocksSight: true, movable: false, hp: 40, maxHp: 40, soundDamp: 0.5,
        vx: 0, vy: 0, slickUntil: 0, indestructible: false, created: true,
      };
      b.world.objects.push(o);
      markNavDirty(b.world);
      b.emit({
        text: `『${ab.name}：壁の隆起』— 地面から${o.name}がせり上がった！`,
        obsText: '地面の石材が盛り上がり、壁がせり上がった！',
        kind: 'ability', actor: c, pos: { x, y }, sound: ab.soundRadius, hint: ab.observedHint,
      });
      return { ok: true };
    }
    const t = wallTarget(b, c, res, ab.range);
    if (t.err) return fail(t.err);
    const o = t.o;
    const cc = rectCenter(o);
    if (effect === 'spike') {
      b.emit({
        text: `『${ab.name}：棘の突出』— ${o.name}から無数の棘が突き出す！`,
        obsText: `${o.name}の表面から石の棘が突き出した！`,
        kind: 'ability', actor: c, pos: cc, sound: ab.soundRadius, hint: ab.observedHint,
      });
      let hitAny = false;
      for (const ch of b.chars) {
        if (ch === c || !ch.alive || distToRect(ch.x, ch.y, o) > 1.3) continue;
        hitAny = true;
        const n = nearestPointOnRect(ch.x, ch.y, o);
        const a = angleTo(n.x, n.y, ch.x, ch.y);
        b.damage(ch, 14, { source: c, kind: 'spike', label: '石の棘' });
        ch.kbx = Math.cos(a) * 6; ch.kby = Math.sin(a) * 6;
      }
      if (!hitAny) b.emit({ text: '……棘の届く範囲には誰もいなかった', kind: 'fail', actor: c });
      return { ok: true };
    }
    // breach
    if (o.indestructible) return fail(`${o.name}は崩せない`);
    b.emit({
      text: `『${ab.name}：崩落』— ${o.name}を崩した！`,
      obsText: `${o.name}が突然、生き物のように崩れた！`,
      kind: 'ability', actor: c, pos: cc, sound: ab.soundRadius, hint: ab.observedHint,
    });
    b.destroyObject(o, c);
    return { ok: true };
  },

  hush(b, c, effect, res, ab, step) {
    if (effect === 'deafen') {
      const t = enemyTarget(b, c, res, ab.range);
      if (t.err) return fail(t.err);
      t.e.status.deafUntil = b.t + 6;
      b.emit({
        text: `『${ab.name}：聴覚封じ』— ${t.e.name}の耳から音を奪った`,
        obsText: '突然、何も聞こえなくなった！',
        kind: 'ability', actor: c, affected: t.e, hint: ab.observedHint,
      });
      return { ok: true };
    }
    let x = c.x, y = c.y;
    if (step.target.type === 'point') {
      const t = pointTarget(b, c, res, ab.range, ab);
      if (t.err) return fail(t.err);
      x = t.x; y = t.y;
    }
    b.world.zones.push({ kind: 'silence', x, y, r: ab.radius, until: b.t + ab.duration, owner: c.id });
    b.emit({ text: `『${ab.name}：無音領域』— 周囲の音が消えた`, kind: 'ability', actor: c });
    // 領域内にいた敵は「音が消えた」ことに気づきうる
    const e = b.enemyOf(c);
    if (e.alive && dist(e.x, e.y, x, y) <= ab.radius) {
      b.emit({ text: '周囲の音がふっと消えた……？', kind: 'ability', affected: e, hint: ab.observedHint });
    }
    return { ok: true };
  },
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
      const surfaces = b.world.objects.filter(o => o.blocksMove && !b.isAirborne(c) && distToRect(c.x, c.y, o) <= c.r + 0.6);
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
      // 開けた場所：床から真上へ
      c.air = { landAt: b.t + 1.8, since: b.t };
      mark(c.x, c.y);
      b.launchDone(c.x, c.y, 10);
      const note = step.target.type === 'direction' ? '（その方向に触れている面がないため）' : '';
      return ok(`『${ab.name}』— 床から真上へ10m跳び上がった${note}`, `${c.name} が真上へ高く跳び上がった！`, c);
    }

    if (effect === 'launch') {
      const reach = ab.effects.launch.range;
      if (step.target.type === 'object') {
        const o = res.obj;
        if (!o || !b.world.objects.includes(o) || !o.movable) return fail('動かせる物体ではない');
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
    b.spawnKnife(c, c.x, c.y, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, { speed: 30, damage: 12, maxRange: 10 });
    mark(c.x + Math.cos(a) * 0.5, c.y + Math.sin(a) * 0.5);
    return ok(`『${ab.name}』— 手のナイフを10m先まで弾き出した！（残り${c.knives}本）`, `${c.name} の手からナイフが一直線に弾き出された！`, c);
  },
};

export function applyAbility(b, c, step, res) {
  const ab = ABILITIES[step.ability];
  return IMPL[step.ability](b, c, step.effect, res, ab, step);
}
