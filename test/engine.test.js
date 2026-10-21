import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../public/js/engine/sim.js';
import { TurnController } from '../public/js/engine/controller.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { buildObservation } from '../public/js/engine/perception.js';
import { localParse } from '../public/js/engine/localParser.js';
import { findPath, isWalkablePoint, nearestWalkable } from '../public/js/engine/world.js';
import { makeItem } from '../public/js/engine/items.js';
import { dist, pointInRect } from '../public/js/engine/vec.js';

// 双方ローカル思考でターン制の戦闘を進める
async function playTurns(b, maxTurns) {
  const tc = new TurnController(b);
  while (!b.over && tc.turn <= maxTurns) {
    assert.equal(tc.phase, 'input');
    const t0 = b.t;
    const playerPlan = compilePlan(b, b.player, localCpuPlan(b, b.player));
    assert.equal(b.t, t0, '入力ターン中に時間が進んだ');
    await tc.commit(playerPlan);
    while (tc.phase === 'execute') tc.step();
  }
  return tc;
}

test('ターン制で CPU 同士の戦闘が例外なく決着する', async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const ids = ['sogo', 'kito'];
    const b = new Battle({ seed, playerChar: ids[seed % 2], cpuChar: ids[(seed >> 1) % 2], mapId: seed % 3 ? 'town' : 'lot' });
    const tc = await playTurns(b, 80);
    assert.ok(b.over, `seed ${seed}（${b.mapId}）が80手以内に決着しない`);
    assert.equal(tc.phase, 'over');
    for (const c of b.chars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
  }
});

test('CPU の計画は入力ターン開始時点で立てられ、プレイヤーの計画を参照しない', async () => {
  const b = new Battle({ seed: 4 });
  let seen = null;
  const tc = new TurnController(b, { cpuRemote: async obs => { seen = JSON.stringify(obs); return { interpretation: '', steps: [{ action: 'wait', targetType: 'none', duration: 1 }], rejected: [] }; } });
  await new Promise(r => setTimeout(r, 0));
  assert.ok(seen, '入力ターン開始時に CPU が考え始めていない');
  const plan = compilePlan(b, b.player, { interpretation: '極秘の奇襲', steps: [{ action: 'wait', targetType: 'none', duration: 1 }] });
  await tc.commit(plan);
  assert.ok(!seen.includes('極秘の奇襲'));
  assert.equal(tc.phase, 'execute');
  while (tc.phase === 'execute') tc.step();
  assert.equal(tc.phase, 'input');
  assert.equal(tc.turn, 2);
});

test('追尾は動く敵を追いかけ、間合いに入ったら次の攻撃に移る', () => {
  const b = new Battle({ seed: 9, playerChar: 'sogo', cpuChar: 'kito', mapId: 'lot' });
  b.world.objects = b.world.objects.filter(o => o.kind !== 'crate');
  b.player.x = 6; b.player.y = 19; b.player.facing = 0;
  b.cpu.x = 12; b.cpu.y = 19; b.cpu.facing = 0;
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'move', mode: 'walk', targetType: 'point', x: 20, y: 19 }] }));
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'chase', targetType: 'enemy', mode: 'run' }, { action: 'melee', targetType: 'enemy' }] }));
  let hit = false;
  for (let i = 0; i < 30 * 8 && !hit; i++) {
    b.step();
    hit = b.cpu.hp < b.cpu.maxHp;
  }
  assert.ok(b.cpu.x > 14, '敵が動いていない');
  assert.ok(hit, '追いついて殴れていない');
});

test('存在しない能力・他人の能力・戦場外の地点は計画から除外される', () => {
  const b = new Battle({ seed: 3, playerChar: 'sogo', cpuChar: 'kito', mapId: 'lot' });
  const plan = compilePlan(b, b.player, {
    interpretation: 't',
    steps: [
      { action: 'ability', ability: 'time_stop', targetType: 'self' },
      { action: 'ability', ability: 'hotel', effect: 'seal', targetType: 'object', targetId: 'house_left_door' },
      { action: 'move', targetType: 'point', x: 999, y: 5 },
      { action: 'fly', targetType: 'none' },
      { action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'self' },
      { action: 'look', targetType: 'enemy' },
    ],
    rejected: [],
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].action, 'look');
  assert.equal(plan.rejected.length, 5);
});

test('行動予算を超えた手順は切り捨てられる', () => {
  const b = new Battle({ seed: 3, mapId: 'lot' });
  const steps = Array.from({ length: 9 }, () => ({ action: 'guard', targetType: 'none', duration: 3 }));
  const plan = compilePlan(b, b.player, { steps });
  assert.ok(plan.budget <= 10 + 1e-9);
  assert.ok(plan.truncated.length > 0);
  assert.ok(plan.steps.length <= 5);
});

test('CPU の観測には、見えていない敵の現在位置もプレイヤーの計画も含まれない', () => {
  const b = new Battle({ seed: 5, mapId: 'lot' });
  const secret = '秘密の作戦テキスト';
  const plan = compilePlan(b, b.player, { interpretation: secret, speech: null, steps: [{ action: 'wait', targetType: 'none', duration: 3 }] });
  b.setPlan(b.player, plan);
  b.step();
  assert.ok(!b.canSee(b.cpu, b.player.x, b.player.y), '初期配置で互いが見えていない前提');
  const obs = JSON.stringify(buildObservation(b, b.cpu));
  assert.ok(!obs.includes(secret));
  const o = buildObservation(b, b.cpu);
  assert.equal(o.enemy.visible, false);
  assert.equal(o.enemy.pos, undefined);
  assert.equal(o.observed_enemy_abilities.length, 0);
});

test('建物の外から中への経路は壁を通らない', () => {
  const b = new Battle({ seed: 7, mapId: 'lot' });
  const p = findPath(b.world, 2.5, 21, 8, 6.5);
  assert.ok(p && !p.partial);
  let px = 2.5, py = 21;
  for (const q of p.points) {
    const n = Math.ceil(Math.hypot(q.x - px, q.y - py) / 0.1);
    for (let i = 1; i <= n; i++) {
      const x = px + ((q.x - px) * i) / n, y = py + ((q.y - py) * i) / n;
      assert.ok(isWalkablePoint(b.world, x, y), `(${x.toFixed(2)}, ${y.toFixed(2)}) が通行不可`);
    }
    px = q.x; py = q.y;
  }
});

test('ローカル解析：仕様書の入力例', () => {
  const b = new Battle({ seed: 1, playerChar: 'sogo', cpuChar: 'kito', mapId: 'lot', randomSpawn: false });
  b.player.memory.lastSeen = { x: 20, y: 10, floor: 0, t: 0 };
  const p1 = compilePlan(b, b.player, localParse(b, b.player, '左の家に駆け込み、窓から敵の位置を確認する'));
  assert.deepEqual(p1.steps.map(s => s.action), ['move', 'move', 'look']);
  const p4 = compilePlan(b, b.player, localParse(b, b.player, '敵を追いかけて殴る'));
  assert.deepEqual(p4.steps.map(s => s.action), ['chase', 'melee']);
  const p2 = compilePlan(b, b.player, localParse(b, b.player, '敵が近づいてきたら、能力で弾き出す'));
  assert.equal(p2.steps[0].ability, 'perpendicular');
  assert.equal(p2.steps[0].condition.kind, 'enemy_within');
  const p3 = compilePlan(b, b.player, localParse(b, b.player, '「覚悟しろ」と叫んで時間を止める'));
  assert.equal(p3.speech, '覚悟しろ');
  assert.ok(p3.rejected.some(r => r.includes('時間を止める')));
  const p5 = compilePlan(b, b.player, localParse(b, b.player, '左の家の2階へ上がって、2階の窓から飛び降りる'));
  assert.deepEqual(p5.steps.map(s => s.action), ['move', 'jump_down']);
  assert.equal(p5.steps[0].target.id, 'house_left_2f');
});

