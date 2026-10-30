// 演出（盛り上げ）：決め技の大カットイン・ゴゴゴ・ターンの帯・答え合わせ・再起不能の帯・体力が少ない時の心音・名場面
// 画面（DOM）だけを扱い、戦闘の中身は変えない
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const clean = s => String(s || '').replace(/（CPU・ローカル）|（先読みで選んだ案）/g, '').replace(/^\s+|\s+$/g, '') || '様子を見る';

export class Drama {
  constructor({ portrait, playSe, flash, kick, isOn }) {
    this.portrait = portrait; // (char) => 画像の URL（無ければ null）
    this.playSe = playSe;
    this.flash = flash;
    this.kick = kick;
    this.isOn = isOn; // 演出を出すか（設定で切れる）
    this.reset(null);
  }

  reset(b) {
    this.b = b;
    this.snap = null; // 実行が始まった時の、全員の作戦と体力
    this.lastFinisher = 0;
    this.lastMenace = 0;
    this.lastBeat = 0;
    this.best = []; // 名場面の候補 { t, score, text }
    this.koOrder = [];
    for (const id of ['#finisher', '#menace', '#turn-banner', '#recap']) $(id)?.classList.remove('show');
    $('#vignette')?.classList.remove('on');
  }

  // ---------- ターンの切り替わり ----------

  onPhase(phase, turn, me) {
    const b = this.b;
    if (!b) return;
    if (phase === 'execute') {
      // 実行が始まる：全員の作戦と体力を控えておく（ターンの終わりに答え合わせ）
      this.snap = {
        turn: turn.turn,
        chars: b.chars.map(c => ({ id: c.id, name: c.name, team: c.team, color: c.color, hp: c.hp, alive: c.alive, plan: clean(c.runner.plan?.interpretation), dealt: c.dealt || 0 })),
      };
      this.banner(`第${turn.turn}手`, '実 行');
      this.maybeMenace(me);
    } else if (phase === 'input' && this.snap && this.snap.turn !== turn.turn) {
      this.recap(me);
      this.snap = null;
    }
  }

  banner(big, small) {
    if (!this.isOn()) return;
    const el = $('#turn-banner');
    if (!el) return;
    el.innerHTML = `<b>${esc(big)}</b><span>${esc(small)}</span>`;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    this.playSe('swing', 0.35);
  }

  // 敵同士が向き合った：ゴゴゴゴ……（近くで見えている敵がいる時に、実行の始まりで）
  maybeMenace(me) {
    const b = this.b;
    if (!this.isOn() || !me || !me.alive) return;
    const now = performance.now();
    if (now - this.lastMenace < 9000) return;
    const foe = b.enemiesOf(me).find(e => e.alive && b.canSee(me, e.x, e.y) && Math.hypot(e.x - me.x, e.y - me.y) < 7);
    if (!foe) return;
    this.lastMenace = now;
    const low = me.hp < me.maxHp * 0.35 || foe.hp < foe.maxHp * 0.35;
    const word = low ? 'ドド' : 'ゴゴ';
    const el = $('#menace');
    el.style.setProperty('--c', foe.color);
    el.innerHTML = Array.from({ length: 8 }, (_, i) => `<i style="--i:${i}">${word[i % 2]}</i>`).join('');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }

  // ターンの答え合わせ：それぞれの作戦と、そのターンのダメージのやり取り
  recap(me) {
    const b = this.b;
    if (!this.isOn() || !this.snap) return;
    const rows = this.snap.chars.map(s => {
      const c = b.chars.find(x => x.id === s.id);
      return { ...s, taken: Math.max(0, Math.round(s.hp - c.hp)), gave: Math.round((c.dealt || 0) - s.dealt), down: s.alive && !c.alive };
    });
    // 何かが起きた人だけ（大人数の時）。自分は必ず入れる
    const meRow = rows.find(r => r.id === me.id);
    let shown = rows.filter(r => r.taken || r.gave || r.down || r.id === me.id);
    if (!shown.some(r => r.id !== me.id)) return; // 誰とも何も起きなかったターンは出さない
    shown = [meRow, ...shown.filter(r => r !== meRow)].filter(Boolean).slice(0, 6);
    const verdict = meRow ? (meRow.gave - meRow.taken > 5 ? ['読み勝ち', 'win'] : meRow.taken - meRow.gave > 5 ? ['読み負け', 'lose'] : ['互角', 'even']) : null;
    const el = $('#recap');
    el.innerHTML = `<h4>第${this.snap.turn}手の答え合わせ ${verdict && b.player.alive && !b.spectate ? `<em class="${verdict[1]}">${verdict[0]}</em>` : ''}</h4>` +
      shown.map(r => `<div class="row" style="--c:${r.color}"><b>${esc(r.id === me.id && !b.spectate ? '自分' : r.name)}</b><span class="plan">${esc(r.plan)}</span><span class="num">${r.gave ? `<i class="g">与${r.gave}</i>` : ''}${r.taken ? `<i class="t">被${r.taken}</i>` : ''}${r.down ? '<i class="ko">再起不能</i>' : ''}</span></div>`).join('');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this.recapTimer);
    this.recapTimer = setTimeout(() => el.classList.remove('show'), 6500);
  }

  hideRecap() { $('#recap')?.classList.remove('show'); }

  // ---------- 打撃・決め技・再起不能 ----------

  // 大きな一撃・能力の決め技：画面を横切る帯に技の名前を大きく出し、時間を一瞬止める（戻り値は止める時間ms）
  onHit(f, attacker, target) {
    const b = this.b;
    if (f.dmg >= 10 && attacker) this.best.push({ t: b.t, score: f.dmg, text: `${attacker.name} の${f.label ? `『${f.label}』` : '一撃'}が ${target ? target.name : '相手'} に${f.dmg}ダメージ` });
    if (!this.isOn() || !attacker) return 0;
    const ability = f.hitKind !== 'melee' && f.hitKind !== 'counter' && f.hitKind !== 'zone';
    if (!(f.dmg >= 18 || (ability && f.dmg >= 14))) return 0;
    return this.finisher(attacker, f.label || '会心の一撃', `${target ? target.name : '相手'} に ${f.dmg} ダメージ`);
  }

  finisher(c, title, sub, force = false) {
    const now = performance.now();
    if (!this.isOn() || (!force && now - this.lastFinisher < 2500)) return 0;
    this.lastFinisher = now;
    const el = $('#finisher');
    const src = this.portrait(c);
    el.style.setProperty('--c', c.color);
    el.innerHTML = `<div class="lines"></div>${src ? `<img src="${src}" alt="">` : ''}<div class="txt"><small>${esc(c.name)}${c.def?.powerLabel ? `　${esc(c.def.powerLabel)}『${esc(c.stand)}』` : `　『${esc(c.stand)}』`}</small><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
    el.classList.toggle('pixel', !!src && src.startsWith('data:'));
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    this.flash(`${c.color}55`);
    this.kick(14);
    this.playSe('stand', 0.9);
    return 520;
  }

  onKO(f, target) {
    const b = this.b;
    if (target) this.koOrder.push(target.name);
    this.best.push({ t: b.t, score: 40, text: `${f.name || (target && target.name)} が再起不能（リタイヤ）` });
    if (!this.isOn() || !target) return;
    const el = $('#finisher');
    el.style.setProperty('--c', '#ff5d73');
    el.innerHTML = `<div class="lines"></div><div class="txt ko"><small>${esc(target.name)}</small><b>再起不能</b><span>リタイヤ</span></div>`;
    el.classList.remove('pixel');
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    this.lastFinisher = performance.now();
  }

  // ログの出来事から：密室の成立・轟音・列車など
  onLog(l) {
    const b = this.b;
    const actor = l.actor && b.chars.find(c => c.id === l.actor);
    if (l.kind === 'ability' && actor && /外周を炎が囲む/.test(l.text)) {
      this.best.push({ t: l.t, score: 30, text: `${actor.name} の『ホテル・カリフォルニア』で密室が成立` });
      return this.finisher(actor, '密室、成立', '最後の扉が閉じた', true);
    }
    if (/リニア貨物列車に撥ねられた|電車に撥ねられた|列車に撥ねられた/.test(l.text) && l.kind === 'combat') this.best.push({ t: l.t, score: 35, text: l.text });
    return 0;
  }

  // ---------- 毎フレーム：体力が少ない時の心音と赤い縁 ----------

  tick(now, me) {
    const low = this.isOn() && me && me.alive && me.hp < me.maxHp * 0.3;
    $('#vignette')?.classList.toggle('on', !!low);
    if (!low) return;
    const gap = me.hp < me.maxHp * 0.15 ? 600 : 900;
    if (now - this.lastBeat > gap) {
      this.lastBeat = now;
      this.playSe('heartbeat', 0.5, 'heart');
    }
  }

  // 結果画面の名場面（大きい順に3つ）
  highlights() {
    const top = [...this.best].sort((p, q) => q.score - p.score || p.t - q.t).slice(0, 3).sort((p, q) => p.t - q.t);
    if (!top.length) return '';
    return `<div class="highlights"><h4>名場面</h4>${top.map(h => `<div><span>${h.t.toFixed(1)}秒</span>${esc(h.text)}</div>`).join('')}</div>`;
  }
}
