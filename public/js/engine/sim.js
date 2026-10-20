// 戦闘シミュレーション本体：物理・知覚・ダメージ・ログ。勝敗はここで確定する
import { CHARACTERS, ABILITIES, RULES } from './data.js';
import { hasLOS, soundFactor, findPath, markNavDirty, buildingAt, objectById, nearestWalkable } from './world.js';
import { createWorld } from './maps.js';
import { dist, angleTo, angDiff, circleRectPush, segRect, segCircle, distToRect, clamp, makeRng, pointInRect } from './vec.js';
import { updateRunner, interruptStep, adoptPlan } from './plan.js';

let projSeq = 0;

function makeChar(id, charId, x, y, isCPU) {
  const def = CHARACTERS[charId];
  return {
    id, charId, def, isCPU,
    name: def.name, stand: def.stand, color: def.color,
    x, y, vx: 0, vy: 0, kbx: 0, kby: 0, kbSlam: null,
    facing: 0, r: RULES.charRadius,
    hp: def.hp, maxHp: def.hp, sp: def.sp, maxSp: def.sp,
    knives: def.knives,
    alive: true,
    status: { proneUntil: 0, proneImmuneUntil: 0, stunUntil: 0, guardUntil: 0, invulnUntil: 0, deafUntil: 0, recoverUntil: 0 },
    cd: {},
    desired: { vx: 0, vy: 0, face: null, running: false },
    runner: { plan: null, idx: 0, step: null },
    pendingPlan: null,
    windup: null,
    lastDamagedAt: -99,
    stepAccum: 0,
    speech: null,
    memory: { lastSeen: null, heard: [], observed: [], sawEnemyAt: -99 },
  };
}

export class Battle {
  constructor({ seed = Date.now(), playerChar = 'makabe', cpuChar = 'karasuma', mapId = 'town' } = {}) {
    this.seed = seed;
    this.rng = makeRng(seed ^ 0x9e3779b9);
    this.mapId = mapId;
    this.world = createWorld(seed, mapId);
    this.t = 0;
    this.log = [];
    this.fx = [];
    this.over = false;
    this.winner = null;
    const sp = this.world.spawns;
    this.player = makeChar('player', playerChar, sp.player.x, sp.player.y, false);
    this.cpu = makeChar('cpu', cpuChar, sp.cpu.x, sp.cpu.y, true);
    this.player.facing = angleTo(sp.player.x, sp.player.y, this.world.w / 2, this.world.h / 2);
    this.cpu.facing = angleTo(sp.cpu.x, sp.cpu.y, this.world.w / 2, this.world.h / 2);
    this.chars = [this.player, this.cpu];
    this.emit({ text: '―― 戦闘開始 ――', kind: 'system', all: true });
  }

  enemyOf(c) {
    return c === this.player ? this.cpu : this.player;
  }

  // ---------- 知覚 ----------

  canSee(viewer, x, y) {
    const d = dist(viewer.x, viewer.y, x, y);
    if (d > RULES.visionRange) return false;
    if (d > RULES.nearAwareness) {
      const a = angleTo(viewer.x, viewer.y, x, y);
      if (Math.abs(angDiff(viewer.facing, a)) > RULES.visionFov / 2) return false;
    }
    // 植え込みの中は、すぐそばか同じ植え込みの中からでないと見えない
    // 空中（真上に跳んだ状態）からは地上の遮蔽物を越えて見渡せ、空中の者も壁越しに見える
    if (this.isAirborne(viewer)) return true;
    if (this.chars.some(ch => ch !== viewer && this.isAirborne(ch) && ch.x === x && ch.y === y)) return true;
    if (!this.world.bushes) this.world.bushes = this.world.objects.filter(o => o.kind === 'bush');
    for (const o of this.world.bushes) {
      if (pointInRect(x, y, o) && d > 2.5 && !pointInRect(viewer.x, viewer.y, o)) return false;
    }
    return hasLOS(this.world, viewer.x, viewer.y, x, y);
  }

  isAirborne(c) {
    return !!(c.air && c.air.landAt > this.t);
  }

  // ---------- パーペンディキュラー：きっかり10m弾き出す運動 ----------

