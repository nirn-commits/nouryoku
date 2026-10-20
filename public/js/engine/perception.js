// 観測情報の構築：AI（プレイヤー入力の解析・CPUの作戦）に渡すのは「その人物が知り得る情報」だけ
import { ABILITIES, ACTIONS, CONDITIONS, DIRECTIONS, RULES } from './data.js';
import { dist, rectCenter, distToRect } from './vec.js';

const r1 = v => Math.round(v * 10) / 10;
const deg = a => Math.round((((a * 180) / Math.PI) % 360 + 360) % 360);

function hpWord(c) {
  const p = c.hp / c.maxHp;
  return p > 0.7 ? '余裕がある' : p > 0.4 ? '傷を負っている' : p > 0.15 ? '深手を負っている' : '瀕死';
}

function stateWords(b, c) {
  const s = [];
  const t = b.t;
  if (c.air && c.air.landAt > t) s.push(`空中（あと${(c.air.landAt - t).toFixed(1)}秒で落下・着地）`);
  if (c.launch) s.push('弾き出されて高速移動中');
  if (c.status.proneUntil > t) s.push('転倒中');
  if (c.status.stunUntil > t) s.push('怯み');
  if (c.status.guardUntil > t) s.push('ガード中');
  if (c.windup) s.push(c.windup.kind === 'melee' ? '殴りかかる構え' : c.windup.kind === 'throw' ? '投擲の構え' : '何かを発動しようとしている');
  const sp = Math.hypot(c.vx, c.vy);
  if (sp > c.def.walk + 0.3) s.push('走っている');
  else if (sp > 0.5) s.push('歩いている');
  else s.push('静止');
  return s;
}

// AI に渡す地形情報。建物・区域・扉は常に、細かい物体は観測者の近くのものだけ（トークン節約）
export function landmarks(b, c = null) {
  const out = [];
  for (const bd of b.world.buildings) {
    out.push({ id: bd.id, name: bd.name, kind: 'building', at: [r1(bd.x + bd.w / 2), r1(bd.y + bd.h / 2)], size: [bd.w, bd.h] });
    for (const d of bd.doors) out.push({ id: d.id, name: d.name, kind: 'door', at: [r1(d.x), r1(d.y)] });
  }
  for (const a of b.world.areas) {
    out.push({ id: a.id, name: a.name, kind: 'area', at: [r1(a.x + a.w / 2), r1(a.y + a.h / 2)], size: [r1(a.w), r1(a.h)] });
  }
  for (const o of b.world.objects) {
    if (o.id.startsWith('outer_')) continue;
    const cc = rectCenter(o);
    if (c) {
      const d = dist(c.x, c.y, cc.x, cc.y);
      const wallLike = o.kind === 'wall' && !o.created;
      if (d > (wallLike ? 12 : 25)) continue;
    }
    const item = { id: o.id, name: o.name, kind: o.kind, at: [r1(cc.x), r1(cc.y)] };
    if (o.kind === 'wall' || o.kind === 'hole' || o.kind === 'bush') item.size = [r1(o.w), r1(o.h)];
    if (!o.indestructible) item.hp = Math.max(0, Math.round(o.hp));
    if (o.movable) { item.movable = true; if (o.kg) item.kg = o.kg; }
    out.push(item);
  }
  return out;
}

export function abilityCatalog(c) {
  return c.def.abilities.map(id => {
    const a = ABILITIES[id];
    return {
      id, name: a.name, desc: a.desc, activation: a.activation, range: a.range, castTime: a.castTime,
      cooldown: a.cooldown, cost: a.cost, weakness: a.weakness,
      effects: Object.entries(a.effects).map(([k, e]) => ({ id: k, name: e.name, targets: e.targets, desc: e.desc })),
    };
  });
}

