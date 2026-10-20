// フィールド描画。プレイヤーが知覚できるものだけを描く（debug 時は全表示）
import { RULES } from './engine/data.js';
import { clamp } from './engine/vec.js';

const SOUND_LABEL = {
  footsteps: '足音', footsteps_run: '駆ける足音', speech: '声', impact: '衝撃音', crash: '崩れる音',
  glass: 'ガラスの音', fall: '倒れる音', throw: '風切り音', swing: '風切り音', ability: '異音', combat: '物音',
  env: '物音', damage: '打撃音', rustle: '葉擦れの音', alarm: '防犯アラーム',
};

const CAR_COLORS = ['#c0392b', '#f4f4f4', '#2c3e50', '#2980b9', '#7f8c8d'];

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
  }

  resize(battle) {
    const wrap = this.canvas.parentElement;
    const w = Math.min(wrap.clientWidth, 1100);
    const fit = w / battle.world.w;
    this.viewW = w;
    this.viewH = Math.round(fit * battle.world.h);
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

  toWorld(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left + this.offX) / this.px, y: (clientY - r.top + this.offY) / this.px };
  }

  computeFog(b, viewer) {
    const step = 0.75;
    const cols = Math.ceil(b.world.w / step), rows = Math.ceil(b.world.h / step);
    const vis = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        vis[r * cols + c] = b.canSee(viewer, (c + 0.5) * step, (r + 0.5) * step) ? 1 : 0;
      }
    }
    this.fog = { step, cols, rows, vis };
  }

  draw(b, { debug = false, hover = null } = {}) {
    const ctx = this.ctx, P = this.px;
    const me = b.player, foe = b.cpu;
    const see = (x, y) => debug || b.canSee(me, x, y);
    const W = b.world.w * P, H = b.world.h * P;

    // カメラ（拡大時は自分を中心に）
    if (this.zoom === 'near') {
      this.offX = clamp(me.x * P - this.viewW / 2, 0, Math.max(0, W - this.viewW));
      this.offY = clamp(me.y * P - this.viewH / 2, 0, Math.max(0, H - this.viewH));
    } else {
      this.offX = 0;
      this.offY = 0;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, -this.offX * this.dpr, -this.offY * this.dpr);

    ctx.fillStyle = '#4a4f3f';
    ctx.fillRect(0, 0, W, H);
    this.drawGround(b);

    for (const bd of b.world.buildings) {
      ctx.fillStyle = { store: '#c9d1d3', office: '#8a8676', toilet: '#8c99a6' }[bd.kind] || '#6b5848';
      ctx.fillRect(bd.x * P, bd.y * P, bd.w * P, bd.h * P);
      ctx.fillStyle = bd.kind === 'store' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.45)';
      ctx.font = `${Math.max(10, P * 0.45)}px sans-serif`;
      ctx.fillText(bd.name, (bd.x + 0.5) * P, (bd.y + 1) * P);
    }
    for (const r of b.world.rubble) {
      const gravel = r.kind === 'gravel';
      ctx.fillStyle = gravel ? 'rgba(170,150,110,0.6)' : 'rgba(120,110,100,0.55)';
      ctx.fillRect(r.x * P, r.y * P, r.w * P, r.h * P);
      ctx.fillStyle = gravel ? 'rgba(110,95,70,0.8)' : 'rgba(60,55,50,0.8)';
      for (let i = 0; i < (r.w * r.h) * 3; i++) {
        const sx = r.x + ((i * 0.618) % 1) * r.w, sy = r.y + ((i * 0.377) % 1) * r.h;
        ctx.fillRect(sx * P, sy * P, P * 0.15, P * 0.12);
      }
    }

    // 領域
    for (const z of b.world.zones) {
      const mine = z.owner === me.id;
      if (z.kind === 'silence' && !mine && !debug) continue;
      if (z.kind !== 'silence' && !mine && !see(z.x, z.y)) continue;
      ctx.beginPath();
      ctx.arc(z.x * P, z.y * P, z.r * P, 0, Math.PI * 2);
      if (z.kind === 'slick') { ctx.fillStyle = 'rgba(120,220,255,0.22)'; ctx.fill(); ctx.strokeStyle = 'rgba(160,240,255,0.6)'; }
      else if (z.kind === 'grip') { ctx.fillStyle = 'rgba(140,90,40,0.3)'; ctx.fill(); ctx.strokeStyle = 'rgba(200,140,80,0.6)'; }
      else { ctx.strokeStyle = 'rgba(200,150,255,0.55)'; ctx.setLineDash([4, 4]); }
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 物体
    for (const o of b.world.objects) this.drawObject(b, o, see);
    for (const bd of b.world.buildings) {
      for (const d of bd.doors) {
        ctx.fillStyle = 'rgba(255,220,150,0.5)';
        ctx.fillRect((d.x - 0.15) * P, (d.y - 0.15) * P, 0.3 * P, 0.3 * P);
      }
    }

    ctx.font = `${Math.max(10, P * 0.5)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (const a of b.world.areas) {
      if (a.id === 'area_main_road' || a.id === 'area_cross_road' || a.id === 'area_crossing' || a.id === 'area_site_gate') continue;
      ctx.fillText(a.name, (a.x + 0.6) * P, (a.y + a.h - 0.6) * P);
    }

    // 霧（見えていない場所を暗く）
    if (!debug) {
      if (!this.fog || this.fogFrame++ % 5 === 0) this.computeFog(b, me);
      const f = this.fog;
      ctx.fillStyle = 'rgba(8,8,16,0.42)';
      for (let r = 0; r < f.rows; r++) {
        for (let c = 0; c < f.cols; c++) {
          if (!f.vis[r * f.cols + c]) ctx.fillRect(c * f.step * P, r * f.step * P, f.step * P + 0.5, f.step * P + 0.5);
        }
      }
    }

    // 落ちているナイフ・飛来物
    for (const pk of b.world.pickups) {
      if (!see(pk.x, pk.y)) continue;
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo((pk.x - 0.2) * P, (pk.y + 0.1) * P); ctx.lineTo((pk.x + 0.2) * P, (pk.y - 0.1) * P); ctx.stroke();
    }
    for (const p of b.world.projectiles) {
      if (!see(p.x, p.y)) continue;
      const sp = Math.hypot(p.vx, p.vy);
      ctx.strokeStyle = p.owner === me.id ? '#9be7ff' : '#ff9b9b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x * P, p.y * P);
      ctx.lineTo((p.x - (p.vx / sp) * 0.7) * P, (p.y - (p.vy / sp) * 0.7) * P);
      ctx.stroke();
    }

    // 物音
    for (const h of me.memory.heard) {
      const age = b.t - h.t;
      if (age > 2.5) continue;
      ctx.strokeStyle = `rgba(255,230,120,${0.8 * (1 - age / 2.5)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(h.x * P, h.y * P, (0.4 + age * 0.8) * P, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,230,120,${1 - age / 2.5})`;
      ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText(`♪${SOUND_LABEL[h.kind] || '物音'}`, h.x * P + 6, h.y * P - 6);
    }

    // 敵の最後の目撃位置
    const ls = me.memory.lastSeen;
    const foeVisible = foe.alive && see(foe.x, foe.y);
    if (!foeVisible && ls && foe.alive) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,120,120,0.7)';
      ctx.beginPath(); ctx.arc(ls.x * P, ls.y * P, RULES.charRadius * P, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,160,160,0.9)';
      ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
      ctx.fillText(`? ${(b.t - ls.t).toFixed(0)}秒前`, ls.x * P + 8, ls.y * P + 4);
    }

    this.drawChar(b, me, true);
    if (foeVisible || (!foe.alive && see(foe.x, foe.y))) this.drawChar(b, foe, false);

    // エフェクト
    for (const f of b.fx) {
      if (!debug && f.visibleTo && !f.visibleTo.has(me.id)) continue;
      const age = b.t - f.t;
      if (f.kind === 'num') {
        ctx.fillStyle = f.color;
        ctx.font = `bold ${Math.max(12, P * 0.6)}px sans-serif`;
        ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
        ctx.fillText(f.text, f.x * P - 8, (f.y - age * 0.8) * P);
        ctx.globalAlpha = 1;
      } else if (f.kind === 'flash') {
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = Math.max(0, 1 - age / 0.8);
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(f.x * P, f.y * P, (0.3 + age * 3) * P, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // セリフ
    this.drawSpeech(b, me, me.x, me.y, false);
    if (foe.speech && (foe.speech.heardByEnemy || debug)) {
      if (foeVisible) this.drawSpeech(b, foe, foe.x, foe.y, false);
      else {
        const h = [...me.memory.heard].reverse().find(x => x.kind === 'speech');
        if (h) this.drawSpeech(b, foe, h.x, h.y, true);
      }
    }

    if (hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hover.x * P, hover.y * P, 4, 0, Math.PI * 2); ctx.stroke();
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
  }

  drawObject(b, o, see) {
    const ctx = this.ctx, P = this.px;
    const x = o.x * P, y = o.y * P, w = o.w * P, h = o.h * P;
    const slick = o.slickUntil > b.t;
    const damaged = !o.indestructible && o.hp < o.maxHp;
    switch (o.kind) {
      case 'wall': {
        ctx.fillStyle = o.indestructible ? '#1c1c22'
          : o.created ? '#6d5f86'
            : o.style === 'block' ? '#8d8b84'
              : o.style === 'panel' ? '#d8d0b0'
                : o.style === 'concrete' ? '#a3a3a3' : '#2c2b33';
        ctx.fillRect(x, y, w, h);
        if (o.style === 'panel') {
          ctx.fillStyle = 'rgba(40,90,160,0.6)';
          if (o.w > o.h) ctx.fillRect(x, y + h * 0.35, w, h * 0.3); else ctx.fillRect(x + w * 0.35, y, w * 0.3, h);
        }
        break;
      }
      case 'window':
        ctx.fillStyle = '#9fd8f0';
        ctx.fillRect(x, y, w, h);
        break;
      case 'crate':
        ctx.fillStyle = slick ? '#b9e6f5' : '#9a6b3c';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#5e3f20';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + w - 2, y + h - 2); ctx.moveTo(x + w - 2, y + 2); ctx.lineTo(x + 2, y + h - 2); ctx.stroke();
        break;
      case 'table':
        ctx.fillStyle = slick ? '#b9e6f5' : '#7a5232';
        ctx.fillRect(x, y, w, h);
        break;
      case 'shelf':
        ctx.fillStyle = slick ? '#b9e6f5' : '#b59a6a';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(230,80,80,0.7)';
        for (let i = 0; i < Math.max(o.w, o.h) / 0.5; i++) {
          if (o.w > o.h) ctx.fillRect(x + (i * 0.5 + 0.1) * P, y + h * 0.25, P * 0.25, h * 0.5);
          else ctx.fillRect(x + w * 0.25, y + (i * 0.5 + 0.1) * P, w * 0.5, P * 0.25);
        }
        break;
      case 'vending':
        ctx.fillStyle = slick ? '#b9e6f5' : '#d63031';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x + w * 0.15, y + h * 0.15, w * 0.7, h * 0.35);
        break;
      case 'drum':
        ctx.fillStyle = slick ? '#b9e6f5' : '#2d6fb5';
        ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1b4475'; ctx.lineWidth = 1.5; ctx.stroke();
        break;
      case 'cone':
        ctx.fillStyle = '#ff7f27';
        ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
        break;
      case 'car': {
        const hash = [...o.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
        ctx.fillStyle = /トラック/.test(o.name) ? '#e8e2d0' : CAR_COLORS[hash % CAR_COLORS.length];
        const r = Math.min(w, h) * 0.25;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
        ctx.fill();
        ctx.fillStyle = 'rgba(40,60,80,0.75)';
        if (o.w > o.h) { ctx.fillRect(x + w * 0.25, y + h * 0.15, w * 0.15, h * 0.7); ctx.fillRect(x + w * 0.62, y + h * 0.15, w * 0.12, h * 0.7); }
        else { ctx.fillRect(x + w * 0.15, y + h * 0.25, w * 0.7, h * 0.15); ctx.fillRect(x + w * 0.15, y + h * 0.62, w * 0.7, h * 0.12); }
        if (o.alarmUntil > b.t && Math.floor(b.t * 4) % 2 === 0) {
          ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 3; ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
        }
        break;
      }
      case 'steel':
        ctx.fillStyle = '#6f7378';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#3d4044'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 4); ctx.lineTo(x + w, y + (h * i) / 4); ctx.stroke(); }
        break;
      case 'hole':
        ctx.fillStyle = '#17110c';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#f1c40f'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
        ctx.setLineDash([]);
        break;
      case 'tree':
        ctx.fillStyle = '#1f4d22';
        ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, w * 0.9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5b3a1e';
        ctx.fillRect(x + w * 0.3, y + h * 0.3, w * 0.4, h * 0.4);
        break;
      case 'pole':
        ctx.fillStyle = '#777';
        ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'bush':
        ctx.fillStyle = 'rgba(46,110,46,0.85)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(80,150,70,0.8)';
        for (let i = 0; i < o.w * o.h * 2; i++) {
          const sx = o.x + ((i * 0.618) % 1) * o.w, sy = o.y + ((i * 0.381) % 1) * o.h;
          ctx.beginPath(); ctx.arc(sx * P, sy * P, P * 0.25, 0, Math.PI * 2); ctx.fill();
        }
        break;
    }
    if (damaged) {
      ctx.fillStyle = `rgba(255,80,60,${0.45 * (1 - o.hp / o.maxHp)})`;
      ctx.fillRect(x, y, w, h);
    }
    if (o.kind === 'crate' && P > 14) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(9, P * 0.4)}px sans-serif`;
      ctx.fillText(o.name.replace(/木箱|（.*）/g, ''), x + w / 2 - P * 0.12, y - 2);
    }
  }

  drawChar(b, c, isMe) {
    const ctx = this.ctx, P = this.px;
    const x = c.x * P, y = c.y * P, r = c.r * P;
    const s = c.status;
    if (!c.alive) {
      ctx.fillStyle = 'rgba(120,120,120,0.7)';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText('再起不能', x - r * 2, y - r - 4);
      return;
    }
    if (isMe) {
      // 視界の扇形
      ctx.fillStyle = 'rgba(255,255,220,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, RULES.visionRange * P, c.facing - RULES.visionFov / 2, c.facing + RULES.visionFov / 2);
      ctx.closePath();
      ctx.fill();
    }
    // 植え込みの中にいる時は薄く描く
    ctx.globalAlpha = b.bushAt(c.x, c.y) ? 0.55 : 1;
    // スタンドのオーラ
    ctx.fillStyle = c.windup ? 'rgba(255,80,80,0.35)' : `${c.color}33`;
    ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = s.proneUntil > b.t ? '#777' : c.color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = s.invulnUntil > b.t ? '#fff' : '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 向き
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(c.facing) * r * 1.6, y + Math.sin(c.facing) * r * 1.6);
    ctx.lineTo(x + Math.cos(c.facing + 2.5) * r * 0.8, y + Math.sin(c.facing + 2.5) * r * 0.8);
    ctx.lineTo(x + Math.cos(c.facing - 2.5) * r * 0.8, y + Math.sin(c.facing - 2.5) * r * 0.8);
    ctx.closePath();
    ctx.fill();
    if (s.guardUntil > b.t) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, c.facing - 1.2, c.facing + 1.2); ctx.stroke();
    }
    // HP バー（敵は見えている時だけ大まかに）
    const bw = P * 1.2;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - bw / 2, y - r - 10, bw, 5);
    ctx.fillStyle = isMe ? '#06d6a0' : '#ff6b6b';
    ctx.fillRect(x - bw / 2, y - r - 10, bw * (c.hp / c.maxHp), 5);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(10, P * 0.42)}px sans-serif`;
    const tags = [];
    if (s.proneUntil > b.t) tags.push('転倒');
    if (s.stunUntil > b.t) tags.push('怯み');
    if (s.deafUntil > b.t) tags.push('無音');
    if (b.bushAt(c.x, c.y)) tags.push('潜伏');
    ctx.fillText(`${isMe ? '自分' : c.name}${tags.length ? ` [${tags.join('・')}]` : ''}`, x - bw / 2, y - r - 14);
    ctx.globalAlpha = 1;
  }

  drawSpeech(b, c, x, y, approx) {
    if (!c.speech) return;
    const ctx = this.ctx, P = this.px;
    const text = approx ? `（声）「${c.speech.text}」` : `「${c.speech.text}」`;
    ctx.font = `${Math.max(11, P * 0.48)}px sans-serif`;
    const w = ctx.measureText(text).width + 12;
    const bx = Math.min(Math.max(4, x * P - w / 2), b.world.w * P - w - 4);
    const by = Math.max(4, y * P - P * 2.2);
    ctx.fillStyle = approx ? 'rgba(255,255,255,0.7)' : '#fff';
    ctx.fillRect(bx, by, w, P * 0.8);
    ctx.fillStyle = '#111';
    ctx.fillText(text, bx + 6, by + P * 0.58);
  }
}
