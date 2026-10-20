// キャラクター・能力・基本行動の定義（ゲームのルールはすべてここと engine 内のコードで決まる）

// 基本行動。cost は行動予算の見積もり（秒）
export const ACTIONS = {
  move: { name: '移動', desc: '目的地・対象・方向へ経路に沿って移動する。mode=walk(静か)/run(速いが足音が大きい)', targets: ['point', 'object', 'enemy', 'direction'] },
  chase: { name: '追尾', desc: '敵を追いかけ続ける（実行中に敵が動いても現在位置へ向かい直す）。見失ったら最後に見た位置→物音の位置を探す。次の手順が攻撃・投擲・能力なら、その間合いに入った時点で終了して次へ進む。最後の手順なら duration 秒（既定4・最大8）distance m（既定1.5）を保って追い続ける', targets: ['enemy'] },
  melee: { name: '近接攻撃', desc: 'スタンドで殴る（射程1.7m、届かなければ最大2.5秒追いかける）。対象が物体なら破壊を狙う', targets: ['enemy', 'object'] },
  throw: { name: '投擲', desc: 'ナイフを投げる（所持数に限りあり、軌道上の遮蔽物に当たる）。外れたナイフは地面に落ち拾える', targets: ['enemy', 'point', 'direction'] },
  guard: { name: 'ガード', desc: '正面からの攻撃を70%軽減する構え。duration秒（最大3秒）', targets: ['none', 'enemy', 'direction'] },
  dodge: { name: '回避', desc: '指定方向へ素早く3m跳ぶ。跳躍直後0.25秒は無敵。クールダウン1.5秒', targets: ['direction', 'point'] },
  open: { name: '開ける', desc: '扉・窓に近づいて開ける（扉は歩いて通るだけでも自動で開く。コンビニのガラス窓は開かない）', targets: ['object'] },
  close: { name: '閉める', desc: '開いている扉・窓に近づいて閉める（人が通っている最中は閉まらない）', targets: ['object'] },
  jump_down: { name: '飛び降りる', desc: '2階の窓から外へ飛び降りる（targetId に窓、省略時は近くの窓）。窓が閉まっていれば突き破る（2ダメージ）。着地の衝撃5ダメージ', targets: ['object', 'none'] },
  push: { name: '押す', desc: '近くの動かせる物体（木箱・机）を自分から遠ざける方向へ押し出す。勢いのある物体は人に当たるとダメージ', targets: ['object'] },
  pull: { name: '引く', desc: '近くの動かせる物体を自分の方へ引き寄せる', targets: ['object'] },
  look: { name: '観察', desc: '対象・方向を向いて様子を確かめる（0.6秒）', targets: ['enemy', 'object', 'point', 'direction'] },
  wait: { name: '待機', desc: 'その場で待つ。duration秒、または条件が満たされるまで', targets: ['none'] },
  ability: { name: '能力使用', desc: 'スタンド能力を使う。ability と effect と対象を指定', targets: ['enemy', 'self', 'object', 'point', 'projectile', 'direction'] },
};

export const CONDITIONS = {
  enemy_within: '敵が value m 以内に見えたら',
  enemy_visible: '敵の姿が見えたら',
  enemy_not_visible: '敵が視界から消えたら',
  projectile_incoming: '自分に向かって飛来物が見えたら',
  enemy_attacking: '敵が攻撃の構えに入ったのが見えたら',
  hp_below: '自分のHPが value 以下になったら',
  damaged: '攻撃を受けたら',
};

export const DIRECTIONS = ['toward_enemy', 'away_from_enemy', 'left', 'right', 'up', 'down', 'up_left', 'up_right', 'down_left', 'down_right', 'forward', 'back', 'cover'];

