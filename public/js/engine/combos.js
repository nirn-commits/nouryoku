// 能力を生かす連携（コンボ）：キャラごとに「能力が一番効く形」を作ってから決める手を組み立てる。
// ここで作った案は先読みの候補に入り、数秒先まで試して良ければ選ばれる
import { ABILITIES } from './data.js';
import { dist, nearestPointOnRect, rectCenter, distToRect, pointInRect } from './vec.js';
import { isWalkablePoint, findPath, buildingAt, hasLOS } from './world.js';

const round = v => Math.round(v * 10) / 10;
const moveTo = (p, floor = 0, mode = 'run') => ({ action: 'move', mode, targetType: 'point', x: round(p.x), y: round(p.y), floor });
const tag = t => `（CPU・ローカル）${t}`;
const ready = (c, id) => !c.cd[id] && c.sp >= (ABILITIES[id]?.cost ?? 0);

// 歩いて行けて、回り道にならない地点か
function reachable(b, c, p, maxLen) {
  if (!isWalkablePoint(b.world, p.x, p.y, c.floor)) return false;
  const path = findPath(b.world, c.x, c.y, p.x, p.y, c.floor, c.floor);
  return !!path && !path.partial && (path.length ?? dist(c.x, c.y, p.x, p.y)) <= maxLen;
}

// 十河：敵の背後（10m以内）に叩きつけられる面が来る位置。敵をはさんで面の反対側に回り込む地点を返す
export function slamApproach(b, c, e, maxWalk = 7) {
  let best = null;
  for (const o of b.world.objects) {
    if (!o.blocksMove || o.floor !== e.floor || o.kind === 'water' || o.kind === 'hole' || o.id.startsWith('outer_')) continue;
    if (distToRect(e.x, e.y, o) > 8.5) continue;
    const n = nearestPointOnRect(e.x, e.y, o);
    const dl = dist(e.x, e.y, n.x, n.y);
    if (dl < 0.6) continue;
    const ux = (n.x - e.x) / dl, uy = (n.y - e.y) / dl;
    const p = { x: e.x - ux * 1.5, y: e.y - uy * 1.5 };
    const walk = dist(c.x, c.y, p.x, p.y);
    if (walk > maxWalk) continue;
    // 近い面ほど、回り込む距離が短いほど良い
    const score = dl + walk * 0.7;
    if (best && score >= best.score) continue;
    if (!reachable(b, c, p, maxWalk * 1.4)) continue;
    best = { p, o, dl, score };
  }
  return best;
}

// 十河：近くの軽い物（木箱・ゴミ箱・三角コーン…）を敵へ弾き飛ばせる位置
function launchObjectApproach(b, c, e) {
  let best = null;
  for (const o of b.world.objects) {
    if (!o.movable || (o.kg ?? 999) > 100 || o.floor !== c.floor) continue;
    const cc = rectCenter(o);
    const de = dist(cc.x, cc.y, e.x, e.y);
    if (de > 9 || de < 1.5 || dist(c.x, c.y, cc.x, cc.y) > 6) continue;
    const ux = (e.x - cc.x) / de, uy = (e.y - cc.y) / de;
    const p = { x: cc.x - ux * (Math.max(o.w, o.h) / 2 + 0.7), y: cc.y - uy * (Math.max(o.w, o.h) / 2 + 0.7) };
    if (!reachable(b, c, p, 8)) continue;
    const score = dist(c.x, c.y, p.x, p.y) + de * 0.3;
    if (!best || score < best.score) best = { p, o, score };
  }
  return best;
}

function sogoCombos(b, c, pe) {
  const out = [];
  if (!pe.visible || !ready(c, 'perpendicular')) return out;
  const e = pe.char;
  const d = dist(c.x, c.y, e.x, e.y);
  if (d < 9 && !b.buildingOf(e)) {
    const s = slamApproach(b, c, e);
    if (s) {
      out.push({ interpretation: tag(`回り込んで${s.o.name}へ叩きつける`), speech: null, steps: [moveTo(s.p, c.floor), { action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }] });
    }
  }
  if (d > 2.5 && d < 12) {
    const lo = launchObjectApproach(b, c, e);
    if (lo) {
      out.push({ interpretation: tag(`${lo.o.name}を敵へ弾き飛ばす`), speech: null, steps: [moveTo(lo.p, c.floor), { action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'object', targetId: lo.o.id }, { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }] });
    }
  }
  return out;
}