test('住宅街：物体が重ならず、主要な場所すべてへ出現地点から歩いて行ける', () => {
  const b = new Battle({ seed: 11, mapId: 'town' });
  const w = b.world;
  const solid = w.objects.filter(o => o.blocksMove && !o.id.startsWith('outer_'));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], c = solid[j];
      if (a.kind === 'wall' && c.kind === 'wall') continue; // 壁の角どうしは重なってよい
      if (a.floor !== c.floor) continue; // 別の階の物どうし
      const overlap = a.x < c.x + c.w - 0.01 && a.x + a.w > c.x + 0.01 && a.y < c.y + c.h - 0.01 && a.y + a.h > c.y + 0.01;
      assert.ok(!overlap, `${a.name} と ${c.name} が重なっている`);
    }
  }
  const sp = w.spawns.player;
  const goals = [
    ...w.buildings.map(bd => [bd.name, bd.x + bd.w / 2, bd.y + bd.h / 2]),
    ...w.areas.map(a => [a.name, a.x + a.w / 2, a.y + a.h / 2]),
    ['CPU 出現地点', w.spawns.cpu.x, w.spawns.cpu.y],
  ];
  for (const [name, x, y] of goals) {
    const p = findPath(w, sp.x, sp.y, x, y);
    assert.ok(p && !p.partial, `${name} へ行けない`);
  }
});

test('住宅街：植え込みの中にいると離れた所からは見えない', () => {
  const b = new Battle({ seed: 12, mapId: 'town' });
  const bush = b.objectById('bush_park_2');
  b.cpu.x = bush.x + bush.w / 2; b.cpu.y = bush.y + bush.h / 2;
  b.player.x = b.cpu.x - 8; b.player.y = b.cpu.y; b.player.facing = 0;
  assert.equal(b.canSee(b.player, b.cpu.x, b.cpu.y), false);
  b.player.x = b.cpu.x - 2;
  assert.equal(b.canSee(b.player, b.cpu.x, b.cpu.y), true);
  assert.equal(b.canSee(b.cpu, b.player.x, b.player.y), true);
});

test('住宅街：車に衝撃を与えると防犯アラームが遠くまで聞こえる', () => {
  const b = new Battle({ seed: 13, mapId: 'town' });
  const car = b.objectById('car_park_1');
  b.cpu.x = 40; b.cpu.y = 21;
  b.damageObject(car, 10, b.player);
  assert.ok(car.alarmUntil > b.t);
  assert.ok(b.cpu.memory.heard.some(h => h.kind === 'alarm'), 'CPU にアラームが聞こえていない');
});

test('住宅街：ローカル解析が新しい場所・物を指せる', () => {
  const b = new Battle({ seed: 14, mapId: 'town', playerChar: 'sogo', cpuChar: 'kito' });
  const cases = [
    ['コンビニに駆け込む', 'store'],
    ['公園の植え込みに隠れる', 'bush_'],
    ['工事現場へ向かう', 'area_site'],
    ['自販機を押す', 'vending_'],
  ];
  for (const [text, id] of cases) {
    const plan = compilePlan(b, b.player, localParse(b, b.player, text));
    assert.ok(plan.steps.length, `${text}：手順がない（${plan.rejected}）`);
    assert.ok(plan.steps[0].target.id.startsWith(id), `${text}：対象が ${plan.steps[0].target.id}`);
  }
});

function sogoBattle() {
  const b = new Battle({ seed: 3, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  b.world.objects = b.world.objects.filter(o => o.kind !== 'crate');
  return b;
}
const runFor = (b, sec) => { for (let i = 0; i < sec * 30; i++) b.step(); };

test('十河：触れた敵をきっかり10m弾き出し、途中に壁があれば叩きつける', () => {
  // 開けた方向：10.00m 飛ぶだけで衝突ダメージなし
  let b = sogoBattle();
  b.player.x = 20; b.player.y = 20; b.cpu.x = 18.6; b.cpu.y = 20;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' }] }));
  runFor(b, 1.5);
  assert.ok(Math.abs(18.6 - b.cpu.x - 10) < 0.05, `移動距離 ${(18.6 - b.cpu.x).toFixed(2)}m`);
  const openHp = b.cpu.hp;
  // 壁の手前：途中で止まり、叩きつけの12ダメージが加わる
  b = sogoBattle();
  b.player.x = 14; b.player.y = 10; b.cpu.x = 15.5; b.cpu.y = 10;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' }] }));
  runFor(b, 1.5);
  assert.ok(b.cpu.x < 17.3, '壁で止まっていない');
  assert.ok(b.log.some(l => /叩きつけで\d+ダメージ/.test(l.text)), '叩きつけのダメージがない');
  assert.ok(b.cpu.hp < openHp, `開けた方向より被害が小さい（${openHp} → ${b.cpu.hp}）`);
});

test('十河：開けた場所では真上に跳び、空中では殴りが届かない', () => {
  const b = sogoBattle();
  b.player.x = 20; b.player.y = 20; b.cpu.x = 21.2; b.cpu.y = 20; b.cpu.facing = Math.PI;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'self' }] }));
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'wait', targetType: 'none', duration: 0.3 }, { action: 'melee', targetType: 'enemy' }] }));
  runFor(b, 1);
  assert.ok(b.isAirborne(b.player));
  assert.equal(b.player.hp, b.player.maxHp, '空中で殴られた');
  runFor(b, 1.5);
  assert.ok(!b.isAirborne(b.player));
  assert.equal(b.player.hp, b.player.maxHp - 5, '着地の衝撃がない');
});

test('十河：100kgを超える物は弾き出せない', () => {
  const b = new Battle({ seed: 3, mapId: 'town', playerChar: 'sogo' });
  const plan = compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'object', targetId: 'vending_1' }] });
  assert.equal(plan.steps.length, 0);
  assert.ok(plan.rejected[0].includes('100kg'));
});

// ---------- 高さ・階 ----------

test('高さ：2階の窓からは塀越しに道路が見え、地上からは塀の陰が見えない', () => {
  const b = new Battle({ seed: 21, mapId: 'town', playerChar: 'sogo', cpuChar: 'kito' });
  const viewer = b.player;
  // 佐藤家の南の塀（y=13、高さ1.8m）の向こう、大通りの低い所
  const tx = 4.75, ty = 15.5;
  viewer.x = 4.75; viewer.y = 11.6; viewer.floor = 0; viewer.facing = Math.PI / 2; // 庭（地上）
  assert.equal(b.canSee(viewer, tx, ty, 0.6), false, '地上から塀越しに低い所が見えている');
  viewer.y = 9.2; viewer.floor = 1; // 2階の南窓（x 4〜5.5）のそば
  assert.ok(b.canSee(viewer, tx, ty, 0.6), '2階の窓から道路が見えない');
});

test('高さ：床と天井は階をまたぐ視線を遮る', () => {
  const b = new Battle({ seed: 22, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  b.player.x = 8; b.player.y = 8; b.player.floor = 0; b.player.facing = 0;
  b.cpu.x = 10; b.cpu.y = 8; b.cpu.floor = 1;
  assert.equal(b.canSee(b.player, b.cpu.x, b.cpu.y), false, '1階から天井越しに2階が見えている');
  b.player.floor = 1;
  assert.equal(b.canSee(b.player, b.cpu.x, b.cpu.y), true);
});

test('高さ：階段を使って2階へ上がり、2階の窓から飛び降りられる', () => {
  const b = new Battle({ seed: 23, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito', randomSpawn: false });
  b.cpu.x = 33; b.cpu.y = 3;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'move', mode: 'run', targetType: 'object', targetId: 'house_left_2f' }] }));
  runFor(b, 12);
  assert.equal(b.player.floor, 1, '2階に上がれていない');
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'jump_down', targetType: 'object', targetId: 'house_left_f2_window_s' }] }));
  runFor(b, 6);
  assert.equal(b.player.floor, 0, '飛び降りていない');
  assert.ok(!b.buildingOf(b.player), '建物の外に出ていない');
  assert.ok(b.objectById('house_left_f2_window_s').broken, '窓を突き破っていない（ガラスが割れていない）');
});

