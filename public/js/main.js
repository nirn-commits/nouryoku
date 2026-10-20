// 画面・入力・ゲームループ。Gemini はサーバー経由（/api/plan）で呼び、APIキーはブラウザに置かない
import { Battle } from './engine/sim.js';
import { CHARACTERS, ABILITIES, ACTIONS, RULES } from './engine/data.js';
import { compilePlan } from './engine/plan.js';
import { buildObservation } from './engine/perception.js';
import { localParse } from './engine/localParser.js';
import { TurnController } from './engine/controller.js';
import { Renderer } from './render.js';
import { pointInRect, dist } from './engine/vec.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const state = {
  gemini: false,
  model: '',
  chosen: 'makabe',
  battle: null,
  turn: null,
  renderer: null,
  paused: false,
  speed: 1,
  acc: 0,
  last: 0,
  cmdSeq: 0,
  thinking: 0,
  hover: null,
  logCount: 0,
  ended: false,
};

const EXAMPLES = {
  makabe: [
    '左の家に駆け込み、窓から敵の位置を確認する',
    '敵が近づいてきたら、足元の地面に能力を使って転倒させる',
    '飛んできたナイフの軌道を能力で逸らし、その隙に距離を詰める',
    '近くの木箱の摩擦を消してから、敵に向かって押し出す',
    '敵を追いかけて殴る',
    '物陰に隠れて、敵が見えたらナイフを投げる',
    '「出てこいよ、臆病者」と挑発して2秒待つ',
  ],
  karasuma: [
    '周囲の音を消して、敵を歩いて追いかけて殴る',
    '3mの距離を保って敵を尾行する',
    '正面から攻撃すると見せかけて、背後の壁を破壊して瓦礫を落とす',
    '敵の目の前に壁を作って通路を塞ぎ、右の家に入る',
    '敵が壁際にいたら、その壁から棘を突き出す',
    '敵の耳を聞こえなくしてから、背後に回り込む',
    '「……どこを見ている」と囁いて、物陰に隠れる',
  ],
};

// ---------- API ----------

