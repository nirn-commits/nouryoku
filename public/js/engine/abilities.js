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
        // 空中：手に持った物を接触面として、水平方向に弾き出す
        if (!c.held) return fail('空中で何にも触れていない（基準にできる物を持っていない）');
        if (step.target.type !== 'direction' || res.error) return fail('空中では弾き出す方向（direction）の指定が必要');
        const a = res.angle;
        b.launchChar(c, Math.cos(a), Math.sin(a), { source: c, kind: 'aerial' });
        mark(c.x, c.y);
        return ok(`『${ab.name}』— 手の${c.held.name}を基準に、空中で直角に方向転換！`, `${c.name} が空中で、直角に軌道を変えた！`, c);
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

    // launch_held：手に持った物を10m先まで
    if (!c.held) return fail('飛ばす物を持っていない（先に何か拾う）');
    if (res.error) return fail(res.error);
    const a = res.angle ?? angleTo(c.x, c.y, res.x, res.y);
    const item = c.held;
    c.held = null;
    const tz = res.char ? b.baseZ(res.char) + 1.2 : undefined;
    b.spawnThrown(c, item, c.x, c.y, c.x + Math.cos(a) * 10, c.y + Math.sin(a) * 10, { speed: 30, damage: RULES.launchImpact, maxRange: 10, tz });
    mark(c.x + Math.cos(a) * 0.5, c.y + Math.sin(a) * 0.5);
    return ok(`『${ab.name}』— 手の${item.name}を10m先まで弾き出した！`, `${c.name} の手から${item.name}が一直線に弾き出された！`, c);
  },
  echo(b, c, effect, res, ab, step) {
    const units = c.units;
    const alive = units.filter(u => u.state !== 'dead');
    if (!alive.length) return fail('個体がすべて潰されている');
    const log = text => b.emit({ text: `『${ab.name}』— ${text}`, kind: 'ability', actor: c });
    const free = () => alive.filter(u => u.state === 'home' || (u.state === 'deployed' && !u.sound)).sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y));
    const targetPoint = () => {
      if (res.error) return null;
      return { x: res.x, y: res.y, floor: res.f ?? 0 };
    };
    const inRange50 = p => dist(c.x, c.y, p.x, p.y) <= ab.range;
    switch (effect) {
      case 'silence_self': {
        const already = alive.filter(u => u.state === 'attached' && u.attachedTo === c.id).length;
        const pick = free().slice(0, Math.max(0, 2 - already));
        for (const u of pick) { u.state = 'attached'; u.attachedTo = c.id; }
        if (!already && !pick.length) return fail('空いている個体がない');
        log('2体を自分に取り付かせ、自分の足音と物音を消した');
        return { ok: true };
      }
      case 'recall': {
        let n = 0;
        for (const u of alive) {
          if (u.state === 'home') continue;
          u.state = 'recall'; u.attachedTo = null; u.target = { char: c }; n++;
        }
        log(`${n}体を手元へ呼び戻す`);
        return { ok: true };
      }
      case 'deploy': {
        const p = targetPoint();
        if (!p) return fail(res.error || '配置する場所が分からない');
        if (!inRange50(p)) return fail(`配置先が射程外（${dist(c.x, c.y, p.x, p.y).toFixed(1)}m > 50m）`);
        const pick = free().slice(0, step.count ?? 4);
        if (!pick.length) return fail('空いている個体がない');
        pick.forEach((u, i) => {
          const a = (i / pick.length) * Math.PI * 2;
          u.state = 'move'; u.attachedTo = null;
          u.target = { x: p.x + Math.cos(a) * 0.5, y: p.y + Math.sin(a) * 0.5, floor: p.floor };
        });
        log(`${pick.length}体を(${p.x.toFixed(1)}, ${p.y.toFixed(1)})へ送り、聞き耳を立てさせる`);
        return { ok: true };
      }
      case 'attach': {
        const e = b.enemyOf(c);
        if (res.error) return fail(res.error);
        if (!inRange50(e)) return fail('敵が50mより遠い');
        if (alive.some(u => (u.state === 'attached' || u.state === 'attach') && u.attachedTo === e.id || (u.state === 'attach' && u.target.char === e))) return fail('既に敵に個体が向かっている');
        const u = free()[0];
        if (!u) return fail('空いている個体がない');
        u.state = 'attach'; u.target = { char: e };
        log(`◆${u.n}を${e.name}へ飛ばす（取り付けば足音と声を奪える）`);
        return { ok: true };
      }
      case 'place': {
        const p = targetPoint();
        if (!p) return fail(res.error || '音を置く場所が分からない');
        if (!inRange50(p)) return fail(`置く場所が射程外（${dist(c.x, c.y, p.x, p.y).toFixed(1)}m > 50m）`);
        const want = step.sound || 'any';
        const match = u => u.sound && u.state !== 'attached' && (want === 'any'
          || (want === 'footsteps' && u.sound.kind.startsWith('footsteps'))
          || (want === 'voice' && u.sound.kind === 'speech')
          || (want === 'loud' && b.isLoud(u.sound)));
        // 取り付いたまま声を抱えている個体も、離れて運べる
        const holder = alive.filter(match)[0] || (want === 'voice' ? alive.find(u => u.sound && u.sound.kind === 'speech') : null);
        if (!holder) return fail(`置ける音（${{ footsteps: '足音', voice: '声', loud: '大きな音', any: '音' }[want]}）を抱えた個体がいない`);
        holder.state = 'place'; holder.attachedTo = null;
        holder.target = { x: p.x, y: p.y, floor: p.floor };
        log(`◆${holder.n}が「${holder.sound.label}${holder.sound.text ? `：${holder.sound.text}` : ''}」を運ぶ`);
        return { ok: true };
      }
      case 'roar': {
        const e = b.enemyOf(c);
        const t = res.error ? null : res;
        if (!t) return fail(res.error);
        if (dist(c.x, c.y, e.x, e.y) > ab.range) return fail('敵が50mより遠い');
        const loud = alive.filter(u => b.isLoud(u.sound));
        if (!loud.length) return fail('大きな音を一つも集めていない（決め技にならない）');
        for (const u of loud) { u.state = 'roar'; u.attachedTo = null; u.target = { char: e }; u.since = b.t; u.armed = false; }
        log(`集めた大きな音${loud.length}つを抱えた個体が、一斉に${e.name}の耳元へ`);
        return { ok: true };
      }
    }
    return fail('不明な効果');
  },

  seventh(b, c, effect, res, ab, step) {
    const inFlight = b.world.projectiles.filter(p => p.kind === 'ball' && p.owner === c.id).length;
    const need = effect === 'spread' ? 3 : 1;
    if (inFlight + need > 3) return fail(`同時に飛ばせる弾は3発まで（飛んでいる弾${inFlight}発）`);
    if (res.error) return fail(res.error);
    const z = b.baseZ(c) + 1.3;
    const aimAt = res.angle !== undefined ? null : { x: res.x, y: res.y };
    const direct = aimAt ? angleTo(c.x, c.y, aimAt.x, aimAt.y) : res.angle;
    const rnd = () => (b.rng() - 0.5) * 2;
    // 反射回数 k で目標の近く（0.45m以内）を通る角度を探す
    // 当たる角度が連続している範囲の中央を選ぶ（かすめる角度より誤差に強い）
    const solve = k => {
      const N = 1440;
      const hits = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        let found = null, length = 0, blockedEarly = false;
        b.traceBall(c.x, c.y, z, c.floor, Math.cos(a), Math.sin(a), 100, (sg, bounces) => {
          const segLen = Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0);
          const vx = sg.x1 - sg.x0, vy = sg.y1 - sg.y0;
          const tt = segLen > 0 ? Math.max(0, Math.min(1, ((aimAt.x - sg.x0) * vx + (aimAt.y - sg.y0) * vy) / (segLen * segLen))) : 0;
          const px = sg.x0 + vx * tt, py = sg.y0 + vy * tt;
          const d = Math.hypot(aimAt.x - px, aimAt.y - py);
          if (d < 0.45) {
            if (bounces === k) found = { a, length: length + segLen * tt, d };
            else if (bounces < k) blockedEarly = true; // もっと早く目標を通ってしまう
            return false;
          }
          // 自分に戻ってくる弾道は避ける
          if (bounces > 0) {
            const sx = (c.x - sg.x0) * vx + (c.y - sg.y0) * vy;
            const st2 = segLen > 0 ? Math.max(0, Math.min(1, sx / (segLen * segLen))) : 0;
            if (Math.hypot(c.x - (sg.x0 + vx * st2), c.y - (sg.y0 + vy * st2)) < 0.8) { blockedEarly = true; return false; }
          }
          length += segLen;
          return bounces <= k;
        });
        hits[i] = found && !blockedEarly ? found : null;
      }
      let best = null;
      for (let i = 0; i < N; i++) {
        if (!hits[i] || hits[(i + N - 1) % N]) continue;
        let j = i;
        while (hits[(j + 1) % N] && j - i < N) j++;
        const mid = hits[Math.round((i + j) / 2) % N] || hits[i];
        const run = { ...mid, width: j - i + 1 };
        // 幅の広い（誤差に強い）弾道を優先し、同程度なら短い方
        if (!best || run.width * 10 - run.length > best.width * 10 - best.length) best = run;
      }
      return best;
    };
    let angles = [];
    let note = '';
    if (effect === 'direct' || !aimAt) {
      angles = [direct];
    } else {
      const want = step.bounces ?? 2;
      const order = [want, want + 1, want - 1, want + 2, want - 2, want + 3].filter(k => k >= 1 && k <= 7);
      let sol = null, usedK = want;
      for (const k of order) { sol = solve(k); if (sol) { usedK = k; break; } }
      if (!sol) {
        note = '（届く跳弾の角度が見つからず、直接狙った）';
        angles = [direct];
      } else {
        if (usedK !== want) note = `（${want}回では届かず、${usedK}回反射で計算）`;
        // 反射を重ねるほど狙いの誤差が増える（精密動作性A なので小さい）
        const err = rnd() * (0.15 + 0.12 * usedK) * Math.PI / 180;
        angles = [sol.a + err];
        if (effect === 'spread') {
          const s2 = solve(usedK + 1), s3 = solve(Math.max(1, usedK - 1));
          angles.push(s2 ? s2.a : sol.a + 0.12, s3 && Math.abs(s3.a - sol.a) > 0.01 ? s3.a : sol.a - 0.12);
        }
      }
      if (effect === 'spread' && angles.length === 1) angles.push(angles[0] + 0.15, angles[0] - 0.15);
    }
    const balls = c.balls;
    if (balls < angles.length) note += balls ? '' : '（玉が尽きたので小石で代用）';
    c.balls = Math.max(0, balls - angles.length);
    for (const a of angles) b.spawnBall(c, a);
    b.emit({
      text: `『${ab.name}』— ${effect === 'direct' ? '指で弾を弾いた' : effect === 'spread' ? '3発を角度を変えて弾いた' : `${step.bounces ?? 2}回の跳弾を狙って弾いた`}${note}（残り${c.balls}個）`,
      obsText: `${c.name} の胸元の白い腕が、小さな玉を指で弾いた！`,
      kind: 'ability', actor: c, pos: c, sound: ab.soundRadius, soundKind: 'flick', hint: ab.observedHint,
    });
    return { ok: true };
  },
};

export function applyAbility(b, c, step, res) {
  const ab = ABILITIES[step.ability];
  return IMPL[step.ability](b, c, step.effect, res, ab, step);
}