// 鬼頭：密室にできる建物（200㎡まで）
const sealable = bd => bd && bd.w * bd.h * bd.floors <= 200;
// 扉の内側（奥へ入った所。追ってきた敵が建物の中まで踏み込むよう、入口から3.5mほど離れる）
function insideOf(b, bd, door, depth = 3.5) {
  const dx = door.x + door.w / 2, dy = door.y + door.h / 2;
  const cx = bd.x + bd.w / 2, cy = bd.y + bd.h / 2;
  const l = dist(dx, dy, cx, cy) || 1;
  const k = Math.min(depth, l);
  let p = { x: dx + ((cx - dx) / l) * k, y: dy + ((cy - dy) / l) * k };
  // 家具などで立てない所なら、少し手前に
  for (let t = k; t > 1 && !isWalkablePoint(b.world, p.x, p.y, 0); t -= 0.5) p = { x: dx + ((cx - dx) / l) * t, y: dy + ((cy - dy) / l) * t };
  return p;
}
const isOpen = o => o && (o.open || o.broken);

// 鬼頭：密室を作る。①敵が入っている小さな建物に自分も入って扉を閉める ②近くの家に入って誘い込み、敵が入ったら閉める
function kitoSealCombos(b, c, pe) {
  const out = [];
  const mine = b.buildingOf(c);
  if (mine && mine.sealed) return out;
  const e = pe.char;
  const foeIn = pe.visible ? b.buildingOf(e) : null;
  // ① 敵が小さな建物の中にいる：一番近い入口から入り、開いている出口を閉めていく（最後の1つで密室）
  if (sealable(foeIn) && foeIn !== mine) {
    const doors = foeIn.exits.map(id => b.objectById(id)).filter(o => o && o.kind === 'door' && o.floor === 0);
    const door = doors.sort((p, q) => dist(c.x, c.y, p.x, p.y) - dist(c.x, c.y, q.x, q.y))[0];
    if (door && dist(c.x, c.y, door.x, door.y) < 16) {
      const p = insideOf(b, foeIn, door);
      const others = foeIn.exits.map(id => b.objectById(id)).filter(o => o && o !== door && isOpen(o) && o.openable !== false);
      if (others.length <= 2 && isWalkablePoint(b.world, p.x, p.y, 0)) {
        out.push({ interpretation: tag(`${foeIn.name}に入って出口を閉め、密室にする`), speech: null, steps: [
          moveTo(p, 0), ...others.map(o => ({ action: 'close', targetType: 'object', targetId: o.id })), { action: 'close', targetType: 'object', targetId: door.id },
          { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }].slice(0, 5) });
      }
    }
  }
  // ② 誘い込み：敵が見えていて、近くに（ほかの出口が閉まっている）小さな家がある。中で待ち、敵が入ってきたら扉を閉める
  if (pe.visible && !foeIn && e.def.role !== 'ranged') {
    const d = dist(c.x, c.y, e.x, e.y);
    if (d > 3 && d < 16) {
      let best = null;
      for (const bd of b.world.buildings) {
        if (!sealable(bd) || bd === foeIn) continue;
        const exits = bd.exits.map(id => b.objectById(id)).filter(Boolean);
        const doors = exits.filter(o => o.kind === 'door' && o.floor === 0);
        for (const door of doors) {
          const dd = dist(c.x, c.y, door.x, door.y);
          if (dd > 11) continue;
          // 扉は敵より自分に近いこと（先に入れる）。ほかの出口は閉まっていること
          if (dist(e.x, e.y, door.x, door.y) < dd) continue;
          if (exits.some(o => o !== door && isOpen(o) && o.openable !== false)) continue;
          const p = insideOf(b, bd, door);
          if (!isWalkablePoint(b.world, p.x, p.y, 0)) continue;
          if (!best || dd < best.dd) best = { bd, door, p, dd };
        }
      }
      if (best) {
        out.push({ interpretation: tag(`${best.bd.name}に誘い込み、入ってきたら閉じ込める`), speech: c.def.lines[0] || null, steps: [
          moveTo(best.p, 0), { action: 'look', targetType: 'enemy' },
          { action: 'close', targetType: 'object', targetId: best.door.id, condition: { kind: 'enemy_inside', timeout: 5 } },
          { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }] });
      }
    }
  }
  return out;
}