  // 人を弾き出す。kind: 'self'（自分の能力移動）/ 'target'（相手に弾かれた）/ 'aerial'（空中で障害物を越える）
  launchChar(c, dx, dy, { source, kind, distance = 10 }) {
    c.launch = { dx, dy, remaining: distance, total: distance, speed: 30, source, kind, sx: c.x, sy: c.y };
    c.kbx = c.kby = 0;
    c.kbSlam = null;
    c.vx = c.vy = 0;
  }

  launchObject(o, dx, dy, source, distance = 10) {
    o.launch = { dx, dy, remaining: distance, total: distance, speed: 30, source, sx: o.x, sy: o.y };
    o.vx = o.vy = 0;
    o.pushedBy = source ? source.id : null;
  }

  launchDone(x, y, traveled, viewerPos) {
    this.fx.push({ kind: 'measure', x, y: y - 0.7, text: traveled.toFixed(2), t: this.t, visibleTo: this.visibleSet(viewerPos || { x, y }) });
  }

  visibleSet(pos) {
    return new Set(this.chars.filter(c => this.canSee(c, pos.x, pos.y)).map(c => c.id));
  }

  // 衝突威力は重さに関係なく一定：人なら打撲（12ダメージ＋怯み）、物なら30の破壊力
  launchImpact(hit, source, label) {
    if (hit.char) {
      this.damage(hit.char, RULES.launchImpact, { source, kind: 'launch_impact', label });
      hit.char.status.stunUntil = Math.max(hit.char.status.stunUntil, this.t + 0.6);
      interruptStep(this, hit.char, '叩きつけられて体勢を崩した', true);
    } else if (hit.obj) {
      this.damageObject(hit.obj, 30, source);
    }
  }

  updateCharLaunch(c, dt) {
    const L = c.launch;
    const step = Math.min(L.speed * dt, L.remaining);
    const n = Math.max(1, Math.ceil(step / 0.1));
    let hit = null;
    for (let i = 0; i < n; i++) {
      const nx = c.x + (L.dx * step) / n, ny = c.y + (L.dy * step) / n;
      if (L.kind !== 'aerial') {
        for (const o of this.world.objects) {
          if (o.blocksMove && circleRectPush(nx, ny, c.r, o)) { hit = { obj: o }; break; }
        }
        if (!hit) {
          for (const other of this.chars) {
            if (other !== c && other.alive && !this.isAirborne(other) && dist(nx, ny, other.x, other.y) < c.r + other.r) { hit = { char: other }; break; }
          }
        }
      }
      if (hit) break;
      c.x = clamp(nx, c.r, this.world.w - c.r);
      c.y = clamp(ny, c.r, this.world.h - c.r);
      L.remaining -= step / n;
    }
    c.vx = c.vy = 0;
    const traveled = L.total - Math.max(0, L.remaining);
    if (hit || L.remaining <= 1e-6) {
      c.launch = null;
      if (L.kind === 'aerial') {
        const p = nearestWalkable(this.world, c.x, c.y, 3);
        if (p) { c.x = p.x; c.y = p.y; }
      }
      this.launchDone(c.x, c.y, traveled);
      if (hit) {
        const what = hit.obj ? hit.obj.name : hit.char.name;
        this.emit({ text: `${c.name} は${what}に叩きつけられた！（${traveled.toFixed(2)}m）`, kind: 'combat', affected: c, pos: c, sound: 10, soundKind: 'impact', actor: L.source });
        this.launchImpact({ char: c }, L.source, '叩きつけ');
        if (hit.char) this.launchImpact(hit, L.source, `飛んできた${c.name}`);
        else this.launchImpact(hit, L.source, '');
      }
    }
  }

