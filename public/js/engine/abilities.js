// スタンド能力の効果処理。射程・視線・対象の妥当性はここで最終確認し、ルールに沿った効果だけを発生させる
import { ABILITIES, RULES } from './data.js';
import { dist, angleTo, nearestPointOnRect, distToRect, circleRectPush, rectCenter, clamp } from './vec.js';
import { buildingAt, FLOOR_H } from './world.js';
import { interruptStep } from './plan.js';
import { applyGeneric } from './generic.js';


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

    if (effect === 'uplift') {
      const t = enemyTarget(b, c, res, ab.effects.uplift.range);
      if (t.err) return fail(t.err);
      const e = t.e;
      if (b.isAirborne(e) || e.launch) return fail('相手が地面に立っていない');
      if (e.floor !== c.floor) return fail('相手が別の階にいる');
      if ((e.def.kg ?? 60) > 100) return fail(`${e.name}は重すぎる（上限100kg）`);
      mark(e.x, e.y);
      interruptStep(b, e, '足元から真上へ弾き上げられた', true);
      if (buildingAt(b.world, e.x, e.y)) {
        b.emit({ text: `『${ab.name}』— ${e.name}を床から真上へ弾き上げ、天井に叩きつけた！`, obsText: `${c.name} が触れた瞬間、${e.name}が真上へ弾けて天井に激突した！`, kind: 'ability', actor: c, affected: e, pos: e, sound: 10, soundKind: 'impact', hint: ab.observedHint });
        b.damage(e, 10, { source: c, kind: 'slam', label: '天井への激突' });
        e.status.stunUntil = Math.max(e.status.stunUntil, b.t + 0.8);
        return { ok: true };
      }
      e.air = { landAt: b.t + 1.8, since: b.t };
      e.uplifted = { source: c };
      e.kbx = e.kby = 0;
      b.launchDone(e.x, e.y, 10);
      return ok(`『${ab.name}』— ${e.name}を足元の地面から真上へ10m打ち上げた！`, `${c.name} が触れた瞬間、${e.name}が真上へ打ち上げられた！`, e, e);
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
      case 'silence_zone': {
        const p = targetPoint();
        if (!p) return fail(res.error || '結界を張る場所が分からない');
        if (!inRange50(p)) return fail(`結界の場所が射程外（${dist(c.x, c.y, p.x, p.y).toFixed(1)}m > 50m）`);
        const pick = free().slice(0, 6);
        if (pick.length < 4) return fail('空いている個体が足りない（4体以上必要）');
        let far = 0;
        pick.forEach((u, i) => {
          const a = (i / pick.length) * Math.PI * 2;
          u.state = 'move'; u.attachedTo = null;
          u.target = { x: p.x + Math.cos(a) * 2.6, y: p.y + Math.sin(a) * 2.6, floor: p.floor };
          far = Math.max(far, dist(u.x, u.y, u.target.x, u.target.y));
        });
        // 個体が円陣に着いた時点から10秒間
        const start = b.t + far / 10;
        b.schedule(start, () => b.addZone({ kind: 'silence', x: p.x, y: p.y, r: 3, floor: p.floor, until: start + 10, owner: c.id, team: c.team }));
        log(`${pick.length}体で(${p.x.toFixed(1)}, ${p.y.toFixed(1)})に円陣を組み、無音の結界を張る（半径3m・10秒）`);
        return { ok: true };
      }
      case 'decoy_walk': {
        const p = targetPoint();
        if (!p) return fail(res.error || '足音を向かわせる場所が分からない');
        if (!inRange50(p)) return fail('射程外（50mより遠い）');
        const holder = alive.find(u => u.sound && u.sound.kind.startsWith('footsteps') && u.state !== 'attached');
        if (!holder) return fail('足音を抱えた個体がいない（先に足音を集める）');
        const snd = holder.sound;
        holder.sound = null;
        holder.state = 'move'; holder.attachedTo = null; holder.target = { x: p.x, y: p.y, floor: p.floor };
        // 本体の少し先から目的地まで、0.5秒ごとに足音を鳴らす
        const sx = c.x + (p.x - c.x) * 0.25, sy = c.y + (p.y - c.y) * 0.25;
        for (let i = 0; i < 6; i++) {
          const k = i / 5;
          const at = { x: sx + (p.x - sx) * k, y: sy + (p.y - sy) * k, floor: p.floor };
          b.schedule(b.t + 0.3 + i * 0.5, () => b.playAt(at, snd.radius, snd.kind, c));
        }
        log(`「${snd.label}」を並べ、(${p.x.toFixed(1)}, ${p.y.toFixed(1)})へ向かう足音の行列を鳴らす`);
        return { ok: true };
      }
      case 'scratch': {
        const e = b.enemyOf(c);
        if (res.error) return fail(res.error);
        if (!inRange50(e)) return fail('敵が50mより遠い');
        const pick = free().slice(0, Math.min(12, Math.max(1, step.count ?? 6)));
        if (!pick.length) return fail('空いている個体がない');
        for (const u of pick) { u.state = 'scratch'; u.attachedTo = null; u.target = { char: e }; u.since = b.t; u.armed = false; }
        log(`${pick.length}体を${e.name}へ飛ばし、群がって引っかかせる`);
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
    if (effect === 'caltrops') {
      if (res.error) return fail(res.error);
      if (c.balls <= 0) return fail('玉が残っていない');
      let { x, y } = res;
      if (res.self) { x = c.x; y = c.y; }
      if (dist(c.x, c.y, x, y) > ab.effects.caltrops.range) return fail(`撒く場所が遠すぎる（${dist(c.x, c.y, x, y).toFixed(1)}m > ${ab.effects.caltrops.range}m）`);
      const n = Math.min(5, c.balls);
      c.balls -= n;
      b.addZone({ kind: 'caltrops', x, y, r: 1.5, floor: res.f ?? c.floor, until: b.t + 20, owner: c.id, team: c.team, n });
      b.emit({ text: `『${ab.name}』— 玉を${n}個、(${x.toFixed(1)}, ${y.toFixed(1)})の床に撒いた（残り${c.balls}個）`, obsText: `${c.name} が床に小さな玉をばら撒いた`, kind: 'ability', actor: c, pos: { x, y }, sound: 4, soundKind: 'flick', hint: ab.observedHint });
      return { ok: true };
    }
    if (effect === 'suppress') {
      if (res.error) return fail(res.error);
      if (c.balls <= 0) return fail('玉が残っていない');
      const e = res.char || (step.target.type === 'enemy' ? b.enemyOf(c) : null);
      c.burst = { left: Math.min(4, c.balls), next: b.t, angle: res.angle ?? angleTo(c.x, c.y, res.x, res.y), target: e };
      b.emit({ text: `『${ab.name}』— 牽制の連射を始める`, kind: 'ability', actor: c, pos: c, hint: ab.observedHint });
      return { ok: true };
    }
    const inFlight = b.world.projectiles.filter(p => p.kind === 'ball' && p.owner === c.id).length;
    const need = effect === 'spread' ? 3 : 1;
    if (inFlight + need > 3) return fail(`同時に飛ばせる弾は3発まで（飛んでいる弾${inFlight}発）`);
    if (res.error) return fail(res.error);
    const z = b.baseZ(c) + 1.3;
    // スタンドを先行させていれば、その位置（角の先など）から弾く
    const o = b.standOrigin(c);
    const aimAt = res.angle !== undefined ? null : { x: res.x, y: res.y };
    const direct = aimAt ? angleTo(o.x, o.y, aimAt.x, aimAt.y) : res.angle;
    const rnd = () => (b.rng() - 0.5) * 2;
    // 反射回数 k で目標の近く（0.45m以内）を通る角度を探す
    // 当たる角度が連続している範囲の中央を選ぶ（かすめる角度より誤差に強い）
    const solve = k => {
      const N = b.isSim ? 240 : 1440; // 先読みの中では粗く計算する
      const hits = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        let found = null, length = 0, blockedEarly = false, after = 0;
        b.traceBall(o.x, o.y, z, c.floor, Math.cos(a), Math.sin(a), 100, (sg, bounces) => {
          const segLen = Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0);
          const vx = sg.x1 - sg.x0, vy = sg.y1 - sg.y0;
          // 外れた後の弾道：目標を通り過ぎた弾が跳ね返って自分に戻ってこないか（2回跳ねる分まで確かめる）
          if (found) {
            const sx = (c.x - sg.x0) * vx + (c.y - sg.y0) * vy;
            const st2 = segLen > 0 ? Math.max(0, Math.min(1, sx / (segLen * segLen))) : 0;
            if (Math.hypot(c.x - (sg.x0 + vx * st2), c.y - (sg.y0 + vy * st2)) < 0.9) { blockedEarly = true; return false; }
            return ++after < 3;
          }
          const tt = segLen > 0 ? Math.max(0, Math.min(1, ((aimAt.x - sg.x0) * vx + (aimAt.y - sg.y0) * vy) / (segLen * segLen))) : 0;
          const px = sg.x0 + vx * tt, py = sg.y0 + vy * tt;
          const d = Math.hypot(aimAt.x - px, aimAt.y - py);
          if (d < 0.45) {
            if (bounces === k) { found = { a, length: length + segLen * tt, d }; return true; }
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
    for (const a of angles) b.spawnBall(c, a, o);
    b.emit({
      text: `『${ab.name}』— ${effect === 'direct' ? '指で弾を弾いた' : effect === 'spread' ? '3発を角度を変えて弾いた' : `${step.bounces ?? 2}回の跳弾を狙って弾いた`}${note}（残り${c.balls}個）`,
      obsText: `${c.name} の胸元の白い腕が、小さな玉を指で弾いた！`,
      kind: 'ability', actor: c, pos: c, sound: ab.soundRadius, soundKind: 'flick', hint: ab.observedHint,
    });
    return { ok: true };
  },
};

// ホテル・カリフォルニア：密室の中で、相手を炎の壁へ叩きつける
IMPL.hotel = (b, c, effect, res, ab) => {
  if (effect !== 'flame_slam') return fail('不明な効果');
  const room = buildingAt(b.world, c.x, c.y);
  if (!room || !room.sealed || room.sealed.by !== c.id) return fail('自分の密室の中でしか使えない');
  const e = b.enemyOf(c);
  if (!e.alive || !b.canSee(c, e.x, e.y)) return fail('相手が見えていない');
  if (dist(c.x, c.y, e.x, e.y) > 1.6) return fail(`相手に手が届かない（${dist(c.x, c.y, e.x, e.y).toFixed(1)}m > 1.6m）`);
  // 一番近い外壁の方向へ投げる
  const edges = [
    { d: e.x - room.x, x: -1, y: 0 }, { d: room.x + room.w - e.x, x: 1, y: 0 },
    { d: e.y - room.y, x: 0, y: -1 }, { d: room.y + room.h - e.y, x: 0, y: 1 },
  ].sort((p, q) => p.d - q.d);
  let dir = edges[0];
  // 開けてある出口が近ければ、そこ（炎の口）へ投げ込む：火傷を負って弾き戻される
  const gate = room.exits.map(id => b.objectById(id)).filter(o => o && (o.open || o.broken) && (o.floor ?? 0) === e.floor)
    .map(o => ({ o, x: o.x + o.w / 2, y: o.y + o.h / 2 })).filter(g => dist(e.x, e.y, g.x, g.y) < 6)
    .sort((p, q) => dist(e.x, e.y, p.x, p.y) - dist(e.x, e.y, q.x, q.y))[0];
  if (gate) { const l = dist(e.x, e.y, gate.x, gate.y) || 1; dir = { x: (gate.x - e.x) / l, y: (gate.y - e.y) / l }; }
  interruptStep(b, e, '壁へ投げつけられた', true);
  b.emit({ text: `『${ab.name}』— ${e.name}を掴み、外壁へ叩きつける！`, obsText: `${c.name} が ${e.name} を壁へ投げつけた！`, kind: 'ability', actor: c, affected: e, pos: e, sound: 10, soundKind: 'impact', hint: ab.observedHint });
  b.damage(e, 8, { source: c, kind: 'grab', label: '投げつけ' });
  if (e.alive) {
    e.kbx = dir.x * 11; e.kby = dir.y * 11;
    e.kbSlam = { damage: 6, source: c };
    e.status.proneUntil = Math.max(e.status.proneUntil, b.t + 0.8);
  }
  return { ok: true };
};

// プリティ・ヴェイカント：スタンドの手のひらで触れた物を粉に変える／粉を集めて元に戻す
IMPL.vacant = (b, c, effect, res, ab, step) => {
  const R = ab.range;
  // スタンドを触れる場所まで伸ばす（壁はすり抜ける）
  const reach = (x, y, floor = c.floor) => {
    const s = b.standOut(c);
    const d = dist(c.x, c.y, x, y);
    const k = d > R ? R / d : 1;
    s.x = c.x + (x - c.x) * k; s.y = c.y + (y - c.y) * k; s.floor = floor === c.floor ? floor : c.floor;
    s.goal = { x: s.x, y: s.y };
    s.facing = angleTo(c.x, c.y, x, y);
  };
  const talking = e => !!(c.speech && c.speech.heardBy && c.speech.heardBy.has(e.id));

  if (effect === 'powder_floor' || effect === 'powder_weapon') {
    const t = enemyTarget(b, c, res, R);
    if (t.err) return fail(t.err);
    const e = res.char || t.e;
    if (b.isAirborne(e)) return fail('相手が宙にいて、足場も得物も触れない');
    reach(e.x, e.y, e.floor);
    if (effect === 'powder_weapon') {
      if (e.held) {
        const name = e.held.name;
        e.held = null;
        b.puff('dust', e);
        b.emit({ text: `『${ab.name}』— ${e.name}の${name}が、手の中でさらさらと粉になって崩れた！`, obsText: `${e.name} の手の${name}が、触れてもいないのに粉になって崩れた！`, kind: 'ability', actor: c, affected: e, pos: e, sound: ab.soundRadius, soundKind: 'powder', hint: ab.observedHint });
        return { ok: true };
      }
      if ((e.balls ?? 0) > 0) {
        const n = Math.min(8, e.balls);
        e.balls -= n;
        b.emit({ text: `『${ab.name}』— ${e.name}のポケットのパチンコ玉${n}個を鉄粉にした（残り${e.balls}個）`, obsText: `${e.name} のポケットから、さらさらと鉄粉がこぼれた`, kind: 'ability', actor: c, affected: e, pos: e, sound: 3, soundKind: 'powder', hint: ab.observedHint });
        return { ok: true };
      }
      return fail(`${e.name}は何も持っていない`);
    }
    // 足場を崩す：2階なら床が抜けて落ちる
    const distracted = talking(e);
    interruptStep(b, e, '足元の床が粉になって崩れた', true);
    e.status.guardUntil = 0;
    e.status.counterUntil = 0;
    b.addPile({ x: e.x - 0.6, y: e.y - 0.6, w: 1.2, h: 1.2 }, e.floor, e.floor === 1 ? '床材の粉' : (buildingAt(b.world, e.x, e.y) ? '床材の粉' : '石粉'), null, c);
    b.puff('dust', e);
    const fell = e.floor === 1;
    b.emit({
      text: `『${ab.name}』— ${e.name}の足元の床を粉にした！${fell ? ' 床が抜けて1階へ落ちる！' : ''}${distracted ? '（話に気を取られていた）' : ''}`,
      obsText: `${e.name} の足元の床が、さらさらと粉になって崩れた！`,
      kind: 'ability', actor: c, affected: e, pos: e, sound: ab.soundRadius, soundKind: 'powder', hint: ab.observedHint,
    });
    b.damage(e, 4, { source: c, kind: 'ability', label: '崩れた足場' });
    if (e.alive) {
      e.vx = e.vy = 0; e.kbx = e.kby = 0;
      if (fell) b.startDrop(e);
      e.status.proneUntil = Math.max(e.status.proneUntil, b.t + 1.4 + (distracted ? 0.6 : 0));
    }
    return { ok: true };
  }

  if (effect === 'powder_trap') {
    if (res.error) return fail(res.error);
    const x = res.self ? c.x : res.x, y = res.self ? c.y : res.y;
    const floor = res.f ?? c.floor;
    if (dist(c.x, c.y, x, y) > R + 0.01) return fail(`仕込む場所が射程外（${dist(c.x, c.y, x, y).toFixed(1)}m > ${R}m）`);
    reach(x, y, floor);
    const mine = b.world.zones.filter(z => z.kind === 'powder_trap' && z.owner === c.id);
    if (mine.length >= 2) b.world.zones = b.world.zones.filter(z => z !== mine[0]);
    b.addZone({ kind: 'powder_trap', x, y, r: 1.2, floor, until: b.t + 30, owner: c.id, team: c.team });
    b.emit({ text: `『${ab.name}』— (${x.toFixed(1)}, ${y.toFixed(1)})の床の内側だけを粉にして、表面を残しておいた（踏めば抜ける・30秒）`, obsText: `${c.name} のスタンドが床に手のひらを当てた`, kind: 'ability', actor: c, pos: { x, y, floor }, sound: 2, soundKind: 'powder', hint: ab.observedHint });
    return { ok: true };
  }

  if (effect === 'powder_object') {
    if (res.error) return fail(res.error);
    const o = res.obj;
    if (!o) return fail('粉にできる物体を指定する必要がある');
    if (!b.canPowder(o)) return fail(`${o.name}は粉にできない（外壁・車・木・柱や、既に割れた窓は不可）`);
    if (o.floor !== c.floor && !(o.floor === 1 && c.floor === 0 && buildingAt(b.world, c.x, c.y))) return fail(`${o.name}は別の階にある`);
    const d = distToRect(c.x, c.y, o);
    if (d > R) return fail(`${o.name}に手が届かない（${d.toFixed(1)}m > ${R}m）`);
    const n = nearestPointOnRect(c.x, c.y, o);
    reach(n.x, n.y, o.floor);
    b.powderObject(o, c, n);
    b.emit({ text: `『${ab.name}』— ${o.name}に手のひらを当てた`, obsText: `${c.name} のスタンドが${o.name}に手のひらを当てた`, kind: 'ability', actor: c, pos: n, sound: 0, hint: ab.observedHint });
    return { ok: true };
  }

  if (effect === 'restore') {
    const piles = (b.world.piles || []).filter(p => p.obj && !p.scattered);
    const at = res.error || res.self ? c : (res.center || res);
    const near = res.pile ? { p: res.pile } : piles
      .map(p => ({ p, d: distToRect(at.x, at.y, p), dc: distToRect(c.x, c.y, p) }))
      .filter(q => q.dc <= R)
      .sort((p, q) => p.d - q.d)[0];
    if (!near) return fail('5m以内に、戻せる粉の山がない');
    if (distToRect(c.x, c.y, near.p) > R) return fail(`粉の山に手が届かない（${distToRect(c.x, c.y, near.p).toFixed(1)}m > ${R}m）`);
    const cc = rectCenter(near.p);
    reach(cc.x, cc.y, near.p.floor);
    const err = b.restorePile(near.p, c);
    if (err) return fail(err);
    return { ok: true };
  }
  return fail('不明な効果');
};

// リトル・レッド・コルベット：車両の通った跡に口を残す／食いしばって噛む／全部の口から喋る
IMPL.corvette = (b, c, effect, res, ab, step) => {
  if (c.status.grabbedUntil > b.t) return fail('口を押さえられていて、能力が使えない');
  if (effect === 'dismiss') {
    const n = c.mouths.length;
    c.mouths = [];
    c.clench = null;
    b.emit({ text: `『${ab.name}』— 残した口${n}個をすべて消した`, kind: 'ability', actor: c, pos: c });
    return { ok: true };
  }
  if (effect === 'bite') {
    if (!c.mouths.length) return fail('口をひとつも残していない');
    const dur = step.duration || 4;
    c.clench = { since: b.t, until: b.t + dur };
    // 喋っている最中なら、そのセリフはここで途切れる
    if (c.speech) c.speech.until = b.t;
    b.emit({ text: `『${ab.name}』— 歯を食いしばる（${dur.toFixed(1)}秒・${c.mouths.length}個の口がすべて噛む）`, obsText: `${c.name} がぐっと歯を食いしばった`, kind: 'ability', actor: c, pos: c, hint: ab.observedHint });
    return { ok: true };
  }
  if (effect === 'call') {
    if (!c.mouths.length) return fail('口をひとつも残していない');
    const text = (step.raw && typeof step.raw.text === 'string' && step.raw.text) || '……こっち';
    c.lastSpeech = null;
    b.speak(c, text);
    return { ok: true };
  }
  // 口を残す
  const add = m => {
    if (c.mouths.length >= 8) c.mouths.shift();
    c.mouths.push({ id: `mouth_${++b.mouthSeq || (b.mouthSeq = 1)}`, ...m, placedAt: b.t });
  };
  // 見えていなくても、車両が体の上を走った相手なら付けられる
  const touched = step.target.type === 'enemy' ? b.enemiesOf(c).find(e => e.alive && (!step.target.charId || e.id === step.target.charId) && b.t - (c.carTouch[e.id] ?? -99) <= 5) : null;
  const who = res.self ? c : res.ally || (res.char && res.char.alive ? res.char : null) || touched;
  if (who) {
    if (who !== c && !(b.t - (c.carTouch[who.id] ?? -99) <= 5)) return fail(`車両が${who.name}の体の上を走っていない（先に stand_move で車両を走らせる）`);
    add({ on: who.id, x: who.x, y: who.y, floor: who.floor, name: who === c ? '自分の腕' : who.name });
    if (!c.standBody) b.standOut(c);
    b.emit({
      text: `『${ab.name}』— ${who === c ? '自分の腕' : `${who.name}の体`}に口を残した（${c.mouths.length}/8）`,
      obsText: who === c ? `${c.name} の腕に、唇のようなものが浮かんだ` : null,
      kind: 'ability', actor: c, pos: who, hint: ab.observedHint,
    });
    return { ok: true };
  }
  if (step.target.type === 'enemy') return fail(res.error || '敵の位置が分からない');
  if (res.error) return fail(res.error);
  const at = res.center && res.obj ? { x: res.x, y: res.y } : res;
  const floor = res.f ?? c.floor;
  const car = c.standBody;
  const near = (car && car.floor === floor && dist(car.x, car.y, at.x, at.y) <= 1.2)
    || c.carTrail.some(p => p.floor === floor && b.t - p.t <= 10 && dist(p.x, p.y, at.x, at.y) <= 1.0);
  if (!near) return fail('車両がその場所を通っていない（先に stand_move で走らせる）');
  const name = res.obj ? res.obj.name : `(${at.x.toFixed(1)}, ${at.y.toFixed(1)})`;
  add({ on: null, x: at.x, y: at.y, floor, name });
  b.emit({ text: `『${ab.name}』— ${name}に口を残した（${c.mouths.length}/8）`, kind: 'ability', actor: c, pos: { x: at.x, y: at.y, floor } });
  return { ok: true };
};

export function applyAbility(b, c, step, res) {
  const ab = ABILITIES[step.ability];
  // データで定義された能力（キャラクターのJSON）は、汎用の仕組みで効果を出す
  if (ab.generic) return applyGeneric(b, c, step.effect, res, ab, step);
  return IMPL[step.ability](b, c, step.effect, res, ab, step);
}
