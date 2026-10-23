// 観戦モード：見どころのある人物を追う自動カメラ
import { dist } from './engine/vec.js';

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
