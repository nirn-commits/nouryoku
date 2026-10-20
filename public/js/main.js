// 画面・入力・ゲームループ。Gemini はサーバー経由（/api/plan）で呼び、APIキーはブラウザに置かない
import { Battle } from './engine/sim.js';
import { CHARACTERS, ABILITIES, ACTIONS, RULES, STAT_LABELS } from './engine/data.js';
import { compilePlan } from './engine/plan.js';
import { buildObservation } from './engine/perception.js';
import { localParse } from './engine/localParser.js';
import { TurnController } from './engine/controller.js';
import { Renderer } from './render.js';
import { pointInRect, dist } from './engine/vec.js';
import { MAPS } from './engine/maps.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const state = {
  gemini: false,
  model: '',
  chosen: 'sogo',
  opponent: 'random',
  mapId: 'town',
  battle: null,
  turn: null,
  renderer: null,
  paused: false,
  speed: 1,
  acc: 0,
  last: 0,
  cmdSeq: 0,
  thinking: 0,
  thinkingSince: 0,
  clientTimeoutMs: 95000,
  hover: null,
  logCount: 0,
  ended: false,
};

const EXAMPLES = {
  sogo: [
    '近くの壁際まで走って、敵が近づいてきたら弾き出して叩きつける',
    '近くの花瓶を拾って、敵に向けて弾き出す',
    '「その距離なら届く。9.8mだ、ギリギリな」と言って、手に持った物を10m先へ弾き出す',
    '敵を追いかけて殴り、柱に叩きつける',
    '壁を蹴って離脱し、物陰に隠れる',
    '真上に跳び上がって、空中で左へ方向転換',
    '佐藤家の2階へ上がって、2階の窓から道路を見張る',
    '2階の窓から飛び降りて逃げる',
    '扉を開けて外へ走る',
  ],
  kito: [
    '敵を追いかけて殴る',
    '家に入って扉を閉め、敵が来たら殴る',
    '出口を全部閉めて密室にする「入れ」',
    '開けられた窓を閉め直してから、敵を追いかけて殴る',
    '敵を家の中へ追い込んで、扉を閉める',
    '「話はいい」と言って、距離を詰めて殴る',
    '鉄パイプを拾ってから、敵を追いかけて殴る',
  ],
  nanami: [
    'エコー・ビーチを10体だけ出して、自分の周りに置く',
    '近くの自販機を3回叩いて、その音を集める',
    '敵にエコー・ビーチを1体貼り付ける',
    '集めた大きい音を敵の足元で一斉に鳴らす',
    '敵の進路に2体ずつ置いて、近づいたら鳴らす',
    '自分の足音を消して、物陰を回り込む',
    'エコー・ビーチを全部回収する',
  ],
  saginuma: [
    '敵に向けて球をまっすぐ撃つ',
    '壁で3回跳ね返る軌道で、物陰の敵を撃つ',
    '5回跳ね返らせて貫通弾にしてから当てる',
    '3発ばらまいて、敵の逃げ道をふさぐ',
    '敵から距離を取りつつ、球を撃ち返す',
    'ブロックを拾って投げつける',
  ],
};

// ---------- API ----------

