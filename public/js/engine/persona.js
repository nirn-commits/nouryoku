// CPU の「人となり」：キャラクターごとの性格（作戦の選び方の癖）と、その場の気分、状況に合わせたセリフ。
// 作戦そのものは先読み（lookahead.js）で選び、ここではその採点の重みと、口にする言葉を決める
import { dist } from './vec.js';

// 性格：攻め気（与えるダメージの重み）／用心深さ（受けるダメージの重み）／博打好き（最悪の場合をどれだけ気にしないか）／口数
export const PERSONA = {
  sogo: { aggression: 1.0, caution: 1.2, gamble: 0.4, chatter: 0.45 },
  kito: { aggression: 1.35, caution: 0.9, gamble: 0.5, chatter: 0.3 },
  nanami: { aggression: 0.9, caution: 1.5, gamble: 0.3, chatter: 0.15 },
  saginuma: { aggression: 1.05, caution: 1.1, gamble: 0.8, chatter: 0.4 },
  saragiin: { aggression: 1.0, caution: 1.15, gamble: 0.55, chatter: 0.75 },
  mikuriya: { aggression: 1.0, caution: 1.3, gamble: 0.4, chatter: 0.2 },
};
const DEFAULT = { aggression: 1, caution: 1.2, gamble: 0.5, chatter: 0.35 };

// 場面ごとのセリフ（1人で言い切る一言。掛け合いにはしない）
const LINES = {
  sogo: {
    spot: ['いた。距離{d}m', '見つけた。角度よし', '{e}か。計算に入れとく'],
    hit: ['入った。誤差なし', '9.8m毎秒毎秒、落ちる速さも計算済みだ', '面があれば十分だ'],
    hurt: ['……今のは計算外だ', 'ちっ、角度が甘かった', '痛ぇな。帳尻は合わせる'],
    low: ['残り少ねえ。開けた所は避ける', '分が悪い。引く', 'ここで無理する数字じゃない'],
    winning: ['数字は嘘をつかない', 'このまま押し切る', '有利な地形だ。動くなよ'],
    losing: ['巻き返す。壁はまだある', '計算し直しだ'],
    hunting: ['どこ行った……', '足音、どっちだ', '近くの壁は3枚。隠れるならそこだ'],
    ability: ['直角に、10m', '弾くぞ', 'その面、借りる'],
    downed: ['寝てろ', '今だ'],
  },
  kito: {
    spot: ['……いたな', '逃げるな', '見つけた'],
    hit: ['まだだ', '立て', '話はそれからだ'],
    hurt: ['……効かねえ', 'それだけか', '悪くない'],
    low: ['……まだ終わってねえ', 'ここからだ'],
    winning: ['終わりだ', '言い訳は聞かない'],
    losing: ['……面白え', '次で取り返す'],
    hunting: ['どこだ', '出てこい', '隠れても無駄だ'],
    ability: ['閉めるぞ', '入れ', '逃げ道はない'],
    downed: ['起きろ', '寝るには早い'],
  },
  nanami: {
    spot: ['……見つけました', 'その足音、覚えました'],
    hit: ['……お静かに', '音は嘘をつきませんから'],
    hurt: ['……っ', '乱暴な音'],
    low: ['……潮時ですね', '少し、離れます'],
    winning: ['聞こえていますよ、全部'],
    losing: ['……うるさい'],
    hunting: ['……どこにいても、音はします'],
    ability: ['響かせます', '……どうぞ、耳を澄ませて'],
    downed: ['そのまま、静かに'],
  },
  saginuma: {
    spot: ['いい角度だ', '賭けましょうか', '見つけましたよ'],
    hit: ['当たり、ですね', '何回跳ねたか、分かりました？', '今日はツイてる'],
    hurt: ['……外れか', 'これだから賭けはやめられない', '痛いな'],
    low: ['……来週には必ず', 'ここは降りておきます'],
    winning: ['勝ち越し、ですね', 'まだ張れますよ'],
    losing: ['負けを取り返すのは、得意なんです', '次の一枚で全部戻す'],
    hunting: ['さて、どこに隠れたかな', '壁の向こうも、射程のうちです'],
    ability: ['……さて、何回跳ねるかな', '7回目は外れたことがないんですよ', '張りますよ'],
    downed: ['ご愁傷様'],
  },
  saragiin: {
    spot: ['あ、{e}じゃん！ 前世から知ってる気がするんだよね', 'みーつけた。あだ名つけていい？', '{e}、元気？ 誕生日いつ？'],
    hit: ['ごめんごめん、床が勝手に崩れちゃって', 'あ、そこもう床じゃないよ', 'その顔、明日の放送で流しとくね'],
    hurt: ['いったぁ……ひどくない？', 'ちょっと、そういうのはナシでしょ', 'え、本気？'],
    low: ['ちょっとタイム！ ……ダメ？', 'そんなに怖い顔しないでよ'],
    winning: ['今日の放送のネタ、決まりだね', '仲良くしようよ、ね？'],
    losing: ['まだまだ、話はこれからだって', '秘密、ひとつ教えてあげようか？'],
    hunting: ['かくれんぼ？ 得意なんだよね', 'どこ行ったのー？'],
    ability: ['ちょっと触るね', 'さらさら〜', 'ほら、元に戻せるから大丈夫'],
    downed: ['あらら、大丈夫？', '手、貸そうか？ 粉だけど'],
  },
  mikuriya: {
    spot: ['……いた', '見つけた。動かないで'],
    hit: ['……噛んだ', '離さない'],
    hurt: ['……痛い', 'うるさい手'],
    low: ['お腹すいた……', '……今は食べられない'],
    winning: ['……その話、三回目', 'もう終わり？'],
    losing: ['……まだ口はある'],
    hunting: ['……どこ', '車、走らせる'],
    ability: ['……行って', 'そこ、通ると噛むよ'],
    downed: ['……ふうん'],
  },
};

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

