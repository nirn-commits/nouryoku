// 観測情報の構築：AI（プレイヤー入力の解析・CPUの作戦）に渡すのは「その人物が知り得る情報」だけ
import { ABILITIES, ACTIONS, CONDITIONS, DIRECTIONS, RULES } from './data.js';
import { dist, rectCenter, distToRect } from './vec.js';
import { ITEM_KINDS, meleeWith } from './items.js';

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
  if (c.climb) s.push('階段を上り下り中');
  if (c.status.deafUntil > t) s.push('耳が聞こえない');
  if (c.status.proneUntil > t) s.push('転倒中');
  if (c.status.stunUntil > t) s.push('怯み');
  if (c.status.guardUntil > t) s.push('ガード中');
  if (c.status.counterUntil > t) s.push('受け流しの構え');
  if (c.status.umbrellaUntil > t) s.push('傘を開いて構えている');
  if (c.status.grabbedUntil > t) s.push('組み付かれて動けない');
  if (c.status.hideUntil > t) s.push('身を潜めている');
  if (c.uplifted) s.push('打ち上げられて落下中');
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
    const item = { id: bd.id, name: bd.name, kind: 'building', at: [r1(bd.x + bd.w / 2), r1(bd.y + bd.h / 2)], size: [bd.w, bd.h], floors: bd.floors };
    // 出口（扉・窓）のうち開いている数（壊れた出口は開いた扱い）。個々の出口は近くの物として載る
    item.exits_open = `${bd.exits.filter(id => { const o = b.objectById(id); return !o || o.open; }).length}/${bd.exits.length}`;
    if (bd.sealed) item.sealed = '密室（外周を炎が囲んでいる。人も飛び道具も出入りできない）';
    out.push(item);
  }
  for (const a of b.world.areas) {
    out.push({ id: a.id, name: a.name, kind: 'area', at: [r1(a.x + a.w / 2), r1(a.y + a.h / 2)], size: [r1(a.w), r1(a.h)], ...(a.floor ? { floor: a.floor } : {}) });
  }
  for (const o of b.world.objects) {
    if (o.id.startsWith('outer_')) continue;
    const cc = rectCenter(o);
    const exit = o.kind === 'door' || o.kind === 'window' || o.kind === 'stairs';
    if (c) {
      const d = dist(c.x, c.y, cc.x, cc.y);
      const wallLike = o.kind === 'wall';
      if (d > (wallLike ? 10 : exit ? 22 : 20)) continue;
      if (wallLike && o.floor !== c.floor) continue; // 別の階の壁は省く
    }
    const item = { id: o.id, name: o.name, kind: o.kind, at: [r1(cc.x), r1(cc.y)] };
    if (o.floor) item.floor = o.floor;
    if (o.kind === 'door' || o.kind === 'window') item.state = o.openable ? (o.open ? 'open' : 'closed') : 'fixed';
    // 窓はガラスの状態も別に持つ（割れていれば枠が閉まっていても通れる。密室の判定は枠の開閉）
    if (o.kind === 'window') item.glass = o.broken ? 'broken' : 'intact';
    if (o.height >= 0.5 && o.kind !== 'wall' && !exit) item.height = o.height;
    if (o.kind === 'wall' || o.kind === 'hole' || o.kind === 'bush') item.size = [r1(o.w), r1(o.h)];
    if (o.kind === 'wall' && o.style === 'block') item.height = o.height;
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
      window: '窓。枠の開閉（state）とガラス（glass）を別に持つ。視線は通す。枠が開いているかガラスが割れていれば通り抜けられる。ガラスが割れても枠は閉められ、密室の判定は枠が閉まっているかで決まる（はめ殺しのガラスは割れても閉まった扱い）',
      bush: '植え込み。通れるが遅く音が出る。中にいると2.5m以内に近づかれない限り見つからない（中から外は見える）',
      car: '車。遮蔽物になる。衝撃を与えると防犯アラームが鳴り、遠くまで聞こえる（陽動に使える）',
      hole: '掘削穴。通れないが視線は通る',
      movable: '木箱・ドラム缶・商品棚・自販機・机・三角コーンは押せる（重い物ほど動きにくい）',
      area: 'kind=area は区域。move の対象にすると中心付近へ向かう。「〇〇の2階」の区域を対象にすると階段を使って2階へ行く',
      floors: '高さがある。1階分は3m。2階建ての家は階段で上り下りする（約1秒）。床・天井は階をまたぐ視線を遮る。2階の窓からは塀や車越しに道路を見下ろせ、地上からは低い塀（1.8m）や車（1.5m）の陰に隠れられる。飛び道具も高さを持ち、2階から投げ下ろせる',
      door: '扉は閉まっていると通れず見通せない。歩いてぶつかると自動で開ける（少し手間取る）。open/close で開け閉めできる。窓も開け閉めでき、開いた窓は通り抜けられる（コンビニのガラス窓は開かず、割るしかない）',
      jump_down: '2階の窓から jump_down で外へ飛び降りられる（着地の衝撃あり）',
      items: '戦場に落ちている物（items_seen）は pickup で拾って持てる（1つまで）。持った物の方が強ければ melee はそれで殴る。throw は持った物を投げる（初めは誰も何も持っていない）',
      point_floor: 'point を2階の地点にしたい時は floor=1 を付ける',
      close_combat: '近接の読み合い：殴り(melee)は掴み(grab)の構えを潰す／掴みはガード・受け流しを崩す／受け流し(counter)は正面からの殴りを打ち返す。フェイント(feint)で相手の構えや回避を空振りさせられる。体当たり(tackle)は突き飛ばして転倒させる',
      stealth: '潜む(hide)と6mより遠くから見つからない（動くと解ける）。物音を立てる(decoy)で離れた所に音を出して誘える。煙幕（消火器の use_item）は視線を遮る',
    },
  };
}