export function rulesSummary() {
  return {
    units: 'メートル。x は右へ、y は下（手前）へ増える。左上が(0,0)',
    actions: Object.entries(ACTIONS).map(([id, a]) => ({ id, name: a.name, desc: a.desc, targetTypes: a.targets })),
    conditions: CONDITIONS,
    directions: DIRECTIONS,
    budget: `1回の計画は最大${RULES.maxSteps}手順・見積もり${RULES.budgetSeconds}秒まで。超過分は実行されない`,
    vision: `視界は前方${Math.round((RULES.visionFov * 180) / Math.PI)}°・${RULES.visionRange}mで壁に遮られる（窓・机は視線を通す）。${RULES.nearAwareness}m以内は背後でも気配で分かる`,
    melee: `近接攻撃の射程${RULES.meleeRange}m、振りかぶり${RULES.meleeWindup}秒（その間に避けられうる）`,
    environment: {
      wall: '壁・塀・柱。移動も視線も遮る。壊せる（外壁は不可）',
      window: '窓・ガラス。視線は通す。割れると通り抜けられる',
      bush: '植え込み。通れるが遅く音が出る。中にいると2.5m以内に近づかれない限り見つからない（中から外は見える）',
      car: '車。遮蔽物になる。衝撃を与えると防犯アラームが鳴り、遠くまで聞こえる（陽動に使える）',
      hole: '掘削穴。通れないが視線は通る',
      movable: '木箱・ドラム缶・商品棚・自販機・机・三角コーンは押せる（重い物ほど動きにくい）',
      area: 'kind=area は区域。move の対象にすると中心付近へ向かう',
    },
  };
}

export function buildObservation(b, c) {
  const e = b.enemyOf(c);
  const visible = e.alive && b.canSee(c, e.x, e.y);
  const bd = b.buildingOf(c);
  const self = {
    name: c.name, stand: c.stand,
    pos: [r1(c.x), r1(c.y)], facing_deg: deg(c.facing),
    hp: Math.round(c.hp), maxHp: c.maxHp, sp: Math.round(c.sp), knives: c.knives, kg: c.def.kg,
    touching: b.world.objects.filter(o => o.blocksMove && distToRect(c.x, c.y, o) <= c.r + 0.6).map(o => o.id),
    inside: bd ? bd.name : '屋外',
    status: stateWords(b, c),
    cooldowns: Object.fromEntries(Object.entries(c.cd).map(([k, v]) => [k, r1(v - b.t)])),
    deaf: c.status.deafUntil > b.t,
    abilities: abilityCatalog(c),
  };
  let enemy;
  if (visible) {
    const ebd = b.buildingOf(e);
    enemy = {
      name: e.name, visible: true, pos: [r1(e.x), r1(e.y)], distance: r1(dist(c.x, c.y, e.x, e.y)),
      facing_deg: deg(e.facing), condition: hpWord(e), state: stateWords(b, e), inside: ebd ? ebd.name : '屋外',
    };
  } else {
    const ls = c.memory.lastSeen;
    enemy = {
      name: e.name, visible: false,
      last_seen: ls ? { pos: [r1(ls.x), r1(ls.y)], seconds_ago: r1(b.t - ls.t) } : null,
    };
  }
  const heard = c.memory.heard
    .filter(h => b.t - h.t < 10)
    .slice(-8)
    .map(h => ({
      kind: h.kind, approx_pos: [r1(h.x), r1(h.y)], seconds_ago: r1(b.t - h.t),
      ...(h.kind === 'speech' && h.text ? { words: h.text } : {}),
    }));
  const projectiles = b.world.projectiles
    .filter(p => b.canSee(c, p.x, p.y))
    .map(p => ({ id: p.id, kind: p.kind, pos: [r1(p.x), r1(p.y)], velocity: [r1(p.vx), r1(p.vy)], mine: p.owner === c.id }));
  const zones = b.world.zones
    .filter(z => z.owner === c.id || (z.kind !== 'silence' && b.canSee(c, z.x, z.y)))
    .map(z => ({ kind: z.kind, pos: [r1(z.x), r1(z.y)], radius: z.r, mine: z.owner === c.id, remaining: r1(z.until - b.t) }));
  const recent = b.log
    .filter(l => l.visibleTo.has(c.id) && b.t - l.t < 12)
    .slice(-10)
    .map(l => `${r1(l.t)}s ${l.actor === c.id ? l.text : l.obsText || l.text}`);

  return {
    time: r1(b.t),
    self,
    enemy,
    heard,
    visible_projectiles: projectiles,
    known_zones: zones,
    knives_on_ground: b.world.pickups.filter(p => b.canSee(c, p.x, p.y)).map(p => [r1(p.x), r1(p.y)]),
    observed_enemy_abilities: c.memory.observed.slice(),
    recent_events: recent,
    map: { size: [b.world.w, b.world.h], landmarks: landmarks(b, c), note: '細かい物体は近く（約25m以内）のものだけ載っている' },
  };
}