  updateObjectLaunch(o, dt) {
    const L = o.launch;
    const step = Math.min(L.speed * dt, L.remaining);
    const n = Math.max(1, Math.ceil(step / 0.1));
    let hit = null;
    for (let i = 0; i < n; i++) {
      const moved = { ...o, x: o.x + (L.dx * step) / n, y: o.y + (L.dy * step) / n };
      for (const p of this.world.objects) {
        if (p === o || !p.blocksMove) continue;
        if (moved.x < p.x + p.w && moved.x + o.w > p.x && moved.y < p.y + p.h && moved.y + o.h > p.y) { hit = { obj: p }; break; }
      }
      if (!hit) {
        for (const ch of this.chars) {
          if (ch.alive && !this.isAirborne(ch) && ch !== L.source && circleRectPush(ch.x, ch.y, ch.r, moved)) { hit = { char: ch }; break; }
        }
      }
      if (hit) break;
      o.x = moved.x; o.y = moved.y;
      L.remaining -= step / n;
    }
    const traveled = L.total - Math.max(0, L.remaining);
    if (hit || L.remaining <= 1e-6) {
      o.launch = null;
      const cc = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      this.launchDone(cc.x, cc.y, traveled);
      markNavDirty(this.world);
      if (hit) {
        this.emit({ text: `弾き出された${o.name}が${hit.obj ? hit.obj.name : hit.char.name}に激突した！（${traveled.toFixed(2)}m）`, kind: 'combat', pos: cc, sound: 10, soundKind: 'impact', actor: L.source, affected: hit.char || null });
        this.launchImpact(hit, L.source, o.name);
        this.damageObject(o, 30, L.source);
      }
    }
  }

  bushAt(x, y) {
    if (!this.world.bushes) this.world.bushes = this.world.objects.filter(o => o.kind === 'bush');
    return this.world.bushes.find(o => pointInRect(x, y, o)) || null;
  }

  canSeeChar(viewer, target) {
    return target.alive !== undefined && this.canSee(viewer, target.x, target.y);
  }

  inSilence(x, y) {
    return this.world.zones.some(z => z.kind === 'silence' && dist(z.x, z.y, x, y) <= z.r);
  }

  canHear(listener, x, y, radius) {
    if (!listener.alive || radius <= 0) return false;
    if (listener.status.deafUntil > this.t) return false;
    if (this.inSilence(x, y) || this.inSilence(listener.x, listener.y)) return false;
    const eff = radius * soundFactor(this.world, x, y, listener.x, listener.y);
    return dist(listener.x, listener.y, x, y) <= eff;
  }

  // ログ・音・観察を一括で発行する。visibleTo は「その出来事を知覚できた者」
  emit({ text, obsText = null, kind = 'info', actor = null, pos = null, sound = 0, soundKind = null, all = false, hint = null, affected = null }) {
    const visibleTo = new Set();
    const heardBy = new Set();
    for (const c of this.chars) {
      if (all || c === actor || c === affected) { visibleTo.add(c.id); continue; }
      const seen = pos && this.canSee(c, pos.x, pos.y);
      const heard = pos && sound && this.canHear(c, pos.x, pos.y, sound);
      if (seen || heard) visibleTo.add(c.id);
      if (heard && !seen) heardBy.add(c.id);
      if (heard && seen && soundKind === 'alarm') this.recordSound(c, pos, soundKind, obsText || text);
    }
    const entry = { t: this.t, text, obsText, kind, actor: actor ? actor.id : null, visibleTo, heardBy };
    this.log.push(entry);
    if (kind === 'ability' && pos) this.fx.push({ kind: 'flash', x: pos.x, y: pos.y, t: this.t, color: actor ? actor.color : '#fff', visibleTo });
    if (this.log.length > 400) this.log.shift();

    for (const c of this.chars) {
      if (c === actor) continue;
      if (heardBy.has(c.id) && pos) this.recordSound(c, pos, soundKind || kind, obsText || text);
      if (hint && visibleTo.has(c.id) && !c.memory.observed.includes(hint)) c.memory.observed.push(hint);
    }
    return entry;
  }

  recordSound(listener, pos, kind, text) {
    const err = 1.5 + dist(listener.x, listener.y, pos.x, pos.y) * 0.12;
    const approx = {
      x: clamp(pos.x + (this.rng() - 0.5) * 2 * err, 0.5, this.world.w - 0.5),
      y: clamp(pos.y + (this.rng() - 0.5) * 2 * err, 0.5, this.world.h - 0.5),
    };
    const heard = listener.memory.heard;
    heard.push({ t: this.t, kind, text, x: approx.x, y: approx.y });
    while (heard.length > 14) heard.shift();
  }

