// Gemini が使えない時のための、キーワードベースの日本語行動解析（簡易版）
// 出力は Gemini と同じ「生の計画」形式。検証は compilePlan が行う
import { ABILITIES } from './data.js';
import { ITEM_WORDS } from './items.js';
import { dist, rectCenter } from './vec.js';

const IMPOSSIBLE = [
  [/時間を止|時を止|時間停止/, '時間を止める能力は存在しない'],
  [/瞬間移動|テレポート|ワープ/, '瞬間移動する能力は存在しない'],
  [/分身/, '分身する能力は存在しない'],
  [/透明に/, '透明になる能力は存在しない'],
  [/空を飛|飛行/, '空を飛ぶ能力は存在しない'],
  [/回復|治療|治す/, '回復手段は存在しない'],
  [/爆発|爆弾|火を|燃や|発火/, '発火・爆発の手段は存在しない'],
];

const COND = [
  [/(近づいて|接近して|近くに)(き|来)たら|間合いに入ったら|寄ってきたら/, () => ({ kind: 'enemy_within', value: 4 })],
  [/(飛んで|投げて)(き|来)たら|物が飛んで|飛来/, () => ({ kind: 'projectile_incoming' })],
  [/(攻撃して|殴りかかって|仕掛けて|殴って)(き|来)たら|構えたら/, () => ({ kind: 'enemy_attacking' })],
  [/(見えたら|現れたら|姿を見せたら|見つけたら|出てきたら)/, () => ({ kind: 'enemy_visible' })],
  [/(見失ったら|隠れたら|消えたら)/, () => ({ kind: 'enemy_not_visible' })],
  [/(ピンチ|体力が.*(減|少な)|HPが.*(減|少な))/, () => ({ kind: 'hp_below', value: 40 })],
  [/(攻撃を受けたら|当たったら|殴られたら|ダメージを受けたら)/, () => ({ kind: 'damaged' })],
];

function nearestBy(list, x, y) {
  let best = null;
  for (const o of list) {
    const c = o.center || rectCenter(o);
    const d = dist(x, y, c.x, c.y);
    if (!best || d < best.d) best = { o, d };
  }
  return best ? best.o : null;
}

