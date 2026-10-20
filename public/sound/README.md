# 効果音

戦闘中の効果音です。`public/js/audio.js` が読み込み、聞こえた音の種類・距離に応じて鳴らします（遠い音ほど小さく、スロー中は低く）。戦闘画面の「効果音」ボタンで ON/OFF できます。

## 出どころ

| ファイル | 使う場面 | 出どころ |
| --- | --- | --- |
| `hit_heavy.mp3` | 大ダメージの打撃（15以上） | Kenney「Starter Kit Racing」impact.ogg（CC0） |
| `hit_light.mp3` | 小さな打撃 | Kenney「Starter Kit FPS」enemy_hurt.ogg（CC0） |
| `crash.mp3` | 壁・物が壊れる | Kenney「Starter Kit City Builder」removal-a.ogg（CC0） |
| `break.mp3` | 物を殴る・物に当たる | Kenney「Starter Kit 3D Platformer」break.ogg（CC0） |
| `fall.mp3` | 着地・転倒 | Kenney「Starter Kit 3D Platformer」fall.ogg（CC0） |
| `ko.mp3` | 再起不能 | Kenney「Starter Kit FPS」enemy_destroy.ogg（CC0） |
| `door.mp3` | 扉・窓の開閉 | Kenney「Starter Kit City Builder」placement-a.ogg（CC0） |
| `ambience_town.mp3` | 住宅街の環境音（小さく流し続ける） | Kenney「Starter Kit City Builder」ambience.ogg（CC0） |
| `glass.mp3` | ガラス・花瓶・瓶が割れる | このゲーム用に合成 |
| `ricochet.mp3` | 跳弾 | このゲーム用に合成 |
| `flick.mp3` | 玉を指で弾く | このゲーム用に合成 |
| `launch.mp3` | パーペンディキュラーの弾き出し（「カチッ」＋風切り） | このゲーム用に合成 |
| `swing.mp3` | 振りかぶり・空振り・投擲 | このゲーム用に合成 |
| `guard.mp3` | ガード | このゲーム用に合成 |
| `scratch.mp3` | エコー・ビーチの引っかき | このゲーム用に合成 |
| `roar.mp3` | エコー・ビーチの轟音 | このゲーム用に合成 |
| `flame.mp3` | ホテル・カリフォルニアの炎 | このゲーム用に合成 |
| `stand.mp3` | スタンドが現れる | このゲーム用に合成 |
| `ability.mp3` | 能力発動（予備） | このゲーム用に合成 |
| `siren.mp3` | パトカーのサイレン（時間制限の予告） | このゲーム用に合成 |
| `alarm.mp3` | 車の防犯アラーム | このゲーム用に合成 |

Kenney の素材は CC0（パブリックドメイン相当）で、クレジット表記なしで自由に使えます（https://kenney.nl）。
差し替えたい場合は、同じ名前の mp3 を置けばそちらが鳴ります。