test('扉：閉じた扉は歩いて通ると開き、閉める行動で閉まる', () => {
  const b = new Battle({ seed: 24, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  b.cpu.x = 33; b.cpu.y = 3;
  const door = b.objectById('house_left_door');
  assert.equal(door.open, false);
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'move', mode: 'run', targetType: 'object', targetId: 'house_left' }] }));
  runFor(b, 8);
  assert.ok(door.open, '扉が開いていない');
  assert.ok(b.buildingOf(b.player), '家に入れていない');
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'close', targetType: 'object', targetId: 'house_left_door' }] }));
  runFor(b, 4);
  assert.equal(door.open, false, '扉が閉まっていない');
});

// ---------- 鬼頭 錠二：ホテル・カリフォルニア ----------

function kitoRoom() {
  const b = new Battle({ seed: 25, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  const bd = b.world.buildings.find(x => x.id === 'house_right');
  // 右の家：扉1つ・窓2つ。扉だけ開けておく
  for (const id of bd.exits) { const o = b.objectById(id); o.open = false; o.blocksMove = true; if (o.kind === 'door') o.blocksSight = true; }
  const door = b.objectById('house_right_door');
  b.setOpen(door, true, null);
  b.player.x = 28; b.player.y = 14.2; b.player.floor = 0;
  b.cpu.x = 26; b.cpu.y = 18; b.cpu.floor = 0;
  return { b, bd, door };
}

test('錠二：内側で最後の出口を自分で閉めると密室が成立し、相手は外へ出られない', () => {
  const { b, bd } = kitoRoom();
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'close', targetType: 'object', targetId: 'house_right_door' }] }));
  runFor(b, 3);
  assert.ok(bd.sealed, '密室が成立していない');
  // 窓を開けて出ようとしても炎で出られない
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [
    { action: 'open', targetType: 'object', targetId: 'house_right_window' },
    { action: 'move', mode: 'run', targetType: 'point', x: 20, y: 17 },
  ] }));
  const hp = b.cpu.hp;
  runFor(b, 6);
  assert.ok(b.buildingOf(b.cpu), '相手が外に出られてしまった');
  assert.ok(b.cpu.hp < hp, '炎に触れても傷を負っていない');
  assert.ok(bd.sealed, '一部の出口を開けただけで解除された');
});

test('錠二：出口がすべて同時に開くと解除される／外からは閉じ込められない', () => {
  const { b, bd } = kitoRoom();
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'close', targetType: 'object', targetId: 'house_right_door' }] }));
  runFor(b, 3);
  assert.ok(bd.sealed);
  for (const id of bd.exits) b.setOpen(b.objectById(id), true, b.cpu);
  b.step();
  assert.equal(bd.sealed, null, '全出口が開いても解除されない');
  // 外から閉めても成立しない
  const { b: b2, bd: bd2, door: door2 } = kitoRoom();
  b2.player.x = 28; b2.player.y = 11.8;
  b2.setOpen(door2, false, b2.player);
  assert.equal(bd2.sealed, null, '外から閉めて密室が成立した');
});

test('十河：屋内で真上に跳ぶと天井にぶつかる', () => {
  const b = new Battle({ seed: 26, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  b.player.x = 8; b.player.y = 8.5; b.cpu.x = 33; b.cpu.y = 3;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'self' }] }));
  runFor(b, 1.5);
  assert.ok(b.log.some(l => l.text.includes('天井に激突')));
  assert.ok(b.player.hp < b.player.maxHp);
});

test('錠二：相手が建物の外にいる時は、出口を全部閉めても密室にならない', () => {
  const { b, bd } = kitoRoom();
  b.cpu.x = 20; b.cpu.y = 30;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'close', targetType: 'object', targetId: 'house_right_door' }] }));
  runFor(b, 3);
  assert.equal(bd.sealed, null, '相手がいないのに密室が成立した');
  assert.ok(b.log.some(l => l.text.includes('相手がいないので密室にはならない')));
});

test('初期装備は無く、落ちている物を拾って投げられる（花瓶は割れる）', () => {
  const b = new Battle({ seed: 31, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  for (const c of b.chars) assert.equal(c.held, null);
  assert.ok(b.world.items.length >= 5, 'マップに拾える物が無い');
  const vase = makeItem('vase', 21, 9);
  b.world.items.push(vase);
  b.player.x = 20; b.player.y = 9; b.player.floor = 0; b.player.facing = 0;
  b.cpu.x = 27; b.cpu.y = 9; b.cpu.floor = 0;
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'wait', targetType: 'none', duration: 5 }] }));
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [
    { action: 'pickup', targetType: 'object', targetId: vase.id },
    { action: 'throw', targetType: 'enemy' },
  ] }));
  const hp = b.cpu.hp;
  runFor(b, 4);
  assert.equal(b.player.held, null, '投げた後も手に持っている');
  assert.ok(b.cpu.hp < hp, '投げた花瓶が当たっていない');
  assert.ok(b.log.some(l => l.text.includes('花瓶が割れた')), '花瓶が割れていない');
  assert.ok(!b.world.items.some(i => i.id === vase.id));
});

test('ローカル解析：「花瓶を拾って投げる」を拾う→投げるの手順にする', () => {
  const b = new Battle({ seed: 32, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  const plan = localParse(b, b.player, '花瓶を拾って投げる');
  const acts = plan.steps.map(s => s.action);
  assert.deepEqual(acts.slice(0, 2), ['pickup', 'throw']);
});

test('七海：配置した個体が近くの大きな音を拾い、集めた轟音で相手を転倒させる', () => {
  const b = new Battle({ seed: 33, mapId: 'lot', playerChar: 'nanami', cpuChar: 'kito' });
  const me = b.player, foe = b.cpu;
  me.x = 20; me.y = 9; foe.x = 30; foe.y = 9; me.facing = 0; me.floor = foe.floor = 0;
  // 衝撃音を3回、個体のすぐ近くで鳴らす
  const free = me.units.filter(u => u.state === 'home').slice(0, 3);
  free.forEach((u, i) => { u.state = 'deployed'; u.x = 22 + i * 3; u.y = 9; u.floor = 0; });
  for (const u of free) b.noise({ x: u.x + 0.3, y: u.y, floor: 0 }, 10, 'impact');
  assert.equal(free.filter(u => b.isLoud(u.sound)).length, 3, '大きな音を拾えていない');
  b.setPlan(foe, compilePlan(b, foe, { steps: [{ action: 'wait', targetType: 'none', duration: 5 }] }));
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'ability', ability: 'echo', effect: 'roar', targetType: 'enemy' }] }));
  const hp = foe.hp;
  runFor(b, 3);
  assert.ok(foe.hp < hp, '轟音がダメージを与えていない');
  assert.ok(foe.status.deafUntil > b.t, '耳が聞こえなくなっていない');
});

test('七海：個体を群がらせて引っかき、そばに残った個体は払われると本体が傷を負う', () => {
  const b = new Battle({ seed: 34, mapId: 'lot', playerChar: 'kito', cpuChar: 'nanami' });
  const me = b.player, foe = b.cpu;
  me.x = 27; me.y = 9; me.floor = foe.floor = 0;
  foe.x = 20; foe.y = 9; foe.facing = 0;
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'wait', targetType: 'none', duration: 3 }] }));
  const plan = compilePlan(b, foe, localParse(b, foe, 'エコー・ビーチ5体で敵を引っかく'));
  assert.equal(plan.steps[0].effect, 'scratch');
  b.setPlan(foe, plan);
  const hp = me.hp;
  runFor(b, 2.5);
  assert.ok(me.hp < hp && hp - me.hp <= 11, `引っかきのダメージがおかしい（${hp - me.hp}）`);
  const near = foe.units.filter(u => u.state === 'deployed' && dist(u.x, u.y, me.x, me.y) <= 1.2).length;
  assert.ok(near >= 3, '引っかいた個体が敵のそばに残っていない');
  const fhp = foe.hp;
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'swat', targetType: 'self' }] }));
  runFor(b, 2);
  assert.ok(foe.hp < fhp, '払っても本体が傷を負っていない');
  assert.ok(!compilePlan(b, foe, { steps: [{ action: 'ability', ability: 'echo', effect: 'attach', targetType: 'enemy' }] }).steps.some(s => s.effect === 'attach'), '取り付くが残っている');
});

