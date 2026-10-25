# キャラクターの書式（JSON）

ジョジョのスタンド使いに限らず、魔法使い・剣士・忍者・超能力者など、いろいろなキャラクターをコードを書かずに追加するための書式です。

## 追加のしかた

1. `public/characters/_template.json` をコピーして、`public/characters/<id>.json` を作ります（例：`ninja.json`）。
2. `public/characters/index.json` の `characters` にファイル名を足します。
   ```json
   { "characters": ["homura.json", "takamiya.json", "ninja.json"] }
   ```
3. ブラウザを再読み込みすると、タイトル画面のキャラクター一覧に出ます。書き方に誤りがあると、一覧の上に**どこがどう違うか**が日本語で表示されます。
4. 見た目（任意）：`public/chips/<id>.png`（本体のキャラチップ）・`public/chips/<id>_stand.png`（スタンドなど）・`public/img/<id>.webp`（立ち絵）を置くと使われます。無ければ色つきの人影で表示されます。チップの形は `public/chips/README.md` を参照。

追加したキャラは、キャラ選択・対戦相手・コマンド画面（能力のボタン）・文章入力（技の名前で使える）・CPU の思考（先読み）・場面ごとのセリフ・観戦モードに、自動で組み込まれます。

同梱の例：`homura.json`（炎の魔法使い・遠距離型）、`takamiya.json`（剣士・近接型）。

## 項目

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `id` | ○ | 半角英小文字で始まる英数字と `_`。ファイル名・画像の名前にも使う |
| `name` | ○ | 名前 |
| `reading` |  | 読みがな |
| `power` |  | `{ "label": "魔法", "name": "紅蓮魔術" }`。label は能力の呼び方（スタンド・魔法・忍術など）、name は能力の総称 |
| `color` |  | 本人の色（`#rrggbb`） |
| `role` |  | 戦い方：`melee`（近接：詰めて殴る）／`mid`（中距離）／`ranged`（遠距離：距離を取る）。既定は melee |
| `keepDistance` |  | mid・ranged が保つ距離（m） |
| `hp` `sp` `spRegen` |  | 体力・能力のエネルギー・毎秒の回復量（既定 100・100・6） |
| `walk` `run` |  | 歩く・走る速さ（m/秒、既定 3.2・5.7） |
| `punch` |  | 素手で殴る威力（既定 8。目安：十河11・錠二17） |
| `defense` |  | 受けるダメージの倍率（小さいほど硬い。既定 1.0） |
| `kg` |  | 体重 |
| `standRange` |  | 体の外に出せる分身（スタンドなど）がある時の射程（m）。書くと「スタンドを出す・先行させる」が使える |
| `stats` |  | キャラ紹介の能力値（`power` `speed` `range` `stamina` `precision` `growth`。文字は自由） |
| `profile` `personality` |  | 紹介文・性格と戦い方 |
| `lines` |  | いつものセリフ（配列） |
| `persona` |  | CPU の性格：`aggression`（攻め気、1前後）・`caution`（用心深さ、1前後）・`gamble`（博打好き、0〜0.9）・`chatter`（口数、0〜1） |
| `situationLines` |  | 場面ごとのセリフ：`spot`（敵を見つけた）・`hit`（一撃を入れた）・`hurt`（強く殴られた）・`low`（体力が少ない）・`winning`・`losing`・`hunting`（探している）・`ability`（能力を使う）・`downed`（相手が倒れた） |
| `examples` |  | 例文（文章入力の例・「できること」に出る） |
| `abilities` | ○ | 能力（1つ以上）。下を参照 |

## 能力（abilities）

```json
{
  "id": "flame", "name": "紅蓮魔術", "desc": "説明",
  "range": 15, "castTime": 0.4, "cooldown": 1.2, "cost": 12,
  "weakness": "弱点", "observedHint": "相手から見た時のヒント",
  "effects": { "fireball": { ...技... }, "firewall": { ...技... } }
}
```

| 項目 | 内容 |
| --- | --- |
| `range` | 射程（m）。技ごとに上書きできる |
| `castTime` | 構えてから出るまでの秒数（技ごとに上書きできる） |
| `cooldown` | 次に使えるまでの秒数 |
| `cost` | 1回に使うエネルギー |

### 技（effects の中身）

