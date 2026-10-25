// キャラクターの登録：JSON で書かれたキャラクターを検証して、ゲームに組み込む。
// 書式は docs/character-format.md、ひな形は public/characters/_template.json
import { CHARACTERS, ABILITIES } from './data.js';
import { GENERIC_PARTS } from './generic.js';

const TARGETS = ['enemy', 'ally', 'self', 'point', 'direction', 'object', 'none'];
const SHAPES = ['single', 'circle', 'cone', 'line', 'self'];
const STATUSES = ['stun', 'prone', 'slow', 'deaf', 'invuln', 'guard', 'hide'];
const ZONES = ['hazard', 'slow', 'smoke', 'caltrops', 'silence'];
const ROLES = ['melee', 'mid', 'ranged'];
const SITUATIONS = ['spot', 'hit', 'hurt', 'low', 'winning', 'losing', 'hunting', 'ability', 'downed'];

const num = (v, d, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

// 部品の検証（間違いは日本語で返す）
function checkParts(parts, where, errors) {
  if (!Array.isArray(parts) || !parts.length) { errors.push(`${where}：do（効果の部品）が1つも無い`); return; }
  parts.forEach((p, i) => {
    const at = `${where}.do[${i}]`;
    if (!p || !GENERIC_PARTS.includes(p.type)) { errors.push(`${at}：type「${p && p.type}」は使えない（${GENERIC_PARTS.join('・')}）`); return; }
    if (p.type === 'damage' && !(p.amount > 0)) errors.push(`${at}：damage には amount（ダメージ量）が必要`);
    if (p.type === 'heal' && !(p.amount > 0)) errors.push(`${at}：heal には amount（回復量）が必要`);
    if (p.type === 'status' && !STATUSES.includes(p.status)) errors.push(`${at}：status は ${STATUSES.join('・')} のどれか`);
    if (p.type === 'zone' && p.kind && !ZONES.includes(p.kind)) errors.push(`${at}：zone の kind は ${ZONES.join('・')} のどれか`);
    if (p.type === 'buff' && !['power', 'speed', 'defense'].includes(p.stat)) errors.push(`${at}：buff の stat は power・speed・defense のどれか`);
    if (p.type === 'projectile' && p.onHit) checkParts(p.onHit, `${at}.onHit`, errors);
  });
}

export function validateCharacter(json) {
  const errors = [];
  if (!json || typeof json !== 'object') return ['JSON の中身がオブジェクトではない'];
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(json.id || '')) errors.push('id は半角英小文字で始まる英数字と _（2〜31文字）');
  if (!json.name) errors.push('name（名前）が必要');
  if (json.role && !ROLES.includes(json.role)) errors.push(`role は ${ROLES.join('・')} のどれか`);
  const abs = json.abilities || [];
  if (!Array.isArray(abs) || !abs.length) errors.push('abilities（能力）が1つ以上必要');
  abs.forEach((ab, i) => {
    const where = `abilities[${i}]`;
    if (!ab || !/^[a-z][a-z0-9_]*$/.test(ab.id || '')) errors.push(`${where}：id は半角英小文字の英数字`);
    if (!ab.name) errors.push(`${where}：name が必要`);
    const effs = Object.entries(ab.effects || {});
    if (!effs.length) errors.push(`${where}：effects（技）が1つ以上必要`);
    for (const [k, ed] of effs) {
      const w = `${where}.effects.${k}`;
      if (!/^[a-z][a-z0-9_]*$/.test(k)) errors.push(`${w}：技の id は半角英小文字の英数字`);
      if (!ed.name) errors.push(`${w}：name が必要`);
      if (!Array.isArray(ed.targets) || !ed.targets.length || ed.targets.some(t => !TARGETS.includes(t))) errors.push(`${w}：targets は ${TARGETS.join('・')} から1つ以上`);
      if (ed.hit && ed.hit.shape && !SHAPES.includes(ed.hit.shape)) errors.push(`${w}：hit.shape は ${SHAPES.join('・')} のどれか`);
      checkParts(ed.do, w, errors);
    }
  });
  if (json.situationLines) for (const k of Object.keys(json.situationLines)) if (!SITUATIONS.includes(k)) errors.push(`situationLines の「${k}」は使えない（${SITUATIONS.join('・')}）`);
  return errors;
}

