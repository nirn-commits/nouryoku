// キャラクター・能力・基本行動の定義（ゲームのルールはすべてここと engine 内のコードで決まる）

// 基本行動。cost は行動予算の見積もり（秒）
export const ACTIONS = {
  move: { name: '移動', desc: '目的地・対象・方向へ経路に沿って移動する。mode=walk(静か)/run(速いが足音が大きい)', targets: ['point', 'object', 'enemy', 'direction'] },
  chase: { name: '追尾', desc: '敵を追いかけ続ける（実行中に敵が動いても現在位置へ向かい直す）。見失ったら最後に見た位置→物音の位置を探す。次の手順が攻撃・投擲・能力なら、その間合いに入った時点で終了して次へ進む。最後の手順なら duration 秒（既定4・最大8）distance m（既定1.5）を保って追い続ける', targets: ['enemy'] },
  melee: { name: '近接攻撃', desc: 'スタンドで殴る（射程1.7m、届かなければ最大2.5秒追いかける）。対象が物体なら破壊を狙う', targets: ['enemy', 'object'] },
  throw: { name: '投擲', desc: 'ナイフを投げる（所持数に限りあり、軌道上の遮蔽物に当たる）。外れたナイフは地面に落ち拾える', targets: ['enemy', 'point', 'direction'] },
  guard: { name: 'ガード', desc: '正面からの攻撃を70%軽減する構え。duration秒（最大3秒）', targets: ['none', 'enemy', 'direction'] },
  dodge: { name: '回避', desc: '指定方向へ素早く3m跳ぶ。跳躍直後0.25秒は無敵。クールダウン1.5秒', targets: ['direction', 'point'] },
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

export const DIRECTIONS = ['toward_enemy', 'away_from_enemy', 'left', 'right', 'up', 'down', 'forward', 'back', 'cover'];

export const ABILITIES = {
  friction: {
    id: 'friction',
    name: '摩擦操作',
    desc: '視界内の地面・物体・敵の足元の摩擦を操作する。',
    activation: '作用地点が射程内かつ視界内（遮蔽物越し不可）',
    effects: {
      slick: { name: '摩擦低下', targets: ['point', 'enemy', 'object'], desc: '地面なら半径1.8mを7秒間ツルツルにする。走って踏み込んだ者は転倒（1.2秒行動不能・3ダメージ）、歩くと滑って制御が効きにくい。物体に使うと8秒間、押したり当たったりした時に勢いよく滑る。' },
      grip: { name: '摩擦増大', targets: ['point', 'enemy'], desc: '半径1.8mを7秒間、足が重くなる地面にする（移動速度35%）。' },
    },
    range: 9, radius: 1.8, duration: 7, castTime: 0.35, cooldown: 4, cost: 25,
    recoil: 'なし',
    weakness: '効果範囲は光沢でうっすら見える。ゆっくり歩けば転倒しない。視界外には使えない。',
    vfx: '地面が青白く光る／「キィン」という高音（半径5mに聞こえる）',
    soundRadius: 5,
    observedHint: '敵の能力？：地面がうっすら光沢を帯び、そこを走ると足を取られて転倒する。摩擦を操っている可能性。',
  },
  vector: {
    id: 'vector',
    name: 'ベクトル反転',
    desc: '至近距離の物体・人・飛来物の運動の向きを書き換える。',
    activation: '対象が4.5m以内',
    effects: {
      redirect: { name: '軌道変更', targets: ['projectile'], desc: '飛来物の進行方向を変える（既定は敵の方向）。変えた飛来物は自分のものになる。' },
      repel: { name: '弾き飛ばし', targets: ['enemy', 'object'], desc: '対象を自分から遠ざける向きに強く弾く（秒速10m）。壁や物に激突すると8ダメージ＋0.6秒怯み、敵の構えは中断される。' },
    },
    range: 4.5, radius: 0, duration: 0, castTime: 0.12, cooldown: 6, cost: 30,
    recoil: '使用後0.2秒は動けない',
    weakness: '射程が非常に短い。発動に光の矢印が見える。',
    vfx: '白い矢印状の閃光／「バシュッ」という音（半径6m）',
    soundRadius: 6,
    observedHint: '敵の能力？：近くの物や飛んできた物が、見えない力で急に向きを変えて弾かれた。至近距離で運動の向きを操る？',
  },
  masonry: {
    id: 'masonry',
    name: '壁面変形',
    desc: '壁や地面の「石材」を粘土のように変形させる。',
    activation: '対象の壁・地点が射程内かつ視界内',
    effects: {
      raise: { name: '壁の隆起', targets: ['point', 'enemy', 'direction'], desc: '地点に長さ2.4m・耐久40の壁を生やす（自分と地点を結ぶ線に垂直な向き）。人がいる場所には生やせない。通路を塞いだり盾にできる。' },
      spike: { name: '棘の突出', targets: ['object'], desc: '対象の壁の表面から棘を突き出す。壁から1.3m以内にいる者に14ダメージ＋壁から押し離す。' },
      breach: { name: '崩落', targets: ['object'], desc: '対象の壁（外壁以外）を崩す。壁は瓦礫になり、すぐそば（1.2m以内）にいる者に崩落の10ダメージ。' },
    },
    range: 8, radius: 0, duration: 0, castTime: 0.6, cooldown: 6, cost: 35,
    recoil: 'なし',
    weakness: '発動まで0.6秒かかり、その間は無防備。外壁は崩せない。石の擦れる音が響く。',
    vfx: '壁面が波打つ／「ゴゴゴ」という重い音（半径10m）',
    soundRadius: 10,
    observedHint: '敵の能力？：壁が生き物のように変形した（棘・新しい壁・崩落）。石材を操る？',
  },
  hush: {
    id: 'hush',
    name: '静寂',
    desc: '音そのものを「吸い取る」。',
    activation: '地点・敵が射程内かつ視界内',
    effects: {
      silence_zone: { name: '無音領域', targets: ['point', 'self'], desc: '半径3.5mを8秒間、無音にする。領域の中で出た音は外に届かず、中にいる者は外の音も聞こえない。' },
      deafen: { name: '聴覚封じ', targets: ['enemy'], desc: '敵を6秒間何も聞こえない状態にし、その間のセリフも誰にも届かない。' },
    },
    range: 10, radius: 3.5, duration: 8, castTime: 0.3, cooldown: 8, cost: 25,
    recoil: 'なし',
    weakness: '直接の攻撃力はない。無音領域は目には見えないが、中の物音が急に消えるので気づかれうる。',
    vfx: '発動しても音は出ない（領域の境界がわずかに揺らいで見える＝使用者のみ）',
    soundRadius: 0,
    observedHint: '敵の能力？：急に周囲の音が消えた／耳が聞こえなくなった。音を消す能力？',
  },
};

export const CHARACTERS = {
  makabe: {
    id: 'makabe',
    name: '真壁 透',
    stand: 'ゼロ・グリップ',
    color: '#4fb3e0',
    hp: 100, sp: 100, spRegen: 6,
    walk: 3.2, run: 5.6,
    power: 10, defense: 1.0, knives: 3,
    abilities: ['friction', 'vector'],
    personality: '冷静沈着な観察型。相手の動きを読み、足元をすくって隙を作ってから殴る。挑発には皮肉で返す。',
    lines: ['足元には気をつけるんだな', 'その一歩……「滑る」ぜ', 'やれやれ、まだやるのか？', '見えているぞ'],
  },
  karasuma: {
    id: 'karasuma',
    name: '烏丸 静',
    stand: 'ハッシュ・メイソン',
    color: '#c77dff',
    hp: 105, sp: 100, spRegen: 5,
    walk: 3.0, run: 5.4,
    power: 11, defense: 0.95, knives: 3,
    abilities: ['masonry', 'hush'],
    personality: '寡黙で狡猾な待ち伏せ型。音を消して忍び寄り、壁を使って退路を断つ。言葉は少なく不気味。',
    lines: ['……静かに', '音もなく、終わらせる', 'この壁は、わたしの味方だ', '……どこを見ている'],
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
  maxSteps: 5,
  conditionTimeoutDefault: 5,
  conditionTimeoutMax: 8,
};
