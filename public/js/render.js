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
};

const CAR_COLORS = ['#c0392b', '#f4f4f4', '#2c3e50', '#2980b9', '#7f8c8d'];

// 物体の色：[上面, 手前の面]
function colorsOf(o, b) {
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

// 打撃の種類と強さに応じた擬音
function onomatopoeia(f) {
  const strong = f.dmg >= 15;
  if (f.guarded) return 'ガッ';
  switch (f.hitKind) {
    case 'ball': return f.dmg >= 22 ? 'ドギュン' : 'ビシッ';
    case 'thrown': return strong ? 'ガシャァン' : 'ゴッ';
    case 'roar': return 'ゴォォン';
    case 'burn': return 'ジュウッ';
    case 'fall': return 'ドサッ';
    case 'launch_impact': case 'slam': return 'ドグシャァ';
    case 'debris': return 'ガラガラ';
    default: return strong ? (f.seq % 2 ? 'ドゴォ' : 'バキィ') : f.seq % 2 ? 'ボゴッ' : 'ドスッ';
  }
}

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

  currentShake(now) {
    return this.shakeAmp * Math.exp(-(now - this.shakeAt) / 110);
  }

  resize(battle) {
    const wrap = this.canvas.parentElement;
    const w = Math.min(wrap.clientWidth, 1100);
    const fit = w / battle.world.w;
    this.viewW = w;
    // 上端の建物の屋根が切れないよう、上に余白をとる
    this.topPad = 3.6 * K * fit;
    this.viewH = Math.round(fit * battle.world.h + this.topPad);
    this.px = this.zoom === 'near' ? Math.max(fit * 2.2, 30) : fit;
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

  draw(b, { debug = false, hover = null, viewer = null } = {}) {
    const ctx = this.ctx, P = this.px;
    const me = this.viewer = viewer || b.player;
    const see = (x, y, z) => debug || b.canSee(me, x, y, z);
    const shake = this.currentShake(performance.now());
    const sx = shake > 0.3 ? (Math.random() - 0.5) * 2 * shake : 0, syy = shake > 0.3 ? (Math.random() - 0.5) * 2 * shake : 0;
    const W = b.world.w * P, H = b.world.h * P;

    // カメラ（拡大時は自分を中心に）
    if (this.zoom === 'near') {
      this.offX = clamp(me.x * P - this.viewW / 2, 0, Math.max(0, W - this.viewW));
      this.offY = clamp(this.sy(me.y, b.baseZ(me)) - this.viewH / 2, -P * 2, Math.max(0, H - this.viewH));
    } else {
      this.offX = 0;
      this.offY = -this.topPad;
    }
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
        const sItem = { key: sb.y + 0.2, z: sb.floor * FLOOR_H, draw: () => this.drawStand(b, c) };
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

    // エコー・ビーチの個体：自分の個体は常に、相手の個体はすぐそば（2.5m以内）だけ見える
    for (const c of b.chars) {
      if (!c.units) continue;
      for (const u of c.units) {
        if (u.state === 'dead' || u.state === 'home') continue;
        const mine = c === me;
        if (!mine && !debug && (u.floor !== me.floor || Math.hypot(u.x - me.x, u.y - me.y) > 2.5)) continue;
        const uz = u.floor * FLOOR_H + (u.state === 'attached' ? 1.4 : 0.6);
        const ux = u.x * P, uy = this.sy(u.y, uz);
        ctx.fillStyle = u.sound ? (b.isLoud(u.sound) ? '#ff7b54' : '#ffe08a') : '#7ad1c5';
        ctx.beginPath();
        ctx.moveTo(ux, uy - 4); ctx.lineTo(ux + 3, uy); ctx.lineTo(ux, uy + 4); ctx.lineTo(ux - 3, uy);
        ctx.closePath();
        ctx.fill();
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

    // 物音
    for (const h of me.memory.heard) {
      const age = b.t - h.t;
      if (age > 2.5) continue;
      const hz = (h.floor ?? 0) * FLOOR_H;
      ctx.strokeStyle = `rgba(255,230,120,${0.8 * (1 - age / 2.5)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(h.x * P, this.sy(h.y, hz), (0.4 + age * 0.8) * P, (0.4 + age * 0.8) * P * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,230,120,${1 - age / 2.5})`;
      ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText(`♪${SOUND_LABEL[h.kind] || '物音'}${h.floor ? '（2階）' : ''}`, h.x * P + 6, this.sy(h.y, hz) - 6);
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
    const lower = group.filter(it => (it.obj ? it.obj.floor : it.char.floor) < f);
    const current = group.filter(it => (it.obj ? it.obj.floor : it.char.floor) === f);
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
    const colors = { vase: '#e6d3a3', bottle: '#7fd18b', kitchen_knife: '#ddd', pan: '#333', pipe: '#9aa', brick: '#b5523b', wrench: '#bbb', lumber: '#c49a62', umbrella: '#3a6ea5', extinguisher: '#d62828', stone: '#999', branch: '#7a5530' };
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

  // スタンドの姿：本体の色で半透明に光る人型。本体から離れていれば細い線でつなぐ
  drawStand(b, c) {
    const ctx = this.ctx, P = this.px;
    const sb = c.standBody;
    const z = sb.floor * FLOOR_H + 0.35 + Math.sin(b.t * 4 + c.x) * 0.06;
    const x = sb.x * P, footY = this.sy(sb.y, z), headY = this.sy(sb.y, z + 1.85);
    const bw = c.r * 1.25 * P;
    ctx.save();
    if (dist(sb.x, sb.y, c.x, c.y) > 0.4) {
      ctx.strokeStyle = `${c.color}66`;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(c.x * P, this.sy(c.y, b.baseZ(c) + 1.2)); ctx.lineTo(x, this.sy(sb.y, z + 1.2)); ctx.stroke();
      ctx.setLineDash([]);
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
    if (isMe) {
      // 視界の扇形（足元の高さ）
      ctx.fillStyle = 'rgba(255,255,220,0.05)';
      ctx.beginPath();
      ctx.moveTo(c.x * P, this.sy(c.y, groundZ));
      ctx.ellipse(c.x * P, this.sy(c.y, groundZ), RULES.visionRange * P, RULES.visionRange * P, 0, c.facing - RULES.visionFov / 2, c.facing + RULES.visionFov / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = c.floor === 0 && b.bushAt(c.x, c.y) ? 0.55 : 1;
    const h = 1.75;
    const x = c.x * P, footY = this.sy(c.y, z), headY = this.sy(c.y, z + h);
    const bw = c.r * 1.3 * P;
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
    // 体（縦長のカプセル）と頭。殴られた瞬間は白く光る
    const prone = s.proneUntil > b.t;
    const hitFlash = b.t - c.lastDamagedAt < 0.12;
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
    // 手に持っている物
    if (c.held) {
      this.drawItem({ ...c.held, x: c.x + Math.cos(c.facing + 0.8) * c.r * 1.2, y: c.y + Math.sin(c.facing + 0.8) * c.r * 1.2 }, z + 1.0, false);
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
    ctx.fillStyle = isMe ? '#06d6a0' : isAlly ? '#4cc9f0' : '#ff6b6b';
    ctx.fillRect(x - barW / 2, headY - 10, barW * (c.hp / c.maxHp), 5);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
    const tags = [];
    if (c.floor === 1) tags.push('2階');
    if (prone) tags.push('転倒');
    if (s.stunUntil > b.t) tags.push('怯み');
    if (c.climb) tags.push('階段');
    if (c.floor === 0 && b.bushAt(c.x, c.y)) tags.push('潜伏');
    if (air) tags.push('空中');
    ctx.fillText(`${isMe ? '自分' : isAlly ? `味方:${c.name}` : c.name}${tags.length ? ` [${tags.join('・')}]` : ''}`, x - barW / 2, headY - 14);
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
