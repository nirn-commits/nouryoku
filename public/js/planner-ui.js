// 行動の組み立て画面：行動を選び、対象（敵・味方・方向・マップ上の地点や物）と条件を決めて、手順を積み上げる。
// 手順ごとの見積もり時間を「行動ゲージ」に出し、1ターンの上限（秒数・手順数）を超えないようにする
import { ACTIONS, ABILITIES, CONDITIONS, RULES } from './engine/data.js';
import { compilePlan } from './engine/plan.js';
import { pointInRect, dist } from './engine/vec.js';

// 行動の分類（ボタンの並び）
const GROUPS = [
  ['移動', [['move', '歩く', { mode: 'walk' }], ['move', '走る', { mode: 'run' }], ['chase', '追いかける'], ['dodge', '回避'], ['vault', '乗り越える'], ['jump_down', '飛び降りる']]],
  ['攻撃', [['melee', '殴る'], ['grab', '掴む'], ['tackle', '体当たり'], ['feint', 'フェイント'], ['throw', '投げる']]],
  ['守り・様子', [['guard', 'ガード'], ['counter', '受け流し'], ['hide', '潜む'], ['search', '見回す'], ['look', '観察']]],
  ['物', [['pickup', '拾う'], ['drop', '手放す'], ['use_item', '持ち物を使う'], ['interact', '操作する'], ['open', '開ける'], ['close', '閉める'], ['push', '押す'], ['pull', '引く'], ['decoy', '物音を立てる'], ['swat', '体を払う']]],
  ['スタンド', [['stand_out', '出す'], ['stand_move', '先行させる'], ['stand_in', '戻す']]],
  ['待機', [['wait', '待つ']]],
];

const DIRS = [['up_left', '↖'], ['up', '↑'], ['up_right', '↗'], ['left', '←'], ['', ''], ['right', '→'], ['down_left', '↙'], ['down', '↓'], ['down_right', '↘']];
const DIR_EXTRA = [['toward_enemy', '敵の方へ'], ['away_from_enemy', '敵から離れる'], ['cover', '物陰へ']];

// 条件の選択肢（value を使うもの）
const COND_VALUE = { enemy_within: { label: 'm', def: 4, min: 1, max: 30 }, hp_below: { label: 'HP', def: 40, min: 1, max: 200 } };

// 秒数などの細かい指定
function paramsFor(action, ability, effect) {
  const p = [];
  if (action === 'wait') p.push(['duration', '秒', 2, 0.5, 6, 0.5]);
  if (action === 'guard') p.push(['duration', '秒', 1.5, 0.3, 3, 0.1]);
  if (action === 'hide') p.push(['duration', '秒', 3, 0.5, 8, 0.5]);
  if (action === 'chase') p.push(['duration', '最大秒', 4, 0.5, 8, 0.5]);
  if (ability === 'corvette' && effect === 'bite') p.push(['duration', '秒', 4, 0.5, 8, 0.5]);
  if (ability === 'echo' && (effect === 'deploy' || effect === 'scratch')) p.push(['count', '体', effect === 'scratch' ? 6 : 4, 1, 24, 1]);
  if (ability === 'seventh' && (effect === 'bank' || effect === 'spread')) p.push(['bounces', '回反射', 2, 1, 7, 1]);
  return p;
}

export class PlanBuilder {
  constructor(root, { getBattle, onChange }) {
    this.root = root;
    this.getBattle = getBattle;
    this.onChange = onChange || (() => {});
    this.steps = [];
    this.pending = null; // 対象を選んでいる途中の行動
    this.cond = null; // 次に足す手順の条件
    this.compiled = null;
    root.addEventListener('click', e => this.click(e));
    root.addEventListener('change', e => this.change(e));
  }

  // 戦闘が始まったら、そのキャラの行動・能力でボタンを作り直す
  reset() {
    this.steps = [];
    this.pending = null;
    this.cond = null;
    this.render();
  }

  me() {
    const b = this.getBattle();
    return b ? b.player : null;
  }

  // ---------- 画面 ----------

  palette() {
    const c = this.me();
    const groups = GROUPS.filter(([name]) => name !== 'スタンド' || (c && c.def.standRange));
    const abilityBtns = c ? c.def.abilities.flatMap(id => Object.entries(ABILITIES[id].effects).map(([eff, ed]) => `<button class="pb-act ab" data-ability="${id}" data-effect="${eff}" title="${ed.desc.replace(/"/g, '&quot;')}">${ed.name}</button>`)) : [];
    return `<div class="pb-palette">${groups.map(([name, list]) => `<span class="pb-group"><em>${name}</em>${list.map(([a, label, extra]) => `<button class="pb-act" data-action="${a}" ${extra ? `data-mode="${extra.mode}"` : ''} title="${ACTIONS[a].desc.replace(/"/g, '&quot;')}">${label}</button>`).join('')}</span>`).join('')}${abilityBtns.length ? `<span class="pb-group ab"><em>能力</em>${abilityBtns.join('')}</span>` : ''}</div>`;
  }

