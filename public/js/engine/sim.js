// 戦闘シミュレーション本体：物理・知覚・ダメージ・ログ。勝敗はここで確定する
import { CHARACTERS, ABILITIES, RULES } from './data.js';
import { hasLOS, soundFactor, findPath, markNavDirty, buildingAt, objectById, nearestWalkable, upperFloorAt, crossesSlab, isWalkablePoint, FLOOR_H, EYE_H, BODY_H } from './world.js';
import { createWorld } from './maps.js';
import { itemDef } from './items.js';
import { blurt } from './persona.js';
import { dist, angleTo, angDiff, circleRectPush, segRectRange, segCircle, distToRect, clamp, makeRng, pointInRect } from './vec.js';
import { updateRunner, interruptStep, adoptPlan } from './plan.js';

let projSeq = 0;

function makeChar(id, charId, x, y, isCPU, team) {
  const def = CHARACTERS[charId];
  return {
    id, charId, def, isCPU, team,
    focusId: null, // 狙っている敵（指定が無ければ見えている一番近い敵）
    name: def.name, stand: def.stand, color: def.color,
    x, y, floor: 0, vx: 0, vy: 0, kbx: 0, kby: 0, kbSlam: null,
    facing: 0, r: RULES.charRadius,
    hp: def.hp, maxHp: def.hp, sp: def.sp, maxSp: def.sp,
    held: null, // 手に持っている物（1つまで）
    standBody: null, // 体の外に出したスタンド { x, y, floor, facing, goal }
    alive: true,
    status: { proneUntil: 0, stunUntil: 0, guardUntil: 0, invulnUntil: 0, recoverUntil: 0, deafUntil: 0, hideUntil: 0, counterUntil: 0, umbrellaUntil: 0, grabbedUntil: 0 },
    balls: def.balls || 0,
    // リトル・レッド・コルベット：残した口（最大8）、車両の通った跡、車両が体の上を走った人
    mouths: def.abilities.includes('corvette') ? [] : null,
    carTrail: [], carTouch: {}, clench: null,
    // エコー・ビーチの24体（背中の◆の数が1〜24、長い腕が左右半々）
    units: def.abilities.includes('echo')
      ? Array.from({ length: 24 }, (_, i) => ({
        n: i + 1, side: i % 2 ? 'R' : 'L', state: 'home', x, y, floor: 0, attachedTo: null, target: null,
        // 戦闘前に拾っておいた自分の足音（囮用）を3体が抱えている
        sound: i < 3 ? { kind: 'footsteps_run', radius: 9, text: null, from: def.name, label: `${def.name}の駆ける足音`, weak: true } : null,
      }))
      : null,
    cd: {},
    desired: { vx: 0, vy: 0, face: null, running: false },
    runner: { plan: null, idx: 0, step: null },
    pendingPlan: null,
    windup: null,
    lastDamagedAt: -99,
    stepAccum: 0,
    speech: null,
    memory: { lastSeen: null, seen: {}, heard: [], observed: [], sawEnemyAt: -99 },
  };
}

export class Battle {
  // 1対1：playerChar 対 cpuChar。2対2：allyChar（味方CPU）と cpu2Char を加える
  // randomSpawn：開始位置を毎回ランダムにする（false なら地図ごとの決まった位置）
  // spectate：観戦モード。プレイヤーのキャラも CPU が操作する
  constructor({ seed = Date.now(), playerChar = 'sogo', cpuChar = 'kito', allyChar = null, cpu2Char = null, mapId = 'town', randomSpawn = true, spectate = false, shrinkZone = true } = {}) {
    this.seed = seed;
    this.rng = makeRng(seed ^ 0x9e3779b9);
    this.mapId = mapId;
    this.world = createWorld(seed, mapId);
    this.t = 0;
    this.log = [];
    this.fx = [];
    this.fxSeq = 0;
    this.over = false;
    this.winner = null;
    this.winnerTeam = null;
    const sp = randomSpawn ? this.randomSpawns() || this.world.spawns : this.world.spawns;
    this.player = makeChar('player', playerChar, sp.player.x, sp.player.y, spectate, 0);
    this.spectate = spectate;
    this.cpu = makeChar('cpu', cpuChar, sp.cpu.x, sp.cpu.y, true, 1);
    this.chars = [this.player, this.cpu];
    if (allyChar) this.chars.push(this.ally = makeChar('ally', allyChar, ...this.spawnNear(sp.player), true, 0));
    if (cpu2Char) this.chars.push(this.cpu2 = makeChar('cpu2', cpu2Char, ...this.spawnNear(sp.cpu), true, 1));
    for (const c of this.chars) {
      c.facing = angleTo(c.x, c.y, this.world.w / 2, this.world.h / 2);
      if (c.units) for (const u of c.units) { u.x = c.x; u.y = c.y; }
    }
    this.teamSize = Math.max(...[0, 1].map(t => this.chars.filter(c => c.team === t).length));
    this.safeZone = null;
    if (shrinkZone) this.initSafeZone();
    this.emit({ text: `―― 戦闘開始${this.teamSize > 1 ? '（2対2）' : ''} ――`, kind: 'system', all: true });
  }

  // ランダムな開始位置：屋外の歩ける場所から、互いに十分離れていて歩いて行き来できる2点を選ぶ
  randomSpawns() {
    const w = this.world;
    const pts = [];
    for (let i = 0; i < 600 && pts.length < 80; i++) {
      const x = 1.5 + this.rng() * (w.w - 3), y = 1.5 + this.rng() * (w.h - 3);
      if (!isWalkablePoint(w, x, y, 0) || buildingAt(w, x, y)) continue;
      if (w.objects.some(o => o.kind === 'bush' && pointInRect(x, y, o, 0.5))) continue;
      pts.push({ x, y });
    }
    const far = Math.max(w.w, w.h) * 0.55;
    for (let tries = 0; tries < 40 && pts.length > 1; tries++) {
      const a = pts[Math.floor(this.rng() * pts.length)];
      const cands = pts.filter(p => dist(a.x, a.y, p.x, p.y) >= far);
      if (!cands.length) continue;
      const c = cands[Math.floor(this.rng() * cands.length)];
      if (!findPath(w, a.x, a.y, c.x, c.y, 0, 0)) continue;
      return this.rng() < 0.5 ? { player: a, cpu: c } : { player: c, cpu: a };
    }
    return null;
  }

  // 出現地点の少し横（歩ける場所）
  spawnNear(p) {
    for (const [dx, dy] of [[0, 2.5], [0, -2.5], [2.5, 0], [-2.5, 0], [2, 2], [-2, -2]]) {
      const q = nearestWalkable(this.world, p.x + dx, p.y + dy, 1.2, 0);
      if (q && dist(q.x, q.y, p.x, p.y) > 1.2) return [q.x, q.y];
    }
    return [p.x + 1, p.y];
  }

  enemiesOf(c) {
    return this.chars.filter(x => x.team !== c.team);
  }

  alliesOf(c) {
    return this.chars.filter(x => x !== c && x.team === c.team);
  }

  // 今の相手：狙いを指定していればその敵、無ければ見えている一番近い敵、次に直近に位置を知った敵
  enemyOf(c) {
    const key = `${this.t}|${c.focusId}`;
    if (c._enemyKey === key && c._enemy) return c._enemy;
    const all = this.enemiesOf(c);
    const alive = all.filter(e => e.alive);
    let e = null;
    if (!alive.length) e = all[0];
    else if (alive.length === 1) e = alive[0];
    else {
      e = alive.find(x => x.id === c.focusId) || null;
      if (!e) {
        const vis = alive.filter(x => this.canSee(c, x.x, x.y));
        if (vis.length) e = vis.reduce((a, x) => (dist(c.x, c.y, x.x, x.y) < dist(c.x, c.y, a.x, a.y) ? x : a));
      }
      if (!e) {
        const known = alive.filter(x => c.memory.seen[x.id]);
        if (known.length) e = known.reduce((a, x) => (c.memory.seen[x.id].t > c.memory.seen[a.id].t ? x : a));
      }
      if (!e) e = alive.reduce((a, x) => (dist(c.x, c.y, x.x, x.y) < dist(c.x, c.y, a.x, a.y) ? x : a));
    }
    c._enemyKey = key;
    c._enemy = e;
    return e;
  }

  // 敵の名前（姓・名・スタンド名）からその敵を探す
  enemyByName(c, text) {
    return this.enemiesOf(c).find(e => {
      const [sei, mei] = e.name.split(/\s+/);
      return [sei, mei, e.stand, e.def.nickname, e.def.stand.split('・')[0]].some(w => w && text.includes(w));
    }) || null;
  }

  // ---------- 知覚 ----------

  // 高さ：足元の高さ（階＋跳躍）。空中は放物線（10m上昇→落下）、飛び降りは落下のみ
  airHeight(c) {
    const a = c.air;
    if (!a) return 0;
    const t = this.t - a.since;
    if (a.profile === 'drop') return Math.max(0, a.from - 4.9 * t * t);
    const top = a.top ?? 10;
    const rise = a.rise ?? 0.35;
    if (t < rise) return (top * t) / rise;
    return Math.max(0, top - 4.9 * (t - rise) * (t - rise));
  }

  baseZ(c) {
    return c.floor * FLOOR_H + this.airHeight(c);
  }

  // pos の高さ：人物ならその体の高さ、物体・地点なら階の床から少し上
  zOf(pos, viewer = null) {
    if (pos.z !== undefined) return pos.z;
    const ch = this.chars.find(c => c === pos || (c.x === pos.x && c.y === pos.y));
    if (ch) return this.baseZ(ch) + BODY_H;
    const f = pos.floor ?? (viewer ? viewer.floor : 0);
    return f * FLOOR_H + 0.5;
  }

  // 本体の目に加えて、先行させたスタンドの位置からも見える
  canSee(viewer, x, y, tz) {
    if (this.canSeeFrom(viewer, viewer.x, viewer.y, this.baseZ(viewer) + EYE_H, viewer.facing, x, y, tz, true)) return true;
    const s = viewer.standBody;
    // 車両の周りの様子は本体には見えない（リトル・レッド・コルベット）
    if (s && !viewer.def.standBlind && s.floor === viewer.floor && dist(s.x, s.y, viewer.x, viewer.y) > 0.5) {
      return this.canSeeFrom(viewer, s.x, s.y, s.floor * FLOOR_H + EYE_H, s.facing, x, y, tz, false);
    }
    return false;
  }

  canSeeFrom(viewer, ox, oy, vz, facing, x, y, tz, aware) {
    const d = dist(ox, oy, x, y);
    if (d > RULES.visionRange) return false;
    // 潜んでいる人物は6m（植え込みの中なら2.5m）より遠くからは見つからない
    const hidden = this.chars.find(h => h !== viewer && h.x === x && h.y === y && h.status.hideUntil > this.t);
    if (hidden && d > (hidden.status.deepHide ? 1.5 : this.bushAt(hidden.x, hidden.y) ? 2.5 : 6)) return false;
    // 煙幕：煙の中や向こう側は見えない（すぐそば1.5m以内は見える）
    if (d > 1.5 && this.world.zones.length && this.smokeBetween(ox, oy, x, y)) return false;
    if (!aware || d > RULES.nearAwareness) {
      const a = angleTo(ox, oy, x, y);
      if (Math.abs(angDiff(facing, a)) > RULES.visionFov / 2) return false;
    }
    const z = tz ?? this.zOf({ x, y }, viewer);
    // 植え込みの中（地面の高さ）は、すぐそばか同じ植え込みの中からでないと見えない
    if (!this.world.bushes) this.world.bushes = this.world.objects.filter(o => o.kind === 'bush');
    if (z < 1.5) {
      for (const o of this.world.bushes) {
        if (pointInRect(x, y, o) && d > 2.5 && !pointInRect(ox, oy, o)) return false;
      }
    }
    // 高さを含めた視線：塀や車越しでも高い所からは見える。床・天井は階をまたぐ視線を遮る
    return hasLOS(this.world, ox, oy, x, y, null, vz, z);
  }

  // 近接攻撃や弾の出どころ：スタンドを先行させていればその位置
  standOrigin(c) {
    const s = c.standBody;
    return s && s.floor === c.floor && !c.def.standBlind ? s : c;
  }

  // スタンドを出す（既に出ていればそのまま）
  standOut(c) {
    if (!c.standBody) {
      c.standBody = { x: c.x + Math.cos(c.facing) * 0.5, y: c.y + Math.sin(c.facing) * 0.5, floor: c.floor, facing: c.facing, goal: {} };
      this.emit({ text: `${c.name} が『${c.stand}』を出した`, obsText: `${c.name} のそばにスタンドの姿が浮かび上がった`, kind: 'stand', actor: c, pos: c });
    }
    return c.standBody;
  }