// エコー・ビーチの個体の状況（本人だけが知っている）
function unitSummary(b, c) {
  const alive = c.units.filter(u => u.state !== 'dead');
  const e = b.enemyOf(c);
  const kindOf = snd => (!snd ? null : snd.kind === 'speech' ? `声「${snd.text}」` : b.isLoud(snd) ? `大きな音（${snd.label}）` : snd.kind.startsWith('footsteps') ? `足音（${snd.label}）` : snd.label);
  return {
    alive: alive.length,
    crushed: c.units.length - alive.length,
    on_self: alive.filter(u => u.state === 'attached' && u.attachedTo === c.id).length,
    at_hand: alive.filter(u => u.state === 'home').length,
    deployed: alive.filter(u => u.state === 'deployed').map(u => ({ n: u.n, at: [r1(u.x), r1(u.y)], holding: kindOf(u.sound) })),
    moving: alive.filter(u => ['move', 'place', 'roar', 'scratch', 'recall'].includes(u.state)).length,
    near_enemy: alive.filter(u => u.state === 'deployed' && e.alive && u.floor === e.floor && dist(u.x, u.y, e.x, e.y) < 1.5).length,
    held_sounds: alive.filter(u => u.sound).map(u => kindOf(u.sound)),
    loud_sounds: alive.filter(u => b.isLoud(u.sound)).length,
  };
}

