// ローカル用サーバー：静的ファイルの配信と、Gemini API への中継（APIキーはここにだけ置く）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rulesSummary } from './public/js/engine/perception.js';
import { ACTIONS, CONDITIONS, DIRECTIONS } from './public/js/engine/data.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// .env を簡易的に読み込む（既に環境変数があればそちらを優先）
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env は任意 */ }

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Gemini に返させる行動計画の形式（ゲーム側でも compilePlan で再検証する）
const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    interpretation: { type: 'STRING' },
    speech: { type: 'STRING', nullable: true },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', enum: Object.keys(ACTIONS) },
          mode: { type: 'STRING', enum: ['walk', 'run'], nullable: true },
          targetType: { type: 'STRING', enum: ['enemy', 'self', 'object', 'point', 'projectile', 'direction', 'none'] },
          targetId: { type: 'STRING', nullable: true },
          x: { type: 'NUMBER', nullable: true },
          y: { type: 'NUMBER', nullable: true },
          direction: { type: 'STRING', enum: DIRECTIONS, nullable: true },
          distance: { type: 'NUMBER', nullable: true },
          ability: { type: 'STRING', nullable: true },
          effect: { type: 'STRING', nullable: true },
          duration: { type: 'NUMBER', nullable: true },
          condition: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              kind: { type: 'STRING', enum: Object.keys(CONDITIONS) },
              value: { type: 'NUMBER', nullable: true },
              timeout: { type: 'NUMBER', nullable: true },
            },
            required: ['kind'],
          },
        },
        required: ['action', 'targetType'],
      },
    },
    rejected: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['interpretation', 'steps', 'rejected'],
};

const COMMON_RULES = `
# 進行の仕組み
- 戦闘はターン制。入力ターン（時間停止）に双方が同時に計画を立て、その後、両者の計画が同時に実行される。
- 相手の今回の計画は分からない。実行中に相手も動くので、敵に近づく・追う時は move ではなく chase（追尾）を使う。
- 状況に応じて動きたい時は condition（条件付き行動）を使う。

# 出力の規則
- steps[].action は rules.actions の id のみ。能力を使う場合は action="ability" とし、ability と effect に observation.self.abilities の id を正確に入れる。
- targetType: enemy=敵 / self=自分 / object=戦場の物体・建物・扉（targetId に observation.map.landmarks の id）/ point=座標（x,y メートル）/ projectile=飛来物 / direction=方向（direction に rules.directions のいずれか。cover=物陰）/ none=対象なし。
- 能力の効果ごとに使える targetType が決まっている（abilities[].effects[].targets）。合わない組み合わせは使わない。
- 存在しない能力・効果やルールにない現象（時間停止・瞬間移動・回復・発火など）を作らない。実行できない部分は steps に入れず rejected に日本語で理由を書く。
- 条件付き行動（「〜したら」）は、その行動の step の condition に入れる（kind は rules.conditions のキー）。
- 1回の計画は最大5手順。行動予算（見積もり10秒）を超えた手順は捨てられるので、重要な手順を先に置く。
- melee は射程外なら自動で接近する。窓から外を見るなら「窓へ move」→「窓を look」。
- 左右は画面の左右（x が小さい方が左）、上は y が小さい方（奥）。
- interpretation には計画の要約を日本語1文で書く。
- 観測情報に書かれていない敵の位置や能力を、事実として扱わない。`;

function playerPrompt() {
  return `あなたは2D見下ろし型の超能力バトルゲームの「行動解析器」です。
プレイヤーが自然文で書いた行動指示を、ゲームエンジンが実行できる構造化された行動計画（JSON）に変換します。
勝敗やダメージはゲームエンジンが決めるので、あなたは指示の意図を忠実に手順へ落とし込むだけにしてください。
- 指示に無い行動を勝手に付け足さない（実行に不可欠な移動は可）。
- 指示文中の「」『』内はセリフ。speech に入れ、行動としては扱わない。
- 曖昧な指示は戦況（observation）から最も自然な解釈を選ぶ。
${COMMON_RULES}`;
}

