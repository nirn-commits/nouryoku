// 画面表示と入力処理
const $ = sel => document.querySelector(sel);

const UI = {
  slots: [],
  mode: null,
  highlights: new Map(),
  busy: false,
  inspect: null,
  cell: 44,
  lastConfig: null,
};

// ---------- セットアップ画面 ----------

function defaultSlots() {
  return [0, 1, 2, 3].map(i => ({
    index: i,
    join: true,
    isCPU: i !== 0,
    charId: CHARACTERS[i].id,
    team: i % 2,
  }));
}

function statBlock(char) {
  return `<table class="stats">${Object.keys(STAT_LABELS).map(k =>
    `<tr><th>${STAT_LABELS[k]}</th><td class="g g${char.stats[k]}">${char.stats[k]}</td></tr>`).join('')}</table>`;
}

function renderSlots() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('#slots').innerHTML = UI.slots.map(s => {
    const c = CHARACTERS.find(ch => ch.id === s.charId);
    return `
    <div class="slot ${s.join ? '' : 'off'}" style="--c:${c.color}">
      <div class="slot-head">
        <b>${s.index + 1}P</b>
        ${s.index >= 2 ? `<label><input type="checkbox" data-k="join" data-i="${s.index}" ${s.join ? 'checked' : ''}> 参加</label>` : '<span class="req">必須</span>'}
      </div>
      <div class="slot-row">
        <select data-k="isCPU" data-i="${s.index}">
          <option value="0" ${!s.isCPU ? 'selected' : ''}>プレイヤー</option>
          <option value="1" ${s.isCPU ? 'selected' : ''}>CPU</option>
        </select>
        ${mode === 'team' ? `<select data-k="team" data-i="${s.index}">
          <option value="0" ${s.team === 0 ? 'selected' : ''}>チームA</option>
          <option value="1" ${s.team === 1 ? 'selected' : ''}>チームB</option>
        </select>` : ''}
      </div>
      <select data-k="charId" data-i="${s.index}" class="char-select">
        ${CHARACTERS.map(ch => `<option value="${ch.id}" ${ch.id === s.charId ? 'selected' : ''}>${ch.name}『${ch.stand}』</option>`).join('')}
      </select>
      <div class="char-card">
        <div class="char-name"><span class="glyph" style="background:${c.color}">${c.glyph}</span>
          <div><div>${c.name}</div><div class="stand-name">スタンド『${c.stand}』</div><div class="type">${c.type}</div></div>
        </div>
        <p class="desc">${c.desc}</p>
        ${statBlock(c)}
        <p class="ability"><b>能力『${c.ability.name}』</b>（CT${c.ability.cooldown}）<br>${c.ability.desc}</p>
      </div>
    </div>`;
  }).join('');
}

function onSlotChange(e) {
  const el = e.target;
  if (!el.dataset.k) return;
  const s = UI.slots[Number(el.dataset.i)];
  const k = el.dataset.k;
  if (k === 'join') s.join = el.checked;
  if (k === 'isCPU') s.isCPU = el.value === '1';
  if (k === 'team') s.team = Number(el.value);
  if (k === 'charId') s.charId = el.value;
  renderSlots();
}

function startFromSetup() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const slots = UI.slots.filter(s => s.join).map(s => ({ ...s }));
  const err = $('#setup-error');
  if (mode === 'team') {
    const a = slots.filter(s => s.team === 0).length;
    const b = slots.filter(s => s.team === 1).length;
    if (slots.length !== 4 || a !== 2 || b !== 2) {
      err.textContent = 'チーム戦は4人参加・各チーム2名ずつにしてください。';
      return;
    }
  }
  err.textContent = '';
  UI.lastConfig = { slots, mode };
  startBattle(slots, mode);
}

// ---------- バトル画面 ----------

function startBattle(slots, mode) {
  $('#setup').classList.add('hidden');
  $('#battle').classList.remove('hidden');
  $('#gameover').classList.add('hidden');
  $('#log').innerHTML = '';
  UI.mode = null;
  UI.inspect = null;
  UI.busy = false;
  newGame(slots, mode);
  fitBoard();
  FX.log('―― 第1ラウンド ――', 'round');
  nextTurn().then(afterAsync);
}

