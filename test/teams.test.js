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

test('駅前（大型）：歩ける場所はすべて行き来でき、建物・橋・踏切・南口が通れ、川と線路の柵は通れない', async () => {
  const { createWorld } = await import('../public/js/engine/maps.js');
  const { findPath, isWalkablePoint, nearestWalkable } = await import('../public/js/engine/world.js');
  const w = createWorld(4, 'station');
  assert.equal(w.w, 100);
  let unreachable = 0;
  for (let x = 1; x < 99; x += 3) for (let y = 1; y < 69; y += 3) {
    if (!isWalkablePoint(w, x, y, 0)) continue;
    const p = findPath(w, 4, 20.5, x, y, 0, 0);
    if (!p || p.partial) unreachable++;
  }
  assert.equal(unreachable, 0, '行き来できない場所がある');
  for (const bd of w.buildings) for (const f of bd.floors > 1 ? [0, 1] : [0]) {
    const q = nearestWalkable(w, bd.x + bd.w / 2, bd.y + bd.h / 2, 3, f);
    const p = q && findPath(w, 4, 20.5, q.x, q.y, 0, f);
    assert.ok(p && !p.partial, `${bd.name}の${f + 1}階に入れない`);
  }
  for (const it of w.items) assert.ok(isWalkablePoint(w, it.x, it.y, it.floor || 0), `${it.name}が拾えない場所にある`);
  assert.ok(!isWalkablePoint(w, 30, 64, 0), '川の上を歩ける');
  assert.ok(isWalkablePoint(w, 52.5, 64, 0), '南口の橋を渡れない');
  assert.ok(!isWalkablePoint(w, 10, 12.1, 0) && !isWalkablePoint(w, 10, 16.8, 0), '線路の柵を通り抜けられる');
});

test('駅前（大型）：8人のバトルロワイヤルが例外なく進む', async () => {
  const ids = ['sogo', 'kito', 'nanami', 'saginuma', 'saragiin', 'mikuriya', 'sogo', 'kito'];
  const b = new Battle({ seed: 9, mapId: 'station', teams: ids.map(id => [id]) });
  const tc = await play(b, 12);
  assert.ok(tc.turn >= 3);
  for (const c of b.chars) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.hp) && c.x > 0 && c.x < 100 && c.y > 0 && c.y < 70);
  assert.ok(b.chars.some(c => c.hp < c.maxHp), '誰も戦っていない');
});

test('視線の判定（升目で速くした版）が、すべての物を調べる判定と一致する', async () => {
  const { createWorld } = await import('../public/js/engine/maps.js');
  const { hasLOS, crossesSlab } = await import('../public/js/engine/world.js');
  const { segRectRange, pointInRect } = await import('../public/js/engine/vec.js');
  const brute = (w, x0, y0, x1, y1, z0, z1) => {
    for (const o of w.objects) {
      if (!o.blocksSight) continue;
      const r = segRectRange(x0, y0, x1, y1, o);
      if (!r || r[1] <= 1e-4 || r[0] >= 1 - 1e-4 || pointInRect(x0, y0, o) || pointInRect(x1, y1, o)) continue;
      const za = z0 + (z1 - z0) * r[0], zb = z0 + (z1 - z0) * r[1];
      if (Math.max(za, zb) < o.z0 || Math.min(za, zb) > o.z1) continue;
      return false;
    }
    return !crossesSlab(w, x0, y0, z0, x1, y1, z1);
  };
  let s = 99;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (const map of ['town', 'station']) {
    const w = createWorld(2, map);
    for (let i = 0; i < 4000; i++) {
      if (i === 2000) w.objects = w.objects.filter((o, k) => k % 5); // 物が壊れた後も
      const x0 = r() * w.w, y0 = r() * w.h, x1 = x0 + (r() - 0.5) * 40, y1 = y0 + (r() - 0.5) * 40, z0 = r() < 0.2 ? 4.6 : 1.6, z1 = r() < 0.2 ? 4.2 : 1.2;
      assert.equal(hasLOS(w, x0, y0, x1, y1, null, z0, z1), brute(w, x0, y0, x1, y1, z0, z1));
    }
  }
});
