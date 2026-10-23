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
import { loadFxSheet, saveFxBlob, loadChips } from './fx.js';
import { Sound } from './audio.js';
import { Director } from './spectate.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
// 全員の情報を見せるか（デバッグ時と観戦モード）
const omni = () => DEBUG || state.spectate;

const state = {
  gemini: false,
  model: '',
  chosen: 'sogo',
  opponent: 'random',
  opponent2: 'random',
  ally: 'random',
  mode: '2v2',
  control: 'play', // play=自分で操作 / watch=CPU同士を観戦
  spectate: false,
  sfx: (() => { try { return localStorage.getItem('sfx') !== 'off'; } catch { return true; } })(),
  freezeUntil: 0, // ヒットストップ（実時間）
  slow: { until: 0, factor: 1 }, // スローモーション（実時間）
  cine: (() => { try { return localStorage.getItem('cine') !== 'off'; } catch { return true; } })(), // クローズアップとスローの演出
  seenSound: new WeakSet(),
  lastFx: 0,
  autoTurn: 0,
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
  logSeen: new WeakSet(),
  ended: false,
};

const snd = new Sound();

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
    'エコー・ビーチ6体で敵を引っかく',
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
  mikuriya: [
    '車両を敵へ走らせて、敵の背中に口をつける',
    '歯を食いしばって5秒噛みつく',
    '自分の腕に口をつけて盾にする',
    '車両を右の路地へ走らせて、そこに口を残す',
    '「……こっち」と口から喋って、敵を路地へおびき寄せる',
    '物陰に隠れてから、車両を敵の方へ走らせる',
  ],
  saragiin: [
    '「前世から知ってる気がするんだよね」と話しかけながら、敵の足元の床を粉にする',
    '敵の持っている鉄パイプを粉にして崩す',
    '目の前の壁に穴を開けて通り抜ける',
    '通り道の床を仕込んでから物陰で待つ',
    '開けた穴を元に戻して塞ぐ',
    '2階の敵の床を崩して1階へ落とし、倒れた所を殴る',
  ],
};

// 戦闘画面に出す「スタンドでできること」（書き方の例つき）
const STAND_TIPS = {
  sogo: [
    ['自分を弾いて10m飛ぶ（壁際なら真横、開けた所なら真上）', '壁を蹴って離脱する'],
    ['触れた敵・物を10m弾き出す。途中の壁に叩きつけると大ダメージ', '敵に触れて弾き出す'],
    ['手に持った物を10m先へ飛ばす', '花瓶を拾って敵に弾き出す'],
    ['空中で持った物を基準に方向転換する', '空中で左へ方向転換'],
    ['開けた所で触れた敵を真上に打ち上げる（落ちて8ダメージ・転倒）', '敵を真上に打ち上げて、落ちたら殴る'],
  ],
  nanami: [
    ['個体を置いて、そこで鳴った音を拾わせる（大きな音を集める）', 'エコー・ビーチを4体、自販機のそばに置く'],
    ['拾った音（足音・声・大きな音）を別の場所で鳴らして誘導する', '足音を右の路地に置く'],
    ['大きな音3つ以上を敵の耳元で一斉に鳴らす（決め技：耳が聞こえず転倒）', '轟音を一斉に鳴らす'],
    ['個体を群がらせて引っかく（1体につき1.5ダメージ）', 'エコー・ビーチ6体で敵を引っかく'],
    ['無音の結界：半径3mの音を10秒間すべて消す（中を歩けば誰にも聞こえない）', '自分の周りに無音の結界を張って回り込む'],
    ['足音の行列：誰かが歩いているような足音を別の方向へ鳴らす', '足音の行列を右に歩かせる'],
    ['自分の足音を消す／個体を呼び戻す', '足音を消して回り込む'],
  ],
  saginuma: [
    ['床に玉を撒く（走って踏んだ敵が転ぶ・20秒）', '足元に玉を撒いてから離れる'],
    ['牽制射撃（0.5秒ごとに4発、直接撃ち続ける）', '敵に牽制射撃して物陰へ走る'],
    ['球をまっすぐ撃つ（跳ねていない球は弱い）', '敵に向けて球をまっすぐ撃つ'],
    ['壁で跳ね返らせて撃つ（跳ねるほど強く、5回以上で貫通）', '3回跳ね返る軌道で物陰の敵を撃つ'],
    ['3発を角度を変えてばらまく', '3発ばらまいて逃げ道をふさぐ'],
  ],
  mikuriya: [
    ['車両を走らせる：最大200m先まで、壁もすり抜けて走る（車両の周りは見えない。敵の体に乗り上げると手応えで位置が分かる）', '車両を敵へ走らせる'],
    ['口を残す：車両が通った場所・体の上を走った人に、自分の口を最大8個残す', '車両を敵へ走らせて、敵の背中に口をつける'],
    ['食いしばる：全部の口で噛む（敵の体の口は噛みつき続け、床の口は近づいた敵の足首を噛む。腕の口は拳を受け止める）。喋ると外れる', '歯を食いしばって5秒噛みつく'],
    ['自分の腕に口を付けておくと、食いしばっている間は殴られても口が受け止める', '自分の腕に口をつけて盾にする'],
    ['口から喋る：全部の口から同じ声（離れた所から敵を誘う・味方に伝える）', '「……こっち」と口から喋る'],
  ],
  saragiin: [
    ['足場を崩す：5m以内の敵の足元を粉にして転ばせる（2階なら床が抜けて落ちる。話しかけている最中なら長く崩れる）', '話しかけながら敵の足元を崩す'],
    ['得物を崩す：敵の持っている物（鉄パイプ・包丁など、鷺沼の玉）を粉にする', '敵の鉄パイプを粉にする'],
    ['粉にする：5m以内の壁・扉・窓・木箱などを粉に（壁は約1mの穴。スタンドは壁をすり抜けて触れる）', '目の前の壁に穴を開ける'],
    ['床を仕込む：踏むと抜ける床を2か所まで（自分の側にだけ見える）', '足元の床を仕込んで下がる'],
    ['元に戻す：散っていない粉の山を元の形に（穴を塞ぐ・痕跡を消す。戻した物はもろい）', '開けた穴を元に戻す'],
  ],
  kito: [
    ['建物の中で、相手も中にいる時に最後の出口を閉めると密室（炎で囲み、誰も出られない）', '家に追い込んで扉を閉める'],
    ['開けられた扉・窓を閉め直す（自分が閉めた出口は戻る）', '開いた窓を閉め直す'],
    ['家の中で待ち伏せ：敵が入ってきた瞬間に扉を閉める（スタンドを出していれば少し離れた扉も素早く閉められる）', 'スタンドを出して、敵が入ってきたら扉を閉める'],
    ['密室の中で敵を炎の壁へ叩きつける（8＋火傷12）', '敵を炎の壁に叩きつける'],
  ],
};
// 誰でも使える行動（近接の読み合い・隠密・地形・道具）
const GENERIC_TIPS = [
  ['掴み：ガード・受け流しを崩して動きを止める（殴られると潰される）', '敵がガードしたら掴みかかる'],
  ['受け流し：正面から殴ってきた相手に打ち返す', '受け流しの構えで待つ'],
  ['フェイント・体当たり：構えを空振りさせる／突き飛ばして転ばせる', 'フェイントしてから殴る'],
  ['潜む・物音を立てる・見回す：見つからない・誘う・気づく', '右に小石を投げて物音を立てる'],
  ['乗り越える・道具（消火器の煙幕、傘の盾）', '消火器を拾って煙幕を張る'],
];
const STAND_COMMON = [['スタンドを出す・先行させる・戻す（射程の分だけ先へ行かせて、壁もすり抜けて覗く／殴る間合いが伸びる／飛び道具を受け止める。出している間はエネルギーが減る）', 'スタンドを右へ先行させる']];