function cpuPrompt(character) {
  return `あなたは2D見下ろし型の超能力バトルゲームに登場するCPUキャラクター「${character.name}」（スタンド『${character.stand}』）の頭脳です。
性格・戦術：${character.personality}
observation（あなた自身が見聞きした情報だけ）をもとに、次の数秒の行動計画を立ててください。
- 相手の能力は observed_enemy_abilities に書かれた観察結果しか知らない。推理はしてよいが、確定事項として扱わない。
- 敵が見えていなければ、最後に見た位置（enemy.last_seen）や物音（heard）から推測して行動する。
- 自分の能力（self.abilities）の射程・クールダウン（self.cooldowns）・スタンドエネルギー（self.sp）を守る。
- recent_events には前のターンの出来事が入っている。前のターンに見聞きした相手の行動から、次の手を読む。
- speech は相手に聞こえうる短いセリフ（任意。毎回は不要。キャラクターらしく、心理戦や挑発・はったりも可）。heard に相手の言葉があれば反応してよい。
- rejected は通常は空配列でよい。
${COMMON_RULES}`;
}

// Gemini の失敗理由を、原因の分かる日本語にする（APIキーそのものは含めない）
class GeminiError extends Error {
  constructor(message, detail = '', fatal = false) {
    super(message);
    this.detail = detail;
    this.fatal = fatal;
  }
}

function explainHttp(status, bodyText) {
  let msg = '';
  try { msg = JSON.parse(bodyText)?.error?.message || ''; } catch { msg = bodyText.slice(0, 200); }
  const hint = {
    400: 'リクエストの形式かモデル名が受け付けられませんでした',
    401: 'APIキーが無効です（.env の GEMINI_API_KEY を確認してください）',
    403: 'APIキーに権限がありません（キーの制限設定や、Gemini API が有効かを確認してください）',
    404: `モデル「${MODEL}」が見つかりません（.env の GEMINI_MODEL を確認してください）`,
    429: '利用上限に達しました（しばらく待つか、無料枠の上限を確認してください）',
  }[status] || (status >= 500 ? 'Gemini 側の一時的な障害です' : 'Gemini の呼び出しに失敗しました');
  // 400 でも本文で原因が分かるもの（再試行しても直らない）
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return new GeminiError(`APIキーが無効です（.env の GEMINI_API_KEY を確認してください）（HTTP ${status}）`, msg, true);
  if (/location is not supported/i.test(msg)) return new GeminiError(`お使いの地域からは Gemini API を利用できません（HTTP ${status}）`, msg, true);
  if (/not found|is not supported for generateContent/i.test(msg)) return new GeminiError(`モデル「${MODEL}」が使えません（.env の GEMINI_MODEL を確認してください）（HTTP ${status}）`, msg, true);
  return new GeminiError(`${hint}（HTTP ${status}）`, msg);
}

// 応答文から JSON を取り出す（```json で囲まれていても読めるように）
function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* 続けて探す */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('JSON が見つからない');
}

