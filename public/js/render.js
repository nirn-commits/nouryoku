// フィールド描画。プレイヤーが知覚できるものだけを描く（debug 時は全表示）
import { RULES } from './engine/data.js';

const SOUND_LABEL = {
  footsteps: '足音', footsteps_run: '駆ける足音', speech: '声', impact: '衝撃音', crash: '崩れる音',
  glass: 'ガラスの音', fall: '倒れる音', throw: '風切り音', swing: '風切り音', ability: '異音', combat: '物音',
  env: '物音', damage: '打撃音',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.px = 26;
    this.fog = null;
    this.fogFrame = 0;
  }

  resize(battle) {
    const wrap = this.canvas.parentElement;
    const w = Math.min(wrap.clientWidth, 1000);
    this.px = w / battle.world.w;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${this.px * battle.world.h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.px * battle.world.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  toWorld(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / this.px, y: (clientY - r.top) / this.px };
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

    ctx.fillStyle = '#3d4436';
    ctx.fillRect(0, 0, W, H);
    // 地面の模様
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < b.world.w; x += 2) { ctx.beginPath(); ctx.moveTo(x * P, 0); ctx.lineTo(x * P, H); ctx.stroke(); }
    for (let y = 0; y < b.world.h; y += 2) { ctx.beginPath(); ctx.moveTo(0, y * P); ctx.lineTo(W, y * P); ctx.stroke(); }

    for (const bd of b.world.buildings) {
      ctx.fillStyle = '#5b4c3f';
      ctx.fillRect(bd.x * P, bd.y * P, bd.w * P, bd.h * P);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = `${Math.max(10, P * 0.45)}px sans-serif`;
      ctx.fillText(bd.name, (bd.x + 0.5) * P, (bd.y + 1) * P);
    }
    for (const r of b.world.rubble) {
      ctx.fillStyle = 'rgba(120,110,100,0.55)';
      ctx.fillRect(r.x * P, r.y * P, r.w * P, r.h * P);
      ctx.fillStyle = 'rgba(60,55,50,0.8)';
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
    for (const o of b.world.objects) {
      const x = o.x * P, y = o.y * P, w = o.w * P, h = o.h * P;
      if (o.kind === 'wall') {
        ctx.fillStyle = o.indestructible ? '#1c1c22' : o.created ? '#6d5f86' : '#2c2b33';
        ctx.fillRect(x, y, w, h);
        if (!o.indestructible && o.hp < o.maxHp) {
          ctx.fillStyle = `rgba(255,80,60,${0.5 * (1 - o.hp / o.maxHp)})`;
          ctx.fillRect(x, y, w, h);
        }
      } else if (o.kind === 'window') {
        ctx.fillStyle = '#9fd8f0';
        ctx.fillRect(x, y, w, h);
      } else if (o.kind === 'crate') {
        ctx.fillStyle = o.slickUntil > b.t ? '#b9e6f5' : '#9a6b3c';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#5e3f20';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + w - 2, y + h - 2); ctx.moveTo(x + w - 2, y + 2); ctx.lineTo(x + 2, y + h - 2); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(9, P * 0.4)}px sans-serif`;
        ctx.fillText(o.name.replace('木箱', ''), x + w / 2 - P * 0.12, y - 2);
      } else if (o.kind === 'table') {
        ctx.fillStyle = o.slickUntil > b.t ? '#b9e6f5' : '#6e4a2e';
        ctx.fillRect(x, y, w, h);
      }
    }
    for (const bd of b.world.buildings) {
      for (const d of bd.doors) {
        ctx.fillStyle = 'rgba(255,220,150,0.5)';
        ctx.fillRect((d.x - 0.15) * P, (d.y - 0.15) * P, 0.3 * P, 0.3 * P);
      }
    }

    // 霧（見えていない場所を暗く）
    if (!debug) {
      if (!this.fog || this.fogFrame++ % 4 === 0) this.computeFog(b, me);
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
    ctx.fillText(`${isMe ? '自分' : c.name}${tags.length ? ` [${tags.join('・')}]` : ''}`, x - bw / 2, y - r - 14);
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