  targetTypes(p) {
    const list = p.ability ? ABILITIES[p.ability].effects[p.effect].targets : ACTIONS[p.action].targets;
    return list.filter(t => t !== 'projectile');
  }

  picker() {
    const p = this.pending;
    if (!p) return `<div class="pb-hint">行動を選んで手順を足していきます（最大${RULES.maxSteps}手順・約${RULES.budgetSeconds}秒まで）。地点や物は戦場をクリックして選びます。</div>`;
    const b = this.getBattle();
    const c = this.me();
    const types = this.targetTypes(p);
    const parts = [`<b class="pb-now">${p.label}</b>`];
    if (types.includes('enemy') && b) {
      for (const e of b.enemiesOf(c).filter(x => x.alive)) {
        const seen = b.canSee(c, e.x, e.y) || c.memory.seen[e.id];
        parts.push(`<button class="pb-tgt enemy" data-type="enemy" data-id="${e.id}">${e.name}${b.canSee(c, e.x, e.y) ? '' : seen ? '（最後に見た所）' : '（居場所不明）'}</button>`);
      }
    }
    if (types.includes('ally') && b && b.alliesOf(c).some(a => a.alive)) parts.push('<button class="pb-tgt" data-type="ally">味方</button>');
    if (types.includes('self') || types.includes('none')) parts.push(`<button class="pb-tgt" data-type="${types.includes('self') ? 'self' : 'none'}">${types.includes('self') ? '自分' : 'その場で'}</button>`);
    if (types.includes('direction')) {
      parts.push(`<span class="pb-dirs">${DIRS.map(([d, l]) => d ? `<button class="pb-tgt dir" data-type="direction" data-dir="${d}">${l}</button>` : '<i></i>').join('')}</span>`);
      parts.push(DIR_EXTRA.map(([d, l]) => `<button class="pb-tgt" data-type="direction" data-dir="${d}">${l}</button>`).join(''));
    }
    if (types.includes('point') || types.includes('object')) {
      const what = types.includes('point') && types.includes('object') ? '地点か物' : types.includes('point') ? '地点' : '物';
      parts.push(`<span class="pb-map">🗺 戦場をクリックして${what}を選ぶ${p.route ? '（続けてクリックで経路に足す）' : ''}</span>`);
      if (p.route && p.added) parts.push('<button class="pb-done">経路を確定</button>');
    }
    if (p.action === 'pickup') parts.push('<button class="pb-tgt" data-type="none">一番近い物</button>');
    // 細かい指定
    for (const [key, label, def, min, max, stepV] of paramsFor(p.action, p.ability, p.effect)) {
      parts.push(`<label class="pb-param">${label}<input type="number" data-param="${key}" value="${p.params[key] ?? def}" min="${min}" max="${max}" step="${stepV}"></label>`);
    }
    if (p.ability === 'echo' && p.effect === 'place') {
      parts.push(`<label class="pb-param">音<select data-param="sound">${[['any', 'どれでも'], ['footsteps', '足音'], ['voice', '声'], ['loud', '大きな音']].map(([v, l]) => `<option value="${v}"${p.params.sound === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`);
    }
    // 条件（「〜したら」）
    const ck = this.cond ? this.cond.kind : '';
    parts.push(`<label class="pb-param cond">条件<select data-cond="kind"><option value="">すぐに</option>${Object.entries(CONDITIONS).map(([k, t]) => `<option value="${k}"${ck === k ? ' selected' : ''}>${t.replace(/（[^）]*）/g, '').replace('value ', '')}</option>`).join('')}</select>${COND_VALUE[ck] ? `<input type="number" data-cond="value" value="${this.cond.value}" min="${COND_VALUE[ck].min}" max="${COND_VALUE[ck].max}">${COND_VALUE[ck].label}` : ''}${ck ? `<input type="number" data-cond="timeout" value="${this.cond.timeout}" min="0.5" max="${RULES.conditionTimeoutMax}" step="0.5" title="この秒数のうちに条件が満たされなければ飛ばす">秒まで待つ` : ''}</label>`);
    parts.push('<button class="pb-cancel" title="この行動をやめる">✕</button>');
    return `<div class="pb-picker">${parts.join('')}</div>`;
  }

  stepsBar() {
    const plan = this.compiled;
    const budget = RULES.budgetSeconds;
    const used = plan ? plan.steps.reduce((a, s) => a + (s.est || 0), 0) : 0;
    const chips = this.steps.map((raw, i) => {
      const st = plan && plan.steps.find(s => s.raw === raw);
      const why = plan && plan.dropped && plan.dropped.get(raw);
      const label = st ? st.label : `${raw._label || raw.action}（${why || '実行できない'}）`;
      const cls = st ? '' : 'bad';
      return `<span class="pb-step ${cls}"><i>${i + 1}</i>${label}${st ? `<small>${st.est.toFixed(1)}秒</small>` : ''}<button data-up="${i}" title="前へ">◀</button><button data-del="${i}" title="消す">✕</button></span>`;
    }).join('');
    const pct = Math.min(100, (used / budget) * 100);
    const warn = plan && (plan.rejected.length || plan.truncated.length) ? `<div class="pb-warn">${[...plan.rejected.map(r => `✕ ${r}`), ...plan.truncated.map(t => `✕ 予算超過で省略：${t}`)].join('　')}</div>` : '';
    return `<div class="pb-steps">${chips || '<span class="pb-empty">（まだ手順がありません。何もしなければその場で様子を見ます）</span>'}</div>
      <div class="pb-gauge" title="行動ゲージ：1ターンに使える時間"><span style="width:${pct}%" class="${used > budget ? 'over' : ''}"></span><em>行動ゲージ ${used.toFixed(1)} / ${budget}秒・${this.steps.length}/${RULES.maxSteps}手順</em></div>${warn}`;
  }

  render() {
    this.recompile();
    this.root.innerHTML = `${this.palette()}${this.picker()}${this.stepsBar()}`;
    this.root.querySelectorAll('.pb-act').forEach(btn => {
      const p = this.pending;
      btn.classList.toggle('on', !!p && btn.dataset.action === (p.ability ? undefined : p.action) && (btn.dataset.mode || '') === (p.mode || '') || (!!p && p.ability && btn.dataset.ability === p.ability && btn.dataset.effect === p.effect));
    });
    this.onChange();
  }

  recompile() {
    const b = this.getBattle();
    this.compiled = b ? compilePlan(b, b.player, this.raw(), 'manual') : null;
  }

  // ---------- 操作 ----------

  click(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('pb-act')) return this.choose(t);
    if (t.classList.contains('pb-tgt')) return this.pickTarget(t.dataset);
    if (t.classList.contains('pb-cancel') || t.classList.contains('pb-done')) { this.pending = null; this.cond = null; return this.render(); }
    if (t.dataset.del !== undefined) { this.steps.splice(Number(t.dataset.del), 1); return this.render(); }
    if (t.dataset.up !== undefined) {
      const i = Number(t.dataset.up);
      if (i > 0) [this.steps[i - 1], this.steps[i]] = [this.steps[i], this.steps[i - 1]];
      return this.render();
    }
  }

  change(e) {
    const el = e.target;
    if (el.dataset.param && this.pending) this.pending.params[el.dataset.param] = el.tagName === 'SELECT' ? el.value : Number(el.value);
    if (el.dataset.cond) {
      if (el.dataset.cond === 'kind') this.cond = el.value ? { kind: el.value, value: COND_VALUE[el.value]?.def ?? null, timeout: RULES.conditionTimeoutDefault } : null;
      else if (this.cond) this.cond[el.dataset.cond] = Number(el.value);
      this.render();
    }
  }

  choose(btn) {
    const d = btn.dataset;
    const p = d.ability
      ? { action: 'ability', ability: d.ability, effect: d.effect, label: btn.textContent, params: {} }
      : { action: d.action, mode: d.mode || null, label: btn.textContent, params: {} };
    // ホテル・カリフォルニアの「最後の扉を閉める」は、閉める行動として扱う
    if (p.ability === 'hotel' && p.effect === 'seal') Object.assign(p, { action: 'close', ability: 'hotel' });
    p.route = p.action === 'move';
    this.pending = p;
    const types = this.targetTypes(p.action === 'close' && p.ability === 'hotel' ? { action: 'close' } : p);
    // 対象を選ぶ必要がない行動は、その場で足す
    if (types.length === 1 && (types[0] === 'none' || types[0] === 'self') && !paramsFor(p.action, p.ability, p.effect).length && !(p.ability === 'echo' && p.effect === 'place')) {
      return this.pickTarget({ type: types[0] });
    }
    this.render();
  }

  addStep(target) {
    const p = this.pending;
    if (this.steps.length >= RULES.maxSteps) return;
    const step = { action: p.action, ...target, _label: p.label };
    if (p.mode) step.mode = p.mode;
    if (p.ability) { step.ability = p.ability; step.effect = p.effect; }
    for (const [key, , def] of paramsFor(p.action, p.ability, p.effect)) step[key] = p.params[key] ?? def;
    if (p.params.sound) step.sound = p.params.sound;
    if (this.cond) step.condition = { kind: this.cond.kind, ...(this.cond.value !== null ? { value: this.cond.value } : {}), timeout: this.cond.timeout };
    this.steps.push(step);
    this.cond = null;
  }

  pickTarget(d) {
    if (!this.pending) return;
    const t = { targetType: d.type };
    if (d.type === 'enemy' && d.id) t.targetId = d.id;
    if (d.type === 'direction') t.direction = d.dir;
    this.addStep(t);
    this.pending = null;
    this.render();
  }

  // 戦場がクリックされた：地点・物を対象にしている途中なら、それを使う
  wantsMap() {
    if (!this.pending) return false;
    const types = this.targetTypes(this.pending.action === 'close' ? { action: 'close' } : this.pending);
    return types.includes('point') || types.includes('object');
  }

  mapClick(x, y) {
    const b = this.getBattle();
    const p = this.pending;
    if (!b || !p) return false;
    const c = b.player;
    const types = this.targetTypes(p.action === 'close' ? { action: 'close' } : p);
    const obj = types.includes('object') ? this.objectAt(b, x, y, p) : null;
    let target = null;
    if (obj) target = { targetType: 'object', targetId: obj.id };
    else if (types.includes('point')) target = { targetType: 'point', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, floor: c.floor };
    if (!target) return true;
    this.addStep(target);
    // 移動は経路として続けて足せる
    if (p.route && this.steps.length < RULES.maxSteps) p.added = true;
    else this.pending = null;
    this.render();
    return true;
  }

  // クリックした所にある物（その行動の対象になれる物を優先）
  objectAt(b, x, y, p) {
    const f = b.player.floor;
    const items = b.world.items.filter(i => (i.floor ?? 0) === f && dist(i.x, i.y, x, y) < 0.9);
    if (items.length && (p.action === 'pickup' || p.action === 'interact')) return items.sort((a, z) => dist(a.x, a.y, x, y) - dist(z.x, z.y, x, y))[0];
    const piles = (b.world.piles || []).filter(pl => pl.floor === f && pointInRect(x, y, pl, 0.2));
    if (piles.length && (p.effect === 'restore' || p.action === 'interact')) return piles[0];
    const objs = b.world.objects.filter(o => !o.id.startsWith('outer_') && (o.floor === f || o.kind === 'stairs') && pointInRect(x, y, o, 0.35));
    const want = { open: ['door', 'window'], close: ['door', 'window'], jump_down: ['window'], interact: ['vending', 'fountain', 'generator', 'trashcan'] }[p.action];
    const o = (want ? objs.filter(z => want.includes(z.kind) || z.buzzer) : objs)[0] || null;
    if (o) return o;
    // 移動先として建物の中をクリックした時は地点で十分
    if (p.action === 'move') return null;
    return items[0] || null;
  }

  // ---------- 結果 ----------

  raw() {
    const speechEl = document.getElementById('pb-speech');
    const speech = speechEl ? speechEl.value.trim() : '';
    // 手順はそのまま渡す（_label は検証で無視される。組み立てた手順と検証結果を突き合わせるため同じ物を使う）
    return { interpretation: '（コマンドで組み立てた計画）', speech: speech || null, steps: this.steps };
  }

  // 戦場に描く予定の印（移動先・地点・物）
  preview() {
    const b = this.getBattle();
    if (!b) return [];
    const out = [];
    this.steps.forEach((s, i) => {
      let p = null;
      if (s.targetType === 'point') p = { x: s.x, y: s.y };
      else if (s.targetType === 'object') {
        const o = b.objectById(s.targetId) || b.world.items.find(it => it.id === s.targetId);
        if (o) p = o.w ? { x: o.x + o.w / 2, y: o.y + o.h / 2 } : { x: o.x, y: o.y };
      }
      if (p) out.push({ ...p, n: i + 1, move: s.action === 'move' });
    });
    return out;
  }

  clear() {
    this.steps = [];
    this.pending = null;
    this.cond = null;
    const speechEl = document.getElementById('pb-speech');
    if (speechEl) speechEl.value = '';
    this.render();
  }
}
