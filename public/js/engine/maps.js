// マップ定義。座標はメートル（x は右・y は下が正、左上が原点）
import { makeRng } from './vec.js';
import { newWorld, addObj, addHouse, addFence } from './world.js';
import { makeItem, resetItemSeq } from './items.js';

function placeItems(world, list, rng) {
  resetItemSeq();
  for (const [kind, x, y, floor = 0] of list) {
    world.items.push(makeItem(kind, x + (rng() - 0.5) * 0.4, y + (rng() - 0.5) * 0.4, floor));
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOP';

// ---------- 空き地（初代の小さなマップ） ----------

function buildLot(seed) {
  const rng = makeRng(seed);
  const world = newWorld(36, 24, seed);
  world.spawns = { player: { x: 2.5, y: 21 }, cpu: { x: 33.5, y: 3 } };

  addHouse(world, {
    id: 'house_left', name: '左の家', aliases: ['左の家'], x: 3, y: 3, w: 10, h: 8, floors: 2,
    openings: [
      { side: 'S', a: 3.5, b: 5.4, type: 'door', id: 'house_left_door', name: '左の家の入口' },
      { side: 'E', a: 3, b: 4.6, type: 'window', id: 'house_left_window', name: '左の家の窓' },
      { side: 'N', a: 6, b: 7.4, type: 'window', id: 'house_left_window_n', name: '左の家の北窓' },
    ],
    stairs: { x: 3.4, y: 3.5, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'E', a: 3, b: 4.6, type: 'window', id: 'house_left_f2_window_e', name: '左の家の2階の東窓' },
        { side: 'S', a: 6, b: 7.5, type: 'window', id: 'house_left_f2_window_s', name: '左の家の2階の南窓' },
        { side: 'N', a: 2, b: 3.5, type: 'window', id: 'house_left_f2_window_n', name: '左の家の2階の北窓' },
      ],
    },
  });
  addObj(world, 'table', { id: 'bed_left', name: '左の家の2階のベッド', floor: 1, x: 9, y: 4, w: 2, h: 1, height: 0.5 });
  addHouse(world, {
    id: 'house_right', name: '右の家', aliases: ['右の家'], x: 23, y: 13, w: 10, h: 8,
    openings: [
      { side: 'N', a: 4.6, b: 6.5, type: 'door', id: 'house_right_door', name: '右の家の入口' },
      { side: 'W', a: 3.4, b: 5, type: 'window', id: 'house_right_window', name: '右の家の窓' },
      { side: 'S', a: 2.5, b: 3.9, type: 'window', id: 'house_right_window_s', name: '右の家の南窓' },
    ],
  });
  addObj(world, 'wall', { id: 'center_wall_1', name: '中央の壁（上）', x: 17.3, y: 8.5, w: 0.5, h: 3 });
  addObj(world, 'wall', { id: 'center_wall_2', name: '中央の壁（下）', x: 17.3, y: 11.5, w: 0.5, h: 3 });
  addObj(world, 'table', { id: 'table_left', name: '左の家の机', x: 6.5, y: 5.5, w: 1.6, h: 0.9 });
  addObj(world, 'table', { id: 'table_right', name: '右の家の机', x: 27, y: 17, w: 1.6, h: 0.9 });

  placeItems(world, [
    ['vase', 5, 8], ['kitchen_knife', 11, 9.5], ['vase', 6, 4.6, 1], ['umbrella', 11, 8, 1],
    ['pan', 30, 15.5], ['bottle', 25, 19.5],
    ['pipe', 16, 20.5], ['brick', 20, 4.5], ['stone', 28.5, 10], ['lumber', 10.5, 13.5], ['stone', 3, 16],
    // 回復アイテム
    ['first_aid', 9, 6], ['drink', 29, 18], ['bandage', 27.5, 16.5, 0], ['onigiri', 18, 12],
  ], rng);
  addObj(world, 'trashcan', { id: 'lot_trash', name: '空き地のゴミ箱', x: 17.5, y: 2.2, w: 0.8, h: 0.8 });
  const crateSpots = [[9, 15], [14, 18], [21, 6], [26, 8], [13, 13], [20.5, 17], [30, 3.5], [5, 19.5]];
  crateSpots.forEach(([cx, cy], i) => {
    addObj(world, 'crate', {
      id: `crate_${LETTERS[i].toLowerCase()}`, name: `木箱${LETTERS[i]}`,
      x: cx + (rng() - 0.5) * 1.6, y: cy + (rng() - 0.5) * 1.6, w: 1, h: 1,
    });
  });
  return world;
}

