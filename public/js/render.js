// フィールド描画（斜め見下ろし）。高さのある物は上面と手前の面を描き、奥（北）から手前（南）の順に重ねる。
// 建物は普段は屋根で覆い、プレイヤーが中にいる時だけ屋根を外して今いる階を見せる。
// プレイヤーが知覚できるものだけを描く（debug 時は全表示）
import { RULES } from './engine/data.js';
import { clamp, pointInRect, dist } from './engine/vec.js';
import { FLOOR_H } from './engine/world.js';
import { ATLAS, AURA_OF, frameRect } from './fx.js';

const K = 0.55; // 高さ1mが画面上で上へずれる量（m）

const SOUND_LABEL = {
  footsteps: '足音', footsteps_run: '駆ける足音', speech: '声', impact: '衝撃音', crash: '崩れる音',
  glass: 'ガラスの音', fall: '倒れる音', throw: '風切り音', swing: '風切り音', ability: '異音', combat: '物音',
  env: '物音', damage: '打撃音', rustle: '葉擦れの音', alarm: '防犯アラーム', door: '扉の音',
  flick: '弾く音', ricochet: '金属音', siren: 'サイレン', stand: '気配',
};

const CAR_COLORS = ['#c0392b', '#f4f4f4', '#2c3e50', '#2980b9', '#7f8c8d'];