test('鷺沼：弾は壁で跳ね返るたびに威力が上がり、跳弾で物陰を狙える', () => {
  const b = new Battle({ seed: 35, mapId: 'lot', playerChar: 'saginuma', cpuChar: 'kito' });
  assert.ok(b.ballDamage(0) < b.ballDamage(1) && b.ballDamage(1) < b.ballDamage(3) && b.ballDamage(3) < b.ballDamage(7));
  const me = b.player, foe = b.cpu;
  // 間に箱を置いて直接は狙えない位置関係にする
  b.world.objects = b.world.objects.filter(o => o.kind !== 'crate');
  me.x = 20; me.y = 9; foe.x = 30; foe.y = 9; me.facing = 0; me.floor = foe.floor = 0;
  b.setPlan(foe, compilePlan(b, foe, { steps: [{ action: 'wait', targetType: 'none', duration: 5 }] }));
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 }] }));
  const hp = foe.hp;
  runFor(b, 4);
  assert.ok(foe.hp < hp, '跳弾が当たっていない');
  assert.ok(b.log.some(l => /[1-7]回跳ねた弾/.test(l.text)), '跳ね返っていない');
  assert.equal(me.hp, me.maxHp, '撃った直後の弾が自分に当たった');
});

test('2対2：4人が出現し、CPU同士のチーム戦が例外なく決着する', async () => {
  const ids = ['sogo', 'kito', 'nanami', 'saginuma'];
  for (let seed = 1; seed <= 4; seed++) {
    const r = i => ids[(seed + i) % 4];
    const b = new Battle({ seed, playerChar: r(0), allyChar: r(1), cpuChar: r(2), cpu2Char: r(3), mapId: seed % 2 ? 'town' : 'lot' });
    assert.equal(b.chars.length, 4);
    assert.deepEqual(b.chars.map(c => c.team), [0, 1, 0, 1]);
    for (const c of b.chars) assert.ok(isWalkablePoint(b.world, c.x, c.y), `${c.id} が歩けない場所に出現した`);
    const tc = new TurnController(b);
    while (!b.over && tc.turn <= 70) {
      const plan = compilePlan(b, b.player, b.player.alive ? localCpuPlan(b, b.player) : { steps: [] });
      await tc.commit(plan);
      while (tc.phase === 'execute') tc.step();
    }
    assert.ok(b.over, `seed ${seed} が決着しない`);
    assert.ok(b.winnerTeam === null || !b.chars.some(c => c.team !== b.winnerTeam && c.alive), '負けたチームに生存者がいる');
  }
});

test('2対2：名前で狙う敵を選べ、味方が見た敵の位置は共有される', () => {
  const b = new Battle({ seed: 41, mapId: 'lot', playerChar: 'kito', allyChar: 'sogo', cpuChar: 'nanami', cpu2Char: 'saginuma' });
  const plan = compilePlan(b, b.player, localParse(b, b.player, '鷺沼を追いかけて殴る'));
  assert.ok(plan.steps.length >= 1);
  assert.equal(plan.steps[0].target.charId, 'cpu2');
  assert.ok(plan.steps[0].label.includes('鷺沼'));
  // 味方だけが敵を見ている
  b.player.x = 4; b.player.y = 17; b.player.facing = Math.PI;
  b.ally.x = 20; b.ally.y = 9; b.ally.facing = 0;
  b.cpu2.x = 27; b.cpu2.y = 9; b.cpu.x = 33; b.cpu.y = 3;
  assert.ok(!b.canSee(b.player, b.cpu2.x, b.cpu2.y));
  b.step();
  const rec = b.player.memory.seen.cpu2;
  assert.ok(rec, '味方の目撃が共有されていない');
  assert.equal(rec.via, b.ally.name);
  const obs = buildObservation(b, b.player);
  assert.equal(obs.allies.length, 1);
  assert.equal(obs.enemies.length, 2);
  assert.equal(obs.enemies.find(e => e.id === 'cpu2').last_seen.reported_by, b.ally.name);
});

test('2対2：投げた物は味方には当たらない', () => {
  const b = new Battle({ seed: 42, mapId: 'lot', playerChar: 'sogo', allyChar: 'kito', cpuChar: 'nanami', cpu2Char: 'saginuma' });
  b.player.x = 20; b.player.y = 9; b.player.facing = 0;
  b.ally.x = 23; b.ally.y = 9;
  b.cpu.x = 27; b.cpu.y = 9; b.cpu2.x = 4; b.cpu2.y = 17;
  for (const c of b.chars) b.setPlan(c, compilePlan(b, c, { steps: [{ action: 'wait', targetType: 'none', duration: 3 }] }));
  b.spawnThrown(b.player, makeItem('brick', 0, 0), 20, 9, 27, 9);
  const hpAlly = b.ally.hp, hpFoe = b.cpu.hp;
  runFor(b, 1.5);
  assert.equal(b.ally.hp, hpAlly, '味方に当たった');
  assert.ok(b.cpu.hp < hpFoe, '味方の向こうの敵に届いていない');
});

test('2対2：片方が倒れても味方が残っていれば続き、相手チーム全滅で勝ち', () => {
  const b = new Battle({ seed: 43, mapId: 'lot', playerChar: 'sogo', allyChar: 'kito', cpuChar: 'nanami', cpu2Char: 'saginuma' });
  b.damage(b.player, 999, { kind: 'debris' });
  b.step();
  assert.ok(!b.over, '1人倒れただけで決着した');
  b.damage(b.cpu, 999, { kind: 'debris' });
  b.damage(b.cpu2, 999, { kind: 'debris' });
  b.step();
  assert.ok(b.over);
  assert.equal(b.winnerTeam, 0);
  assert.ok(b.fx.some(f => f.kind === 'ko') && b.fx.some(f => f.kind === 'hit'), '演出用の打撃・KO イベントが出ていない');
});

test('スタンド：先行させると射程内に留まり、スタンドの位置から見える', () => {
  const b = new Battle({ seed: 51, mapId: 'lot', playerChar: 'kito', cpuChar: 'saginuma' });
  const me = b.player, foe = b.cpu;
  me.x = 24; me.y = 9; me.facing = Math.PI; me.floor = foe.floor = 0;
  foe.x = 30; foe.y = 9;
  b.setPlan(foe, compilePlan(b, foe, { steps: [{ action: 'wait', targetType: 'none', duration: 3 }] }));
  assert.ok(!b.canSee(me, foe.x, foe.y), '背後の敵が最初から見えている');
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'stand_move', targetType: 'direction', direction: 'right' }] }));
  me.facing = Math.PI;
  runFor(b, 1);
  const s = me.standBody;
  assert.ok(s, 'スタンドが出ていない');
  assert.ok(dist(s.x, s.y, me.x, me.y) <= me.def.standRange + 0.06, 'スタンドが射程より遠くへ行った');
  assert.ok(b.canSee(me, foe.x, foe.y), 'スタンドの位置から見えていない');
  assert.ok(me.memory.seen.cpu, 'スタンドで見た敵を記憶していない');
});