function fitBoard() {
  const wrap = $('#board-wrap');
  const avail = Math.min(wrap.parentElement.clientWidth - (window.innerWidth > 900 ? 330 : 0), 760);
  UI.cell = Math.max(20, Math.min(48, Math.floor(avail / MAP_W)));
  document.documentElement.style.setProperty('--cell', `${UI.cell}px`);
  render();
}

function isHumanTurn() {
  return G && !G.over && G.cur && !G.cur.unit.isCPU && !UI.busy;
}

function visibleTrapsFor(viewer) {
  if (!viewer || viewer.isCPU) return [];
  return G.traps.filter(t => {
    const owner = G.units.find(u => u.id === t.owner);
    return owner && !isEnemy(owner, viewer);
  });
}

function render() {
  if (!G) return;
  const cur = G.cur && G.cur.unit;
  const traps = visibleTrapsFor(cur);
  let html = '';
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const t = G.tiles[y][x];
      const hl = UI.highlights.get(`${x},${y}`);
      let inner = '';
      const item = itemAt(x, y);
      if (item) inner += `<span class="item item-${item.type}" title="${ITEM_TYPES[item.type].name}：${ITEM_TYPES[item.type].desc}">${ITEM_TYPES[item.type].icon}</span>`;
      if (traps.some(tr => tr.x === x && tr.y === y)) inner += '<span class="trap" title="見えざる糸">✳</span>';
      const u = unitAt(x, y);
      if (u) {
        const cls = ['unit'];
        if (u === cur) cls.push('active');
        if (u.status.invis > 0) cls.push('invis');
        if (u.status.stun > 0) cls.push('stunned');
        if (u.status.reflect > 0) cls.push('reflect');
        const teamMark = G.mode === 'team' ? `<i class="team t${u.team}">${u.team ? 'B' : 'A'}</i>` : '';
        inner += `<div class="${cls.join(' ')}" style="--c:${u.color}" title="${u.name}『${u.stand}』 HP ${u.hp}/${u.maxHp}">
          ${u.glyph}${teamMark}<span class="mini-hp"><span style="width:${(u.hp / u.maxHp) * 100}%"></span></span></div>`;
      }
      html += `<div class="cell ${t} ${hl ? 'hl-' + hl : ''}" data-x="${x}" data-y="${y}">${inner}</div>`;
    }
  }
  const board = $('#board');
  board.style.gridTemplateColumns = `repeat(${MAP_W}, var(--cell))`;
  board.innerHTML = html;
  renderSide();
}

function statusText(u) {
  const out = [];
  if (u.status.stun > 0) out.push('<span class="st stun">行動不能</span>');
  if (u.status.invis > 0) out.push('<span class="st invis">透明</span>');
  if (u.status.empower) out.push('<span class="st emp">急所狙い</span>');
  if (u.status.reflect > 0) out.push('<span class="st refl">痛み返し</span>');
  return out.join(' ');
}

function unitCard(u, detailed) {
  const teamTxt = G.mode === 'team' ? `<span class="team t${u.team}">チーム${u.team ? 'B' : 'A'}</span>` : '';
  return `
    <div class="char-name"><span class="glyph" style="background:${u.color}">${u.glyph}</span>
      <div><div>${u.name} ${teamTxt} <small>${u.isCPU ? 'CPU' : `${u.slot + 1}P`}</small></div>
      <div class="stand-name">『${u.stand}』</div></div>
    </div>
    <div class="bar hp"><span style="width:${(u.hp / u.maxHp) * 100}%"></span><em>HP ${u.hp}/${u.maxHp}</em></div>
    <div class="bar gauge ${u.gauge >= 100 ? 'full' : ''}"><span style="width:${u.gauge}%"></span><em>ラッシュ ${u.gauge}/100</em></div>
    <div class="meta">移動${u.move} / 射程${u.range} / 攻撃${u.dmg} / 命中${u.hit}%</div>
    <div class="meta">能力『${u.char.ability.name}』${u.cd > 0 ? `<span class="cd">あと${u.cd}ターン</span>` : '<span class="ready">使用可</span>'}</div>
    ${detailed ? `<p class="ability">${u.char.ability.desc}</p>` : ''}
    <div>${statusText(u)}</div>`;
}

