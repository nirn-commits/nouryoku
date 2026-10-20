// 行動計画：AI/解析器が出した「生の計画」を検証して実行可能な形に変換し、時間経過に沿って実行する
import { ACTIONS, ABILITIES, CONDITIONS, DIRECTIONS, RULES } from './data.js';
import { dist, angleTo, angDiff, clamp, nearestPointOnRect, distToRect, rectCenter } from './vec.js';
import { nearestWalkable, hasLOS, isWalkablePoint } from './world.js';
import { applyAbility } from './abilities.js';

const DEFAULT_TARGET = {
  move: 'enemy', chase: 'enemy', melee: 'enemy', throw: 'enemy', guard: 'enemy', dodge: 'direction',
  push: 'object', pull: 'object', look: 'enemy', wait: 'none', ability: 'enemy',
};

const DIR_LABEL = {
  toward_enemy: '敵の方向', away_from_enemy: '敵から離れる方向', left: '左', right: '右', up: '上（奥）',
  down: '下（手前）', up_left: '左上（北西）', up_right: '右上（北東）', down_left: '左下（南西）', down_right: '右下（南東）', forward: '前方', back: '後方', cover: '物陰',
};

const str = v => (typeof v === 'string' ? v.trim() : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- 検証・変換 ----------

function targetName(b, t) {
  if (t.type === 'enemy') return '敵';
  if (t.type === 'self') return '自分';
  if (t.type === 'point') return `地点(${t.x.toFixed(1)}, ${t.y.toFixed(1)})`;
  if (t.type === 'direction') return DIR_LABEL[t.dir] || t.dir;
  if (t.type === 'projectile') return '飛来物';
  if (t.type === 'object') {
    const o = b.objectById(t.id);
    if (o) return o.name;
    const bd = b.world.buildings.find(x => x.id === t.id);
    if (bd) return bd.name;
    const door = b.world.buildings.flatMap(x => x.doors).find(d => d.id === t.id);
    if (door) return door.name;
    const area = b.world.areas.find(a => a.id === t.id);
    return area ? area.name : t.id;
  }
  return '';
}

export function describeStep(b, s) {
  const tn = targetName(b, s.target);
  const cond = s.condition ? `［${condLabel(s.condition)}］` : '';
  switch (s.action) {
    case 'move': return `${cond}${tn}へ${s.mode === 'run' ? '走る' : '歩く'}`;
    case 'chase': return `${cond}敵を${s.mode === 'run' ? '走って' : '歩いて'}追尾（最大${s.duration.toFixed(0)}秒${s.distance ? `・距離${s.distance}m` : ''}）`;
    case 'melee': return `${cond}${tn}を殴る`;
    case 'throw': return `${cond}${tn}へナイフを投げる`;
    case 'guard': return `${cond}ガード（${s.duration.toFixed(1)}秒）`;
    case 'dodge': return `${cond}${tn}へ回避`;
    case 'push': return `${cond}${tn}を押す`;
    case 'pull': return `${cond}${tn}を引く`;
    case 'look': return `${cond}${tn}を観察`;
    case 'wait': return `${cond}待機${s.duration ? `（${s.duration.toFixed(1)}秒）` : ''}`;
    case 'ability': {
      const ab = ABILITIES[s.ability];
      return `${cond}『${ab.name}：${ab.effects[s.effect].name}』→${tn}`;
    }
    default: return s.action;
  }
}

function condLabel(c) {
  return CONDITIONS[c.kind].replace('value', c.value ?? '');
}

function resolveObjectId(b, id) {
  if (!id) return null;
  if (b.objectById(id)) return id;
  if (b.world.buildings.some(x => x.id === id)) return id;
  if (b.world.buildings.some(x => x.doors.some(d => d.id === id))) return id;
  if (b.world.areas.some(a => a.id === id)) return id;
  return null;
}

function validateStep(b, c, raw, cursor) {
  const action = str(raw.action);
  if (!ACTIONS[action]) return { error: `不明な行動「${action || '（空）'}」は実行できない` };
  let ttype = str(raw.targetType) || DEFAULT_TARGET[action];
  if (ttype === 'none' && action !== 'wait' && action !== 'guard') ttype = DEFAULT_TARGET[action];
  const mode = raw.mode === 'run' || raw.mode === 'walk' ? raw.mode : action === 'chase' ? 'run' : 'walk';
  const step = { action, mode, target: { type: ttype }, raw };

  // 能力の照合：存在しない能力・他人の能力は許可しない
  if (action === 'ability') {
    const abId = str(raw.ability);
    if (!ABILITIES[abId]) return { error: `能力「${abId || '（未指定）'}」はこのゲームに存在しない` };
    if (!c.def.abilities.includes(abId)) return { error: `『${ABILITIES[abId].name}』は${c.name}の能力ではない` };
    const ab = ABILITIES[abId];
    let effect = str(raw.effect);
    if (!ab.effects[effect]) {
      effect = Object.keys(ab.effects).find(k => ab.effects[k].targets.includes(ttype));
      if (!effect) return { error: `『${ab.name}』は「${ttype}」を対象にできない` };
    }
    if (!ab.effects[effect].targets.includes(ttype)) {
      return { error: `『${ab.name}：${ab.effects[effect].name}』は「${ttype}」を対象にできない（対象：${ab.effects[effect].targets.join('/')}）` };
    }
    step.ability = abId;
    step.effect = effect;
  } else if (!ACTIONS[action].targets.includes(ttype)) {
    return { error: `${ACTIONS[action].name}は「${ttype}」を対象にできない` };
  }

  const t = step.target;
  if (ttype === 'object') {
    const id = resolveObjectId(b, str(raw.targetId));
    if (!id) return { error: `対象「${str(raw.targetId) || '（未指定）'}」は戦場に存在しない` };
    t.id = id;
    const o = b.objectById(id);
    if ((action === 'push' || action === 'pull') && (!o || !o.movable)) return { error: `${targetName(b, t)}は動かせない` };
    if (action === 'ability') {
      if (step.ability === 'masonry' && (!o || o.kind !== 'wall')) return { error: `『壁面変形』の対象は壁のみ（${targetName(b, t)}は不可）` };
      if (step.effect === 'breach' && o.indestructible) return { error: `${o.name}は崩せない（外壁）` };
      if (step.ability === 'friction' && (!o || !o.movable)) return { error: `『摩擦操作』で物体を対象にできるのは動かせる物（木箱・机）のみ` };
      if (step.ability === 'vector' && (!o || !o.movable)) return { error: `『ベクトル反転』で弾けるのは動かせる物のみ` };
      if (step.ability === 'perpendicular' && step.effect === 'launch') {
        if (!o || !o.movable) return { error: `『パーペンディキュラー』で弾き出せるのは動かせる物のみ（${targetName(b, t)}は不可）` };
        if ((o.kg ?? 0) > 100) return { error: `${o.name}は重すぎて弾き出せない（約${o.kg}kg、上限100kg）` };
      }
      if (step.ability === 'perpendicular' && step.effect === 'self_launch' && (!o || !o.blocksMove)) {
        return { error: `${targetName(b, t)}は足場にできる面ではない` };
      }
    }
  } else if (ttype === 'point') {
    const x = num(raw.x), y = num(raw.y);
    if (x === null || y === null) return { error: '地点の座標が指定されていない' };
    if (x < 0 || y < 0 || x > b.world.w || y > b.world.h) return { error: `地点(${x}, ${y})は戦場の外` };
    t.x = x; t.y = y;
  } else if (ttype === 'direction') {
    t.dir = DIRECTIONS.includes(raw.direction) ? raw.direction : (action === 'dodge' ? 'away_from_enemy' : 'toward_enemy');
  } else if (ttype === 'projectile') {
    t.id = str(raw.targetId) || null;
  }
  if (DIRECTIONS.includes(raw.direction)) step.aim = raw.direction;
  step.distance = num(raw.distance) !== null ? clamp(raw.distance, 0.5, 15) : null;

  const d = num(raw.duration);
  if (action === 'guard') step.duration = clamp(d ?? 1.5, 0.3, 3);
  else if (action === 'chase') step.duration = clamp(d ?? 4, 0.5, 8);
  else if (action === 'wait') step.duration = clamp(d ?? (raw.condition ? 0 : 1), 0, 6);
  else step.duration = 0;

  if (raw.condition && typeof raw.condition === 'object' && raw.condition.kind) {
    const kind = str(raw.condition.kind);
    if (!CONDITIONS[kind]) return { error: `条件「${kind}」は判定できない` };
    step.condition = {
      kind,
      value: num(raw.condition.value) ?? (kind === 'enemy_within' ? 4 : kind === 'hp_below' ? 40 : null),
      timeout: clamp(num(raw.condition.timeout) ?? RULES.conditionTimeoutDefault, 0.5, RULES.conditionTimeoutMax),
    };
  }
  step.est = estimateCost(b, c, step, cursor);
  step.label = describeStep(b, step);
  return { step };
}

// cursor は「前の手順を終えた時点の想定位置」。移動手順の後はその目的地から見積もる
function estimateCost(b, c, s, cursor) {
  const speed = s.mode === 'run' ? c.def.run : c.def.walk;
  let cost = 0;
  const from = cursor || c;
  const approxDist = () => {
    const r = resolveTarget(b, c, s.target, s);
    if (r.error) return 6;
    if (s.target.type === 'direction') return s.distance ?? 5;
    const d = dist(from.x, from.y, r.x, r.y);
    if (s.target.type === 'enemy' && s.action === 'move') return Math.max(0, d - (s.distance ?? 1.3));
    return d;
  };
  switch (s.action) {
    case 'move': cost = Math.max(0.3, (approxDist() * 1.25) / speed); break;
    case 'chase': cost = s.duration; break;
    case 'melee': cost = 0.8 + clamp((approxDist() - 1.5) / c.def.run, 0, 2.5); break;
    case 'throw': cost = RULES.throwWindup + RULES.throwRecovery + 0.1; break;
    case 'guard': cost = s.duration; break;
    case 'dodge': cost = 0.4; break;
    case 'push': case 'pull': cost = 0.6 + clamp((approxDist() - 1) / c.def.walk, 0, 3); break;
    case 'look': cost = 0.6; break;
    case 'wait': cost = s.duration; break;
    case 'ability': cost = ABILITIES[s.ability].castTime + 0.25; break;
  }
  if (s.condition) cost += Math.min(s.condition.timeout, 3);
  return cost;
}

// 生の計画 → 実行可能な計画。行動予算を超えた分は切り捨てる
export function compilePlan(b, c, raw, source = 'local') {
  raw = raw && typeof raw === 'object' ? raw : {};
  const plan = {
    source,
    interpretation: str(raw.interpretation).slice(0, 200),
    speech: str(raw.speech).replace(/^「|」$/g, '').slice(0, 80) || null,
    steps: [],
    rejected: (Array.isArray(raw.rejected) ? raw.rejected : []).map(x => String(x).slice(0, 120)).slice(0, 5),
    truncated: [],
    budget: 0,
  };
  const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 12) : [];
  let cursor = { x: c.x, y: c.y };
  for (const s of steps) {
    const r = validateStep(b, c, s || {}, cursor);
    if (r.error) { plan.rejected.push(r.error); continue; }
    const step = r.step;
    const remaining = RULES.budgetSeconds - plan.budget;
    if (plan.steps.length >= RULES.maxSteps || remaining < 0.3) { plan.truncated.push(step.label); continue; }
    if (step.est > remaining) {
      if (step.action === 'move' || step.action === 'wait' || step.action === 'guard' || step.action === 'chase') {
        // 移動・待機は予算の範囲で打ち切る
        step.maxTime = remaining;
        step.est = remaining;
        if (step.duration) step.duration = Math.min(step.duration, remaining);
        step.label += '（予算内で打ち切り）';
      } else {
        plan.truncated.push(step.label);
        continue;
      }
    }
    plan.budget += step.est;
    plan.steps.push(step);
    if (step.action === 'move' && step.target.type !== 'direction') {
      const res = resolveTarget(b, c, step.target, step);
      if (!res.error) cursor = { x: res.x, y: res.y };
    }
  }
  return plan;
}

