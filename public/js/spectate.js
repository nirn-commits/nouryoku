// 観戦モードを面白くする仕掛け：実況の字幕、見どころを追う自動カメラ、両チームの体力の綱引き、勝敗予想
import { ABILITIES } from './engine/data.js';
import { dist } from './engine/vec.js';

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

// ---------- 自動カメラ：いま一番見どころのある人物を映す ----------
export class Director {
  constructor() {
    this.focus = null;
    this.since = 0;
    this.fixed = null; // 固定するキャラの id（null なら自動）
  }

  // 見どころの点数：最近殴った・殴られた、敵が近い、体力が少ない、能力を構えている
  score(b, c) {
    if (!c.alive) return -1;
    const foes = b.enemiesOf(c).filter(e => e.alive);
    const d = foes.length ? Math.min(...foes.map(e => dist(c.x, c.y, e.x, e.y))) : 50;
    let s = Math.max(0, 12 - d);
    s += Math.max(0, 6 - (b.t - c.lastDamagedAt)) * 2;
    s += (1 - c.hp / c.maxHp) * 4;
    if (c.windup) s += 4;
    if (b.isAirborne(c) || c.launch) s += 6;
    return s;
  }

  viewer(b) {
    if (this.fixed) {
      const c = b.chars.find(x => x.id === this.fixed);
      if (c && c.alive) return c;
      this.fixed = null;
    }
    const cur = this.focus && b.chars.find(x => x.id === this.focus);
    const best = [...b.chars].sort((p, q) => this.score(b, q) - this.score(b, p))[0];
    // 切り替えすぎないよう、最低3.5秒は同じ人を映す（今の人が倒れたら即切り替え）
    if (!cur || !cur.alive || (best !== cur && b.t - this.since > 3.5 && this.score(b, best) > this.score(b, cur) + 3)) {
      this.focus = best.id;
      this.since = b.t;
      return best;
    }
    return cur;
  }

  // カメラボタン：自動 → 1人ずつ固定 → 自動
  cycle(b) {
    const ids = b.chars.filter(c => c.alive).map(c => c.id);
    const i = this.fixed ? ids.indexOf(this.fixed) : -1;
    this.fixed = i + 1 < ids.length ? ids[i + 1] : null;
    return this.fixed ? b.chars.find(c => c.id === this.fixed).name : '自動';
  }
}

// ---------- 実況：戦闘の記録から、見どころを字幕にする ----------
export class Commentator {
  constructor(b) {
    this.b = b;
    this.seen = new WeakSet();
    this.queue = [];
    this.current = null;
    this.shownAt = 0;
    this.lastEventAt = 0;
    this.usedAbility = new Set();
    this.lowHp = new Set();
    this.leader = null;
    this.firstBlood = false;
    this.rng = Math.random;
    this.say('実況', pick(this.rng, ['さあ、戦いの火ぶたが切られた！', '両者、位置についた。どんな戦いになるか！', 'スタンド使い同士の戦い、開始！']), 1);
  }

  say(who, text, pri = 1) {
    // 優先度の低い字幕は詰まっていたら捨てる
    if (this.queue.length > 3 && pri < 2) return;
    this.queue.push({ who, text, pri });
    this.queue.sort((p, q) => q.pri - p.pri);
  }

  name(id) {
    const c = this.b.chars.find(x => x.id === id);
    return c ? c.name : '';
  }

  // 新しい記録を見て字幕を作る
  update() {
    const b = this.b;
    for (const e of b.log) {
      if (this.seen.has(e)) continue;
      this.seen.add(e);
      this.react(e);
    }
    // 形勢逆転（与えたダメージの多い側が入れ替わった）
    const d0 = b.teamDealt(0), d1 = b.teamDealt(1);
    const lead = d0 > d1 + 8 ? 0 : d1 > d0 + 8 ? 1 : this.leader;
    if (lead !== null && this.leader !== null && lead !== this.leader) {
      this.say('実況', pick(this.rng, ['形勢逆転！ 流れが変わった！', 'ここでひっくり返した！ 与えたダメージで逆転！', '追い上げて、ついに逆転！']), 2);
    }
    this.leader = lead;
    // 体力が少なくなった
    for (const c of b.chars) {
      if (c.alive && c.hp < c.maxHp * 0.25 && !this.lowHp.has(c.id)) {
        this.lowHp.add(c.id);
        this.say('実況', pick(this.rng, [`${c.name}、残りの体力がわずか！ 踏ん張れるか！`, `${c.name}は追い詰められた！ あと一撃が命取り！`]), 2);
      }
    }
    // 静かな時間が続いたら、状況を伝える
    if (b.t - this.lastEventAt > 9) {
      this.lastEventAt = b.t;
      this.say('解説', this.situation(), 0);
    }
  }