async function apiPlan(payload, timeoutMs = 95000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}${data.detail ? `／詳細：${data.detail}` : ''}`);
    return data.plan;
  } finally {
    clearTimeout(timer);
  }
}

async function checkStatus() {
  const el = $('#ai-status');
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.gemini = !!data.gemini;
    state.model = data.model;
    el.textContent = state.gemini
      ? `AI：Gemini（${data.model}）で行動を解析します`
      : 'AI：GEMINI_API_KEY が未設定のため、簡易ローカル解析で動作します';
    el.className = `ai-status ${state.gemini ? 'ok' : 'warn'}`;
  } catch {
    state.gemini = false;
    el.textContent = 'AI：サーバーに接続できないため、簡易ローカル解析で動作します（npm start で起動すると Gemini を使えます）';
    el.className = 'ai-status warn';
  }
}

// ---------- タイトル ----------

function abilityHtml(id) {
  const a = ABILITIES[id];
  return `<div class="ab"><b>『${a.name}』</b> <span class="meta">射程${a.range}m / 発動${a.castTime}秒 / CT${a.cooldown}秒 / SP${a.cost}</span>
    <div>${a.desc}</div>
    <ul>${Object.values(a.effects).map(e => `<li><b>${e.name}</b>（対象：${e.targets.map(t => ({ point: '地点', enemy: '敵', object: '物体', self: '自分', projectile: '飛来物', direction: '方向' }[t])).join('・')}）${e.desc}</li>`).join('')}</ul>
    <div class="weak">弱点：${a.weakness}</div></div>`;
}

function renderCharCards() {
  $('#char-cards').innerHTML = Object.values(CHARACTERS).map(c => `
    <div class="char-card ${state.chosen === c.id ? 'chosen' : ''}" data-id="${c.id}" style="--c:${c.color}">
      <div class="char-head"><span class="dot"></span><div><b>${c.name}</b><div class="stand">スタンド『${c.stand}』</div></div></div>
      <p class="persona">${c.personality}</p>
      <div class="meta">HP ${c.hp} / 歩き${c.walk}m/s・走り${c.run}m/s / ナイフ${c.knives}本</div>
      ${c.abilities.map(abilityHtml).join('')}
    </div>`).join('');
}

// ---------- 戦闘 ----------

function startBattle() {
  const cpuChar = state.chosen === 'makabe' ? 'karasuma' : 'makabe';
  const b = new Battle({ seed: Date.now() & 0xffffff, playerChar: state.chosen, cpuChar });
  state.battle = b;
  state.ended = false;
  state.logCount = 0;
  state.acc = 0;
  state.paused = false;
  const cdef = CHARACTERS[cpuChar];
  state.turn = new TurnController(b, {
    cpuRemote: state.gemini
      ? obs => apiPlan({ role: 'cpu', observation: obs, character: { name: cdef.name, stand: cdef.stand, personality: cdef.personality } })
      : null,
  });
  state.lastPhase = null;
  $('#title').classList.add('hidden');
  $('#result').classList.add('hidden');
  $('#battle').classList.remove('hidden');
  $('#log').innerHTML = '';
  $('#cmd').value = '';
  const ex = $('#examples');
  ex.innerHTML = '<option value="">例文…</option>' + EXAMPLES[state.chosen].map(t => `<option>${t}</option>`).join('');
  $('#ability-ref').innerHTML = b.player.def.abilities.map(abilityHtml).join('') +
    `<h4>基本行動</h4><ul>${Object.values(ACTIONS).filter(a => a !== ACTIONS.ability).map(a => `<li><b>${a.name}</b>：${a.desc}</li>`).join('')}</ul>
     <p class="meta">1回の指示は最大${RULES.maxSteps}手順・見積もり${RULES.budgetSeconds}秒まで。</p>`;
  state.renderer.resize(b);
  updatePause();
  $('#cmd').focus();
}

function playerLog(text, kind = 'plan') {
  state.battle.emit({ text, kind, actor: state.battle.player });
}

async function submitCommand() {
  const b = state.battle;
  const turn = state.turn;
  if (!b || b.over || turn.phase !== 'input' || state.thinking) return;
  const text = $('#cmd').value.trim();
  $('#cmd').value = '';
  const seq = ++state.cmdSeq;
  playerLog(text ? `▶ 指示：${text}` : '▶ 指示：（何もしない）', 'command');
  state.thinking++;
  updateThinking();
  let raw = null;
  let source = 'local';
  if (state.gemini && text) {
    try {
      raw = await apiPlan({ role: 'player', text, observation: buildObservation(b, b.player) });
      source = 'gemini';
    } catch (e) {
      playerLog(`（Gemini 解析に失敗：${e.message}。ローカル解析に切り替えます）`, 'fail');
    }
  }
  state.thinking--;
  updateThinking();
  if (b !== state.battle || b.over) return;
  if (seq !== state.cmdSeq) return;
  if (!raw) raw = text ? localParse(b, b.player, text) : { interpretation: 'その場で様子を見る', steps: [] };
  const plan = compilePlan(b, b.player, raw, source);
  if (plan.interpretation) playerLog(`解釈：${plan.interpretation}`);
  if (plan.steps.length) playerLog(`計画：${plan.steps.map(s => s.label).join(' → ')}（見積もり${plan.budget.toFixed(1)}秒）`);
  for (const r of plan.rejected) playerLog(`✕ 実行不可：${r}`, 'fail');
  if (plan.truncated.length) playerLog(`✕ 行動予算超過のため省略：${plan.truncated.join('、')}`, 'fail');
  // 相手の計画が揃いしだい、双方の行動を同時に実行する
  await turn.commit(plan);
}

function updateThinking() {
  updatePhase();
}

function updatePhase() {
  const turn = state.turn;
  if (!turn) return;
  const phase = turn.phase;
  const input = phase === 'input' && !state.thinking;
  $('#cmd').disabled = !input;
  $('#send-btn').disabled = !input;
  $('#send-btn').textContent = state.thinking ? '解析中…' : phase === 'resolving' ? '相手の思考待ち…' : phase === 'execute' ? '実行中…' : '決定';
  const label = {
    input: `第${turn.turn}手：入力ターン（時間停止中）`,
    resolving: `第${turn.turn}手：相手の作戦を待っています…`,
    execute: `第${turn.turn}手：双方の行動を実行中`,
    over: '決着',
  }[phase];
  $('#phase-label').textContent = label;
  $('#phase-label').className = `phase phase-${phase}`;
  if (phase !== state.lastPhase) {
    if (phase === 'input') $('#cmd').focus();
    state.lastPhase = phase;
  }
}

function updatePause() {
  $('#pause-btn').textContent = state.paused ? '再開' : '一時停止';
  $('#pause-badge').classList.toggle('hidden', !state.paused);
}

function bar(cls, v, max, label) {
  return `<div class="bar ${cls}"><span style="width:${Math.max(0, (v / max) * 100)}%"></span><em>${label}</em></div>`;
}

function renderSide() {
  const b = state.battle;
  const me = b.player, foe = b.cpu;
  const st = [];
  if (me.status.proneUntil > b.t) st.push('転倒');
  if (me.status.stunUntil > b.t) st.push('怯み');
  if (me.status.guardUntil > b.t) st.push('ガード');
  if (me.status.deafUntil > b.t) st.push('聴覚喪失');
  if (b.zoneAt('silence', me.x, me.y)) st.push('無音の中');
  const cds = me.def.abilities.map(id => {
    const left = me.cd[id] ? me.cd[id] - b.t : 0;
    return `<span class="${left > 0 ? 'cd' : 'ready'}">『${ABILITIES[id].name}』${left > 0 ? `${left.toFixed(1)}s` : '可'}</span>`;
  }).join(' ');
  $('#self-card').style.setProperty('--c', me.color);
  $('#self-card').innerHTML = `
    <h3>${me.name} <small>『${me.stand}』</small></h3>
    ${bar('hp', me.hp, me.maxHp, `HP ${Math.round(me.hp)}/${me.maxHp}`)}
    ${bar('sp', me.sp, me.maxSp, `スタンドエネルギー ${Math.round(me.sp)}`)}
    <div class="meta">ナイフ ${me.knives}本 ／ 位置 (${me.x.toFixed(1)}, ${me.y.toFixed(1)}) ／ ${b.buildingOf(me)?.name || '屋外'}</div>
    <div class="meta">${cds}</div>
    <div class="meta">${st.join('・')}</div>`;

  const vis = foe.alive && b.canSee(me, foe.x, foe.y);
  const ls = me.memory.lastSeen;
  $('#enemy-card').style.setProperty('--c', foe.color);
  $('#enemy-card').innerHTML = `
    <h3>敵：${foe.name} ${vis ? '<span class="tag seen">視認中</span>' : '<span class="tag">見えていない</span>'}</h3>
    ${vis || DEBUG ? bar('hp enemy', foe.hp, foe.maxHp, `HP 約${Math.round(foe.hp / 10) * 10}`) : ''}
    <div class="meta">${vis ? `距離 ${dist(me.x, me.y, foe.x, foe.y).toFixed(1)}m` : ls ? `最後に見た位置 (${ls.x.toFixed(1)}, ${ls.y.toFixed(1)})・${(b.t - ls.t).toFixed(0)}秒前` : '一度も姿を見ていない'}</div>
    <div class="meta">敵の能力（観察から推測）：${me.memory.observed.length ? me.memory.observed.map(h => `<div>・${h}</div>`).join('') : '不明'}</div>
    ${DEBUG ? `<div class="meta debug">[debug] CPU計画:${(foe.runner.plan?.steps || []).map((s, i) => `${i === foe.runner.idx - 1 ? '▶' : ''}${s.label}`).join(' / ')}</div>` : ''}`;

  const plan = me.runner.plan;
  $('#plan-source').textContent = plan ? (plan.source === 'gemini' ? 'Gemini' : 'ローカル解析') : '';
  if (!plan || (!me.runner.step && me.runner.idx >= plan.steps.length && !me.pendingPlan)) {
    $('#plan-view').innerHTML = '<div class="meta">（待機中：新しい指示を入力してください）</div>';
  } else {
    const cur = me.runner.idx - 1;
    $('#plan-view').innerHTML = plan.steps.map((s, i) => {
      const cls = i < cur || (i === cur && !me.runner.step) ? 'done' : i === cur ? 'now' : '';
      const phase = i === cur && me.runner.step?.phase === 'cond' ? '（条件待ち）' : '';
      return `<div class="step ${cls}">${i + 1}. ${s.label}${phase}</div>`;
    }).join('') + (me.pendingPlan ? '<div class="meta">次の計画を待機中（現在の動作の完了後に切り替え）</div>' : '');
  }
  $('#time-label').textContent = `経過 ${b.t.toFixed(1)}秒`;
}

function renderLog() {
  const b = state.battle;
  const me = b.player;
  const entries = b.log.filter(l => DEBUG || l.visibleTo.has(me.id));
  if (entries.length === state.logCount) return;
  const fresh = entries.slice(state.logCount);
  state.logCount = entries.length;
  const log = $('#log');
  for (const l of fresh) {
    const p = document.createElement('p');
    p.className = `k-${l.kind}`;
    const text = l.actor === me.id || DEBUG ? l.text : l.obsText || l.text;
    p.innerHTML = `<span class="t">${l.t.toFixed(1)}</span> ${escapeHtml(text)}`;
    if (l.heardBy.has(me.id) && l.kind !== 'speech') p.innerHTML += ' <span class="heard">（音）</span>';
    log.prepend(p);
  }
  while (log.children.length > 200) log.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function showResult() {
  const b = state.battle;
  state.ended = true;
  const won = b.winner === b.player;
  $('#result-title').textContent = b.winner ? (won ? '勝利！' : '敗北……') : '相打ち';
  $('#result-body').textContent = b.winner ? `${b.winner.name}『${b.winner.stand}』の勝ち（${b.t.toFixed(1)}秒）` : '両者再起不能';
  setTimeout(() => $('#result').classList.remove('hidden'), 800);
}

function loop(now) {
  const dtReal = Math.min(0.1, (now - state.last) / 1000 || 0);
  state.last = now;
  const b = state.battle;
  if (b && !$('#battle').classList.contains('hidden')) {
    // 時間が進むのは実行フェーズの間だけ
    if (!state.paused && state.turn.phase === 'execute') {
      state.acc += dtReal * state.speed;
      let n = 0;
      while (state.acc >= RULES.dt && n++ < 12 && state.turn.phase === 'execute') {
        state.turn.step();
        state.acc -= RULES.dt;
      }
    } else {
      state.acc = 0;
    }
    updatePhase();
    state.renderer.draw(b, { debug: DEBUG, hover: state.hover });
    renderSide();
    renderLog();
    if (b.over && !state.ended) showResult();
  }
  requestAnimationFrame(loop);
}

// ---------- フィールドのクリック：座標や物体名を入力欄へ ----------

function describePoint(b, x, y) {
  const o = b.world.objects.find(ob => pointInRect(x, y, ob, 0.25) && !ob.id.startsWith('outer_'));
  if (o) return o.name;
  const door = b.world.buildings.flatMap(bd => bd.doors).find(d => dist(d.x, d.y, x, y) < 0.8);
  if (door) return door.name;
  return `(${x.toFixed(1)}, ${y.toFixed(1)})`;
}

function insertText(t) {
  const el = $('#cmd');
  const s = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, s) + t + el.value.slice(el.selectionEnd ?? s);
  el.focus();
  el.selectionStart = el.selectionEnd = s + t.length;
}

window.addEventListener('DOMContentLoaded', async () => {
  state.renderer = new Renderer($('#field'));
  renderCharCards();
  await checkStatus();
  $('#char-cards').addEventListener('click', e => {
    const card = e.target.closest('.char-card');
    if (card) { state.chosen = card.dataset.id; renderCharCards(); }
  });
  $('#start-btn').addEventListener('click', startBattle);
  $('#send-btn').addEventListener('click', submitCommand);
  $('#cmd').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitCommand(); }
    if (e.key === 'Escape') $('#cmd').blur();
  });
  $('#examples').addEventListener('change', e => {
    if (e.target.value) { $('#cmd').value = e.target.value; e.target.value = ''; $('#cmd').focus(); }
  });
  $('#pause-btn').addEventListener('click', () => { state.paused = !state.paused; updatePause(); });
  $('#speed').addEventListener('change', e => { state.speed = Number(e.target.value); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && document.activeElement !== $('#cmd') && !$('#battle').classList.contains('hidden')) {
      e.preventDefault();
      state.paused = !state.paused;
      updatePause();
    }
  });
  const field = $('#field');
  field.addEventListener('click', e => {
    const b = state.battle;
    if (!b) return;
    const p = state.renderer.toWorld(e.clientX, e.clientY);
    insertText(describePoint(b, p.x, p.y));
  });
  field.addEventListener('mousemove', e => {
    const b = state.battle;
    if (!b) return;
    const p = state.renderer.toWorld(e.clientX, e.clientY);
    state.hover = p;
    const tip = $('#tooltip');
    tip.textContent = describePoint(b, p.x, p.y);
    tip.style.left = `${e.offsetX + 14}px`;
    tip.style.top = `${e.offsetY + 10}px`;
    tip.classList.remove('hidden');
  });
  field.addEventListener('mouseleave', () => { state.hover = null; $('#tooltip').classList.add('hidden'); });
  $('#quit-btn').addEventListener('click', () => {
    if (!confirm('戦闘を中断してタイトルに戻りますか？')) return;
    state.battle = null;
    $('#battle').classList.add('hidden');
    $('#title').classList.remove('hidden');
  });
  $('#again-btn').addEventListener('click', startBattle);
  $('#title-btn').addEventListener('click', () => {
    state.battle = null;
    $('#result').classList.add('hidden');
    $('#battle').classList.add('hidden');
    $('#title').classList.remove('hidden');
  });
  window.addEventListener('resize', () => { if (state.battle) state.renderer.resize(state.battle); });
  requestAnimationFrame(t => { state.last = t; loop(t); });
});