  // 音だけ（ログには残さない足音など）
  noise(src, radius, kind) {
    for (const c of this.chars) {
      if (c === src) continue;
      if (this.canHear(c, src.x, src.y, radius)) this.recordSound(c, src, kind, null);
    }
  }

  speak(c, text) {
    if (!text) return;
    // 同じセリフの連呼は省く
    if (c.lastSpeech && c.lastSpeech.text === text && this.t - c.lastSpeech.t < 10) return;
    c.lastSpeech = { text, t: this.t };
    const muted = c.status.deafUntil > this.t; // 聴覚封じ中は声も届かない
    c.speech = { text, until: this.t + 3.5 };
    const listener = this.enemyOf(c);
    const heard = !muted && this.canHear(listener, c.x, c.y, RULES.speechRadius);
    const entry = { t: this.t, text: `${c.name}「${text}」`, kind: 'speech', actor: c.id, visibleTo: new Set([c.id]), heardBy: new Set() };
    if (heard) {
      entry.visibleTo.add(listener.id);
      entry.heardBy.add(listener.id);
      this.recordSound(listener, c, 'speech', text);
    }
    c.speech.heardByEnemy = heard;
    this.log.push(entry);
  }

  updatePerception(c) {
    const e = this.enemyOf(c);
    if (e.alive && this.canSee(c, e.x, e.y)) {
      if (this.t - c.memory.sawEnemyAt > 1.5) c.memory.newlySpotted = true;
      c.memory.lastSeen = { x: e.x, y: e.y, t: this.t, facing: e.facing };
      c.memory.sawEnemyAt = this.t;
    }
  }

  perceivedEnemy(c) {
    const e = this.enemyOf(c);
    if (e.alive && this.canSee(c, e.x, e.y)) return { x: e.x, y: e.y, visible: true, char: e };
    if (c.memory.lastSeen) return { ...c.memory.lastSeen, visible: false, char: null };
    return null;
  }

  // ---------- ダメージ ----------

  damage(target, amount, { source = null, kind = 'hit', from = null, label = '' } = {}) {
    if (!target.alive || this.over) return 0;
    if (this.isAirborne(target) && kind !== 'fall' && kind !== 'launch_impact') {
      this.emit({ text: `${target.name} は空中にいて${label || '攻撃'}が届かない`, actor: source, affected: target, pos: target, kind: 'combat' });
      return 0;
    }
    if (target.launch && target.launch.kind !== 'target' && kind !== 'launch_impact') {
      this.emit({ text: `${target.name} は高速で移動していて${label || '攻撃'}が当たらない`, actor: source, affected: target, pos: target, kind: 'combat' });
      return 0;
    }
    if (target.status.invulnUntil > this.t && kind !== 'debris') {
      this.emit({ text: `${target.name} は${label || '攻撃'}を紙一重でかわした！`, actor: source, affected: target, pos: target, kind: 'combat' });
      return 0;
    }
    let dmg = amount * target.def.defense;
    let guarded = false;
    if (from && target.status.guardUntil > this.t && (kind === 'melee' || kind === 'knife')) {
      const a = angleTo(target.x, target.y, from.x, from.y);
      if (Math.abs(angDiff(target.facing, a)) <= (70 * Math.PI) / 180) { dmg *= 0.3; guarded = true; }
    }
    if (target.status.proneUntil > this.t) dmg *= 1.3;
    dmg = Math.max(1, Math.round(dmg));
    target.hp = Math.max(0, target.hp - dmg);
    target.lastDamagedAt = this.t;
    const entry = this.emit({
      text: `${target.name} に${label ? `${label}で` : ''}${dmg}ダメージ${guarded ? '（ガード）' : ''}`,
      kind: 'damage', actor: source, affected: target, pos: target, sound: 9, soundKind: 'impact',
    });
    this.fx.push({ kind: 'num', x: target.x, y: target.y - 0.6, text: `-${dmg}`, t: this.t, color: guarded ? '#aaa' : '#ff5d73', visibleTo: entry.visibleTo });
    // 怯み：構えや詠唱を中断させる
    // 同じ瞬間に放たれる攻撃は相打ちにする（処理順で有利不利が出ないように）
    const releasing = target.windup && target.windup.until <= this.t + RULES.dt + 1e-6;
    if (dmg >= 6 && !guarded && !releasing) {
      target.status.stunUntil = Math.max(target.status.stunUntil, this.t + 0.25);
      interruptStep(this, target, '攻撃を受けて行動が中断された');
    }
    if (target.hp <= 0) {
      target.alive = false;
      target.vx = target.vy = 0;
      this.emit({ text: `${target.name} は再起不能（リタイヤ）！`, kind: 'ko', all: true });
    }
    return dmg;
  }