  // 先行したスタンド：目標へ向かうが、本体から射程より遠くへは行けない。壁はすり抜ける（階はまたげない）
  updateStand(c, dt) {
    const s = c.standBody;
    if (!s) return;
    if (!c.alive) { c.standBody = null; return; }
    const R = c.def.standRange || 1;
    if (s.floor !== c.floor || c.launch || this.isAirborne(c) || c.climb) {
      s.x = c.x; s.y = c.y; s.floor = c.floor; s.facing = c.facing;
      return;
    }
    const g = s.goal || {};
    if (g.char && g.char.alive && this.canSee(c, g.char.x, g.char.y)) { g.x = g.char.x; g.y = g.char.y; }
    else if (g.char && g.char.alive && c.def.standBlind) {
      // 見えていなくても、最後に分かっている位置へ走らせる
      const rec = c.memory.seen[g.char.id];
      if (rec) { g.x = rec.x; g.y = rec.y; }
    }
    let gx, gy;
    if (g.x !== undefined) { gx = g.x; gy = g.y; } else { gx = c.x + Math.cos(c.facing) * 0.6; gy = c.y + Math.sin(c.facing) * 0.6; }
    const dx = gx - c.x, dy = gy - c.y, d = Math.hypot(dx, dy);
    if (d > R) { gx = c.x + (dx / d) * R; gy = c.y + (dy / d) * R; }
    const m = dist(s.x, s.y, gx, gy), step = (c.def.standSpeed ?? RULES.standSpeed) * dt;
    if (m > step) { s.x += ((gx - s.x) / m) * step; s.y += ((gy - s.y) / m) * step; } else { s.x = gx; s.y = gy; }
    // 本体から離れて引きずられる時も射程は守る
    const bd = dist(c.x, c.y, s.x, s.y);
    if (bd > R + 0.05) { s.x = c.x + ((s.x - c.x) / bd) * R; s.y = c.y + ((s.y - c.y) / bd) * R; }
    if (c.mouths) this.trackCar(c, s);
    if (g.char && g.char.alive && this.canSee(c, g.char.x, g.char.y)) s.facing = angleTo(s.x, s.y, g.char.x, g.char.y);
    else if (d > 0.3) s.facing = angleTo(c.x, c.y, g.x ?? gx, g.y ?? gy);
    else s.facing = c.facing;
  }

  // 敵の飛び道具をスタンドで受け止める（本体に反動が返る）
  standBlocks(p, x1, y1, owner) {
    let best = null;
    for (const c of this.chars) {
      const s = c.standBody;
      if (!c.alive || !s || (owner && c.team === owner.team) || s.floor !== (p.floor ?? s.floor)) continue;
      const zb = s.floor * FLOOR_H;
      if (p.z < zb - 0.2 || p.z > zb + 2) continue;
      const t = segCircle(p.x, p.y, x1, y1, s.x, s.y, 0.35);
      if (t !== null && (!best || t < best.t)) best = { t, c };
    }
    return best;
  }

  // 演出用のエフェクト（見えた人だけに表示）
  puff(kind, pos, extra = {}) {
    const z = pos.z ?? (pos.floor ?? 0) * FLOOR_H + 0.3;
    this.fx.push({ kind, x: pos.x, y: pos.y, z, t: this.t, visibleTo: this.visibleSet({ x: pos.x, y: pos.y, z }), ...extra });
  }

  // 開いた傘：正面から来る飛び道具を防ぐ
  umbrellaBlocks(p, x1, y1) {
    let best = null;
    for (const c of this.chars) {
      if (!c.alive || !(c.status.umbrellaUntil > this.t) || c.id === p.owner) continue;
      const cx = c.x + Math.cos(c.facing) * 0.45, cy = c.y + Math.sin(c.facing) * 0.45;
      const t = segCircle(p.x, p.y, x1, y1, cx, cy, 0.55);
      if (t === null) continue;
      const from = angleTo(c.x, c.y, p.x, p.y);
      if (Math.abs(angDiff(c.facing, from)) > Math.PI / 2) continue;
      if (!best || t < best.t) best = { t, c };
    }
    return best;
  }

  // 牽制射撃：一定間隔で直接撃つ
  updateBurst(c) {
    const bu = c.burst;
    if (this.t < bu.next) return;
    if (bu.left <= 0 || c.balls <= 0 || !(c.status.stunUntil <= this.t && c.status.proneUntil <= this.t)) { c.burst = null; return; }
    const inFlight = this.world.projectiles.filter(p => p.kind === 'ball' && p.owner === c.id).length;
    bu.next = this.t + 0.5;
    if (inFlight >= 3) return;
    let a = bu.angle;
    if (bu.target) {
      const pe = this.perceivedEnemy(c, bu.target);
      if (pe) a = angleTo(c.x, c.y, pe.x, pe.y);
    }
    a += (this.rng() - 0.5) * 0.06;
    c.facing = a;
    c.balls--;
    bu.left--;
    const o = this.standOrigin(c);
    this.spawnBall(c, a, o);
    this.emit({ text: `${c.name} が牽制の弾を弾いた（残り${c.balls}個）`, obsText: `${c.name} から小さな玉が続けざまに飛んでくる！`, kind: 'combat', actor: c, pos: c, sound: 3, soundKind: 'flick' });
  }

  standHit(c, dmg, what, owner) {
    this.emit({ text: `${c.name} の『${c.stand}』が${what}を受け止めた！`, obsText: `${c.name} のスタンドが${what}を受け止めた！`, kind: 'combat', actor: c, pos: c.standBody, sound: 6, soundKind: 'impact' });
    this.damage(c, Math.max(1, Math.round(dmg * (c.def.standFeedback ?? RULES.standBlock))), { source: owner, kind: 'stand', label: 'スタンドへの衝撃の反動' });
  }

