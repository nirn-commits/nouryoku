import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../public/js/engine/sim.js';
import { TurnController } from '../public/js/engine/controller.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { buildObservation } from '../public/js/engine/perception.js';
import { localParse } from '../public/js/engine/localParser.js';
import { findPath, isWalkablePoint } from '../public/js/engine/world.js';

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
    const b = new Battle({ seed, playerChar: seed % 2 ? 'makabe' : 'karasuma', cpuChar: seed % 2 ? 'karasuma' : 'makabe' });
    const tc = await playTurns(b, 60);
    assert.ok(b.over, `seed ${seed} が60手以内に決着しない`);
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
  const b = new Battle({ seed: 9, playerChar: 'makabe', cpuChar: 'karasuma' });
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
  const b = new Battle({ seed: 3, playerChar: 'makabe', cpuChar: 'karasuma' });
  const plan = compilePlan(b, b.player, {
    interpretation: 't',
    steps: [
      { action: 'ability', ability: 'time_stop', targetType: 'self' },
      { action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'point', x: 5, y: 5 },
      { action: 'move', targetType: 'point', x: 999, y: 5 },
      { action: 'fly', targetType: 'none' },
      { action: 'ability', ability: 'friction', effect: 'grip', targetType: 'object', targetId: 'crate_a' },
      { action: 'look', targetType: 'enemy' },
    ],
    rejected: [],
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].action, 'look');
  assert.equal(plan.rejected.length, 5);
});

test('行動予算を超えた手順は切り捨てられる', () => {
  const b = new Battle({ seed: 3 });
  const steps = Array.from({ length: 9 }, () => ({ action: 'guard', targetType: 'none', duration: 3 }));
  const plan = compilePlan(b, b.player, { steps });
  assert.ok(plan.budget <= 10 + 1e-9);
  assert.ok(plan.truncated.length > 0);
  assert.ok(plan.steps.length <= 5);
});

test('CPU の観測には、見えていない敵の現在位置もプレイヤーの計画も含まれない', () => {
  const b = new Battle({ seed: 5 });
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
  const b = new Battle({ seed: 7 });
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
  const b = new Battle({ seed: 1, playerChar: 'makabe', cpuChar: 'karasuma' });
  b.player.memory.lastSeen = { x: 20, y: 10, t: 0 };
  const p1 = compilePlan(b, b.player, localParse(b, b.player, '左の家に駆け込み、窓から敵の位置を確認する'));
  assert.deepEqual(p1.steps.map(s => s.action), ['move', 'move', 'look']);
  const p4 = compilePlan(b, b.player, localParse(b, b.player, '敵を追いかけて殴る'));
  assert.deepEqual(p4.steps.map(s => s.action), ['chase', 'melee']);
  const p2 = compilePlan(b, b.player, localParse(b, b.player, '敵が近づいてきたら、足元の地面に能力を使って転倒させる'));
  assert.equal(p2.steps[0].ability, 'friction');
  assert.equal(p2.steps[0].condition.kind, 'enemy_within');
  const p3 = compilePlan(b, b.player, localParse(b, b.player, '「覚悟しろ」と叫んで時間を止める'));
  assert.equal(p3.speech, '覚悟しろ');
  assert.ok(p3.rejected.some(r => r.includes('時間を止める')));
});

test('走って摩擦低下の領域に入ると転倒する', () => {
  const b = new Battle({ seed: 2, playerChar: 'makabe', cpuChar: 'karasuma' });
  b.player.x = 10; b.player.y = 19; b.player.facing = 0;
  b.cpu.x = 14; b.cpu.y = 19; b.cpu.facing = Math.PI;
  b.world.objects = b.world.objects.filter(o => o.kind !== 'crate');
  b.world.zones.push({ kind: 'slick', x: 12, y: 19, r: 1.8, until: 99, owner: 'player' });
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'move', mode: 'run', targetType: 'point', x: 8, y: 19 }] }));
  for (let i = 0; i < 60; i++) b.step();
  assert.ok(b.cpu.status.proneUntil > 0, '転倒していない');
  assert.ok(b.cpu.memory.observed.length > 0, '能力の観察情報が記録されていない');
});