```json
"fireball": {
  "name": "火球", "desc": "説明",
  "targets": ["enemy", "point", "direction"],
  "range": 18,
  "hit": { "shape": "circle", "radius": 2 },
  "requires": ["outdoors"],
  "text": "『{name}』の火球が{target}を襲う！",
  "do": [ ...部品... ]
}
```

- `targets`：狙えるもの。`enemy`（敵）・`ally`（味方）・`self`（自分）・`point`（地点）・`direction`（方向）・`object`（物）・`none`。
- `hit`：効果が当たる範囲。`shape` は `single`（狙った敵1人・既定）／`circle`（狙った所を中心に `radius` m）／`cone`（自分から扇形、`radius` m・`angle` 度）／`line`（自分から直線、`length` m・`width` m）／`self`（自分。`allies: true` と `radius` で近くの味方も）。
- `requires`：使える条件。`indoors`（屋内だけ）・`outdoors`（屋外だけ）・`holding`（物を持っている時だけ）・`{ "hpBelow": 40 }`（体力40以下の時だけ）。
- `text`：使った時のログ。`{name}` は使った人、`{target}` は当たった相手。

### 部品（do の中身。上から順に実行）

| type | 内容 | 主な項目 |
| --- | --- | --- |
| `damage` | 当たった敵にダメージ | `amount`、`melee: true`（殴りとして扱う：ガード・受け流しが効く） |
| `heal` | 当たった味方（自分）を回復 | `amount` |
| `knockback` | 当たった敵を吹き飛ばす | `distance`（m）、`slam`（壁に当たった時の追加ダメージ）、`from: "center"`（範囲の中心から外へ） |
| `status` | 状態をかける | `status`：`stun`（動けない）・`prone`（転倒）・`slow`（鈍化、`amount` は速さの倍率）・`deaf`（耳が聞こえない）・`invuln`（無敵）・`guard`（ガード）・`hide`（潜む）。`seconds`。自分に向けた技なら自分にかかる |
| `buff` | 強化 | `stat`：`power`（殴る威力）・`speed`（足の速さ）・`defense`（受けるダメージ。0.7で3割減）。`mult`、`seconds` |
| `dash` | 自分が素早く動く（壁で止まる） | `toward`：`target`（狙った所へ）・`away`（離れる）。`distance`、`invuln`（その間の無敵の秒数） |
| `teleport` | 狙った地点へ瞬間移動 | — |
| `projectile` | 飛び道具を撃つ（壁・物に当たると止まる） | `speed` `damage` `range` `count`（同時に何発）・`spread`（広がりの角度）・`radius`（当たった所で爆発する範囲）・`onHit`（当たった時の部品の配列）・`color` |
| `zone` | 場を置く | `kind`：`hazard`（中の敵に毎秒 `dps` ダメージ）・`slow`（中の敵の速さ×`mult`）・`smoke`（視線を遮る）・`caltrops`（走ると転ぶ）・`silence`（音が消える）。`radius` `seconds` |
| `noise` | 物音を立てる（囮） | `radius` |
| `reveal` | 周りの敵の居場所を感じ取る（味方にも伝わる） | `radius` |

### 例：雷の忍者

```json
"raijin": {
  "name": "雷遁", "desc": "前方に雷を走らせ、当たった敵を痺れさせる",
  "targets": ["enemy", "direction"], "range": 8,
  "hit": { "shape": "line", "length": 8, "width": 1.2 },
  "do": [
    { "type": "damage", "amount": 8 },
    { "type": "status", "status": "stun", "seconds": 1 }
  ]
},
"kawarimi": {
  "name": "変わり身", "desc": "煙を残して後ろへ跳ぶ",
  "targets": ["self"], "castTime": 0.1,
  "do": [
    { "type": "zone", "kind": "smoke", "radius": 2.5, "seconds": 5 },
    { "type": "dash", "toward": "away", "distance": 5, "invuln": 0.3 }
  ]
}
```

## 調整の目安

- 1回の攻撃のダメージ：素手 8〜17、技 8〜15、決め技 20前後。体力はおおむね 85〜110。
- 強すぎる技は `cooldown`（次に使えるまで）と `cost`（エネルギー）で抑えます。
- 追加したキャラの強さは、CPU 同士の観戦で確かめられます。