function showTab(name) {
  for (const t of document.querySelectorAll('.tabs .tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-body .pane')) p.classList.toggle('on', p.dataset.pane === name);
}

function standTipsHtml(c) {
  const tips = [...(STAND_TIPS[c.charId] || []), ...(c.def.standRange ? STAND_COMMON : [])];
  tips.push(...GENERIC_TIPS);
  return `<ul>${tips.map(([what, ex]) => `<li>${what}<br><span class="ex" data-ex="${ex}">例：「${ex}」</span></li>`).join('')}</ul>`;
}

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
    tryExt(['webp', 'png', 'jpg', 'jpeg']);
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

// キャラチップの正面（南向き）の1コマを画像にする（タイトルのカードやカットインに使う）
const chipThumbCache = {};
function chipThumb(id) {
  if (chipThumbCache[id]) return chipThumbCache[id];
  const chip = state.chips && state.chips[id];
  if (!chip) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 48;
  cv.getContext('2d').drawImage(chip.img, 0, 0, 48, 48, 0, 0, 48, 48);
  return (chipThumbCache[id] = cv.toDataURL());
}

// 能力発動時のカットイン
function showCutin(c, text) {
  const el = $('#cutin');
  const chipSrc = chipThumb(`${c.charId}_stand`) || chipThumb(c.charId);
  const src = portraitSrc[`${c.charId}_stand`] || portraitSrc[c.charId] || chipSrc;
  if (!el || !src) return;
  el.classList.toggle('pixel', !portraitSrc[`${c.charId}_stand`] && !portraitSrc[c.charId]);
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
      ${chipThumb(c.id) || chipThumb(`${c.id}_stand`) ? `<div class="chips">${[c.id, `${c.id}_stand`].map(id => chipThumb(id) ? `<img class="chip" src="${chipThumb(id)}" alt="">` : '').join('')}</div>` : ''}
      <div class="char-head"><span class="dot"></span><div><b>${c.name}</b>${c.reading ? ` <small>（${c.reading}${c.nickname ? `・通称「${c.nickname}」` : ''}）</small>` : ''}<div class="stand">スタンド『${c.stand}』</div></div></div>
      ${c.profile ? `<p class="profile">${c.profile}</p>` : ''}
      <p class="persona">${c.personality}</p>
      ${c.stats ? `<table class="stats"><tr>${Object.values(STAT_LABELS).map(l => `<th>${l}</th>`).join('')}</tr><tr>${Object.keys(STAT_LABELS).map(k => `<td>${c.stats[k]}</td>`).join('')}</tr></table>` : ''}
      <div class="meta">HP ${c.hp} / 体重${c.kg}kg / 歩き${c.walk}m/s・走り${c.run}m/s</div>
      ${c.abilities.map(abilityHtml).join('')}
    </div>`).join('');
  for (const [sel, key] of [['#opponent', 'opponent'], ['#opponent2', 'opponent2'], ['#ally', 'ally']]) {
    $(sel).innerHTML = '<option value="random">ランダム</option>' +
      Object.values(CHARACTERS).map(c => `<option value="${c.id}">${c.name}『${c.stand}』${c.id === state.chosen ? '（自分と同じ）' : ''}</option>`).join('');
    $(sel).value = state[key];
  }
  $('#mode').value = state.mode;
  document.querySelectorAll('.team-only').forEach(el => el.classList.toggle('hidden', state.mode !== '2v2'));
}

// 出場キャラを決める。ランダムはまだ出ていないキャラから選ぶ（足りなければ重複可）
function pickLineup() {
  const used = [state.chosen];
  const pick = want => {
    if (want !== 'random') { used.push(want); return want; }
    const pool = Object.keys(CHARACTERS).filter(id => !used.includes(id));
    const list = pool.length ? pool : Object.keys(CHARACTERS).filter(id => id !== state.chosen);
    const id = list[Math.floor(Math.random() * list.length)];
    used.push(id);
    return id;
  };
  const team = state.mode === '2v2';
  // 指定済みのキャラを先に確保してから、ランダムを埋める
  for (const k of ['ally', 'opponent', 'opponent2']) if (state[k] !== 'random' && (team || k === 'opponent')) used.push(state[k]);
  const cpuChar = state.opponent !== 'random' ? state.opponent : pick('random');
  const allyChar = team ? (state.ally !== 'random' ? state.ally : pick('random')) : null;
  const cpu2Char = team ? (state.opponent2 !== 'random' ? state.opponent2 : pick('random')) : null;
  return { cpuChar, allyChar, cpu2Char };
}

// ---------- 戦闘 ----------

function startBattle() {
  const lineup = pickLineup();
  state.spectate = state.control === 'watch';
  const b = new Battle({ seed: Date.now() & 0xffffff, playerChar: state.chosen, ...lineup, mapId: state.mapId, spectate: state.spectate });
  document.querySelector('.command').classList.toggle('hidden', state.spectate);
  document.querySelector('.tab[data-tab="tips"]').classList.toggle('hidden', state.spectate);
  showTab('log');
  state.battle = b;
  state.ended = false;
  state.logSeen = new WeakSet();
  state.acc = 0;
  state.paused = false;
  state.freezeUntil = 0;
  state.slow = { until: 0, factor: 1 };
  snd.unlock();
  if (state.mapId === 'town') snd.startAmbience(); else snd.stopAmbience();
  state.lastFx = 0;
  state.autoTurn = 0;
  state.turn = new TurnController(b, {
    cpuTimeoutMs: state.clientTimeoutMs,
    cpuRemote: state.gemini
      ? (obs, c) => apiPlan({ role: 'cpu', observation: obs, character: { name: c.def.name, stand: c.def.stand, personality: c.def.personality } })
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
  $('#stand-tips-title').textContent = `『${b.player.stand}』と共通の行動（例文をクリックで入力欄へ）`;
  $('#stand-tips-body').innerHTML = standTipsHtml(b.player);
  $('#ability-ref').innerHTML = b.player.def.abilities.map(abilityHtml).join('') +
    `<h4>基本行動</h4><ul>${Object.values(ACTIONS).filter(a => a !== ACTIONS.ability).map(a => `<li><b>${a.name}</b>：${a.desc}</li>`).join('')}</ul>
     <p class="meta">1回の指示は最大${RULES.maxSteps}手順・見積もり${RULES.budgetSeconds}秒まで。</p>`;
  state.renderer.resize(b);
  setupSpectate(b);
  updatePause();
  if (!state.spectate) $('#cmd').focus();
}

// ---------- 観戦：自動カメラ・体力の綱引き ----------

const teamNames = (b, t) => b.chars.filter(c => c.team === t).map(c => c.name).join('・');

function setupSpectate(b) {
  const on = state.spectate;
  state.director = on ? new Director() : null;
  for (const id of ['#tug', '#cam-btn']) $(id).classList.toggle('hidden', !on);
  $('#cam-btn').textContent = 'カメラ：自動';
}

function updateSpectate(now) {
  const b = state.battle;
  if (!state.spectate || !b) return;
  // 体力の綱引き（左がチームA）
  const hp = t => b.chars.filter(c => c.team === t).reduce((a, c) => a + Math.max(0, c.hp), 0);
  const max = t => b.chars.filter(c => c.team === t).reduce((a, c) => a + c.maxHp, 0);
  const a = hp(0) / max(0), z = hp(1) / max(1);
  $('#tug .tug-fill').style.width = `${(a + z > 0 ? a / (a + z) : 0.5) * 100}%`;
  $('#tug .tug-a').textContent = `${teamNames(b, 0)} ${Math.round(a * 100)}%`;
  $('#tug .tug-b').textContent = `${Math.round(z * 100)}% ${teamNames(b, 1)}`;
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
    input: state.spectate ? `第${turn.turn}手：観戦中（CPUが作戦を考えています）` : state.battle && !state.battle.player.alive ? `第${turn.turn}手：観戦中（味方の戦いを見守っています）` : `第${turn.turn}手：入力ターン（時間停止中）`,
    resolving: state.spectate ? `第${turn.turn}手：観戦中（CPUが作戦を考えています）` : `第${turn.turn}手：相手の作戦を待っています…`,
    execute: `第${turn.turn}手：全員の行動を実行中`,
    over: '決着',
  }[phase];
  $('#phase-label').textContent = label;
  $('#phase-label').className = `phase phase-${phase}`;
  if (phase !== state.lastPhase) {
    if (phase === 'input' && !state.spectate) $('#cmd').focus();
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
  const me = b.player;
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
    ${portrait(me.charId, 'mini')}<h3>${state.spectate ? 'チームA：' : ''}${me.name} <small>『${me.stand}』</small></h3>
    ${bar('hp', me.hp, me.maxHp, `HP ${Math.round(me.hp)}/${me.maxHp}`)}
    ${bar('sp', me.sp, me.maxSp, `スタンドエネルギー ${Math.round(me.sp)}`)}
    <div class="meta">${me.held ? `手に${me.held.name}` : '素手'} ／ 位置 (${me.x.toFixed(1)}, ${me.y.toFixed(1)}) ／ ${room ? `${room.name}の${me.floor + 1}階` : '屋外'}${room ? `（出口 開${room.exits.filter(id => b.exitOpen(id)).length}/${room.exits.length}）` : ''}</div>
    <div class="meta">${cds}</div>
    <div class="meta">${st.join('・')}</div>`;

  const ally = b.alliesOf(me)[0];
  const allyCard = $('#ally-card');
  allyCard.classList.toggle('hidden', !ally);
  if (ally) {
    const abd = b.buildingOf(ally);
    const ap = ally.runner.plan;
    const cur = ap && ap.steps[Math.max(0, ally.runner.idx - 1)];
    allyCard.style.setProperty('--c', ally.color);
    allyCard.innerHTML = `${portrait(ally.charId, 'mini')}<h3>${state.spectate ? 'チームA：' : '味方：'}${ally.name} <small>『${ally.stand}』</small></h3>
      ${ally.alive ? bar('hp', ally.hp, ally.maxHp, `HP ${Math.round(ally.hp)}/${ally.maxHp}`) : '<div class="meta"><b>再起不能</b></div>'}
      ${ally.alive ? `<div class="meta">距離 ${dist(me.x, me.y, ally.x, ally.y).toFixed(1)}m・${abd ? `${abd.name}の${ally.floor + 1}階` : '屋外'}${ally.held ? `・${ally.held.name}` : ''}</div>
      <div class="meta">狙い：${b.enemyOf(ally).name}／${cur && ally.runner.step ? `行動中：${cur.label}` : '待機'}</div>` : ''}`;
  }
  const foes = b.enemiesOf(me);
  $('#enemy-card').innerHTML = foes.map(foe => {
    const vis = foe.alive && b.canSee(me, foe.x, foe.y);
    const ls = me.memory.seen[foe.id];
    const target = foe.alive && b.enemyOf(me) === foe && foes.filter(f => f.alive).length > 1;
    return `<div class="foe" style="--c:${foe.color}">${portrait(foe.charId, 'mini')}
    <h3>${state.spectate ? 'チームB：' : '敵：'}${foe.name} ${!foe.alive ? '<span class="tag">再起不能</span>' : vis ? '<span class="tag seen">視認中</span>' : '<span class="tag">見えていない</span>'}${target ? ' <span class="tag focus">狙い</span>' : ''}</h3>
    ${foe.alive && (vis || omni()) ? bar('hp enemy', foe.hp, foe.maxHp, `HP 約${Math.round(foe.hp / 10) * 10}`) : ''}
    ${foe.alive ? `<div class="meta">${vis ? `距離 ${dist(me.x, me.y, foe.x, foe.y).toFixed(1)}m・${b.buildingOf(foe) ? `${b.buildingOf(foe).name}の${foe.floor + 1}階` : '屋外'}` : ls ? `最後の目撃 (${ls.x.toFixed(1)}, ${ls.y.toFixed(1)})${ls.floor ? '・2階' : ''}・${(b.t - ls.t).toFixed(0)}秒前${ls.via ? `（${ls.via}の報告）` : ''}` : '一度も姿を見ていない'}</div>` : ''}
    ${omni() ? `<div class="meta debug">計画：${(foe.runner.plan?.steps || []).map((s, i) => `${i === foe.runner.idx - 1 ? '▶' : ''}${s.label}`).join(' / ')}</div>` : ''}</div>`;
  }).join('') + `<div class="meta">敵の能力（観察から推測）：${me.memory.observed.length ? me.memory.observed.map(h => `<div>・${h}</div>`).join('') : '不明'}</div>`;

  const plan = me.runner.plan;
  $('#plan-source').textContent = plan ? (plan.source === 'gemini' ? 'Gemini' : 'ローカル') : '';
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
  // 時間制限（警察到着）と、判定に使う与ダメージ
  const left = Math.max(0, RULES.timeLimit - b.t);
  const tl = $('#time-label');
  const zr = b.safeZone ? b.zoneRadius() : 0;
  const shrinking = RULES.zonePhases.some(([t0, t1]) => b.t >= t0 && b.t < t1);
  const next = RULES.zonePhases.find(([t0]) => b.t < t0);
  const out = me.alive && b.outsideZone(me);
  tl.innerHTML = `経過 ${b.t.toFixed(1)}秒／${b.safeZone ? '' : '<!--'}<span class="${out ? 'zone-out' : 'zone'}">安全地帯 半径${zr.toFixed(0)}m${shrinking ? '（縮小中）' : next ? `（${(next[0] - b.t).toFixed(0)}秒後に縮小）` : ''}${out ? '・外にいる！' : ''}</span>／${b.safeZone ? '' : '-->'}警察まで ${left.toFixed(0)}秒／与ダメージ ${state.spectate ? 'A' : '自分側'} ${b.teamDealt(me.team)}：${state.spectate ? 'B' : '相手側'} ${b.teamDealt(1 - me.team)}`;
  tl.classList.toggle('siren', b.t >= RULES.policeWarn);
}