// ---------- 対象の解決（実行時。知覚している情報だけを使う） ----------

function dirVector(b, c, dir) {
  const pe = b.perceivedEnemy(c);
  const toward = pe ? angleTo(c.x, c.y, pe.x, pe.y) : c.facing;
  switch (dir) {
    case 'toward_enemy': return toward;
    case 'away_from_enemy': return toward + Math.PI;
    case 'left': return Math.PI;
    case 'right': return 0;
    case 'up': return -Math.PI / 2;
    case 'down': return Math.PI / 2;
    case 'up_left': return -Math.PI * 0.75;
    case 'up_right': return -Math.PI / 4;
    case 'down_left': return Math.PI * 0.75;
    case 'down_right': return Math.PI / 4;
    case 'forward': return c.facing;
    case 'back': return c.facing + Math.PI;
    default: return toward;
  }
}

export function findCover(b, c) {
  const pe = b.perceivedEnemy(c);
  const heard = c.memory.heard[c.memory.heard.length - 1];
  const threat = pe || heard || { x: b.world.w / 2, y: b.world.h / 2 };
  let best = null;
  for (const o of b.world.objects) {
    if (!o.blocksSight || o.indestructible) continue;
    if (distToRect(c.x, c.y, o) > 12) continue;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const cc = rectCenter(o);
      const rx = o.w / 2 + 0.75, ry = o.h / 2 + 0.75;
      const px = cc.x + Math.cos(a) * rx, py = cc.y + Math.sin(a) * ry;
      if (!isWalkablePoint(b.world, px, py)) continue;
      if (hasLOS(b.world, threat.x, threat.y, px, py)) continue;
      const score = dist(c.x, c.y, px, py) - dist(threat.x, threat.y, px, py) * 0.3;
      if (!best || score < best.score) best = { x: px, y: py, score, obj: o };
    }
  }
  return best;
}

