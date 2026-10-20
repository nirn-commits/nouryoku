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
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 12000);
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
- trigger は今回考え直すきっかけ（plan_done=手順を終えた / damaged=攻撃を受けた / spotted=敵を発見 / heard_speech=声が聞こえた / periodic=定期）。
- speech は相手に聞こえうる短いセリフ（任意。毎回は不要。キャラクターらしく、心理戦や挑発・はったりも可）。heard に相手の言葉があれば反応してよい。
- rejected は通常は空配列でよい。
${COMMON_RULES}`;
}

async function callGemini(systemText, userText) {
  const url = `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: PLAN_SCHEMA,
    },
  };
  if (process.env.GEMINI_THINKING_BUDGET) {
    body.generationConfig.thinkingConfig = { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET) };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const plan = JSON.parse(text);
    if (!plan || !Array.isArray(plan.steps)) throw new Error('計画の形式が不正');
    return plan;
  } finally {
    clearTimeout(timer);
  }
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
    console.error(`[gemini] ${role}: ${e.message}`);
    sendJson(res, 502, { error: e.name === 'AbortError' ? 'Gemini の応答がタイムアウトしました' : 'Gemini の呼び出しに失敗しました' });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, HOST, () => {
    console.log(`能力バトル: http://${HOST}:${PORT}/`);
    console.log(API_KEY ? `Gemini: 有効（${MODEL}）` : 'Gemini: 無効（GEMINI_API_KEY 未設定のため、ローカル解析で動作します）');
  });
}