function renderLog() {
  const b = state.battle;
  const me = b.player;
  const team = new Set(b.chars.filter(c => c.team === me.team && (c === me || !me.alive)).map(c => c.id));
  const entries = b.log.filter(l => omni() || [...team].some(id => l.visibleTo.has(id)));
  // 表示済みの記録は覚えておき、新しいものだけ足す（観戦に切り替わっても重複しない）
  const fresh = entries.slice(-60).filter(l => !state.logSeen.has(l));
  if (!fresh.length) return;
  for (const l of fresh) state.logSeen.add(l);
  const log = $('#log');
  for (const l of fresh) {
    const p = document.createElement('p');
    p.className = `k-${l.kind}`;
    const text = team.has(l.actor) || omni() ? l.text : l.obsText || l.text;
    p.innerHTML = `<span class="t">${l.t.toFixed(1)}</span> ${escapeHtml(text)}`;
    if (l.heardBy.has(me.id) && l.kind !== 'speech') p.innerHTML += ' <span class="heard">（音）</span>';
    log.prepend(p);
    if (l.kind === 'stand') playSe('stand', 0.5);
    if (l.kind === 'ability') {
      const ac = b.chars.find(ch => ch.id === l.actor);
      const seName = ac && ABILITY_SE[ac.def.abilities[0]];
      if (seName) playSe(seName, 0.8, 'ability');
      const c = ac;
      if (c && (c.team === me.team || omni() || b.canSee(me, c.x, c.y))) showCutin(c, text);
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
  const won = b.winnerTeam === b.player.team;
  if (state.spectate) {
    const names = t => b.chars.filter(c => c.team === t).map(c => c.name).join('・');
    $('#result-title').textContent = b.winnerTeam === null ? '引き分け' : `${b.teamSize > 1 ? (b.winnerTeam === 0 ? 'チームA' : 'チームB') : names(b.winnerTeam)}の勝ち`;
    $('#result-body').textContent = `${names(0)} 対 ${names(1)}／与えたダメージ ${b.teamDealt(0)} 対 ${b.teamDealt(1)}（${b.t.toFixed(1)}秒${b.endReason === 'police' ? '・警察到着で判定' : ''}）`;
    setTimeout(() => $('#result').classList.remove('hidden'), 1800);
    return;
  }
  const team = b.teamSize > 1;
  $('#result-title').textContent = b.winnerTeam === null ? '相打ち' : won ? '勝利！' : '敗北……';
  const names = b.winnerTeam === null ? '' : b.chars.filter(c => c.team === b.winnerTeam).map(c => `${c.name}『${c.stand}』`).join('・');
  const score = `与えたダメージ ${b.teamDealt(b.player.team)} 対 ${b.teamDealt(1 - b.player.team)}`;
  $('#result-body').textContent = b.endReason === 'police'
    ? (b.winnerTeam === null ? `警察が到着し、両者その場から逃げた（${score}で引き分け）` : `警察が到着。${names}${team ? 'のチーム' : ''}の判定勝ち（${score}）`)
    : b.winnerTeam === null ? '全員再起不能' : `${names}${team ? 'のチーム' : ''}の勝ち（${b.t.toFixed(1)}秒）`;
  setTimeout(() => $('#result').classList.remove('hidden'), 1800);
}

// ---------- 戦闘の演出：ヒットストップ・画面揺れ・効果音 ----------

let audio = null;
function sfx(kind, power = 1) {
  if (!state.sfx) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const out = audio.createGain();
    out.gain.setValueAtTime(Math.min(0.5, 0.12 + power * 0.25), t);
    out.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'ko' ? 0.9 : 0.25));
    out.connect(audio.destination);
    // 打撃音：低い唸り＋短いノイズ
    const osc = audio.createOscillator();
    osc.type = kind === 'ability' ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(kind === 'ability' ? 220 : kind === 'ko' ? 90 : 140, t);
    osc.frequency.exponentialRampToValueAtTime(kind === 'ability' ? 660 : 40, t + (kind === 'ko' ? 0.8 : 0.2));
    osc.connect(out); osc.start(t); osc.stop(t + 1);
    if (kind !== 'ability') {
      const len = Math.floor(audio.sampleRate * 0.12);
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = audio.createBufferSource();
      src.buffer = buf;
      const f = audio.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900 + power * 1800;
      src.connect(f); f.connect(out); src.start(t);
    }
  } catch { /* 音が出せない環境では無視 */ }
}