export function resolveTarget(b, c, t, step = {}) {
  switch (t.type) {
    case 'enemy': {
      const pe = b.perceivedEnemy(c);
      if (pe) return { x: pe.x, y: pe.y, char: pe.visible ? pe.char : null, visible: pe.visible };
      // 姿を見ていなければ、直近に聞こえた物音の位置を推定位置として使う
      const h = [...c.memory.heard].reverse().find(x => b.t - x.t < 10);
      if (h) return { x: h.x, y: h.y, char: null, visible: false, guess: true };
      return { error: '敵の位置が分からない（姿も物音も捉えていない）' };
    }
    case 'self':
    case 'none':
      return { x: c.x, y: c.y, self: true };
    case 'point':
      return { x: t.x, y: t.y };
    case 'direction': {
      if (t.dir === 'cover') {
        const cv = findCover(b, c);
        if (cv) return { x: cv.x, y: cv.y };
      }
      const a = dirVector(b, c, t.dir === 'cover' ? 'away_from_enemy' : t.dir);
      const d = step.distance ?? (step.action === 'dodge' ? RULES.dodgeDistance : 5);
      return {
        x: clamp(c.x + Math.cos(a) * d, 0.8, b.world.w - 0.8),
        y: clamp(c.y + Math.sin(a) * d, 0.8, b.world.h - 0.8),
        angle: a,
      };
    }
    case 'object': {
      const o = b.objectById(t.id);
      if (o) {
        const n = nearestPointOnRect(c.x, c.y, o);
        return { x: n.x, y: n.y, obj: o, center: rectCenter(o) };
      }
      const bd = b.world.buildings.find(x => x.id === t.id);
      if (bd) {
        const p = nearestWalkable(b.world, bd.x + bd.w / 2, bd.y + bd.h / 2 + 1, 3) || { x: bd.x + bd.w / 2, y: bd.y + bd.h / 2 };
        return { x: p.x, y: p.y, building: bd };
      }
      const door = b.world.buildings.flatMap(x => x.doors).find(d => d.id === t.id);
      if (door) return { x: door.x, y: door.y, door };
      const area = b.world.areas.find(a => a.id === t.id);
      if (area) {
        // 区域：中心付近の歩ける場所（自分が既に中にいれば今の場所）
        if (c.x >= area.x && c.x <= area.x + area.w && c.y >= area.y && c.y <= area.y + area.h) return { x: c.x, y: c.y, area };
        const p = nearestWalkable(b.world, area.x + area.w / 2, area.y + area.h / 2, 5) || { x: area.x + area.w / 2, y: area.y + area.h / 2 };
        return { x: p.x, y: p.y, area };
      }
      return { error: '対象が既に存在しない' };
    }
    case 'projectile': {
      const list = b.world.projectiles.filter(p => p.owner !== c.id && b.canSee(c, p.x, p.y) || (p.owner !== c.id && dist(c.x, c.y, p.x, p.y) < 2));
      let best = t.id ? list.find(p => p.id === t.id) : null;
      if (!best) {
        for (const p of list) if (!best || dist(c.x, c.y, p.x, p.y) < dist(c.x, c.y, best.x, best.y)) best = p;
      }
      if (!best) return { error: '近くに飛来物が見当たらない' };
      return { x: best.x, y: best.y, projectile: best };
    }
  }
  return { error: '対象が不明' };
}

