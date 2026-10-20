import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../public/js/engine/sim.js';
import { TurnController } from '../public/js/engine/controller.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { buildObservation } from '../public/js/engine/perception.js';
import { localParse } from '../public/js/engine/localParser.js';
import { findPath, isWalkablePoint } from '../public/js/engine/world.js';
import { makeItem } from '../public/js/engine/items.js';

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
  const b = new Battle({ seed: 1, playerChar: 'sogo', cpuChar: 'kito', mapId: 'lot' });
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
  const b = new Battle({ seed: 23, mapId: 'lot', playerChar: 'sogo', cpuChar: 'kito' });
  b.cpu.x = 33; b.cpu.y = 3;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'move', mode: 'run', targetType: 'object', targetId: 'house_left_2f' }] }));
  runFor(b, 12);
  assert.equal(b.player.floor, 1, '2階に上がれていない');
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'jump_down', targetType: 'object', targetId: 'house_left_f2_window_s' }] }));
  runFor(b, 6);
  assert.equal(b.player.floor, 0, '飛び降りていない');
  assert.ok(!b.buildingOf(b.player), '建物の外に出ていない');
  assert.ok(!b.objectById('house_left_f2_window_s'), '窓を突き破っていない');
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

test('七海：取り付いた個体は足音を奪い、払われると本体が傷を負う', () => {
  const b = new Battle({ seed: 34, mapId: 'lot', playerChar: 'kito', cpuChar: 'nanami' });
  const me = b.player, foe = b.cpu;
  me.x = 20; me.y = 9; foe.x = 4; foe.y = 17;
  const u = foe.units.find(x => x.state === 'home');
  u.state = 'attached'; u.attachedTo = me.id;
  for (let i = 0; i < 3; i++) b.noise(me, 6, 'footsteps_run');
  assert.ok(u.sound && u.sound.kind.startsWith('footsteps'), '足音を拾っていない');
  assert.ok(me.memory.suspectAttached, '音が消えたことに気づいていない');
  const hp = foe.hp;
  b.setPlan(me, compilePlan(b, me, { steps: [{ action: 'swat', targetType: 'self' }] }));
  runFor(b, 2);
  assert.equal(u.state, 'dead');
  assert.ok(foe.hp < hp);
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