  // ---------- 環境 ----------

  damageObject(o, amount, source) {
    if (!this.world.objects.includes(o)) return;
    if (o.kind === 'car' && !(o.alarmUntil > this.t)) {
      // 車に衝撃が加わると防犯アラームが鳴る（広い範囲に聞こえる）
      o.alarmUntil = this.t + 6;
      this.emit({ text: `${o.name}の防犯アラームがけたたましく鳴り響く！`, kind: 'env', pos: { x: o.x + o.w / 2, y: o.y + o.h / 2 }, sound: 40, soundKind: 'alarm', actor: source });
    }
    if (o.indestructible) return;
    o.hp -= amount;
    if (o.hp > 0) return;
    this.destroyObject(o, source);
  }

  destroyObject(o, source, cause = '破壊') {
    const w = this.world;
    w.objects = w.objects.filter(x => x !== o);
    const center = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    if (o.kind === 'wall') {
      w.rubble.push({ x: o.x - 0.3, y: o.y - 0.3, w: o.w + 0.6, h: o.h + 0.6 });
      this.emit({ text: `${o.name} が崩れ落ちた！`, kind: 'env', pos: center, sound: 14, soundKind: 'crash', actor: source });
      for (const c of this.chars) {
        if (c !== source && c.alive && distToRect(c.x, c.y, o) <= 1.2) this.damage(c, 10, { source, kind: 'debris', label: '崩落した瓦礫' });
      }
    } else if (o.kind === 'window') {
      this.emit({ text: `${o.name} のガラスが割れた！`, kind: 'env', pos: center, sound: 12, soundKind: 'glass', actor: source });
      // 割れた窓は通り抜けられる開口部になる（建物の記録は残す）
    } else {
      w.rubble.push({ x: o.x, y: o.y, w: o.w, h: o.h });
      this.emit({ text: `${o.name} が壊れた。`, kind: 'env', pos: center, sound: 10, soundKind: 'crash', actor: source });
    }
    markNavDirty(w);
  }

  spawnKnife(owner, x, y, tx, ty, { speed = RULES.knifeSpeed, damage = RULES.knifeDamage, maxRange = RULES.knifeRange } = {}) {
    const a = angleTo(x, y, tx, ty);
    const p = {
      id: `knife_${++projSeq}`, kind: 'knife', owner: owner.id,
      x: x + Math.cos(a) * 0.55, y: y + Math.sin(a) * 0.55,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      traveled: 0, damage, maxRange, born: this.t,
    };
    this.world.projectiles.push(p);
    return p;
  }

  // ---------- 1ステップ進める ----------

  step(dt = RULES.dt) {
    if (this.over) return;
    this.t += dt;
    const w = this.world;
    w.zones = w.zones.filter(z => z.until > this.t);
    for (const o of w.objects) if (o.slickUntil && o.slickUntil < this.t) o.slickUntil = 0;

    for (const c of this.chars) {
      if (!c.alive) continue;
      if (c.speech && c.speech.until < this.t) c.speech = null;
      this.updatePerception(c);
      updateRunner(this, c);
    }
    for (const c of this.chars) if (c.alive) this.moveChar(c, dt);
    this.separateChars();
    this.updateObjects(dt);
    this.updateProjectiles(dt);
    this.updatePickups();
    this.fx = this.fx.filter(f => this.t - f.t < 1.2);

    const alive = this.chars.filter(c => c.alive);
    if (alive.length < 2) {
      this.over = true;
      this.winner = alive[0] || null;
      this.emit({ text: this.winner ? `勝者：${this.winner.name}『${this.winner.stand}』` : '相打ち', kind: 'system', all: true });
    }
  }

