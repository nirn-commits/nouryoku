import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Battle } from '../public/js/engine/sim.js';
import { TurnController } from '../public/js/engine/controller.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { registerCharacter, validateCharacter } from '../public/js/engine/registry.js';
import { CHARACTERS } from '../public/js/engine/data.js';

const read = f => JSON.parse(readFileSync(new URL(`../public/characters/${f}`, import.meta.url), 'utf8'));
const fixture = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const fixtures = ['homura.json', 'takamiya.json'];
const list = read('index.json').characters;
for (const f of list) registerCharacter(read(f), { replace: true });
for (const f of fixtures) registerCharacter(fixture(f), { replace: true });

test('キャラクターのJSON：同梱のキャラ・ひな形・テスト用のキャラは書式どおり／誤りは日本語で指摘される', () => {
  for (const f of [...list, '_template.json']) assert.deepEqual(validateCharacter(read(f)), [], f);
  for (const f of fixtures) assert.deepEqual(validateCharacter(fixture(f)), [], f);
  const bad = read('_template.json');
  bad.id = 'Bad ID';
  bad.abilities[0].effects.strike.do = [{ type: 'explode' }];
  bad.abilities[0].effects.strike.targets = ['moon'];
  const errs = validateCharacter(bad);
  assert.ok(errs.some(e => e.includes('id')) && errs.some(e => e.includes('explode')) && errs.some(e => e.includes('targets')), errs.join('\n'));
  assert.throws(() => registerCharacter(bad), /書き方に誤り/);
});

test('キャラクターのJSON：登録したキャラ同士・既存キャラとの戦闘が例外なく進み、能力も使われる', async () => {
  for (const [p, q] of [['homura', 'kito'], ['takamiya', 'saginuma'], ['homura', 'takamiya']]) {
    assert.ok(CHARACTERS[p] && CHARACTERS[q]);
    const b = new Battle({ seed: 7, mapId: 'lot', playerChar: p, cpuChar: q });
    const tc = new TurnController(b);
    while (!b.over && tc.turn < 30) { await tc.commit(compilePlan(b, b.player, localCpuPlan(b, b.player))); while (tc.phase === 'execute') tc.step(); }
    for (const c of b.chars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.hp));
    const used = b.log.filter(l => l.kind === 'ability' && (l.actor === 'player' || l.actor === 'cpu')).length;
    assert.ok(used > 0, `${p} 対 ${q} で能力が一度も使われない`);
  }
});

test('汎用の部品：飛び道具・危険な場・突進・扇形・強化が働く', () => {
  const b = new Battle({ seed: 9, mapId: 'lot', playerChar: 'homura', cpuChar: 'takamiya', randomSpawn: false });
  b.player.x = 18; b.player.y = 9; b.cpu.x = 24; b.cpu.y = 9; b.player.facing = 0; b.cpu.facing = Math.PI;
  const run = s => { for (let i = 0; i < s * 30; i++) b.step(); };
  const plan = (c, steps) => b.setPlan(c, compilePlan(b, c, { steps }));
  plan(b.cpu, [{ action: 'wait', targetType: 'none', duration: 6 }]);
  const hp = b.cpu.hp;
  plan(b.player, [{ action: 'ability', ability: 'homura__flame', effect: 'fireball', targetType: 'enemy' }]);
  run(1.5);
  assert.ok(b.cpu.hp < hp, '火球が当たらない');
  plan(b.player, [{ action: 'ability', ability: 'homura__flame', effect: 'firewall', targetType: 'enemy' }]);
  const hp2 = b.cpu.hp;
  run(3);
  assert.ok(b.cpu.hp < hp2 - 4, '炎の壁で削られない');
  plan(b.player, [{ action: 'ability', ability: 'homura__flame', effect: 'heatguard', targetType: 'self' }]);
  run(0.6);
  assert.ok(b.player.buffs && b.player.buffs.some(x => x.stat === 'defense'), '強化がかからない');
  // 剣士：居合で一気に詰める
  b.cpu.x = b.player.x + 4.5; b.cpu.y = b.player.y; b.cpu.vx = b.cpu.vy = b.cpu.kbx = b.cpu.kby = 0; b.cpu.status.proneUntil = b.cpu.status.stunUntil = 0;
  const d0 = Math.hypot(b.cpu.x - b.player.x, b.cpu.y - b.player.y);
  plan(b.cpu, [{ action: 'ability', ability: 'takamiya__iai', effect: 'iai', targetType: 'enemy' }]);
  run(1.2);
  assert.ok(Math.hypot(b.cpu.x - b.player.x, b.cpu.y - b.player.y) < d0 - 2, '居合で踏み込まない');
});

test('書式の説明にある例（雷の忍者）がそのまま登録でき、雷遁で痺れ、変わり身で煙を残して離れる', () => {
  const ninja = {
    id: 'ninja_test', name: '雷丸', role: 'mid',
    abilities: [{ id: 'ninpo', name: '忍法', range: 8, cooldown: 0.5, cost: 5, effects: {
      raijin: { name: '雷遁', targets: ['enemy', 'direction'], range: 8, hit: { shape: 'line', length: 8, width: 1.2 }, do: [{ type: 'damage', amount: 8 }, { type: 'status', status: 'stun', seconds: 1 }] },
      kawarimi: { name: '変わり身', targets: ['self'], castTime: 0.1, do: [{ type: 'zone', kind: 'smoke', radius: 2.5, seconds: 5 }, { type: 'dash', toward: 'away', distance: 5, invuln: 0.3 }] },
    } }],
  };
  registerCharacter(ninja, { replace: true });
  const b = new Battle({ seed: 3, mapId: 'lot', playerChar: 'ninja_test', cpuChar: 'kito', randomSpawn: false });
  b.player.x = 24; b.player.y = 5; b.cpu.x = 29; b.cpu.y = 5; b.player.facing = 0; b.cpu.facing = Math.PI;
  const run = s => { for (let i = 0; i < s * 30; i++) b.step(); };
  b.setPlan(b.cpu, compilePlan(b, b.cpu, { steps: [{ action: 'wait', targetType: 'none', duration: 5 }] }));
  const hp = b.cpu.hp;
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'ninja_test__ninpo', effect: 'raijin', targetType: 'enemy' }] }));
  run(0.6);
  assert.ok(b.cpu.hp < hp && b.cpu.status.stunUntil > b.t, '雷遁が当たらない・痺れない');
  const d0 = Math.hypot(b.cpu.x - b.player.x, b.cpu.y - b.player.y);
  b.setPlan(b.player, compilePlan(b, b.player, { steps: [{ action: 'ability', ability: 'ninja_test__ninpo', effect: 'kawarimi', targetType: 'self' }] }));
  run(1.2);
  assert.ok(b.world.zones.some(z => z.kind === 'smoke'), '煙が出ない');
  assert.ok(Math.hypot(b.cpu.x - b.player.x, b.cpu.y - b.player.y) > d0 + 2, '敵から離れない');
});