export const ABILITIES = {
  perpendicular: {
    id: 'perpendicular',
    name: 'パーペンディキュラー',
    desc: '接触面を境に、どちらか一方を「面から離れる垂直方向」へきっかり10m弾き出す。距離は常に10mで、短縮・延長・途中停止は不可。経路上の障害物で止まり、衝突の威力は重さに関係なく一定（人なら10ダメージ＋0.6秒怯み、物なら30の破壊力）。障害物に当たらず10m飛び切れば衝突ダメージはない。移動完了時に速度ゼロ。質量上限100kg。引き寄せは不可。',
    activation: '対象に触れていること（スタンドの射程約2m）。何にも触れていない空中では発動不可だが、手に持った物（ナイフ）は接触扱い',
    effects: {
      self_launch: {
        name: '自分を弾く', targets: ['self', 'object', 'direction'],
        desc: '触れている面から自分を10m弾き出す。壁・柱・物に触れていれば（0.6m以内）その面の正面方向へ水平に飛ぶ（飛行中は攻撃を受けない）。開けた場所では真上に10m跳び、約1.8秒空中にいた後に落下して着地の衝撃5ダメージ。空中にいる間は近接攻撃・ナイフが届かず、壁越しに見渡せる。空中でナイフを持っていれば、それを基準に任意の水平方向へ10m移動できる（direction で指定。高所なので障害物を越える）。object を指定するとその面を使う。',
      },
      launch: {
        name: '触れた物を弾く', targets: ['enemy', 'object'], range: 2, castTime: 0.4,
        desc: '約2m以内の敵か物（100kg以下）に触れ、手から離れる方向へきっかり10m弾き出す。触れるまで0.4秒かかる。敵には接触の打撃3ダメージ。10m以内に壁・柱・物があればそこへ叩きつけられ（人10ダメージ＋怯み）、なければ飛ぶだけ。',
      },
      launch_held: {
        name: '持った物を飛ばす', targets: ['enemy', 'point', 'direction'], range: 10, castTime: 0.3,
        desc: '手に持ったナイフを、きっかり10m先まで弾き出す（10mで落ちる）。当たれば重さに関係なく12ダメージ。ナイフを1本使う。',
      },
    },
    range: 2, radius: 0, duration: 0, castTime: 0.1, cooldown: 1.5, cost: 30,
    recoil: 'なし（真上に跳んだ場合は落下と着地がある）',
    weakness: '平らな開けた場所では真上にしか飛べない。移動距離が固定なので着地点を読まれやすい。射程が約2mと短く遠距離型に弱い。100kg超の相手（自販機・ドラム缶・車など）は飛ばせない。',
    vfx: '接触点に直角記号「∟」、移動完了時に移動距離（例「10.00」）が表示される／「カチッ」という硬い音（半径6m）',
    soundRadius: 6,
    observedHint: '敵の能力？：触れた物や人が、直角に、きっかり同じ距離（約10m）だけ弾き出された。「10.00」という表示……距離が一定の能力？ 至近距離でしか使えない？',
  },
  hotel: {
    id: 'hotel',
    name: 'ホテル・カリフォルニア',
    desc: '錠二が建物（部屋）の内側にいる状態で、本人の手で最後の出口（扉・窓）を閉めて密室にした瞬間、建物の外周をスタンドエネルギーの炎が囲む。外から閉じ込めることはできない。炎は物を燃やさず熱も煙もないが、生物が触れると火傷（12ダメージ）を負って押し戻される。人も飛び道具も炎を越えられない（視線は通る）。内側から出口を開けても危険はないが、開けた所には炎の壁が残り、外へは出られない。錠二が開いた出口を閉め直すと、その出口は閉じた状態に戻る。開閉できる出口がすべて同時に開いた状態になると解除される（壊れて閉じられない出口は開いた扱い）。範囲は最大約200㎡（建物1棟、2階を含む）。',
    activation: '錠二が建物の中にいて、その建物の出口で開いているのが最後の1つの時に、それを自分の手で閉める（通常の「閉める」行動でも成立する）',
    effects: {
      seal: { name: '最後の扉を閉める', targets: ['object'], desc: '指定した扉・窓に近づいて閉める。それで今いる建物の出口がすべて閉じれば密室が成立する。' },
    },
    range: 1.5, radius: 0, duration: 0, castTime: 0.4, cooldown: 0, cost: 0,
    recoil: '本体も同じ檻に入る',
    weakness: '本体も同じ檻に入る必要があり、相手が格上なら追い詰められるのは錠二の側。屋外や扉の閉まらない空間では発動不可。射程（約1.5m）と精密動作性が低く、遠距離型や搦め手に弱い。窓を割れる相手には閉め直しが通用しにくい。',
    vfx: '建物の外周を白く揺らめく炎が囲む（音はしない）',
    soundRadius: 0,
    observedHint: '敵の能力？：あの男が扉を閉めた瞬間、建物の外側を炎が囲んだ。触れると焼けるが物は燃えない。出口を全部開ければ出られる？',
  },
};