// 鬼頭：密室の中では、開けた出口の炎へ投げ込む（出口を1つ開けておき、敵をそこへ叩きつける）
function kitoCombos(b, c, pe) {
  const out = kitoSealCombos(b, c, pe);
  if (!pe.visible) return out;
  const e = pe.char;
  const bd = b.buildingOf(c);
  if (!bd || !bd.sealed || bd.sealed.by !== c.id || b.buildingOf(e) !== bd) return out;
  const exits = bd.exits.map(id => b.objectById(id)).filter(o => o && o.floor === e.floor);
  const open = exits.filter(o => o.open || o.broken);
  // 全部開けると解除されるので、開けるのは閉まっている出口が2つ以上ある時だけ
  const closed = exits.filter(o => !(o.open || o.broken) && o.openable !== false);
  const near = o => dist(e.x, e.y, o.x + o.w / 2, o.y + o.h / 2);
  const gate = open.filter(o => near(o) < 6).sort((p, q) => near(p) - near(q))[0];
  if (gate) {
    out.push({ interpretation: tag(`開いた${gate.name}の炎へ投げ込む`), speech: null, steps: [{ action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'ability', ability: 'hotel', effect: 'flame_slam', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }] });
  } else if (closed.length >= 2) {
    const o = closed.sort((p, q) => near(p) - near(q))[0];
    if (near(o) < 6) out.push({ interpretation: tag(`${o.name}を開けて炎の口を作り、そこへ投げ込む`), speech: null, steps: [{ action: 'open', targetType: 'object', targetId: o.id }, { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'ability', ability: 'hotel', effect: 'flame_slam', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] });
  }
  return out;
}

// 七海：自分で轟音の材料を作る。物のそばで個体を足元に置き、その物を殴る（殴った衝撃音を、そばの個体が1回に1つ拾う）
export function nanamiCombos(b, c, pe) {
  const out = [];
  if (!c.units) return out;
  const alive = c.units.filter(u => u.state !== 'dead');
  const loud = alive.filter(u => b.isLoud(u.sound)).length;
  const free = alive.filter(u => u.state === 'home' || (u.state === 'deployed' && !u.sound)).length;
  const need = 3 - loud;
  const d = pe ? dist(c.x, c.y, pe.x, pe.y) : 99;
  if (need <= 0 || free < need + 2 || (pe && pe.visible && d < 8)) return out;
  // 殴れる物（壊れにくい壁・柱・車・物）のそばの、敵から見えにくい立ち位置
  let best = null;
  for (const o of b.world.objects) {
    if (!o.blocksMove || o.floor !== c.floor || o.kind === 'water' || o.kind === 'hole' || o.kind === 'window' || o.kind === 'door' || o.id.startsWith('outer_')) continue;
    const dd = distToRect(c.x, c.y, o);
    if (dd > 7) continue;
    const n = nearestPointOnRect(c.x, c.y, o);
    const l = dist(c.x, c.y, n.x, n.y) || 1;
    const p = dd < 0.9 ? { x: c.x, y: c.y } : { x: n.x + ((c.x - n.x) / l) * 0.8, y: n.y + ((c.y - n.y) / l) * 0.8 };
    // 叩くと壊れてしまう物（木箱など）は、3回は持たないことがある：丈夫な物ほど良い
    const sturdy = o.indestructible || (o.hp ?? 0) > 40 ? 0 : 2;
    const score = dd + sturdy + (o.kind === 'car' ? 3 : 0); // 車はアラームで居場所が知れ渡る
    if (best && score >= best.score) continue;
    if (dd >= 0.9 && !reachable(b, c, p, 10)) continue;
    best = { o, p, score };
  }
  if (!best) return out;
  const steps = [];
  if (dist(c.x, c.y, best.p.x, best.p.y) > 0.5) steps.push(moveTo(best.p, c.floor, 'walk'));
  steps.push({ action: 'ability', ability: 'echo', effect: 'deploy', targetType: 'point', x: round(best.p.x), y: round(best.p.y), floor: c.floor, count: need });
  for (let i = 0; i < need && steps.length < 5; i++) steps.push({ action: 'melee', targetType: 'object', targetId: best.o.id });
  out.push({ interpretation: tag(`${best.o.name}を叩いて轟音を${need}つ集める`), speech: null, steps });
  return out;
}

// 七海：轟音の材料がそろっていて敵の居場所が分かれば、決め技を撃ってから追い打ち
function nanamiFinisher(b, c, pe) {
  if (!c.units) return [];
  const loud = c.units.filter(u => u.state !== 'dead' && b.isLoud(u.sound)).length;
  if (loud < 3 || dist(c.x, c.y, pe.x, pe.y) > 45) return [];
  return [{ interpretation: tag('集めた轟音を耳元で鳴らし、倒れた所を殴る'), speech: null, steps: [{ action: 'ability', ability: 'echo', effect: 'roar', targetType: 'enemy' }, { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] }];
}

// 蛇穴院：話しかけて気を引きながら足場を崩し（話している最中は長く崩れる）、倒れた所を殴る。
// 向かってくる相手には、通り道の床を先に仕込んで待つ
function saragiinCombos(b, c, pe) {
  const out = [];
  if (!pe.visible || !ready(c, 'vacant')) return out;
  const e = pe.char;
  const d = dist(c.x, c.y, e.x, e.y);
  const line = c.def.lines[Math.floor(b.rng() * c.def.lines.length)];
  if (d <= 7) {
    out.push({ interpretation: tag('話しかけながら足場を崩し、倒れた所を殴る'), speech: line, steps: [
      ...(d > 4.6 ? [{ action: 'chase', targetType: 'enemy', mode: 'walk', distance: 4 }] : []),
      { action: 'ability', ability: 'vacant', effect: 'powder_floor', targetType: 'enemy' },
      { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }].slice(0, 5) });
  }
  const traps = b.world.zones.filter(z => z.kind === 'powder_trap' && z.owner === c.id).length;
  if (d > 4 && d < 11 && traps < 2 && e.def.role !== 'ranged') {
    out.push({ interpretation: tag('通り道の床を仕込み、踏み抜いた所を殴る'), speech: line, steps: [
      { action: 'ability', ability: 'vacant', effect: 'powder_trap', targetType: 'direction', direction: 'toward_enemy', distance: Math.min(3, d / 2) },
      { action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_prone', timeout: 3.5 } },
      { action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }] });
  }
  return out;
}

// 御厨：詰めてくる相手の通り道に、車両で口を仕掛けて食いしばる（踏み込んだ足首に噛みつく）。離れたまま噛み続ける
function mikuriyaCombos(b, c, pe) {
  const out = [];
  if (!c.mouths || !pe.visible) return out;
  const e = pe.char;
  const d = dist(c.x, c.y, e.x, e.y);
  if (d > 4 && d < 13 && e.def.role !== 'ranged') {
    const k = 0.4;
    const p = { x: c.x + (e.x - c.x) * k, y: c.y + (e.y - c.y) * k };
    if (isWalkablePoint(b.world, p.x, p.y, c.floor)) {
      out.push({ interpretation: tag('通り道に口を仕掛けて、踏み込んだ所を噛む'), speech: null, steps: [
        { action: 'stand_move', targetType: 'point', x: round(p.x), y: round(p.y), floor: c.floor },
        { action: 'ability', ability: 'corvette', effect: 'mouth', targetType: 'point', x: round(p.x), y: round(p.y), floor: c.floor },
        { action: 'ability', ability: 'corvette', effect: 'bite', targetType: 'none', duration: 5 },
        { action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 5 }] });
    }
  }
  return out;
}

// 鷺沼：相手から見えない物陰に入ってから、跳弾で撃つ（遮蔽物の陰からでも当てられるのが跳弾の強み）
function saginumaCombos(b, c, pe) {
  const out = [];
  if (!pe.visible || (c.balls ?? 0) < 4) return out;
  const e = pe.char;
  const d = dist(c.x, c.y, e.x, e.y);
  if (d > 25) return out;
  let best = null;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    for (const r of [3, 5.5]) {
      const p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
      if (p.x < 1 || p.y < 1 || p.x > b.world.w - 1 || p.y > b.world.h - 1) continue;
      if (!isWalkablePoint(b.world, p.x, p.y, c.floor) || b.outsideZone(p, b.t + 8)) continue;
      if (hasLOS(b.world, e.x, e.y, p.x, p.y)) continue; // 相手から見える所は物陰ではない
      const de = dist(p.x, p.y, e.x, e.y);
      if (de < 6) continue;
      // 近すぎず遠すぎない所。間合い（keepDistance）に近いほど良い
      const score = Math.abs(de - (c.def.keepDistance || 10)) + r * 0.4;
      if (best && score >= best.score) continue;
      if (!reachable(b, c, p, r * 1.6)) continue;
      best = { p, score };
    }
  }
  if (best) {
    out.push({ interpretation: tag('物陰に入ってから跳弾で撃つ'), speech: null, steps: [moveTo(best.p, c.floor),
      { action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 2 },
      { action: 'ability', ability: 'seventh', effect: 'bank', targetType: 'enemy', bounces: 3 },
      { action: 'wait', targetType: 'none', duration: 0, condition: { kind: 'enemy_within', value: 6, timeout: 3 } },
      { action: 'move', mode: 'run', targetType: 'direction', direction: 'away_from_enemy', distance: 6 }] });
  }
  return out;
}

const COMBOS = { seventh: saginumaCombos, corvette: mikuriyaCombos, vacant: saragiinCombos, perpendicular: sogoCombos, hotel: kitoCombos, echo: (b, c, pe) => [...nanamiFinisher(b, c, pe), ...nanamiCombos(b, c, pe)] };

// データで追加したキャラ：技の中身から連携を組む。
//  ・止めてから叩く：転倒・痺れ・鈍化をかける技 → 一番痛い技（無ければ詰めて殴る）
//  ・強化してから攻める：自分を強くする技 → 一番痛い技
function genericCombos(b, c, pe) {
  const out = [];
  if (!c.def.custom || !pe.visible) return out;
  const d = dist(c.x, c.y, pe.x, pe.y);
  const effs = c.def.abilities.filter(id => ready(c, id)).flatMap(id => Object.entries(ABILITIES[id].effects).map(([eff, ed]) => ({ id, eff, ed, range: ed.range ?? ABILITIES[id].range })));
  const parts = ed => [...(ed.do || []), ...(ed.do || []).flatMap(p => p.onHit || [])];
  const dmg = ed => parts(ed).reduce((a, p) => a + (p.type === 'damage' ? p.amount : p.type === 'projectile' ? (p.damage || 0) * (p.count || 1) : p.type === 'zone' && p.kind === 'hazard' ? (p.dps || 3) * 3 : 0), 0);
  const control = effs.filter(x => (x.ed.targets.includes('enemy') || x.ed.targets.includes('point')) && parts(x.ed).some(p => (p.type === 'status' && ['stun', 'prone', 'slow'].includes(p.status)) || (p.type === 'zone' && p.kind === 'slow')));
  const attack = effs.filter(x => x.ed.targets.includes('enemy') && dmg(x.ed) > 0).sort((p, q) => dmg(q.ed) - dmg(p.ed));
  const buff = effs.filter(x => x.ed.targets.includes('self') && parts(x.ed).some(p => p.type === 'buff' && p.stat !== 'defense'));
  const ranged = c.def.role === 'ranged';
  const hit = x => ({ action: 'ability', ability: x.id, effect: x.eff, ...(x.ed.targets.includes('enemy') ? { targetType: 'enemy' } : { targetType: 'point', x: round(pe.x), y: round(pe.y) }) });
  const finish = (skip) => {
    const a = attack.find(x => x !== skip);
    if (a) return [...(!ranged && d > a.range ? [{ action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }] : []), hit(a)];
    return ranged ? [] : [{ action: 'chase', targetType: 'enemy', mode: 'run', duration: 2 }, { action: 'melee', targetType: 'enemy' }, { action: 'melee', targetType: 'enemy' }];
  };
  for (const ctl of control.slice(0, 2)) {
    if (d > ctl.range + (ranged ? 0 : 3)) continue;
    out.push({ interpretation: tag(`${ctl.ed.name}で止めてから叩く`), speech: null, steps: [...(!ranged && d > ctl.range ? [{ action: 'chase', targetType: 'enemy', mode: 'run', duration: 2, distance: Math.max(1, ctl.range - 0.5) }] : []), hit(ctl), ...finish(ctl)].slice(0, 5) });
  }
  if (buff.length) out.push({ interpretation: tag(`${buff[0].ed.name}で強くしてから攻める`), speech: null, steps: [{ action: 'ability', ability: buff[0].id, effect: buff[0].eff, targetType: 'self' }, ...finish(null)].slice(0, 5) });
  return out;
}

// そのキャラの能力を生かす案の一覧
export function abilityCombos(b, c, pe) {
  if (!pe) return [];
  const out = genericCombos(b, c, pe);
  const off = globalThis.AI_OFF;
  for (const id of c.def.abilities) if (COMBOS[id] && !(off && off.has(`combo_${id}`))) out.push(...COMBOS[id](b, c, pe));
  return out;
}

export { reachable, moveTo, buildingAt, pointInRect };