export function personaOf(c) {
  return PERSONA[c.charId] || DEFAULT;
}

// 今の気分：体力の差・直前の被弾・敵が見えているか
export function moodOf(b, c) {
  const pe = b.perceivedEnemy(c);
  const e = pe && pe.char;
  const me = c.hp / c.maxHp;
  if (me < 0.3) return 'desperate';
  if (!pe || !pe.visible) return 'hunting';
  const them = e ? e.hp / e.maxHp : 1;
  if (me - them > 0.25) return 'confident';
  if (them - me > 0.25) return 'pressed';
  return 'even';
}

// 先読みの採点の重み（性格 × 気分）
export function scoreWeights(b, c) {
  const p = personaOf(c);
  const mood = moodOf(b, c);
  let dealt = p.aggression, taken = p.caution, gamble = p.gamble;
  if (mood === 'confident') { dealt *= 1.1; gamble += 0.1; }
  if (mood === 'pressed') { taken *= 1.1; }
  if (mood === 'desperate') {
    // 追い詰められた時：攻め気の強い者は捨て身に、用心深い者は逃げに傾く
    if (p.aggression >= 1.2) { dealt *= 1.3; taken *= 0.8; gamble += 0.2; } else { taken *= 1.35; }
  }
  return { dealt, taken, gamble: Math.min(0.9, gamble), mood };
}

// 前のターンから何が起きたか（セリフのきっかけ）
function events(b, c) {
  const m = c.aiMem || (c.aiMem = { dealt: 0, hp: c.hp, visible: false, lastLine: -99, recent: [] });
  const pe = b.perceivedEnemy(c);
  const ev = {
    dealt: (c.dealt || 0) - m.dealt,
    hurt: m.hp - c.hp,
    spotted: !!(pe && pe.visible && !m.visible),
    enemy: pe && pe.char,
    d: pe ? dist(c.x, c.y, pe.x, pe.y) : 99,
    downed: !!(pe && pe.visible && pe.char && (pe.char.status.proneUntil > b.t || pe.char.status.stunUntil > b.t)),
  };
  m.dealt = c.dealt || 0;
  m.hp = c.hp;
  m.visible = !!(pe && pe.visible);
  return ev;
}

// 計画に合わせた一言を選ぶ（言わない方がいい時は null）
export function chooseLine(b, c, plan) {
  const ev = events(b, c);
  const bank = LINES[c.charId];
  if (!bank || !plan || !plan.steps) return null;
  const steps = plan.steps;
  // 潜む・隠れる計画の時は黙る（声で居場所がばれる）。食いしばっている間は喋れない
  if (steps.some(s => s.action === 'hide' || (s.action === 'ability' && s.effect === 'silence_self'))) return null;
  if (c.clench || steps.some(s => s.ability === 'corvette' && s.effect === 'bite')) return null;
  const p = personaOf(c);
  const mood = moodOf(b, c);
  let key = null, chance = p.chatter;
  if (ev.spotted) { key = 'spot'; chance += 0.35; }
  else if (ev.hurt >= 15) { key = 'hurt'; chance += 0.3; }
  else if (ev.dealt >= 15) { key = 'hit'; chance += 0.25; }
  else if (ev.downed) { key = 'downed'; chance += 0.2; }
  else if (mood === 'desperate') { key = 'low'; chance += 0.2; }
  else if (steps.some(s => s.action === 'ability')) key = 'ability';
  else if (mood === 'confident') key = 'winning';
  else if (mood === 'pressed') key = 'losing';
  else if (mood === 'hunting') { key = 'hunting'; chance *= 0.5; }
  if (!key || !bank[key]) return null;
  const m = c.aiMem;
  // 喋りすぎない：前の一言から少し間を置き、同じセリフは続けない
  if (b.t - m.lastLine < 4 || b.rng() > Math.min(0.95, chance)) return null;
  const options = bank[key].filter(l => !m.recent.includes(l));
  const raw = pick(b.rng, options.length ? options : bank[key]);
  m.recent = [raw, ...m.recent].slice(0, 6);
  m.lastLine = b.t;
  return { text: raw.replace('{e}', ev.enemy ? ev.enemy.name.split(/\s+/).pop() : '').replace('{d}', ev.d < 99 ? ev.d.toFixed(1) : '?'), key, mood };
}

// ターンの途中の思わず出る一言（強く殴られた・強く殴った時）。CPU だけ、喋りすぎないよう間を空ける
export function blurt(b, c, key) {
  if (b.isSim || !c.isCPU || !c.alive || c.clench || c.status.hideUntil > b.t) return null;
  const bank = LINES[c.charId];
  if (!bank || !bank[key]) return null;
  const m = c.aiMem || (c.aiMem = { dealt: c.dealt || 0, hp: c.hp, visible: false, lastLine: -99, recent: [] });
  if (b.t - m.lastLine < 5 || b.rng() > personaOf(c).chatter + 0.15) return null;
  const options = bank[key].filter(l => !m.recent.includes(l) && !l.includes('{'));
  if (!options.length) return null;
  const text = pick(b.rng, options);
  m.recent = [text, ...m.recent].slice(0, 6);
  m.lastLine = b.t;
  return text;
}