function renderSide() {
  const cur = G.cur && G.cur.unit;
  const shown = UI.inspect && UI.inspect.alive ? UI.inspect : cur;
  $('#current-card').innerHTML = shown ? unitCard(shown, true) : '';
  $('#current-card').style.setProperty('--c', shown ? shown.color : '#888');
  $('#round-label').textContent = `第${G.round}ラウンド`;
  $('#turn-label').innerHTML = cur ? `<b style="color:${cur.color}">${cur.name}</b> のターン` : '';

  const human = isHumanTurn();
  const btns = document.querySelectorAll('#actions button');
  btns.forEach(b => {
    const act = b.dataset.act;
    let ok = human;
    if (human) {
      if (act === 'move') ok = !G.cur.moved;
      if (act === 'attack') ok = !G.cur.acted && attackTargets(cur).length > 0;
      if (act === 'ability') ok = !G.cur.acted && cur.cd <= 0 && abilityTargets(cur).length > 0;
      if (act === 'rush') ok = !G.cur.acted && cur.gauge >= 100 && attackTargets(cur).length > 0;
    }
    b.disabled = !ok;
    b.classList.toggle('on', UI.mode === act);
  });
  if (cur) {
    $('#actions [data-act=ability]').textContent = `能力『${cur.char.ability.name}』`;
  }

  $('#unit-list').innerHTML = G.order.concat(G.units.filter(u => !G.order.includes(u))).map(u =>
    `<div class="unit-row ${u.alive ? '' : 'dead'} ${u === cur ? 'cur' : ''}" data-id="${u.id}" style="--c:${u.color}">
      <span class="glyph sm" style="background:${u.color}">${u.glyph}</span>
      <span class="nm">${u.name}</span>
      <span class="bar hp sm"><span style="width:${(u.hp / u.maxHp) * 100}%"></span></span>
      <span class="hpn">${u.alive ? u.hp : '再起不能'}</span>
    </div>`).join('');
}

function setMode(mode) {
  const u = G.cur && G.cur.unit;
  UI.mode = mode;
  UI.highlights = new Map();
  UI.inspect = null;
  const hint = $('#hint');
  if (!u || !mode) { hint.textContent = ''; render(); return; }

  if (mode === 'move') {
    const reach = reachable(u);
    for (const k of reach.dist.keys()) if (k !== `${u.x},${u.y}`) UI.highlights.set(k, 'move');
    hint.textContent = '移動先のマスを選んでください。';
  } else if (mode === 'attack' || mode === 'rush') {
    for (const t of attackTargets(u)) UI.highlights.set(`${t.x},${t.y}`, 'attack');
    hint.textContent = mode === 'rush' ? 'ラッシュを叩き込む相手を選んでください。' : '攻撃する相手を選んでください。';
  } else if (mode === 'ability') {
    for (const p of abilityTargets(u)) UI.highlights.set(`${p.x},${p.y}`, 'ability');
    hint.textContent = `『${u.char.ability.name}』の対象マスを選んでください。`;
  }
  render();
}

function defaultMode() {
  if (!isHumanTurn()) return setMode(null);
  if (!G.cur.moved) return setMode('move');
  setMode(null);
  $('#hint').textContent = '行動を選ぶか、ターンを終了してください。';
}

async function onCellClick(e) {
  const cell = e.target.closest('.cell');
  if (!cell || !G) return;
  const x = Number(cell.dataset.x), y = Number(cell.dataset.y);
  const key = `${x},${y}`;

  if (!isHumanTurn() || !UI.mode || !UI.highlights.has(key)) {
    const u = unitAt(x, y);
    UI.inspect = u;
    renderSide();
    return;
  }

  const u = G.cur.unit;
  const mode = UI.mode;
  UI.busy = true;
  UI.highlights = new Map();
  UI.mode = null;
  render();
  if (mode === 'move') await moveUnit(u, x, y);
  else if (mode === 'attack') await basicAttack(u, unitAt(x, y));
  else if (mode === 'rush') await rushAttack(u, unitAt(x, y));
  else if (mode === 'ability') await useAbility(u, x, y);
  UI.busy = false;

  if (checkGameOver()) return;
  if (!u.alive || (G.cur.moved && G.cur.acted)) {
    await sleep(350);
    await endTurn();
    afterAsync();
    return;
  }
  defaultMode();
}

