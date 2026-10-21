// 行動計画：AI/解析器が出した「生の計画」を検証して実行可能な形に変換し、時間経過に沿って実行する
import { ACTIONS, ABILITIES, CONDITIONS, DIRECTIONS, RULES } from './data.js';
import { dist, angleTo, angDiff, clamp, nearestPointOnRect, distToRect, rectCenter, pointInRect } from './vec.js';
import { nearestWalkable, hasLOS, isWalkablePoint, upperFloorAt, findPath } from './world.js';
import { applyAbility } from './abilities.js';
import { itemDef, strengthScale, makeItem } from './items.js';

const DEFAULT_TARGET = {
  move: 'enemy', chase: 'enemy', melee: 'enemy', throw: 'enemy', guard: 'enemy', dodge: 'direction',
  push: 'object', pull: 'object', open: 'object', close: 'object', jump_down: 'none', swat: 'self', pickup: 'none', drop: 'none', grab: 'enemy', tackle: 'enemy', counter: 'none', feint: 'enemy', hide: 'none', search: 'none', decoy: 'direction', vault: 'object', use_item: 'direction', interact: 'object', stand_out: 'none', stand_move: 'enemy', stand_in: 'none', look: 'enemy', wait: 'none', ability: 'enemy',
};

const DIR_LABEL = {
  toward_enemy: '敵の方向', away_from_enemy: '敵から離れる方向', left: '左', right: '右', up: '上（奥）',
  down: '下（手前）', up_left: '左上（北西）', up_right: '右上（北東）', down_left: '左下（南西）', down_right: '右下（南東）', forward: '前方', back: '後方', cover: '物陰',
};

const str = v => (typeof v === 'string' ? v.trim() : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- 検証・変換 ----------

function targetName(b, t) {
  if (t.type === 'enemy') return t.charId ? b.chars.find(x => x.id === t.charId)?.name || '敵' : '敵';
  if (t.type === 'ally') return '味方';
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
    if (area) return area.name;
    const item = b.world.items.find(i => i.id === t.id);
    return item ? item.name : t.id;
  }
  return '';
}

export function describeStep(b, s) {
  const tn = targetName(b, s.target);
  const cond = s.condition ? `［${condLabel(s.condition)}］` : '';
  switch (s.action) {
    case 'move': return `${cond}${tn}へ${s.mode === 'run' ? '走る' : '歩く'}`;
    case 'chase': return `${cond}${tn}を${s.mode === 'run' ? '走って' : '歩いて'}追尾（最大${s.duration.toFixed(0)}秒${s.distance ? `・距離${s.distance}m` : ''}）`;
    case 'melee': return `${cond}${tn}を殴る`;
    case 'throw': return `${cond}${tn}へ持っている物を投げる`;
    case 'pickup': return `${cond}${s.target.type === 'object' ? tn : '近くの物'}を拾う`;
    case 'drop': return `${cond}持っている物を手放す`;
    case 'guard': return `${cond}ガード（${s.duration.toFixed(1)}秒）`;
    case 'dodge': return `${cond}${tn}へ回避`;
    case 'push': return `${cond}${tn}を押す`;
    case 'open': return `${cond}${tn}を開ける`;
    case 'close': return `${cond}${tn}を閉める${s.ability === 'hotel' ? '（ホテル・カリフォルニア）' : ''}`;
    case 'jump_down': return `${cond}${s.target.type === 'object' ? tn : '2階の窓'}から飛び降りる`;
    case 'swat': return `${cond}体のまわりを払う`;
    case 'pull': return `${cond}${tn}を引く`;
    case 'look': return `${cond}${tn}を観察`;
    case 'stand_out': return `${cond}スタンドを出す`;
    case 'grab': return `${cond}${tn}に掴みかかる`;
    case 'tackle': return `${cond}${tn}へ体当たり`;
    case 'counter': return `${cond}受け流しの構え`;
    case 'feint': return `${cond}${tn}へフェイント`;
    case 'hide': return `${cond}身を潜める（${s.duration.toFixed(0)}秒）`;
    case 'search': return `${cond}周囲を見回す`;
    case 'decoy': return `${cond}${tn}に物音を立てる`;
    case 'vault': return `${cond}${tn}を乗り越える`;
    case 'use_item': return `${cond}手の物を使う${s.target.type !== 'none' && s.target.type !== 'self' ? `（${tn}）` : ''}`;
    case 'interact': return `${cond}${tn}を操作する`;
    case 'stand_move': return `${cond}スタンドを${tn}へ先行させる`;
    case 'stand_in': return `${cond}スタンドを戻す`;
    case 'wait': return `${cond}待機${s.duration ? `（${s.duration.toFixed(1)}秒）` : ''}`;
    case 'ability': {
      const ab = ABILITIES[s.ability];
      const extra = [s.count ? `${s.count}体` : '', s.sound ? { footsteps: '足音', voice: '声', loud: '大きな音', any: '' }[s.sound] : '', s.bounces !== undefined ? `${s.bounces}回反射` : ''].filter(Boolean).join('・');
      return `${cond}『${ab.name}：${ab.effects[s.effect].name}』→${tn}${extra ? `（${extra}）` : ''}`;
    }
    default: return s.action;
  }
}

function condLabel(c) {
  return CONDITIONS[c.kind].replace('value', c.value ?? '').replace(/（[^）]*）/g, '');
}

function resolveObjectId(b, id) {
  if (!id) return null;
  if (b.objectById(id)) return id;
  if (b.world.buildings.some(x => x.id === id)) return id;
  if (b.world.buildings.some(x => x.doors.some(d => d.id === id))) return id;
  if (b.world.areas.some(a => a.id === id)) return id;
  if (b.world.items.some(i => i.id === id)) return id;
  return null;
}