test('スタンド：敵の投げた物をスタンドで受け止めると、本体には3割だけ返る', () => {
  const b = new Battle({ seed: 52, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  const me = b.player, foe = b.cpu;
  me.x = 27; me.y = 9; me.floor = foe.floor = 0;
  foe.x = 20; foe.y = 9;
  me.standBody = { x: 25.6, y: 9, floor: 0, facing: Math.PI, goal: { x: 25.6, y: 9 } };
  for (const c of b.chars) b.setPlan(c, compilePlan(b, c, { steps: [{ action: 'wait', targetType: 'none', duration: 3 }] }));
  b.spawnThrown(foe, makeItem('brick', 0, 0), 20, 9, 27, 9);
  const hp = me.hp;
  runFor(b, 1.5);
  const lost = hp - me.hp;
  assert.ok(lost > 0 && lost <= 5, `反動のダメージがおかしい（${lost}）`);
  assert.ok(b.log.some(l => l.text.includes('受け止めた')));
});

test('スタンド：七海は群体なので出し入れの行動を使えず、出している間はエネルギーが減る', () => {
  const n = new Battle({ seed: 53, mapId: 'lot', playerChar: 'nanami', cpuChar: 'kito' });
  const plan = compilePlan(n, n.player, { steps: [{ action: 'stand_out', targetType: 'none' }] });
  assert.equal(plan.steps.length, 0);
  assert.ok(plan.rejected[0].includes('群体'));
  const b = new Battle({ seed: 53, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  b.setPlan(b.player, compilePlan(b, b.player, localParse(b, b.player, 'スタンドを出す')));
  const sp = b.player.sp;
  runFor(b, 3);
  assert.ok(b.player.standBody);
  assert.ok(b.player.sp < sp);
  b.setPlan(b.player, compilePlan(b, b.player, localParse(b, b.player, 'スタンドを戻す')));
  runFor(b, 1);
  assert.equal(b.player.standBody, null);
});

test('時間制限：警察が来た時点で与ダメージの多い側の判定勝ち、両者待つだけなら引き分け', () => {
  const b = new Battle({ seed: 61, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  b.player.x = 4; b.player.y = 17; b.cpu.x = 33; b.cpu.y = 3;
  const wait = c => b.setPlan(c, compilePlan(b, c, { steps: [{ action: 'wait', targetType: 'none', duration: 10 }] }));
  b.damage(b.cpu, 5, { source: b.player, kind: 'melee' });
  let warned = false;
  while (!b.over) {
    for (const c of b.chars) if (!c.runner.step) wait(c);
    b.step();
    if (b.log.some(l => l.text.includes('サイレン'))) warned = true;
  }
  assert.ok(warned, 'サイレンが鳴っていない');
  assert.equal(b.endReason, 'police');
  assert.ok(Math.abs(b.t - 180) < 0.1);
  assert.equal(b.winnerTeam, 0, 'ダメージを与えた側が判定勝ちになっていない');
  const b2 = new Battle({ seed: 62, mapId: 'lot', playerChar: 'kito', cpuChar: 'sogo' });
  b2.player.x = 4; b2.player.y = 17; b2.cpu.x = 33; b2.cpu.y = 3;
  while (!b2.over) {
    for (const c of b2.chars) if (!c.runner.step) b2.setPlan(c, compilePlan(b2, c, { steps: [{ action: 'wait', targetType: 'none', duration: 10 }] }));
    b2.step();
  }
  assert.equal(b2.winnerTeam, null, '両者待つだけなのに勝敗がついた');
});

test('開始位置はランダムで、屋外の歩ける場所に、敵味方が十分離れて出現する', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    for (const mapId of ['town', 'lot']) {
      const b = new Battle({ seed, mapId, playerChar: 'sogo', allyChar: 'kito', cpuChar: 'nanami', cpu2Char: 'saginuma' });
      for (const c of b.chars) {
        assert.ok(isWalkablePoint(b.world, c.x, c.y, 0), `${mapId} seed ${seed}：${c.id} が歩けない場所に出た`);
      }
      assert.ok(!b.buildingOf(b.player) && !b.buildingOf(b.cpu), '建物の中に出現した');
      assert.ok(dist(b.player.x, b.player.y, b.cpu.x, b.cpu.y) >= Math.max(b.world.w, b.world.h) * 0.5, '敵味方が近すぎる');
      seen.add(`${mapId}:${Math.round(b.player.x)},${Math.round(b.player.y)}`);
    }
  }
  assert.ok(seen.size >= 10, '開始位置が毎回同じ');
});

test('2階へ：「階段を上る」で2階まで上がり、遠い家の2階へは歩き方の指定が無ければ走って向かう', () => {
  const b = new Battle({ seed: 81, mapId: 'town', playerChar: 'sogo', cpuChar: 'kito', randomSpawn: false });
  b.cpu.x = 1.5; b.cpu.y = 1.5;
  const house = b.world.buildings.find(x => x.id === 'house_sato') || b.world.buildings.find(x => x.floors > 1);
  b.player.x = house.x + house.w / 2; b.player.y = house.y + house.h / 2 + 0.5;
  const p1 = compilePlan(b, b.player, localParse(b, b.player, '階段を上る'));
  assert.ok(p1.steps[0].target.id.endsWith('_2f'), `階段を上るが2階を目指していない（${p1.steps[0].label}）`);
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'wait', targetType: 'none', duration: 10 }] }));
  b.setPlan(b.player, p1);
  runFor(b, 8);
  assert.equal(b.player.floor, 1, '2階に上がれていない');
  // 遠くから「佐藤家の2階へ上がる」：走りに切り替わり、1回の予算内でほぼ着く
  const b2 = new Battle({ seed: 82, mapId: 'town', playerChar: 'sogo', cpuChar: 'kito', randomSpawn: false });
  const p2 = compilePlan(b2, b2.player, localParse(b2, b2.player, '鈴木家の2階に行く'));
  assert.equal(p2.steps[0].mode, 'run', '遠い移動なのに歩きのまま');
  const p3 = compilePlan(b2, b2.player, localParse(b2, b2.player, '鈴木家の2階に歩いて行く'));
  assert.equal(p3.steps[0].mode, 'walk', '歩くと書いたのに走りになった');
});

test('窓：ガラスの割れと枠の開閉は別。割れても枠を閉めれば密室の判定では閉まった扱い', () => {
  const { b, bd } = kitoRoom();
  const win = b.objectById('house_right_window');
  b.damageObject(win, 99, b.cpu);
  assert.ok(b.world.objects.includes(win), '割れた窓が消えた');
  assert.ok(win.broken && !win.open && !win.blocksMove, '割れた窓の状態がおかしい');
  assert.equal(b.exitOpen(win.id), false, '枠が閉まっているのに開いた扱い');
  b.setOpen(win, true, b.cpu);
  assert.ok(win.open && win.broken);
  assert.equal(b.exitOpen(win.id), true);
  b.setOpen(win, false, b.player);
  assert.equal(b.exitOpen(win.id), false);
  // 割れた窓が残っていても、最後の扉を閉めれば密室になる
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'close', targetType: 'object', targetId: 'house_right_door' }] }));
  runFor(b, 3);
  assert.ok(bd.sealed, '割れた窓のある家で密室にできない');
});

test('錠二：家の中で待ち伏せし、敵が入ってきたら扉を閉めて密室にできる（スタンドなら離れた所から閉められる）', () => {
  const { b, bd } = kitoRoom();
  const me = b.player, foe = b.cpu;
  // 錠二は扉から2m離れた室内、敵は家の外（北側）
  me.x = 28.3; me.y = 16; foe.x = 28.3; foe.y = 8; foe.facing = Math.PI / 2;
  me.facing = -Math.PI / 2;
  const plan = compilePlan(b, me, localParse(b, me, 'スタンドを出して、敵が入ってきたら扉を閉める'));
  assert.deepEqual(plan.steps.map(s => s.action), ['stand_out', 'close']);
  assert.equal(plan.steps[1].condition.kind, 'enemy_inside');
  b.setPlan(me, plan);
  b.setPlan(foe, compilePlan(b, foe, { steps: [{ action: 'move', mode: 'walk', targetType: 'point', x: 26, y: 17 }] }));
  runFor(b, 1);
  assert.equal(bd.sealed, null, '敵が入る前に密室になった');
  runFor(b, 8);
  assert.ok(bd.sealed, '敵が入ってきたのに密室にならない');
  assert.ok(pointInRect(foe.x, foe.y, bd));
});

