// 戦場に落ちている、拾って武器にできる物。1人1つまで持てる
// melee：持って殴った時の威力（素手・スタンドの拳より強ければこちら）、throw：投げた時の威力、reach：殴る届く距離の上乗せ
export const ITEM_KINDS = {
  vase: { name: '花瓶', melee: 11, throw: 12, reach: 0, kg: 2, breaks: true },
  bottle: { name: '瓶', melee: 9, throw: 9, reach: 0, kg: 0.6, breaks: true },
  kitchen_knife: { name: '包丁', melee: 14, throw: 12, reach: 0.2, kg: 0.3 },
  pan: { name: 'フライパン', melee: 12, throw: 9, reach: 0.2, kg: 1.5 },
  pipe: { name: '鉄パイプ', melee: 16, throw: 10, reach: 0.7, kg: 3 },
  brick: { name: 'レンガ', melee: 13, throw: 14, reach: 0, kg: 2.5 },
  wrench: { name: 'スパナ', melee: 12, throw: 11, reach: 0.2, kg: 1 },
  lumber: { name: '角材', melee: 14, throw: 8, reach: 0.8, kg: 3 },
  umbrella: { name: '傘', melee: 7, throw: 6, reach: 0.8, kg: 0.5 },
  extinguisher: { name: '消火器', melee: 15, throw: 13, reach: 0.1, kg: 6 },
  stone: { name: '石', melee: 9, throw: 10, reach: 0, kg: 0.8 },
  branch: { name: '木の枝', melee: 8, throw: 6, reach: 0.6, kg: 0.7 },
};

// 文中の言い方 → 種類
export const ITEM_WORDS = [
  [/花瓶/, 'vase'], [/瓶|ビン|ボトル/, 'bottle'], [/包丁|ナイフ|刃物/, 'kitchen_knife'], [/フライパン|鍋/, 'pan'],
  [/鉄パイプ|パイプ/, 'pipe'], [/レンガ|煉瓦|ブロック片/, 'brick'], [/スパナ|レンチ|工具/, 'wrench'], [/角材|木材|棒/, 'lumber'],
  [/傘/, 'umbrella'], [/消火器/, 'extinguisher'], [/石|小石/, 'stone'], [/枝/, 'branch'],
];

let itemSeq = 0;

export function resetItemSeq() {
  itemSeq = 0;
}

export function makeItem(kind, x, y, floor = 0, extra = {}) {
  const k = ITEM_KINDS[kind];
  return { id: `item_${kind}_${++itemSeq}`, kind, name: k.name, x, y, floor, ...extra };
}

export function itemDef(item) {
  return item ? ITEM_KINDS[item.kind] : null;
}

// 武器の威力は振るう人の腕力で変わる（破壊力の低い七海・鷺沼は鉄パイプでも半分程度、十河は7割強、錠二は1倍強）
export function strengthScale(c) {
  return Math.min(1.15, Math.max(0.5, 0.3 + c.def.power / 25));
}

// その人が持って殴った時の威力
export function meleeWith(c, kind) {
  return Math.round(ITEM_KINDS[kind].melee * strengthScale(c));
}