// 新しく起きた演出用エフェクトを拾い、ヒットストップ・揺れ・効果音に変える
function viewerOf(b) {
  if (state.spectate && state.director) return state.director.viewer(b);
  return b.player.alive ? b.player : b.alliesOf(b.player).find(a => a.alive) || b.player;
}

// 音の種類 → 効果音ファイル
const SE_OF = {
  impact: 'break', crash: 'crash', glass: 'glass', door: 'door', fall: 'fall', swing: 'swing', throw: 'swing',
  ricochet: 'ricochet', flick: 'flick', alarm: 'alarm', siren: 'siren', powder: 'powder',
};
const ABILITY_SE = { perpendicular: 'launch', hotel: 'flame', echo: 'stand', vacant: 'powder', corvette: 'stand' };

// 効果音を鳴らす。距離で小さくし、スロー中は低く再生する。素材が無ければ合成音で代用
function playSe(name, vol = 1, fallback = null) {
  const rate = performance.now() < state.slow.until ? 0.75 : 1;
  if (snd.play(name, vol, rate) || snd.has(name)) return;
  if (fallback) sfx(fallback, vol);
}

function seVolume(me, x, y, reach = 30) {
  return Math.max(0.2, Math.min(1, 1 - dist(me.x, me.y, x, y) / reach));
}