  zoneAt(kind, x, y) {
    return this.world.zones.find(z => z.kind === kind && dist(z.x, z.y, x, y) <= z.r) || null;
  }

  moveChar(c, dt) {
    const s = c.status;
    for (const k in c.cd) if (c.cd[k] <= this.t) delete c.cd[k];
    c.sp = Math.min(c.maxSp, c.sp + c.def.spRegen * dt);

    if (c.launch) {
      this.updateCharLaunch(c, dt);
      return;
    }
    if (c.air) {
      if (c.air.landAt > this.t) { c.vx = c.vy = 0; return; }
      // 落下して着地
      c.air = null;
      const p = nearestWalkable(this.world, c.x, c.y, 3);
      if (p) { c.x = p.x; c.y = p.y; }
      this.emit({ text: `${c.name} が落下して着地した`, kind: 'combat', actor: c, pos: c, sound: 8, soundKind: 'fall' });
      this.damage(c, 5, { source: null, kind: 'fall', label: '着地の衝撃' });
      s.stunUntil = Math.max(s.stunUntil, this.t + 0.3);
    }

    const kbSpeed = Math.hypot(c.kbx, c.kby);
    const incapacitated = s.proneUntil > this.t || s.stunUntil > this.t || s.recoverUntil > this.t;
    const slick = this.zoneAt('slick', c.x, c.y);
    const grip = this.zoneAt('grip', c.x, c.y);
    const onRubble = w => w.rubble.some(r => pointInRect(c.x, c.y, r));

    if (kbSpeed > 0.2) {
      c.vx = c.kbx; c.vy = c.kby;
      const decay = Math.max(0, kbSpeed - 14 * dt) / kbSpeed;
      c.kbx *= decay; c.kby *= decay;
    } else {
      c.kbx = c.kby = 0;
      c.kbSlam = null;
      let tvx = incapacitated ? 0 : c.desired.vx;
      let tvy = incapacitated ? 0 : c.desired.vy;
      let maxSp = Math.hypot(tvx, tvy);
      if (maxSp > 0.01) {
        // 旋回：向きと進行方向がずれているほど遅くなる
        const diff = Math.abs(angDiff(c.facing, Math.atan2(tvy, tvx)));
        let factor = 0.6 + 0.4 * Math.max(0, Math.cos(diff));
        if (grip) factor *= 0.35;
        if (onRubble(this.world)) factor *= 0.6;
        if (this.bushAt(c.x, c.y)) factor *= 0.6;
        tvx *= factor; tvy *= factor;
        maxSp *= factor;
      }
      let accel = slick ? 3 : 20;
      if (s.proneUntil > this.t) accel = slick ? 1 : 12;
      const dvx = tvx - c.vx, dvy = tvy - c.vy;
      const dv = Math.hypot(dvx, dvy);
      const maxDv = accel * dt;
      if (dv > maxDv) { c.vx += (dvx / dv) * maxDv; c.vy += (dvy / dv) * maxDv; } else { c.vx = tvx; c.vy = tvy; }
    }

    // 向き
    const speed = Math.hypot(c.vx, c.vy);
    let faceTarget = c.desired.face;
    if (faceTarget == null && speed > 0.5 && kbSpeed <= 0.2 && !incapacitated) faceTarget = Math.atan2(c.vy, c.vx);
    if (faceTarget != null && !(s.proneUntil > this.t)) {
      const d = angDiff(c.facing, faceTarget);
      const maxTurn = 10 * dt;
      c.facing += clamp(d, -maxTurn, maxTurn);
    }

    // 摩擦低下領域：走って踏み込むと転倒
    if (slick && speed > 2.6 && s.proneUntil <= this.t && s.proneImmuneUntil <= this.t && s.invulnUntil <= this.t) {
      s.proneUntil = this.t + 1.2;
      s.proneImmuneUntil = this.t + 2.7;
      const owner = this.chars.find(x => x.id === slick.owner);
      interruptStep(this, c, '足を取られて転倒した', true);
      this.emit({
        text: `${c.name} は足を滑らせて転倒した！`, kind: 'combat', affected: c, pos: c, sound: 7, soundKind: 'fall',
        actor: owner, hint: ABILITIES.friction.observedHint,
      });
      this.damage(c, 3, { source: owner, kind: 'fall', label: '転倒' });
    }

    // 移動と衝突
    const ox = c.x, oy = c.y;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    let slammed = false;
    for (let iter = 0; iter < 3; iter++) {
      for (const o of this.world.objects) {
        if (!o.blocksMove) continue;
        const p = circleRectPush(c.x, c.y, c.r, o);
        if (!p) continue;
        c.x += p.x; c.y += p.y;
        const vn = c.vx * p.nx + c.vy * p.ny;
        if (vn < 0) { c.vx -= vn * p.nx; c.vy -= vn * p.ny; }
        if (kbSpeed > 3 && c.kbSlam && !slammed) {
          slammed = true;
          const slam = c.kbSlam;
          c.kbx = c.kby = 0;
          c.kbSlam = null;
          this.emit({ text: `${c.name} は${o.name}に叩きつけられた！`, kind: 'combat', affected: c, pos: c, sound: 10, soundKind: 'impact' });
          this.damage(c, slam.damage, { source: slam.source, kind: 'slam', label: '激突' });
          c.status.stunUntil = Math.max(c.status.stunUntil, this.t + 0.6);
          if (o.kind !== 'wall' || !o.indestructible) this.damageObject(o, 6, slam.source);
        }
      }
    }
    c.x = clamp(c.x, c.r, this.world.w - c.r);
    c.y = clamp(c.y, c.r, this.world.h - c.r);

    // 足音
    const moved = dist(ox, oy, c.x, c.y);
    c.stepAccum += moved;
    const running = speed > c.def.walk + 0.3;
    if (c.stepAccum > (running ? 1.5 : 1.2)) {
      c.stepAccum = 0;
      if (speed > 0.8) this.noise(c, running ? 9 : 3, running ? 'footsteps_run' : 'footsteps');
      if (speed > 0.8 && this.bushAt(c.x, c.y)) this.noise(c, 6, 'rustle');
    }
  }