// 物体の色：[上面, 手前の面]
export function colorsOf(o, b) {
  switch (o.kind) {
    case 'wall':
      if (o.indestructible) return ['#1c1c22', '#121216'];
      if (o.style === 'block') return ['#a3a19a', '#7d7b74'];
      if (o.style === 'panel') return ['#e2dcc0', '#b9b294'];
      if (o.style === 'concrete') return ['#b3b3b3', '#8a8a8a'];
      return ['#4a4552', '#35313b'];
    case 'window': return o.open ? ['rgba(160,216,240,0.25)', 'rgba(120,180,210,0.25)'] : ['rgba(170,225,245,0.75)', 'rgba(120,190,220,0.6)'];
    case 'door': return ['#8a5a32', '#6b4425'];
    case 'crate': return ['#a5753f', '#7d5629'];
    case 'table': return ['#7a5232', '#5d3d24'];
    case 'shelf': return ['#c4a878', '#9a8259'];
    case 'vending': return ['#e04848', '#a82e2e'];
    case 'fountain': return ['#9fd6e8', '#6a9fb3'];
    case 'generator': return ['#e8c547', '#a88a24'];
    case 'trashcan': return ['#5f7d5a', '#435a3f'];
    case 'drum': return ['#3478c0', '#235386'];
    case 'cone': return ['#ff8c3a', '#d0661c'];
    case 'car': {
      if (/トラック/.test(o.name)) return ['#ece6d4', '#bdb7a5'];
      const hash = [...o.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
      const c = CAR_COLORS[hash % CAR_COLORS.length];
      return [c, shade(c, -0.3)];
    }
    case 'steel': return ['#7d8186', '#575a5e'];
    case 'hole': return ['#17110c', '#17110c'];
    case 'tree': return ['#2c6b31', '#1f4d22'];
    case 'pole': return ['#8a8a8a', '#666'];
    case 'bush': return ['rgba(60,130,60,0.92)', 'rgba(40,95,40,0.92)'];
    default: return ['#888', '#666'];
  }
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => clamp(Math.round(((n >> s) & 255) * (1 + f)), 0, 255);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const CHIP_CELL = 48;
// キャラチップの表示サイズ（48px のコマを整数倍に近い大きさで）
function chipSizeFor(P) {
  return Math.round(Math.max(36, Math.min(144, P * 2.0)) / 12) * 12;
}

// 打撃の種類と強さに応じた擬音
function onomatopoeia(f) {
  const strong = f.dmg >= 15;
  if (f.guarded) return 'ガッ';
  switch (f.hitKind) {
    case 'ball': return f.dmg >= 22 ? 'ドギュン' : 'ビシッ';
    case 'thrown': return strong ? 'ガシャァン' : 'ゴッ';
    case 'roar': return 'ゴォォン';
    case 'scratch': return 'ビシッ';
    case 'burn': return 'ジュウッ';
    case 'fall': return 'ドサッ';
    case 'launch_impact': case 'slam': return 'ドグシャァ';
    case 'debris': return 'ガラガラ';
    default: return strong ? (f.seq % 2 ? 'ドゴォ' : 'バキィ') : f.seq % 2 ? 'ボゴッ' : 'ドスッ';
  }
}

// 音の種類ごとの色
const SOUND_COLOR = {
  speech: '#ffffff', footsteps: '#ffe08a', footsteps_run: '#ffd166', impact: '#ff9b54', crash: '#ff7b54', damage: '#ff7b54',
  glass: '#9be7ff', alarm: '#ff4d6d', door: '#c7b8ff', ricochet: '#e8e8f0', flick: '#e8e8f0', default: '#ffe08a',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.px = 26;
    this.fog = null;
    this.fogFrame = 0;
    this.zoom = 'fit'; // fit=全体表示 / near=自分の周りを拡大
    this.offX = 0;
    this.offY = 0;
    this.dpr = 1;
    this.portraits = {};
    this.shakeAmp = 0;
    this.shakeAt = 0;
    this.sheet = null; // エフェクト素材（無ければプログラムで描く）
    this.cine = null; // クローズアップ { x, y, z, scale, start, dur }（実時間）
    this.chips = {}; // キャラチップ（public/chips/<id>.png・<id>_stand.png）
  }

  // 素材の1コマを、中心 (cx, cy)・高さ h ピクセルで描く
  sprite(rect, cx, cy, h, { alpha = 1, rot = 0, anchorY = 0.5 } = {}) {
    if (!this.sheet || !rect) return false;
    const [sx, sy, sw, sh] = frameRect(this.sheet, rect);
    const w = (h * sw) / sh;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    ctx.drawImage(this.sheet.canvas, sx, sy, sw, sh, -w / 2, -h * anchorY, w, h);
    ctx.restore();
    return true;
  }

  // 連番の途中のコマ（k は 0〜1 の進み具合）
  seq(frames, k) {
    return frames[Math.min(frames.length - 1, Math.max(0, Math.floor(k * frames.length)))];
  }

  // 画面揺れ（実時間で減衰）
  kick(amp) {
    const now = performance.now();
    this.shakeAmp = Math.max(this.currentShake(now), amp);
    this.shakeAt = now;
  }

  // クローズアップ：(x, y) へ寄って scale 倍に拡大し、dur 秒後に戻る（より強い寄りで上書き）
  closeUp(x, y, z, scale, dur) {
    const now = performance.now();
    const cur = this.cineAmount(now);
    if (this.cine && cur > 0.3 && this.cine.scale > scale) return;
    this.cine = { x, y, z, scale, start: now - (cur > 0 ? 120 * cur : 0), dur: dur * 1000 };
  }

  // 寄り具合 0〜1（寄る 0.12秒・保つ・戻る 0.3秒）
  cineAmount(now) {
    const c = this.cine;
    if (!c) return 0;
    const t = now - c.start;
    if (t >= c.dur) { this.cine = null; return 0; }
    const ease = v => v * v * (3 - 2 * v);
    if (t < 120) return ease(t / 120);
    if (t > c.dur - 300) return ease((c.dur - t) / 300);
    return 1;
  }

  currentShake(now) {
    return this.shakeAmp * Math.exp(-(now - this.shakeAt) / 110);
  }

  resize(battle) {
    const wrap = this.canvas.parentElement;
    // 枠の幅と高さの両方に収まる大きさ（上端の建物の屋根が切れないよう、上に余白をとる）
    const availW = Math.max(200, wrap.clientWidth);
    const availH = wrap.clientHeight > 80 ? wrap.clientHeight : Infinity;
    const fit = Math.min(availW / battle.world.w, availH / (battle.world.h + 3.6 * K));
    const w = Math.floor(fit * battle.world.w);
    this.viewW = w;
    this.topPad = 3.6 * K * fit;
    this.viewH = Math.round(fit * battle.world.h + this.topPad);
    this.px = this.zoom === 'near' ? Math.max(fit * 2.2, 30) : fit;
    this.basePx = this.px;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${this.viewH}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(this.viewH * this.dpr);
  }

  toggleZoom(battle) {
    this.zoom = this.zoom === 'fit' ? 'near' : 'fit';
    this.resize(battle);
    return this.zoom;
  }

  // 画面座標 → 戦場の座標（今いる階の床の高さの面として逆算する）
  toWorld(clientX, clientY, z = 0) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left + this.offX) / this.px, y: (clientY - r.top + this.offY) / this.px + z * K };
  }

  // 高さ z の点の画面上の y（ピクセル）
  sy(y, z) {
    return (y - z * K) * this.px;
  }

  computeFog(b, viewer) {
    const step = 0.75;
    const cols = Math.ceil(b.world.w / step), rows = Math.ceil(b.world.h / step);
    const vis = new Uint8Array(cols * rows);
    const inUpper = viewer.floor === 1 ? b.buildingOf(viewer) : null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * step, y = (r + 0.5) * step;
        const z = inUpper && pointInRect(x, y, inUpper) ? FLOOR_H + 0.5 : 0.5;
        vis[r * cols + c] = b.canSee(viewer, x, y, z) ? 1 : 0;
      }
    }
    this.fog = { step, cols, rows, vis };
  }

  // 箱（上面＋手前の面）を描く
  box(x, y, w, h, z0, z1, top, front, alpha = 1) {
    const ctx = this.ctx, P = this.px;
    ctx.globalAlpha = alpha;
    if (z1 - z0 > 0.02) {
      ctx.fillStyle = front;
      ctx.fillRect(x * P, this.sy(y + h, z1), w * P, (z1 - z0) * K * P);
    }
    ctx.fillStyle = top;
    ctx.fillRect(x * P, this.sy(y, z1), w * P, h * P);
    ctx.globalAlpha = 1;
  }

  // 建物の見せ方：roof（屋根で覆う）/ cut（屋根を外して floor 階まで見せる）
  buildingModes(b, debug) {
    const me = this.viewer || b.player;
    const modes = new Map();
    for (const bd of b.world.buildings) {
      const inside = pointInRect(me.x, me.y, bd);
      modes.set(bd.id, inside ? { mode: 'cut', floor: me.floor } : debug ? { mode: 'cut', floor: 0 } : { mode: 'roof' });
    }
    return modes;
  }

  draw(b, { debug = false, hover = null, viewer = null, spectate = false, preview = null } = {}) {
    this.preview = preview;
    this.spectate = spectate;
    const ctx = this.ctx;
    // 前のフレームが途中で失敗していても、描画の状態を初期化してから描く
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.filter = 'none';
    if (ctx.setLineDash) ctx.setLineDash([]);
    const me = this.viewer = viewer || b.player;
    const see = (x, y, z) => debug || b.canSee(me, x, y, z);
    const shake = this.currentShake(performance.now());
    const sx = shake > 0.3 ? (Math.random() - 0.5) * 2 * shake : 0, syy = shake > 0.3 ? (Math.random() - 0.5) * 2 * shake : 0;

    // カメラ（拡大時は自分を中心に）
    const P0 = this.px = this.basePx || this.px;
    if (this.zoom === 'near') {
      this.offX = clamp(me.x * P0 - this.viewW / 2, 0, Math.max(0, b.world.w * P0 - this.viewW));
      this.offY = clamp(this.sy(me.y, b.baseZ(me)) - this.viewH / 2, -P0 * 2, Math.max(0, b.world.h * P0 - this.viewH));
    } else {
      this.offX = 0;
      this.offY = -this.topPad;
    }
    // クローズアップ：拡大率を上げ、注目点を画面の中央へ寄せる
    const cineK = this.cineAmount(performance.now());
    if (cineK > 0) {
      const c = this.cine;
      const P2 = this.px = P0 * (1 + (c.scale - 1) * cineK);
      const px0 = c.x * P0 - this.offX, py0 = (c.y - c.z * K) * P0 - this.offY; // 元の画面での注目点の位置
      const keepX = c.x * P2 - px0, keepY = (c.y - c.z * K) * P2 - py0;
      const midX = c.x * P2 - this.viewW / 2, midY = (c.y - c.z * K) * P2 - this.viewH / 2;
      this.offX = keepX + (midX - keepX) * cineK;
      this.offY = keepY + (midY - keepY) * cineK;
    }
    const P = this.px;
    const W = b.world.w * P, H = b.world.h * P;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, (-this.offX + sx) * this.dpr, (-this.offY + syy) * this.dpr);

    // ---- 地面 ----
    ctx.fillStyle = '#4a4f3f';
    ctx.fillRect(0, 0, W, H);
    this.drawGround(b);
    const modes = this.buildingModes(b, debug);
    for (const bd of b.world.buildings) {
      ctx.fillStyle = { store: '#c9d1d3', office: '#8a8676', toilet: '#8c99a6' }[bd.kind] || '#6b5848';
      ctx.fillRect(bd.x * P, bd.y * P, bd.w * P, bd.h * P);
    }
    for (const r of b.world.rubble) {
      if ((r.floor ?? 0) !== 0) continue;
      this.drawRubble(r, 0);
    }
    for (const pl of b.world.piles || []) if (pl.floor === 0) this.drawPile(pl, 0);
    for (const o of b.world.objects) {
      if (o.kind === 'stairs') this.drawStairs(o, 0);
      if (o.kind === 'hole') this.box(o.x, o.y, o.w, o.h, 0, 0.02, '#17110c', '#17110c');
    }
    for (const it of b.world.items) {
      if ((it.floor ?? 0) === 0 && !this.hiddenUnderRoof(b, it, modes) && see(it.x, it.y, 0.3)) this.drawItem(it, 0);
    }

    // 霧（見えていない地面を暗く）
    if (!debug) {
      if (!this.fog || this.fogFrame++ % 5 === 0) this.computeFog(b, me);
      const f = this.fog;
      ctx.fillStyle = 'rgba(8,8,16,0.45)';
      for (let r = 0; r < f.rows; r++) {
        for (let c = 0; c < f.cols; c++) {
          if (!f.vis[r * f.cols + c]) ctx.fillRect(c * f.step * P, r * f.step * P, f.step * P + 0.5, f.step * P + 0.5);
        }
      }
    }

    // ---- 立体物（奥から手前へ） ----
    const items = [];
    const groups = new Map(b.world.buildings.map(bd => [bd.id, []]));
    const buildingOfPoint = (x, y) => b.world.buildings.find(bd => pointInRect(x, y, bd));
    for (const o of b.world.objects) {
      if (o.kind === 'stairs' || o.kind === 'hole' || o.id.startsWith('outer_')) continue;
      const bd = o.building ? b.world.buildings.find(x => x.id === o.building) : buildingOfPoint(o.x + o.w / 2, o.y + o.h / 2);
      const item = { key: o.y + o.h, z: o.z0, draw: cap => this.drawObject(b, o, cap) , obj: o };
      if (bd) groups.get(bd.id).push(item); else items.push(item);
    }
    // 味方は連絡を取り合っているので常に表示。敵は見えている時だけ
    const visibleChar = c => c === me || c.team === me.team || (c.alive && see(c.x, c.y));
    for (const c of b.chars) {
      const show = visibleChar(c) || (!c.alive && see(c.x, c.y));
      if (!show) continue;
      const bd = buildingOfPoint(c.x, c.y);
      const item = { key: c.y + c.r, z: b.baseZ(c), char: c, draw: () => this.drawChar(b, c, c === me, c !== me && c.team === me.team) };
      if (bd && !b.isAirborne(c)) groups.get(bd.id).push(item); else items.push(item);
      // 体の外に出したスタンド（味方のものと、見えている敵のもの）
      const sb = c.standBody;
      if (c.alive && sb && (c.team === me.team || see(sb.x, sb.y, sb.floor * FLOOR_H + 1.2))) {
        const sbd = buildingOfPoint(sb.x, sb.y);
        const sItem = { key: sb.y + 0.2, z: sb.floor * FLOOR_H, floor: sb.floor, stand: c, draw: () => this.drawStand(b, c) };
        if (sbd) groups.get(sbd.id).push(sItem); else items.push(sItem);
      }
    }
    const ghosts = [];
    for (const bd of b.world.buildings) {
      const group = groups.get(bd.id);
      const m = modes.get(bd.id);
      items.push({ key: bd.y + bd.h, z: 0, draw: () => this.drawBuilding(b, bd, group, m, ghosts) });
    }
    items.sort((a, z) => a.key - z.key || a.z - z.z);
    for (const it of items) it.draw(null);
    // 屋根の下でも見えている人物は輪郭で示す
    for (const c of ghosts) this.drawGhost(b, c);

    // 密室の炎
    for (const bd of b.world.buildings) if (bd.sealed) this.drawFlames(b, bd);

    // 場の仕掛け：煙幕（見える範囲）・撒かれた玉（見える所）・無音の結界（自分の側のものだけ）
    for (const z of b.world.zones) {
      const zz = (z.floor ?? 0) * FLOOR_H;
      const zx = z.x * P, zy = this.sy(z.y, zz);
      if (z.kind === 'smoke') {
        const left = Math.min(1, (z.until - b.t) / 2);
        for (let i = 0; i < 9; i++) {
          const a = i * 2.1 + b.t * 0.3, rr = z.r * (0.25 + (i % 3) * 0.28);
          ctx.fillStyle = `rgba(225,228,232,${0.42 * left})`;
          ctx.beginPath(); ctx.arc(zx + Math.cos(a) * rr * P, this.sy(z.y + Math.sin(a) * rr * 0.7, zz + 1 + (i % 3) * 0.4), z.r * 0.55 * P, 0, Math.PI * 2); ctx.fill();
        }
      } else if (z.kind === 'caltrops' && (debug || z.team === me.team || see(z.x, z.y, zz + 0.1))) {
        ctx.fillStyle = 'rgba(235,235,245,0.9)';
        for (let i = 0; i < 14; i++) {
          const a = i * 2.4, rr = z.r * ((i * 37) % 10) / 10;
          ctx.beginPath(); ctx.arc(zx + Math.cos(a) * rr * P, zy + Math.sin(a) * rr * P * 0.7, Math.max(1.5, P * 0.06), 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = 'rgba(235,235,245,0.35)';
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.ellipse(zx, zy, z.r * P, z.r * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      } else if (z.kind === 'powder_trap' && (debug || z.team === me.team)) {
        // 内側を粉にした床：仕込んだ側にだけ見える
        ctx.strokeStyle = 'rgba(242,138,178,0.75)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(zx, zy, z.r * P, z.r * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(242,138,178,0.12)';
        ctx.fill();
      } else if (z.kind === 'hazard' || z.kind === 'slow') {
        // 汎用の場：危険な場（炎・毒など）は赤橙、鈍化の場は青
        const col = z.kind === 'hazard' ? '255,120,60' : '90,160,255';
        const pulse = 0.25 + Math.sin(b.t * 6) * 0.06;
        ctx.fillStyle = `rgba(${col},${pulse})`;
        ctx.beginPath(); ctx.ellipse(zx, zy, z.r * P, z.r * P * 0.7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(${col},0.8)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (z.kind === 'hum') {
        // 動いている発電機：うなりの届く範囲
        const ph = (b.t * 1.2) % 1;
        ctx.strokeStyle = `rgba(232,197,71,${0.5 * (1 - ph)})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(zx, zy, z.r * P * (0.3 + ph * 0.7), z.r * P * 0.7 * (0.3 + ph * 0.7), 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(232,197,71,0.9)';
        ctx.font = `${Math.max(10, P * 0.4)}px sans-serif`;
        ctx.fillText('♪ 発電機のうなり', zx + P * 0.6, zy - P * 0.8);
      } else if (z.kind === 'silence' && (debug || z.team === me.team)) {
        ctx.strokeStyle = 'rgba(122,209,197,0.8)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(zx, zy, z.r * P, z.r * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(122,209,197,0.9)';
        ctx.font = `${Math.max(10, P * 0.4)}px sans-serif`;
        ctx.fillText(`無音の結界 ${(z.until - b.t).toFixed(0)}s`, zx - z.r * P * 0.6, zy - z.r * P * 0.75);
      }
    }

    // リトル・レッド・コルベットの口：自分の側には常に、相手には声や噛みつきで現れた時とすぐそばだけ見える
    for (const c of b.chars) {
      if (!c.mouths || !c.mouths.length) continue;
      for (const m of b.mouthSpots(c)) {
        const mine = c.team === me.team || debug;
        const near = m.floor === me.floor && Math.hypot(m.x - me.x, m.y - me.y) <= 2.5;
        if (!mine && !near && !(m.revealedUntil > b.t) && !(m.biting && see(m.x, m.y, (m.floor ?? 0) * FLOOR_H + 0.5))) continue;
        const on = m.on && b.chars.find(x => x.id === m.on);
        const mz = (m.floor ?? 0) * FLOOR_H + (on ? 1.25 : 0.05);
        const mx = m.x * P + (on ? P * 0.22 : 0), my = this.sy(m.y, mz);
        this.drawLips(mx, my, Math.max(5, P * 0.2), m.biting || c.clench, m.revealedUntil > b.t);
      }
    }

    // エコー・ビーチの個体：自分と味方の個体は常に、相手の個体はすぐそば（2.5m以内）だけ見える
    // 近くに固まった個体はまとめて、スタンドのチップ1つと体数の数字で示す
    for (const c of b.chars) {
      if (!c.units) continue;
      const shown = c.units.filter(u => {
        if (u.state === 'dead' || u.state === 'home' || u.state === 'attached') return false;
        if (c.team === me.team || debug) return true;
        return u.floor === me.floor && Math.hypot(u.x - me.x, u.y - me.y) <= 2.5;
      });
      const groups = [];
      for (const u of shown) {
        const g = groups.find(q => q.floor === u.floor && Math.hypot(q.x - u.x, q.y - u.y) < 0.9);
        if (g) { g.list.push(u); g.x = (g.x * (g.list.length - 1) + u.x) / g.list.length; g.y = (g.y * (g.list.length - 1) + u.y) / g.list.length; }
        else groups.push({ x: u.x, y: u.y, floor: u.floor, list: [u] });
      }
      const schip = this.chips && this.chips[`${c.charId}_stand`];
      for (const g of groups) {
        const gz = g.floor * FLOOR_H + 0.2;
        const ux = g.x * P, uy = this.sy(g.y, gz);
        const loud = g.list.filter(u => b.isLoud(u.sound)).length;
        const held = g.list.filter(u => u.sound).length;
        const badge = loud ? '#ff7b54' : held ? '#ffe08a' : '#7ad1c5';
        const size = Math.max(20, Math.round(chipSizeFor(P) * 0.42 / 4) * 4);
        if (schip) this.drawChip(schip, ux, uy, size, Math.PI / 2, 0, b.t, { alpha: 0.9, glow: c.color });
        else {
          ctx.fillStyle = badge;
          ctx.beginPath(); ctx.moveTo(ux, uy - 6); ctx.lineTo(ux + 4, uy - 2); ctx.lineTo(ux, uy + 2); ctx.lineTo(ux - 4, uy - 2); ctx.closePath(); ctx.fill();
        }
        // 体数（音を抱えていれば色が変わる。「轟」は大きな音、「音」はそれ以外の音を抱えた数）
        const label = `${g.list.length}体${loud ? `・轟${loud}` : held ? `・音${held}` : ''}`;
        ctx.font = `bold ${Math.max(10, Math.round(size * 0.38))}px sans-serif`;
        const tw = ctx.measureText(label).width + 8;
        const bx = ux + size * 0.25, by = uy - size * 0.95;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, tw, size * 0.42, 6) : ctx.rect(bx, by, tw, size * 0.42); ctx.fill();
        ctx.strokeStyle = badge; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = badge;
        ctx.fillText(label, bx + 4, by + size * 0.34);
      }
    }

    // 飛来物
    for (const p of b.world.projectiles) {
      if (!see(p.x, p.y, p.z)) continue;
      const sp = Math.hypot(p.vx, p.vy) || 1;
      if (this.sheet) {
        // 軌跡の素材：弾は白、投げた物は自分側が青・相手側が赤
        const owner = b.chars.find(c => c.id === p.owner);
        const color = p.kind === 'ball' ? (p.bounces >= 5 ? 'yellow' : 'white') : owner && owner.team === me.team ? 'blue' : 'red';
        const rot = Math.atan2(this.sy(p.y + p.vy / sp, p.z) - this.sy(p.y, p.z), (p.vx / sp) * P);
        const L = P * (p.kind === 'ball' ? 2.2 : 1.6);
        this.sprite(ATLAS.trail[color], p.x * P - Math.cos(rot) * L * 0.45, this.sy(p.y, p.z) - Math.sin(rot) * L * 0.45, L * (38 / 238), { rot });
      }
      if (p.bolt) {
        // 汎用の飛び道具（魔法の弾など）：色つきの光の玉
        const col = p.color || '#ffb347';
        ctx.fillStyle = col;
        ctx.shadowColor = col; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(p.x * P, this.sy(p.y, p.z), Math.max(3, P * 0.18), 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        continue;
      }
      if (p.kind === 'ball') {
        // パチンコ玉
        ctx.fillStyle = '#e8e8f0';
        ctx.beginPath(); ctx.arc(p.x * P, this.sy(p.y, p.z), Math.max(2, P * 0.1), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(232,232,240,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x * P, this.sy(p.y, p.z)); ctx.lineTo((p.x - (p.vx / sp) * 1.5) * P, this.sy(p.y - (p.vy / sp) * 1.5, p.z)); ctx.stroke();
        continue;
      }
      ctx.strokeStyle = p.owner === me.id ? '#9be7ff' : '#ff9b9b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x * P, this.sy(p.y, p.z));
      ctx.lineTo((p.x - (p.vx / sp) * 0.7) * P, this.sy(p.y - (p.vy / sp) * 0.7, p.z - (p.vz / sp) * 0.7));
      ctx.stroke();
    }

    this.drawSafeZone(b);
    this.drawPreview(b, me);

    // 物音：聞こえた音（姿の見えない所の音は推定位置）に、広がる輪と種類を出す
    for (const h of me.memory.heard) {
      const age = b.t - h.t;
      if (age > 3.2) continue;
      const hz = (h.floor ?? 0) * FLOOR_H;
      this.drawSoundMark(h.x * P, this.sy(h.y, hz), age, 3.2, h.kind, `${SOUND_LABEL[h.kind] || '物音'}${h.floor ? '（2階）' : ''}`, true);
    }
    // 防犯アラームが鳴り続けている車
    for (const o of b.world.objects) {
      if (o.kind !== 'car' || !(o.alarmUntil > b.t)) continue;
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      if (!debug && !b.canHear(me, cx, cy, 40, 1)) continue;
      const ph = (b.t * 1.5) % 1;
      this.drawSoundMark(cx * P, this.sy(cy, 1.6), ph, 1, 'alarm', '防犯アラーム', false);
    }

    // 敵の最後の目撃位置（味方からの報告を含む）
    for (const foe of b.enemiesOf(me)) {
      const ls = me.memory.seen[foe.id];
      if (!foe.alive || !ls || visibleChar(foe)) continue;
      const lz = (ls.floor ?? 0) * FLOOR_H;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,120,120,0.8)';
      ctx.beginPath(); ctx.ellipse(ls.x * P, this.sy(ls.y, lz), RULES.charRadius * P, RULES.charRadius * P * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect((ls.x - 0.25) * P, this.sy(ls.y, lz + 1.7), 0.5 * P, 1.7 * K * P);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,160,160,0.95)';
      ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText(`? ${b.teamSize > 1 ? `${foe.name.split(/\s+/)[0]}・` : ''}${(b.t - ls.t).toFixed(0)}秒前${ls.floor ? '・2階' : ''}${ls.via ? '（報告）' : ''}`, ls.x * P + 8, this.sy(ls.y, lz + 1));
    }

    // エフェクト
    for (const f of b.fx) {
      if (!debug && f.visibleTo && !f.visibleTo.has(me.id)) continue;
      const age = b.t - f.t;
      const fy = this.sy(f.y, f.z ?? 1);
      if (f.kind === 'num') {
        // 大ダメージは大きく、跳ねるように出る
        const pop = age < 0.12 ? 1 + (0.12 - age) * (f.big ? 6 : 3) : 1;
        const size = Math.max(12, P * (f.big ? 0.95 : 0.6)) * pop;
        ctx.font = `bold ${size}px sans-serif`;
        ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.strokeText(f.text, f.x * P - 8, fy - age * 0.8 * P - P);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x * P - 8, fy - age * 0.8 * P - P);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'sound') {
        // 見えている所で鳴った音：届く範囲（半径）を一瞬だけ示す
        if (age < 0.9) {
          const r = Math.min(f.radius, 25);
          ctx.strokeStyle = SOUND_COLOR[f.sk] || SOUND_COLOR.default;
          ctx.globalAlpha = 0.5 * (1 - age / 0.9);
          ctx.setLineDash([4, 6]);
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.ellipse(f.x * P, this.sy(f.y, (f.z ?? 1) - 1), r * P * Math.min(1, age * 4 + 0.2), r * P * Math.min(1, age * 4 + 0.2), 0, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          if (f.sk !== 'alarm') this.drawSoundMark(f.x * P, fy, age, 0.9, f.sk, SOUND_LABEL[f.sk] || '物音', false); // アラームは車の印で示す
        }
      } else if (f.kind === 'hit') {
        this.drawHit(f, age, fy);
      } else if (f.kind === 'ko') {
        this.drawKO(f, age, fy);
      } else if (f.kind === 'spark' && this.sheet) {
        this.sprite(this.seq(ATLAS.spark, age / 0.45), f.x * P, fy, P * 1.4, { alpha: age < 0.45 ? 1 : 0 });
        ctx.fillStyle = '#fff3b0';
        ctx.font = `bold ${Math.max(11, P * 0.5)}px monospace`;
        ctx.globalAlpha = Math.max(0, 1 - age / 0.6);
        ctx.fillText(f.text, f.x * P + 4, fy - 4);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'flash' && this.sheet) {
        const k = age / 0.7;
        if (k < 1) this.sprite(ATLAS.aura[AURA_OF[f.charId] || 'white'], f.x * P, fy, P * (1 + k * 3), { alpha: 1 - k });
      } else if (f.kind === 'glass') {
        if (!this.sprite(this.seq(ATLAS.glass, age / 0.6), f.x * P, fy, P * 1.4, { alpha: age < 0.6 ? 1 : 0 })) {
          ctx.globalAlpha = Math.max(0, 1 - age / 0.6);
          ctx.fillStyle = '#cfe8ff';
          for (let i = 0; i < 7; i++) {
            const a = i * 0.9, r = (0.2 + age * 2) * P;
            ctx.fillRect(f.x * P + Math.cos(a) * r, fy + Math.sin(a) * r * 0.7 + age * age * P * 3, 3, 3);
          }
          ctx.globalAlpha = 1;
        }
      } else if (f.kind === 'dust') {
        const dur = f.big ? 1.0 : 0.7;
        if (!this.sprite(this.seq(ATLAS.dust, age / dur), f.x * P, fy, P * (f.big ? 2.4 : 1.4), { alpha: age < dur ? 0.9 : 0, anchorY: 0.7 })) {
          ctx.globalAlpha = Math.max(0, 0.6 * (1 - age / dur));
          ctx.fillStyle = '#b8a890';
          for (let i = 0; i < 5; i++) {
            ctx.beginPath(); ctx.arc(f.x * P + (i - 2) * P * 0.25 * (1 + age), fy - age * P * 0.4, P * (0.15 + age * 0.3), 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      } else if (f.kind === 'shock') {
        const dur = 0.7;
        if (!this.sprite(this.seq(ATLAS.shock, age / dur), f.x * P, fy, P * (f.big ? 3.2 : 2), { alpha: age < dur ? 1 : 0 })) {
          ctx.strokeStyle = '#f3d9a4';
          ctx.lineWidth = 3;
          ctx.globalAlpha = Math.max(0, 1 - age / dur);
          for (const r0 of [0.3, 0.6]) { ctx.beginPath(); ctx.ellipse(f.x * P, fy, (r0 + age * 3) * P, (r0 + age * 3) * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke(); }
          ctx.globalAlpha = 1;
        }
      } else if (f.kind === 'spark') {
        // 跳弾の火花と反射回数
        ctx.globalAlpha = Math.max(0, 1 - age / 0.6);
        ctx.strokeStyle = '#fff3b0';
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(f.x * P, fy);
          ctx.lineTo(f.x * P + Math.cos(a) * P * 0.4, fy + Math.sin(a) * P * 0.4);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff3b0';
        ctx.font = `bold ${Math.max(11, P * 0.5)}px monospace`;
        ctx.fillText(f.text, f.x * P + 4, fy - 4);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'flash') {
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = Math.max(0, 1 - age / 0.8);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(f.x * P, fy, (0.3 + age * 3) * P, (0.3 + age * 3) * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (f.kind === 'mark') {
        // 接触点の直角記号
        ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
        ctx.strokeStyle = '#ffe8a3';
        ctx.lineWidth = 2;
        const s = Math.max(8, P * 0.5);
        const mx = f.x * P, my = fy;
        ctx.beginPath();
        ctx.moveTo(mx - s / 2, my - s / 2);
        ctx.lineTo(mx - s / 2, my + s / 2);
        ctx.lineTo(mx + s / 2, my + s / 2);
        ctx.stroke();
        ctx.strokeRect(mx - s / 2, my + s / 6, s / 3, s / 3);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'measure') {
        // 移動完了時の距離表示（例「10.00」）
        ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
        ctx.font = `bold ${Math.max(12, P * 0.6)}px monospace`;
        const tw = ctx.measureText(f.text).width;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(f.x * P - tw / 2 - 4, fy - P * 1.6, tw + 8, P * 0.75);
        ctx.fillStyle = '#ffe8a3';
        ctx.fillText(f.text, f.x * P - tw / 2, fy - P);
        ctx.globalAlpha = 1;
      }
    }

    // セリフ：自分・味方のセリフと、聞こえた敵のセリフ
    for (const c of b.chars) {
      if (!c.speech) continue;
      if (c === me || visibleChar(c)) {
        if (c === me || debug || c.team === me.team || c.speech.heardBy?.has(me.id) || see(c.x, c.y)) this.drawSpeech(b, c, c.x, c.y, b.baseZ(c), false);
      } else if (c.speech.heardBy?.has(me.id)) {
        const h = [...me.memory.heard].reverse().find(x => x.kind === 'speech');
        if (h) this.drawSpeech(b, c, h.x, h.y, (h.floor ?? 0) * FLOOR_H, true);
      }
    }

    if (hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hover.x * P, this.sy(hover.y, me.floor * FLOOR_H), 4, 0, Math.PI * 2); ctx.stroke();
    }
    // クローズアップ中は上下に黒帯と周辺減光（映画のような見せ方）
    if (cineK > 0) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const vg = ctx.createRadialGradient(this.viewW / 2, this.viewH / 2, Math.min(this.viewW, this.viewH) * 0.25, this.viewW / 2, this.viewH / 2, Math.max(this.viewW, this.viewH) * 0.7);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, `rgba(0,0,0,${0.55 * cineK})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      const bar = this.viewH * 0.085 * cineK;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.viewW, bar);
      ctx.fillRect(0, this.viewH - bar, this.viewW, bar);
    }
  }

  // ---- 建物：屋根で覆う／屋根を外して中を見せる ----
  drawBuilding(b, bd, group, m, ghosts) {
    const ctx = this.ctx, P = this.px;
    const top = bd.floors * FLOOR_H;
    const me = this.viewer || b.player;
    if (m.mode === 'roof') {
      // 外壁（各階）を描いてから屋根で覆う。中の家具・人物は見えない
      const walls = group.filter(it => it.obj && (it.obj.kind === 'wall' || it.obj.kind === 'window' || it.obj.kind === 'door'));
      walls.sort((a, z) => a.key - z.key || a.z - z.z);
      for (const it of walls) it.draw(null);
      ctx.fillStyle = bd.kind === 'store' ? '#9aa4a8' : bd.kind === 'house' ? '#6e4038' : '#7a7a72';
      ctx.fillRect(bd.x * P, this.sy(bd.y, top + 0.2), bd.w * P, bd.h * P);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bd.x * P, this.sy(bd.y, top + 0.2), bd.w * P, bd.h * P);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `${Math.max(10, P * 0.45)}px sans-serif`;
      ctx.fillText(`${bd.name}${bd.floors > 1 ? '（2階建て）' : ''}`, (bd.x + 0.4) * P, this.sy(bd.y + 1, top + 0.2));
      for (const it of group) if (it.char && it.char !== me) ghosts.push(it.char);
      return;
    }
    // 屋根を外した表示：見ている階より上は描かない。今いる階の壁は低く切って中を見やすくする
    const f = m.floor;
    // 物体・人物・スタンドのどれでも、その階で振り分ける
    const floorOf = it => (it.obj ? it.obj.floor : it.char ? it.char.floor : it.floor ?? 0);
    const lower = group.filter(it => floorOf(it) < f);
    const current = group.filter(it => floorOf(it) === f);
    const draw = (list, capFloor) => {
      list.sort((a, z) => a.key - z.key || a.z - z.z);
      for (const it of list) {
        if (it.obj && (it.obj.kind === 'wall' || it.obj.kind === 'window' || it.obj.kind === 'door') && capFloor !== null) it.draw(capFloor);
        else if (it.obj && it.obj.floor < f && !(it.obj.kind === 'wall' || it.obj.kind === 'window' || it.obj.kind === 'door')) continue;
        else it.draw(null);
      }
    };
    if (f >= 1) {
      // 1階の外壁は土台として描き、2階の床を張る
      draw(lower.filter(it => it.obj), null);
      ctx.fillStyle = bd.kind === 'house' ? '#7a6350' : '#7d7a70';
      ctx.fillRect(bd.x * P, this.sy(bd.y, FLOOR_H), bd.w * P, bd.h * P);
      if (bd.stairs) this.drawStairs(bd.stairs, FLOOR_H);
      for (const r of b.world.rubble) if ((r.floor ?? 0) === 1 && pointInRect(r.x + r.w / 2, r.y + r.h / 2, bd)) this.drawRubble(r, FLOOR_H);
      for (const pl of b.world.piles || []) if (pl.floor === 1 && pointInRect(pl.x + pl.w / 2, pl.y + pl.h / 2, bd)) this.drawPile(pl, FLOOR_H);
      for (const it of b.world.items) if ((it.floor ?? 0) === 1 && pointInRect(it.x, it.y, bd)) this.drawItem(it, FLOOR_H);
    }
    draw(current, f * FLOOR_H + 1.1);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `${Math.max(10, P * 0.45)}px sans-serif`;
    ctx.fillText(`${bd.name}・${f + 1}階`, (bd.x + 0.4) * P, this.sy(bd.y + 0.8, f * FLOOR_H));
    // 別の階にいる見えている人物は輪郭で示す
    for (const it of group) if (it.char && it.char.floor !== f && it.char !== me) ghosts.push(it.char);
  }

  drawObject(b, o, cap) {
    const ctx = this.ctx, P = this.px;
    const [top, front] = colorsOf(o, b);
    const z0 = o.z0;
    let z1 = o.z1;
    if (cap !== null && cap !== undefined) z1 = Math.min(z1, cap);
    if (o.kind === 'door') {
      if (o.open) {
        // 開いた扉：枠だけ
        ctx.strokeStyle = 'rgba(200,160,110,0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x * P, this.sy(o.y, z1), o.w * P, o.h * P);
        return;
      }
    }
    if (o.kind === 'window' && o.broken) {
      // 割れた窓：枠（閉まっていれば木枠の色、開いていれば水色）と、枠に残ったガラス片
      const zt = z0 + Math.min(1.2, z1 - z0);
      const x = o.x * P, y = this.sy(o.y, zt), w = Math.max(2, o.w * P), h = Math.max(2, o.h * P);
      ctx.strokeStyle = o.open ? 'rgba(170,225,245,0.9)' : '#a07850';
      ctx.lineWidth = o.open ? 2 : 3;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(190,230,255,0.75)';
      const horiz = w >= h;
      for (let i = 0; i < 3; i++) {
        const k = (i + 0.5) / 3;
        ctx.beginPath();
        if (horiz) { ctx.moveTo(x + w * k - 3, y); ctx.lineTo(x + w * k + 3, y); ctx.lineTo(x + w * k, y + h * 0.9); }
        else { ctx.moveTo(x, y + h * k - 3); ctx.lineTo(x, y + h * k + 3); ctx.lineTo(x + w * 0.9, y + h * k); }
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    if (o.kind === 'window' && o.open) {
      ctx.strokeStyle = 'rgba(170,225,245,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(o.x * P, this.sy(o.y, z0 + Math.min(1.2, z1 - z0)), o.w * P, o.h * P);
      return;
    }
    if (o.kind === 'tree') {
      this.box(o.x + o.w * 0.35, o.y + o.h * 0.35, o.w * 0.3, o.h * 0.3, 0, 2.2, '#5b3a1e', '#4a2f18');
      ctx.fillStyle = top;
      ctx.beginPath(); ctx.ellipse((o.x + o.w / 2) * P, this.sy(o.y + o.h / 2, 3.6), o.w * 1.2 * P, o.w * 1.0 * P, 0, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (o.kind === 'pole') {
      this.box(o.x, o.y, o.w, o.h, 0, Math.min(z1, 7), top, front);
      return;
    }
    if (o.kind === 'drum') {
      ctx.fillStyle = front;
      ctx.fillRect(o.x * P, this.sy(o.y + o.h / 2, z1), o.w * P, (z1 - z0) * K * P);
      ctx.fillStyle = top;
      ctx.beginPath(); ctx.ellipse((o.x + o.w / 2) * P, this.sy(o.y + o.h / 2, z1), (o.w / 2) * P, (o.h / 2) * P, 0, 0, Math.PI * 2); ctx.fill();
      return;
    }
    if (o.kind === 'cone') {
      ctx.fillStyle = top;
      ctx.beginPath();
      ctx.moveTo((o.x + o.w / 2) * P, this.sy(o.y + o.h / 2, z1));
      ctx.lineTo((o.x + o.w) * P, this.sy(o.y + o.h, z0));
      ctx.lineTo(o.x * P, this.sy(o.y + o.h, z0));
      ctx.closePath();
      ctx.fill();
      return;
    }
    this.box(o.x, o.y, o.w, o.h, z0, z1, top, front);
    // 細部
    if (o.kind === 'car') {
      ctx.fillStyle = 'rgba(40,60,80,0.75)';
      const x = o.x * P, y = this.sy(o.y, z1), w = o.w * P, h = o.h * P;
      if (o.w > o.h) { ctx.fillRect(x + w * 0.25, y + h * 0.15, w * 0.15, h * 0.7); ctx.fillRect(x + w * 0.62, y + h * 0.15, w * 0.12, h * 0.7); }
      else { ctx.fillRect(x + w * 0.15, y + h * 0.25, w * 0.7, h * 0.15); ctx.fillRect(x + w * 0.15, y + h * 0.62, w * 0.7, h * 0.12); }
      if (o.alarmUntil > b.t && Math.floor(b.t * 4) % 2 === 0) {
        ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 3; ctx.strokeRect(x - 2, y - 2, w + 4, h + (z1 - z0) * K * P + 4);
      }
    } else if (o.kind === 'crate') {
      ctx.strokeStyle = '#5e3f20';
      ctx.lineWidth = 1.5;
      const x = o.x * P, y = this.sy(o.y, z1), w = o.w * P, h = o.h * P;
      ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + w - 2, y + h - 2); ctx.moveTo(x + w - 2, y + 2); ctx.lineTo(x + 2, y + h - 2); ctx.stroke();
      if (P > 14) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, P * 0.4)}px sans-serif`;
        ctx.fillText(o.name.replace(/木箱|（.*）/g, ''), x + w / 2 - P * 0.12, y - 2);
      }
    } else if (o.kind === 'shelf') {
      ctx.fillStyle = 'rgba(230,80,80,0.7)';
      const x = o.x * P, y = this.sy(o.y, z1);
      for (let i = 0; i < Math.max(o.w, o.h) / 0.5; i++) {
        if (o.w > o.h) ctx.fillRect(x + (i * 0.5 + 0.1) * P, y + o.h * P * 0.25, P * 0.25, o.h * P * 0.5);
        else ctx.fillRect(x + o.w * P * 0.25, y + (i * 0.5 + 0.1) * P, o.w * P * 0.5, P * 0.25);
      }
    } else if (o.kind === 'wall' && o.style === 'panel') {
      ctx.fillStyle = 'rgba(40,90,160,0.6)';
      ctx.fillRect(o.x * P, this.sy(o.y + o.h, z1) + (z1 - z0) * K * P * 0.4, o.w * P, (z1 - z0) * K * P * 0.25);
    }
    if (!o.indestructible && o.hp < o.maxHp) {
      ctx.fillStyle = `rgba(255,80,60,${0.45 * (1 - o.hp / o.maxHp)})`;
      ctx.fillRect(o.x * P, this.sy(o.y, z1), o.w * P, o.h * P);
    }
  }

  drawGround(b) {
    const ctx = this.ctx, P = this.px;
    for (const g of b.world.ground) {
      const x = g.x * P, y = g.y * P, w = g.w * P, h = g.h * P;
      if (g.kind === 'road') {
        ctx.fillStyle = '#3b3b40';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.setLineDash([P * 1.2, P * 1.2]);
        ctx.lineWidth = Math.max(1, P * 0.08);
        ctx.beginPath();
        if (g.w > g.h) { ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); } else { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); }
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (g.kind === 'crosswalk') {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        for (let yy = g.y + 0.3; yy < g.y + g.h - 0.3; yy += 0.9) ctx.fillRect(x, yy * P, w, P * 0.45);
      } else if (g.kind === 'site') {
        ctx.fillStyle = '#6e5e46';
        ctx.fillRect(x, y, w, h);
      } else if (g.kind === 'lot') {
        ctx.fillStyle = '#505055';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        for (let xx = 19.8; xx < 27.5; xx += 3.7) { ctx.beginPath(); ctx.moveTo(xx * P, 29 * P); ctx.lineTo(xx * P, 37 * P); ctx.stroke(); }
      } else if (g.kind === 'park') {
        ctx.fillStyle = '#3d5a34';
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.font = `${Math.max(10, P * 0.5)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (const a of b.world.areas) {
      if (a.floor || /road|crossing|gate/.test(a.id)) continue;
      ctx.fillText(a.name, (a.x + 0.6) * P, (a.y + a.h - 0.6) * P);
    }
  }

  // 粉の山（プリティ・ヴェイカント）：素材の色。散った山は薄く広がる
  drawPile(p, z) {
    const ctx = this.ctx, P = this.px;
    const col = { 'ガラス粉': '205,232,240', '鉄粉': '90,92,98', '鉄粉と木粉': '120,105,90', '木粉': '196,160,110', '樹脂の粉': '230,140,80' }[p.material] || '214,208,196';
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const k = p.scattered ? 1.3 : 0.75;
    ctx.fillStyle = `rgba(${col},${p.scattered ? 0.25 : 0.7})`;
    ctx.beginPath(); ctx.ellipse(cx * P, this.sy(cy, z), (p.w / 2) * k * P, (p.h / 2) * k * P * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    if (!p.scattered) {
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.beginPath(); ctx.ellipse(cx * P, this.sy(cy, z) - P * 0.05, (p.w / 2) * 0.35 * P, (p.h / 2) * 0.3 * P, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawRubble(r, z) {
    const ctx = this.ctx, P = this.px;
    const gravel = r.kind === 'gravel';
    ctx.fillStyle = gravel ? 'rgba(170,150,110,0.6)' : 'rgba(120,110,100,0.55)';
    ctx.fillRect(r.x * P, this.sy(r.y, z), r.w * P, r.h * P);
    ctx.fillStyle = gravel ? 'rgba(110,95,70,0.8)' : 'rgba(60,55,50,0.8)';
    for (let i = 0; i < (r.w * r.h) * 3; i++) {
      const sx = r.x + ((i * 0.618) % 1) * r.w, syy = r.y + ((i * 0.377) % 1) * r.h;
      ctx.fillRect(sx * P, this.sy(syy, z), P * 0.15, P * 0.12);
    }
  }

  drawStairs(s, z) {
    const ctx = this.ctx, P = this.px;
    ctx.fillStyle = 'rgba(210,190,160,0.75)';
    ctx.fillRect(s.x * P, this.sy(s.y, z), s.w * P, s.h * P);
    ctx.strokeStyle = 'rgba(90,70,50,0.8)';
    ctx.lineWidth = 1;
    const steps = Math.round(s.h / 0.3);
    for (let i = 1; i < steps; i++) {
      const yy = s.y + (s.h * i) / steps;
      ctx.beginPath(); ctx.moveTo(s.x * P, this.sy(yy, z)); ctx.lineTo((s.x + s.w) * P, this.sy(yy, z)); ctx.stroke();
    }
  }

  // 屋根で覆われた建物の中・自分のいない階の物は描かない
  hiddenUnderRoof(b, it, modes) {
    const bd = b.world.buildings.find(x => pointInRect(it.x, it.y, x));
    if (!bd) return false;
    const m = modes.get(bd.id);
    return m.mode === 'roof' || (it.floor ?? 0) !== m.floor;
  }

  // 落ちている物（花瓶・鉄パイプなど）
  drawItem(it, z, label = true) {
    const ctx = this.ctx, P = this.px;
    const x = it.x * P, y = this.sy(it.y, z);
    const colors = { drink: '#ff5d73', onigiri: '#f4f4f4', bandage: '#f3e6d0', first_aid: '#e63946', vase: '#e6d3a3', bottle: '#7fd18b', kitchen_knife: '#ddd', pan: '#333', pipe: '#9aa', brick: '#b5523b', wrench: '#bbb', lumber: '#c49a62', umbrella: '#3a6ea5', extinguisher: '#d62828', stone: '#999', branch: '#7a5530' };
    ctx.fillStyle = colors[it.kind] || '#ccc';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    const r = Math.max(3, P * 0.18);
    if (['pipe', 'lumber', 'umbrella', 'branch', 'kitchen_knife', 'wrench'].includes(it.kind)) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5);
      ctx.fillRect(-r * 2, -r * 0.35, r * 4, r * 0.7); ctx.strokeRect(-r * 2, -r * 0.35, r * 4, r * 0.7);
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (label && P > 18) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${Math.max(9, P * 0.36)}px sans-serif`;
      ctx.fillText(it.name, x + r + 2, y + 3);
    }
  }

  // 密室：建物の外周を囲む白い炎（スタンドエネルギー）
  drawFlames(b, bd) {
    const ctx = this.ctx, P = this.px;
    const top = bd.floors * FLOOR_H + 0.6;
    if (this.sheet) {
      // 炎の帯を外周に沿って並べる（少しずつ揺らす）
      const hgt = top * K * P;
      const step = Math.max(1, (hgt * 212) / 135 / P) * 0.8;
      const edges = [];
      for (let x = bd.x; x < bd.x + bd.w; x += step) edges.push([x + step / 2, bd.y], [x + step / 2, bd.y + bd.h]);
      for (let y = bd.y; y < bd.y + bd.h; y += step) edges.push([bd.x, y + step / 2], [bd.x + bd.w, y + step / 2]);
      for (const [x, y] of edges) {
        const flick = 0.85 + 0.15 * Math.sin(b.t * 9 + x * 3.1 + y * 1.7);
        this.sprite(ATLAS.flame[0], x * P, this.sy(y, 0), hgt * flick, { alpha: 0.85, anchorY: 1 });
      }
      return;
    }
    const perim = [];
    for (let x = bd.x; x <= bd.x + bd.w; x += 0.6) perim.push([x, bd.y], [x, bd.y + bd.h]);
    for (let y = bd.y; y <= bd.y + bd.h; y += 0.6) perim.push([bd.x, y], [bd.x + bd.w, y]);
    for (const [x, y] of perim) {
      const flick = 0.6 + 0.4 * Math.sin(b.t * 9 + x * 3.1 + y * 1.7);
      const hgt = top * flick;
      const grad = ctx.createLinearGradient(0, this.sy(y, 0), 0, this.sy(y, hgt));
      grad.addColorStop(0, 'rgba(255,255,255,0.75)');
      grad.addColorStop(0.5, 'rgba(255,190,120,0.45)');
      grad.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo((x - 0.3) * P, this.sy(y, 0));
      ctx.quadraticCurveTo((x - 0.1) * P, this.sy(y, hgt * 0.6), x * P, this.sy(y, hgt));
      ctx.quadraticCurveTo((x + 0.1) * P, this.sy(y, hgt * 0.6), (x + 0.3) * P, this.sy(y, 0));
      ctx.closePath();
      ctx.fill();
    }
  }

  // キャラチップの1コマを描く（足元が (x, footY)）。fps>0 なら走りのアニメ
  drawChip(chip, x, footY, size, facing, fps, t, { prone = false, flash = false, invuln = false, alpha = 1, glow = null } = {}) {
    const ctx = this.ctx;
    const k = ((Math.round(facing / (Math.PI / 4)) % 8) + 8) % 8; // 0=東 1=南東 2=南 …
    const dirIdx = [2, 1, 0, 7, 6, 5, 4, 3][k]; // シートの並び：南・南東・東・北東・北・北西・西・南西
    let sx = dirIdx * CHIP_CELL, sy = 0;
    if (fps && chip.rows >= 5) {
      // 走り：東西南北の4方向。斜めは横向きの絵を使う
      const run = { 0: 1, 1: 1, 2: 0, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1 }[k];
      sx = (Math.floor(t * fps) % 8) * CHIP_CELL;
      sy = (run + 1) * CHIP_CELL;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = (ctx.globalAlpha ?? 1) * alpha;
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 10; }
    if (flash) ctx.filter = 'brightness(3)';
    else if (invuln) ctx.filter = 'brightness(1.5)';
    if (prone) {
      ctx.translate(x, footY - size * 0.15);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(chip.img, sx, sy, CHIP_CELL, CHIP_CELL, -size / 2, -size / 2, size, size);
    } else {
      ctx.drawImage(chip.img, sx, sy, CHIP_CELL, CHIP_CELL, Math.round(x - size / 2), Math.round(footY - size), size, size);
    }
    ctx.restore();
  }

  // 組み立て中の計画：移動の経路（線）と、手順の番号つきの印
  drawPreview(b, me) {
    const pts = this.preview;
    if (!pts || !pts.length) return;
    const ctx = this.ctx, P = this.px;
    const z = me.floor * FLOOR_H;
    ctx.save();
    ctx.strokeStyle = 'rgba(242,193,78,0.9)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(me.x * P, this.sy(me.y, z));
    for (const p of pts) if (p.move) ctx.lineTo(p.x * P, this.sy(p.y, z));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      const x = p.x * P, y = this.sy(p.y, z);
      ctx.fillStyle = p.move ? 'rgba(242,193,78,0.95)' : 'rgba(155,231,255,0.95)';
      ctx.beginPath(); ctx.arc(x, y, Math.max(7, P * 0.32), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `bold ${Math.max(10, P * 0.38)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(p.n), x, y + 0.5);
    }
    ctx.restore();
  }

  // 安全地帯：円の外を暗い紫で覆い、今の縁（実線）と次に縮む先（点線）を描く
  drawSafeZone(b) {
    const z = b.safeZone;
    if (!z) return;
    const ctx = this.ctx, P = this.px;
    const r = b.zoneRadius();
    const next = RULES.zonePhases.find(([, t1]) => b.t < t1);
    const target = next ? b.zoneRadius(next[1]) : r;
    const cx = z.x * P, cy = this.sy(z.y, 0);
    const W = b.world.w * P, top = this.sy(-6, 0), bottom = this.sy(b.world.h + 2, 0);
    ctx.save();
    ctx.fillStyle = 'rgba(90,20,120,0.28)';
    ctx.beginPath();
    ctx.rect(-P * 4, top, W + P * 8, bottom - top);
    ctx.moveTo(cx + r * P, cy);
    ctx.arc(cx, cy, r * P, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(214,170,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r * P, 0, Math.PI * 2); ctx.stroke();
    if (target < r - 0.5) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, target * P, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // 唇の形（食いしばっている時は閉じた歯、喋った直後は開いた口）
  drawLips(x, y, r, biting, open) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#c81d25';
    ctx.strokeStyle = '#2a0508';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * (open && !biting ? 0.62 : 0.45), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = biting ? '#f4f1e8' : '#3a0a0e';
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.7, biting ? r * 0.14 : r * (open ? 0.3 : 0.08), 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // スタンドの姿：チップがあればその絵、無ければ本体の色で半透明に光る人型。本体から離れていれば細い線でつなぐ
  drawStand(b, c) {
    const ctx = this.ctx, P = this.px;
    const sb = c.standBody;
    const car = c.def.standBlind; // 遠隔操作の小さな車両は、床を走る（浮かない・本体と線でつながない）
    const z = sb.floor * FLOOR_H + (car ? 0.02 : 0.35 + Math.sin(b.t * 4 + c.x) * 0.06);
    const x = sb.x * P, footY = this.sy(sb.y, z), headY = this.sy(sb.y, z + 1.85);
    const bw = c.r * 1.25 * P;
    ctx.save();
    if (!car && dist(sb.x, sb.y, c.x, c.y) > 0.4) {
      ctx.strokeStyle = `${c.color}66`;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(c.x * P, this.sy(c.y, b.baseZ(c) + 1.2)); ctx.lineTo(x, this.sy(sb.y, z + 1.2)); ctx.stroke();
      ctx.setLineDash([]);
    }
    const schip = this.chips && this.chips[`${c.charId}_stand`];
    if (schip) {
      const size = Math.round(chipSizeFor(P) * (car ? 0.6 : 1));
      this.drawChip(schip, x, footY, size, sb.facing, 0, b.t, { alpha: 0.85, glow: c.color });
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(9, P * 0.36)}px sans-serif`;
      ctx.fillText(`『${c.stand}』`, x - size * 0.4, footY - size - 2);
      ctx.restore();
      return;
    }
    ctx.shadowColor = c.color;
    ctx.shadowBlur = 12;
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = `${c.color}aa`;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - bw / 2, headY + bw * 0.7, bw, footY - headY - bw * 0.7, bw / 2) : ctx.rect(x - bw / 2, headY + bw * 0.7, bw, footY - headY - bw * 0.7);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, headY + bw * 0.45, bw * 0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // 構えた腕（向いている方へ）
    ctx.lineWidth = Math.max(2, bw * 0.28);
    ctx.strokeStyle = `${c.color}dd`;
    const ay = (headY + footY) / 2 - bw * 0.3;
    ctx.beginPath(); ctx.moveTo(x, ay); ctx.lineTo(x + Math.cos(sb.facing) * bw * 1.4, ay + Math.sin(sb.facing) * bw * 0.8); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(9, P * 0.36)}px sans-serif`;
    ctx.fillText(`『${c.stand}』`, x - bw, headY - 3);
    ctx.restore();
  }

  drawGhost(b, c) {
    const ctx = this.ctx, P = this.px;
    const z = b.baseZ(c);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.strokeRect((c.x - 0.25) * P, this.sy(c.y, z + 1.7), 0.5 * P, 1.7 * K * P);
    ctx.setLineDash([]);
    ctx.fillStyle = c.color;
    ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
    ctx.fillText(`${c.name}（窓越し）`, (c.x + 0.4) * P, this.sy(c.y, z + 1.7));
  }

  // 音の印：波紋3重＋音の種類の札（推定位置なら「?」付き）
  drawSoundMark(x, y, age, dur, kind, label, approx) {
    const ctx = this.ctx, P = this.px;
    const k = age / dur;
    const color = SOUND_COLOR[kind] || SOUND_COLOR.default;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const kk = (k * 1.6 + i * 0.25) % 1;
      ctx.globalAlpha = Math.max(0, (1 - kk) * (1 - k * 0.6));
      ctx.beginPath(); ctx.ellipse(x, y, (0.3 + kk * 1.4) * P, (0.3 + kk * 1.4) * P * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, k - 0.6) * 2.5);
    ctx.font = `bold ${Math.max(11, P * 0.45)}px sans-serif`;
    const text = `♪ ${label}${approx ? '？' : ''}`;
    const tw = ctx.measureText(text).width + 10;
    const bx = x + P * 0.4, by = y - P * 1.1;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, by, tw, Math.max(15, P * 0.62));
    ctx.fillStyle = color;
    ctx.fillText(text, bx + 5, by + Math.max(11, P * 0.47));
    ctx.restore();
  }

  // 打撃の瞬間：衝撃の閃光・集中線・擬音
  drawHit(f, age, fy) {
    const ctx = this.ctx, P = this.px;
    const x = f.x * P;
    const power = Math.min(1, f.dmg / 30);
    if (this.sheet) {
      if (age < 0.35) {
        if (f.dmg >= 15 && age < 0.3) this.sprite(ATLAS.speedLines[0], x, fy, P * (3 + power * 2), { alpha: 0.75 * (1 - age / 0.3), rot: f.ang });
        const frames = f.dmg >= 10 && !f.guarded ? ATLAS.hitBig : ATLAS.hitSmall;
        this.sprite(this.seq(frames, age / 0.35), x, fy, P * (1.2 + power * 2.2));
      }
      if (f.dmg >= 5 && age < 1.0) {
        const pop = age < 0.1 ? 1.4 - age * 4 : 1;
        this.sprite(ATLAS.ono[onomatopoeia(f)], x + P * 1.4, fy - P * (2.0 + age * 0.5), P * (0.9 + power * 1.1) * pop, { alpha: Math.max(0, 1 - Math.max(0, age - 0.5) * 2), rot: -0.18 + ((f.seq * 37) % 10) / 30 });
      }
      return;
    }
    if (age < 0.35) {
      const k = age / 0.35;
      ctx.globalAlpha = 1 - k;
      // 衝撃の星形
      const R = P * (0.5 + power * 1.1) * (0.6 + k * 0.8);
      ctx.fillStyle = f.guarded ? '#cfd8ff' : '#fff6d0';
      ctx.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = f.ang + (i / 16) * Math.PI * 2;
        const r = i % 2 ? R * 0.45 : R;
        ctx.lineTo(x + Math.cos(a) * r, fy + Math.sin(a) * r * 0.8);
      }
      ctx.closePath();
      ctx.fill();
      // 集中線
      ctx.strokeStyle = f.guarded ? '#9fb3ff' : '#ff5d3a';
      ctx.lineWidth = 2;
      for (let i = 0; i < 10; i++) {
        const a = f.ang + (i / 10) * Math.PI * 2 + 0.2;
        const r0 = R * 0.9, r1 = R * (1.4 + power);
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r0, fy + Math.sin(a) * r0 * 0.8);
        ctx.lineTo(x + Math.cos(a) * r1, fy + Math.sin(a) * r1 * 0.8);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // 擬音（ジョジョ風の書き文字）
    if (f.dmg >= 5 && age < 1.0) {
      const word = onomatopoeia(f);
      const size = Math.max(14, P * (0.7 + power * 0.9)) * (age < 0.1 ? 1.4 - age * 4 : 1);
      ctx.save();
      ctx.translate(x + P * 1.1, fy - P * (2.0 + age * 0.5));
      ctx.rotate(-0.18 + ((f.seq * 37) % 10) / 30);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 0.5) * 2);
      ctx.font = `900 italic ${size}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
      ctx.lineWidth = Math.max(3, size / 7);
      ctx.strokeStyle = '#1a0a2a';
      ctx.strokeText(word, 0, 0);
      ctx.fillStyle = f.guarded ? '#cfd8ff' : power > 0.5 ? '#ff4d6d' : '#ffd166';
      ctx.fillText(word, 0, 0);
      ctx.restore();
    }
  }

  drawKO(f, age, fy) {
    const ctx = this.ctx, P = this.px;
    if (this.sheet) {
      const a = Math.min(1, age * 4) * Math.max(0, 1 - Math.max(0, age - 1.8) * 1.5);
      const pop = age < 0.15 ? 1.6 - age * 4 : 1;
      this.sprite(ATLAS.retire[0], f.x * P, fy - P * 2.2, P * 1.7 * pop, { alpha: a });
      return;
    }
    ctx.save();
    ctx.globalAlpha = Math.min(1, age * 4) * Math.max(0, 1 - Math.max(0, age - 1.8) * 1.5);
    const size = Math.max(18, P * 1.1);
    ctx.font = `900 ${size}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
    const text = '再起不能（リタイヤ）';
    const w = ctx.measureText(text).width;
    const x = Math.min(Math.max(4, f.x * P - w / 2), this.canvas.width / this.dpr + this.offX - w - 4);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, x, fy - P * 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, fy - P * 2);
    ctx.restore();
  }

  drawChar(b, c, isMe, isAlly = false) {
    const ctx = this.ctx, P = this.px;
    const s = c.status;
    const z = b.baseZ(c);
    const groundZ = c.floor * FLOOR_H;
    const air = b.isAirborne(c);
    // 弾き出し中の軌跡
    if (c.launch) {
      ctx.strokeStyle = 'rgba(255,232,163,0.7)';
      ctx.lineWidth = Math.max(2, P * 0.15);
      ctx.beginPath(); ctx.moveTo(c.launch.sx * P, this.sy(c.launch.sy, z + 1)); ctx.lineTo(c.x * P, this.sy(c.y, z + 1)); ctx.stroke();
    }
    // 影
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(c.x * P, this.sy(c.y, groundZ), c.r * P, c.r * P * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    if (!c.alive) {
      ctx.fillStyle = 'rgba(120,120,120,0.85)';
      ctx.fillRect((c.x - 0.8) * P, this.sy(c.y + 0.2, groundZ + 0.3), 1.6 * P, 0.4 * P);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText('再起不能', (c.x - 0.8) * P, this.sy(c.y, groundZ + 0.8));
      return;
    }
    if (isMe && !this.spectate) {
      // 視界の扇形（足元の高さ）
      ctx.fillStyle = 'rgba(255,255,220,0.05)';
      ctx.beginPath();
      ctx.moveTo(c.x * P, this.sy(c.y, groundZ));
      ctx.ellipse(c.x * P, this.sy(c.y, groundZ), RULES.visionRange * P, RULES.visionRange * P, 0, c.facing - RULES.visionFov / 2, c.facing + RULES.visionFov / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = (c.floor === 0 && b.bushAt(c.x, c.y)) || s.hideUntil > b.t ? 0.5 : 1;
    const h = 1.75;
    const chip = this.chips && this.chips[c.charId];
    const chipSize = chipSizeFor(P);
    const x = c.x * P, footY = this.sy(c.y, z);
    const headY = chip ? footY - chipSize * 0.95 : this.sy(c.y, z + h);
    const bw = chip ? chipSize * 0.22 : c.r * 1.3 * P;
    // スタンドのオーラ
    ctx.fillStyle = c.windup ? 'rgba(255,80,80,0.35)' : `${c.color}33`;
    ctx.beginPath(); ctx.ellipse(x, (footY + headY) / 2, bw * 1.6, (footY - headY) * 0.75, 0, 0, Math.PI * 2); ctx.fill();
    // 構え・発動待ちの間は「ゴゴゴ」
    if (c.windup && this.sheet) {
      this.sprite(ATLAS.gogogo[0], x + bw * 2.2 + Math.sin(b.t * 40) * 1.5, (headY + footY) / 2, P * 1.7, { alpha: 0.9 });
    } else if (c.windup) {
      ctx.save();
      ctx.font = `900 italic ${Math.max(11, P * 0.5)}px serif`;
      ctx.fillStyle = 'rgba(190,120,255,0.9)';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      const jx = Math.sin(b.t * 40) * 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.strokeText('ゴ', x + bw * 1.6 + jx, headY + i * P * 0.45);
        ctx.fillText('ゴ', x + bw * 1.6 + jx, headY + i * P * 0.45);
      }
      ctx.restore();
    }
    const prone = s.proneUntil > b.t;
    const hitFlash = b.t - c.lastDamagedAt < 0.12;
    if (chip) {
      // キャラチップ：足元に本人の色の輪、向きと移動でコマを選ぶ
      ctx.strokeStyle = isMe ? '#06d6a0' : isAlly ? '#4cc9f0' : '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, footY, c.r * P * 1.1, c.r * P * 0.65, 0, 0, Math.PI * 2); ctx.stroke();
      const moving = Math.hypot(c.vx, c.vy) > 0.4;
      this.drawChip(chip, x, footY, chipSize, c.facing, moving ? (Math.hypot(c.vx, c.vy) > c.def.walk + 0.3 ? 14 : 9) : 0, b.t, { prone, flash: hitFlash, invuln: s.invulnUntil > b.t });
    } else {
      // 体（縦長のカプセル）と頭。殴られた瞬間は白く光る
      ctx.fillStyle = hitFlash ? '#fff' : prone ? '#777' : c.color;
      ctx.strokeStyle = s.invulnUntil > b.t ? '#fff' : '#111';
      ctx.lineWidth = 2;
      if (prone) {
        ctx.fillRect(x - bw * 1.5, footY - bw, bw * 3, bw);
      } else {
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x - bw / 2, headY + bw * 0.6, bw, footY - headY - bw * 0.6, bw / 2) : ctx.rect(x - bw / 2, headY + bw * 0.6, bw, footY - headY - bw * 0.6);
        ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, headY + bw * 0.4, bw * 0.55, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      // 向き（足元の矢印）
      ctx.fillStyle = '#fff';
      const fx0 = x + Math.cos(c.facing) * c.r * 1.7 * P, fy0 = footY + Math.sin(c.facing) * c.r * 1.7 * P * 0.6;
      ctx.beginPath();
      ctx.moveTo(fx0, fy0);
      ctx.lineTo(x + Math.cos(c.facing + 2.6) * c.r * P * 0.8, footY + Math.sin(c.facing + 2.6) * c.r * P * 0.5);
      ctx.lineTo(x + Math.cos(c.facing - 2.6) * c.r * P * 0.8, footY + Math.sin(c.facing - 2.6) * c.r * P * 0.5);
      ctx.closePath();
      ctx.fill();
    }
    // 手に持っている物
    if (c.held) {
      this.drawItem({ ...c.held, x: c.x + Math.cos(c.facing + 0.8) * c.r * 1.2, y: c.y + Math.sin(c.facing + 0.8) * c.r * 1.2 }, z + 1.0, false);
    }
    // 受け流しの構え（青い弧）・開いた傘・組み付かれている
    if (s.counterUntil > b.t) {
      ctx.strokeStyle = '#6cf';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, (footY + headY) / 2, bw * 1.6, (footY - headY) * 0.65, 0, c.facing - 1.4, c.facing + 1.4); ctx.stroke();
    }
    if (s.umbrellaUntil > b.t) {
      const ux = x + Math.cos(c.facing) * bw * 1.6, uy = (footY + headY) / 2 + Math.sin(c.facing) * bw;
      ctx.fillStyle = 'rgba(58,110,165,0.85)';
      ctx.beginPath(); ctx.ellipse(ux, uy, bw * 1.2, bw * 1.5, c.facing, -Math.PI / 2, Math.PI / 2); ctx.fill();
    }
    if (s.grabbedUntil > b.t) {
      ctx.fillStyle = '#ffd166';
      ctx.font = `bold ${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText('組み付かれ', x - bw * 1.5, footY + Math.max(12, P * 0.5));
    }
    if (s.guardUntil > b.t) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(x, (footY + headY) / 2, bw * 1.4, (footY - headY) * 0.6, 0, c.facing - 1.2, c.facing + 1.2); ctx.stroke();
    }
    // HP バーと名札
    const barW = P * 1.2;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - barW / 2, headY - 10, barW, 5);
    ctx.fillStyle = this.spectate ? (c.team === 0 ? '#4cc9f0' : '#ff6b6b') : isMe ? '#06d6a0' : isAlly ? '#4cc9f0' : '#ff6b6b';
    ctx.fillRect(x - barW / 2, headY - 10, barW * (c.hp / c.maxHp), 5);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
    const tags = [];
    if (c.floor === 1) tags.push('2階');
    if (prone) tags.push('転倒');
    if (s.stunUntil > b.t) tags.push('怯み');
    if (c.climb) tags.push('階段');
    if ((c.floor === 0 && b.bushAt(c.x, c.y)) || s.hideUntil > b.t) tags.push('潜伏');
    if (air) tags.push('空中');
    const label = this.spectate ? `${b.teamSize > 1 ? (c.team === 0 ? 'A:' : 'B:') : ''}${c.name}` : isMe ? '自分' : isAlly ? `味方:${c.name}` : c.name;
    ctx.fillText(`${label}${tags.length ? ` [${tags.join('・')}]` : ''}`, x - barW / 2, headY - 14);
    ctx.globalAlpha = 1;
  }

  drawSpeech(b, c, x, y, z, approx) {
    if (!c.speech) return;
    const ctx = this.ctx, P = this.px;
    const text = approx ? `（声）「${c.speech.text}」` : `「${c.speech.text}」`;
    ctx.font = `${Math.max(11, P * 0.48)}px sans-serif`;
    const w = ctx.measureText(text).width + 12;
    const bx = Math.min(Math.max(4, x * P - w / 2), b.world.w * P - w - 4);
    const by = Math.max(4, this.sy(y, z + 2.6));
    ctx.fillStyle = approx ? 'rgba(255,255,255,0.7)' : '#fff';
    ctx.fillRect(bx, by, w, P * 0.8);
    ctx.fillStyle = '#111';
    ctx.fillText(text, bx + 6, by + P * 0.58);
  }
}