// スロー：factor 倍の速さを ms ミリ秒（より強いスローで上書き）
function slowMo(now, factor, ms) {
  if (!state.cine) return;
  if (now < state.slow.until && state.slow.factor <= factor) { state.slow.until = Math.max(state.slow.until, now + ms); return; }
  state.slow = { until: now + ms, factor };
}

function closeUp(f, scale, sec) {
  if (state.cine) state.renderer.closeUp(f.x, f.y, f.z ?? 1, scale, sec);
}

// 新しく起きた演出用エフェクトを拾い、ヒットストップ・揺れ・クローズアップ・スロー・効果音に変える
function handleImpacts(now) {
  const b = state.battle;
  const me = viewerOf(b);
  for (const f of b.fx) {
    if (!f.seq || f.seq <= state.lastFx) continue;
    state.lastFx = Math.max(state.lastFx, f.seq);
    if (!omni() && f.visibleTo && !f.visibleTo.has(me.id)) continue;
    if (f.kind === 'hit' && f.hitKind === 'zone') continue; // 安全地帯の外の削りは演出なし
    if (f.kind === 'hit') {
      const power = Math.min(1, f.dmg / 30);
      state.freezeUntil = Math.max(state.freezeUntil, now + 40 + power * 190);
      state.renderer.kick(3 + power * 12);
      if (f.dmg >= 15) {
        flashScreen(f.target === me.id ? 'rgba(255,60,60,0.35)' : 'rgba(255,255,255,0.35)');
        // 大ダメージ：寄ってスローに
        closeUp(f, 2.3, 1.0);
        slowMo(now, 0.25, 700);
      }
      const name = f.guarded ? 'guard' : f.hitKind === 'scratch' ? 'scratch' : f.dmg >= 15 ? 'hit_heavy' : 'hit_light';
      playSe(name, seVolume(me, f.x, f.y) * (0.6 + power * 0.4), 'hit');
    } else if (f.kind === 'ko') {
      state.freezeUntil = Math.max(state.freezeUntil, now + 260);
      closeUp(f, 2.6, 1.9);
      slowMo(now, 0.2, 1600);
      state.renderer.kick(16);
      flashScreen('rgba(255,255,255,0.55)');
      playSe('ko', 1, 'ko');
    } else if (f.kind === 'clash') {
      // 至近距離の殴り合い：構えの間だけ寄ってスローに（続けて起きる時は3秒に1回まで）
      if (now - (state.lastClash || 0) > 3000) {
        state.lastClash = now;
        closeUp(f, 1.8, 1.1);
        slowMo(now, 0.4, 800);
      }
      playSe('swing', 0.5);
    } else if (f.kind === 'shock') {
      playSe('roar', 1);
    }
  }
  // 音：見えている所で鳴った音（sound）と、姿の見えない所から聞こえた音
  for (const f of b.fx) {
    if (f.kind !== 'sound' || state.seenSound.has(f)) continue;
    state.seenSound.add(f);
    if (!omni() && f.visibleTo && !f.visibleTo.has(me.id)) continue;
    const name = SE_OF[f.sk];
    if (name) playSe(name, seVolume(me, f.x, f.y, Math.max(12, f.radius * 1.2)));
  }
  for (const h of me.memory.heard) {
    if (state.seenSound.has(h)) continue;
    state.seenSound.add(h);
    if (b.t - h.t > 0.5) continue;
    const name = SE_OF[h.kind];
    if (name) playSe(name, h.kind === 'siren' ? 0.8 : 0.45 * seVolume(me, h.x, h.y));
  }
}