// ---------- 条件判定（本人の知覚に基づく） ----------

function projectileIncoming(b, c) {
  return b.world.projectiles.some(p => {
    if (p.owner === c.id) return false;
    const d = dist(c.x, c.y, p.x, p.y);
    if (d > 8 || !b.canSee(c, p.x, p.y)) return false;
    const sp = Math.hypot(p.vx, p.vy);
    const tx = c.x - p.x, ty = c.y - p.y;
    const along = (tx * p.vx + ty * p.vy) / sp;
    if (along <= 0) return false;
    const perp = Math.abs(tx * p.vy - ty * p.vx) / sp;
    return perp < 1.3;
  });
}

function checkCondition(b, c, cond, st) {
  const pe = b.perceivedEnemy(c);
  const visible = pe && pe.visible;
  switch (cond.kind) {
    case 'enemy_within': return visible && dist(c.x, c.y, pe.x, pe.y) <= (cond.value ?? 4);
    case 'enemy_visible': return !!visible;
    case 'enemy_not_visible': return !visible;
    case 'projectile_incoming': return projectileIncoming(b, c);
    case 'enemy_attacking': return visible && pe.char.windup && dist(c.x, c.y, pe.x, pe.y) < 6;
    case 'hp_below': return c.hp <= (cond.value ?? 40);
    case 'damaged': return c.lastDamagedAt > st.t0;
  }
  return false;
}

// ---------- 実行 ----------

function selfLog(b, c, text, kind = 'plan') {
  b.emit({ text, kind, actor: c });
}

function faceTo(c, x, y) {
  c.desired.face = angleTo(c.x, c.y, x, y);
}

function facingOk(c, x, y, tol = 0.35) {
  return Math.abs(angDiff(c.facing, angleTo(c.x, c.y, x, y))) < tol;
}

// 経路に沿って目標へ向かう。'arrived' | 'moving' | 'stuck'
function approach(b, c, st, tx, ty, stopDist, run) {
  const D = st.data;
  const d = dist(c.x, c.y, tx, ty);
  if (d <= stopDist) return 'arrived';
  const needPath = !D.path || D.repathAt <= b.t || dist(D.goalX, D.goalY, tx, ty) > 1 || b.world.navDirty;
  if (needPath) {
    const p = b.path(c, tx, ty);
    D.repathAt = b.t + 0.7;
    D.goalX = tx; D.goalY = ty;
    if (!p || !p.points.length) return 'stuck';
    D.path = p.points;
    if (p.partial && !D.partialNoted) {
      D.partialNoted = true;
      D.partial = true;
      selfLog(b, c, '目的地まで通れる経路がない。可能な限り近づく', 'fail');
    }
  }
  while (D.path.length && dist(c.x, c.y, D.path[0].x, D.path[0].y) < 0.3) D.path.shift();
  if (!D.path.length) return D.partial ? 'stuck' : 'arrived';
  const wp = D.path[0];
  const a = angleTo(c.x, c.y, wp.x, wp.y);
  let speed = run ? c.def.run : c.def.walk;
  speed = Math.min(speed, (d - stopDist) * 3 + 0.6); // 減速
  c.desired.vx = Math.cos(a) * speed;
  c.desired.vy = Math.sin(a) * speed;

  // 引っかかり検出
  if (!D.lastPos || b.t - D.lastPos.t > 1) {
    if (D.lastPos && dist(D.lastPos.x, D.lastPos.y, c.x, c.y) < 0.15) {
      D.stuckCount = (D.stuckCount || 0) + 1;
      D.path = null;
      if (D.stuckCount >= 3) return 'stuck';
    }
    D.lastPos = { x: c.x, y: c.y, t: b.t };
  }
  return 'moving';
}