test('錠二：コンビニ（扉2つ・はめ殺しのガラス）でも、ガラスが割れていても密室にでき、閉め残しは知らせる', () => {
  const b = new Battle({ seed: 3, mapId: 'town', playerChar: 'kito', cpuChar: 'sogo', randomSpawn: false });
  const bd = b.world.buildings.find(x => x.id === 'store');
  b.setOpen(b.objectById('store_door'), true, null);
  b.setOpen(b.objectById('store_backdoor'), true, null);
  b.damageObject(b.objectById('store_glass_1'), 99, null);
  b.player.x = bd.x + bd.w / 2; b.player.y = bd.y + bd.h / 2;
  b.cpu.x = bd.x + 2; b.cpu.y = bd.y + bd.h / 2;
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'wait', targetType: 'none', duration: 10 }] }));
  const plan = compilePlan(b, b.player, localParse(b, b.player, '扉を閉める'));
  assert.equal(plan.steps.filter(s => s.action === 'close').length, 2, '開いている扉を両方閉めない');
  b.setPlan(b.player, plan);
  runFor(b, 10);
  assert.ok(b.log.some(l => l.text.includes('まだ開いている出口がある')), '閉め残しを知らせていない');
  assert.ok(bd.sealed, 'コンビニで密室にならない');
});

test('スタンド：壁をすり抜けて先行し、壁越しに見える', () => {
  const { b, bd } = kitoRoom();
  const me = b.player, foe = b.cpu;
  // 錠二は右の家の中、北の壁の内側。敵は壁の外側
  me.x = 25; me.y = bd.y + 0.8; me.facing = -Math.PI / 2;
  foe.x = 25; foe.y = bd.y - 2.5;
  assert.ok(!b.canSee(me, foe.x, foe.y), '最初から壁越しに見えている');
  b.setPlan(foe, compilePlan(b, foe, { steps: [{ action: 'wait', targetType: 'none', duration: 3 }] }));
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'stand_move', targetType: 'direction', direction: 'up' }] }));
  runFor(b, 1);
  assert.ok(me.standBody.y < bd.y, 'スタンドが壁の外へ出ていない');
  assert.ok(b.canSee(me, foe.x, foe.y), 'スタンドの位置から壁の外が見えていない');
});

// ---------- 増やした行動 ----------

function duel(me, foe, opts = {}) {
  const b = new Battle({ seed: 91, mapId: 'lot', playerChar: me, cpuChar: foe, randomSpawn: false, ...opts });
  b.player.x = 22; b.player.y = 9; b.player.facing = 0; b.player.floor = 0;
  b.cpu.x = 23.4; b.cpu.y = 9; b.cpu.facing = Math.PI; b.cpu.floor = 0;
  return b;
}
const plan = (b, c, steps) => b.setPlan(c, compilePlan(b, c, { steps }));

test('掴み：ガードしている相手を崩して動けなくする／構えの間に殴られると潰される', () => {
  const b = duel('kito', 'sogo');
  plan(b, b.cpu, [{ action: 'guard', targetType: 'enemy', duration: 3 }]);
  plan(b, b.player, [{ action: 'grab', targetType: 'enemy' }]);
  const hp = b.cpu.hp;
  runFor(b, 1);
  assert.ok(b.cpu.hp < hp, '掴みのダメージが入っていない');
  assert.ok(b.cpu.status.grabbedUntil > b.t - 0.5, '組み付かれていない');
  // 殴り＞掴み
  const b2 = duel('sogo', 'kito');
  plan(b2, b2.cpu, [{ action: 'melee', targetType: 'enemy' }]);
  plan(b2, b2.player, [{ action: 'wait', targetType: 'none', duration: 0.25 }, { action: 'grab', targetType: 'enemy' }]);
  runFor(b2, 1.5);
  assert.ok(!b2.log.some(l => l.text.includes('組み付いた')), '殴られたのに掴みが決まった');
});

test('受け流し：正面からの殴りを打ち返す', () => {
  const b = duel('kito', 'sogo');
  plan(b, b.player, [{ action: 'counter', targetType: 'none' }]);
  plan(b, b.cpu, [{ action: 'melee', targetType: 'enemy' }]);
  const hpMe = b.player.hp, hpFoe = b.cpu.hp;
  runFor(b, 1.5);
  assert.equal(b.player.hp, hpMe, '受け流したのにダメージを受けた');
  assert.ok(b.cpu.hp < hpFoe, '打ち返していない');
});

test('体当たり：当たった相手を突き飛ばして転倒させる', () => {
  const b = duel('kito', 'sogo');
  b.world.objects = b.world.objects.filter(o => o.kind !== 'crate');
  b.cpu.x = 25;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b, b.player, [{ action: 'tackle', targetType: 'enemy' }]);
  const x0 = b.cpu.x, hp = b.cpu.hp;
  runFor(b, 0.6);
  assert.ok(b.cpu.status.proneUntil > b.t, '転倒していない');
  runFor(b, 0.6);
  assert.ok(b.cpu.x > x0 + 1.5, '突き飛ばされていない');
  assert.ok(b.cpu.hp < hp);
});

test('潜む：6mより遠くからは見えず、歩き出すと解ける。フェイントは構えだけ見せる', () => {
  const b = duel('sogo', 'kito');
  b.cpu.x = 30;
  plan(b, b.cpu, [{ action: 'hide', targetType: 'none', duration: 5 }]);
  runFor(b, 0.2);
  assert.ok(!b.canSee(b.player, b.cpu.x, b.cpu.y), '8m先の潜んだ相手が見えている');
  b.cpu.x = 26; b.cpu.vx = 0;
  assert.ok(b.canSee(b.player, b.cpu.x, b.cpu.y), '4mの距離で見えない');
  plan(b, b.cpu, [{ action: 'move', mode: 'walk', targetType: 'point', x: 30, y: 9 }]);
  runFor(b, 0.6);
  assert.equal(b.cpu.status.hideUntil, 0, '歩いても潜んだまま');
  const b2 = duel('sogo', 'kito');
  plan(b2, b2.player, [{ action: 'feint', targetType: 'enemy' }]);
  plan(b2, b2.cpu, [{ action: 'wait', targetType: 'none', duration: 2 }]);
  runFor(b2, 0.2);
  assert.ok(b2.player.windup, 'フェイントで構えを見せていない');
  const hp = b2.cpu.hp;
  runFor(b2, 1);
  assert.equal(b2.cpu.hp, hp, 'フェイントなのに当たった');
});