async function requestOnce(body) {
  if (typeof fetch !== 'function') throw new GeminiError('Node.js が古いため通信できません（18 以上が必要です）');
  const url = `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new GeminiError(`Gemini の応答が${Math.round(TIMEOUT_MS / 1000)}秒以内に返りませんでした（.env の GEMINI_TIMEOUT_MS で延長できます）`);
      throw new GeminiError('Gemini に接続できませんでした（インターネット接続やプロキシ設定を確認してください）', e.cause?.code || e.message);
    }
    const textBody = await res.text();
    if (!res.ok) {
      const err = explainHttp(res.status, textBody);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(textBody);
    const cand = data?.candidates?.[0];
    if (!cand) {
      const reason = data?.promptFeedback?.blockReason;
      throw new GeminiError(reason ? `入力が安全フィルタで止められました（${reason}）` : 'Gemini から応答の候補が返りませんでした');
    }
    const text = cand.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) throw new GeminiError(`Gemini の応答が空でした（終了理由：${cand.finishReason || '不明'}）`);
    let plan;
    try {
      plan = extractJson(text);
    } catch {
      throw new GeminiError(`Gemini の応答を JSON として読めませんでした（終了理由：${cand.finishReason || '不明'}）`, text.slice(0, 200));
    }
    if (!plan || typeof plan !== 'object') throw new GeminiError('計画の形式が不正です');
    if (!Array.isArray(plan.steps)) plan.steps = [];
    if (!Array.isArray(plan.rejected)) plan.rejected = [];
    return plan;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(systemText, userText) {
  const base = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
  };
  const thinking = process.env.GEMINI_THINKING_BUDGET !== undefined && process.env.GEMINI_THINKING_BUDGET !== ''
    ? { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET) }
    : null;
  // モデルによっては応答スキーマや思考設定を受け付けないので、400 の場合は設定を減らして再試行する
  const variants = [
    { temperature: 0.4, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA, ...(thinking ? { thinkingConfig: thinking } : {}) },
    { temperature: 0.4, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA },
    { temperature: 0.4, responseMimeType: 'application/json' },
  ];
  if (!thinking) variants.shift();
  let lastErr;
  for (const [i, generationConfig] of variants.entries()) {
    try {
      const sys = i === variants.length - 1
        ? `${systemText}\n\n# 出力形式（JSON）\n${JSON.stringify(PLAN_SCHEMA)}`
        : systemText;
      return await requestOnce({ ...base, systemInstruction: { parts: [{ text: sys }] }, generationConfig });
    } catch (e) {
      lastErr = e;
      if (e.status !== 400 || e.fatal) break;
      console.error(`[gemini] 設定を減らして再試行します：${e.message} ${e.detail || ''}`);
    }
  }
  throw lastErr;
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', ch => {
      size += ch.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handlePlan(req, res) {
  if (!API_KEY) return sendJson(res, 503, { error: 'GEMINI_API_KEY が設定されていません' });
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'リクエストが不正です' });
  }
  const { role, text, observation, character } = input || {};
  if (!observation || (role !== 'player' && role !== 'cpu')) return sendJson(res, 400, { error: 'role/observation が必要です' });
  const rules = rulesSummary();
  const system = role === 'player' ? playerPrompt() : cpuPrompt(character || {});
  const user = role === 'player'
    ? `# ルール\n${JSON.stringify(rules)}\n\n# 戦況（プレイヤーキャラクターの観測）\n${JSON.stringify(observation)}\n\n# プレイヤーの行動指示\n${String(text || '').slice(0, 400)}`
    : `# ルール\n${JSON.stringify(rules)}\n\n# あなたの観測\n${JSON.stringify(observation)}`;
  const started = Date.now();
  try {
    const plan = await callGemini(system, user);
    sendJson(res, 200, { plan, ms: Date.now() - started, model: MODEL });
  } catch (e) {
    console.error(`[gemini] ${role}: ${e.message}${e.detail ? `\n  詳細: ${e.detail}` : ''}`);
    sendJson(res, 502, { error: e instanceof GeminiError ? e.message : `Gemini の呼び出しに失敗しました（${e.message}）`, detail: e.detail || '' });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.url === '/api/status' && req.method === 'GET') return sendJson(res, 200, { gemini: !!API_KEY, model: MODEL });
    if (req.url === '/api/plan' && req.method === 'POST') return void handlePlan(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end();
  });
}

async function checkGemini() {
  console.log(`Node.js ${process.version} / モデル: ${MODEL}`);
  if (!API_KEY) { console.log('✕ GEMINI_API_KEY が設定されていません（.env を確認してください）'); process.exit(1); }
  console.log(`APIキー: 設定あり（末尾 …${API_KEY.slice(-4)}）`);
  const started = Date.now();
  try {
    const plan = await callGemini(playerPrompt(), `# ルール\n${JSON.stringify(rulesSummary())}\n\n# 戦況\n{"self":{"pos":[3,20],"abilities":[]},"enemy":{"visible":false},"map":{"landmarks":[{"id":"house_left","name":"左の家","kind":"building"}]}}\n\n# プレイヤーの行動指示\n左の家へ走る`);
    console.log(`✓ 接続成功（${Date.now() - started}ms）`);
    console.log(JSON.stringify(plan, null, 1));
  } catch (e) {
    console.log(`✕ ${e.message}`);
    if (e.detail) console.log(`  詳細: ${e.detail}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--check')) {
  await checkGemini();
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`能力バトル: http://${HOST}:${PORT}/`);
    console.log(API_KEY ? `Gemini: 有効（${MODEL}）` : 'Gemini: 無効（GEMINI_API_KEY 未設定のため、ローカル解析で動作します）');
  });
}