function moveGoal(b, c, st, res) {
  const s = st.def;
  if (res.obj && !res.obj.blocksMove) {
    // 植え込みなど通れる物体は、その中に入る
    return { x: res.center.x, y: res.center.y, stop: 0.3 };
  }
  if (res.obj) {
    // 物体のそば（自分のいる側）
    const n = nearestPointOnRect(c.x, c.y, res.obj);
    const cc = res.center;
    let nx = n.x - cc.x, ny = n.y - cc.y;
    const l = Math.hypot(nx, ny) || 1;
    const p = nearestWalkable(b.world, n.x + (nx / l) * 0.7, n.y + (ny / l) * 0.7, 2.5);
    return { x: p ? p.x : n.x, y: p ? p.y : n.y, stop: 0.35 };
  }
  if (s.target.type === 'enemy') return { x: res.x, y: res.y, stop: s.distance ?? 1.3 };
  const p = nearestWalkable(b.world, res.x, res.y, 3) || res;
  return { x: p.x, y: p.y, stop: 0.3 };
}

const EXEC = {
  move: {
    start(b, c, st) {
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      st.data.goal = moveGoal(b, c, st, res);
      st.data.deadline = b.t + (st.def.maxTime ?? Math.max(4, st.def.est * 2 + 2));
      return null;
    },
    update(b, c, st) {
      const s = st.def;
      if (s.target.type === 'enemy') {
        const pe = b.perceivedEnemy(c);
        if (pe && pe.visible) { st.data.goal.x = pe.x; st.data.goal.y = pe.y; }
      }
      const g = st.data.goal;
      const r = approach(b, c, st, g.x, g.y, g.stop, s.mode === 'run');
      if (r === 'arrived') return 'done';
      if (r === 'stuck') return { fail: '経路が塞がれていて進めない' };
      if (b.t > st.data.deadline) return s.maxTime ? 'done' : { fail: '時間内に到達できなかった' };
      return 'running';
    },
  },

  chase: {
    start(b, c, st) {
      st.data.until = b.t + (st.def.maxTime ?? st.def.duration);
      st.data.visited = new Set();
      return null;
    },
    update(b, c, st) {
      const s = st.def;
      const D = st.data;
      const e = b.enemyOf(c);
      if (!e.alive) return 'done';
      if (b.t > D.until) return 'done';
      const next = c.runner.plan && c.runner.plan.steps[c.runner.idx];
      const run = s.mode === 'run';
      if (b.canSee(c, e.x, e.y)) {
        D.lost = false;
        D.path = D.lostTarget ? null : D.path;
        D.lostTarget = null;
        const d = dist(c.x, c.y, e.x, e.y);
        // 次の手順の間合いに入ったら追尾を終えて次へ
        const reach = next ? reachFor(next) : null;
        if (reach !== null && d <= reach) {
          selfLog(b, c, `${e.name} を間合いに捉えた`);
          return 'done';
        }
        const keep = s.distance ?? (reach !== null ? Math.max(0.8, reach - 0.3) : 1.5);
        D.repathAt = Math.min(D.repathAt ?? 0, b.t + 0.4);
        const r = approach(b, c, st, e.x, e.y, keep, run);
        if (r === 'arrived') { c.desired.vx = c.desired.vy = 0; faceTo(c, e.x, e.y); }
        else if (r === 'stuck') { D.path = null; D.stuckCount = 0; }
        return 'running';
      }
      // 見失った：最後に見た位置 → 最近の物音の位置 → 見回す
      if (!D.lost) {
        D.lost = true;
        selfLog(b, c, '敵を見失った。痕跡を追う');
      }
      if (!D.lostTarget) {
        const ls = c.memory.lastSeen;
        const h = [...c.memory.heard].reverse().find(x => b.t - x.t < 8 && !D.visited.has(`${x.t}`));
        if (ls && !D.visited.has('lastSeen')) D.lostTarget = { x: ls.x, y: ls.y, key: 'lastSeen' };
        else if (h) D.lostTarget = { x: h.x, y: h.y, key: `${h.t}` };
        D.path = null;
      }
      if (D.lostTarget) {
        const r = approach(b, c, st, D.lostTarget.x, D.lostTarget.y, 0.6, run);
        if (r !== 'moving') { D.visited.add(D.lostTarget.key); D.lostTarget = null; D.path = null; }
        return 'running';
      }
      c.desired.face = c.facing + 2.5; // その場で見回す
      return 'running';
    },
  },

  melee: {
    start(b, c, st) {
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 2.5;
      st.data.obj = res.obj || null;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const e = b.enemyOf(c);
      if (D.phase === 'approach') {
        let tx, ty, reach;
        if (D.obj) {
          if (!b.world.objects.includes(D.obj)) return { fail: '対象が既に壊れている' };
          const n = nearestPointOnRect(c.x, c.y, D.obj);
          tx = n.x; ty = n.y; reach = 1.0;
        } else {
          const pe = resolveTarget(b, c, { type: 'enemy' });
          if (pe.error) return { fail: '敵を見失った' };
          tx = pe.x; ty = pe.y; reach = RULES.meleeRange - 0.15;
          if (!pe.visible && dist(c.x, c.y, tx, ty) < 1.2) return { fail: '敵を見失った' };
        }
        const r = approach(b, c, st, tx, ty, reach, true);
        if (r === 'arrived') {
          D.phase = 'windup';
          D.until = b.t + RULES.meleeWindup;
          st.locked = true;
          c.windup = { kind: 'melee', until: D.until };
          b.emit({ text: `${c.name} が拳を振りかぶる`, kind: 'combat', actor: c, pos: c });
        } else if (r === 'stuck' || b.t > D.deadline) return { fail: '間合いに入れなかった' };
        return 'running';
      }
      if (D.phase === 'windup') {
        if (D.obj) { const n = nearestPointOnRect(c.x, c.y, D.obj); faceTo(c, n.x, n.y); }
        else if (b.canSee(c, e.x, e.y)) faceTo(c, e.x, e.y);
        if (b.t < D.until) return 'running';
        c.windup = null;
        if (D.obj) {
          if (b.world.objects.includes(D.obj) && distToRect(c.x, c.y, D.obj) <= 1.4) {
            b.emit({ text: `${c.name} の『${c.stand}』が${D.obj.name}を殴りつけた！`, kind: 'combat', actor: c, pos: c, sound: 10, soundKind: 'impact' });
            b.damageObject(D.obj, c.def.power * 1.5, c);
          } else b.emit({ text: `${c.name} の拳は届かなかった`, kind: 'fail', actor: c, pos: c });
        } else {
          const d = dist(c.x, c.y, e.x, e.y);
          const ang = Math.abs(angDiff(c.facing, angleTo(c.x, c.y, e.x, e.y)));
          if (e.alive && d <= RULES.meleeRange + e.r * 0.5 && ang <= RULES.meleeArc) {
            if (e.status.invulnUntil <= b.t) b.emit({ text: `${c.name} の『${c.stand}』の拳が ${e.name} を捉えた！`, kind: 'combat', actor: c, affected: e, pos: e, sound: 4 });
            const a = angleTo(c.x, c.y, e.x, e.y);
            const dealt = b.damage(e, c.def.power, { source: c, kind: 'melee', from: c, label: '拳' });
            if (dealt > 0) { e.kbx = Math.cos(a) * 3; e.kby = Math.sin(a) * 3; }
          } else {
            b.emit({ text: `${c.name} の拳は空を切った`, kind: 'combat', actor: c, pos: c, sound: 4, soundKind: 'swing' });
          }
        }
        D.phase = 'recover';
        D.until = b.t + RULES.meleeRecovery;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },

  throw: {
    start(b, c, st) {
      if (c.knives <= 0) return 'ナイフを持っていない';
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      st.data.aim = { x: res.x, y: res.y };
      st.data.phase = 'windup';
      st.data.until = b.t + RULES.throwWindup;
      st.locked = true;
      c.windup = { kind: 'throw', until: st.data.until };
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      if (D.phase === 'windup') {
        if (st.def.target.type === 'enemy') {
          const pe = b.perceivedEnemy(c);
          if (pe && pe.visible) D.aim = { x: pe.x, y: pe.y };
        }
        faceTo(c, D.aim.x, D.aim.y);
        if (b.t < D.until) return 'running';
        c.windup = null;
        if (!facingOk(c, D.aim.x, D.aim.y, 0.6)) c.facing = angleTo(c.x, c.y, D.aim.x, D.aim.y);
        c.knives--;
        b.spawnKnife(c, c.x, c.y, D.aim.x, D.aim.y);
        b.emit({ text: `${c.name} がナイフを投げた！（残り${c.knives}本）`, obsText: `${c.name} がナイフを投げた！`, kind: 'combat', actor: c, pos: c, sound: 5, soundKind: 'throw' });
        D.phase = 'recover';
        D.until = b.t + RULES.throwRecovery;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },

  guard: {
    start(b, c, st) {
      st.data.until = b.t + st.def.duration;
      c.status.guardUntil = st.data.until;
      return null;
    },
    update(b, c, st) {
      const res = resolveTarget(b, c, st.def.target.type === 'none' ? { type: 'enemy' } : st.def.target, st.def);
      if (!res.error && !res.self) faceTo(c, res.x, res.y);
      c.status.guardUntil = st.data.until;
      return b.t >= st.data.until ? 'done' : 'running';
    },
    end(b, c) { c.status.guardUntil = 0; },
  },

  dodge: {
    start(b, c, st) {
      if (c.cd.dodge) return '回避の体勢が整っていない（クールダウン中）';
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      const a = res.angle ?? angleTo(c.x, c.y, res.x, res.y);
      c.kbx = Math.cos(a) * 10;
      c.kby = Math.sin(a) * 10;
      c.kbSlam = null;
      c.status.invulnUntil = b.t + 0.25;
      c.cd.dodge = b.t + RULES.dodgeCooldown;
      st.data.until = b.t + RULES.dodgeTime;
      st.locked = true;
      b.emit({ text: `${c.name} が素早く跳んだ`, kind: 'combat', actor: c, pos: c, sound: 4 });
      return null;
    },
    update(b, c, st) {
      return b.t >= st.data.until ? 'done' : 'running';
    },
  },

  push: pushPull(1),
  pull: pushPull(-1),

  look: {
    start(b, c, st) {
      const tt = st.def.target;
      let res = resolveTarget(b, c, tt, st.def);
      if (res.error && tt.type === 'enemy') {
        // 敵の位置を知らない場合は、最後に聞こえた音の方向か前方を見る
        const h = c.memory.heard[c.memory.heard.length - 1];
        res = h ? { x: h.x, y: h.y } : { x: c.x + Math.cos(c.facing) * 5, y: c.y + Math.sin(c.facing) * 5 };
      } else if (res.error) return res.error;
      if (res.obj && res.obj.kind === 'window') {
        // 窓越しに外を見る：窓の向こう側を向く
        const bd = b.buildingOf(c);
        const cc = res.center;
        const from = bd ? { x: bd.x + bd.w / 2, y: bd.y + bd.h / 2 } : { x: c.x, y: c.y };
        const a = angleTo(from.x, from.y, cc.x, cc.y);
        res = { x: cc.x + Math.cos(a) * 8, y: cc.y + Math.sin(a) * 8 };
      }
      st.data.at = res;
      st.data.until = b.t + 0.6;
      return null;
    },
    update(b, c, st) {
      faceTo(c, st.data.at.x, st.data.at.y);
      if (b.t < st.data.until) return 'running';
      const e = b.enemyOf(c);
      selfLog(b, c, b.canSee(c, e.x, e.y) ? `${e.name} の姿を確認した（距離${dist(c.x, c.y, e.x, e.y).toFixed(1)}m）` : '敵の姿は見えない');
      return 'done';
    },
  },

  wait: {
    start(b, c, st) {
      st.data.until = b.t + st.def.duration;
      return null;
    },
    update(b, c, st) {
      const pe = b.perceivedEnemy(c);
      if (pe) faceTo(c, pe.x, pe.y);
      return b.t >= st.data.until ? 'done' : 'running';
    },
  },

  ability: {
    start(b, c, st) {
      const s = st.def;
      const ab = ABILITIES[s.ability];
      if (c.cd[s.ability]) {
        const left = c.cd[s.ability] - b.t;
        // まもなく使えるなら待つ（それ以上は失敗）
        if (left > 2) return `『${ab.name}』はクールダウン中（あと${left.toFixed(1)}秒）`;
        st.data.phase = 'cooldown';
        return null;
      }
      if (c.sp < ab.cost) return `スタンドエネルギーが足りない（必要${ab.cost}）`;
      const res = resolveTarget(b, c, s.target, s);
      if (res.error) return res.error;
      st.data.aim = res;
      st.data.until = b.t + (ab.effects[s.effect].castTime ?? ab.castTime);
      st.data.phase = 'cast';
      st.locked = true;
      c.windup = { kind: 'ability', until: st.data.until };
      return null;
    },
    update(b, c, st) {
      const s = st.def;
      const ab = ABILITIES[s.ability];
      const D = st.data;
      if (D.phase === 'cooldown') {
        if (c.cd[s.ability]) return 'running';
        const err = EXEC.ability.start(b, c, st);
        return err ? { fail: err } : 'running';
      }
      if (D.phase === 'cast') {
        const res = resolveTarget(b, c, s.target, s);
        if (!res.error && !res.self) D.aim = res;
        if (!D.aim.self) faceTo(c, D.aim.x, D.aim.y);
        if (b.t < D.until) return 'running';
        c.windup = null;
        const r = applyAbility(b, c, s, resolveTarget(b, c, s.target, s));
        if (!r.ok) return { fail: r.reason };
        c.cd[s.ability] = b.t + ab.cooldown;
        c.sp -= ab.cost;
        D.phase = 'recover';
        D.until = b.t + (s.ability === 'vector' ? 0.2 : 0.1);
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },
};

// 次の手順を敵に対して実行できる距離（追尾の終了判定に使う）
function reachFor(next) {
  if (next.target.type !== 'enemy') return null;
  if (next.action === 'melee') return RULES.meleeRange - 0.2;
  if (next.action === 'throw') return 10;
  if (next.action === 'ability') {
    const ab = ABILITIES[next.ability];
    return Math.max(1, (ab.effects[next.effect].range ?? ab.range) - 0.5);
  }
  return null;
}

function pushPull(sign) {
  return {
    start(b, c, st) {
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      if (!res.obj || !res.obj.movable) return '動かせる物体ではない';
      st.data.obj = res.obj;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 4;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const o = D.obj;
      if (!b.world.objects.includes(o)) return { fail: '対象が既に壊れている' };
      const n = nearestPointOnRect(c.x, c.y, o);
      if (D.phase === 'approach') {
        if (distToRect(c.x, c.y, o) <= 0.75) {
          D.phase = 'act';
          D.until = b.t + 0.3;
          st.locked = true;
          return 'running';
        }
        const r = approach(b, c, st, n.x, n.y, 0.7, st.def.mode === 'run');
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      if (D.phase === 'act') {
        faceTo(c, n.x, n.y);
        if (b.t < D.until) return 'running';
        const cc = rectCenter(o);
        const a = angleTo(c.x, c.y, cc.x, cc.y) + (sign < 0 ? Math.PI : 0);
        const slick = o.slickUntil > b.t;
        const sp = (sign > 0 ? 7 : 4) / (o.mass || 1) * (slick ? 2.2 : 1);
        o.vx = Math.cos(a) * sp;
        o.vy = Math.sin(a) * sp;
        o.pushedBy = c.id;
        b.emit({ text: `${c.name} が${o.name}を${sign > 0 ? '押し出した' : '引き寄せた'}${slick ? '（滑るように勢いよく動く！）' : ''}`, kind: 'env', actor: c, pos: cc, sound: 6 });
        D.phase = 'recover';
        D.until = b.t + 0.3;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  };
}

function startStep(b, c, def) {
  const st = { def, phase: def.condition ? 'cond' : 'run', t0: b.t, data: {}, locked: false };
  c.runner.step = st;
  if (st.phase === 'run') beginRun(b, c, st);
}

function beginRun(b, c, st) {
  st.phase = 'run';
  st.runT0 = b.t;
  const err = EXEC[st.def.action].start(b, c, st);
  if (err) endStep(b, c, { fail: err });
}

function endStep(b, c, result) {
  const st = c.runner.step;
  if (!st) return;
  const ex = EXEC[st.def.action];
  if (ex.end) ex.end(b, c, st);
  if (c.windup) c.windup = null;
  if (result && result.fail) selfLog(b, c, `✕ ${st.def.label}：${result.fail}`, 'fail');
  c.runner.step = null;
}

// 被弾・転倒などによる中断。force でなければ、構え・詠唱中の行動のみ中断する
export function interruptStep(b, c, reason, force = false) {
  const st = c.runner.step;
  if (!st || st.phase !== 'run') return;
  if (!force && !st.locked) return;
  endStep(b, c, { fail: reason });
}

export function adoptPlan(b, c, plan) {
  const st = c.runner.step;
  if (st && st.locked) {
    c.pendingPlan = plan;
    return;
  }
  if (st) endStep(b, c, null);
  c.runner.plan = plan;
  c.runner.idx = 0;
  c.runner.step = null;
  c.planAdoptedAt = b.t;
  if (plan.speech) b.speak(c, plan.speech);
}

export function planFinished(c) {
  const r = c.runner;
  return !r.step && !c.pendingPlan && (!r.plan || r.idx >= r.plan.steps.length);
}

export function updateRunner(b, c) {
  c.desired.vx = 0;
  c.desired.vy = 0;
  c.desired.face = null;
  const s = c.status;
  if (s.proneUntil > b.t || s.stunUntil > b.t || s.recoverUntil > b.t) return;
  // 弾き出されて飛んでいる間は何もできない。空中では能力（空中での方向転換）だけ使える
  if (c.launch) return;
  if (b.isAirborne(c)) {
    const st = c.runner.step;
    const next = st ? st.def : c.runner.plan && c.runner.plan.steps[c.runner.idx];
    if (!next || !((next.action === 'ability' && next.ability === 'perpendicular') || next.action === 'wait' || next.action === 'look')) return;
  }

  if (!c.runner.step) {
    if (c.pendingPlan) {
      const p = c.pendingPlan;
      c.pendingPlan = null;
      adoptPlan(b, c, p);
    }
    const plan = c.runner.plan;
    if (plan && c.runner.idx < plan.steps.length) {
      startStep(b, c, plan.steps[c.runner.idx++]);
    } else {
      // 待機中：知っている敵の位置か、最後の物音の方を向く。
      // 目の前の敵が振りかぶったら反射的にガードする（両者共通の「安全な代替行動」）
      const pe = b.perceivedEnemy(c);
      const h = c.memory.heard[c.memory.heard.length - 1];
      if (pe && pe.visible && pe.char.windup && dist(c.x, c.y, pe.x, pe.y) < 2.6) {
        c.status.guardUntil = b.t + 0.15;
      }
      if (pe) faceTo(c, pe.x, pe.y);
      else if (h && b.t - h.t < 4) faceTo(c, h.x, h.y);
      return;
    }
  }
  const st = c.runner.step;
  if (!st) return;
  if (st.phase === 'cond') {
    const cond = st.def.condition;
    if (checkCondition(b, c, cond, st)) {
      selfLog(b, c, `条件成立：${condLabel(cond)}`);
      beginRun(b, c, st);
    } else if (b.t - st.t0 > cond.timeout) {
      endStep(b, c, { fail: `条件（${condLabel(cond)}）が${cond.timeout}秒以内に満たされなかった` });
      return;
    } else {
      const pe = b.perceivedEnemy(c);
      if (pe) faceTo(c, pe.x, pe.y);
      return;
    }
  }
  if (!c.runner.step || c.runner.step !== st) return;
  const r = EXEC[st.def.action].update(b, c, st);
  if (r === 'done') endStep(b, c, null);
  else if (r && r.fail) endStep(b, c, r);
}