// ---------- 住宅街（工事現場・コンビニ・公園） 60m × 40m ----------

function buildTown(seed) {
  const rng = makeRng(seed);
  const jitter = (v, r) => v + (rng() - 0.5) * 2 * r;
  const W = 60, H = 40;
  const world = newWorld(W, H, seed);
  world.spawns = { player: { x: 3, y: 21 }, cpu: { x: 57, y: 21 } };

  // 地面（見た目と、AI が場所を指す時の手がかり）
  world.ground.push(
    { kind: 'road', x: 0.5, y: 18, w: W - 1, h: 6 },
    { kind: 'road', x: 28, y: 0.5, w: 6, h: H - 1 },
    { kind: 'crosswalk', x: 26.5, y: 18, w: 1.5, h: 6 },
    { kind: 'crosswalk', x: 34, y: 18, w: 1.5, h: 6 },
    { kind: 'site', x: 34, y: 0.5, w: 25.5, h: 16.5 },
    { kind: 'lot', x: 0.5, y: 24, w: 27.5, h: 15.5 },
    { kind: 'park', x: 48, y: 25, w: 11.5, h: 14.5 },
  );
  world.areas.push(
    { id: 'area_main_road', name: '大通り', x: 0.5, y: 18, w: W - 1, h: 6 },
    { id: 'area_cross_road', name: '南北の道路', x: 28, y: 0.5, w: 6, h: H - 1 },
    { id: 'area_crossing', name: '交差点', x: 28, y: 18, w: 6, h: 6 },
    { id: 'area_site', name: '工事現場', x: 34.3, y: 0.5, w: 25.2, h: 16.2 },
    { id: 'area_store_front', name: 'コンビニの前', x: 0.5, y: 24, w: 18.8, h: 4 },
    { id: 'area_parking', name: 'コンビニの駐車場', x: 19.3, y: 24, w: 8.7, h: 15.5 },
    { id: 'area_park', name: '公園', x: 48, y: 25, w: 11.5, h: 14.5 },
  );

  // ---- 北西：住宅2軒（ブロック塀つき） ----
  addHouse(world, {
    id: 'house_sato', name: '佐藤家', aliases: ['佐藤', '北西の家'], x: 3, y: 3, w: 9, h: 7,
    openings: [
      { side: 'S', a: 3, b: 4.8, type: 'door', id: 'house_sato_door', name: '佐藤家の玄関' },
      { side: 'E', a: 2, b: 3.5, type: 'window', id: 'house_sato_window', name: '佐藤家の東窓' },
      { side: 'N', a: 5, b: 6.5, type: 'window', id: 'house_sato_window_n', name: '佐藤家の北窓' },
    ],
    floors: 2,
    stairs: { x: 10.4, y: 3.4, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'S', a: 1, b: 2.5, type: 'window', id: 'house_sato_f2_window_s', name: '佐藤家の2階の南窓' },
        { side: 'E', a: 4, b: 5.5, type: 'window', id: 'house_sato_f2_window_e', name: '佐藤家の2階の東窓' },
        { side: 'W', a: 2, b: 3.5, type: 'window', id: 'house_sato_f2_window_w', name: '佐藤家の2階の西窓' },
      ],
    },
  });
  addObj(world, 'table', { id: 'bed_sato', name: '佐藤家の2階のベッド', floor: 1, x: 4, y: 7.5, w: 2, h: 1, height: 0.5 });
  addObj(world, 'table', { id: 'table_sato', name: '佐藤家の座卓', x: 5, y: 5, w: 1.6, h: 0.9 });
  addFence(world, { id: 'fence_sato_s', name: '佐藤家の塀・南', x: 0.5, y: 13, len: 13.5, horiz: true, gaps: [[5.5, 8]] });
  addFence(world, { id: 'fence_sato_e', name: '佐藤家の塀・東', x: 14, y: 0.5, len: 12.5, horiz: false });

  addHouse(world, {
    id: 'house_suzuki', name: '鈴木家', aliases: ['鈴木', '北の家'], x: 17, y: 3, w: 9, h: 7,
    openings: [
      { side: 'S', a: 4, b: 5.8, type: 'door', id: 'house_suzuki_door', name: '鈴木家の玄関' },
      { side: 'W', a: 2, b: 3.5, type: 'window', id: 'house_suzuki_window', name: '鈴木家の西窓' },
      { side: 'E', a: 3, b: 4.5, type: 'window', id: 'house_suzuki_window_e', name: '鈴木家の東窓' },
    ],
    floors: 2,
    stairs: { x: 17.4, y: 7.2, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'S', a: 6, b: 7.5, type: 'window', id: 'house_suzuki_f2_window_s', name: '鈴木家の2階の南窓' },
        { side: 'N', a: 2, b: 3.5, type: 'window', id: 'house_suzuki_f2_window_n', name: '鈴木家の2階の北窓' },
        { side: 'E', a: 2, b: 3.5, type: 'window', id: 'house_suzuki_f2_window_e', name: '鈴木家の2階の東窓' },
      ],
    },
  });
  addObj(world, 'table', { id: 'bed_suzuki', name: '鈴木家の2階のベッド', floor: 1, x: 19.5, y: 4, w: 2, h: 1, height: 0.5 });
  addObj(world, 'shelf', { id: 'shelf_suzuki', name: '鈴木家の本棚', x: 23.5, y: 3.6, w: 1.8, h: 0.6 });
  addFence(world, { id: 'fence_suzuki_s', name: '鈴木家の塀・南', x: 15.5, y: 13, len: 12, horiz: true, gaps: [[4.5, 7.5]] });
  addFence(world, { id: 'fence_suzuki_w', name: '鈴木家の塀・西', x: 15.5, y: 0.5, len: 12.5, horiz: false });
  addFence(world, { id: 'fence_suzuki_e', name: '鈴木家の塀・東', x: 27.25, y: 0.5, len: 12.5, horiz: false, gaps: [[5, 7]] });
  addObj(world, 'bush', { id: 'bush_sato', name: '佐藤家の庭の植え込み', x: 9, y: 10.6, w: 4, h: 1.6 });
  addObj(world, 'crate', { id: 'crate_a', name: '木箱A（物置）', x: jitter(2, 0.3), y: jitter(11, 0.3), w: 1, h: 1 });

  // ---- 北東：工事現場（仮囲い・掘削穴・鉄骨・建設中の柱・現場事務所） ----
  addFence(world, { id: 'site_fence_w', name: '工事現場の仮囲い・西', x: 34, y: 0.5, len: 16.5, horiz: false, gaps: [[6, 8]], hp: 30, style: 'panel', t: 0.2 });
  addFence(world, { id: 'site_fence_s', name: '工事現場の仮囲い・南', x: 34, y: 16.8, len: 25.5, horiz: true, gaps: [[6, 10.5]], hp: 30, style: 'panel', t: 0.2 });
  world.areas.push({ id: 'area_site_gate', name: '工事現場のゲート', x: 40, y: 16, w: 4.5, h: 1.6 });
  addObj(world, 'hole', { id: 'site_pit', name: '掘削穴', x: 37.5, y: 2.5, w: 7, h: 6 });
  addObj(world, 'steel', { id: 'site_steel', name: '鉄骨の山', x: 36, y: 11, w: 4.5, h: 1.4 });
  addObj(world, 'steel', { id: 'site_steel_2', name: '積まれた資材', x: 45.5, y: 14.2, w: 3, h: 1.2 });
  [[48, 10], [52, 10], [56, 10], [48, 13.5], [52, 13.5], [56, 13.5]].forEach(([x, y], i) => {
    addObj(world, 'wall', { id: `site_pillar_${i + 1}`, name: `建設中の柱${i + 1}`, x, y, w: 0.7, h: 0.7, hp: 90, style: 'concrete' });
  });
  addHouse(world, {
    id: 'site_office', name: '現場事務所', kind: 'office', aliases: ['事務所', 'プレハブ'], x: 50, y: 2, w: 7.5, h: 5, wallHp: 45,
    openings: [
      { side: 'S', a: 2, b: 3.8, type: 'door', id: 'site_office_door', name: '現場事務所の入口' },
      { side: 'W', a: 1.5, b: 3, type: 'window', id: 'site_office_window', name: '現場事務所の窓' },
    ],
  });
  addObj(world, 'table', { id: 'site_office_desk', name: '事務所の机', x: 53, y: 3, w: 1.6, h: 0.8 });
  world.rubble.push({ kind: 'gravel', name: '土砂の山', x: 45.5, y: 4.5, w: 3, h: 3.5 });
  world.rubble.push({ kind: 'gravel', name: '砂利', x: 35, y: 13, w: 9, h: 3.2 });
  [[46, 9.5], [47.2, 9.7], [jitter(43, 0.5), 13]].forEach(([x, y], i) => {
    addObj(world, 'drum', { id: `drum_${i + 1}`, name: `ドラム缶${i + 1}`, x, y, w: 0.7, h: 0.7 });
  });
  [[41, 15.6], [43.2, 15.6]].forEach(([x, y], i) => {
    addObj(world, 'cone', { id: `cone_${i + 1}`, name: `三角コーン${i + 1}`, x, y, w: 0.45, h: 0.45 });
  });
  addObj(world, 'crate', { id: 'crate_b', name: '木箱B（資材）', x: jitter(57.5, 0.3), y: jitter(15, 0.3), w: 1, h: 1 });

  // ---- 大通り：路上駐車・トラック・電柱 ----
  addObj(world, 'car', { id: 'car_street', name: '路上駐車の車', x: jitter(10, 1), y: 18.7, w: 4.4, h: 1.9 });
  addObj(world, 'car', { id: 'truck_site', name: '工事車両のトラック', x: 40, y: 18.6, w: 6.5, h: 2.3, height: 3 });
  [[8, 17.3], [21, 17.3], [40, 24.3], [53, 24.3], [27.7, 3], [27.3, 32]].forEach(([x, y], i) => {
    addObj(world, 'pole', { id: `pole_${i + 1}`, name: `電柱${i + 1}`, x, y, w: 0.4, h: 0.4 });
  });

  // ---- 南西：コンビニと駐車場 ----
  addHouse(world, {
    id: 'store', name: 'コンビニ', kind: 'store', aliases: ['コンビニ', '店', 'お店', '店内'], x: 4, y: 28, w: 14, h: 8, wallHp: 60,
    openings: [
      { side: 'N', a: 0.4, b: 5, type: 'window', id: 'store_glass_1', name: 'コンビニのガラス窓（西）', hp: 8, fixed: true },
      { side: 'N', a: 5, b: 7, type: 'door', id: 'store_door', name: 'コンビニの入口ドア' },
      { side: 'N', a: 7, b: 13.6, type: 'window', id: 'store_glass_2', name: 'コンビニのガラス窓（東）', hp: 8, fixed: true },
      { side: 'S', a: 10, b: 11.6, type: 'door', id: 'store_backdoor', name: 'コンビニの裏口' },
    ],
  });
  addObj(world, 'shelf', { id: 'store_shelf_1', name: 'コンビニの商品棚1', x: 6, y: 31, w: 5, h: 0.8 });
  addObj(world, 'shelf', { id: 'store_shelf_2', name: 'コンビニの商品棚2', x: 6, y: 33.5, w: 5, h: 0.8 });
  addObj(world, 'shelf', { id: 'store_shelf_3', name: 'コンビニの飲料棚', x: 4.5, y: 34.9, w: 0.8, h: 0.8 });
  addObj(world, 'shelf', { id: 'store_shelf_4', name: 'コンビニの雑誌棚', x: 12.5, y: 30.2, w: 0.8, h: 4 });
  addObj(world, 'table', { id: 'store_counter', name: 'レジカウンター（防犯ブザー）', x: 14.5, y: 29.6, w: 3, h: 0.9, mass: 3, buzzer: true });
  addObj(world, 'vending', { id: 'vending_1', name: '自動販売機1', x: 18.4, y: 31.5, w: 0.8, h: 1 });
  addObj(world, 'vending', { id: 'vending_2', name: '自動販売機2', x: 18.4, y: 32.7, w: 0.8, h: 1 });
  addObj(world, 'crate', { id: 'crate_c', name: '木箱C（ゴミ置き場）', x: 16, y: 36.8, w: 1.2, h: 1 });
  addObj(world, 'car', { id: 'car_park_1', name: '駐車場の車1', x: 20.5, y: jitter(30, 0.5), w: 1.9, h: 4.4 });
  addObj(world, 'car', { id: 'car_park_2', name: '駐車場の車2', x: 24.2, y: jitter(32, 1), w: 1.9, h: 4.4 });
  addObj(world, 'cone', { id: 'cone_3', name: '三角コーン3', x: 26.5, y: 25.5, w: 0.45, h: 0.45 });

  // ---- 南東：高橋家・公園・公衆トイレ ----
  addHouse(world, {
    id: 'house_takahashi', name: '高橋家', aliases: ['高橋', '南東の家'], x: 36, y: 30, w: 9, h: 7,
    openings: [
      { side: 'N', a: 3, b: 4.8, type: 'door', id: 'house_takahashi_door', name: '高橋家の玄関' },
      { side: 'E', a: 2, b: 3.5, type: 'window', id: 'house_takahashi_window', name: '高橋家の東窓' },
      { side: 'S', a: 5, b: 6.5, type: 'window', id: 'house_takahashi_window_s', name: '高橋家の南窓' },
    ],
    floors: 2,
    stairs: { x: 43.4, y: 34.2, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'N', a: 5, b: 6.5, type: 'window', id: 'house_takahashi_f2_window_n', name: '高橋家の2階の北窓' },
        { side: 'W', a: 2, b: 3.5, type: 'window', id: 'house_takahashi_f2_window_w', name: '高橋家の2階の西窓' },
        { side: 'S', a: 2, b: 3.5, type: 'window', id: 'house_takahashi_f2_window_s', name: '高橋家の2階の南窓' },
      ],
    },
  });
  addObj(world, 'table', { id: 'bed_takahashi', name: '高橋家の2階のベッド', floor: 1, x: 37, y: 31, w: 2, h: 1, height: 0.5 });
  addObj(world, 'table', { id: 'table_takahashi', name: '高橋家の食卓', x: 41, y: 33, w: 1.6, h: 0.9 });
  addFence(world, { id: 'fence_taka_n', name: '高橋家の塀・北', x: 34.3, y: 27, len: 12.7, horiz: true, gaps: [[4, 7]] });
  addFence(world, { id: 'fence_taka_w', name: '高橋家の塀・西', x: 34.3, y: 27, len: 12.5, horiz: false });
  addFence(world, { id: 'fence_taka_e', name: '高橋家の塀・東', x: 46.8, y: 27, len: 12.5, horiz: false, gaps: [[8, 10]] });

  addObj(world, 'bush', { id: 'bush_park_1', name: '公園の植え込み（北）', x: 49.5, y: 26, w: 4, h: 1.8 });
  addObj(world, 'bush', { id: 'bush_park_2', name: '公園の植え込み（東）', x: 55.5, y: 31, w: 3, h: 3.5 });
  addObj(world, 'bush', { id: 'bush_park_3', name: '公園の植え込み（南）', x: 49, y: 37, w: 4.5, h: 1.6 });
  [[51, 31.5], [57, 27.5], [53.8, 35.5]].forEach(([x, y], i) => {
    addObj(world, 'tree', { id: `tree_${i + 1}`, name: `公園の木${i + 1}`, x, y, w: 0.9, h: 0.9 });
  });
  addObj(world, 'table', { id: 'park_bench', name: '公園のベンチ', x: 52.5, y: 29, w: 2, h: 0.6, mass: 2 });
  addHouse(world, {
    id: 'park_toilet', name: '公衆トイレ', kind: 'toilet', aliases: ['トイレ'], x: 56, y: 36.3, w: 3.5, h: 3.2,
    openings: [{ side: 'W', a: 1, b: 2.6, type: 'door', id: 'park_toilet_door', name: '公衆トイレの入口' }],
  });
  addObj(world, 'crate', { id: 'crate_d', name: '木箱D', x: jitter(31, 1), y: jitter(30, 2), w: 1, h: 1 });

  // 拾って武器にできる物
  placeItems(world, [
    ['vase', 5.5, 4.4], ['kitchen_knife', 9.5, 8.8], ['vase', 8, 4.6, 1],
    ['pan', 19.5, 8.6], ['vase', 24.5, 6.5], ['umbrella', 23, 7.5, 1],
    ['kitchen_knife', 38.5, 35.5], ['vase', 43, 31.6], ['bottle', 42, 35.4, 1],
    ['bottle', 8.2, 32.4], ['bottle', 9, 34.9], ['umbrella', 16.5, 34.6], ['extinguisher', 4.8, 29],
    ['pipe', 38, 14.6], ['brick', 41.5, 10.4], ['wrench', 54.5, 5.5], ['lumber', 46, 12.6], ['brick', 36.5, 10],
    ['stone', 51.5, 34.3], ['branch', 55.5, 29.6], ['stone', 50.5, 29], ['bottle', 26, 17.4], ['stone', 33, 26.5],
    // 回復アイテム：コンビニの棚まわり・各家の救急箱・現場事務所の包帯
    ['onigiri', 7, 32.3], ['onigiri', 9.5, 32.3], ['drink', 5.2, 34.2], ['drink', 13.4, 33.2],
    ['first_aid', 6.5, 5.5], ['first_aid', 26, 5.5, 1], ['first_aid', 41, 33.5], ['bandage', 54.5, 4.2], ['bandage', 57.5, 38],
  ], rng);
  // 干渉できる物
  addObj(world, 'fountain', { id: 'park_fountain', name: '公園の水飲み場', x: 51, y: 33, w: 0.8, h: 0.8 });
  addObj(world, 'generator', { id: 'site_generator', name: '工事現場の発電機', x: 49.5, y: 11.5, w: 1.6, h: 1 });
  addObj(world, 'trashcan', { id: 'trash_store', name: 'コンビニ前のゴミ箱', x: 18.6, y: 26.6, w: 0.8, h: 0.8 });
  addObj(world, 'trashcan', { id: 'trash_park', name: '公園のゴミ箱', x: 49.2, y: 29.5, w: 0.8, h: 0.8 });
  addObj(world, 'trashcan', { id: 'trash_street', name: '路地のゴミ箱', x: 33.2, y: 23.6, w: 0.8, h: 0.8 });
  return world;
}

export const MAPS = {
  town: { id: 'town', name: '住宅街', desc: '工事現場・コンビニ・公園のある住宅街（60m×40m）。植え込みに隠れたり、車の防犯アラームで気を引いたりできる。', build: buildTown },
  lot: { id: 'lot', name: '空き地', desc: '2軒の家と木箱が並ぶ小さな空き地（36m×24m）。すぐに接敵する短期決戦向け。', build: buildLot },
};

export function createWorld(seed = Date.now(), mapId = 'town') {
  return (MAPS[mapId] || MAPS.town).build(seed);
}