// 検証して登録する。登録した id を返す（間違いがあれば例外）
export function registerCharacter(json, { replace = false } = {}) {
  const errors = validateCharacter(json);
  if (errors.length) {
    const e = new Error(`キャラクター「${json && (json.name || json.id) || '?'}」の書き方に誤りがあります：\n・${errors.join('\n・')}`);
    e.errors = errors;
    throw e;
  }
  if (CHARACTERS[json.id] && !replace) throw new Error(`id「${json.id}」は既に使われています`);
  const power = json.power || {};
  const abilityIds = [];
  for (const ab of json.abilities) {
    const id = `${json.id}__${ab.id}`;
    const effects = {};
    for (const [k, ed] of Object.entries(ab.effects)) {
      effects[k] = {
        name: ed.name, desc: ed.desc || ed.name, targets: ed.targets,
        range: num(ed.range, num(ab.range, 5, 0, 60), 0, 60),
        ...(ed.castTime !== undefined ? { castTime: num(ed.castTime, 0.3, 0, 3) } : {}),
        hit: ed.hit || null, do: ed.do, requires: ed.requires || [],
        text: ed.text || null, observedText: ed.observedText || null, sound: ed.sound,
      };
    }
    ABILITIES[id] = {
      id, generic: true, owner: json.id,
      name: ab.name, desc: ab.desc || ab.name,
      activation: ab.activation || '',
      effects,
      range: num(ab.range, 5, 0, 60), radius: 0, duration: 0,
      castTime: num(ab.castTime, 0.3, 0, 3), cooldown: num(ab.cooldown, 1.5, 0, 30), cost: num(ab.cost, 10, 0, 100),
      recoil: ab.recoil || 'なし',
      weakness: ab.weakness || '',
      vfx: ab.vfx || '',
      soundRadius: num(ab.sound, 6, 0, 40),
      observedHint: ab.observedHint || `敵の能力？：${ab.name}らしき力を使ってきた`,
    };
    abilityIds.push(id);
  }
  const def = {
    id: json.id,
    custom: true,
    name: json.name,
    reading: json.reading || '',
    nickname: json.nickname,
    stand: power.name || json.abilities[0].name, // 能力の総称（スタンド名・流派・魔法の系統など）
    powerLabel: power.label || '能力', // 「スタンド」「魔法」「異能」など、画面での呼び方
    color: json.color || '#cfcfcf',
    role: json.role || 'melee',
    ...(json.role && json.role !== 'melee' ? { keepDistance: num(json.keepDistance, json.role === 'mid' ? 4.5 : 10, 2, 20) } : {}),
    hp: num(json.hp, 100, 20, 300), sp: num(json.sp, 100, 10, 300), spRegen: num(json.spRegen, 6, 0, 30),
    walk: num(json.walk, 3.2, 1, 6), run: num(json.run, 5.7, 2, 9),
    power: num(json.punch, 8, 1, 30), defense: num(json.defense, 1, 0.4, 2),
    kg: num(json.kg, 60, 20, 200),
    ...(json.standRange ? { standRange: num(json.standRange, 2, 0.5, 10) } : {}),
    abilities: abilityIds,
    stats: null,
    profile: json.profile || '',
    personality: json.personality || '',
    lines: Array.isArray(json.lines) && json.lines.length ? json.lines.slice(0, 12) : ['……'],
    persona: json.persona || null,
    situationLines: json.situationLines || null,
    examples: Array.isArray(json.examples) ? json.examples : null,
    chip: json.chip || null,
  };
  CHARACTERS[json.id] = def;
  return json.id;
}

// ブラウザ：public/characters/index.json に並んだファイルを読み込んで登録する
export async function loadCharacterFiles(base = 'characters/') {
  const loaded = [], failed = [];
  let list = [];
  try {
    const res = await fetch(`${base}index.json`, { cache: 'no-store' });
    if (res.ok) list = (await res.json()).characters || [];
  } catch { return { loaded, failed }; }
  for (const file of list) {
    try {
      const res = await fetch(`${base}${file}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`読み込めない（HTTP ${res.status}）`);
      loaded.push(registerCharacter(await res.json(), { replace: true }));
    } catch (e) {
      failed.push({ file, message: e.message });
    }
  }
  return { loaded, failed };
}