function splitClauses(text) {
  return text
    .replace(/(してから|それから|そのあと|その後|その隙に|そして|次に|ながら|つつ)/g, '、')
    // 「〜まで走って投げる」のように移動の後に別の行動が続く場合は分ける
    .replace(/((?:消し|奪っ|走っ|ダッシュし|歩い|駆け寄っ|近づい|追いかけ|追っ|追尾し|尾行し|追跡し|迫っ|移動し|向かっ|行っ|戻っ|下がっ|離れ|回り込ん|詰め|入っ|出)(?:て|で))(?![き来いお])(?=.)/g, '$1、')
    .split(/[、。,.\n!！?？]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 文中の物体の言い方 → 該当する物体の条件
const OBJECT_WORDS = [
  [/自販機|自動販売機/, o => o.kind === 'vending'],
  [/商品棚|本棚|棚/, o => o.kind === 'shelf'],
  [/ドラム缶/, o => o.kind === 'drum'],
  [/コーン/, o => o.kind === 'cone'],
  [/トラック/, o => o.kind === 'car' && /トラック/.test(o.name)],
  [/(?<!駐)車(?!場)|自動車|クルマ/, o => o.kind === 'car'],
  [/鉄骨|資材/, o => o.kind === 'steel'],
  [/掘削穴|穴の(そば|近く|縁|手前)/, o => o.kind === 'hole'],
  [/植え込み|茂み|草むら|生け垣|やぶ/, o => o.kind === 'bush'],
  [/木の(陰|後ろ|裏)|木へ|木まで|木に|樹/, o => o.kind === 'tree'],
  [/電柱/, o => o.kind === 'pole'],
  [/柱/, o => o.id.startsWith('site_pillar')],
  [/レジ|カウンター/, o => o.id === 'store_counter'],
  [/ベンチ/, o => o.id === 'park_bench'],
  [/机|テーブル|座卓|食卓/, o => o.kind === 'table'],
  [/仮囲い|フェンス/, o => o.style === 'panel'],
];

const AREA_WORDS = [
  [/工事現場|現場の中|建設現場/, 'area_site'],
  [/ゲート/, 'area_site_gate'],
  [/公園/, 'area_park'],
  [/駐車場/, 'area_parking'],
  [/コンビニの前|店の前|店先/, 'area_store_front'],
  [/交差点/, 'area_crossing'],
  [/大通り|道路|通り/, 'area_main_road'],
];

const DIR_WORDS = [
  [/左|西/, (o, c) => o.x < c.x], [/右|東/, (o, c) => o.x > c.x],
  [/奥|北|上/, (o, c) => o.y < c.y], [/手前|南|下/, (o, c) => o.y > c.y],
];

function centerOf(o) {
  return o.center || { x: o.x + (o.w || 0) / 2, y: o.y + (o.h || 0) / 2 };
}

function inside(o, bd) {
  const cc = centerOf(o);
  return cc.x >= bd.x && cc.x <= bd.x + bd.w && cc.y >= bd.y && cc.y <= bd.y + bd.h;
}

function findBuildingRef(b, c, clause) {
  const w = b.world;
  // 名前・別名での言及（「コンビニ」「佐藤家」「事務所」など）
  let best = null;
  for (const bd of w.buildings) {
    for (const n of [bd.name, ...(bd.aliases || [])]) {
      if (clause.includes(n) && (!best || n.length > best.len)) best = { bd, len: n.length, name: n };
    }
  }
  if (best) return { ...best.bd, idx: clause.lastIndexOf(best.name), ref: best.bd };
  // 「左の家」「北の建物」など、自分から見た方向での言及
  const m = clause.match(/(左|右|西|東|北|南|奥|手前|上|下)(?:の|側の|手の)(?:家|建物|民家)/);
  const houses = w.buildings.filter(x => x.kind === 'house');
  if (m) {
    const test = DIR_WORDS.find(([re]) => re.test(m[1]))[1];
    const cands = houses.filter(h => test(centerOf(h), c));
    if (cands.length) return { ...nearestBy(cands, c.x, c.y), idx: m.index };
  }
  const g = clause.search(/家|建物|民家|屋内|室内/);
  if (g >= 0) return { ...nearestBy(houses.length ? houses : w.buildings, c.x, c.y), idx: g };
  return null;
}

function findObjectRef(b, c, clause) {
  const w = b.world;
  const pe = b.perceivedEnemy(c);
  const nearEnemy = /敵の(近く|そば|横|後ろ|背後|側)|背後の|後ろの/.test(clause) && pe;
  const ref = nearEnemy ? pe : c;
  const house = findBuildingRef(b, c, clause);
  let area = null;
  for (const [re, id] of AREA_WORDS) {
    const m2 = clause.match(re);
    const a = m2 && w.areas.find(x => x.id === id);
    if (a) { area = { ...a, idx: m2.index }; break; }
  }
  const floorWanted = /2階|二階|２階/.test(clause) ? 1 : /1階|一階|１階/.test(clause) ? 0 : null;
  // 「コンビニの棚」「公園の植え込み」のように場所が添えられていれば、その中の物を優先する
  const pick = list0 => {
    const list = floorWanted === null ? list0 : list0.filter(o => (o.floor ?? 0) === floorWanted).concat(list0.length && !list0.some(o => (o.floor ?? 0) === floorWanted) ? list0 : []);
    if (!list.length) return null;
    for (const place of [house, area]) {
      if (!place) continue;
      const inPlace = list.filter(o => inside(o, place));
      if (inPlace.length) return nearestBy(inPlace, ref.x, ref.y);
    }
    return nearestBy(list, ref.x, ref.y);
  };

  const m = clause.match(/木箱([A-HＡ-Ｈa-h])/);
  if (m) {
    const letter = m[1].normalize('NFKC').toLowerCase();
    const o = b.objectById(`crate_${letter}`);
    if (o) return { type: 'object', id: o.id };
  }
  if (/木箱|箱/.test(clause)) {
    const o = pick(w.objects.filter(x => x.kind === 'crate'));
    if (o) return { type: 'object', id: o.id };
  }
  for (const [re, test] of OBJECT_WORDS) {
    if (!re.test(clause)) continue;
    const o = pick(w.objects.filter(test));
    if (o) return { type: 'object', id: o.id, kind: o.kind };
  }
  if (/階段/.test(clause)) {
    const o = pick(w.objects.filter(x => x.kind === 'stairs'));
    if (o) return { type: 'object', id: o.id };
  }
  if (/窓|ガラス/.test(clause)) {
    const o = pick(w.objects.filter(x => x.kind === 'window'));
    if (o) return { type: 'object', id: o.id };
  }
  if (/入口|扉|ドア|玄関|裏口/.test(clause)) {
    let doors = w.objects.filter(o => o.kind === 'door' && (!house || o.building === house.id));
    if (/裏口/.test(clause) && doors.some(d => /裏口/.test(d.name))) doors = doors.filter(d => /裏口/.test(d.name));
    const d = pick(doors);
    if (d) return { type: 'object', id: d.id };
  }
  if (/中央の壁|真ん中の壁/.test(clause) && b.objectById('center_wall_1')) return { type: 'object', id: 'center_wall_1' };
  if (/壁|塀/.test(clause)) {
    let walls = w.objects.filter(o => o.kind === 'wall' && !o.indestructible);
    if (/塀/.test(clause)) walls = walls.filter(o => o.style === 'block');
    const o = pick(walls);
    if (o) return { type: 'object', id: o.id, wall: true };
  }
  // 「2階へ上がる」「佐藤家の2階」→ 2階の区域。「1階へ降りる」→ 今いる建物の階段（1階側）
  if (floorWanted === 1) {
    const bd2 = (house && house.floors >= 2 ? house : null) || (b.buildingOf(c)?.floors >= 2 ? b.buildingOf(c) : null)
      || nearestBy(w.buildings.filter(x => x.floors >= 2).map(x => ({ ...x, center: { x: x.x + x.w / 2, y: x.y + x.h / 2 } })), c.x, c.y);
    if (bd2 && w.areas.some(a => a.id === `${bd2.id}_2f`)) return { type: 'object', id: `${bd2.id}_2f`, area: true };
  }
  if (floorWanted === 0 && c.floor === 1) {
    const bdc = b.buildingOf(c);
    if (bdc && bdc.stairs) return { type: 'object', id: bdc.stairs.id };
  }
  // 「コンビニの駐車場」のように建物名と区域名が両方ある時は、後ろにある方（文の主語）を採る
  if (house && (!area || house.idx >= area.idx)) return { type: 'object', id: house.id };
  if (area) return { type: 'object', id: area.id, area: true };
  return null;
}

function pointRef(clause) {
  const m = clause.match(/[（(]\s*(-?\d+(?:\.\d+)?)\s*[,、，／]\s*(-?\d+(?:\.\d+)?)\s*[)）]/);
  return m ? { type: 'point', x: Number(m[1]), y: Number(m[2]) } : null;
}

function dirRef(clause) {
  if (/物陰|陰に|隠れ/.test(clause)) return 'cover';
  if (/離れ|逃げ|下が|距離を取|退/.test(clause)) return 'away_from_enemy';
  // 斜め（北＝上・東＝右）
  if (/北東|東北|右上|右斜め上|右奥/.test(clause)) return 'up_right';
  if (/北西|西北|左上|左斜め上|左奥/.test(clause)) return 'up_left';
  if (/南東|東南|右下|右斜め下|右手前/.test(clause)) return 'down_right';
  if (/南西|西南|左下|左斜め下|左手前/.test(clause)) return 'down_left';
  if (/東へ|東に|東側へ/.test(clause)) return 'right';
  if (/西へ|西に|西側へ/.test(clause)) return 'left';
  if (/左へ|左に|左側へ/.test(clause)) return 'left';
  if (/右へ|右に|右側へ/.test(clause)) return 'right';
  if (/奥|上へ|北/.test(clause)) return 'up';
  if (/手前|下へ|南/.test(clause)) return 'down';
  if (/横|脇|サイド/.test(clause)) return 'left';
  return null;
}

function toTarget(ref) {
  if (!ref) return { targetType: 'enemy' };
  if (ref.type === 'object') return { targetType: 'object', targetId: ref.id };
  if (ref.type === 'point') return { targetType: 'point', x: ref.x, y: ref.y };
  return { targetType: 'enemy' };
}

// エコー・ビーチ（灯）・セブンス・サン（玲司）の言い回し
const ECHO_RE = /エコー・ビーチ|エコービーチ|個体|(足音|声|音)を.{0,12}(置|鳴ら|流)|足音を消|音を消|引っか|ひっか|群が|足音を置|音を置|声を置|置いて鳴ら|音を拾|聞き耳|轟音|一斉に|決め技|呼び戻|囮の足音|足音で誘/;
const SEVENTH_RE = /セブンス・サン|跳弾|跳ね返|反射|バウンド|パチンコ玉|玉を弾|弾を弾|撃つ|撃ち|狙撃|三方|3発|三発|回跳/;

// パーペンディキュラー（十河）の言い回し
const PERP_RE = /パーペンディキュラー|垂直|直角|弾き出|弾き飛ば|吹っ飛ば|吹き飛ば|ぶっ飛ば|叩きつけ|叩き付け|跳び上が|飛び上が|真上|壁を蹴|蹴って(跳|飛)|方向転換|能力で(跳|飛|移動|離脱|逃げ)|自分を(弾|飛)|離脱|(10|１０)\s*(m|ｍ|メートル)/;

// 落ちている物への言及（「花瓶」「鉄パイプ」など）→ 一番近いその種類の物
function findItemRef(b, c, clause) {
  for (const [re, kind] of ITEM_WORDS) {
    if (!re.test(clause)) continue;
    const cost = i => dist(c.x, c.y, i.x, i.y) + ((i.floor ?? 0) !== c.floor ? 6 : 0);
    const list = b.world.items.filter(i => i.kind === kind).sort((a, z) => cost(a) - cost(z));
    if (list.length) return list[0];
  }
  return null;
}

function parseClause(b, c, clause, has, ctx = {}) {
  const steps = [];
  const found = findObjectRef(b, c, clause);
  if (found) ctx.lastObj = found;
  // 「木箱に近づいて押し出す」の「押し出す」のように目的語が省かれたら、直前に出てきた物を指す
  const obj = found || (/押|引|壊|殴|叩|弾|閉め|開け/.test(clause) ? ctx.lastObj : null);
  const pt = pointRef(clause);
  const dir = dirRef(clause);
  const run = /走|駆け|急い|ダッシュ|全力|一気|飛び込/.test(clause);
  const mentionsEnemy = /敵|相手|あいつ|奴|やつ/.test(clause);

  // --- スタンドの出し入れ・先行 ---
  if (/スタンド/.test(clause) && !/スタンド(で|の拳)(殴|攻撃|叩)/.test(clause)) {
    if (/スタンドを?(戻|引っ込|しま|消)/.test(clause)) return [{ action: 'stand_in', targetType: 'none' }];
    if (/先行|先に|先へ|前に出|前へ|行かせ|向かわせ|進ませ|覗|偵察|送り|送っ|伸ば|回り込ませ|飛ばし/.test(clause)) {
      const t = pt ? toTarget(pt) : obj ? { targetType: 'object', targetId: obj.id } : mentionsEnemy ? { targetType: 'enemy' } : dir ? { targetType: 'direction', direction: dir === 'cover' ? 'forward' : dir } : { targetType: 'direction', direction: 'forward' };
      return [{ action: 'stand_move', ...t }];
    }
    const m = clause.match(/スタンドを?(出して|出し|出す|発現させ(て)?|構えて)/);
    if (m) {
      const rest = clause.slice(m.index + m[0].length).trim();
      return [{ action: 'stand_out', targetType: 'none' }, ...(rest ? parseClause(b, c, rest, has, ctx) : [])];
    }
  }

  // --- 能力 ---
  if (has.perpendicular && PERP_RE.test(clause)) {
    const held = (/持った物|手の物|手に持/.test(clause) || ITEM_WORDS.some(([re]) => re.test(clause))) && /飛ばす|飛ばし|弾き出|投げ|放つ|撃ち出/.test(clause);
    if (held) {
      steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch_held', ...(pt ? toTarget(pt) : dir && dir !== 'cover' ? { targetType: 'direction', direction: dir } : { targetType: 'enemy' }) });
      return steps;
    }
    if (/方向転換|空中で/.test(clause)) {
      steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'direction', direction: dir && dir !== 'cover' ? dir : 'away_from_enemy' });
      return steps;
    }
    if (/跳び上が|飛び上が|真上|上へ跳|上に跳|壁を蹴|蹴って(跳|飛)|能力で(跳|飛|移動|離脱|逃げ)|弾けて|自分を(弾|飛)|(10|１０)\s*(m|ｍ|メートル)(跳|飛|移動)|離脱/.test(clause)) {
      // 「壁を蹴って」のように特定の壁でなければ、今触れている面を自動で使う
      if (obj && !obj.wall && b.objectById(obj.id)?.blocksMove) steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'object', targetId: obj.id });
      else if (dir && dir !== 'cover' && !/真上|上へ跳|上に跳|跳び上が|飛び上が/.test(clause)) steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'direction', direction: dir });
      else steps.push({ action: 'ability', ability: 'perpendicular', effect: 'self_launch', targetType: 'self' });
      return steps;
    }
    if (obj && b.objectById(obj.id)?.movable && !mentionsEnemy) steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'object', targetId: obj.id });
    else steps.push({ action: 'ability', ability: 'perpendicular', effect: 'launch', targetType: 'enemy' });
    return steps;
  }
  // --- エコー・ビーチ（七海 灯） ---
  if (has.echo && ECHO_RE.test(clause)) {
    const cnt = clause.match(/(\d+)\s*体/);
    const where = pt ? toTarget(pt) : obj ? toTarget(obj) : dir && dir !== 'cover' ? { targetType: 'direction', direction: dir, distance: 12 } : null;
    if (/轟音|一斉|決め技|耳元/.test(clause)) steps.push({ action: 'ability', ability: 'echo', effect: 'roar', targetType: 'enemy' });
    else if (/呼び戻|戻せ|戻す|回収/.test(clause)) steps.push({ action: 'ability', ability: 'echo', effect: 'recall', targetType: 'self' });
    else if (/足音を消|音を消|静かに動|忍び/.test(clause) && !/敵の/.test(clause)) steps.push({ action: 'ability', ability: 'echo', effect: 'silence_self', targetType: 'self' });
    else if (/引っか|ひっか|群が|襲わせ|攻撃させ|噛/.test(clause)) steps.push({ action: 'ability', ability: 'echo', effect: 'scratch', targetType: 'enemy', ...(cnt ? { count: Number(cnt[1]) } : {}) });
    else if (/(音|声).*(置|鳴ら|流|聞かせ)|鳴ら|流す|聞かせ/.test(clause)) {
      const sound = /声/.test(clause) ? 'voice' : /大きな音|轟音|衝撃音|アラーム/.test(clause) ? 'loud' : /足音/.test(clause) ? 'footsteps' : 'any';
      steps.push({ action: 'ability', ability: 'echo', effect: 'place', sound, ...(where || { targetType: 'direction', direction: 'away_from_enemy', distance: 12 }) });
    } else {
      steps.push({ action: 'ability', ability: 'echo', effect: 'deploy', ...(where || (mentionsEnemy ? { targetType: 'enemy' } : { targetType: 'direction', direction: 'forward', distance: 1 })), ...(cnt ? { count: Number(cnt[1]) } : {}) });
    }
    return steps;
  }

  // --- セブンス・サン（鷺沼 玲司） ---
  if (has.seventh && SEVENTH_RE.test(clause)) {
    const m = clause.match(/(\d|[一二三四五六七])\s*回/);
    const kanji = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
    const bounces = m ? (kanji[m[1]] ?? Number(m[1])) : /限界|最大|7回|ギリギリまで/.test(clause) ? 7 : 2;
    const tgt = pt ? toTarget(pt) : { targetType: 'enemy' };
    if (/三方|3発|三発|逃げ道を塞/.test(clause)) steps.push({ action: 'ability', ability: 'seventh', effect: 'spread', bounces, ...tgt });
    else if (/跳弾|跳ね返|反射|バウンド|跳ねさせ|回跳/.test(clause)) steps.push({ action: 'ability', ability: 'seventh', effect: 'bank', bounces, ...tgt });
    else steps.push({ action: 'ability', ability: 'seventh', effect: 'direct', ...(pt ? toTarget(pt) : dir && dir !== 'cover' ? { targetType: 'direction', direction: dir } : { targetType: 'enemy' }) });
    return steps;
  }

  if (/(体|服|肩|首|耳)(を|の).*(払|叩|はた)|払い(落|潰)|虫|小さな(何か|物).*(潰|払)/.test(clause)) {
    steps.push({ action: 'swat', targetType: 'self' });
    return steps;
  }

  // --- 扉・窓・階 ---
  const bdHere = b.buildingOf(c);
  const exitsOf = (bd, open) => (bd ? bd.exits : [])
    .map(id => b.objectById(id)).filter(o => o && o.openable && !!o.open === open)
    .sort((a, z) => dist(c.x, c.y, a.x, a.y) - dist(c.x, c.y, z.x, z.y));
  if (has.hotel && /密室|閉じ込め|全部閉め|すべて閉め|全て閉め|出口を.*閉め/.test(clause)) {
    const exits = exitsOf(bdHere, true);
    if (!exits.length) return steps;
    for (const o of exits.slice(0, 4)) steps.push({ action: 'close', targetType: 'object', targetId: o.id });
    return steps;
  }
  if (/飛び降り|跳び降り|窓から(外へ|下へ)?(飛|跳)/.test(clause)) {
    const o = obj && b.objectById(obj.id);
    if (o && o.kind === 'window' && o.floor === 1) steps.push({ action: 'jump_down', targetType: 'object', targetId: o.id });
    else steps.push({ action: 'jump_down', targetType: 'none' });
    return steps;
  }
  if (/閉め|閉じ/.test(clause)) {
    const o = obj && b.objectById(obj.id);
    const target = o && (o.kind === 'door' || o.kind === 'window') ? o : exitsOf(bdHere, true)[0];
    if (target) steps.push({ action: 'close', targetType: 'object', targetId: target.id });
    return steps;
  }
  if (/開け|開く|開いて/.test(clause) && !/こじ開/.test(clause)) {
    const o = obj && b.objectById(obj.id);
    const target = o && (o.kind === 'door' || o.kind === 'window') ? o : exitsOf(bdHere, false)[0];
    if (target) steps.push({ action: 'open', targetType: 'object', targetId: target.id });
    return steps;
  }

  // --- 物理的な行動 ---
  if (/見せかけ|フェイント|ふりをし/.test(clause)) {
    steps.push({ action: 'move', mode: 'run', targetType: 'enemy', distance: 4 });
    return steps;
  }
  // 拾う：「花瓶を拾う」「何か武器を拾う」
  const itemRef = findItemRef(b, c, clause);
  if (/拾|手に取|掴|つかん|持って|持つ|武器に/.test(clause) && !/持っている|持った/.test(clause)) {
    steps.push({ action: 'pickup', ...(itemRef ? { targetType: 'object', targetId: itemRef.id } : { targetType: 'none' }), mode: run ? 'run' : 'walk' });
    if (/投げ/.test(clause)) steps.push({ action: 'throw', ...(pt ? toTarget(pt) : { targetType: 'enemy' }) });
    else if (/殴|攻撃|叩/.test(clause)) steps.push({ action: 'melee', targetType: 'enemy' });
    ctx.pickedUp = true;
    return steps;
  }
  if (/手放|捨て/.test(clause)) {
    steps.push({ action: 'drop', targetType: 'none' });
    return steps;
  }
  if (/投げ|投擲|放り/.test(clause)) {
    // 持っていない物を投げる指示なら、まず拾う
    if (itemRef && (!c.held || c.held.kind !== itemRef.kind) && !ctx.pickedUp) steps.push({ action: 'pickup', targetType: 'object', targetId: itemRef.id, mode: 'run' });
    else if (!c.held && !ctx.pickedUp) steps.push({ action: 'pickup', targetType: 'none', mode: 'run' });
    steps.push({ action: 'throw', ...(pt ? toTarget(pt) : { targetType: 'enemy' }) });
    return steps;
  }
  if (/壁|塀|木箱|箱|窓|ガラス|机|棚|自販機|自動販売機|ドラム缶|車|柱|仮囲い/.test(clause) && /壊|破壊|崩|割|殴|叩|蹴/.test(clause) && obj) {
    steps.push({ action: 'melee', targetType: 'object', targetId: obj.id });
    return steps;
  }
  if (/押す|押し|突き飛ば|蹴り飛ば|蹴飛ば/.test(clause) && obj && b.objectById(obj.id)?.movable) {
    steps.push({ action: 'push', targetType: 'object', targetId: obj.id, mode: run ? 'run' : 'walk' });
    return steps;
  }
  if (/引き寄せ|引っ張|引く/.test(clause) && obj && b.objectById(obj.id)?.movable) {
    steps.push({ action: 'pull', targetType: 'object', targetId: obj.id });
    return steps;
  }
  if (/殴|攻撃|パンチ|ラッシュ|打ち込|叩|蹴|斬|仕留め|ぶちのめ|ぶん殴/.test(clause)) {
    steps.push({ action: 'melee', targetType: 'enemy' });
    return steps;
  }
  if (/ガード|防御|防ぐ|守る|身を守|構える|受け止め/.test(clause)) {
    const m = clause.match(/(\d+(?:\.\d+)?)\s*秒/);
    steps.push({ action: 'guard', targetType: 'enemy', duration: m ? Number(m[1]) : 1.5 });
    return steps;
  }
  if (/避け|回避|かわ|躱|飛び退|跳び退|横に跳/.test(clause)) {
    steps.push({ action: 'dodge', targetType: 'direction', direction: dir && dir !== 'cover' ? dir : (/横/.test(clause) ? 'left' : 'away_from_enemy') });
    return steps;
  }
  if (/追いかけ|追尾|追う|追っ|追い詰|尾行|追跡|ついて行|付いて行|後を付け|後をつけ|距離を詰め|間合いを詰め|接近|近づ|迫/.test(clause) && (mentionsEnemy || !obj)) {
    const dm = clause.match(/(\d+(?:\.\d+)?)\s*(?:m|ｍ|メートル)/);
    const tm = clause.match(/(\d+(?:\.\d+)?)\s*秒/);
    steps.push({
      action: 'chase', targetType: 'enemy', mode: /歩い|そっと|静かに|忍び/.test(clause) ? 'walk' : 'run',
      ...(dm ? { distance: Number(dm[1]) } : {}), ...(tm ? { duration: Number(tm[1]) } : {}),
    });
    return steps;
  }
  const isMove = /上が|上る|登る|降り|下り|ダッシュ|疾走|歩く|歩い|突っ走|移動|行く|行って|向か|駆け込|入る|入り|入って|走|近づ|詰め|離れ|逃げ|隠れ|下が|回り込|回る|回って|進|戻|退|出る|出て|寄る/.test(clause);
  const isLook = /確認|見る|見て|覗|観察|様子|探す|探し|偵察|見張|警戒/.test(clause);
  if (isMove) {
    const mode = run || /逃げ|駆け込/.test(clause) ? 'run' : 'walk';
    if (pt) steps.push({ action: 'move', mode, ...toTarget(pt) });
    else if (obj && (dir === 'cover' || obj.kind === 'bush')) steps.push({ action: 'move', mode, ...toTarget(obj) });
    else if (dir && dir !== 'left' && dir !== 'right' || (dir && !obj)) {
      const dm = clause.match(/(\d+(?:\.\d+)?)\s*(?:m|ｍ|メートル)/);
      steps.push({ action: 'move', mode, targetType: 'direction', direction: dir, ...(dm ? { distance: Number(dm[1]) } : {}) });
    }
    else if (obj) steps.push({ action: 'move', mode, ...toTarget(obj) });
    else if (/詰め|近づ|接近|寄る/.test(clause) || mentionsEnemy) steps.push({ action: 'move', mode, targetType: 'enemy', distance: /詰め/.test(clause) ? 1.5 : 3 });
    else steps.push({ action: 'move', mode, targetType: 'direction', direction: 'forward' });
  }
  if (isLook) {
    if (/窓/.test(clause) && obj) {
      if (!isMove) steps.push({ action: 'move', mode: 'walk', targetType: 'object', targetId: obj.id });
      steps.push({ action: 'look', targetType: 'object', targetId: obj.id });
    } else steps.push({ action: 'look', ...(pt ? toTarget(pt) : { targetType: 'enemy' }) });
  }
  if (!isMove && !isLook && /待|待機|じっと|息を潜め|動かず/.test(clause)) {
    const m = clause.match(/(\d+(?:\.\d+)?)\s*秒/);
    steps.push({ action: 'wait', targetType: 'none', duration: m ? Number(m[1]) : 2 });
  }
  return steps;
}