test('物音を立てる・見回す・乗り越える', () => {
  const b = duel('sogo', 'kito');
  b.cpu.x = 30; b.cpu.facing = 0;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b, b.player, [{ action: 'decoy', targetType: 'point', x: 31, y: 9 }]);
  runFor(b, 1);
  assert.ok(b.cpu.memory.heard.some(h => h.kind === 'impact'), '物音が聞こえていない');
  // 見回す：背後の敵に気づく
  const b2 = duel('sogo', 'kito');
  b2.player.facing = Math.PI; b2.cpu.x = 28;
  plan(b2, b2.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b2, b2.player, [{ action: 'search', targetType: 'none' }]);
  runFor(b2, 2);
  assert.ok(b2.player.memory.seen.cpu, '見回しても背後の敵に気づかない');
  // 乗り越える
  const b3 = new Battle({ seed: 92, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito', randomSpawn: false });
  const crate = b3.world.objects.find(o => o.kind === 'crate');
  b3.cpu.x = 2; b3.cpu.y = 2;
  const cc = { x: crate.x + crate.w / 2, y: crate.y + crate.h / 2 };
  const start = nearestWalkable(b3.world, cc.x - crate.w / 2 - 0.8, cc.y, 1.5, 0);
  b3.player.x = start.x; b3.player.y = start.y;
  plan(b3, b3.cpu, [{ action: 'wait', targetType: 'none', duration: 4 }]);
  plan(b3, b3.player, [{ action: 'vault', targetType: 'object', targetId: crate.id }]);
  runFor(b3, 2.5);
  assert.ok(b3.player.x > cc.x, '木箱の向こう側へ出ていない');
});

test('道具：消火器の煙幕は視線を遮り、傘は正面からの投擲を防ぐ', () => {
  const b = duel('sogo', 'kito');
  b.cpu.x = 30;
  b.player.held = { id: 'ext', kind: 'extinguisher', name: '消火器' };
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  assert.ok(b.canSee(b.player, b.cpu.x, b.cpu.y));
  plan(b, b.player, [{ action: 'use_item', targetType: 'enemy' }]);
  runFor(b, 0.6);
  assert.ok(b.world.zones.some(z => z.kind === 'smoke'), '煙幕が出ていない');
  assert.ok(!b.canSee(b.player, b.cpu.x, b.cpu.y), '煙幕越しに見えている');
  const b2 = duel('kito', 'sogo');
  b2.cpu.x = 30;
  b2.player.held = { id: 'umb', kind: 'umbrella', name: '傘' };
  plan(b2, b2.player, [{ action: 'use_item', targetType: 'none' }]);
  plan(b2, b2.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  runFor(b2, 0.4);
  b2.spawnThrown(b2.cpu, makeItem('brick', 0, 0), 30, 9, 22, 9);
  const hp = b2.player.hp;
  runFor(b2, 1);
  assert.equal(b2.player.hp, hp, '傘が投擲を防いでいない');
});

test('十河：真上に打ち上げると、落ちてダメージと転倒', () => {
  const b = duel('sogo', 'kito');
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 4 }]);
  plan(b, b.player, [{ action: 'ability', ability: 'perpendicular', effect: 'uplift', targetType: 'enemy' }]);
  const hp = b.cpu.hp;
  runFor(b, 0.8);
  assert.ok(b.isAirborne(b.cpu), '打ち上がっていない');
  runFor(b, 1.6);
  assert.ok(!b.isAirborne(b.cpu));
  assert.ok(b.cpu.hp <= hp - 6, '落下ダメージが入っていない');
  assert.ok(b.cpu.status.proneUntil > b.t, '転倒していない');
});

test('錠二：密室の中で相手を炎の壁へ叩きつける', () => {
  const { b, bd } = kitoRoom();
  plan(b, b.player, [{ action: 'close', targetType: 'object', targetId: 'house_right_door' }]);
  runFor(b, 3);
  assert.ok(bd.sealed);
  b.player.x = b.cpu.x - 1; b.player.y = b.cpu.y; b.player.facing = 0;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b, b.player, [{ action: 'ability', ability: 'hotel', effect: 'flame_slam', targetType: 'enemy' }]);
  const hp = b.cpu.hp;
  runFor(b, 1.5);
  assert.ok(hp - b.cpu.hp >= 15, `炎への叩きつけのダメージが小さい（${hp - b.cpu.hp}）`);
});

test('七海：無音の結界の中の足音は聞こえず、足音の行列は離れた所を歩く音に聞こえる', () => {
  const b = duel('nanami', 'kito');
  b.cpu.x = 30;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 6 }]);
  plan(b, b.player, [{ action: 'ability', ability: 'echo', effect: 'silence_zone', targetType: 'self' }]);
  runFor(b, 1.2);
  assert.ok(b.world.zones.some(z => z.kind === 'silence'), '結界が張られていない');
  const n0 = b.cpu.memory.heard.length;
  for (let i = 0; i < 3; i++) b.noise(b.player, 9, 'footsteps_run');
  assert.equal(b.cpu.memory.heard.length, n0, '結界の中の足音が聞こえた');
  const b2 = duel('nanami', 'kito');
  b2.cpu.x = 28; b2.cpu.y = 9;
  plan(b2, b2.cpu, [{ action: 'wait', targetType: 'none', duration: 6 }]);
  plan(b2, b2.player, [{ action: 'ability', ability: 'echo', effect: 'decoy_walk', targetType: 'point', x: 27, y: 15 }]);
  runFor(b2, 4);
  const steps = b2.cpu.memory.heard.filter(h => h.kind.startsWith('footsteps'));
  assert.ok(steps.length >= 3, `足音の行列が聞こえていない（${steps.length}）`);
});

test('鷺沼：撒いた玉を走って踏むと転び、牽制射撃は続けて撃つ', () => {
  const b = duel('saginuma', 'kito');
  b.cpu.x = 30;
  plan(b, b.player, [{ action: 'ability', ability: 'seventh', effect: 'caltrops', targetType: 'point', x: 26, y: 9 }]);
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 0.5 }, { action: 'move', mode: 'run', targetType: 'point', x: 23, y: 9 }]);
  runFor(b, 3);
  assert.ok(b.log.some(l => l.text.includes('玉を踏んで転んだ')), '走って踏んでも転ばない');
  const b2 = duel('saginuma', 'kito');
  b2.cpu.x = 32;
  const balls = b2.player.balls;
  plan(b2, b2.cpu, [{ action: 'wait', targetType: 'none', duration: 4 }]);
  plan(b2, b2.player, [{ action: 'ability', ability: 'seventh', effect: 'suppress', targetType: 'enemy' }]);
  runFor(b2, 2.5);
  assert.ok(balls - b2.player.balls >= 3, '牽制射撃で続けて撃っていない');
});

test('観戦モード：プレイヤーのキャラも CPU が考えて動き、決着まで進む', async () => {
  const b = new Battle({ seed: 95, mapId: 'town', playerChar: 'sogo', allyChar: 'nanami', cpuChar: 'kito', cpu2Char: 'saginuma', spectate: true });
  assert.ok(b.player.isCPU);
  const tc = new TurnController(b);
  let moved = false;
  const x0 = b.player.x;
  while (!b.over && tc.turn <= 70) {
    await tc.commit(compilePlan(b, b.player, { steps: [] }));
    while (tc.phase === 'execute') tc.step();
    if (Math.abs(b.player.x - x0) > 1) moved = true;
  }
  assert.ok(b.over, '観戦モードで決着しない');
  assert.ok(moved, 'プレイヤーのキャラが CPU として動いていない');
});

// ---------- ガン待ち対策（A1・A3・B5）と回復・干渉できる物 ----------

test('七海：自分で立てた大きな音は轟音の材料にならない（敵の立てた音はなる）', () => {
  const b = duel('nanami', 'kito');
  b.cpu.x = 30;
  const u = b.player.units.find(x => x.state === 'home');
  u.state = 'deployed'; u.x = 25; u.y = 9; u.floor = 0;
  b.emit({ text: '木箱を殴った', kind: 'env', actor: b.player, pos: { x: 25.3, y: 9, floor: 0 }, sound: 10, soundKind: 'impact' });
  assert.ok(u.sound && !b.isLoud(u.sound), '自分の音が大きな音として数えられた');
  const u2 = b.player.units.find(x => x.state === 'home');
  u2.state = 'deployed'; u2.x = 28; u2.y = 9; u2.floor = 0;
  b.emit({ text: '敵が木箱を殴った', kind: 'env', actor: b.cpu, pos: { x: 28.3, y: 9, floor: 0 }, sound: 10, soundKind: 'impact' });
  assert.ok(b.isLoud(u2.sound), '敵の音が大きな音にならない');
});

test('七海：轟音を鳴らすと、相手におおよその居場所が伝わる', () => {
  const b = duel('nanami', 'kito');
  b.cpu.x = 30; b.player.facing = Math.PI; b.cpu.facing = 0;
  assert.ok(!b.cpu.memory.seen.player);
  b.roarHit(b.player, b.cpu, 3);
  const r = b.cpu.memory.seen.player;
  assert.ok(r, '居場所が伝わっていない');
  assert.ok(dist(r.x, r.y, b.player.x, b.player.y) <= 4.3, '推定位置が離れすぎている');
});

