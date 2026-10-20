// Gemini が使えない時のための、キーワードベースの日本語行動解析（簡易版）
// 出力は Gemini と同じ「生の計画」形式。検証は compilePlan が行う
import { ABILITIES } from './data.js';
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
  [/(飛んで|投げて)(き|来)たら|ナイフが来たら|飛来/, () => ({ kind: 'projectile_incoming' })],
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
    .replace(/((?:走っ|駆け寄っ|近づい|移動し|向かっ|行っ|戻っ|下がっ|離れ|回り込ん|詰め|入っ|出)(?:て|で))(?![き来いお])(?=.)/g, '$1、')
    .split(/[、。,.\n!！?？]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function findObjectRef(b, c, clause) {
  const w = b.world;
  const pe = b.perceivedEnemy(c);
  const leftHouse = w.buildings.find(x => x.id === 'house_left');
  const rightHouse = w.buildings.find(x => x.id === 'house_right');
  const house = /左の家|左の建物|左側の家/.test(clause) ? leftHouse
    : /右の家|右の建物|右側の家/.test(clause) ? rightHouse
      : /家|建物|屋内|室内/.test(clause) ? nearestBy(w.buildings.map(x => ({ ...x, center: { x: x.x + x.w / 2, y: x.y + x.h / 2 } })), c.x, c.y) : null;

  const m = clause.match(/木箱([A-HＡ-Ｈa-h])/);
  if (m) {
    const letter = m[1].normalize('NFKC').toLowerCase();
    const o = b.objectById(`crate_${letter}`);
    if (o) return { type: 'object', id: o.id };
  }
  if (/木箱|箱/.test(clause)) {
    const crates = w.objects.filter(o => o.kind === 'crate');
    const ref = /敵の(近く|そば|横)/.test(clause) && pe ? pe : c;
    const o = nearestBy(crates, ref.x, ref.y);
    if (o) return { type: 'object', id: o.id };
  }
  if (/机|テーブル/.test(clause)) {
    const o = nearestBy(w.objects.filter(x => x.kind === 'table'), c.x, c.y);
    if (o) return { type: 'object', id: o.id };
  }
  if (/窓/.test(clause)) {
    const wins = w.objects.filter(o => o.kind === 'window' && (!house || o.building === house.id));
    const o = nearestBy(wins, c.x, c.y);
    if (o) return { type: 'object', id: o.id };
  }
  if (/入口|扉|ドア|玄関/.test(clause)) {
    const doors = w.buildings.filter(x => !house || x === house).flatMap(x => x.doors);
    const d = nearestBy(doors.map(d => ({ ...d, center: d })), c.x, c.y);
    if (d) return { type: 'object', id: d.id };
  }
  if (/中央の壁|真ん中の壁/.test(clause)) return { type: 'object', id: 'center_wall_1' };
  if (/壁/.test(clause)) {
    const walls = w.objects.filter(o => o.kind === 'wall' && !o.indestructible);
    // 「背後の壁」「敵の近くの壁」は敵の近くの壁
    const ref = /背後|後ろ|敵の|そば|近く/.test(clause) && pe ? pe : c;
    const o = nearestBy(walls, ref.x, ref.y);
    if (o) return { type: 'object', id: o.id, wall: true };
  }
  if (house) return { type: 'object', id: house.id };
  return null;
}

function pointRef(clause) {
  const m = clause.match(/[（(]\s*(-?\d+(?:\.\d+)?)\s*[,、，／]\s*(-?\d+(?:\.\d+)?)\s*[)）]/);
  return m ? { type: 'point', x: Number(m[1]), y: Number(m[2]) } : null;
}

function dirRef(clause) {
  if (/物陰|陰に|隠れ/.test(clause)) return 'cover';
  if (/離れ|逃げ|下が|距離を取|退/.test(clause)) return 'away_from_enemy';
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

function parseClause(b, c, clause, has) {
  const steps = [];
  const obj = findObjectRef(b, c, clause);
  const pt = pointRef(clause);
  const dir = dirRef(clause);
  const run = /走|駆け|急い|ダッシュ|全力|一気|飛び込/.test(clause);
  const mentionsEnemy = /敵|相手|あいつ|奴|やつ/.test(clause);

  // --- 能力 ---
  if (has.friction && /摩擦|滑ら|滑り|すべ|転倒|転ば|ツルツル|足を取|足元をすく|グリップ|足を重く|足止め/.test(clause)) {
    const effect = /グリップ|重く|足止め|鈍く|粘/.test(clause) ? 'grip' : 'slick';
    if (/木箱|箱|机/.test(clause) && obj && effect === 'slick') steps.push({ action: 'ability', ability: 'friction', effect, ...toTarget(obj) });
    else if (pt) steps.push({ action: 'ability', ability: 'friction', effect, ...toTarget(pt) });
    else steps.push({ action: 'ability', ability: 'friction', effect, targetType: 'enemy' });
    return steps;
  }
  if (has.vector && /逸ら|そら|反転|跳ね返|弾き返|ベクトル|軌道|押し戻|吹き飛ば|弾き飛ば|弾く/.test(clause)) {
    if (/ナイフ|飛来|飛んで|飛び道具|投げ/.test(clause)) steps.push({ action: 'ability', ability: 'vector', effect: 'redirect', targetType: 'projectile', direction: 'toward_enemy' });
    else if (/木箱|箱|机/.test(clause) && obj) steps.push({ action: 'ability', ability: 'vector', effect: 'repel', ...toTarget(obj) });
    else steps.push({ action: 'ability', ability: 'vector', effect: 'repel', targetType: 'enemy' });
    return steps;
  }
  if (has.masonry && /壁/.test(clause) && /棘|トゲ|とげ|スパイク|突き出/.test(clause) && obj && obj.wall) {
    steps.push({ action: 'ability', ability: 'masonry', effect: 'spike', targetType: 'object', targetId: obj.id });
    return steps;
  }
  if (has.masonry && /壁/.test(clause) && /崩|破壊|壊|瓦礫|穴/.test(clause) && obj && obj.wall) {
    steps.push({ action: 'ability', ability: 'masonry', effect: 'breach', targetType: 'object', targetId: obj.id });
    return steps;
  }
  if (has.masonry && /(壁|バリケード|盾).*(作|生や|立て|築|出|隆起|塞)|塞ぐ|塞い|遮る/.test(clause)) {
    if (pt) steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', ...toTarget(pt) });
    else if (/目の前|前に|自分の前|盾/.test(clause)) steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'direction', direction: 'toward_enemy' });
    else steps.push({ action: 'ability', ability: 'masonry', effect: 'raise', targetType: 'enemy' });
    return steps;
  }
  if (has.hush && /音を消|静寂|無音|静かに|サイレン|音を奪|耳を|聞こえなく|消音/.test(clause)) {
    if (/耳|聞こえなく|聴覚/.test(clause) && mentionsEnemy) steps.push({ action: 'ability', ability: 'hush', effect: 'deafen', targetType: 'enemy' });
    else if (pt) steps.push({ action: 'ability', ability: 'hush', effect: 'silence_zone', ...toTarget(pt) });
    else steps.push({ action: 'ability', ability: 'hush', effect: 'silence_zone', targetType: 'self' });
    return steps;
  }

  // --- 物理的な行動 ---
  if (/見せかけ|フェイント|ふりをし/.test(clause)) {
    steps.push({ action: 'move', mode: 'run', targetType: 'enemy', distance: 4 });
    return steps;
  }
  if (/ナイフ|投げ|投擲/.test(clause)) {
    steps.push({ action: 'throw', ...(pt ? toTarget(pt) : { targetType: 'enemy' }) });
    return steps;
  }
  if (/壁|木箱|箱|窓|机/.test(clause) && /壊|破壊|崩|割|殴|叩き割/.test(clause) && obj) {
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
  const isMove = /移動|行く|行って|向か|駆け込|入る|入り|入って|走|近づ|詰め|離れ|逃げ|隠れ|下が|回り込|進|戻|退|出る|出て|寄る/.test(clause);
  const isLook = /確認|見る|見て|覗|観察|様子|探す|探し|偵察|見張|警戒/.test(clause);
  if (isMove) {
    const mode = run || /逃げ|駆け込/.test(clause) ? 'run' : 'walk';
    if (pt) steps.push({ action: 'move', mode, ...toTarget(pt) });
    else if (dir && dir !== 'left' && dir !== 'right' || (dir && !obj)) steps.push({ action: 'move', mode, targetType: 'direction', direction: dir });
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
  // 持っていない能力への言及
  const foreign = {
    friction: /摩擦|ツルツル|滑らせ|転倒させ|転ばせ/, vector: /ベクトル|軌道.*(逸|変|そら)|逸らし|跳ね返|弾き飛ば/, masonry: /壁を(変形|生や|作|出)|棘|トゲ|壁を隆起/, hush: /音を消|静寂|無音|聞こえなく/,
  };
  const foreignRes = [];
  for (const [k, re] of Object.entries(foreign)) {
    if (!has[k] && re.test(body)) {
      raw.rejected.push(`『${ABILITIES[k].name}』に相当する能力は${c.name}にはない`);
      foreignRes.push(re);
    }
  }

  // 座標の区切りで文が分かれないようにする
  body = body.replace(/([（(]\s*-?\d+(?:\.\d+)?)\s*[,、，]\s*(-?\d+(?:\.\d+)?\s*[)）])/g, '$1／$2');
  let pendingCond = null;
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
    if (/^(と|って|と言って|と言い)?(挑発|叫|言|呟|告げ|笑|宣言|問いかけ)/.test(clause) || /^(と|って)$/.test(clause)) continue;
    const steps = clause ? parseClause(b, c, clause, has) : [];
    if (!steps.length) {
      if (cond) { pendingCond = cond; continue; }
      if (clause.length > 1 && !IMPOSSIBLE.some(([re]) => re.test(clause))) raw.rejected.push(`「${clause}」を行動として解釈できなかった`);
      continue;
    }
    const useCond = cond || pendingCond;
    if (useCond) { steps[0].condition = useCond; pendingCond = null; }
    raw.steps.push(...steps);
  }
  if (!raw.steps.length && raw.speech) raw.interpretation = 'セリフのみ';
  else raw.interpretation = raw.steps.length ? `（ローカル解析）${raw.steps.length}手順の行動として解釈` : '（ローカル解析）実行できる行動が見つからなかった';
  return raw;
}