function flashScreen(color) {
  const el = $('#screen-flash');
  el.style.background = color;
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

// 不具合が起きても画面と進行を止めない：内容を一度だけログに出して続ける
const reported = new Set();
function guard(where, fn) {
  try {
    fn();
  } catch (e) {
    const key = `${where}:${e.message}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.error(where, e);
      if (state.battle) state.battle.emit({ text: `（${where}で不具合が起きました：${e.message}。続行します）`, kind: 'fail', all: true });
    }
  }
}

function loop(now) {
  // 次のフレームを先に予約しておく（途中で例外が起きても止まらない）
  requestAnimationFrame(loop);
  const dtReal = Math.min(0.1, (now - state.last) / 1000 || 0);
  state.last = now;
  const b = state.battle;
  if (b && !$('#battle').classList.contains('hidden')) {
    // 時間が進むのは実行フェーズの間だけ
    guard('演出', () => handleImpacts(now));
    // 自分がやられた後は、味方の戦いを観戦する（入力ターンは自動で進む）
    if (state.turn.phase === 'input' && (!b.player.alive || state.spectate) && state.autoTurn !== state.turn.turn) {
      state.autoTurn = state.turn.turn;
      state.turn.commit(compilePlan(b, b.player, { steps: [] }));
    }
    const frozen = now < state.freezeUntil;
    const slow = now < state.slow.until ? state.slow.factor : 1;
    if (!state.paused && !frozen && state.turn.phase === 'execute') {
      state.acc += dtReal * state.speed * slow;
      let n = 0;
      while (state.acc >= RULES.dt && n++ < 12 && state.turn.phase === 'execute') {
        guard('戦闘の進行', () => state.turn.step());
        state.acc -= RULES.dt;
      }
    } else {
      state.acc = 0;
    }
    guard('画面の更新', () => updatePhase());
    // 自分がやられたら、生きている味方の視点で観戦する
    const viewer = viewerOf(b);
    guard('戦場の描画', () => state.renderer.draw(b, { debug: omni(), hover: state.hover, viewer, spectate: state.spectate }));
    guard('情報欄の表示', () => renderSide());
    guard('ログの表示', () => renderLog());
    guard('観戦の演出', () => updateSpectate(now));
    if (b.over && !state.ended) showResult();
  }
}

// ---------- フィールドのクリック：座標や物体名を入力欄へ ----------

function describePoint(b, x, y) {
  const f = b.player.floor;
  const o = b.world.objects.find(ob => ob.floor === f && pointInRect(x, y, ob, 0.25) && !ob.id.startsWith('outer_'))
    || b.world.objects.find(ob => pointInRect(x, y, ob, 0.25) && !ob.id.startsWith('outer_'));
  if (o) return o.name;
  return `(${x.toFixed(1)}, ${y.toFixed(1)})${f === 1 ? '（2階）' : ''}`;
}

// 2D表示と3D表示の切り替え（3D の描画部品は使う時に初めて読み込む）
async function setView(mode) {
  if (mode !== '2d' && !state.r3d) {
    try {
      const { Renderer3D } = await import('./render3d.js');
      state.r3d = new Renderer3D($('#field3d'));
      state.r3d.chips = state.r2d.chips;
      state.r3d.sheet = state.r2d.sheet;
    } catch (e) {
      alert(`3D表示を始められませんでした（${e.message}）。2D表示のまま続けます`);
      return;
    }
  }
  state.view = mode;
  const r = mode === '2d' ? state.r2d : state.r3d;
  if (mode !== '2d') { r.tps = mode === 'tps'; r.tpsOffset = 0; }
  state.renderer = r;
  $('#field').classList.toggle('hidden', mode !== '2d');
  $('#field3d').classList.toggle('hidden', mode === '2d');
  $('#view-btn').textContent = { '2d': '表示：2D', '3d': '表示：3D', tps: '表示：TPS' }[mode];
  $('#zoom-btn').classList.toggle('hidden', mode === 'tps');
  $('#zoom-btn').textContent = r.zoom === 'near' ? '全体表示' : '拡大表示';
  try { localStorage.setItem('nouryoku.view', mode); } catch { /* 無視 */ }
  if (state.battle) r.resize(state.battle);
}

function insertText(t) {
  const el = $('#cmd');
  const s = el.selectionStart ?? el.value.length;
  el.value = el.value.slice(0, s) + t + el.value.slice(el.selectionEnd ?? s);
  el.focus();
  el.selectionStart = el.selectionEnd = s + t.length;
}

window.addEventListener('DOMContentLoaded', async () => {
  state.renderer = state.r2d = new Renderer($('#field'));
  renderCharCards();
  renderMapCards();
  preloadPortraits();
  loadChips(Object.keys(CHARACTERS).flatMap(k => [k, `${k}_stand`])).then(chips => { state.r2d.chips = chips; if (state.r3d) state.r3d.chips = chips; state.chips = chips; renderCharCards(); });
  // エフェクト素材（public/fx/effects.png またはブラウザに保存した画像）
  const fxStatus = sheet => {
    $('#fx-status').textContent = sheet
      ? `読み込み済み：${sheet.source}（${sheet.w}×${sheet.h}px${sheet.keyed ? '・市松模様の背景を自動で抜きました' : ''}）`
      : '素材なし（プログラムで描いたエフェクトを使います）';
    $('#fx-clear').classList.toggle('hidden', !sheet || !sheet.source.startsWith('ブラウザ'));
  };
  const reloadFx = () => loadFxSheet().then(sheet => { state.r2d.sheet = sheet; if (state.r3d) state.r3d.sheet = sheet; fxStatus(sheet); }).catch(() => fxStatus(null));
  reloadFx();
  const fxIn = document.createElement('input');
  fxIn.type = 'file';
  fxIn.accept = 'image/*';
  fxIn.addEventListener('change', async () => {
    const f = fxIn.files[0];
    fxIn.value = '';
    if (!f) return;
    $('#fx-status').textContent = '読み込み中…';
    await saveFxBlob(f).catch(() => alert('ブラウザに保存できませんでした'));
    reloadFx();
  });
  $('#fx-btn').addEventListener('click', () => fxIn.click());
  $('#fx-clear').addEventListener('click', async () => { await saveFxBlob(null).catch(() => {}); reloadFx(); });
  await checkStatus();
  $('#opponent').addEventListener('change', e => { state.opponent = e.target.value; });
  $('#opponent2').addEventListener('change', e => { state.opponent2 = e.target.value; });
  $('#ally').addEventListener('change', e => { state.ally = e.target.value; });
  $('#mode').addEventListener('change', e => { state.mode = e.target.value; renderCharCards(); });
  $('#control').addEventListener('change', e => { state.control = e.target.value; renderCharCards(); });
  const sfxBtn = $('#sfx-btn');
  const sfxLabel = () => { sfxBtn.textContent = `効果音：${state.sfx ? 'ON' : 'OFF'}`; };
  sfxLabel();
  snd.setEnabled(state.sfx);
  // クローズアップ・スロー演出の切り替え
  const cineBtn = $('#cine-btn');
  const cineLabel = () => { cineBtn.textContent = `寄り・スロー：${state.cine ? 'ON' : 'OFF'}`; };
  cineLabel();
  cineBtn.addEventListener('click', () => {
    state.cine = !state.cine;
    try { localStorage.setItem('cine', state.cine ? 'on' : 'off'); } catch {}
    if (!state.cine) { state.renderer.cine = null; state.slow = { until: 0, factor: 1 }; }
    cineLabel();
  });
  // 最初の操作で音を出せるようにする（ブラウザの決まり）
  document.addEventListener('pointerdown', () => snd.unlock(), { once: true });
  document.addEventListener('keydown', () => snd.unlock(), { once: true });
  sfxBtn.addEventListener('click', () => {
    state.sfx = !state.sfx;
    snd.setEnabled(state.sfx);
    if (state.sfx && state.battle && state.mapId === 'town') snd.startAmbience();
    try { localStorage.setItem('sfx', state.sfx ? 'on' : 'off'); } catch {}
    sfxLabel();
  });
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
  $('#cam-btn').addEventListener('click', () => { if (state.battle && state.director) $('#cam-btn').textContent = `カメラ：${state.director.cycle(state.battle)}`; });

  // 表示：2D → 3D → TPS → 2D の順に切り替える
  $('#view-btn').addEventListener('click', () => setView({ '2d': '3d', '3d': 'tps', tps: '2d' }[state.view || '2d']));
  try { const v = localStorage.getItem('nouryoku.view'); if (v === '3d' || v === 'tps') setView(v); } catch { /* 保存できない環境では2D */ }
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
  // 右の欄のタブ（戦闘ログ／行動計画／できること）
  document.querySelector('.tabs').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) showTab(t.dataset.tab);
  });
  // 「スタンドでできること」の例文をクリックすると入力欄に入る
  $('#stand-tips-body').addEventListener('click', e => {
    const ex = e.target.closest('[data-ex]');
    if (ex) { $('#cmd').value = ex.dataset.ex; $('#cmd').focus(); }
  });
  $('#examples').addEventListener('change', e => {
    if (e.target.value) { $('#cmd').value = e.target.value; e.target.value = ''; $('#cmd').focus(); }
  });
  $('#pause-btn').addEventListener('click', () => { state.paused = !state.paused; updatePause(); });
  $('#speed').addEventListener('change', e => { state.speed = Number(e.target.value); });
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyZ' && document.activeElement !== $('#cmd') && !$('#battle').classList.contains('hidden')) toggleZoom();
    // 3D表示：Q / E でカメラを回す
    if ((e.code === 'KeyQ' || e.code === 'KeyE') && (state.view === '3d' || state.view === 'tps') && document.activeElement !== $('#cmd') && !$('#battle').classList.contains('hidden')) state.r3d.rotate(e.code === 'KeyQ' ? -Math.PI / 8 : Math.PI / 8);
    if (e.code === 'Space' && document.activeElement !== $('#cmd') && !$('#battle').classList.contains('hidden')) {
      e.preventDefault();
      state.paused = !state.paused;
      updatePause();
    }
  });
  for (const field of [$('#field'), $('#field3d')]) {
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
  }
  $('#quit-btn').addEventListener('click', () => {
    if (!confirm('戦闘を中断してタイトルに戻りますか？')) return;
    state.battle = null;
    $('#battle').classList.add('hidden');
    $('#title').classList.remove('hidden');
    snd.stopAmbience();
  });
  $('#again-btn').addEventListener('click', startBattle);
  $('#title-btn').addEventListener('click', () => {
    state.battle = null;
    $('#result').classList.add('hidden');
    $('#battle').classList.add('hidden');
    $('#title').classList.remove('hidden');
    snd.stopAmbience();
  });
  window.addEventListener('resize', () => { if (state.battle) state.renderer.resize(state.battle); });
  // 枠の大きさが変わったら（画面の回転・右の欄の幅など）フィールドを描き直す大きさに合わせる
  if (window.ResizeObserver) {
    let last = '';
    new ResizeObserver(([e]) => {
      const k = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
      if (k !== last && state.battle) { last = k; state.renderer.resize(state.battle); }
    }).observe(document.querySelector('.field-wrap'));
  }
  requestAnimationFrame(t => { state.last = t; loop(t); });
});