  smokeBetween(x0, y0, x1, y1) {
    for (const z of this.world.zones) {
      if (z.kind !== 'smoke') continue;
      const vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((z.x - x0) * vx + (z.y - y0) * vy) / L2));
      if (dist(z.x, z.y, x0 + vx * t, y0 + vy * t) < z.r) return true;
    }
    return false;
  }

  zoneAt(kind, x, y, floor = 0) {
    return this.world.zones.find(z => z.kind === kind && (z.floor ?? 0) === floor && dist(z.x, z.y, x, y) <= z.r) || null;
  }

  addZone(z) {
    this.world.zones.push({ floor: 0, ...z });
  }

  // 同じ場所に長くとどまると、住人や通行人に気づかれて騒がれる（ガン待ち対策）
  updateLinger(c) {
    const L = c.linger;
    const bd = this.buildingOf(c);
    const key = bd ? `b:${bd.id}` : null;
    // 建物の中なら同じ建物、外なら半径5m以内を「同じ場所」とみなす
    if (!L || (key ? L.key !== key : (L.key !== null || dist(c.x, c.y, L.x, L.y) > 5))) {
      c.linger = { x: c.x, y: c.y, key, since: this.t, warned: false };
      return;
    }
    const stay = this.t - L.since;
    if (!L.warned && stay >= RULES.lingerTime - 10) {
      L.warned = true;
      this.emit({ text: `（同じ場所に長くいる。あと10秒ほどで${key ? '住人' : '通行人'}に気づかれそうだ）`, kind: 'fail', actor: c });
    }
    if (stay < RULES.lingerTime) return;
    const who = key ? (bd.kind === 'store' ? '店員' : bd.kind === 'house' ? '住人' : '作業員') : '通行人';
    this.emit({ text: `${who}が${c.name}に気づいた！「誰かいるぞ！」`, kind: 'env', pos: { x: c.x, y: c.y, floor: c.floor }, sound: 0, all: true });
    // 叫び声は全員に聞こえ、敵には居場所が正確に伝わる
    for (const o of this.chars) {
      if (o === c || !o.alive) continue;
      this.recordSound(o, { x: c.x, y: c.y, floor: c.floor }, 'speech', '誰かいるぞ！');
      if (o.team !== c.team) o.memory.seen[c.id] = { id: c.id, name: c.name, x: c.x, y: c.y, floor: c.floor, t: this.t, facing: c.facing, via: `${who}の声` };
    }
    c.status.hideUntil = 0;
    c.linger = { x: c.x, y: c.y, key, since: this.t, warned: false };
  }

  // 回復（最大HPまで）
  heal(c, amount, label) {
    if (!c.alive) return 0;
    const before = c.hp;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    const got = Math.round(c.hp - before);
    this.emit({ text: `${c.name} は${label}でHPが${got}回復した（${Math.round(c.hp)}/${c.maxHp}）`, obsText: `${c.name} が${label}で一息ついた`, kind: 'info', actor: c, pos: c });
    this.fx.push({ kind: 'num', x: c.x, y: c.y - 0.6, text: `+${got}`, t: this.t, color: '#06d6a0', visibleTo: this.visibleSet(c) });
    return got;
  }

  // 少し後に鳴らす音（足音の行列など）。owner の個体が鳴らすので拾われない
  // 先読み用の写し：盤面をまるごと複製する（記録・演出・予約済みの処理は持たない）。乱数は seed から作り直す
  fork(seed = 1) {
    const skip = new Set(['rng', 'scheduled', 'log', 'fx']);
    const data = structuredClone(Object.fromEntries(Object.entries(this).filter(([k]) => !skip.has(k))));
    const f = Object.assign(Object.create(Battle.prototype), data);
    f.rng = makeRng(seed);
    f.scheduled = [];
    f.log = [];
    f.fx = [];
    f.isSim = true;
    return f;
  }

  schedule(t, fn) {
    (this.scheduled ||= []).push({ t, fn });
  }

  // 本人の音を出さずに、聞こえる人にだけ音を届ける（置いた音を鳴らす時と同じ扱い）
  playAt(pos, radius, kind, except = null) {
    const z = (pos.floor ?? 0) * FLOOR_H + 0.5;
    for (const c of this.chars) {
      if (c === except || !c.alive) continue;
      if (this.canHear(c, pos.x, pos.y, radius, z)) this.recordSound(c, pos, kind, null);
    }
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
      if (this.sealedBoundaryBetween(c.x, c.y, nx, ny) !== null) { hit = { flame: true }; break; }
      if (L.kind !== 'aerial') {
        for (const o of this.world.objects) {
          if (o.blocksMove && o.floor === c.floor && circleRectPush(nx, ny, c.r, o)) { hit = { obj: o }; break; }
        }
        if (!hit) {
          for (const other of this.chars) {
            if (other !== c && other.alive && other.floor === c.floor && !this.isAirborne(other) && dist(nx, ny, other.x, other.y) < c.r + other.r) { hit = { char: other }; break; }
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
        // 空中で移動した先：2階建ての上なら屋根ではなく地面へ（屋根には乗れない）
        const p = nearestWalkable(this.world, c.x, c.y, 4, 0);
        if (p) { c.x = p.x; c.y = p.y; }
        c.floor = 0;
      }
      this.launchDone(c.x, c.y, traveled);
      if (hit && hit.flame) {
        this.burn(c, null);
      } else if (hit) {
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
      if (this.sealedBoundaryBetween(o.x + o.w / 2, o.y + o.h / 2, moved.x + o.w / 2, moved.y + o.h / 2) !== null) { hit = { flame: true }; break; }
      for (const p of this.world.objects) {
        if (p === o || !p.blocksMove || p.floor !== o.floor) continue;
        if (moved.x < p.x + p.w && moved.x + o.w > p.x && moved.y < p.y + p.h && moved.y + o.h > p.y) { hit = { obj: p }; break; }
      }
      if (!hit) {
        for (const ch of this.chars) {
          if (ch.alive && ch.floor === o.floor && !this.isAirborne(ch) && ch !== L.source && circleRectPush(ch.x, ch.y, ch.r, moved)) { hit = { char: ch }; break; }
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
      if (hit && hit.flame) {
        this.emit({ text: `弾き出された${o.name}は炎の壁に阻まれて止まった（${traveled.toFixed(2)}m）`, kind: 'combat', pos: cc, actor: L.source });
      } else if (hit) {
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

  canHear(listener, x, y, radius, sz = 1) {
    if (!listener.alive || radius <= 0) return false;
    if (listener.status.deafUntil > this.t) return false;
    let eff = radius * soundFactor(this.world, x, y, listener.x, listener.y, sz, this.baseZ(listener) + EYE_H);
    // 動いている発電機のそばの小さな音は、うなりにかき消される（すぐ近くなら聞こえる）
    if (radius < 12 && this.world.zones.length) {
      const hum = this.world.zones.find(z => z.kind === 'hum' && (dist(z.x, z.y, x, y) <= z.r || dist(z.x, z.y, listener.x, listener.y) <= z.r));
      if (hum) eff = Math.min(eff, 2.5);
    }
    return dist(listener.x, listener.y, x, y) <= eff;
  }

  // ログ・音・観察を一括で発行する。visibleTo は「その出来事を知覚できた者」
  emit({ text, obsText = null, kind = 'info', actor = null, pos = null, sound = 0, soundKind = null, all = false, hint = null, affected = null }) {
    // エコー・ビーチの個体に拾われた音は、その場では鳴らない
    if (pos && sound && this.captureSound(pos, sound, soundKind || kind, obsText || text, this.chars.includes(pos) ? pos : null, actor)) sound = 0;
    const visibleTo = new Set();
    const heardBy = new Set();
    const soundSeen = new Set(); // 音の出どころが見えていて、音も聞こえた人（音の輪を正確な位置に出す）
    for (const c of this.chars) {
      const pz = pos ? this.zOf(pos, actor || affected || c) : 0;
      if (all || c === actor || c === affected) {
        visibleTo.add(c.id);
        if (pos && sound && (c === actor || c === affected)) soundSeen.add(c.id);
        continue;
      }
      const seen = pos && this.canSee(c, pos.x, pos.y, pz);
      const heard = pos && sound && this.canHear(c, pos.x, pos.y, sound, pz);
      if (seen || heard) visibleTo.add(c.id);
      if (heard && !seen) heardBy.add(c.id);
      if (heard && seen) soundSeen.add(c.id);
      if (heard && seen && soundKind === 'alarm') this.recordSound(c, pos, soundKind, obsText || text);
    }
    const entry = { t: this.t, text, obsText, kind, actor: actor ? actor.id : null, visibleTo, heardBy };
    if (pos && sound && soundSeen.size) this.fx.push({ kind: 'sound', x: pos.x, y: pos.y, z: this.zOf(pos), radius: sound, sk: soundKind || kind, t: this.t, visibleTo: soundSeen });
    this.log.push(entry);
    if (kind === 'ability' && pos) this.fx.push({ kind: 'flash', seq: ++this.fxSeq, x: pos.x, y: pos.y, t: this.t, color: actor ? actor.color : '#fff', charId: actor ? actor.charId : null, visibleTo });
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
    heard.push({ t: this.t, kind, text, x: approx.x, y: approx.y, floor: pos.floor ?? 0 });
    while (heard.length > 14) heard.shift();
  }

  // 音だけ（ログには残さない足音など）
  noise(src, radius, kind) {
    if (this.captureSound(src, radius, kind, null, this.chars.includes(src) ? src : null)) return;
    for (const c of this.chars) {
      if (c === src) continue;
      if (this.canHear(c, src.x, src.y, radius, this.baseZ(src) + 1)) this.recordSound(c, src, kind, null);
    }
  }

  speak(c, text) {
    if (!text) return;
    // 同じセリフの連呼は省く
    if (c.lastSpeech && c.lastSpeech.text === text && this.t - c.lastSpeech.t < 10) return;
    c.lastSpeech = { text, t: this.t };
    c.speech = { text, until: this.t + 3.5 };
    const stolen = this.captureSound(c, RULES.speechRadius, 'speech', text, c);
    const entry = { t: this.t, text: `${c.name}「${text}」`, kind: 'speech', actor: c.id, visibleTo: new Set([c.id]), heardBy: new Set() };
    let heard = false;
    for (const listener of this.chars) {
      if (listener === c || !listener.alive || stolen) continue;
      if (!this.canHear(listener, c.x, c.y, RULES.speechRadius, this.baseZ(c) + EYE_H)) continue;
      entry.visibleTo.add(listener.id);
      entry.heardBy.add(listener.id);
      this.recordSound(listener, c, 'speech', text);
      if (listener.team !== c.team) heard = true;
    }
    // リトル・レッド・コルベット：全部の口から同じ声が出る（噛みつきは外れる）
    if (c.mouths && c.mouths.length && !(c.status.grabbedUntil > this.t)) {
      if (c.clench) this.releaseClench(c, '喋ったので');
      const spots = this.mouthSpots(c);
      for (const m of spots) {
        for (const listener of this.chars) {
          if (listener === c || !listener.alive || entry.heardBy.has(listener.id)) continue;
          if (m.on === listener.id || this.canHear(listener, m.x, m.y, RULES.speechRadius * 0.8, (m.floor ?? 0) * FLOOR_H + 1)) {
            entry.visibleTo.add(listener.id);
            entry.heardBy.add(listener.id);
            this.recordSound(listener, { x: m.x, y: m.y, floor: m.floor }, 'speech', text);
            if (listener.team !== c.team) { heard = true; if (m.on === listener.id) this.noticeMouth(listener, m); }
          }
        }
        m.revealedUntil = this.t + 3;
      }
      entry.text += `（${spots.length}個の口からも同じ声）`;
    }
    c.speech.heardByEnemy = heard;
    c.speech.heardBy = entry.heardBy;
    this.log.push(entry);
  }

  // 見えている敵を記憶する。2対2では味方にも位置を知らせる（携帯で連絡を取り合っている）
  updatePerception(c) {
    for (const e of this.enemiesOf(c)) {
      if (!e.alive || !this.canSee(c, e.x, e.y)) continue;
      if (this.t - c.memory.sawEnemyAt > 1.5) c.memory.newlySpotted = true;
      const rec = { id: e.id, name: e.name, x: e.x, y: e.y, floor: e.floor, t: this.t, facing: e.facing };
      c.memory.seen[e.id] = rec;
      c.memory.sawEnemyAt = this.t;
      for (const a of this.alliesOf(c)) if (a.alive) a.memory.seen[e.id] = { ...rec, via: c.name };
    }
    const e = this.enemyOf(c);
    const all = Object.values(c.memory.seen).filter(r => this.chars.find(x => x.id === r.id)?.alive);
    c.memory.lastSeen = c.memory.seen[e.id] || all.sort((a, z) => z.t - a.t)[0] || null;
  }

  perceivedEnemy(c, e = this.enemyOf(c)) {
    if (e.alive && this.canSee(c, e.x, e.y)) return { x: e.x, y: e.y, floor: e.floor, visible: true, char: e };
    const rec = c.memory.seen[e.id] || (e === this.enemyOf(c) ? c.memory.lastSeen : null);
    if (rec) return { ...rec, visible: false, char: null };
    return null;
  }

  // チームが相手に与えたダメージの合計（判定に使う）
  teamDealt(team) {
    return Math.round(this.chars.filter(c => c.team === team).reduce((s, c) => s + (c.dealt || 0), 0));
  }

  // 通報で警察が来る：サイレン（全員に聞こえる）→ 到着で判定
  updatePolice() {
    if (!this.policeWarned && this.t >= RULES.policeWarn) {
      this.policeWarned = true;
      this.emit({ text: `遠くからパトカーのサイレンが近づいてくる……（あと${RULES.timeLimit - RULES.policeWarn}秒で警察が到着。その時点で相手に多くダメージを与えていた側の判定勝ち）`, kind: 'system', all: true });
      for (const c of this.chars) if (c.alive) this.recordSound(c, { x: this.world.w / 2, y: this.world.h + 5, floor: 0 }, 'siren', null);
    }
    if (this.t < RULES.timeLimit) return;
    const d0 = this.teamDealt(0), d1 = this.teamDealt(1);
    this.over = true;
    this.endReason = 'police';
    this.winnerTeam = d0 > d1 ? 0 : d1 > d0 ? 1 : null;
    this.winner = this.winnerTeam === null ? null : this.chars.find(c => c.team === this.winnerTeam && c.alive) || this.chars.find(c => c.team === this.winnerTeam);
    const name = t => this.chars.filter(c => c.team === t).map(c => c.name).join('・');
    this.emit({ text: `警察が到着！ 全員がその場から散った。判定：${name(0)} ${d0} 対 ${name(1)} ${d1}（与えたダメージ）→ ${this.winnerTeam === null ? '引き分け' : `${name(this.winnerTeam)}の判定勝ち`}`, kind: 'system', all: true });
  }

  // ---------- 安全地帯（徐々に狭まる） ----------

  // 中心は地図の中ほどの歩ける屋外。最初の半径は地図全体を覆う大きさ
  initSafeZone() {
    const w = this.world;
    let c = null;
    for (let i = 0; i < 40 && !c; i++) {
      const x = w.w * (0.3 + this.rng() * 0.4), y = w.h * (0.3 + this.rng() * 0.4);
      if (isWalkablePoint(w, x, y, 0) && !buildingAt(w, x, y)) c = { x, y };
    }
    c = c || { x: w.w / 2, y: w.h / 2 };
    const r0 = Math.max(...[[0, 0], [w.w, 0], [0, w.h], [w.w, w.h]].map(([x, y]) => dist(c.x, c.y, x, y))) + 1;
    this.safeZone = { x: c.x, y: c.y, r0, phase: -1, nextTick: {} };
  }

  // 時刻 t の半径
  zoneRadius(t = this.t) {
    const z = this.safeZone;
    if (!z) return Infinity;
    let frac = 1;
    for (const [t0, t1, to] of RULES.zonePhases) {
      const target = Math.max(RULES.zoneMinR / z.r0, to);
      if (t <= t0) break;
      frac = t >= t1 ? target : frac + (target - frac) * ((t - t0) / (t1 - t0));
      if (t < t1) break;
    }
    return Math.max(RULES.zoneMinR, z.r0 * frac);
  }

  zonePhaseAt(t = this.t) {
    let n = 0;
    for (const [t0] of RULES.zonePhases) if (t >= t0) n++;
    return n;
  }

  outsideZone(p, t = this.t) {
    if (!this.safeZone) return false;
    return dist(p.x, p.y, this.safeZone.x, this.safeZone.y) > this.zoneRadius(t);
  }

  updateSafeZone() {
    const z = this.safeZone;
    if (!z) return;
    const phase = this.zonePhaseAt();
    if (phase !== z.phase) {
      z.phase = phase;
      const ph = RULES.zonePhases[phase - 1];
      if (ph) {
        const r1 = Math.round(Math.max(RULES.zoneMinR, z.r0 * Math.max(RULES.zoneMinR / z.r0, ph[2])));
        this.emit({ text: `安全地帯が狭まり始めた（${ph[1] - ph[0]}秒かけて半径${r1}mまで。中心 (${z.x.toFixed(0)}, ${z.y.toFixed(0)})）。外にいると毎秒ダメージ`, kind: 'system', all: true });
      } else if (phase === 0) {
        this.emit({ text: `安全地帯：中心 (${z.x.toFixed(0)}, ${z.y.toFixed(0)})。${RULES.zonePhases[0][0]}秒後から段階的に狭まる`, kind: 'system', all: true });
      }
    }
    if (phase === 0) return;
    for (const c of this.chars) {
      if (!c.alive || !this.outsideZone(c)) { if (c.alive) c.zoneWarned = false; continue; }
      if (!c.zoneWarned) {
        c.zoneWarned = true;
        this.emit({ text: `（${c.name} は安全地帯の外にいる！ 中心 (${z.x.toFixed(0)}, ${z.y.toFixed(0)}) の方へ戻らないと削られ続ける）`, kind: 'fail', actor: c });
      }
      if (this.t < (z.nextTick[c.id] ?? 0)) continue;
      z.nextTick[c.id] = this.t + 1;
      this.damage(c, RULES.zoneDamage + phase - 1, { kind: 'zone', label: '安全地帯の外' });
    }
  }

  teamAlive(team) {
    return this.chars.some(c => c.team === team && c.alive);
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
    // 受け流し：正面から殴られたら受け流して打ち返す
    if (kind === 'melee' && source && target.status.counterUntil > this.t) {
      const a = angleTo(target.x, target.y, source.x, source.y);
      if (Math.abs(angDiff(target.facing, a)) <= (75 * Math.PI) / 180) {
        target.status.counterUntil = 0;
        this.emit({ text: `${target.name} は${source.name}の${label || '攻撃'}を受け流し、打ち返した！`, kind: 'combat', actor: target, affected: source, pos: target, sound: 6, soundKind: 'impact' });
        source.status.stunUntil = Math.max(source.status.stunUntil, this.t + 0.6);
        this.damage(source, target.def.power * 1.2, { source: target, kind: 'counter', from: target, label: '受け流しからの反撃' });
        return 0;
      }
    }
    // 自分の腕や肩の口：食いしばっていれば、拳や刃を噛んで受け止める（口は壊れる）
    if ((kind === 'melee' || kind === 'grab') && source && target.clench && target.mouths) {
      const guard = target.mouths.find(m => m.on === target.id);
      if (guard) {
        target.mouths = target.mouths.filter(m => m !== guard);
        source.status.stunUntil = Math.max(source.status.stunUntil, this.t + 0.7);
        this.emit({ text: `${target.name} の腕の口が${source.name}の${label || '攻撃'}に噛みついて受け止めた！（口は砕けた・残り${target.mouths.length}個）`, kind: 'combat', actor: target, affected: source, pos: target, sound: 6, soundKind: 'impact', hint: ABILITIES.corvette.observedHint });
        return 0;
      }
    }
    let dmg = amount * target.def.defense;
    const scoring = source && source.team !== target.team;
    let guarded = false;
    if (from && target.status.guardUntil > this.t && (kind === 'melee' || kind === 'thrown')) {
      const a = angleTo(target.x, target.y, from.x, from.y);
      if (Math.abs(angDiff(target.facing, a)) <= (70 * Math.PI) / 180) { dmg *= 0.3; guarded = true; }
    }
    if (target.status.proneUntil > this.t) dmg *= 1.3;
    dmg = Math.max(1, Math.round(dmg));
    if (scoring) source.dealt = (source.dealt || 0) + Math.min(dmg, target.hp);
    target.hp = Math.max(0, target.hp - dmg);
    target.lastDamagedAt = this.t;
    const entry = this.emit({
      text: `${target.name} に${label ? `${label}で` : ''}${dmg}ダメージ${guarded ? '（ガード）' : ''}`,
      kind: 'damage', actor: source, affected: target, pos: target, sound: 9, soundKind: 'damage',
    });
    this.fx.push({ kind: 'num', x: target.x, y: target.y - 0.6, text: `-${dmg}`, t: this.t, color: guarded ? '#aaa' : '#ff5d73', big: dmg >= 15, visibleTo: entry.visibleTo });
    if (['fall', 'slam', 'launch_impact', 'debris'].includes(kind)) this.puff('dust', { x: target.x, y: target.y, floor: target.floor });
    // 演出用：打撃の瞬間（画面側でヒットストップ・揺れ・擬音にする）
    this.fx.push({ kind: 'hit', seq: ++this.fxSeq, x: target.x, y: target.y, z: this.baseZ(target) + 1.1, dmg, guarded, hitKind: kind, target: target.id, t: this.t, visibleTo: entry.visibleTo, ang: from ? angleTo(from.x, from.y, target.x, target.y) : this.rng() * Math.PI * 2 });
    // 怯み：構えや詠唱を中断させる
    // 同じ瞬間に放たれる攻撃は相打ちにする（処理順で有利不利が出ないように）
    const releasing = target.windup && target.windup.until <= this.t + RULES.dt + 1e-6;
    if (dmg >= 6 && !guarded && !releasing) {
      target.status.stunUntil = Math.max(target.status.stunUntil, this.t + 0.25);
      interruptStep(this, target, '攻撃を受けて行動が中断された');
    }
    // 強い一撃：殴られた側・殴った側が思わず口にする一言（CPU のみ）
    if (dmg >= 15 && target.hp > 0) {
      const hurt = blurt(this, target, 'hurt');
      if (hurt) this.speak(target, hurt);
      else if (source && source !== target && source.alive) {
        const hit = blurt(this, source, 'hit');
        if (hit) this.speak(source, hit);
      }
    }
    if (target.hp <= 0) {
      target.alive = false;
      target.vx = target.vy = 0;
      const ko = this.emit({ text: `${target.name} は再起不能（リタイヤ）！`, kind: 'ko', all: true });
      this.fx.push({ kind: 'ko', seq: ++this.fxSeq, x: target.x, y: target.y, z: this.baseZ(target) + 1, t: this.t, name: target.name, visibleTo: ko.visibleTo });
    }
    return dmg;
  }

  // ---------- 環境 ----------

  damageObject(o, amount, source) {
    if (!this.world.objects.includes(o)) return;
    if (o.kind === 'car' && !(o.alarmUntil > this.t)) {
      // 車に衝撃が加わると防犯アラームが鳴る（広い範囲に聞こえる）
      o.alarmUntil = this.t + 6;
      this.emit({ text: `${o.name}の防犯アラームがけたたましく鳴り響く！`, kind: 'env', pos: { x: o.x + o.w / 2, y: o.y + o.h / 2, z: 1 }, sound: 40, soundKind: 'alarm', actor: source });
    }
    if (o.indestructible) return;
    o.hp -= amount;
    if (o.hp > 0) return;
    this.destroyObject(o, source);
  }

  // 窓のガラスが割れる：窓枠は残り、枠の開け閉めとは別に「割れている」状態になる（通り抜けられる）
  breakGlass(o, source) {
    if (o.broken) return;
    o.broken = true;
    o.blocksMove = false;
    o.indestructible = true;
    const center = { x: o.x + o.w / 2, y: o.y + o.h / 2, floor: o.floor };
    this.emit({ text: `${o.name} のガラスが割れた！（窓枠は${o.openable ? (o.open ? '開いたまま' : '閉まったまま') : 'はめ殺し'}）`, kind: 'env', pos: center, sound: 12, soundKind: 'glass', actor: source });
    this.puff('glass', { ...center, z: o.floor * FLOOR_H + 1.2 });
    markNavDirty(this.world);
  }

  destroyObject(o, source, cause = '破壊') {
    const w = this.world;
    if (o.kind === 'window') { this.breakGlass(o, source); return; }
    w.objects = w.objects.filter(x => x !== o);
    const center = { x: o.x + o.w / 2, y: o.y + o.h / 2, floor: o.floor };
    if (o.kind === 'wall') {
      w.rubble.push({ x: o.x - 0.3, y: o.y - 0.3, w: o.w + 0.6, h: o.h + 0.6, floor: o.floor });
      this.emit({ text: `${o.name} が崩れ落ちた！`, kind: 'env', pos: center, sound: 14, soundKind: 'crash', actor: source });
      this.puff('dust', center, { big: true });
      for (const c of this.chars) {
        if (c !== source && c.alive && c.floor <= o.floor && distToRect(c.x, c.y, o) <= 1.2) this.damage(c, 10, { source, kind: 'debris', label: '崩落した瓦礫' });
      }
    } else {
      w.rubble.push({ x: o.x, y: o.y, w: o.w, h: o.h, floor: o.floor });
      this.emit({ text: `${o.name} が壊れた。`, kind: 'env', pos: center, sound: 10, soundKind: 'crash', actor: source });
    }
    markNavDirty(w);
  }

  // ---------- プリティ・ヴェイカント：粉にする・元に戻す ----------

  // 物の素材（粉の名前）
  powderMaterial(o) {
    if (o.kind === 'window') return 'ガラス粉';
    if (o.kind === 'wall') return o.style === 'panel' ? '鉄粉' : '石粉';
    if (['vending', 'drum', 'trashcan', 'steel'].includes(o.kind)) return '鉄粉';
    if (o.kind === 'cone') return '樹脂の粉';
    if (o.kind === 'shelf') return '鉄粉と木粉';
    return '木粉';
  }

  canPowder(o) {
    if (!o || !this.world.objects.includes(o)) return false;
    if (o.kind === 'window') return !o.broken;
    if (o.kind === 'wall') return !String(o.id).startsWith('outer_');
    return !o.indestructible && !['stairs', 'bush', 'hole'].includes(o.kind);
  }

  addPile(rect, floor, material, obj, by) {
    const w = this.world;
    if (!w.piles) w.piles = [];
    const pile = { id: `pile_${w.piles.length + 1}`, x: rect.x, y: rect.y, w: rect.w, h: rect.h, floor, material, obj, by: by ? by.id : null, t: this.t, scattered: false };
    w.piles.push(pile);
    return pile;
  }

  // 物を粉にする。壁は触れた所（near）に約1mの穴を開ける。粉の山を返す
  powderObject(o, by, near) {
    const w = this.world;
    const center = { x: o.x + o.w / 2, y: o.y + o.h / 2, floor: o.floor };
    const material = this.powderMaterial(o);
    let pile;
    if (o.kind === 'window') {
      o.broken = true;
      o.blocksMove = false;
      o.indestructible = true;
      pile = this.addPile({ x: o.x - 0.3, y: o.y - 0.3, w: o.w + 0.6, h: o.h + 0.6 }, o.floor, material, { glassOf: o.id }, by);
      this.emit({ text: `${o.name} のガラスが、さらさらとガラス粉になって崩れ落ちた`, kind: 'env', pos: center, sound: 4, soundKind: 'powder', actor: by });
    } else if (o.kind === 'wall' && Math.max(o.w, o.h) > 1.6) {
      // 長い壁は一部だけ：触れた所を中心に約1.1m
      const horiz = o.w >= o.h;
      const len = horiz ? o.w : o.h, start = horiz ? o.x : o.y;
      const at = near ? (horiz ? near.x : near.y) : start + len / 2;
      const a = clamp(at - 0.55, start, start + len - 1.1), b2 = a + 1.1;
      const slice = horiz ? { x: a, y: o.y, w: 1.1, h: o.h } : { x: o.x, y: a, w: o.w, h: 1.1 };
      w.objects = w.objects.filter(x => x !== o);
      const parts = [[start, a], [b2, start + len]].filter(([p0, p1]) => p1 - p0 > 0.15);
      parts.forEach(([p0, p1], i) => {
        w.objects.push({ ...o, id: `${o.id}_${i ? 'b' : 'a'}`, ...(horiz ? { x: p0, w: p1 - p0 } : { y: p0, h: p1 - p0 }) });
      });
      const snap = { ...o, id: `${o.id}_patch`, ...slice };
      pile = this.addPile({ x: slice.x - 0.4, y: slice.y - 0.4, w: slice.w + 0.8, h: slice.h + 0.8 }, o.floor, material, snap, by);
      this.emit({ text: `${o.name} の一部がさらさらと${material}になって崩れ、約1mの穴が開いた`, kind: 'env', pos: { x: slice.x + slice.w / 2, y: slice.y + slice.h / 2, floor: o.floor }, sound: 5, soundKind: 'powder', actor: by });
    } else {
      w.objects = w.objects.filter(x => x !== o);
      pile = this.addPile({ x: o.x - 0.2, y: o.y - 0.2, w: o.w + 0.4, h: o.h + 0.4 }, o.floor, material, { ...o }, by);
      this.emit({ text: `${o.name} が、さらさらと${material}の山になって崩れた`, kind: 'env', pos: center, sound: 5, soundKind: 'powder', actor: by });
    }
    this.puff('dust', { x: pile.x + pile.w / 2, y: pile.y + pile.h / 2, floor: pile.floor });
    markNavDirty(w);
    return pile;
  }

  // 粉の山を集めて元の形に戻す（中は空洞でもろい）
  restorePile(pile, by) {
    const w = this.world;
    const snap = pile.obj;
    if (!snap) return '形のない粉（床など）は戻せない';
    if (pile.scattered) return '粉が散っていて、8割も集められない';
    if (snap.glassOf) {
      const o = w.objects.find(x => x.id === snap.glassOf);
      if (!o) return '窓枠ごと無くなっている';
      o.broken = false;
      o.blocksMove = !o.open;
      o.indestructible = false;
      o.hp = 2;
      o.restored = true;
    } else {
      if (this.chars.some(c => c.alive && c.floor === snap.floor && circleRectPush(c.x, c.y, c.r, snap))) return '戻す場所に人が立っている';
      w.objects.push({ ...snap, hp: Math.max(3, Math.round((snap.hp ?? 10) * 0.3)), restored: true, vx: 0, vy: 0 });
    }
    w.piles = w.piles.filter(x => x !== pile);
    markNavDirty(w);
    const name = snap.glassOf ? (w.objects.find(x => x.id === snap.glassOf) || {}).name : snap.name;
    this.emit({ text: `${by ? by.name : '誰か'} が${pile.material}を集め、${name}を元の形に戻した`, obsText: `散らばっていた粉が寄り集まり、${name}が元どおりの形になった`, kind: 'env', actor: by, pos: { x: pile.x + pile.w / 2, y: pile.y + pile.h / 2, floor: pile.floor }, sound: 4, soundKind: 'powder' });
    return null;
  }

  // 粉の山を走って踏むと散る／仕込まれた床を踏むと抜ける
  updatePowderStep(c, running) {
    const w = this.world;
    if (w.piles) {
      for (const p of w.piles) {
        if (!p.scattered && running && p.floor === c.floor && pointInRect(c.x, c.y, p)) {
          p.scattered = true;
          this.emit({ text: `${c.name} が${p.material}の山を踏み散らした`, kind: 'env', actor: c, pos: c });
        }
      }
    }
    const tz = this.world.zones.find(z => z.kind === 'powder_trap' && z.team !== c.team && (z.floor ?? 0) === c.floor && dist(z.x, z.y, c.x, c.y) <= z.r);
    if (tz && !(c.status.proneUntil > this.t) && !this.isAirborne(c)) {
      w.zones = w.zones.filter(z => z !== tz);
      const owner = this.chars.find(x => x.id === tz.owner) || null;
      c.status.proneUntil = this.t + 1.6;
      c.vx *= 0.2; c.vy *= 0.2;
      this.puff('dust', { x: c.x, y: c.y, floor: c.floor });
      this.emit({ text: `${c.name} の足元の床がさらさらと抜け、足を取られて倒れた！`, kind: 'combat', affected: c, pos: c, sound: 6, soundKind: 'fall', hint: ABILITIES.vacant.observedHint });
      interruptStep(this, c, '足元の床が粉になって抜けた', true);
      this.damage(c, 5, { source: owner, kind: 'ability', label: '崩れた床' });
    }
  }

  // 飛来物は高さも持つ：手の高さから狙った高さへまっすぐ飛ぶ（2階から下へ投げ下ろすこともできる）
  // 手に持った物を投げる（item は投げた物。落ちた所に残る／割れ物は割れる）
  spawnThrown(owner, item, x, y, tx, ty, { speed = RULES.throwSpeed, damage = itemDef(item).throw, maxRange = RULES.throwRange, tz = null } = {}) {
    const a = angleTo(x, y, tx, ty);
    const z0 = this.baseZ(owner) + 1.4;
    const d = Math.max(0.5, dist(x, y, tx, ty));
    const z1 = tz ?? this.zOf({ x: tx, y: ty }, owner);
    const p = {
      id: `thrown_${++projSeq}`, kind: 'thrown', item, owner: owner.id,
      x: x + Math.cos(a) * 0.55, y: y + Math.sin(a) * 0.55, z: z0,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, vz: ((z1 - z0) / d) * speed,
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
    if (this.scheduled && this.scheduled.length) {
      const due = this.scheduled.filter(s => s.t <= this.t);
      this.scheduled = this.scheduled.filter(s => s.t > this.t);
      for (const s of due) s.fn();
    }
    for (const c of this.chars) if (c.burst && c.alive) this.updateBurst(c);
    for (const c of this.chars) if (c.alive) this.updateLinger(c);
    for (const c of this.chars) if (c.alive && c.mouths) this.updateMouths(c, dt);
    this.updateSeals();

    for (const c of this.chars) {
      if (!c.alive) continue;
      if (c.speech && c.speech.until < this.t) c.speech = null;
      this.updatePerception(c);
      updateRunner(this, c);
    }
    for (const c of this.chars) if (c.alive) this.moveChar(c, dt);
    for (const c of this.chars) this.updateStand(c, dt);
    this.separateChars();
    this.updateObjects(dt);
    for (const c of this.chars) if (c.units) this.updateUnits(c, dt);
    this.updateProjectiles(dt);
    this.fx = this.fx.filter(f => this.t - f.t < (f.kind === 'ko' ? 2.5 : 1.2));

    this.updateSafeZone(dt);
    this.updatePolice();
    if (this.over) return;
    const t0 = this.teamAlive(0), t1 = this.teamAlive(1);
    if (!t0 || !t1) {
      this.over = true;
      this.winnerTeam = t0 ? 0 : t1 ? 1 : null;
      this.winner = this.winnerTeam === null ? null : this.chars.find(c => c.team === this.winnerTeam && c.alive);
      const names = this.winnerTeam === null ? '' : this.chars.filter(c => c.team === this.winnerTeam).map(c => `${c.name}『${c.stand}』`).join('・');
      this.emit({ text: this.winnerTeam === null ? '相打ち' : `勝者：${names}`, kind: 'system', all: true });
    }
  }

  // 人物がいる建物（2階も含む）
  roomOf(c) {
    return buildingAt(this.world, c.x, c.y);
  }

  moveChar(c, dt) {
    const s = c.status;
    for (const k in c.cd) if (c.cd[k] <= this.t) delete c.cd[k];
    if (!c.standBody) c.sp = Math.min(c.maxSp, c.sp + c.def.spRegen * dt);
    else {
      // 出している間は少しずつエネルギーを使い、尽きると自然に戻る
      // 遠隔操作の車両は、出したままでも少しずつ回復する
      const regen = c.def.standBlind ? c.def.spRegen * 0.5 : 0;
      c.sp = Math.min(c.maxSp, Math.max(0, c.sp + (regen - (c.def.standDrain ?? RULES.standDrain)) * dt));
      if (c.sp <= 0) {
        c.standBody = null;
        this.emit({ text: `スタンドエネルギーが尽き、『${c.stand}』が体に戻った`, kind: 'fail', actor: c });
      }
    }

    if (c.launch) {
      this.updateCharLaunch(c, dt);
      return;
    }
    if (c.climb) {
      // 階段の上り下り
      c.vx = c.vy = 0;
      if (c.climb.until > this.t) return;
      c.floor = c.climb.to;
      c.climb = null;
      this.noise(c, 6, 'footsteps');
    }
    if (c.air) {
      if (c.air.landAt > this.t) { c.vx = c.vy = 0; return; }
      // 落下して着地
      const soft = c.air.soft;
      c.air = null;
      const p = nearestWalkable(this.world, c.x, c.y, 3, c.floor);
      if (p) { c.x = p.x; c.y = p.y; }
      this.puff('dust', { x: c.x, y: c.y, floor: c.floor });
      const up = c.uplifted;
      c.uplifted = null;
      if (up) {
        // 打ち上げられて落ちた：受け身が取れず転倒
        this.emit({ text: `${c.name} が地面に叩きつけられた！`, kind: 'combat', affected: c, pos: c, sound: 10, soundKind: 'fall' });
        this.damage(c, 8, { source: up.source, kind: 'fall', label: '打ち上げからの落下' });
        s.proneUntil = Math.max(s.proneUntil, this.t + 1.2);
      } else if (!soft) {
        this.emit({ text: `${c.name} が落下して着地した`, kind: 'combat', actor: c, pos: c, sound: 8, soundKind: 'fall' });
        this.damage(c, 5, { source: null, kind: 'fall', label: '着地の衝撃' });
        s.stunUntil = Math.max(s.stunUntil, this.t + 0.3);
      }
    }

    const kbSpeed = Math.hypot(c.kbx, c.kby);
    const incapacitated = s.proneUntil > this.t || s.stunUntil > this.t || s.recoverUntil > this.t;
    const onRubble = this.world.rubble.some(r => (r.floor ?? 0) === c.floor && pointInRect(c.x, c.y, r));

    if (kbSpeed > 0.2) {
      c.vx = c.kbx; c.vy = c.kby;
      const decay = Math.max(0, kbSpeed - 14 * dt) / kbSpeed;
      c.kbx *= decay; c.kby *= decay;
    } else {
      c.kbx = c.kby = 0;
      c.kbSlam = null;
      // 口に噛みつかれていると動きが鈍る（足首なら大きく）
      const bitten = s.bittenUntil > this.t ? s.bittenSlow : 1;
      let tvx = incapacitated ? 0 : c.desired.vx * bitten;
      let tvy = incapacitated ? 0 : c.desired.vy * bitten;
      if (Math.hypot(tvx, tvy) > 0.01) {
        // 旋回：向きと進行方向がずれているほど遅くなる
        const diff = Math.abs(angDiff(c.facing, Math.atan2(tvy, tvx)));
        let factor = 0.6 + 0.4 * Math.max(0, Math.cos(diff));
        if (onRubble) factor *= 0.6;
        if (c.floor === 0 && this.bushAt(c.x, c.y)) factor *= 0.6;
        tvx *= factor; tvy *= factor;
      }
      const accel = s.proneUntil > this.t ? 12 : 20;
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

    // 移動と衝突（同じ階の物だけ）
    const ox = c.x, oy = c.y;
    const roomBefore = this.roomOf(c);
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    let slammed = false;
    for (let iter = 0; iter < 3; iter++) {
      for (const o of this.world.objects) {
        if (!o.blocksMove || o.floor !== c.floor) continue;
        const p = circleRectPush(c.x, c.y, c.r, o);
        if (!p) continue;
        // 閉じた扉は、歩いてぶつかれば開ける（少し手間取る）
        if (o.kind === 'door' && kbSpeed <= 0.2 && !incapacitated) {
          this.setOpen(o, true, c);
          s.recoverUntil = Math.max(s.recoverUntil, this.t + 0.35);
        }
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

    // 密室の炎：建物の内と外の境目は越えられない
    if (this.crossesSealedRoom(c, roomBefore)) {
      c.x = ox; c.y = oy;
      c.vx = c.vy = 0;
      this.burn(c, roomBefore || this.roomOf({ x: c.x + c.vx * dt, y: c.y + c.vy * dt }));
    }

    // 2階の床の外に出たら落下する（2階の窓から飛び出した時など）
    if (c.floor === 1 && !upperFloorAt(this.world, c.x, c.y)) this.startDrop(c);

    // 潜んでいる人は、歩き出すと解ける
    if (s.hideUntil > this.t && speed > 0.4 && kbSpeed <= 0.2) s.hideUntil = 0;
    if (s.deepHide && !(s.hideUntil > this.t)) s.deepHide = false;
    // 撒かれた玉：走って踏むと転ぶ（撒いた本人の側は踏まない）
    if (speed > c.def.walk + 0.3 && !(s.proneUntil > this.t)) {
      const cz = this.zoneAt('caltrops', c.x, c.y, c.floor);
      if (cz && cz.team !== c.team) {
        s.proneUntil = this.t + 1.2;
        c.vx *= 0.3; c.vy *= 0.3;
        this.emit({ text: `${c.name} は床に撒かれた玉を踏んで転んだ！`, kind: 'combat', affected: c, pos: c, sound: 6, soundKind: 'fall', hint: ABILITIES.seventh.observedHint });
        interruptStep(this, c, '足を取られて転んだ', true);
      }
    }

    if ((this.world.piles && this.world.piles.length) || this.world.zones.length) this.updatePowderStep(c, speed > c.def.walk + 0.3);

    // 足音
    const moved = dist(ox, oy, c.x, c.y);
    c.stepAccum += moved;
    const running = speed > c.def.walk + 0.3;
    if (c.stepAccum > (running ? 1.5 : 1.2)) {
      c.stepAccum = 0;
      if (speed > 0.8) this.noise(c, running ? 9 : 3, running ? 'footsteps_run' : 'footsteps');
      if (speed > 0.8 && c.floor === 0 && this.bushAt(c.x, c.y)) this.noise(c, 6, 'rustle');
    }
  }

  // ---------- 扉・窓と、ホテル・カリフォルニアの密室 ----------

  // 出口の開け閉め。閉める時は人が挟まっていないこと。成功したら true
  setOpen(o, open, by) {
    if (!o.openable || !this.world.objects.includes(o) || !!o.open === open) return false;
    if (!open && this.chars.some(c => c.alive && c.floor === o.floor && circleRectPush(c.x, c.y, c.r, o))) return false;
    o.open = open;
    o.blocksMove = !open && !o.broken;
    if (o.kind === 'door') o.blocksSight = !open;
    if (o.kind === 'window') markNavDirty(this.world);
    const cc = { x: o.x + o.w / 2, y: o.y + o.h / 2, floor: o.floor };
    this.emit({ text: `${by ? by.name : '誰か'} が${o.name}を${open ? '開けた' : '閉めた'}`, kind: 'env', actor: by, pos: cc, sound: o.kind === 'door' ? 6 : 4, soundKind: 'door' });
    if (!open && by && by.def.abilities.includes('hotel')) this.trySeal(by, o);
    return true;
  }

  // 出口が開いているか：窓は「枠」で判定する（ガラスが割れていても枠が閉まっていれば閉まった扱い）。
  // はめ殺しの窓（コンビニのガラスなど）は枠が開かないので、ガラスが割れても閉まった扱い。壊れて無くなった出口だけは開いた扱い
  exitOpen(id) {
    const o = objectById(this.world, id);
    if (!o) return true;
    if (o.kind === 'window' && !o.openable) return false;
    return !!o.open;
  }

  // 錠二が建物の内側で、最後の出口を自分の手で閉めた瞬間に密室が成立する
  trySeal(c, closed) {
    const bd = this.world.buildings.find(x => x.id === closed.building);
    if (!bd || bd.sealed || !pointInRect(c.x, c.y, bd)) return;
    const still = bd.exits.filter(id => this.exitOpen(id));
    if (still.length) {
      // まだ開いている出口を本人に知らせる（相手が中にいる時だけ。黙って失敗しないように）
      if (this.chars.some(x => x.team !== c.team && x.alive && pointInRect(x.x, x.y, bd))) {
        const names = still.map(id => objectById(this.world, id)?.name || '壊れた出口').join('・');
        this.emit({ text: `まだ開いている出口がある：${names}（あと${still.length}か所閉めれば密室）`, kind: 'fail', actor: c });
      }
      return;
    }
    // 閉じ込める相手が中にいなければ密室にはならない（自分だけが閉じこもることはない）
    if (!this.chars.some(x => x.team !== c.team && x.alive && pointInRect(x.x, x.y, bd))) {
      this.emit({ text: `出口はすべて閉じたが、${bd.name}の中に相手がいないので密室にはならない`, kind: 'fail', actor: c });
      return;
    }
    if (bd.w * bd.h * bd.floors > 200) {
      this.emit({ text: `${bd.name}は広すぎて密室にできない（約${Math.round(bd.w * bd.h * bd.floors)}㎡ > 200㎡）`, kind: 'fail', actor: c });
      return;
    }
    bd.sealed = { by: c.id, since: this.t };
    const ab = ABILITIES.hotel;
    const inside = this.chars.filter(x => x.alive && pointInRect(x.x, x.y, bd)).map(x => x.name).join('と');
    this.emit({
      text: `『${ab.name}』— 最後の出口が閉じた。${bd.name}の外周を炎が囲む（閉じ込められたのは${inside}）`,
      obsText: `${c.name} が扉を閉めた瞬間、${bd.name}の外側を白い炎が囲んだ！`,
      kind: 'ability', actor: c, pos: { x: bd.x + bd.w / 2, y: bd.y + bd.h / 2, z: 1.5 }, hint: ab.observedHint,
    });
    for (const x of this.chars) {
      if (x !== c && pointInRect(x.x, x.y, bd) && !x.memory.observed.includes(ab.observedHint)) x.memory.observed.push(ab.observedHint);
    }
  }

  // 解除：開閉できる出口がすべて同時に開いた状態になった時、または錠二が再起不能になった時
  updateSeals() {
    for (const bd of this.world.buildings) {
      if (!bd.sealed) continue;
      const owner = this.chars.find(x => x.id === bd.sealed.by);
      const allOpen = bd.exits.every(id => this.exitOpen(id));
      if (allOpen || !owner || !owner.alive) {
        bd.sealed = null;
        this.emit({ text: `${bd.name}を囲んでいた炎が消えた${allOpen ? '（出口がすべて開いた）' : ''}`, kind: 'ability', pos: { x: bd.x + bd.w / 2, y: bd.y + bd.h / 2, z: 1.5 }, all: true });
      }
    }
  }

  crossesSealedRoom(c, roomBefore) {
    const after = this.roomOf(c);
    return roomBefore !== after && ((roomBefore && roomBefore.sealed) || (after && after.sealed));
  }

  // 線分が、密室の建物の内と外の境目を横切る位置（0..1）。横切らなければ null
  sealedBoundaryBetween(x0, y0, x1, y1) {
    let best = null;
    for (const bd of this.world.buildings) {
      if (!bd.sealed) continue;
      const in0 = pointInRect(x0, y0, bd), in1 = pointInRect(x1, y1, bd);
      if (in0 === in1) continue;
      const r = segRectRange(x0, y0, x1, y1, bd);
      const t = r ? (in0 ? r[1] : r[0]) : 0.5;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  // 炎に触れた：火傷のダメージ（物は燃えない）
  burn(c) {
    if (c.burnCd > this.t) return;
    c.burnCd = this.t + 0.8;
    this.emit({ text: `${c.name} は炎の壁に触れて焼かれた！ 外へは出られない`, kind: 'combat', affected: c, pos: c, hint: ABILITIES.hotel.observedHint });
    this.damage(c, 12, { source: null, kind: 'burn', label: '炎' });
  }

  // 2階から地面へ落下する
  startDrop(c) {
    c.floor = 0;
    c.air = { since: this.t, landAt: this.t + 0.78, profile: 'drop', from: FLOOR_H };
    this.emit({ text: `${c.name} が2階から飛び降りた！`, kind: 'combat', actor: c, pos: { x: c.x, y: c.y, z: FLOOR_H }, sound: 6 });
  }

  separateChars() {
    for (let i = 0; i < this.chars.length; i++) {
      for (let j = i + 1; j < this.chars.length; j++) {
        const a = this.chars[i], b = this.chars[j];
        if (!a.alive || !b.alive || a.floor !== b.floor || this.isAirborne(a) || this.isAirborne(b)) continue;
        const d = dist(a.x, a.y, b.x, b.y);
        const min = a.r + b.r;
        if (d < min && d > 1e-6) {
          const push = (min - d) / 2;
          const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }
  }

  updateObjects(dt) {
    for (const o of this.world.objects.slice()) {
      if (o.launch) { this.updateObjectLaunch(o, dt); continue; }
      if (!o.movable) continue;
      const sp = Math.hypot(o.vx, o.vy);
      if (sp < 0.05) { o.vx = o.vy = 0; continue; }
      const fric = 9 / (o.mass || 1);
      const ns = Math.max(0, sp - fric * dt);
      o.vx *= ns / sp; o.vy *= ns / sp;
      const nx = o.x + o.vx * dt, ny = o.y + o.vy * dt;
      const moved = { ...o, x: nx, y: ny };
      let blocked = null;
      for (const p of this.world.objects) {
        if (p === o || !p.blocksMove || p.floor !== o.floor) continue;
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
        if (!c.alive || c.floor !== o.floor) continue;
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
      if (p.kind === 'ball') {
        if (this.updateBall(p, dt)) keep.push(p);
        continue;
      }
      const x1 = p.x + p.vx * dt, y1 = p.y + p.vy * dt, z1 = p.z + p.vz * dt;
      let hit = null, best = 2;
      // 物体：高さの範囲を通る時だけ当たる
      for (const o of w.objects) {
        if (!o.blocksMove) continue;
        const r = segRectRange(p.x, p.y, x1, y1, o);
        if (!r || r[0] >= best) continue;
        const za = p.z + (z1 - p.z) * r[0], zb = p.z + (z1 - p.z) * r[1];
        if (Math.max(za, zb) < o.z0 || Math.min(za, zb) > o.z1) continue;
        best = r[0]; hit = { type: 'obj', o };
      }
      // 床・天井・地面
      if (z1 <= 0) {
        const t = p.z / (p.z - z1);
        if (t < best) { best = t; hit = { type: 'ground' }; }
      } else if (crossesSlab(w, p.x, p.y, p.z, x1, y1, z1)) {
        if (best > 0.5) { best = 0.5; hit = { type: 'ground' }; }
      }
      // 密室の炎は飛び道具も通さない
      const sealedCross = this.sealedBoundaryBetween(p.x, p.y, x1, y1);
      if (sealedCross !== null && sealedCross < best) { best = sealedCross; hit = { type: 'flame' }; }
      const sb = this.standBlocks(p, x1, y1, this.chars.find(x => x.id === p.owner));
      if (sb && sb.t < best) { best = sb.t; hit = { type: 'stand', c: sb.c }; }
      const ub = this.umbrellaBlocks(p, x1, y1);
      if (ub && ub.t < best) { best = ub.t; hit = { type: 'umbrella', c: ub.c }; }
      for (const c of this.chars) {
        if (!c.alive) continue;
        if (c.id === p.owner && this.t - p.born < 0.3) continue;
        const thrower = this.chars.find(x => x.id === p.owner);
        if (c !== thrower && thrower && c.team === thrower.team) continue; // 味方には当てない
        if (c.launch && c.launch.kind !== 'target') continue;
        const t = segCircle(p.x, p.y, x1, y1, c.x, c.y, c.r);
        if (t === null || t >= best) continue;
        const zz = p.z + (z1 - p.z) * t, bz = this.baseZ(c);
        if (zz < bz - 0.2 || zz > bz + 1.9) continue; // 頭上や足元を通り過ぎる
        best = t; hit = { type: 'char', c };
      }
      if (hit) {
        const hx = p.x + (x1 - p.x) * best, hy = p.y + (y1 - p.y) * best, hz = p.z + (z1 - p.z) * best;
        const owner = this.chars.find(c => c.id === p.owner);
        const sp = Math.hypot(p.vx, p.vy) || 1;
        const dropFloor = hz >= FLOOR_H - 0.1 && upperFloorAt(w, hx, hy) ? 1 : 0;
        const name = p.item.name;
        if (hit.type === 'umbrella') {
          this.emit({ text: `${hit.c.name} の傘が${name}を防いだ！`, kind: 'combat', actor: hit.c, pos: hit.c, sound: 6, soundKind: 'impact' });
          this.landItem(p.item, hit.c.x + Math.cos(hit.c.facing) * 0.8, hit.c.y + Math.sin(hit.c.facing) * 0.8, hit.c.floor, owner, true);
        } else if (hit.type === 'stand') {
          this.standHit(hit.c, p.damage, name, owner);
          this.landItem(p.item, hit.c.standBody.x, hit.c.standBody.y, hit.c.floor, owner, true);
        } else if (hit.type === 'char') {
          if (hit.c.status.invulnUntil > this.t || this.isAirborne(hit.c) && hit.c.air.profile !== 'drop' && hz < this.baseZ(hit.c) - 0.2) { p.x = x1; p.y = y1; p.z = z1; keep.push(p); continue; }
          this.damage(hit.c, p.damage, { source: owner, kind: 'thrown', from: { x: hx - p.vx, y: hy - p.vy }, label: `投げられた${name}` });
          this.landItem(p.item, hit.c.x + (p.vx / sp) * 1.2, hit.c.y + (p.vy / sp) * 1.2, hit.c.floor, owner, true);
        } else if (hit.type === 'obj') {
          this.emit({ text: `${name}が${hit.o.name}に当たった。`, kind: 'env', pos: { x: hx, y: hy, z: hz }, sound: 7, soundKind: 'impact', actor: owner });
          this.damageObject(hit.o, hit.o.kind === 'window' ? 10 : 3, owner);
          this.landItem(p.item, hx - (p.vx / sp) * 0.5, hy - (p.vy / sp) * 0.5, hit.o.floor, owner, true);
        } else if (hit.type === 'flame') {
          this.emit({ text: `${name}が炎の壁に阻まれて落ちた。`, kind: 'env', pos: { x: hx, y: hy, z: hz }, actor: owner });
          this.landItem(p.item, hx - (p.vx / sp) * 0.4, hy - (p.vy / sp) * 0.4, dropFloor, owner, false);
        } else {
          this.landItem(p.item, hx, hy, dropFloor, owner, true);
        }
        continue;
      }
      p.traveled += Math.hypot(x1 - p.x, y1 - p.y);
      p.x = x1; p.y = y1; p.z = z1;
      if (p.traveled > (p.maxRange ?? RULES.throwRange)) {
        this.landItem(p.item, p.x, p.y, p.z >= FLOOR_H && upperFloorAt(w, p.x, p.y) ? 1 : 0, this.chars.find(c => c.id === p.owner), true);
        continue;
      }
      keep.push(p);
    }
    w.projectiles = keep;
  }

  // 投げた物が落ちる。割れ物は何かに当たると割れて大きな音を立てる
  landItem(item, x, y, floor, owner, impact) {
    const def = itemDef(item);
    if (impact && def.breaks) {
      this.emit({ text: `${item.name}が割れた！`, kind: 'env', pos: { x, y, z: floor * FLOOR_H + 0.5, floor }, sound: 12, soundKind: 'glass', actor: owner });
      this.puff('glass', { x, y, z: floor * FLOOR_H + 0.5 });
      return;
    }
    const p = nearestWalkable(this.world, x, y, 2, floor) || { x, y };
    this.world.items.push({ ...item, x: p.x, y: p.y, floor });
  }

  // 物を拾う（持っていた物はその場に置く）
  pickUp(c, item) {
    if (!this.world.items.includes(item)) return false;
    this.world.items = this.world.items.filter(i => i !== item);
    if (c.held) this.dropHeld(c);
    c.held = { id: item.id, kind: item.kind, name: item.name };
    this.emit({ text: `${c.name} が${item.name}を拾った`, kind: 'info', actor: c, pos: c, sound: 3 });
    return true;
  }

  dropHeld(c) {
    if (!c.held) return;
    this.world.items.push({ ...c.held, x: c.x + 0.3, y: c.y + 0.3, floor: c.floor });
    c.held = null;
  }

  // 持った物で殴った時：割れ物は割れる（大きな音）
  breakHeld(c) {
    if (!c.held || !itemDef(c.held).breaks) return;
    this.emit({ text: `${c.held.name}が砕け散った！`, kind: 'env', actor: c, pos: c, sound: 12, soundKind: 'glass' });
    this.puff('glass', { x: c.x + Math.cos(c.facing) * 0.6, y: c.y + Math.sin(c.facing) * 0.6, z: this.baseZ(c) + 1.2 });
    c.held = null;
  }

  // ---------- エコー・ビーチ：音を拾って、運んで、置く ----------

  // 音が鳴った瞬間、近くの個体（または鳴らした人物に取り付いた個体）が拾えば true（その場では鳴らない）
  // actor：その音を立てた人（七海が自分で立てた音は「弱い音」になり、轟音の材料にならない）
  captureSound(pos, radius, kind, text, sourceChar, actor = null) {
    if (radius <= 0) return false;
    // 無音の結界の中で鳴った音は、すべて吸い取られる
    if (this.world.zones.length && this.zoneAt('silence', pos.x, pos.y, pos.floor ?? (sourceChar ? sourceChar.floor : 0))) return true;
    for (const owner of this.chars) {
      if (!owner.units || !owner.alive) continue;
      // 大きな音は、近くに配置された空きの個体が先に引っ張られる
      if (radius >= 9) {
        const z0 = this.zOf(pos);
        const free = owner.units.find(u => u.state === 'deployed' && !u.sound && dist(u.x, u.y, pos.x, pos.y) <= RULES.unitHearRange && Math.abs(u.floor * FLOOR_H - z0) < 2.5);
        if (free) { free.sound = this.makeSound(kind, radius, text, sourceChar, false); this.unitHeard(owner, sourceChar, free); return true; }
      }
      // 取り付いた個体：その人物から出る音を拾い続ける（保持は最後の1音）
      if (sourceChar) {
        const att = owner.units.find(u => u.state === 'attached' && u.attachedTo === sourceChar.id);
        if (att) {
          att.sound = this.makeSound(kind, radius, text, sourceChar, false);
          if (sourceChar !== owner) this.noticeSilence(sourceChar, kind);
          return true;
        }
      }
      // 手元の個体：七海の体のすぐそばで鳴った大きな音（殴られた音など）は、体にいる個体が受け止めて拾う
      if (radius >= 9 && (actor || sourceChar) !== owner && owner.floor === (pos.floor ?? owner.floor) && dist(owner.x, owner.y, pos.x, pos.y) <= 1.2) {
        const home = owner.units.find(u => u.state === 'home' && !u.sound);
        if (home) { home.sound = this.makeSound(kind, radius, text, sourceChar, false); return true; }
      }
      // 配置された個体：1m以内で鳴った音。空いている個体が優先、全員が抱えていれば小さい音を大きい音で上書き
      const z = this.zOf(pos);
      const near = owner.units.filter(u => u.state === 'deployed' && dist(u.x, u.y, pos.x, pos.y) <= RULES.unitHearRange && Math.abs(u.floor * FLOOR_H - z) < 2.5);
      if (!near.length) continue;
      let u = near.find(x => !x.sound);
      if (!u) {
        u = near.reduce((a, x) => (x.sound.radius < a.sound.radius ? x : a));
        if (u.sound.radius >= radius) continue;
      }
      u.sound = this.makeSound(kind, radius, text, sourceChar, false);
      this.unitHeard(owner, sourceChar, u);
      return true;
    }
    return false;
  }

  // 配置した個体のすぐそば（1m以内）で敵が音を立てた：七海にはその敵の居場所が正確に分かる（味方にも伝える）
  unitHeard(owner, src, u) {
    if (!src || src.team === owner.team || !src.alive) return;
    const rec = { id: src.id, name: src.name, x: src.x, y: src.y, floor: src.floor, t: this.t, facing: src.facing, via: `エコー・ビーチ◆${u.n}` };
    for (const c of this.chars) if (c.team === owner.team && c.alive) c.memory.seen[src.id] = { ...rec };
  }

  makeSound(kind, radius, text, who, weak = false) {
    const label = { speech: '声', footsteps: '足音', footsteps_run: '駆ける足音', impact: '衝撃音', crash: '崩れる音', glass: 'ガラスの割れる音', alarm: '防犯アラーム', fall: '倒れる音', door: '扉の音', ricochet: '金属音' }[kind] || '物音';
    return { weak, kind, radius, text: kind === 'speech' ? text : null, from: who ? who.name : null, label: `${who ? `${who.name}の` : ''}${label}`, at: this.t };
  }

  // 大きな音（轟音の材料）。weak は開戦前から抱えている囮用の足音だけ
  isLoud(sound) {
    // 敵の駆ける足音（半径9m）も材料になる：敵の通り道に個体を置いて集める
    return !!sound && !sound.weak && sound.radius >= 9 && sound.kind !== 'speech';
  }

  // 自分の声や足音が消えていることに気づく
  noticeSilence(c, kind) {
    c.memory.silenced = (c.memory.silenced || 0) + (kind === 'speech' ? 3 : 1);
    if (c.memory.silenced >= 3) {
      c.memory.suspectAttached = true;
      const hint = ABILITIES.echo.observedHint;
      if (!c.memory.observed.includes(hint)) c.memory.observed.push(hint);
    }
  }

  // 抱えた音を、個体のいる場所で元の音量のまま鳴らす
  playSound(owner, u) {
    const snd = u.sound;
    if (!snd) return;
    u.sound = null;
    const pos = { x: u.x, y: u.y, z: u.floor * FLOOR_H + 1, floor: u.floor };
    for (const c of this.chars) {
      if (c === owner || !c.alive) continue;
      if (!this.canHear(c, pos.x, pos.y, snd.radius, pos.z)) continue;
      this.recordSound(c, pos, snd.kind, snd.text);
      const text = snd.kind === 'speech' ? `${snd.from ? `${snd.from}の声で` : ''}「${snd.text}」と聞こえた` : `${snd.label}が聞こえた`;
      this.log.push({ t: this.t, text, kind: snd.kind === 'speech' ? 'speech' : 'info', actor: null, visibleTo: new Set([c.id]), heardBy: new Set([c.id]) });
    }
    this.log.push({ t: this.t, text: `（エコー・ビーチ）◆${u.n}が「${snd.label}${snd.text ? `：${snd.text}` : ''}」を置いた`, kind: 'ability', actor: owner.id, visibleTo: new Set([owner.id]), heardBy: new Set() });
  }

  updateUnits(owner, dt) {
    const speed = 10;
    const roar = owner.units.filter(u => u.state === 'roar');
    for (const u of owner.units) {
      if (u.state === 'dead') continue;
      if (!owner.alive) { u.state = 'dead'; continue; }
      if (u.state === 'home') { u.x = owner.x; u.y = owner.y; u.floor = owner.floor; continue; }
      if (u.state === 'attached') {
        const host = this.chars.find(c => c.id === u.attachedTo);
        if (!host || !host.alive) { u.state = 'deployed'; continue; }
        u.x = host.x; u.y = host.y; u.floor = host.floor;
        continue;
      }
      if (u.state === 'deployed') continue;
      // 移動中（move / place / roar / scratch / recall）
      const host = u.target && u.target.char ? u.target.char : null;
      const tx = host ? host.x : u.target.x, ty = host ? host.y : u.target.y;
      const d = dist(u.x, u.y, tx, ty);
      const step = speed * dt;
      if (d > step) {
        u.x += ((tx - u.x) / d) * step;
        u.y += ((ty - u.y) / d) * step;
        // 本体から約50mより遠くへは行けない
        const od = dist(owner.x, owner.y, u.x, u.y);
        if (od > 50) { u.x = owner.x + ((u.x - owner.x) / od) * 50; u.y = owner.y + ((u.y - owner.y) / od) * 50; }
        continue;
      }
      u.x = tx; u.y = ty;
      u.floor = host ? host.floor : (u.target.floor ?? 0);
      if (u.state === 'recall') { u.state = 'home'; continue; }
      if (u.state === 'attach') { u.state = 'attached'; u.attachedTo = host.id; continue; }
      if (u.state === 'place') { this.playSound(owner, u); u.state = 'deployed'; continue; }
      if (u.state === 'move') { u.state = 'deployed'; continue; }
      if (u.state === 'roar' || u.state === 'scratch') u.armed = true;
    }
    // 引っかき：届いた個体の数だけ小さな傷を負わせ、個体はそのまま敵のそばに残る
    const scratch = owner.units.filter(u => u.state === 'scratch');
    if (scratch.length && (scratch.every(u => u.armed) || this.t - scratch[0].since > 3)) {
      const target = scratch[0].target.char;
      const hit = scratch.filter(u => u.armed && u.floor === target.floor && dist(u.x, u.y, target.x, target.y) < 1.5);
      for (const u of scratch) {
        u.state = 'deployed';
        u.armed = false;
        // 敵の足元に散らばる
        const a = (u.n / 24) * Math.PI * 2;
        u.x = target.x + Math.cos(a) * 0.5; u.y = target.y + Math.sin(a) * 0.5;
      }
      if (hit.length && target.alive) {
        this.emit({ text: `『エコー・ビーチ』— ${hit.length}体が${target.name}に群がって引っかいた！`, obsText: `小さな何かが群がって体中を引っかいてくる！`, kind: 'ability', actor: owner, affected: target, pos: target, hint: ABILITIES.echo.observedHint });
        this.damage(target, hit.length * RULES.scratchDamage, { source: owner, kind: 'scratch', label: '小さな爪の引っかき' });
      }
    }
    // 轟音：全員が耳元に着いた（または2秒経った）ら一斉に鳴らす
    if (roar.length && (roar.every(u => u.armed) || this.t - roar[0].since > 2)) {
      const target = roar[0].target.char;
      const ready = roar.filter(u => u.armed && dist(u.x, u.y, target.x, target.y) < 1.5);
      const loud = ready.filter(u => this.isLoud(u.sound)).length;
      for (const u of roar) { u.sound = null; u.armed = false; u.state = 'deployed'; }
      this.roarHit(owner, target, loud);
    }
  }

  roarHit(owner, target, loud) {
    const ab = ABILITIES.echo;
    // 個体が飛んできた方向から、本体のおおよその居場所がばれる（相手とその味方に伝わる）
    const err = 3;
    const guess = { x: clamp(owner.x + (this.rng() - 0.5) * 2 * err, 0.5, this.world.w - 0.5), y: clamp(owner.y + (this.rng() - 0.5) * 2 * err, 0.5, this.world.h - 0.5) };
    for (const o of this.chars) {
      if (o.team === owner.team || !o.alive) continue;
      o.memory.seen[owner.id] = { id: owner.id, name: owner.name, x: guess.x, y: guess.y, floor: owner.floor, t: this.t, facing: owner.facing, via: '轟音の個体が飛んできた方向' };
    }
    this.log.push({ t: this.t, text: `轟音の個体が飛んできた方向から、${owner.name}のおおよその居場所（(${guess.x.toFixed(0)}, ${guess.y.toFixed(0)})付近）の見当がついた`, kind: 'info', actor: null, visibleTo: new Set(this.chars.filter(o => o.team !== owner.team).map(o => o.id)), heardBy: new Set() });
    const pos = { x: target.x, y: target.y, z: this.baseZ(target) + 1.6 };
    this.puff('shock', pos, { big: loud >= 3 });
    this.emit({ text: `『${ab.name}』— ${loud}つの轟音が${target.name}の耳元で一斉に鳴り響いた！`, obsText: `耳元で轟音が一斉に炸裂した！`, kind: 'ability', actor: owner, affected: target, pos, hint: ab.observedHint });
    if (loud >= RULES.roarLoud) {
      target.status.deafUntil = this.t + 10;
      target.status.proneUntil = Math.max(target.status.proneUntil, this.t + 2.5);
      interruptStep(this, target, '轟音で平衡感覚を失った', true);
      this.damage(target, 6 + loud * 3, { source: owner, kind: 'roar', label: '轟音' });
    } else {
      target.status.stunUntil = Math.max(target.status.stunUntil, this.t + 0.4);
      this.emit({ text: '……音が足りない。怯ませただけだ', kind: 'fail', actor: owner });
    }
  }

  // 人物の体やすぐそばにいる個体を払い潰す。潰されると本体の指先に傷が走る
  swatUnits(c) {
    let n = 0;
    for (const owner of this.chars) {
      if (!owner.units || owner.team === c.team) continue;
      for (const u of owner.units) {
        if (u.state === 'dead') continue;
        const onBody = u.state === 'attached' && u.attachedTo === c.id;
        const close = (u.state === 'deployed' || u.state === 'place' || u.state === 'move') && u.floor === c.floor && dist(u.x, u.y, c.x, c.y) <= 1.2;
        if (!onBody && !close) continue;
        u.state = 'dead';
        u.sound = null;
        n++;
        this.damage(owner, 2, { source: c, kind: 'unit', label: `◆${u.n}が潰された痛み` });
      }
    }
    for (const owner of this.chars) {
      if (!owner.mouths || owner.team === c.team) continue;
      const before = owner.mouths.length;
      // 背中など手の届きにくい所の口は、払っても半分ほどしか落とせない
      owner.mouths = owner.mouths.filter(m => !((m.on === c.id && this.rng() < 0.5) || (!m.on && m.floor === c.floor && dist(m.x, m.y, c.x, c.y) <= 1.2)));
      n += before - owner.mouths.length;
      const car = owner.standBody;
      if (car && car.floor === c.floor && dist(car.x, car.y, c.x, c.y) <= 1.5) {
        owner.standBody = null;
        n++;
        this.emit({ text: `${c.name} が足元を走り回る小さな車両を叩き落とした！`, kind: 'combat', actor: c, affected: owner, pos: car, sound: 6, soundKind: 'impact' });
        this.damage(owner, 10, { source: c, kind: 'stand', label: '車両が受けた衝撃の反動' });
      }
    }
    c.memory.suspectAttached = false;
    c.memory.silenced = 0;
    return n;
  }

  // ---------- リトル・レッド・コルベット：口の複製 ----------

  // 車両の通った跡（10秒）と、体の上を走った人（3秒）を覚える
  trackCar(c, s) {
    const last = c.carTrail[c.carTrail.length - 1];
    if (!last || dist(last.x, last.y, s.x, s.y) > 0.3) c.carTrail.push({ x: s.x, y: s.y, floor: s.floor, t: this.t });
    if (c.carTrail.length > 400 || (c.carTrail[0] && this.t - c.carTrail[0].t > 10)) c.carTrail = c.carTrail.filter(p => this.t - p.t <= 10);
    for (const o of this.chars) {
      if (!o.alive || o === c || o.floor !== s.floor || dist(o.x, o.y, s.x, s.y) > 0.7) continue;
      c.carTouch[o.id] = this.t;
      // 車両が人の体に乗り上げた手応えで、おおまかな位置が分かる
      if (o.team !== c.team) {
        const rec = { id: o.id, name: o.name, x: s.x, y: s.y, floor: s.floor, t: this.t, facing: o.facing, via: '車両の手応え' };
        c.memory.seen[o.id] = rec;
        for (const a of this.alliesOf(c)) if (a.alive) a.memory.seen[o.id] = { ...rec, via: `${c.name}の車両` };
      }
    }
  }

  // 口の今の位置（人に付いた口はその人と一緒に動く）
  mouthSpots(c) {
    return (c.mouths || []).map(m => {
      if (!m.on) return m;
      const o = this.chars.find(x => x.id === m.on);
      if (o) { m.x = o.x; m.y = o.y; m.floor = o.floor; }
      return m;
    });
  }

  noticeMouth(e, m) {
    e.memory.suspectAttached = true;
    m.known = true;
    const hint = ABILITIES.corvette.observedHint;
    if (!e.memory.observed.includes(hint)) e.memory.observed.push(hint);
  }

  releaseClench(c, why) {
    if (!c.clench) return;
    c.clench = null;
    for (const m of c.mouths || []) m.biting = null;
    this.emit({ text: `${c.name} の食いしばりが外れた${why ? `（${why}）` : ''}`, kind: 'fail', actor: c });
  }

  // 食いしばり・あくび・口を押さえられる
  updateMouths(c, dt) {
    const s = c.status;
    if (!c.mouths.length) { if (c.clench) c.clench = null; return; }
    // 組み付かれて口を押さえられると、能力全体が止まる
    if (s.grabbedUntil > this.t) { if (c.clench) this.releaseClench(c, '口を押さえられた'); return; }
    if (c.clench && (this.t >= c.clench.until || s.proneUntil > this.t + 0.5)) this.releaseClench(c, this.t >= c.clench.until ? '' : '倒れて歯が離れた');
    if (c.clench) {
      for (const m of this.mouthSpots(c)) {
        if (m.on === c.id) continue;
        const foe = m.on ? this.chars.find(x => x.id === m.on && x.team !== c.team) : this.enemiesOf(c).find(e => e.alive && e.floor === m.floor && !this.isAirborne(e) && dist(e.x, e.y, m.x, m.y) <= (m.biting === e.id ? 1.3 : 0.8));
        if (!foe || !foe.alive) { m.biting = null; continue; }
        if (m.biting !== foe.id) {
          m.biting = foe.id; m.nextBite = this.t + 1;
          this.noticeMouth(foe, m);
          this.emit({ text: `${m.on ? `${foe.name}の体の口` : `${m.name}の口`}が${foe.name}${m.on ? 'に' : 'の足首に'}噛みついた！`, obsText: `${foe.name} の${m.on ? '背中' : '足首'}に、どこからか現れた口が噛みついている！`, kind: 'combat', actor: c, affected: foe, pos: foe, sound: 4, soundKind: 'impact', hint: ABILITIES.corvette.observedHint });
          this.damage(foe, 5, { source: c, kind: 'bite', label: '噛みつき' });
        } else if (this.t >= m.nextBite) {
          m.nextBite = this.t + 1;
          this.damage(foe, 3, { source: c, kind: 'bite', label: '噛みつき（食いしばり）' });
        }
        const prev = foe.status.bittenUntil > this.t ? foe.status.bittenSlow : 1;
        foe.status.bittenUntil = this.t + 0.15;
        foe.status.bittenSlow = Math.min(prev, m.on ? 0.65 : 0.3);
      }
    } else if (this.rng() < dt / 70) {
      // うっかりあくび：全部の口が同じ動きをして、居場所がばれる
      this.emit({ text: `${c.name} はうっかりあくびをした。${c.mouths.length}個の口が一斉に「ふぁ……」`, kind: 'fail', actor: c });
      this.noise(c, 6, 'speech');
      for (const m of this.mouthSpots(c)) {
        m.revealedUntil = this.t + 3;
        for (const e of this.enemiesOf(c)) {
          if (!e.alive) continue;
          if (m.on === e.id || this.canHear(e, m.x, m.y, 6, (m.floor ?? 0) * FLOOR_H + 1)) {
            this.recordSound(e, { x: m.x, y: m.y, floor: m.floor }, 'speech', 'ふぁ……');
            if (m.on === e.id) this.noticeMouth(e, m);
          }
        }
      }
    }
  }

  // ---------- セブンス・サン：跳弾 ----------

  // 1つの面に当たった時の法線の向き（'x' なら左右の面、'y' なら上下の面）
  static hitAxis(x0, y0, dx, dy, r) {
    const tx = dx ? Math.min((r.x - x0) / dx, (r.x + r.w - x0) / dx) : -Infinity;
    const ty = dy ? Math.min((r.y - y0) / dy, (r.y + r.h - y0) / dy) : -Infinity;
    return tx > ty ? 'x' : 'y';
  }

  // 静止した地形だけで弾道をたどる（狙いの計算用）。cb(segment, bounces) で各区間を返す
  traceBall(x, y, z, floor, dx, dy, maxDist, cb) {
    let traveled = 0, bounces = 0;
    const solids = this.world.objects.filter(o => o.blocksMove && o.floor === floor && z >= o.z0 && z <= o.z1 && o.kind !== 'window');
    while (traveled < maxDist && bounces <= 7) {
      const rem = maxDist - traveled;
      const x1 = x + dx * rem, y1 = y + dy * rem;
      let best = null, bt = 2;
      for (const o of solids) {
        const r = segRectRange(x, y, x1, y1, o);
        if (r && r[0] > 1e-6 && r[0] < bt) { bt = r[0]; best = o; }
      }
      const t = best ? bt : 1;
      const hx = x + (x1 - x) * t, hy = y + (y1 - y) * t;
      if (cb({ x0: x, y0: y, x1: hx, y1: hy }, bounces) === false) return;
      traveled += rem * t;
      if (!best || best.kind === 'bush' || best.kind === 'tree') return;
      const axis = Battle.hitAxis(x, y, dx, dy, best);
      if (axis === 'x') dx = -dx; else dy = -dy;
      x = hx + dx * 0.02; y = hy + dy * 0.02;
      bounces++;
    }
  }

  spawnBall(owner, angle, from = owner) {
    const z = this.baseZ(owner) + 1.3;
    const p = {
      id: `ball_${++projSeq}`, kind: 'ball', owner: owner.id,
      x: from.x + Math.cos(angle) * 0.5, y: from.y + Math.sin(angle) * 0.5, z, floor: owner.floor,
      vx: Math.cos(angle) * 45, vy: Math.sin(angle) * 45, vz: 0,
      traveled: 0, bounces: 0, final: false, born: this.t, hit: new Set(),
    };
    this.world.projectiles.push(p);
    return p;
  }

  ballDamage(bounces) {
    return [4, 9, 15, 22, 28, 34, 34, 34][Math.min(7, bounces)];
  }

  // 1ステップ分の弾の運動。残すなら true
  updateBall(p, dt) {
    const sp = Math.hypot(p.vx, p.vy);
    let rem = sp * dt;
    const owner = this.chars.find(c => c.id === p.owner);
    for (let guard = 0; guard < 6 && rem > 1e-6; guard++) {
      const dx = p.vx / sp, dy = p.vy / sp;
      const x1 = p.x + dx * rem, y1 = p.y + dy * rem;
      let hit = null, bt = 2;
      for (const o of this.world.objects) {
        if (!o.blocksMove || o.floor !== p.floor || p.z < o.z0 || p.z > o.z1) continue;
        const r = segRectRange(p.x, p.y, x1, y1, o);
        if (r && r[0] > 1e-6 && r[0] < bt) { bt = r[0]; hit = { o }; }
      }
      const fl = this.sealedBoundaryBetween(p.x, p.y, x1, y1);
      if (fl !== null && fl < bt) { bt = fl; hit = { flame: true }; }
      const ub = this.umbrellaBlocks(p, x1, y1);
      if (ub && ub.t < bt) { bt = ub.t; hit = { umbrella: ub.c }; }
      const sb = this.standBlocks(p, x1, y1, owner);
      if (sb && sb.t < bt && !p.hit.has(`stand_${sb.c.id}`)) { bt = sb.t; hit = { stand: sb.c }; }
      for (const c of this.chars) {
        if (!c.alive || p.hit.has(c.id) || c.floor !== p.floor) continue;
        if (c !== owner && owner && c.team === owner.team) continue; // 味方には当てない
        if (c === owner && p.bounces === 0 && this.t - p.born < 0.2) continue;
        if (this.isAirborne(c) || (c.launch && c.launch.kind !== 'target')) continue;
        const t = segCircle(p.x, p.y, x1, y1, c.x, c.y, c.r);
        if (t !== null && t < bt) { bt = t; hit = { c }; }
      }
      if (!hit) {
        p.x = x1; p.y = y1;
        p.traveled += rem;
        break;
      }
      const hx = p.x + (x1 - p.x) * bt, hy = p.y + (y1 - p.y) * bt;
      p.traveled += rem * bt;
      rem -= rem * bt;
      if (hit.umbrella) {
        this.emit({ text: `${hit.umbrella.name} の傘が弾を防いだ！`, kind: 'combat', actor: hit.umbrella, pos: hit.umbrella, sound: 6, soundKind: 'ricochet' });
        return false;
      }
      if (hit.stand) {
        p.hit.add(`stand_${hit.stand.id}`);
        this.standHit(hit.stand, this.ballDamage(p.bounces), `${p.bounces}回跳ねた弾`, owner);
        // 5回以上跳ねた弾はスタンドも貫通する
        if (p.bounces >= 5 && !p.final) { p.x = hx + dx * 0.5; p.y = hy + dy * 0.5; continue; }
        return false;
      }
      if (hit.flame) {
        this.emit({ text: '弾が炎の壁に阻まれて落ちた。', kind: 'env', actor: owner, pos: { x: hx, y: hy, z: p.z } });
        return false;
      }
      if (hit.c) {
        const dmg = this.ballDamage(p.bounces);
        p.hit.add(hit.c.id);
        const tier = p.bounces >= 5 ? '（貫通）' : p.bounces >= 3 ? '（骨折級）' : p.bounces >= 2 ? '（骨にひび）' : p.bounces >= 1 ? '（打撲）' : '';
        this.damage(hit.c, dmg, { source: owner, kind: 'ball', from: { x: hx - dx, y: hy - dy }, label: `${p.bounces}回跳ねた弾${tier}` });
        // 5回以上跳ねた弾は人体を貫通して進む。7回後の弾はこれで消える
        if (p.bounces >= 5 && !p.final) { p.x = hx + dx * 0.9; p.y = hy + dy * 0.9; continue; }
        return false;
      }
      const o = hit.o;
      if (p.final) {
        // 7回反射した後は、次に当たった物を貫通して消える
        this.damageObject(o, 30, owner);
        this.emit({ text: `7回跳ねた弾が${o.name}を撃ち抜いて消えた`, kind: 'env', actor: owner, pos: { x: hx, y: hy, z: p.z, floor: p.floor }, sound: 8, soundKind: 'ricochet' });
        return false;
      }
      if (o.kind === 'bush' || o.kind === 'tree') return false; // 柔らかい物で止まる
      if (o.kind === 'window') {
        // ガラスは割って抜ける
        this.damageObject(o, 20, owner);
        p.x = hx + dx * 0.05; p.y = hy + dy * 0.05;
        continue;
      }
      const axis = Battle.hitAxis(p.x, p.y, dx, dy, o);
      if (axis === 'x') p.vx = -p.vx; else p.vy = -p.vy;
      p.bounces++;
      if (p.bounces >= 7) p.final = true;
      p.x = hx + (p.vx / sp) * 0.02; p.y = hy + (p.vy / sp) * 0.02;
      this.fx.push({ kind: 'spark', x: hx, y: hy, z: p.z, t: this.t, text: String(p.bounces), visibleTo: this.visibleSet({ x: hx, y: hy, z: p.z }) });
      this.noise({ x: hx, y: hy, floor: p.floor, z: p.z }, 8, 'ricochet');
    }
    return p.traveled < 100;
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

  // f：目的地の階（省略時は今いる階）。階段を経由する経路を返す
  path(c, x, y, f = c.floor) {
    return findPath(this.world, c.x, c.y, x, y, c.floor, f);
  }
}