  separateChars() {
    const [a, b] = this.chars;
    if (!a.alive || !b.alive) return;
    const d = dist(a.x, a.y, b.x, b.y);
    const min = a.r + b.r;
    if (d < min && d > 1e-6) {
      const push = (min - d) / 2;
      const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
    }
  }

  updateObjects(dt) {
    for (const o of this.world.objects.slice()) {
      if (o.launch) { this.updateObjectLaunch(o, dt); continue; }
      if (!o.movable) continue;
      const sp = Math.hypot(o.vx, o.vy);
      if (sp < 0.05) { o.vx = o.vy = 0; continue; }
      const fric = (o.slickUntil > this.t ? 0.6 : 9) / (o.mass || 1);
      const ns = Math.max(0, sp - fric * dt);
      o.vx *= ns / sp; o.vy *= ns / sp;
      const nx = o.x + o.vx * dt, ny = o.y + o.vy * dt;
      const moved = { ...o, x: nx, y: ny };
      let blocked = null;
      for (const p of this.world.objects) {
        if (p === o || !p.blocksMove) continue;
        if (nx < p.x + p.w && nx + o.w > p.x && ny < p.y + p.h && ny + o.h > p.y) { blocked = p; break; }
      }
      if (blocked) {
        if (sp > 4) {
          this.emit({ text: `${o.name} が${blocked.name}に激突した！`, kind: 'env', pos: { x: o.x + o.w / 2, y: o.y + o.h / 2 }, sound: 10, soundKind: 'crash' });
          this.damageObject(o, Math.round(sp * 1.5), null);
          this.damageObject(blocked, Math.round(sp), null);
        }
        o.vx = o.vy = 0;
        markNavDirty(this.world);
        continue;
      }
      for (const c of this.chars) {
        if (!c.alive) continue;
        if (circleRectPush(c.x, c.y, c.r, moved)) {
          if (sp > 2.5) {
            const owner = this.chars.find(x => x.id === o.pushedBy) || null;
            this.emit({ text: `${o.name} が ${c.name} に激突した！`, kind: 'combat', pos: c, affected: c, sound: 10, soundKind: 'impact' });
            this.damage(c, Math.round(sp * 1.6), { source: owner, kind: 'crate', label: o.name });
            c.kbx = (o.vx / sp) * 4; c.kby = (o.vy / sp) * 4;
          }
          o.vx *= 0.25; o.vy *= 0.25;
          blocked = c;
          break;
        }
      }
      if (blocked) continue;
      o.x = nx; o.y = ny;
      if (Math.hypot(o.vx, o.vy) < 0.05) { o.vx = o.vy = 0; markNavDirty(this.world); }
    }
  }