  react(e) {
    const b = this.b;
    const t = e.text || '';
    const actor = e.actor ? this.name(e.actor) : '';
    let m;
    if (e.kind === 'ko') {
      this.lastEventAt = b.t;
      this.say('実況', pick(this.rng, [`決まったー！ ${t.replace(/ は再起不能.*$/, '')}、再起不能！`, `${t.replace(/ は再起不能.*$/, '')}、ここで力尽きた！`]), 3);
      return;
    }
    if (e.kind === 'damage' && (m = /^(.+?) に(.*?)(\d+)ダメージ/.exec(t))) {
      const dmg = Number(m[3]);
      if (/安全地帯/.test(t)) return;
      if (!this.firstBlood) {
        this.firstBlood = true;
        this.lastEventAt = b.t;
        this.say('実況', `先に当てたのは${actor || '攻撃側'}！ ${m[1]}に${dmg}ダメージ！`, 2);
      } else if (dmg >= 15) {
        this.lastEventAt = b.t;
        this.say('実況', pick(this.rng, [`強烈！ ${m[1]}に${dmg}ダメージ！`, `重い一撃が入った！ ${m[1]}、${dmg}ダメージ！`, `これは効いた！ ${dmg}ダメージ！`]), 2);
      }
      return;
    }
    if (e.kind === 'ability' && e.actor) {
      const c = b.chars.find(x => x.id === e.actor);
      const ab = c && ABILITIES[c.def.abilities[0]];
      if (!ab) return;
      const eff = (m = /『[^』]+』— ([^（！]+)/.exec(t)) ? m[1].slice(0, 26) : '';
      this.lastEventAt = b.t;
      if (!this.usedAbility.has(c.id)) {
        this.usedAbility.add(c.id);
        this.say('実況', `出た！ ${c.name}の『${ab.name}』！`, 2);
        this.say('解説', this.explain(c, ab), 1);
      } else if (eff && this.rng() < 0.35) this.say('実況', `${c.name}、${eff}`, 1);
      return;
    }
    if (/炎が囲む|密室/.test(t) && /成立|囲む/.test(t)) { this.lastEventAt = b.t; this.say('実況', '密室が完成！ ここからは錠二の間合いだ！', 3); return; }
    if (/転んだ|倒れた|叩きつけられた|床が抜け/.test(t) && e.kind === 'combat') { this.lastEventAt = b.t; this.say('実況', pick(this.rng, ['倒れた！ 追い打ちのチャンス！', '足元をすくった！ ここは攻め時！']), 1); return; }
    if (/安全地帯が狭まり始めた/.test(t)) { this.say('実況', '安全地帯が狭まる！ 逃げ場がなくなっていくぞ！', 2); return; }
    if (/サイレン/.test(t)) { this.say('実況', 'サイレンが聞こえてきた！ 警察が来る前に決着をつけられるか！', 2); return; }
    if (e.kind === 'speech' && e.actor && this.rng() < 0.3) { this.say('実況', `${actor}、何か言っている……「${t.replace(/^.*?「/, '').replace(/」.*$/, '').slice(0, 24)}」`, 0); }
  }

  // 能力の解説（最初に使った時だけ）
  explain(c, ab) {
    const short = {
      perpendicular: '触れた面からきっかり10m、直角に弾き出す能力。壁が近いほど危ない',
      hotel: '最後の出口を自分で閉めると、建物が炎の密室になる。中に入ったら要注意',
      echo: '音を集めて運ぶ群体。大きな音を3つ集めて耳元で鳴らされると倒れる',
      seventh: '跳ね返るほど威力が上がる弾。物陰でも安心できない',
      vacant: '手で触れた物を粉にする。足元も、武器も、壁も',
      corvette: '車両が通った所に口を残し、食いしばると全部が噛みつく',
    }[ab.id];
    return short ? `『${ab.name}』は、${short}。` : `『${ab.name}』に注目。`;
  }

  // 静かな時の状況説明
  situation() {
    const b = this.b;
    const alive = b.chars.filter(c => c.alive);
    let best = null;
    for (const a of alive) for (const e of b.enemiesOf(a)) {
      if (!e.alive) continue;
      const d = dist(a.x, a.y, e.x, e.y);
      if (!best || d < best.d) best = { a, e, d };
    }
    if (!best) return '静かな時間が続く。';
    if (best.d > 20) return pick(this.rng, ['お互いの姿はまだ見えていない。どちらが先に見つけるか。', `${best.a.name}と${best.e.name}、まだ距離がある。探り合いの時間だ。`]);
    if (best.d > 8) return `${best.a.name}と${best.e.name}の距離はおよそ${Math.round(best.d)}m。次の一手で動くか。`;
    return `${best.a.name}と${best.e.name}、目と鼻の先！ 一瞬も目が離せない。`;
  }

  // 字幕を1つずつ表示する（最低2.4秒）
  next(now) {
    if (this.current && now - this.shownAt < (this.current.pri >= 2 ? 2600 : 2200)) return null;
    if (!this.queue.length) {
      if (this.current && now - this.shownAt > 4200) { this.current = null; return { clear: true }; }
      return null;
    }
    this.current = this.queue.shift();
    this.shownAt = now;
    return this.current;
  }
}

// ---------- 勝敗予想の成績 ----------
const KEY = 'nouryoku.predict';
export function predictStats() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { hit: 0, total: 0 }; } catch { return { hit: 0, total: 0 }; }
}
export function recordPrediction(hit) {
  const s = predictStats();
  s.total++;
  if (hit) s.hit++;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 保存できない環境 */ }
  return s;
}
