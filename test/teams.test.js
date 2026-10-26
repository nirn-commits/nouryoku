import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../public/js/engine/sim.js';
import { TurnController } from '../public/js/engine/controller.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { dist } from '../public/js/engine/vec.js';

// 先読みの時間を短くして、大人数の試合を手早く回す
globalThis.LOOK_BUDGET = 150;

async function play(b, maxTurns = 40) {
  const tc = new TurnController(b);
  while (!b.over && tc.turn < maxTurns) {
    await tc.commit(compilePlan(b, b.player, localCpuPlan(b, b.player)));
    while (tc.phase === 'execute') tc.step();
  }
  return tc;
}

test('5対5：同じキャラが何人いても名前で見分けられ、チームの仲間は近くに・敵チームは離れて出る', () => {
  const b = new Battle({ seed: 11, mapId: 'town', teams: [['sogo', 'sogo', 'kito', 'nanami', 'mikuriya'], ['sogo', 'saginuma', 'saragiin', 'kito', 'nanami']] });
  assert.equal(b.chars.length, 10);
  assert.equal(b.mode, '5対5');
  assert.equal(new Set(b.chars.map(c => c.id)).size, 10);
  assert.equal(new Set(b.chars.map(c => c.name)).size, 10, b.chars.map(c => c.name).join(','));
  assert.ok(b.chars.filter(c => c.charId === 'sogo').every(c => /[①②③]$/.test(c.name)));
  assert.equal(b.player.team, 0);
  assert.equal(b.enemiesOf(b.player).length, 5);
  assert.equal(b.alliesOf(b.player).length, 4);
  const t0 = b.chars.filter(c => c.team === 0), t1 = b.chars.filter(c => c.team === 1);
  for (const c of t0) assert.ok(dist(c.x, c.y, b.player.x, b.player.y) < 8, `${c.name} が仲間から離れている`);
  for (const c of t1) assert.ok(dist(c.x, c.y, b.player.x, b.player.y) > 15, `${c.name} が敵チームのすぐ近くに出た`);
  for (let i = 0; i < b.chars.length; i++) for (let j = i + 1; j < b.chars.length; j++) assert.ok(dist(b.chars[i].x, b.chars[i].y, b.chars[j].x, b.chars[j].y) > 1, '出現位置が重なっている');
});

test('バトルロワイヤル：全員が敵同士。最後の1人が勝ち、脱落者は倒れていく', async () => {
  const ids = ['sogo', 'kito', 'nanami', 'saginuma', 'saragiin', 'mikuriya'];
  const b = new Battle({ seed: 5, mapId: 'lot', teams: ids.map(id => [id]) });
  assert.equal(b.teamCount, 6);
  assert.ok(b.royale);
  assert.equal(b.enemiesOf(b.player).length, 5);
  assert.equal(b.alliesOf(b.player).length, 0);
  await play(b, 60);
  assert.ok(b.over, '決着がつかない');
  if (b.endReason !== 'police') {
    assert.equal(b.aliveTeams().length, b.winnerTeam === null ? 0 : 1);
    assert.ok(b.winner && b.winner.alive);
  }
  assert.ok(b.chars.filter(c => !c.alive).length >= 2, '誰も脱落していない');
});

test('バトルロワイヤル：警察が来たら、生き残りの中で与えたダメージが一番多い人の判定勝ち', () => {
  const b = new Battle({ seed: 3, mapId: 'lot', teams: [['sogo'], ['kito'], ['nanami'], ['saginuma']] });
  b.chars[1].dealt = 90; b.chars[1].alive = false; // 一番多く与えたが脱落している
  b.chars[2].dealt = 40;
  b.chars[3].dealt = 25;
  b.t = 1000;
  b.step();
  assert.ok(b.over);
  assert.equal(b.endReason, 'police');
  assert.equal(b.winnerTeam, 2);
});

test('同じキャラ同士の1対1も戦える', async () => {
  const b = new Battle({ seed: 8, mapId: 'lot', playerChar: 'kito', cpuChar: 'kito' });
  assert.notEqual(b.player.name, b.cpu.name);
  await play(b, 30);
  assert.ok(b.t > 5);
  for (const c of b.chars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.hp));
});
