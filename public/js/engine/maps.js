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

// ---------- 駅前（駅・線路・商店街・学校・神社・河川敷） 100m × 70m ----------
// 大人数（5対5・バトルロワイヤル）向けの大きな町。北から、駅とロータリー → 線路（踏切2か所・南口） → 大通り →
// 西に商店街と神社・倉庫、東に学校（校舎・体育館・グラウンド） → 河川敷と川（橋3本）

function buildStation(seed) {
  const rng = makeRng(seed);
  const jitter = (v, r) => v + (rng() - 0.5) * 2 * r;
  const W = 100, H = 70;
  const world = newWorld(W, H, seed);
  world.spawns = { player: { x: 4, y: 20.5 }, cpu: { x: 96, y: 20.5 } };

  world.ground.push(
    { kind: 'parking', x: 26, y: 1, w: 10.5, h: 10.5 },
    { kind: 'plaza', x: 37.5, y: 9.6, w: 27, h: 2.4, edge: true },
    { kind: 'plaza', x: 66, y: 0.5, w: 33.5, h: 11.5 },
    { kind: 'rail', x: 0.5, y: 12.4, w: W - 1, h: 4.2 },
    { kind: 'crosswalk', x: 21, y: 12.4, w: 5, h: 4.2 },
    { kind: 'crosswalk', x: 91, y: 12.4, w: 5, h: 4.2 },
    { kind: 'road', x: 0.5, y: 17.4, w: W - 1, h: 6 },
    { kind: 'road', x: 50, y: 23.4, w: 6, h: 45.6 },
    { kind: 'crosswalk', x: 48.5, y: 17.4, w: 1.5, h: 6 },
    { kind: 'crosswalk', x: 56, y: 17.4, w: 1.5, h: 6 },
    { kind: 'plaza', x: 2, y: 32, w: 44.5, h: 3 },
    { kind: 'park', x: 2, y: 43.5, w: 19, h: 15 },
    { kind: 'parking', x: 37.5, y: 43.5, w: 12, h: 14.5 },
    { kind: 'field', x: 59, y: 43, w: 40, h: 14.5 },
    { kind: 'grass', x: 0.5, y: 58.5, w: W - 1, h: 3 },
    { kind: 'grass', x: 0.5, y: 66.5, w: W - 1, h: 3 },
    { kind: 'plaza', x: 10, y: 61.5, w: 5, h: 5 },
    { kind: 'plaza', x: 86, y: 61.5, w: 5, h: 5 },
  );
  world.areas.push(
    { id: 'area_rotary', name: '駅前ロータリー', x: 66, y: 0.5, w: 33.5, h: 11.5 },
    { id: 'area_platform', name: '駅のホーム', x: 37.5, y: 9.6, w: 27, h: 2.4 },
    { id: 'area_monthly_parking', name: '月極駐車場', x: 26, y: 1, w: 10.5, h: 10.5 },
    { id: 'area_rail', name: '線路', x: 0.5, y: 12.4, w: W - 1, h: 4.2 },
    { id: 'area_crossing_w', name: '西の踏切', x: 21, y: 12.4, w: 5, h: 4.2 },
    { id: 'area_crossing_e', name: '東の踏切', x: 91, y: 12.4, w: 5, h: 4.2 },
    { id: 'area_main_road', name: '大通り', x: 0.5, y: 17.4, w: W - 1, h: 6 },
    { id: 'area_south_road', name: '南口通り', x: 50, y: 23.4, w: 6, h: 38 },
    { id: 'area_arcade', name: '商店街のアーケード', x: 2, y: 32, w: 44.5, h: 3 },
    { id: 'area_shrine', name: '神社の境内', x: 2, y: 43.5, w: 19, h: 15 },
    { id: 'area_coin_parking', name: 'コインパーキング', x: 37.5, y: 43.5, w: 12, h: 14.5 },
    { id: 'area_school_ground', name: '学校のグラウンド', x: 59, y: 43, w: 40, h: 14.5 },
    { id: 'area_riverside_n', name: '河川敷（北岸）', x: 0.5, y: 58.5, w: W - 1, h: 3 },
    { id: 'area_riverside_s', name: '河川敷（南岸）', x: 0.5, y: 66.5, w: W - 1, h: 3 },
    { id: 'area_bridge_w', name: '西の歩道橋', x: 10, y: 61.5, w: 5, h: 5 },
    { id: 'area_bridge_c', name: '南口の橋', x: 50, y: 61.5, w: 6, h: 5 },
    { id: 'area_bridge_e', name: '東の歩道橋', x: 86, y: 61.5, w: 5, h: 5 },
  );

  // ---- 北：住宅2軒・月極駐車場 ----
  addHouse(world, {
    id: 'house_kitamura', name: '北村家', aliases: ['北村', '駅の西の家'], x: 3, y: 1.5, w: 9, h: 7, floors: 2,
    openings: [
      { side: 'S', a: 3, b: 4.8, type: 'door', id: 'house_kitamura_door', name: '北村家の玄関' },
      { side: 'E', a: 2, b: 3.5, type: 'window', id: 'house_kitamura_window', name: '北村家の東窓' },
    ],
    stairs: { x: 10.4, y: 2, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'S', a: 1, b: 2.5, type: 'window', id: 'house_kitamura_f2_window_s', name: '北村家の2階の南窓' },
        { side: 'E', a: 4, b: 5.5, type: 'window', id: 'house_kitamura_f2_window_e', name: '北村家の2階の東窓' },
      ],
    },
  });
  addObj(world, 'table', { id: 'table_kitamura', name: '北村家の座卓', x: 5, y: 4, w: 1.6, h: 0.9 });
  addObj(world, 'table', { id: 'bed_kitamura', name: '北村家の2階のベッド', floor: 1, x: 4, y: 6, w: 2, h: 1, height: 0.5 });
  addHouse(world, {
    id: 'house_nishida', name: '西田家', aliases: ['西田'], x: 14.5, y: 1.5, w: 9, h: 7,
    openings: [
      { side: 'S', a: 4, b: 5.8, type: 'door', id: 'house_nishida_door', name: '西田家の玄関' },
      { side: 'W', a: 2, b: 3.5, type: 'window', id: 'house_nishida_window', name: '西田家の西窓' },
      { side: 'E', a: 3, b: 4.5, type: 'window', id: 'house_nishida_window_e', name: '西田家の東窓' },
    ],
  });
  addObj(world, 'shelf', { id: 'shelf_nishida', name: '西田家のタンス', x: 16, y: 2.2, w: 1.8, h: 0.6 });
  addFence(world, { id: 'fence_houses_s', name: '住宅の塀・南', x: 0.5, y: 10.2, len: 24.5, horiz: true, gaps: [[5, 7.5], [17, 20]] });
  addObj(world, 'bush', { id: 'bush_kitamura', name: '北村家の生け垣', x: 1, y: 9, w: 3.5, h: 1.1 });
  addObj(world, 'car', { id: 'car_monthly_1', name: '月極駐車場の車1', x: 27.2, y: jitter(3, 0.5), w: 1.9, h: 4.4 });
  addObj(world, 'car', { id: 'car_monthly_2', name: '月極駐車場の車2', x: 32.4, y: jitter(5.5, 0.8), w: 1.9, h: 4.4 });

  // ---- 北：駅舎（券売機・改札・売店）とホーム ----
  addHouse(world, {
    id: 'station', name: '駅舎', kind: 'station', aliases: ['駅', '駅舎', '改札'], x: 40, y: 1.2, w: 22, h: 8.2, wallHp: 80,
    openings: [
      { side: 'W', a: 3, b: 5, type: 'door', id: 'station_door_w', name: '駅の西口' },
      { side: 'E', a: 3, b: 5, type: 'door', id: 'station_door_e', name: '駅の東口' },
      { side: 'S', a: 9, b: 13, type: 'door', id: 'station_gate', name: '改札からホームへの出口' },
      { side: 'N', a: 3, b: 6, type: 'window', id: 'station_window_1', name: '駅舎の北窓（西）', hp: 8, fixed: true },
      { side: 'N', a: 16, b: 19, type: 'window', id: 'station_window_2', name: '駅舎の北窓（東）', hp: 8, fixed: true },
    ],
  });
  addObj(world, 'vending', { id: 'ticket_1', name: '券売機1', x: 41, y: 2, w: 0.9, h: 0.8 });
  addObj(world, 'vending', { id: 'ticket_2', name: '券売機2', x: 42.2, y: 2, w: 0.9, h: 0.8 });
  [[45, 6], [47.2, 6], [54.2, 6], [56.4, 6]].forEach(([x, y], i) => {
    addObj(world, 'steel', { id: `gate_${i + 1}`, name: `改札機${i + 1}`, x, y, w: 1.4, h: 0.6, height: 1.0 });
  });
  addObj(world, 'shelf', { id: 'kiosk', name: '駅の売店', x: 58, y: 2, w: 3, h: 1 });
  addObj(world, 'table', { id: 'station_bench', name: '待合室のベンチ', x: 50, y: 2.2, w: 3, h: 0.6, mass: 2 });
  addObj(world, 'table', { id: 'platform_bench_1', name: 'ホームのベンチ1', x: 41, y: 10.2, w: 2.2, h: 0.5, mass: 2 });
  addObj(world, 'table', { id: 'platform_bench_2', name: 'ホームのベンチ2', x: 59, y: 10.2, w: 2.2, h: 0.5, mass: 2 });
  addObj(world, 'vending', { id: 'vending_platform', name: 'ホームの自動販売機', x: 63.2, y: 10, w: 0.8, h: 1 });

  // ---- 北東：駅前ロータリー（バス・タクシー・植え込み） ----
  addObj(world, 'car', { id: 'bus', name: '路線バス', x: 70, y: 3.5, w: 10, h: 2.6, height: 3 });
  addObj(world, 'car', { id: 'taxi_1', name: 'タクシー1', x: jitter(85, 1), y: 7.6, w: 4.4, h: 1.9 });
  addObj(world, 'car', { id: 'taxi_2', name: 'タクシー2', x: jitter(92, 1), y: 7.6, w: 4.4, h: 1.9 });
  addObj(world, 'bush', { id: 'bush_rotary', name: 'ロータリーの植え込み', x: 82, y: 2.5, w: 8, h: 2.5 });
  addObj(world, 'tree', { id: 'tree_rotary_1', name: 'ロータリーの木1', x: 95, y: 2.5, w: 0.9, h: 0.9 });
  addObj(world, 'tree', { id: 'tree_rotary_2', name: 'ロータリーの木2', x: 67.5, y: 9, w: 0.9, h: 0.9 });
  addObj(world, 'table', { id: 'bus_stop_bench', name: 'バス停のベンチ', x: 72, y: 7.5, w: 2, h: 0.6, mass: 2 });
  addObj(world, 'trashcan', { id: 'trash_rotary', name: 'ロータリーのゴミ箱', x: 76, y: 7.6, w: 0.8, h: 0.8 });

  // ---- 線路：両側の柵（踏切2か所・駅のホーム・南口で切れる）と停車中の電車 ----
  addFence(world, { id: 'rail_fence_n', name: '線路の柵・北', x: 0.5, y: 12.1, len: W - 1, horiz: true, gaps: [[20.5, 25.5], [37, 64], [90.5, 95.5]], style: 'panel', hp: 25, t: 0.15 });
  addFence(world, { id: 'rail_fence_s', name: '線路の柵・南', x: 0.5, y: 16.8, len: W - 1, horiz: true, gaps: [[20.5, 25.5], [47.5, 55.5], [90.5, 95.5]], style: 'panel', hp: 25, t: 0.15 });
  world.areas.push({ id: 'area_south_exit', name: '駅の南口', x: 48, y: 16.4, w: 7.5, h: 1.6 });
  addObj(world, 'car', { id: 'train', name: '停車中の電車', x: 66, y: 12.9, w: 23, h: 2.8, height: 3.6 });
  [[20.3, 11.6], [25.7, 11.6], [20.3, 17], [25.7, 17], [90.3, 11.6], [95.7, 11.6], [90.3, 17], [95.7, 17]].forEach(([x, y], i) => {
    addObj(world, 'pole', { id: `crossing_bar_${i + 1}`, name: `踏切の遮断機${i + 1}`, x, y, w: 0.35, h: 0.35 });
  });

  // ---- 大通り：路上の車・トラック・電柱 ----
  addObj(world, 'car', { id: 'car_street_1', name: '路上駐車の車1', x: jitter(10, 1.5), y: 18.2, w: 4.4, h: 1.9 });
  addObj(world, 'car', { id: 'car_street_2', name: '路上駐車の車2', x: jitter(34, 1.5), y: 21.1, w: 4.4, h: 1.9 });
  addObj(world, 'car', { id: 'truck_street', name: '配送のトラック', x: jitter(66, 1.5), y: 20.6, w: 6.5, h: 2.3, height: 3 });
  addObj(world, 'car', { id: 'car_street_3', name: '路上駐車の車3', x: jitter(84, 1.5), y: 18.2, w: 4.4, h: 1.9 });
  [[14, 23.8], [30, 23.8], [46, 23.8], [62, 17.1], [78, 17.1], [56.4, 40], [49.4, 52]].forEach(([x, y], i) => {
    addObj(world, 'pole', { id: `pole_${i + 1}`, name: `電柱${i + 1}`, x, y, w: 0.4, h: 0.4 });
  });

  // ---- 西：商店街（アーケードの両側に小さな店が6軒ずつ。店の間の路地は通れる） ----
  const shopsN = [['greengrocer', '八百屋'], ['bookstore', '本屋'], ['cafe', '喫茶店'], ['diner', '定食屋'], ['clothes', '古着屋'], ['pharmacy', '薬局']];
  const shopsS = [['fishmonger', '魚屋'], ['stationery', '文房具屋'], ['bakery', 'パン屋'], ['barber', '床屋'], ['electric', '電器屋'], ['vacant', '空き店舗']];
  const shopX = [2.5, 10, 17.5, 25, 32.5, 40];
  const shop = (key, label, x, north) => {
    const y = north ? 25.5 : 35;
    const id = `shop_${key}`;
    addHouse(world, {
      id, name: label, kind: 'shop', aliases: [label, '店'], x, y, w: 5.9, h: 6.5, wallHp: 55,
      openings: north
        ? [{ side: 'S', a: 2, b: 3.8, type: 'door', id: `${id}_door`, name: `${label}の入口` }, { side: 'N', a: 2, b: 3.6, type: 'window', id: `${id}_window`, name: `${label}の裏窓` }]
        : [{ side: 'N', a: 2, b: 3.8, type: 'door', id: `${id}_door`, name: `${label}の入口` }, { side: 'S', a: 2.2, b: 3.8, type: 'window', id: `${id}_window`, name: `${label}の裏窓` }],
    });
    addObj(world, key === 'cafe' || key === 'diner' ? 'table' : 'shelf', {
      id: `${id}_furniture`, name: `${label}の${key === 'cafe' || key === 'diner' ? 'テーブル' : '棚'}`,
      x: x + 1, y: north ? y + 1 : y + 4.6, w: key === 'cafe' || key === 'diner' ? 1.6 : 3.6, h: key === 'cafe' || key === 'diner' ? 0.9 : 0.7,
    });
  };
  shopsN.forEach(([k, l], i) => shop(k, l, shopX[i], true));
  shopsS.forEach(([k, l], i) => shop(k, l, shopX[i], false));
  addObj(world, 'vending', { id: 'vending_arcade', name: '商店街の自動販売機', x: 46.6, y: 31.8, w: 0.8, h: 1 });
  addObj(world, 'trashcan', { id: 'trash_arcade', name: '商店街のゴミ箱', x: 16.6, y: 32.3, w: 0.8, h: 0.8 });
  addObj(world, 'crate', { id: 'crate_a', name: '木箱A（八百屋の前）', x: jitter(6, 0.3), y: 32.4, w: 1, h: 1 });
  addObj(world, 'crate', { id: 'crate_b', name: '木箱B（魚屋の発泡箱）', x: jitter(4, 0.3), y: 34, w: 1, h: 0.9 });
  addObj(world, 'cone', { id: 'cone_arcade', name: '三角コーン（商店街の入口）', x: 1.2, y: 33.3, w: 0.45, h: 0.45 });

  // ---- 南西：神社（本殿・鳥居・木立）・倉庫・コインパーキング ----
  addHouse(world, {
    id: 'shrine', name: '神社の本殿', kind: 'shrine', aliases: ['神社', '本殿', 'お社'], x: 7, y: 45, w: 8, h: 6,
    openings: [
      { side: 'S', a: 3, b: 5, type: 'door', id: 'shrine_door', name: '本殿の扉' },
      { side: 'E', a: 2, b: 3.5, type: 'window', id: 'shrine_window', name: '本殿の格子窓' },
    ],
  });
  addObj(world, 'table', { id: 'shrine_box', name: '賽銭箱', x: 10, y: 53, w: 2, h: 0.7, mass: 2.5 });
  addObj(world, 'pole', { id: 'torii_w', name: '鳥居の柱（西）', x: 9.2, y: 56.5, w: 0.5, h: 0.5 });
  addObj(world, 'pole', { id: 'torii_e', name: '鳥居の柱（東）', x: 12.8, y: 56.5, w: 0.5, h: 0.5 });
  [[3.5, 45], [3.5, 50], [4, 55], [18.5, 45.5], [18, 52], [17, 56.5]].forEach(([x, y], i) => {
    addObj(world, 'tree', { id: `tree_shrine_${i + 1}`, name: `境内の木${i + 1}`, x, y, w: 1, h: 1 });
  });
  addObj(world, 'bush', { id: 'bush_shrine_1', name: '境内の植え込み（西）', x: 2.3, y: 52, w: 2.5, h: 2 });
  addObj(world, 'bush', { id: 'bush_shrine_2', name: '境内の植え込み（東）', x: 16, y: 48, w: 3, h: 2.2 });
  addFence(world, { id: 'fence_shrine_e', name: '神社の玉垣・東', x: 21.2, y: 43.5, len: 15, horiz: false, gaps: [[6, 9]], hp: 40 });

  addHouse(world, {
    id: 'warehouse', name: '倉庫', kind: 'warehouse', aliases: ['倉庫'], x: 24, y: 44, w: 12, h: 9, floors: 2, wallHp: 70,
    openings: [
      { side: 'W', a: 3, b: 6, type: 'door', id: 'warehouse_door_w', name: '倉庫の搬入口（西）' },
      { side: 'E', a: 5, b: 7, type: 'door', id: 'warehouse_door_e', name: '倉庫の通用口（東）' },
      { side: 'N', a: 4, b: 5.5, type: 'window', id: 'warehouse_window', name: '倉庫の北窓' },
    ],
    stairs: { x: 34.4, y: 44.5, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'S', a: 2, b: 3.5, type: 'window', id: 'warehouse_f2_window_s', name: '倉庫の2階の南窓' },
        { side: 'W', a: 5, b: 6.5, type: 'window', id: 'warehouse_f2_window_w', name: '倉庫の2階の西窓' },
        { side: 'N', a: 7, b: 8.5, type: 'window', id: 'warehouse_f2_window_n', name: '倉庫の2階の北窓' },
      ],
    },
  });
  [[26, 46], [29.5, 49.5], [26.5, 50.5]].forEach(([x, y], i) => addObj(world, 'crate', { id: `crate_w${i + 1}`, name: `倉庫の木箱${i + 1}`, x: jitter(x, 0.3), y: jitter(y, 0.3), w: 1.2, h: 1.2 }));
  addObj(world, 'shelf', { id: 'warehouse_rack', name: '倉庫の棚', x: 30, y: 45, w: 3.5, h: 0.8 });
  addObj(world, 'crate', { id: 'crate_w_f2', name: '倉庫の2階の木箱', floor: 1, x: 27, y: 47, w: 1.2, h: 1.2 });
  [[1, 'drum'], [2, 'drum']].forEach(([i]) => addObj(world, 'drum', { id: `drum_${i}`, name: `ドラム缶${i}`, x: 36.6 + i * 0.1, y: 47 + i * 1.6, w: 0.7, h: 0.7 }));
  addObj(world, 'car', { id: 'car_coin_1', name: 'コインパーキングの車1', x: 38.6, y: jitter(46, 0.8), w: 1.9, h: 4.4 });
  addObj(world, 'car', { id: 'car_coin_2', name: 'コインパーキングの車2', x: 43.8, y: jitter(51.5, 0.8), w: 1.9, h: 4.4 });
  addObj(world, 'vending', { id: 'vending_coin', name: 'コインパーキングの精算機', x: 48.6, y: 44, w: 0.7, h: 0.7 });

  // ---- 南東：学校（塀・校舎2階建て・体育館・体育倉庫・グラウンド） ----
  addFence(world, { id: 'school_fence_n', name: '学校の塀・北', x: 57.5, y: 24.5, len: 42, horiz: true, gaps: [[8, 13], [36, 39]] });
  addFence(world, { id: 'school_fence_w', name: '学校の塀・西', x: 57.5, y: 24.5, len: 34, horiz: false, gaps: [[20, 24]] });
  addFence(world, { id: 'school_fence_s', name: '学校の塀・南', x: 57.5, y: 58.2, len: 42, horiz: true, gaps: [[27, 31]] });
  world.areas.push({ id: 'area_school_gate', name: '校門', x: 65.5, y: 24, w: 5, h: 1.2 });
  addHouse(world, {
    id: 'school', name: '校舎', kind: 'school', aliases: ['学校', '校舎', '教室'], x: 60, y: 27, w: 22, h: 9, floors: 2, wallHp: 80,
    openings: [
      { side: 'S', a: 3, b: 5, type: 'door', id: 'school_door_w', name: '校舎の昇降口（西）' },
      { side: 'S', a: 16, b: 18, type: 'door', id: 'school_door_e', name: '校舎の昇降口（東）' },
      { side: 'N', a: 2, b: 4, type: 'window', id: 'school_window_1', name: '校舎の北窓1' },
      { side: 'N', a: 10, b: 12, type: 'window', id: 'school_window_2', name: '校舎の北窓2' },
      { side: 'N', a: 18, b: 20, type: 'window', id: 'school_window_3', name: '校舎の北窓3' },
      { side: 'W', a: 3, b: 5, type: 'window', id: 'school_window_w', name: '校舎の西窓' },
    ],
    stairs: { x: 80.4, y: 27.5, w: 1.2, h: 2.4 },
    upper: {
      openings: [
        { side: 'S', a: 2, b: 4, type: 'window', id: 'school_f2_window_s1', name: '校舎の2階の南窓1' },
        { side: 'S', a: 9, b: 11, type: 'window', id: 'school_f2_window_s2', name: '校舎の2階の南窓2' },
        { side: 'S', a: 17, b: 19, type: 'window', id: 'school_f2_window_s3', name: '校舎の2階の南窓3' },
        { side: 'N', a: 6, b: 8, type: 'window', id: 'school_f2_window_n', name: '校舎の2階の北窓' },
        { side: 'W', a: 3, b: 5, type: 'window', id: 'school_f2_window_w', name: '校舎の2階の西窓' },
      ],
    },
  });
  // 教室の机（1階・2階）
  for (const [fl, xs] of [[0, [62, 65, 68, 71, 74]], [1, [62, 66, 70, 74, 77]]]) {
    xs.forEach((x, i) => addObj(world, 'table', { id: `school_desk_${fl}_${i + 1}`, name: `${fl ? '2階の' : ''}教室の机${i + 1}`, floor: fl, x, y: fl ? 31 : 32, w: 1.4, h: 0.8 }));
  }
  addObj(world, 'shelf', { id: 'school_locker', name: '下駄箱', x: 66, y: 34.5, w: 4, h: 0.7 });
  addHouse(world, {
    id: 'gym', name: '体育館', kind: 'gym', aliases: ['体育館'], x: 85, y: 26.5, w: 13, h: 14, wallHp: 80,
    openings: [
      { side: 'W', a: 5, b: 8, type: 'door', id: 'gym_door_w', name: '体育館の入口（西）' },
      { side: 'S', a: 5, b: 8, type: 'door', id: 'gym_door_s', name: '体育館の入口（南）' },
      { side: 'E', a: 4, b: 6, type: 'window', id: 'gym_window_e', name: '体育館の東窓' },
      { side: 'N', a: 3, b: 5, type: 'window', id: 'gym_window_n', name: '体育館の北窓' },
    ],
  });
  addObj(world, 'table', { id: 'gym_stage', name: '体育館の舞台', x: 87, y: 27, w: 9, h: 2, height: 1.0, mass: 9 });
  addObj(world, 'steel', { id: 'gym_basket', name: 'バスケットゴール', x: 90.8, y: 39.4, w: 1.4, h: 0.6, height: 3 });
  addHouse(world, {
    id: 'school_shed', name: '体育倉庫', kind: 'warehouse', aliases: ['体育倉庫'], x: 61, y: 37.5, w: 5, h: 4,
    openings: [{ side: 'E', a: 1.2, b: 2.8, type: 'door', id: 'school_shed_door', name: '体育倉庫の扉' }],
  });
  addObj(world, 'steel', { id: 'goal_w', name: 'サッカーゴール（西）', x: 60, y: 48.5, w: 1, h: 4, height: 2.4 });
  addObj(world, 'steel', { id: 'goal_e', name: 'サッカーゴール（東）', x: 97.5, y: 48.5, w: 1, h: 4, height: 2.4 });
  addObj(world, 'table', { id: 'school_bench', name: 'グラウンドのベンチ', x: 77, y: 42.2, w: 3, h: 0.6, mass: 2 });
  [[84, 42], [99, 57]].forEach(([x, y], i) => addObj(world, 'tree', { id: `tree_school_${i + 1}`, name: `学校の木${i + 1}`, x: x - 1, y: y - 1, w: 0.9, h: 0.9 }));
  addObj(world, 'bush', { id: 'bush_school', name: '校舎前の植え込み', x: 71, y: 36.6, w: 6, h: 1.4 });

  // ---- 南：河川敷と川（橋3本：西の歩道橋・南口の橋・東の歩道橋） ----
  [[0.5, 10], [15, 50], [56, 86], [91, 99.5]].forEach(([x0, x1], i) => {
    addObj(world, 'water', { id: `river_${i + 1}`, name: '川', x: x0, y: 61.5, w: x1 - x0, h: 5 });
  });
  for (const [x0, x1, nm] of [[10, 15, '西の歩道橋'], [50, 56, '南口の橋'], [86, 91, '東の歩道橋']]) {
    addObj(world, 'wall', { id: `rail_${x0}_w`, name: `${nm}の欄干（西）`, x: x0, y: 61.5, w: 0.25, h: 5, style: 'block', height: 1.1, hp: 60 });
    addObj(world, 'wall', { id: `rail_${x0}_e`, name: `${nm}の欄干（東）`, x: x1 - 0.25, y: 61.5, w: 0.25, h: 5, style: 'block', height: 1.1, hp: 60 });
  }
  [[4, 59], [30, 59.2], [44, 67], [70, 67.4], [96, 59.4]].forEach(([x, y], i) => {
    addObj(world, 'bush', { id: `bush_river_${i + 1}`, name: `河川敷の草むら${i + 1}`, x, y, w: 3.5, h: 1.8 });
  });
  addObj(world, 'table', { id: 'river_bench', name: '河川敷のベンチ', x: 22, y: 67.6, w: 2, h: 0.6, mass: 2 });
  addObj(world, 'crate', { id: 'crate_c', name: '木箱C（河川敷の物置）', x: jitter(78, 1), y: jitter(59.6, 0.3), w: 1, h: 1 });

  placeItems(world, [
    // 住宅・駅
    ['vase', 6, 3], ['kitchen_knife', 8, 7], ['umbrella', 9, 3, 1], ['pan', 20, 6], ['bottle', 16, 7],
    ['umbrella', 48, 3], ['bottle', 60, 4], ['drink', 59.5, 4.3], ['onigiri', 58.5, 4.4], ['extinguisher', 41.6, 7.6],
    ['stone', 30, 9.8], ['umbrella', 73, 9], ['bottle', 78, 9.5],
    // 線路・大通り
    ['stone', 8, 14.5], ['stone', 33, 14.5], ['pipe', 60, 15.2], ['brick', 44, 23], ['stone', 75, 23],
    // 商店街
    ['kitchen_knife', 20, 37.5], ['pan', 27, 29], ['bottle', 19, 29.2], ['vase', 12, 29], ['umbrella', 34, 37], ['wrench', 35, 37.4],
    ['lumber', 42, 37], ['extinguisher', 35, 29],
    ['first_aid', 42, 29], ['bandage', 43.5, 29.4], ['drink', 21, 29.4], ['onigiri', 20.5, 37.8], ['onigiri', 4, 29.2],
    // 神社・倉庫・駐車場
    ['branch', 6, 53], ['stone', 15, 55], ['stone', 19, 50], ['pipe', 28, 47.5], ['lumber', 32, 50], ['wrench', 33, 51.5],
    ['brick', 31, 49.5, 1], ['first_aid', 30, 46, 1], ['stone', 47.5, 45.5],
    // 学校
    ['umbrella', 67, 33.5], ['vase', 75, 30, 1], ['first_aid', 79, 33], ['bandage', 63, 40], ['lumber', 64, 39.5],
    ['stone', 70, 46], ['branch', 84, 44], ['drink', 92, 30], ['brick', 95, 34],
    // 河川敷
    ['branch', 8, 60.2], ['stone', 25, 60], ['stone', 60, 68], ['branch', 82, 68.2], ['bottle', 40, 68], ['bandage', 52, 68.4],
  ], rng);
  addObj(world, 'fountain', { id: 'shrine_fountain', name: '神社の手水舎', x: 14, y: 52.5, w: 1.2, h: 0.9 });
  addObj(world, 'fountain', { id: 'school_fountain', name: '学校の水飲み場', x: 83, y: 37, w: 1, h: 0.8 });
  addObj(world, 'generator', { id: 'warehouse_generator', name: '倉庫の発電機', x: 24.5, y: 53.6, w: 1.6, h: 1 });
  addObj(world, 'trashcan', { id: 'trash_road', name: '大通りのゴミ箱', x: 48.4, y: 24, w: 0.8, h: 0.8 });
  return world;
}

export const MAPS = {
  town: { id: 'town', name: '住宅街', desc: '工事現場・コンビニ・公園のある住宅街（60m×40m）。植え込みに隠れたり、車の防犯アラームで気を引いたりできる。', build: buildTown },
  station: { id: 'station', name: '駅前（大型）', desc: '駅とロータリー・線路と踏切・商店街・神社・倉庫・学校・河川敷のある大きな町（100m×70m）。5対5やバトルロワイヤル向け。線路は踏切と南口、川は3本の橋でしか渡れない。', build: buildStation },
  lot: { id: 'lot', name: '空き地', desc: '2軒の家と木箱が並ぶ小さな空き地（36m×24m）。すぐに接敵する短期決戦向け。', build: buildLot },
};

export function createWorld(seed = Date.now(), mapId = 'town') {
  return (MAPS[mapId] || MAPS.town).build(seed);
}