function validateStep(b, c, raw, cursor) {
  const action = str(raw.action);
  if (!ACTIONS[action]) return { error: `不明な行動「${action || '（空）'}」は実行できない` };
  let ttype = str(raw.targetType) || DEFAULT_TARGET[action];
  if (ttype === 'none' && !['wait', 'guard', 'jump_down', 'swat', 'pickup', 'drop', 'stand_out', 'stand_in', 'counter', 'hide', 'search', 'use_item'].includes(action)) ttype = DEFAULT_TARGET[action];
  if (action.startsWith('stand_') && !c.def.standRange) return { error: `『${c.stand}』は群体のスタンドなので、本体のように出したり先行させたりはできない（能力の「聞き耳を立てる」「取り付く」で個体を送る）` };
  const mode = raw.mode === 'run' || raw.mode === 'walk' ? raw.mode : action === 'chase' ? 'run' : 'walk';
  const step = { action, mode, target: { type: ttype }, raw, autoMode: action === 'move' && raw.mode !== 'run' && raw.mode !== 'walk' };

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
    // ホテル・カリフォルニアは「自分の手で最後の出口を閉める」ことで成立するので、行動としては「閉める」
    if (abId === 'hotel' && effect === 'seal') step.action = 'close';
  } else if (!ACTIONS[action].targets.includes(ttype)) {
    return { error: `${ACTIONS[action].name}は「${ttype}」を対象にできない` };
  }

  const t = step.target;
  // 2対2：狙う敵を id か名前で指定できる
  if (ttype === 'enemy' && str(raw.targetId)) {
    const tid = str(raw.targetId);
    const e = b.enemiesOf(c).find(x => x.id === tid) || b.enemyByName(c, tid);
    if (e) t.charId = e.id;
  }
  if (ttype === 'ally' && !b.alliesOf(c).some(a => a.alive)) return { error: '動ける味方がいない' };
  if (ttype === 'object') {
    const id = resolveObjectId(b, str(raw.targetId));
    if (!id) return { error: `対象「${str(raw.targetId) || '（未指定）'}」は戦場に存在しない` };
    t.id = id;
    const o = b.objectById(id);
    if ((action === 'push' || action === 'pull') && (!o || !o.movable)) return { error: `${targetName(b, t)}は動かせない` };
    if (step.action === 'open' || step.action === 'close') {
      if (!o || !(o.kind === 'door' || o.kind === 'window')) return { error: `${targetName(b, t)}は開け閉めできる扉・窓ではない` };
      if (!o.openable) return { error: `${o.name}は開かない（割ることはできる）` };
    }
    if (action === 'jump_down' && (!o || o.kind !== 'window' || o.floor !== 1)) return { error: `飛び降りられるのは2階の窓だけ（${targetName(b, t)}は不可）` };
    if (action === 'interact' && !(o && (['vending', 'fountain', 'generator', 'trashcan'].includes(o.kind) || o.buzzer))) return { error: `${targetName(b, t)}は操作できない（自動販売機・水飲み場・発電機・ゴミ箱・レジカウンター）` };
    if (action === 'vault' && (!o || !o.blocksMove || (o.z1 - o.z0) > 1.6 || o.kind === 'door' || o.kind === 'window')) return { error: `${targetName(b, t)}は乗り越えられない（高さ1.6m以下の物だけ）` };
    if (action === 'ability') {
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
    if (raw.floor === 0 || raw.floor === 1) t.floor = raw.floor;
  } else if (ttype === 'direction') {
    t.dir = DIRECTIONS.includes(raw.direction) ? raw.direction : (action === 'dodge' ? 'away_from_enemy' : 'toward_enemy');
  } else if (ttype === 'projectile') {
    t.id = str(raw.targetId) || null;
  }
  if (DIRECTIONS.includes(raw.direction)) step.aim = raw.direction;
  step.distance = num(raw.distance) !== null ? clamp(raw.distance, 0.5, 15) : null;
  // 能力ごとの追加指定：エコー・ビーチの個体数・置く音の種類、セブンス・サンの反射回数
  if (num(raw.count) !== null) step.count = clamp(Math.round(raw.count), 1, 24);
  if (['footsteps', 'voice', 'loud', 'any'].includes(raw.sound)) step.sound = raw.sound;
  if (num(raw.bounces) !== null) step.bounces = clamp(Math.round(raw.bounces), 0, 7);

  const d = num(raw.duration);
  if (action === 'guard') step.duration = clamp(d ?? 1.5, 0.3, 3);
  else if (action === 'chase') step.duration = clamp(d ?? 4, 0.5, 8);
  else if (action === 'wait') step.duration = clamp(d ?? (raw.condition ? 0 : 1), 0, 6);
  else if (action === 'hide') step.duration = clamp(d ?? 3, 0.5, 8);
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
  let climbs = 0;
  const approxDist = () => {
    const r = resolveTarget(b, c, s.target, s);
    if (r.error) return 6;
    if (s.target.type === 'direction') return s.distance ?? 5;
    let d = dist(from.x, from.y, r.x, r.y);
    const ff = from.f ?? (from === c ? c.floor : 0), tf = r.f ?? 0;
    // 階をまたぐ移動や遠い移動は、実際の経路（階段・扉の遠回りを含む）で測る
    if (s.action === 'move' && (ff !== tf || d > 6)) {
      const p = findPath(b.world, from.x, from.y, r.x, r.y, ff, tf);
      if (p && p.length) d = Math.max(d, p.length);
      climbs = Math.abs(tf - ff);
    }
    if (s.target.type === 'enemy' && s.action === 'move') return Math.max(0, d - (s.distance ?? 1.3));
    return d;
  };
  switch (s.action) {
    case 'move': cost = Math.max(0.3, (approxDist() * 1.15) / speed) + climbs * 1.2; break;
    case 'chase': cost = s.duration; break;
    case 'melee': cost = 0.8 + clamp((approxDist() - 1.5) / c.def.run, 0, 2.5); break;
    case 'throw': cost = RULES.throwWindup + RULES.throwRecovery + 0.1; break;
    case 'guard': cost = s.duration; break;
    case 'dodge': cost = 0.4; break;
    case 'grab': cost = 0.6 + clamp((approxDist() - 1.2) / c.def.run, 0, 2); break;
    case 'tackle': cost = 0.7; break;
    case 'counter': cost = 0.9; break;
    case 'feint': cost = 0.4; break;
    case 'hide': cost = s.duration; break;
    case 'search': cost = 1.5; break;
    case 'decoy': cost = 0.5; break;
    case 'vault': cost = 0.9 + clamp(approxDist() / c.def.run, 0, 3); break;
    case 'use_item': cost = (c.held && itemDef(c.held)?.useTime) || 0.5; break;
    case 'interact': cost = 2 + clamp(approxDist() / c.def.walk, 0, 4); break;
    case 'push': case 'pull': cost = 0.6 + clamp((approxDist() - 1) / c.def.walk, 0, 3); break;
    case 'open': case 'close': cost = 0.6 + clamp((approxDist() - 1) / speed, 0, 4); break;
    case 'jump_down': cost = 1.2 + (s.target.type === 'object' ? clamp((approxDist() - 1) / speed, 0, 4) : 1); break;
    case 'swat': cost = 0.6; break;
    case 'pickup': cost = 0.5 + (s.target.type === 'object' ? clamp(approxDist() / speed, 0, 4) : 1.5); break;
    case 'drop': cost = 0.1; break;
    case 'look': cost = 0.6; break;
    case 'stand_out': case 'stand_in': cost = 0.2; break;
    case 'stand_move': cost = 0.4; break;
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
    // 歩き方の指定が無い移動は、歩いて5秒を超える遠さか予算に収まらなければ走る
    if ((step.est > remaining || step.est > 5) && step.autoMode && step.mode === 'walk') {
      step.mode = 'run';
      step.est = estimateCost(b, c, step, cursor);
      step.label = describeStep(b, step);
    }
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
      if (!res.error) cursor = { x: res.x, y: res.y, f: res.f ?? 0 };
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
    case 'ally': {
      const a = b.alliesOf(c).filter(x => x.alive).sort((p, q) => dist(c.x, c.y, p.x, p.y) - dist(c.x, c.y, q.x, q.y))[0];
      if (!a) return { error: '動ける味方がいない' };
      return { x: a.x, y: a.y, f: a.floor, ally: a };
    }
    case 'enemy': {
      const named = t.charId ? b.chars.find(x => x.id === t.charId && x.alive) : null;
      const pe = named ? b.perceivedEnemy(c, named) : b.perceivedEnemy(c);
      if (pe) return { x: pe.x, y: pe.y, f: pe.floor ?? 0, char: pe.visible ? pe.char : null, visible: pe.visible };
      // 姿を見ていなければ、直近に聞こえた物音の位置を推定位置として使う
      const h = [...c.memory.heard].reverse().find(x => b.t - x.t < 10);
      if (h) return { x: h.x, y: h.y, f: h.floor ?? 0, char: null, visible: false, guess: true };
      return { error: '敵の位置が分からない（姿も物音も捉えていない）' };
    }
    case 'self':
    case 'none':
      return { x: c.x, y: c.y, f: c.floor, self: true };
    case 'point': {
      // 階の指定がなければ、2階の床がある場所で自分が2階にいる時だけ2階
      const f = t.floor ?? (c.floor === 1 && upperFloorAt(b.world, t.x, t.y) ? 1 : 0);
      return { x: t.x, y: t.y, f };
    }
    case 'direction': {
      if (t.dir === 'cover') {
        const cv = findCover(b, c);
        if (cv) return { x: cv.x, y: cv.y, f: 0 };
      }
      const a = dirVector(b, c, t.dir === 'cover' ? 'away_from_enemy' : t.dir);
      const d = step.distance ?? (step.action === 'dodge' ? RULES.dodgeDistance : 5);
      return {
        x: clamp(c.x + Math.cos(a) * d, 0.8, b.world.w - 0.8),
        y: clamp(c.y + Math.sin(a) * d, 0.8, b.world.h - 0.8),
        f: c.floor,
        angle: a,
      };
    }
    case 'object': {
      const o = b.objectById(t.id);
      if (o) {
        const n = nearestPointOnRect(c.x, c.y, o);
        return { x: n.x, y: n.y, f: o.floor, obj: o, center: rectCenter(o) };
      }
      const bd = b.world.buildings.find(x => x.id === t.id);
      if (bd) {
        // 建物そのもの：1階の中央付近（既に中にいれば今の場所）
        if (pointInRect(c.x, c.y, bd)) return { x: c.x, y: c.y, f: c.floor, building: bd };
        const p = nearestWalkable(b.world, bd.x + bd.w / 2, bd.y + bd.h / 2 + 1, 3) || { x: bd.x + bd.w / 2, y: bd.y + bd.h / 2 };
        return { x: p.x, y: p.y, f: 0, building: bd };
      }
      const item = b.world.items.find(i => i.id === t.id);
      if (item) return { x: item.x, y: item.y, f: item.floor ?? 0, item };
      const area = b.world.areas.find(a => a.id === t.id);
      if (area) {
        // 区域：中心付近の歩ける場所（自分が既に中にいれば今の場所）。「〇〇の2階」は2階
        const f = area.floor ?? 0;
        if (c.floor === f && c.x >= area.x && c.x <= area.x + area.w && c.y >= area.y && c.y <= area.y + area.h) return { x: c.x, y: c.y, f, area };
        const p = nearestWalkable(b.world, area.x + area.w / 2, area.y + area.h / 2, 5, f) || { x: area.x + area.w / 2, y: area.y + area.h / 2 };
        return { x: p.x, y: p.y, f, area };
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
    case 'enemy_guarding': return !!(visible && (pe.char.status.guardUntil > b.t || pe.char.status.counterUntil > b.t));
    case 'enemy_prone': return !!(visible && (pe.char.status.proneUntil > b.t || pe.char.status.stunUntil > b.t || b.isAirborne(pe.char)));
    case 'enemy_inside': {
      const bd = b.buildingOf(c);
      // どの敵でも、同じ建物の中にいるのが見えたら（味方の報告も含む）
      return !!bd && b.enemiesOf(c).some(e => {
        if (!e.alive) return false;
        if (b.canSee(c, e.x, e.y)) return pointInRect(e.x, e.y, bd);
        const r = c.memory.seen[e.id];
        return r && b.t - r.t < 1 && pointInRect(r.x, r.y, bd);
      });
    }
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
// tf：目的地の階。階が違えば階段を経由する
function approach(b, c, st, tx, ty, stopDist, run, tf = c.floor) {
  const D = st.data;
  const d = dist(c.x, c.y, tx, ty);
  if (d <= stopDist && c.floor === tf) return 'arrived';
  const needPath = !D.path || D.repathAt <= b.t || dist(D.goalX, D.goalY, tx, ty) > 1 || D.goalF !== tf || D.pathFloor !== c.floor || b.world.navDirty;
  if (needPath) {
    const p = b.path(c, tx, ty, tf);
    D.repathAt = b.t + 0.7;
    D.goalX = tx; D.goalY = ty; D.goalF = tf; D.pathFloor = c.floor;
    if (!p || !p.points.length) return 'stuck';
    D.path = p.points;
    if (p.partial && !D.partialNoted) {
      D.partialNoted = true;
      D.partial = true;
      selfLog(b, c, '目的地まで通れる経路がない。可能な限り近づく', 'fail');
    }
  }
  while (D.path.length && D.path[0].stairTo === undefined && dist(c.x, c.y, D.path[0].x, D.path[0].y) < 0.3) D.path.shift();
  if (!D.path.length) return D.partial ? 'stuck' : c.floor === tf ? 'arrived' : 'stuck';
  const wp = D.path[0];
  if (wp.stairTo !== undefined && dist(c.x, c.y, wp.x, wp.y) < 0.45) {
    // 階段を上り下りする（約1秒）
    c.climb = { until: b.t + 1.0, to: wp.stairTo };
    D.path.shift();
    D.pathFloor = wp.stairTo;
    selfLog(b, c, `階段を${wp.stairTo > c.floor ? '上る' : '下りる'}`);
    return 'moving';
  }
  const dd = c.floor === tf ? d : dist(c.x, c.y, wp.x, wp.y) + 2;
  const a = angleTo(c.x, c.y, wp.x, wp.y);
  let speed = run ? c.def.run : c.def.walk;
  speed = Math.min(speed, (dd - stopDist) * 3 + 0.6); // 減速
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
  const f = res.f ?? 0;
  if (res.obj && (!res.obj.blocksMove || res.obj.kind === 'door')) {
    // 植え込み・階段など通れる物体はその中に、扉はその位置へ
    return { x: res.center.x, y: res.center.y, stop: 0.3, f };
  }
  if (res.obj) {
    // 物体のそば（自分のいる側）
    const n = nearestPointOnRect(c.x, c.y, res.obj);
    const cc = res.center;
    let nx = n.x - cc.x, ny = n.y - cc.y;
    const l = Math.hypot(nx, ny) || 1;
    const p = nearestWalkable(b.world, n.x + (nx / l) * 0.7, n.y + (ny / l) * 0.7, 2.5, f);
    return { x: p ? p.x : n.x, y: p ? p.y : n.y, stop: 0.35, f };
  }
  if (s.target.type === 'enemy') return { x: res.x, y: res.y, stop: s.distance ?? 1.3, f };
  if (s.target.type === 'ally') return { x: res.x, y: res.y, stop: s.distance ?? 1.5, f, ally: res.ally };
  const p = nearestWalkable(b.world, res.x, res.y, 3, f) || res;
  return { x: p.x, y: p.y, stop: 0.3, f };
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
        if (pe && pe.visible) { st.data.goal.x = pe.x; st.data.goal.y = pe.y; st.data.goal.f = pe.floor; }
      }
      if (s.target.type === 'ally' && st.data.goal.ally) { const a = st.data.goal.ally; st.data.goal.x = a.x; st.data.goal.y = a.y; st.data.goal.f = a.floor; }
      const g = st.data.goal;
      const r = approach(b, c, st, g.x, g.y, g.stop, s.mode === 'run', g.f);
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
        const reach = next ? reachFor(next, c) : null;
        if (reach !== null && d <= reach && e.floor === c.floor) {
          selfLog(b, c, `${e.name} を間合いに捉えた`);
          return 'done';
        }
        const keep = s.distance ?? (reach !== null ? Math.max(0.8, reach - 0.3) : 1.5);
        D.repathAt = Math.min(D.repathAt ?? 0, b.t + 0.4);
        if (reach !== null && e.floor !== c.floor && d <= reach) { /* 別の階：階段へ回る */ }
        const r = approach(b, c, st, e.x, e.y, keep, run, e.floor);
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
        if (ls && !D.visited.has('lastSeen')) D.lostTarget = { x: ls.x, y: ls.y, f: ls.floor ?? 0, key: 'lastSeen' };
        else if (h) D.lostTarget = { x: h.x, y: h.y, f: h.floor ?? 0, key: `${h.t}` };
        D.path = null;
      }
      if (D.lostTarget) {
        const r = approach(b, c, st, D.lostTarget.x, D.lostTarget.y, 0.6, run, D.lostTarget.f);
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
        let tx, ty, reach, tf;
        if (D.obj) {
          if (!b.world.objects.includes(D.obj)) return { fail: '対象が既に壊れている' };
          const n = nearestPointOnRect(c.x, c.y, D.obj);
          tx = n.x; ty = n.y; reach = 1.0; tf = D.obj.floor;
        } else {
          const pe = resolveTarget(b, c, { type: 'enemy' });
          if (pe.error) return { fail: '敵を見失った' };
          tx = pe.x; ty = pe.y; tf = pe.f; reach = meleeRange(c) - 0.15;
          if (!pe.visible && dist(c.x, c.y, tx, ty) < 1.2 && c.floor === tf) return { fail: '敵を見失った' };
        }
        const r = approach(b, c, st, tx, ty, reach, true, tf);
        if (r === 'arrived') {
          D.phase = 'windup';
          D.until = b.t + RULES.meleeWindup;
          st.locked = true;
          c.windup = { kind: 'melee', until: D.until };
          if (c.standBody && !D.obj && pe0(b, c)) c.standBody.goal = { char: b.enemyOf(c), x: b.enemyOf(c).x, y: b.enemyOf(c).y };
          b.emit({ text: `${c.name} が拳を振りかぶる`, kind: 'combat', actor: c, pos: c });
          // 演出用：至近距離で殴り合う瞬間（画面側でクローズアップとスローにする）
          if (!D.obj && e.alive && dist(c.x, c.y, e.x, e.y) < 3.2) b.puff('clash', { x: (c.x + e.x) / 2, y: (c.y + e.y) / 2, z: b.baseZ(c) + 1.1 }, { seq: ++b.fxSeq, until: D.until });
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
            b.damageObject(D.obj, meleePower(c) * 1.5, c);
            b.breakHeld(c);
          } else b.emit({ text: `${c.name} の拳は届かなかった`, kind: 'fail', actor: c, pos: c });
        } else {
          const d = dist(c.x, c.y, e.x, e.y);
          const ang = Math.abs(angDiff(c.facing, angleTo(c.x, c.y, e.x, e.y)));
          if (e.alive && e.floor === c.floor && d <= meleeRange(c) + e.r * 0.5 && ang <= (c.def.meleeArc ?? RULES.meleeArc)) {
            const weapon = c.held && weaponMelee(c) > c.def.power ? c.held.name : null;
            if (e.status.invulnUntil <= b.t) b.emit({ text: weapon ? `${c.name} の${weapon}が ${e.name} を捉えた！` : `${c.name} の『${c.stand}』の拳が ${e.name} を捉えた！`, kind: 'combat', actor: c, affected: e, pos: e, sound: 4 });
            const a = angleTo(c.x, c.y, e.x, e.y);
            // スタンドは本体から離れるほど力が落ちる（素の間合いの外で当たった拳は7割）
            const far = !weapon && d > (c.def.meleeRange ?? RULES.meleeRange) + e.r * 0.5;
            // 錠二は自分の密室の中では「最後までやる」：拳の威力が1.35倍
            const room = b.buildingOf(c);
            const sealedByMe = !!(room && room.sealed && room.sealed.by === c.id);
            const mult = (far ? 0.7 : 1) * (sealedByMe ? 1.35 : 1);
            const dealt = b.damage(e, meleePower(c) * mult, { source: c, kind: 'melee', from: c, label: weapon || (sealedByMe ? '密室の拳' : far ? '伸ばしたスタンドの拳' : '拳') });
            if (weapon) b.breakHeld(c);
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
      if (!c.held) return '投げる物を持っていない（先に拾う）';
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
        if (!c.held) return { fail: '投げる物を持っていない' };
        const item = c.held;
        c.held = null;
        const tz = st.def.target.type === 'enemy' && b.perceivedEnemy(c)?.visible ? b.baseZ(b.enemyOf(c)) + 1.2 : null;
        // 投げる威力も腕力で少し変わる
        b.spawnThrown(c, item, c.x, c.y, D.aim.x, D.aim.y, { tz, damage: itemDef(item).throw * (0.7 + c.def.power / 50) });
        b.emit({ text: `${c.name} が${item.name}を投げた！`, kind: 'combat', actor: c, pos: c, sound: 5, soundKind: 'throw' });
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

  open: openClose(true),
  close: openClose(false),

  // 2階の窓から飛び降りる：窓まで行き、閉まっていれば突き破って外へ
  jump_down: {
    start(b, c, st) {
      let o = st.def.target.type === 'object' ? b.objectById(st.def.target.id) : null;
      if (!o) {
        const bd = b.buildingOf(c);
        const wins = bd && c.floor === 1 ? b.world.objects.filter(x => x.kind === 'window' && x.floor === 1 && x.building === bd.id) : [];
        o = wins.sort((a, z) => distToRect(c.x, c.y, a) - distToRect(c.x, c.y, z))[0];
        // 割れて無くなった窓（開口部）も使える
        if (!o && bd && c.floor === 1) {
          const gone = (bd.exits || []).map(id => ({ id })).filter(x => !b.objectById(x.id) && x.id.includes('f2_window'));
          if (gone.length) st.data.goneId = gone[0].id;
        }
        if (!o && !st.data.goneId) return '2階の窓のそばにいない';
      }
      st.data.obj = o;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 6;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const o = D.obj;
      if (!o) return { fail: '窓が見つからない' };
      const bd = b.world.buildings.find(x => x.id === o.building);
      const cc = rectCenter(o);
      if (D.phase === 'approach') {
        const n = nearestPointOnRect(c.x, c.y, o);
        if (c.floor === 1 && dist(c.x, c.y, n.x, n.y) <= 0.75) {
          D.phase = 'jump';
          D.until = b.t + 0.3;
          st.locked = true;
          return 'running';
        }
        const r = approach(b, c, st, n.x, n.y, 0.7, true, 1);
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      if (D.phase === 'jump') {
        faceTo(c, cc.x, cc.y);
        if (b.t < D.until) return 'running';
        // 窓の外側の向き
        const out = o.w > o.h ? { x: 0, y: Math.sign(cc.y - (bd.y + bd.h / 2)) } : { x: Math.sign(cc.x - (bd.x + bd.w / 2)), y: 0 };
        const tx = cc.x + out.x * 1.2, ty = cc.y + out.y * 1.2;
        if (bd.sealed) {
          b.burn(c);
          return { fail: '窓の外は炎の壁で、飛び出せない' };
        }
        if (b.world.objects.includes(o) && !o.open && !o.broken) {
          b.emit({ text: `${c.name} が${o.name}を突き破った！`, kind: 'combat', actor: c, pos: { ...cc, floor: 1 }, sound: 12, soundKind: 'glass' });
          b.destroyObject(o, c);
          b.damage(c, 2, { source: null, kind: 'fall', label: 'ガラス' });
        }
        c.x = tx; c.y = ty;
        b.startDrop(c);
        return 'done';
      }
      return 'done';
    },
  },

  // 落ちている物を拾う
  pickup: {
    start(b, c, st) {
      let item = st.def.target.type === 'object' ? b.world.items.find(i => i.id === st.def.target.id) : null;
      if (!item) {
        item = b.world.items
          .filter(i => (i.floor ?? 0) === c.floor && dist(c.x, c.y, i.x, i.y) < 15)
          .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y))[0];
      }
      if (!item) return '近くに拾える物がない';
      st.data.item = item;
      st.data.deadline = b.t + 6;
      return null;
    },
    update(b, c, st) {
      const it = st.data.item;
      if (!b.world.items.includes(it)) return { fail: `${it.name}はもう無い` };
      if (c.floor === (it.floor ?? 0) && dist(c.x, c.y, it.x, it.y) <= 0.9) {
        if (!st.data.until) { st.data.until = b.t + 0.35; st.locked = true; }
        if (b.t < st.data.until) return 'running';
        b.pickUp(c, it);
        return 'done';
      }
      const r = approach(b, c, st, it.x, it.y, 0.6, st.def.mode === 'run', it.floor ?? 0);
      if (r === 'stuck' || b.t > st.data.deadline) return { fail: `${it.name}に近づけなかった` };
      return 'running';
    },
  },

  // 掴み：近づいて組み付く。ガード・受け流しは効かないが、構えの間に殴られると潰される
  grab: {
    start(b, c, st) {
      c.status.hideUntil = 0;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 2.2;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const e = b.enemyOf(c);
      if (D.phase === 'approach') {
        const pe = resolveTarget(b, c, st.def.target);
        if (pe.error) return { fail: '掴む相手が見えない' };
        const r = approach(b, c, st, pe.x, pe.y, 1.0, true, pe.f);
        if (r === 'arrived') {
          D.phase = 'windup';
          D.until = b.t + 0.4;
          st.locked = true;
          c.windup = { kind: 'grab', until: D.until };
          b.emit({ text: `${c.name} が掴みかかる！`, kind: 'combat', actor: c, pos: c, sound: 3 });
        } else if (r === 'stuck' || b.t > D.deadline) return { fail: '掴める距離まで近づけなかった' };
        return 'running';
      }
      if (D.phase === 'windup') {
        if (b.canSee(c, e.x, e.y)) faceTo(c, e.x, e.y);
        if (b.t < D.until) return 'running';
        c.windup = null;
        const d = dist(c.x, c.y, e.x, e.y);
        if (e.alive && e.floor === c.floor && d <= 1.35 && !b.isAirborne(e) && !e.launch && !(e.status.invulnUntil > b.t)) {
          b.emit({ text: `${c.name} が ${e.name} に組み付いた！ ${e.status.guardUntil > b.t || e.status.counterUntil > b.t ? '（構えごと崩した）' : ''}`, kind: 'combat', actor: c, affected: e, pos: e, sound: 5, soundKind: 'impact' });
          e.status.guardUntil = 0;
          e.status.counterUntil = 0;
          e.status.stunUntil = Math.max(e.status.stunUntil, b.t + 1.2);
          e.status.grabbedUntil = b.t + 1.2;
          e.kbx = e.kby = 0;
          interruptStep(b, e, '組み付かれて動けない', true);
          b.damage(e, 4, { source: c, kind: 'grab', label: '組み付き' });
        } else {
          b.emit({ text: `${c.name} の掴みは空を切った`, kind: 'combat', actor: c, pos: c, sound: 3, soundKind: 'swing' });
          c.status.stunUntil = Math.max(c.status.stunUntil, b.t + 0.3);
        }
        D.phase = 'recover';
        D.until = b.t + 0.25;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },

  // 体当たり：突進して当たれば突き飛ばして転倒、壁なら叩きつけ
  tackle: {
    start(b, c, st) {
      c.status.hideUntil = 0;
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      const a = res.angle ?? angleTo(c.x, c.y, res.x, res.y);
      st.data.dir = { x: Math.cos(a), y: Math.sin(a) };
      st.data.phase = 'charge';
      st.data.until = b.t + 0.15;
      st.locked = true;
      c.facing = a;
      c.windup = { kind: 'tackle', until: st.data.until };
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      if (D.phase === 'charge') {
        if (b.t < D.until) return 'running';
        c.windup = null;
        c.kbx = D.dir.x * 10.6; c.kby = D.dir.y * 10.6;
        c.kbSlam = null;
        D.phase = 'dash';
        D.until = b.t + 0.55;
        b.emit({ text: `${c.name} が体当たりで突っ込む！`, kind: 'combat', actor: c, pos: c, sound: 6, soundKind: 'footsteps_run' });
        return 'running';
      }
      if (D.phase === 'dash') {
        const hitC = b.enemiesOf(c).find(e => e.alive && e.floor === c.floor && dist(c.x, c.y, e.x, e.y) <= c.r + e.r + 0.25 && !b.isAirborne(e) && !e.launch);
        if (hitC) {
          c.kbx = c.kby = 0;
          if (hitC.status.invulnUntil > b.t) {
            b.emit({ text: `${hitC.name} は体当たりをかわした！`, kind: 'combat', actor: c, affected: hitC, pos: hitC });
          } else {
            b.emit({ text: `${c.name} の体当たりが ${hitC.name} を突き飛ばした！`, kind: 'combat', actor: c, affected: hitC, pos: hitC, sound: 8, soundKind: 'impact' });
            hitC.kbx = D.dir.x * 9.2; hitC.kby = D.dir.y * 9.2;
            hitC.kbSlam = { damage: 7, source: c };
            hitC.status.proneUntil = Math.max(hitC.status.proneUntil, b.t + 1.0);
            hitC.status.guardUntil = 0;
            interruptStep(b, hitC, '突き飛ばされた', true);
            b.damage(hitC, 6, { source: c, kind: 'tackle', label: '体当たり' });
          }
          D.phase = 'recover';
          D.until = b.t + 0.3;
          return 'running';
        }
        if (b.t < D.until && Math.hypot(c.kbx, c.kby) > 1) return 'running';
        b.emit({ text: `${c.name} の体当たりは外れ、よろけた`, kind: 'combat', actor: c, pos: c });
        c.status.stunUntil = Math.max(c.status.stunUntil, b.t + 0.6);
        return 'done';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },

  // 受け流し：短い構え。正面から殴られたら打ち返す（判定は sim の damage）
  counter: {
    start(b, c, st) {
      c.status.counterUntil = b.t + 0.8;
      st.data.until = b.t + 0.8;
      st.locked = true;
      return null;
    },
    update(b, c, st) {
      const pe = b.perceivedEnemy(c);
      if (pe && pe.visible) faceTo(c, pe.x, pe.y);
      // 受け流しが決まると構えは消費される（sim の damage で 0 になる）
      if (c.status.counterUntil === 0) return 'done';
      if (b.t < st.data.until) return 'running';
      // 何も来なかった：構えを解く隙
      c.status.counterUntil = 0;
      c.status.stunUntil = Math.max(c.status.stunUntil, b.t + 0.4);
      return 'done';
    },
    end(b, c) { c.status.counterUntil = 0; },
  },

  // フェイント：構えだけ見せる（相手の反射のガードや条件付きの行動を誘う）
  feint: {
    start(b, c, st) {
      c.status.hideUntil = 0;
      st.data.until = b.t + 0.35;
      c.windup = { kind: 'melee', until: st.data.until + 0.3, feint: true };
      b.emit({ text: `${c.name} が拳を振りかぶる`, kind: 'combat', actor: c, pos: c });
      return null;
    },
    update(b, c, st) {
      const pe = b.perceivedEnemy(c);
      if (pe && pe.visible) faceTo(c, pe.x, pe.y);
      if (b.t < st.data.until) return 'running';
      c.windup = null;
      selfLog(b, c, '……と見せかけて、拳を止めた（フェイント）');
      return 'done';
    },
    end(b, c) { if (c.windup && c.windup.feint) c.windup = null; },
  },

  // 潜む：動かずに気配を消す
  hide: {
    start(b, c, st) {
      st.data.until = b.t + st.def.duration;
      c.status.hideUntil = st.data.until;
      selfLog(b, c, '身を潜めて気配を消した');
      return null;
    },
    update(b, c, st) {
      if (c.status.hideUntil <= b.t) return 'done';
      return b.t >= st.data.until ? 'done' : 'running';
    },
    end(b, c) { c.status.hideUntil = 0; },
  },

  // 見回す：一周ぐるりと向きを変える
  search: {
    start(b, c, st) {
      st.data.t0 = b.t;
      st.data.f0 = c.facing;
      return null;
    },
    update(b, c, st) {
      const k = (b.t - st.data.t0) / 1.5;
      c.facing = st.data.f0 + k * Math.PI * 2;
      c.desired.face = c.facing;
      if (k < 1) return 'running';
      const seen = b.enemiesOf(c).filter(e => e.alive && c.memory.seen[e.id] && b.t - c.memory.seen[e.id].t < 1.6);
      selfLog(b, c, seen.length ? `見回して ${seen.map(e => e.name).join('・')} を見つけた` : '見回したが、敵の姿は見えない');
      return 'done';
    },
  },

  // 物音を立てる：小石を投げて離れた所で音を鳴らす
  decoy: {
    start(b, c, st) {
      const res = resolveTarget(b, c, st.def.target, { ...st.def, distance: st.def.distance ?? 8 });
      if (res.error) return res.error;
      let { x, y } = res;
      const d = dist(c.x, c.y, x, y);
      if (d > 12) { x = c.x + ((x - c.x) / d) * 12; y = c.y + ((y - c.y) / d) * 12; }
      st.data.at = { x, y, floor: res.f ?? c.floor };
      st.data.until = b.t + 0.45;
      faceTo(c, x, y);
      return null;
    },
    update(b, c, st) {
      faceTo(c, st.data.at.x, st.data.at.y);
      if (b.t < st.data.until) return 'running';
      const at = st.data.at;
      selfLog(b, c, `小石を投げて(${at.x.toFixed(1)}, ${at.y.toFixed(1)})で物音を立てた`);
      b.puff('dust', { x: at.x, y: at.y, floor: at.floor });
      b.playAt(at, 10, 'impact', c);
      return 'done';
    },
  },

  // 乗り越える：低い障害物の向こう側へ
  vault: {
    start(b, c, st) {
      const o = b.objectById(st.def.target.id);
      if (!o || !b.world.objects.includes(o)) return '乗り越える物が無い';
      st.data.obj = o;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 4;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const o = D.obj;
      const n = nearestPointOnRect(c.x, c.y, o);
      if (D.phase === 'approach') {
        if (dist(c.x, c.y, n.x, n.y) <= c.r + 0.35 && c.floor === o.floor) {
          // 向こう側の着地点：自分から物の中心を通って反対側へ
          const cc = rectCenter(o);
          const a = angleTo(c.x, c.y, cc.x, cc.y);
          const span = Math.abs(Math.cos(a)) * o.w + Math.abs(Math.sin(a)) * o.h;
          const land = nearestWalkable(b.world, cc.x + Math.cos(a) * (span / 2 + c.r + 0.4), cc.y + Math.sin(a) * (span / 2 + c.r + 0.4), 1.2, c.floor);
          if (!land) return { fail: `${o.name}の向こう側に降りる場所がない` };
          D.land = land;
          D.from = { x: c.x, y: c.y };
          D.phase = 'over';
          D.t0 = b.t;
          st.locked = true;
          b.emit({ text: `${c.name} が${o.name}を乗り越える`, kind: 'combat', actor: c, pos: c, sound: 4 });
          return 'running';
        }
        const r = approach(b, c, st, n.x, n.y, c.r + 0.3, st.def.mode === 'run', o.floor);
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      if (D.phase === 'over') {
        const k = Math.min(1, (b.t - D.t0) / 0.7);
        c.x = D.from.x + (D.land.x - D.from.x) * k;
        c.y = D.from.y + (D.land.y - D.from.y) * k;
        c.vx = c.vy = 0;
        return k >= 1 ? 'done' : 'running';
      }
      return 'done';
    },
  },

  // 道具を使う：消火器の煙幕・傘の盾
  use_item: {
    start(b, c, st) {
      const kind = c.held && c.held.kind;
      const hd = c.held ? itemDef(c.held) : null;
      if (hd && hd.heal) {
        st.data.heal = { amount: hd.heal, name: c.held.name };
        st.data.until = b.t + hd.useTime;
        st.locked = true;
        selfLog(b, c, `${c.held.name}を使い始めた（${hd.useTime}秒）`);
        return null;
      }
      if (kind === 'extinguisher') {
        const res = st.def.target.type === 'none' || st.def.target.type === 'self'
          ? { x: c.x + Math.cos(c.facing) * 3, y: c.y + Math.sin(c.facing) * 3, f: c.floor }
          : resolveTarget(b, c, st.def.target, { ...st.def, distance: st.def.distance ?? 3 });
        if (res.error) return res.error;
        const d = dist(c.x, c.y, res.x, res.y);
        const k = d > 4 ? 4 / d : 1;
        const at = { x: c.x + (res.x - c.x) * k, y: c.y + (res.y - c.y) * k };
        b.addZone({ kind: 'smoke', x: at.x, y: at.y, r: 3, floor: c.floor, until: b.t + 8, owner: c.id });
        b.emit({ text: `${c.name} が消火器を噴射した！ 白い煙が辺りを覆う`, kind: 'env', actor: c, pos: c, sound: 8, soundKind: 'crash' });
        c.held = null; // 空になった消火器は捨てる
        st.data.until = b.t + 0.5;
        return null;
      }
      if (kind === 'umbrella') {
        c.status.umbrellaUntil = b.t + 3;
        b.emit({ text: `${c.name} が傘を開いて身構えた`, kind: 'combat', actor: c, pos: c, sound: 3 });
        st.data.until = b.t + 0.3;
        return null;
      }
      return c.held ? `${c.held.name}には特別な使い方がない（回復アイテム・消火器・傘だけ）` : '道具を持っていない（回復アイテム・消火器・傘を先に拾う）';
    },
    update(b, c, st) {
      if (b.t < st.data.until) return 'running';
      if (st.data.heal) {
        if (!c.held) return { fail: '使う前に手放してしまった' };
        c.held = null;
        b.heal(c, st.data.heal.amount, st.data.heal.name);
      }
      return 'done';
    },
  },

  // 操作する：自動販売機・水飲み場・発電機・ゴミ箱・防犯ブザー
  interact: {
    start(b, c, st) {
      const o = b.objectById(st.def.target.id);
      if (!o || !b.world.objects.includes(o)) return '操作する物が無い';
      if (o.kind === 'fountain' && c.cd.fountain) return `水飲み場はまだ使えない（あと${(c.cd.fountain - b.t).toFixed(0)}秒）`;
      if (o.kind === 'vending' && (o.stock ?? 3) <= 0) return `${o.name}は売り切れ`;
      st.data.obj = o;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 6;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const o = D.obj;
      const n = nearestPointOnRect(c.x, c.y, o);
      if (D.phase === 'approach') {
        if (c.floor === o.floor && dist(c.x, c.y, n.x, n.y) <= c.r + 0.5) {
          D.phase = 'use';
          D.until = b.t + ({ vending: 1.5, fountain: 2, generator: 1, trashcan: 0.6 }[o.kind] ?? 0.8);
          st.locked = o.kind === 'vending' || o.kind === 'fountain';
          return 'running';
        }
        const r = approach(b, c, st, n.x, n.y, c.r + 0.4, st.def.mode === 'run', o.floor);
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      faceTo(c, n.x, n.y);
      if (b.t < D.until) return 'running';
      const at = { x: o.x + o.w / 2, y: o.y + o.h / 2, floor: o.floor };
      if (o.kind === 'vending') {
        o.stock = (o.stock ?? 3) - 1;
        const item = makeItem('drink', c.x, c.y, c.floor);
        b.emit({ text: `${c.name} が${o.name}で缶ジュースを買った（残り${o.stock}本）`, kind: 'env', actor: c, pos: at, sound: 5, soundKind: 'impact' });
        if (c.held) b.world.items.push(item); else c.held = { id: item.id, kind: item.kind, name: item.name };
      } else if (o.kind === 'fountain') {
        c.cd.fountain = b.t + 25;
        b.heal(c, 10, '水飲み場の水');
      } else if (o.kind === 'generator') {
        const on = b.world.zones.find(z => z.kind === 'hum' && z.obj === o.id);
        if (on) {
          on.until = b.t;
          b.emit({ text: `${c.name} が${o.name}を止めた`, kind: 'env', actor: c, pos: at, sound: 6, soundKind: 'door' });
        } else {
          b.addZone({ kind: 'hum', obj: o.id, x: at.x, y: at.y, r: 12, floor: o.floor, until: b.t + 45 });
          b.emit({ text: `${c.name} が${o.name}を動かした。ゴウンゴウンとうなり始め、周りの小さな音がかき消される`, kind: 'env', actor: c, pos: at, sound: 14, soundKind: 'crash' });
        }
      } else if (o.kind === 'trashcan') {
        c.status.hideUntil = b.t + 8;
        c.status.deepHide = true;
        selfLog(b, c, `${o.name}の陰に身を縮めて隠れた（動くと解ける）`);
      } else if (o.buzzer) {
        o.alarmUntil = b.t + 6;
        b.emit({ text: `${c.name} が防犯ブザーを鳴らした！ けたたましい音が響き渡る`, kind: 'env', actor: c, pos: at, sound: 40, soundKind: 'alarm' });
      }
      return 'done';
    },
  },

  stand_out: {
    start(b, c, st) {
      b.standOut(c).goal = {};
      st.data.until = b.t + 0.2;
      return null;
    },
    update(b, c, st) { return b.t >= st.data.until ? 'done' : 'running'; },
  },

  stand_move: {
    start(b, c, st) {
      const res = resolveTarget(b, c, st.def.target, st.def);
      if (res.error) return res.error;
      const s = b.standOut(c);
      s.goal = { x: res.x, y: res.y, char: res.char || null };
      selfLog(b, c, `『${c.stand}』を${targetName(b, st.def.target)}の方へ先行させる（射程${c.def.standRange}m）`);
      st.data.until = b.t + 0.4;
      return null;
    },
    update(b, c, st) { return b.t >= st.data.until ? 'done' : 'running'; },
  },

  stand_in: {
    start(b, c, st) {
      if (c.standBody) {
        c.standBody = null;
        b.emit({ text: `${c.name} は『${c.stand}』を戻した`, obsText: `${c.name} のスタンドが消えた`, kind: 'stand', actor: c, pos: c });
      }
      st.data.until = b.t + 0.2;
      return null;
    },
    update(b, c, st) { return b.t >= st.data.until ? 'done' : 'running'; },
  },

  drop: {
    start(b, c) {
      if (!c.held) return '何も持っていない';
      b.dropHeld(c);
      return null;
    },
    update() { return 'done'; },
  },

  // 体やすぐそばの小さなスタンドを払い潰す
  swat: {
    start(b, c, st) {
      st.data.until = b.t + 0.5;
      st.locked = true;
      return null;
    },
    update(b, c, st) {
      if (b.t < st.data.until) return 'running';
      const n = b.swatUnits(c);
      selfLog(b, c, n ? `小さな何かを${n}体払い潰した` : '払ったが、何も手応えがない');
      return 'done';
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
        D.until = b.t + 0.1;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  },
};

function pe0(b, c) {
  const pe = b.perceivedEnemy(c);
  return pe && pe.visible;
}

// 殴る距離・威力：持った物の方が強ければそれで殴る（リーチも伸びる）
function meleeRange(c) {
  const base = c.def.meleeRange ?? RULES.meleeRange;
  const it = c.held ? itemDef(c.held) : null;
  if (it && weaponMelee(c) > c.def.power) return base + it.reach;
  // 出しているスタンドは敵へ飛び出して殴るので、射程の分だけ届く
  return c.standBody ? base + (c.def.standRange || 0) * 0.5 : base;
}

function weaponMelee(c) {
  const it = c.held ? itemDef(c.held) : null;
  return it ? it.melee * strengthScale(c) : 0;
}

function meleePower(c) {
  return Math.max(c.def.power, weaponMelee(c));
}

// 次の手順を敵に対して実行できる距離（追尾の終了判定に使う）
function reachFor(next, c) {
  if (next.target.type !== 'enemy') return null;
  if (next.action === 'melee') return meleeRange(c) - 0.2;
  if (next.action === 'throw') return 10;
  if (next.action === 'ability') {
    const ab = ABILITIES[next.ability];
    return Math.max(1, (ab.effects[next.effect].range ?? ab.range) - 0.5);
  }
  return null;
}

// 扉・窓の開け閉め（閉める時、錠二なら密室の成立を判定する）
function openClose(open) {
  return {
    start(b, c, st) {
      const o = b.objectById(st.def.target.id);
      if (!o) return open ? '既に壊れていて開いている' : '壊れていて閉められない';
      if (!!o.open === open) return open ? `${o.name}は既に開いている` : `${o.name}は既に閉まっている`;
      st.data.obj = o;
      st.data.phase = 'approach';
      st.data.deadline = b.t + 6;
      return null;
    },
    update(b, c, st) {
      const D = st.data;
      const o = D.obj;
      if (!b.world.objects.includes(o)) return { fail: '対象が壊れた' };
      const n = nearestPointOnRect(c.x, c.y, o);
      if (D.phase === 'approach') {
        // スタンドを出していれば、スタンドの手が届く所（射程の分だけ遠く）から素早く開け閉めできる
        const reach = 1.0 + (c.standBody ? c.def.standRange || 0 : 0);
        // スタンドは壁をすり抜けるので、出していれば壁越しの扉にも手が届く
        if (c.floor === o.floor && dist(c.x, c.y, n.x, n.y) <= reach && (c.standBody || hasLOS(b.world, c.x, c.y, n.x, n.y))) {
          D.phase = 'act';
          D.until = b.t + (c.standBody ? 0.15 : 0.35);
          st.locked = true;
          return 'running';
        }
        // 閉める時は部屋の内側から（自分が今いる側）近づく
        const r = approach(b, c, st, n.x, n.y, 0.9, st.def.mode === 'run', o.floor);
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      if (D.phase === 'act') {
        faceTo(c, n.x, n.y);
        if (b.t < D.until) return 'running';
        if (!!o.open === open) return 'done';
        if (!b.setOpen(o, open, c)) return { fail: open ? '開けられなかった' : '人がいて閉められない' };
        return 'done';
      }
      return 'done';
    },
  };
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
        if (distToRect(c.x, c.y, o) <= 0.75 && c.floor === o.floor) {
          D.phase = 'act';
          D.until = b.t + 0.3;
          st.locked = true;
          return 'running';
        }
        const r = approach(b, c, st, n.x, n.y, 0.7, st.def.mode === 'run', o.floor);
        if (r === 'stuck' || b.t > D.deadline) return { fail: `${o.name}に近づけなかった` };
        return 'running';
      }
      if (D.phase === 'act') {
        faceTo(c, n.x, n.y);
        if (b.t < D.until) return 'running';
        const cc = rectCenter(o);
        const a = angleTo(c.x, c.y, cc.x, cc.y) + (sign < 0 ? Math.PI : 0);
        const sp = (sign > 0 ? 7 : 4) / (o.mass || 1);
        o.vx = Math.cos(a) * sp;
        o.vy = Math.sin(a) * sp;
        o.pushedBy = c.id;
        b.emit({ text: `${c.name} が${o.name}を${sign > 0 ? '押し出した' : '引き寄せた'}`, kind: 'env', actor: c, pos: { ...cc, floor: o.floor }, sound: 6 });
        D.phase = 'recover';
        D.until = b.t + 0.3;
        return 'running';
      }
      return b.t >= D.until ? 'done' : 'running';
    },
  };
}

function startStep(b, c, def) {
  if (def.target.type === 'enemy' && def.target.charId) c.focusId = def.target.charId;
  const st = { def, phase: def.condition ? 'cond' : 'run', t0: b.t, data: {}, locked: false };
  c.runner.step = st;
  if (st.phase === 'run') beginRun(b, c, st);
}

function beginRun(b, c, st) {
  // 攻撃や能力を始めると、潜んでいた気配は解ける
  if (['melee', 'throw', 'ability', 'grab', 'tackle', 'feint', 'decoy'].includes(st.def.action)) c.status.hideUntil = 0;
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
  if (c.launch || c.climb) return;
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