function afterAsync() {
  if (G && !G.over) defaultMode();
}

async function onActionClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled || !isHumanTurn()) return;
  const act = b.dataset.act;
  if (act === 'end') {
    UI.highlights = new Map();
    UI.mode = null;
    await endTurn();
    afterAsync();
    return;
  }
  setMode(UI.mode === act ? null : act);
}

// ---------- 演出 ----------

FX.render = render;

FX.log = (msg, cls = '') => {
  const log = $('#log');
  const p = document.createElement('p');
  p.className = cls;
  p.innerHTML = msg;
  log.prepend(p);
  while (log.children.length > 80) log.lastChild.remove();
};

FX.float = (x, y, text, cls) => {
  const el = document.createElement('div');
  el.className = `float ${cls}`;
  el.textContent = text;
  el.style.left = `${(x + 0.5) * UI.cell}px`;
  el.style.top = `${(y + 0.3) * UI.cell}px`;
  $('#fx-layer').appendChild(el);
  setTimeout(() => el.remove(), 1100);
};

FX.cutin = async (text, color, big) => {
  const el = $('#cutin');
  el.querySelector('.cutin-text').textContent = `『${text}』${big ? '！！' : '！'}`;
  el.style.setProperty('--c', color);
  el.classList.toggle('big', !!big);
  el.classList.remove('hidden');
  await sleep(big ? 900 : 650);
  el.classList.add('hidden');
};

FX.banner = async (u, sub) => {
  const el = $('#banner');
  el.innerHTML = `<span class="menace">ドドドド</span><span><b style="color:${u.color}">${u.name}</b> のターン${sub ? `<br><small>${sub}</small>` : ''}</span><span class="menace">ドドドド</span>`;
  el.classList.remove('hidden');
  render();
  await sleep(u.isCPU ? 550 : 750);
  el.classList.add('hidden');
};

FX.onGameOver = winners => {
  render();
  const title = $('#gameover-title');
  const body = $('#gameover-body');
  if (!winners.length) {
    title.textContent = '相打ち……！';
    body.textContent = '誰も立っていない。';
  } else if (G.mode === 'team') {
    title.textContent = `チーム${winners[0].team ? 'B' : 'A'} の勝利！`;
    body.innerHTML = winners.map(w => `<b style="color:${w.color}">${w.name}『${w.stand}』</b>`).join('<br>');
  } else {
    const w = winners[0];
    title.innerHTML = `<span style="color:${w.color}">${w.name}</span> の勝利！`;
    body.innerHTML = `スタンド『${w.stand}』 撃破数 ${w.kills}`;
  }
  setTimeout(() => $('#gameover').classList.remove('hidden'), 700);
};

// ---------- 初期化 ----------

function backToTitle() {
  if (G) G.aborted = true;
  $('#battle').classList.add('hidden');
  $('#gameover').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  renderSlots();
}

window.addEventListener('DOMContentLoaded', () => {
  UI.slots = defaultSlots();
  renderSlots();
  $('#slots').addEventListener('change', onSlotChange);
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', renderSlots));
  $('#start-btn').addEventListener('click', startFromSetup);
  $('#board').addEventListener('click', onCellClick);
  $('#board').addEventListener('contextmenu', e => { e.preventDefault(); if (isHumanTurn()) defaultMode(); });
  $('#unit-list').addEventListener('click', e => {
    const row = e.target.closest('.unit-row');
    if (row) { UI.inspect = G.units.find(u => u.id === row.dataset.id); renderSide(); }
  });
  $('#actions').addEventListener('click', onActionClick);
  $('#quit-btn').addEventListener('click', () => { if (confirm('バトルを中断してタイトルに戻りますか？')) backToTitle(); });
  $('#again-btn').addEventListener('click', () => startBattle(UI.lastConfig.slots, UI.lastConfig.mode));
  $('#title-btn').addEventListener('click', backToTitle);
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && isHumanTurn()) defaultMode(); });
  window.addEventListener('resize', () => { if (G && !$('#battle').classList.contains('hidden')) fitBoard(); });
});
