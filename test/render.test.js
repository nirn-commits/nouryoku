import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../public/js/engine/sim.js';
import { compilePlan } from '../public/js/engine/plan.js';
import { localCpuPlan } from '../public/js/engine/localAI.js';
import { TurnController } from '../public/js/engine/controller.js';

// 描画処理が例外で止まらないかを、ブラウザの代わりの「何でも受け付ける」キャンバスで確かめる
function fakeCtx() {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return noop;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

globalThis.window = globalThis.window || { devicePixelRatio: 1 };
const { Renderer } = await import('../public/js/render.js');

function makeRenderer(b) {
  const canvas = { parentElement: { clientWidth: 1000 }, style: {}, getContext: () => fakeCtx(), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const r = new Renderer(canvas);
  r.resize(b);
  // キャラチップがある場合の描き方も通す
  const img = {};
  r.chips = Object.fromEntries(['sogo', 'kito', 'nanami', 'saginuma'].flatMap(k => [[k, { img, rows: 5 }], [`${k}_stand`, { img, rows: 1 }]]));
  return r;
}

test('描画：建物の中でスタンドを出していても、描画が例外で止まらない', () => {
  const b = new Battle({ seed: 71, mapId: 'town', playerChar: 'kito', allyChar: 'nanami', cpuChar: 'sogo', cpu2Char: 'saginuma' });
  const bd = b.world.buildings.find(x => x.kind === 'house');
  const me = b.player;
  me.x = bd.x + bd.w / 2; me.y = bd.y + bd.h / 2; me.floor = 0;
  b.cpu.x = me.x + 1; b.cpu.y = me.y;
  me.standBody = { x: me.x + 1, y: me.y, floor: 0, facing: 0, goal: {} };
  b.cpu.standBody = { x: b.cpu.x - 0.5, y: b.cpu.y, floor: 0, facing: Math.PI, goal: {} };
  // 割れた窓（枠が閉まっているもの・開いているもの）も描く
  const wins = b.world.objects.filter(o => o.kind === 'window' && o.building === bd.id);
  b.damageObject(wins[0], 99, null);
  if (wins[1]) { b.damageObject(wins[1], 99, null); b.setOpen(wins[1], true, null); }
  // 場の仕掛けと、構え・傘・組み付き・潜伏の表示
  for (const kind of ['smoke', 'caltrops', 'silence', 'hum']) b.addZone({ kind, x: me.x + 2, y: me.y, r: 2, until: b.t + 5, team: 0 });
  Object.assign(me.status, { counterUntil: b.t + 1, umbrellaUntil: b.t + 1, hideUntil: b.t + 1 });
  b.cpu.status.grabbedUntil = b.t + 1;
  const r = makeRenderer(b);
  r.draw(b);
  // 2階にいる場合とクローズアップ中も
  me.floor = 1;
  me.standBody.floor = 1;
  r.closeUp(me.x, me.y, 1, 2, 1);
  r.draw(b);
  r.draw(b, { debug: true });
});

test('描画：2対2の戦闘を最後まで進めながら毎フレーム描いても例外が出ない', async () => {
  for (const mapId of ['town', 'lot']) {
    const b = new Battle({ seed: 72, mapId, playerChar: 'sogo', allyChar: 'kito', cpuChar: 'nanami', cpu2Char: 'saginuma' });
    const r = makeRenderer(b);
    const tc = new TurnController(b);
    let frames = 0;
    while (!b.over && tc.turn <= 40) {
      await tc.commit(compilePlan(b, b.player, b.player.alive ? localCpuPlan(b, b.player) : { steps: [] }));
      while (tc.phase === 'execute') {
        tc.step();
        if (frames++ % 3 === 0) r.draw(b, { viewer: b.player.alive ? b.player : b.ally });
      }
    }
    assert.ok(frames > 100);
  }
});