export function buildObservation(b, c) {
  const e = b.enemyOf(c);
  const visible = e.alive && b.canSee(c, e.x, e.y);
  const bd = b.buildingOf(c);
  const self = {
    name: c.name, stand: c.stand,
    pos: [r1(c.x), r1(c.y)], floor: c.floor + 1, facing_deg: deg(c.facing),
    hp: Math.round(c.hp), maxHp: c.maxHp, sp: Math.round(c.sp), held: c.held ? `${c.held.name}（殴る${meleeWith(c, c.held.kind)}・素手${c.def.power}・投げる${ITEM_KINDS[c.held.kind].throw}${ITEM_KINDS[c.held.kind].breaks ? '・割れ物' : ''}）` : null, kg: c.def.kg,
    touching: b.world.objects.filter(o => o.blocksMove && distToRect(c.x, c.y, o) <= c.r + 0.6).map(o => o.id),
    inside: bd ? `${bd.name}の${c.floor + 1}階${bd.sealed ? '（密室：炎に囲まれている）' : ''}` : '屋外',
    status: stateWords(b, c),
    cooldowns: Object.fromEntries(Object.entries(c.cd).map(([k, v]) => [k, r1(v - b.t)])),
    stand: c.def.standRange ? (c.standBody ? { out: true, pos: [r1(c.standBody.x), r1(c.standBody.y)], range: c.def.standRange, note: '出している間はスタンドエネルギーが回復しない' } : { out: false, range: c.def.standRange }) : { note: '群体のスタンドなので stand_out / stand_move は使えない' },
    ...(c.def.balls ? { balls: c.balls } : {}),
    ...(c.units ? { echo_units: unitSummary(b, c) } : {}),
    ...(c.memory.suspectAttached ? { notice: '自分の足音や声が消えている。体に何か小さな物が取り付いているかもしれない（swat で払える）' } : {}),
    abilities: abilityCatalog(c),
  };
  const describeEnemy = e => {
    if (!e.alive) return { id: e.id, name: e.name, stand: e.stand, status: '再起不能' };
    if (b.canSee(c, e.x, e.y)) {
      const ebd = b.buildingOf(e);
      return {
        id: e.id, name: e.name, visible: true, pos: [r1(e.x), r1(e.y)], floor: e.floor + 1, distance: r1(dist(c.x, c.y, e.x, e.y)),
        facing_deg: deg(e.facing), condition: hpWord(e), state: stateWords(b, e), inside: ebd ? `${ebd.name}の${e.floor + 1}階` : '屋外',
        ...(e.standBody ? { stand_out_at: [r1(e.standBody.x), r1(e.standBody.y)] } : {}),
      };
    }
    const ls = c.memory.seen[e.id];
    return {
      id: e.id, name: e.name, visible: false,
      last_seen: ls ? { pos: [r1(ls.x), r1(ls.y)], floor: (ls.floor ?? 0) + 1, seconds_ago: r1(b.t - ls.t), ...(ls.via ? { reported_by: ls.via } : {}) } : null,
    };
  };
  const enemy = describeEnemy(e);
  const team = b.teamSize > 1;
  // 味方とは連絡を取り合っているので、位置と様子は分かる
  const allies = b.alliesOf(c).map(a => a.alive ? {
    id: a.id, name: a.name, stand: a.stand, pos: [r1(a.x), r1(a.y)], floor: a.floor + 1, distance: r1(dist(c.x, c.y, a.x, a.y)),
    hp: Math.round(a.hp), maxHp: a.maxHp, held: a.held ? a.held.name : null, target: a.alive ? b.enemyOf(a).name : null,
    abilities: a.def.abilities.map(id => ABILITIES[id].name),
  } : { id: a.id, name: a.name, status: '再起不能' });
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
  const recent = b.log
    .filter(l => l.visibleTo.has(c.id) && b.t - l.t < 12)
    .slice(-10)
    .map(l => `${r1(l.t)}s ${l.actor === c.id ? l.text : l.obsText || l.text}`);

  return {
    time: r1(b.t),
    // ガン待ち対策の時間制限：警察到着時点で、相手に与えたダメージが多い側の判定勝ち（同点は引き分け＝両者の負け扱い）
    time_limit: {
      police_arrives_in: r1(Math.max(0, RULES.timeLimit - b.t)),
      damage_dealt: { my_team: b.teamDealt(c.team), enemy_team: b.teamDealt(1 - c.team) },
      note: '警察が来た時点でダメージを多く与えていた側の判定勝ち。待っているだけでは勝てない',
    },
    self,
    ...(team ? { mode: '2対2のチーム戦。enemies の全員を倒せば勝ち。味方（allies）と協力する。targetType=enemy の targetId に敵の id を入れると狙う敵を選べる。targetType=ally で味方の所へ移動できる', enemies: b.enemiesOf(c).map(describeEnemy), allies } : {}),
    enemy,
    heard,
    visible_projectiles: projectiles,
    // 場の仕掛け：見えている煙幕・撒かれた玉、味方の無音の結界
    zones: b.world.zones
      .filter(z => (z.team !== undefined && z.team === c.team) || (z.kind !== 'silence' && b.canSee(c, z.x, z.y, (z.floor ?? 0) * 3 + 0.3)) || dist(c.x, c.y, z.x, z.y) < z.r + 1)
      .map(z => ({ kind: { smoke: '煙幕（視線を遮る）', caltrops: '床に撒かれた玉（走ると転ぶ）', silence: '無音の結界（中の音が消える）' }[z.kind] || z.kind, at: [r1(z.x), r1(z.y)], radius: z.r, seconds_left: r1(z.until - b.t), ...(z.team !== undefined ? { mine: z.team === c.team } : {}) })),
    // 拾える物（見えている物だけ）。pickup の targetId に id を使う
    items_seen: b.world.items
      .filter(i => dist(c.x, c.y, i.x, i.y) < 25 && b.canSee(c, i.x, i.y, (i.floor ?? 0) * 3 + 0.3))
      .slice(0, 10)
      .map(i => ({ id: i.id, name: i.name, at: [r1(i.x), r1(i.y)], ...(i.floor ? { floor: i.floor + 1 } : {}), melee_for_me: meleeWith(c, i.kind), my_fist: c.def.power, throw: ITEM_KINDS[i.kind].throw })),
    observed_enemy_abilities: c.memory.observed.slice(),
    recent_events: recent,
    map: { size: [b.world.w, b.world.h], landmarks: landmarks(b, c), note: '細かい物体は近く（約25m以内）のものだけ載っている' },
  };
}