export function localParse(b, c, text) {
  const raw = { interpretation: '', speech: null, steps: [], rejected: [] };
  let body = String(text || '');
  const speeches = [];
  body = body.replace(/[「『]([^」』]*)[」』]/g, (_, s) => { speeches.push(s); return ' '; });
  if (speeches.length) raw.speech = speeches.join(' ');

  for (const [re, msg] of IMPOSSIBLE) {
    if (re.test(body)) raw.rejected.push(msg);
  }
  const has = Object.fromEntries(Object.keys(ABILITIES).map(k => [k, c.def.abilities.includes(k)]));
  // 2対2：他の人物の名前・スタンド名は「敵」「味方」に置き換える（名前を挙げた敵を狙う）
  let named = null;
  for (const o of b.chars) {
    if (o === c) continue;
    const words = [o.name, ...o.name.split(/\s+/), o.def.nickname, o.stand !== c.stand ? o.stand : null].filter(Boolean).sort((p, q) => q.length - p.length);
    for (const w of words) {
      if (!body.includes(w)) continue;
      if (o.team !== c.team && !named) named = o;
      body = body.split(w).join(o.team === c.team ? '味方' : '敵');
    }
  }
  // 持っていない能力への言及
  const foreign = {
    perpendicular: /パーペンディキュラー|直角に弾|(10|１０)\s*(m|ｍ|メートル)(弾|飛)|弾き出/,
    hotel: /ホテル・カリフォルニア|密室|炎で囲/,
    echo: /エコー・ビーチ|足音を置|声を置|轟音を(集|置)|個体を/,
    seventh: /セブンス・サン|跳弾|パチンコ玉/,
  };
  const foreignRes = [];
  for (const [k, re] of Object.entries(foreign)) {
    if (!has[k] && re.test(body)) {
      raw.rejected.push(`『${ABILITIES[k].name}』に相当する能力は${c.name}にはない`);
      foreignRes.push(re);
    }
  }

  // 「4体、右に置く」のように体数の後の読点で文が分かれないようにする
  body = body.replace(/(\d+)\s*体\s*[、,，]/g, '$1体');
  // 座標の区切りで文が分かれないようにする
  body = body.replace(/([（(]\s*-?\d+(?:\.\d+)?)\s*[,、，]\s*(-?\d+(?:\.\d+)?\s*[)）])/g, '$1／$2');
  let pendingCond = null;
  const ctx = {};
  for (let clause of splitClauses(body)) {
    let cond = null;
    for (const [re, f] of COND) {
      const m = clause.match(re);
      if (m) {
        cond = f();
        // 条件部分（「敵が近づいてきたら」など）は行動として解釈しない
        clause = clause.slice(m.index + m[0].length).trim();
        break;
      }
    }
    if (foreignRes.some(re => re.test(clause))) continue;
    // セリフにつながる言い回し（「〜と言って」「〜と挑発して」）は取り除き、続きを解析する
    clause = clause.replace(/^(と|って)?(言って|言い|叫んで|叫び|挑発して|挑発し|呟いて|囁いて|告げて|笑って|宣言して|問いかけて)/, '').trim();
    if (!clause || /^(と|って)?(挑発|叫|言|呟|囁|告げ|笑|宣言|問いかけ)[^、]{0,3}$/.test(clause) || /^(と|って)$/.test(clause)) {
      if (cond) pendingCond = cond;
      continue;
    }
    const toAlly = /味方/.test(clause) && /(所|ところ|もと|元|そば|近く|合流|へ|に寄|に近づ)/.test(clause) && !/殴|攻撃|投げ/.test(clause);
    const steps = toAlly ? [{ action: 'move', targetType: 'ally', mode: /走|駆け|急|ダッシュ/.test(clause) ? 'run' : 'walk' }] : clause ? parseClause(b, c, clause, has, ctx) : [];
    if (!steps.length) {
      if (cond) { pendingCond = cond; continue; }
      if (clause.length > 1 && !IMPOSSIBLE.some(([re]) => re.test(clause))) raw.rejected.push(`「${clause}」を行動として解釈できなかった`);
      continue;
    }
    const useCond = cond || pendingCond;
    if (useCond) { steps[0].condition = useCond; pendingCond = null; }
    raw.steps.push(...steps);
  }
  if (named) for (const st of raw.steps) if (st.targetType === 'enemy' || (!st.targetType && ['chase', 'melee', 'throw'].includes(st.action))) { st.targetType = 'enemy'; st.targetId = named.id; }
  if (!raw.steps.length && raw.speech) raw.interpretation = 'セリフのみ';
  else raw.interpretation = raw.steps.length ? `（ローカル解析）${raw.steps.length}手順の行動として解釈` : '（ローカル解析）実行できる行動が見つからなかった';
  return raw;
}