// 能力値の表記（A〜E）
export const STAT_LABELS = { power: '破壊力', speed: 'スピード', range: '射程距離', stamina: '持続力', precision: '精密動作性', growth: '成長性' };

export const CHARACTERS = {
  sogo: {
    id: 'sogo',
    name: '十河 矩比呂',
    reading: 'そごう のりひろ',
    nickname: 'ノリ',
    stand: 'パーペンディキュラー',
    color: '#f4a261',
    hp: 95, sp: 100, spRegen: 6,
    walk: 3.3, run: 5.8,
    power: 11, defense: 1.0, knives: 3,
    abilities: ['perpendicular'],
    kg: 52,
    stats: { power: 'B', speed: 'B（能力移動時A）', range: 'E（約2m）', stamina: 'C', precision: 'B', growth: 'B' },
    profile: '工業高校電子機械科2年、17歳。171cm・52kg。通称「ノリ」。細身で猫背、黒縁眼鏡。学ランは前全開で、中にレトロゲーム機のTシャツ。胸ポケットにドライバーセット。',
    personality: 'ナード系の不良。喧嘩は自分に有利な地形（壁・柱・物が近くにある場所）でしか買わず、不利なら迷わず逃げる。大人を信用しない。ぶっきらぼうで、数字や単位を混ぜて話す。理不尽には損得抜きで割って入る。',
    lines: ['その距離なら届く。9.8mだ、ギリギリな', '10.00。誤差ゼロ', '開けた場所はお断りだ', '先払いだ。拳でな', '壁まで7m……計算済みだよ'],
  },
  kito: {
    id: 'kito',
    name: '鬼頭 錠二',
    reading: 'きとう じょうじ',
    stand: 'ホテル・カリフォルニア',
    color: '#e85d04',
    hp: 125, sp: 100, spRegen: 5,
    walk: 3.1, run: 5.6,
    power: 15, defense: 0.85, knives: 0,
    meleeRange: 1.5, meleeArc: Math.PI / 4,
    abilities: ['hotel'],
    kg: 98,
    stats: { power: 'A', speed: 'B', range: 'E（約1.5m）', stamina: 'A', precision: 'D', growth: 'C' },
    profile: '34歳。186cm・98kg。元地下格闘技選手で、現在は闇金の取り立て屋。短く刈った髪、こめかみから顎への裂傷痕、潰れた両耳、骨折を繰り返して歪んだ拳。黒のスラックスに白い開襟シャツ、袖は肘までまくっている。',
    personality: '暴力を一番手っ取り早い会話だと考えている。怒鳴らず、脅し文句は短く、相手が言い訳を始める前に殴る。外の喧嘩は止められ逃げられるので、相手を部屋（建物）に追い込み、扉を閉めてから最後までやる。部屋に入ると必ず後ろ手に扉を閉める。殴り終えた後は倒れた家具を元に戻す几帳面さがある。低く短い口調で、感情の起伏がほとんどない。',
    lines: ['入れ', '話はいい', '閉めるぞ', '……終わりだ', '逃げ道はない', '言い訳は聞かない'],
  },
};

// 基本パラメータ
export const RULES = {
  dt: 1 / 30,
  charRadius: 0.4,
  meleeRange: 1.7,
  meleeArc: Math.PI / 3, // 片側60°
  meleeWindup: 0.3,
  meleeRecovery: 0.4,
  throwWindup: 0.4,
  throwRecovery: 0.3,
  knifeSpeed: 15,
  knifeDamage: 8,
  knifeRange: 18,
  dodgeDistance: 3,
  dodgeTime: 0.3,
  dodgeCooldown: 1.5,
  visionRange: 22,
  visionFov: (140 * Math.PI) / 180,
  nearAwareness: 2.5,
  speechRadius: 15,
  budgetSeconds: 10,
  launchImpact: 10, // パーペンディキュラーの衝突威力（重さに関係なく一定）
  launchTouch: 3,
  maxSteps: 5,
  conditionTimeoutDefault: 5,
  conditionTimeoutMax: 8,
};