async function apiPlan(payload, timeoutMs = state.clientTimeoutMs) {
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
    if (ctrl.signal.aborted) throw new Error('timeout');
    if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}${data.detail ? `／詳細：${data.detail}` : ''}`);
    return data.plan;
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'timeout') {
      throw new Error(`ブラウザ側の待ち時間（${Math.round(timeoutMs / 1000)}秒）を超えました。サーバーのターミナルに所要時間が表示されています`);
    }
    throw e;
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
    // サーバーは設定を変えて最大3回試すので、その分だけ待つ
    if (data.timeoutMs) state.clientTimeoutMs = data.timeoutMs * 3 + 5000;
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

// キャラクター画像：①タイトル画面でアップロードした画像（ブラウザに保存）②public/img/<id>.png|jpg|webp の順で探す
// <id> は本体、<id>_stand はスタンド
const portraitSrc = {};
const PORTRAIT_KEY = id => `portrait:${id}`;
function storedPortrait(id) {
  try { return localStorage.getItem(PORTRAIT_KEY(id)); } catch { return null; }
}
function preloadPortraits() {
  for (const id of Object.keys(CHARACTERS).flatMap(k => [k, `${k}_stand`])) {
    const saved = storedPortrait(id);
    if (saved) { portraitSrc[id] = saved; continue; }
    const tryExt = exts => {
      if (!exts.length) return;
      const img = new Image();
      img.onload = () => { if (!portraitSrc[id]) { portraitSrc[id] = img.src; renderCharCards(); } };
      img.onerror = () => tryExt(exts.slice(1));
      img.src = `img/${id}.${exts[0]}`;
    };
    tryExt(['png', 'jpg', 'jpeg', 'webp']);
  }
  renderCharCards();
}

function portrait(id, cls) {
  return portraitSrc[id] ? `<img class="portrait ${cls}" src="${portraitSrc[id]}" alt="">` : '';
}

// アップロード画像は長辺 640px に縮小して保存（localStorage の容量対策）
function savePortraitFile(id, file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 640 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k);
      cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const url = cv.toDataURL('image/webp', 0.85);
      portraitSrc[id] = url;
      try { localStorage.setItem(PORTRAIT_KEY(id), url); } catch { alert('ブラウザの保存容量が足りないため、この画像は今回の起動中だけ表示されます'); }
      renderCharCards();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function clearPortrait(id) {
  try { localStorage.removeItem(PORTRAIT_KEY(id)); } catch {}
  delete portraitSrc[id];
  preloadPortraits();
}

function portraitSlot(id, label) {
  return `<div class="pslot">${portrait(id, 'card') || `<div class="portrait card empty">${label}<br><small>画像なし</small></div>`}
    <div class="pbtns"><button type="button" class="pbtn" data-up="${id}">${label}の画像…</button>${storedPortrait(id) ? `<button type="button" class="pbtn" data-clear="${id}">消す</button>` : ''}</div></div>`;
}

// 能力発動時のカットイン
function showCutin(c, text) {
  const el = $('#cutin');
  const src = portraitSrc[`${c.charId}_stand`] || portraitSrc[c.charId];
  if (!el || !src) return;
  el.style.setProperty('--c', c.color);
  el.innerHTML = `<img src="${src}" alt=""><div class="cap"><b>『${escapeHtml(c.stand)}』</b><span>${escapeHtml(text)}</span></div>`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(showCutin.timer);
  showCutin.timer = setTimeout(() => el.classList.remove('show'), 1600);
}

function renderMapCards() {
  $('#map-cards').innerHTML = Object.values(MAPS).map(m => `
    <div class="map-card ${state.mapId === m.id ? 'chosen' : ''}" data-id="${m.id}">
      <b>${m.name}</b><div class="meta">${m.desc}</div>
    </div>`).join('');
}

function renderCharCards() {
  $('#char-cards').innerHTML = Object.values(CHARACTERS).map(c => `
    <div class="char-card ${state.chosen === c.id ? 'chosen' : ''}" data-id="${c.id}" style="--c:${c.color}">
      <div class="portraits">${portraitSlot(c.id, '本体')}${portraitSlot(`${c.id}_stand`, 'スタンド')}</div>
      <div class="char-head"><span class="dot"></span><div><b>${c.name}</b>${c.reading ? ` <small>（${c.reading}${c.nickname ? `・通称「${c.nickname}」` : ''}）</small>` : ''}<div class="stand">スタンド『${c.stand}』</div></div></div>
      ${c.profile ? `<p class="profile">${c.profile}</p>` : ''}
      <p class="persona">${c.personality}</p>
      ${c.stats ? `<table class="stats"><tr>${Object.values(STAT_LABELS).map(l => `<th>${l}</th>`).join('')}</tr><tr>${Object.keys(STAT_LABELS).map(k => `<td>${c.stats[k]}</td>`).join('')}</tr></table>` : ''}
      <div class="meta">HP ${c.hp} / 体重${c.kg}kg / 歩き${c.walk}m/s・走り${c.run}m/s</div>
      ${c.abilities.map(abilityHtml).join('')}
    </div>`).join('');
  const sel = $('#opponent');
  sel.innerHTML = '<option value="random">ランダム（自分以外）</option>' +
    Object.values(CHARACTERS).map(c => `<option value="${c.id}" ${state.opponent === c.id ? 'selected' : ''}>${c.name}『${c.stand}』${c.id === state.chosen ? '（同キャラ対決）' : ''}</option>`).join('');
  sel.value = state.opponent;
}

function pickOpponent() {
  if (state.opponent !== 'random') return state.opponent;
  const others = Object.keys(CHARACTERS).filter(id => id !== state.chosen);
  return others[Math.floor(Math.random() * others.length)];
}

// ---------- 戦闘 ----------

function startBattle() {
  const cpuChar = pickOpponent();
  const b = new Battle({ seed: Date.now() & 0xffffff, playerChar: state.chosen, cpuChar, mapId: state.mapId });
  state.battle = b;
  state.ended = false;
  state.logCount = 0;
  state.acc = 0;
  state.paused = false;
  const cdef = CHARACTERS[cpuChar];
  state.turn = new TurnController(b, {
    cpuTimeoutMs: state.clientTimeoutMs,
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
  state.thinkingSince = performance.now();
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
  $('#send-btn').textContent = state.thinking ? `解析中… ${Math.floor((performance.now() - state.thinkingSince) / 1000)}秒` : phase === 'resolving' ? '相手の思考待ち…' : phase === 'execute' ? '実行中…' : '決定';
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
  const room = b.buildingOf(me);
  if (room && room.sealed) st.push('<b style="color:#ff9b54">密室（炎に囲まれている）</b>');
  if (b.isAirborne(me)) st.push('空中');
  const cds = me.def.abilities.map(id => {
    const left = me.cd[id] ? me.cd[id] - b.t : 0;
    return `<span class="${left > 0 ? 'cd' : 'ready'}">『${ABILITIES[id].name}』${left > 0 ? `${left.toFixed(1)}s` : '可'}</span>`;
  }).join(' ');
  $('#self-card').style.setProperty('--c', me.color);
  $('#self-card').innerHTML = `
    ${portrait(me.charId, 'mini')}<h3>${me.name} <small>『${me.stand}』</small></h3>
    ${bar('hp', me.hp, me.maxHp, `HP ${Math.round(me.hp)}/${me.maxHp}`)}
    ${bar('sp', me.sp, me.maxSp, `スタンドエネルギー ${Math.round(me.sp)}`)}
    <div class="meta">${me.held ? `手に${me.held.name}` : '素手'} ／ 位置 (${me.x.toFixed(1)}, ${me.y.toFixed(1)}) ／ ${room ? `${room.name}の${me.floor + 1}階` : '屋外'}${room ? `（出口 開${room.exits.filter(id => b.exitOpen(id)).length}/${room.exits.length}）` : ''}</div>
    <div class="meta">${cds}</div>
    <div class="meta">${st.join('・')}</div>`;

  const vis = foe.alive && b.canSee(me, foe.x, foe.y);
  const ls = me.memory.lastSeen;
  $('#enemy-card').style.setProperty('--c', foe.color);
  $('#enemy-card').innerHTML = `${portrait(foe.charId, 'mini')}
    <h3>敵：${foe.name} ${vis ? '<span class="tag seen">視認中</span>' : '<span class="tag">見えていない</span>'}</h3>
    ${vis || DEBUG ? bar('hp enemy', foe.hp, foe.maxHp, `HP 約${Math.round(foe.hp / 10) * 10}`) : ''}
    <div class="meta">${vis ? `距離 ${dist(me.x, me.y, foe.x, foe.y).toFixed(1)}m・${b.buildingOf(foe) ? `${b.buildingOf(foe).name}の${foe.floor + 1}階` : '屋外'}` : ls ? `最後に見た位置 (${ls.x.toFixed(1)}, ${ls.y.toFixed(1)})${ls.floor ? '・2階' : ''}・${(b.t - ls.t).toFixed(0)}秒前` : '一度も姿を見ていない'}</div>
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
    if (l.kind === 'ability') {
      const c = b.chars.find(ch => ch.id === l.actor);
      if (c && (c === me || DEBUG || b.canSee(me, c.x, c.y))) showCutin(c, text);
    }
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
  const f = b.player.floor;
  const o = b.world.objects.find(ob => ob.floor === f && pointInRect(x, y, ob, 0.25) && !ob.id.startsWith('outer_'))
    || b.world.objects.find(ob => pointInRect(x, y, ob, 0.25) && !ob.id.startsWith('outer_'));
  if (o) return o.name;
  return `(${x.toFixed(1)}, ${y.toFixed(1)})${f === 1 ? '（2階）' : ''}`;
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
  renderMapCards();
  preloadPortraits();
  await checkStatus();
  $('#opponent').addEventListener('change', e => { state.opponent = e.target.value; });
  $('#map-cards').addEventListener('click', e => {
    const card = e.target.closest('.map-card');
    if (card) { state.mapId = card.dataset.id; renderMapCards(); }
  });
  const toggleZoom = () => {
    if (!state.battle) return;
    const z = state.renderer.toggleZoom(state.battle);
    $('#zoom-btn').textContent = z === 'near' ? '全体表示' : '拡大表示';
  };
  $('#zoom-btn').addEventListener('click', toggleZoom);
  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = 'image/*';
  fileIn.addEventListener('change', () => {
    if (fileIn.files[0]) savePortraitFile(fileIn.dataset.id, fileIn.files[0]);
    fileIn.value = '';
  });
  $('#char-cards').addEventListener('click', e => {
    const up = e.target.closest('[data-up]');
    if (up) { e.stopPropagation(); fileIn.dataset.id = up.dataset.up; fileIn.click(); return; }
    const clr = e.target.closest('[data-clear]');
    if (clr) { e.stopPropagation(); clearPortrait(clr.dataset.clear); return; }
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
    if (e.code === 'KeyZ' && document.activeElement !== $('#cmd') && !$('#battle').classList.contains('hidden')) toggleZoom();
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
    const p = state.renderer.toWorld(e.clientX, e.clientY, b.player.floor * 3);
    insertText(describePoint(b, p.x, p.y));
  });
  field.addEventListener('mousemove', e => {
    const b = state.battle;
    if (!b) return;
    const p = state.renderer.toWorld(e.clientX, e.clientY, b.player.floor * 3);
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