  updateProjectiles(dt) {
    const w = this.world;
    const keep = [];
    for (const p of w.projectiles) {
      const x1 = p.x + p.vx * dt, y1 = p.y + p.vy * dt;
      let hit = null, best = 2;
      for (const o of w.objects) {
        if (!o.blocksMove) continue;
        const t = segRect(p.x, p.y, x1, y1, o);
        if (t !== null && t < best) { best = t; hit = { type: 'obj', o }; }
      }
      for (const c of this.chars) {
        if (!c.alive) continue;
        if (c.id === p.owner && this.t - p.born < 0.3) continue;
        if (this.isAirborne(c) || (c.launch && c.launch.kind !== 'target')) continue;
        const t = segCircle(p.x, p.y, x1, y1, c.x, c.y, c.r);
        if (t !== null && t < best) { best = t; hit = { type: 'char', c }; }
      }
      if (hit) {
        const hx = p.x + (x1 - p.x) * best, hy = p.y + (y1 - p.y) * best;
        const owner = this.chars.find(c => c.id === p.owner);
        if (hit.type === 'char') {
          if (hit.c.status.invulnUntil > this.t) { p.x = x1; p.y = y1; keep.push(p); continue; }
          this.damage(hit.c, p.damage, { source: owner, kind: 'knife', from: { x: hx - p.vx, y: hy - p.vy }, label: 'ナイフ' });
          const sp = Math.hypot(p.vx, p.vy);
          w.pickups.push({ kind: 'knife', x: hit.c.x + (p.vx / sp) * 1.2, y: hit.c.y + (p.vy / sp) * 1.2, readyAt: this.t + 1.5 });
        } else {
          const sp = Math.hypot(p.vx, p.vy);
          this.emit({ text: `ナイフが${hit.o.name}に突き刺さった。`, kind: 'env', pos: { x: hx, y: hy }, sound: 6, soundKind: 'impact', actor: owner });
          this.damageObject(hit.o, hit.o.kind === 'window' ? 10 : 3, owner);
          w.pickups.push({ kind: 'knife', x: hx - (p.vx / sp) * 0.5, y: hy - (p.vy / sp) * 0.5 });
        }
        continue;
      }
      p.traveled += Math.hypot(x1 - p.x, y1 - p.y);
      p.x = x1; p.y = y1;
      if (p.traveled > (p.maxRange ?? RULES.knifeRange)) {
        w.pickups.push({ kind: 'knife', x: p.x, y: p.y });
        continue;
      }
      keep.push(p);
    }
    w.projectiles = keep;
  }

  updatePickups() {
    const w = this.world;
    w.pickups = w.pickups.filter(pk => {
      if (pk.readyAt && pk.readyAt > this.t) return true;
      for (const c of this.chars) {
        if (c.alive && dist(c.x, c.y, pk.x, pk.y) < 0.7) {
          c.knives++;
          this.emit({ text: `${c.name} はナイフを拾った（所持${c.knives}本）`, kind: 'info', actor: c, pos: c });
          return false;
        }
      }
      return true;
    });
  }

  // ---------- 外部（プレイヤー入力・CPU）から計画を受け取る ----------

  setPlan(c, plan) {
    adoptPlan(this, c, plan);
  }

  objectById(id) {
    return objectById(this.world, id);
  }

  buildingOf(c) {
    return buildingAt(this.world, c.x, c.y);
  }

  path(c, x, y) {
    return findPath(this.world, c.x, c.y, x, y);
  }
}