test('同じ場所に長くいると住人に気づかれ、居場所が敵に知られる', () => {
  const { b } = kitoRoom();
  b.cpu.x = 4; b.cpu.y = 17;
  const wait = c => { if (!c.runner.step) b.setPlan(c, compilePlan(b, c, { steps: [{ action: 'wait', targetType: 'none', duration: 6 }] })); };
  for (let i = 0; i < 30 * 42; i++) { wait(b.player); wait(b.cpu); b.step(); }
  assert.ok(b.log.some(l => l.text.includes('住人が') && l.text.includes('気づいた')), '気づかれていない');
  assert.ok(b.cpu.memory.seen.player && b.cpu.memory.seen.player.via.includes('住人'), '居場所が敵に伝わっていない');
});

test('回復：拾った回復アイテムを使うとHPが戻り、使っている途中で殴られると中断する', () => {
  const b = duel('sogo', 'kito');
  b.cpu.x = 32;
  b.player.hp = 50;
  b.player.held = { id: 'fa', kind: 'first_aid', name: '救急箱' };
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 5 }]);
  plan(b, b.player, [{ action: 'use_item', targetType: 'self' }]);
  runFor(b, 3.5);
  assert.equal(b.player.hp, 85, '救急箱で回復していない');
  assert.equal(b.player.held, null);
  const b2 = duel('sogo', 'kito');
  b2.player.hp = 50;
  b2.player.held = { id: 'fa', kind: 'first_aid', name: '救急箱' };
  plan(b2, b2.cpu, [{ action: 'melee', targetType: 'enemy' }]);
  plan(b2, b2.player, [{ action: 'use_item', targetType: 'self' }]);
  runFor(b2, 3.5);
  assert.ok(b2.player.hp < 50, '殴られたのに回復を続けた');
  assert.ok(b2.player.held, '中断したのにアイテムが無くなった');
  // マップに回復アイテムがある
  for (const mapId of ['town', 'lot']) {
    const w = new Battle({ seed: 1, mapId }).world;
    assert.ok(w.items.some(i => ['drink', 'onigiri', 'bandage', 'first_aid'].includes(i.kind)), `${mapId}に回復アイテムが無い`);
  }
});

test('干渉できる物：自販機・水飲み場・発電機・ゴミ箱・防犯ブザー', () => {
  const b = new Battle({ seed: 96, mapId: 'town', playerChar: 'sogo', cpuChar: 'kito', randomSpawn: false });
  b.cpu.x = 58; b.cpu.y = 2;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 30 }]);
  const near = o => { const p = nearestWalkable(b.world, o.x + o.w / 2, o.y + o.h + 0.6, 2, 0); b.player.x = p.x; b.player.y = p.y; };
  // 自販機で缶ジュースを買う
  const v = b.objectById('vending_1');
  near(v);
  plan(b, b.player, [{ action: 'interact', targetType: 'object', targetId: v.id }]);
  runFor(b, 3);
  assert.equal(b.player.held?.kind, 'drink', '自販機で買えていない');
  // 水飲み場で回復
  b.player.held = null; b.player.hp = 60;
  const f = b.objectById('park_fountain');
  near(f);
  plan(b, b.player, [{ action: 'interact', targetType: 'object', targetId: f.id }]);
  runFor(b, 3);
  assert.equal(b.player.hp, 70, '水飲み場で回復していない');
  // 発電機を動かすと、そばの足音が遠くへ聞こえない
  const g = b.objectById('site_generator');
  near(g);
  plan(b, b.player, [{ action: 'interact', targetType: 'object', targetId: g.id }]);
  runFor(b, 2.5);
  assert.ok(b.world.zones.some(z => z.kind === 'hum'), '発電機が動いていない');
  const listener = b.cpu;
  listener.x = g.x + 8; listener.y = g.y + 0.5;
  const n0 = listener.memory.heard.length;
  b.noise({ x: g.x + 2, y: g.y + 1, floor: 0 }, 9, 'footsteps_run');
  assert.equal(listener.memory.heard.length, n0, '発電機のうなりの中の足音が聞こえた');
  // ゴミ箱の陰に隠れると、2m先からでも見えない
  const t = b.objectById('trash_park');
  near(t);
  listener.x = b.player.x + 3; listener.y = b.player.y; listener.facing = Math.PI;
  plan(b, b.player, [{ action: 'interact', targetType: 'object', targetId: t.id }]);
  runFor(b, 1.5);
  assert.ok(!b.canSee(listener, b.player.x, b.player.y), 'ゴミ箱の陰に隠れても見えている');
  // 防犯ブザー
  const r = b.objectById('store_counter');
  const p = nearestWalkable(b.world, r.x + r.w / 2, r.y + r.h + 0.7, 2, 0);
  b.player.x = p.x; b.player.y = p.y;
  plan(b, b.player, [{ action: 'interact', targetType: 'object', targetId: r.id }]);
  runFor(b, 3);
  assert.ok(b.log.some(l => l.text.includes('防犯ブザー')), '防犯ブザーが鳴らない');
});

test('プリティ・ヴェイカント：足場を崩す・得物を崩す・壁に穴を開けて元に戻す・床を仕込む', () => {
  const run = (b, s) => { for (let i = 0; i < s * 30; i++) b.step(); };
  // 足場を崩す
  let b = duel('saragiin', 'kito');
  b.cpu.x = 26;
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b, b.player, [{ action: 'ability', ability: 'vacant', effect: 'powder_floor', targetType: 'enemy' }]);
  const hp = b.cpu.hp;
  run(b, 1);
  assert.ok(b.cpu.hp < hp, '足場を崩してもダメージがない');
  assert.ok(b.cpu.status.proneUntil > b.t, '足場を崩しても倒れない');
  assert.ok(b.world.piles.length >= 1);
  // 得物を崩す
  b = duel('saragiin', 'kito');
  b.cpu.held = { id: 'x', kind: 'pipe', name: '鉄パイプ' };
  plan(b, b.cpu, [{ action: 'wait', targetType: 'none', duration: 3 }]);
  plan(b, b.player, [{ action: 'ability', ability: 'vacant', effect: 'powder_weapon', targetType: 'enemy' }]);
  run(b, 1);
  assert.equal(b.cpu.held, null, '得物が崩れない');
  // 壁に穴：一部だけ消え、元に戻せる
  b = duel('saragiin', 'kito');
  const wall = b.world.objects.find(o => o.kind === 'wall' && !o.id.startsWith('outer_') && Math.max(o.w, o.h) > 2);
  b.player.x = wall.x + wall.w / 2 + (wall.w > wall.h ? 0 : 1.5); b.player.y = wall.y + wall.h / 2 + (wall.w > wall.h ? 1.5 : 0); b.player.floor = wall.floor;
  b.cpu.x = 5; b.cpu.y = 5;
  const n0 = b.world.objects.length;
  plan(b, b.player, [{ action: 'ability', ability: 'vacant', effect: 'powder_object', targetType: 'object', targetId: wall.id }]);
  run(b, 1);
  assert.ok(!b.world.objects.includes(wall), '壁が崩れない');
  assert.ok(b.world.objects.filter(o => o.id.startsWith(wall.id)).length >= 1, '壁の残りの部分が無い');
  const pile = b.world.piles.at(-1);
  run(b, 2.5);
  plan(b, b.player, [{ action: 'ability', ability: 'vacant', effect: 'restore', targetType: 'self' }]);
  run(b, 1);
  assert.ok(b.world.objects.some(o => o.id === `${wall.id}_patch` && o.restored), '穴が元に戻らない');
  assert.ok(!b.world.piles.includes(pile));
  assert.ok(b.world.objects.length >= n0);
  // 床を仕込む：相手が踏むと抜ける
  b = duel('saragiin', 'kito');
  b.cpu.x = 30;
  plan(b, b.player, [{ action: 'ability', ability: 'vacant', effect: 'powder_trap', targetType: 'point', x: 25, y: 9 }]);
  run(b, 1);
  assert.ok(b.world.zones.some(z => z.kind === 'powder_trap'));
  plan(b, b.cpu, [{ action: 'move', targetType: 'point', x: 20, y: 9, mode: 'walk' }]);
  run(b, 3);
  assert.ok(!b.world.zones.some(z => z.kind === 'powder_trap'), '仕込んだ床を踏んでも抜けない');
});
