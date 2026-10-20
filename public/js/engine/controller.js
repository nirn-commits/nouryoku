// ターン進行：入力ターン（時間停止）→ 双方の計画を同時に実行 → 次の入力ターン
// CPU は入力ターン開始時点の自分の観測だけから計画を立てる（プレイヤーの入力内容は見ない）
import { RULES } from './data.js';
import { compilePlan, planFinished } from './plan.js';
import { buildObservation } from './perception.js';
import { localCpuPlan } from './localAI.js';

export class TurnController {
  constructor(battle, { cpuRemote = null, cpuTimeoutMs = 95000 } = {}) {
    this.b = battle;
    this.cpuRemote = cpuRemote;
    this.cpuTimeoutMs = cpuTimeoutMs;
    this.turn = 0;
    this.phase = 'input'; // input | resolving | execute | over
    this.cpuPlanPromise = null;
    this.cpuSource = null;
    this.execStart = 0;
    this.remoteFailures = 0;
    this.beginInput();
  }

  // 入力ターン開始：時間は止まり、CPU はこの時点の観測で作戦を考え始める
  beginInput() {
    const b = this.b;
    if (b.over) { this.phase = 'over'; return; }
    this.turn++;
    this.phase = 'input';
    b.emit({ text: `―― 第${this.turn}手：入力ターン ――`, kind: 'system', all: true });
    this.cpuPlanPromise = this.planCpu();
  }

  async planCpu() {
    const b = this.b, c = b.cpu;
    if (this.cpuRemote && this.remoteFailures < 3) {
      const obs = buildObservation(b, c);
      try {
        const raw = await withTimeout(this.cpuRemote(obs), this.cpuTimeoutMs);
        const plan = compilePlan(b, c, raw, 'gemini');
        if (plan.steps.length || plan.speech) {
          this.remoteFailures = 0;
          return plan;
        }
      } catch (e) {
        this.remoteFailures++;
        b.emit({ text: `（CPU側の Gemini 呼び出しに失敗したため、CPU は簡易思考で行動します：${e.message}）`, kind: 'fail', all: true });
      }
    }
    return compilePlan(b, c, localCpuPlan(b, c), 'local');
  }

  // プレイヤーの計画が確定したら、CPU の計画を待って同時に実行を始める
  async commit(playerPlan) {
    if (this.phase !== 'input') return false;
    this.phase = 'resolving';
    const cpuPlan = await this.cpuPlanPromise;
    const b = this.b;
    if (b.over) { this.phase = 'over'; return false; }
    b.emit({ text: `―― 第${this.turn}手：実行 ――`, kind: 'system', all: true });
    b.setPlan(b.player, playerPlan);
    b.setPlan(b.cpu, cpuPlan);
    this.execStart = b.t;
    this.phase = 'execute';
    return true;
  }

  settled() {
    const b = this.b;
    if (b.world.projectiles.length) return false;
    if (b.world.objects.some(o => o.movable && Math.hypot(o.vx, o.vy) > 0.05)) return false;
    return b.chars.every(c => !c.alive || (Math.hypot(c.kbx, c.kby) < 0.2 && c.status.proneUntil <= b.t && c.status.stunUntil <= b.t));
  }

  // 実行中のみ時間を進める。両者の計画が終わり、場が落ち着いたら次の入力ターンへ
  step() {
    if (this.phase !== 'execute') return;
    const b = this.b;
    b.step();
    if (b.over) { this.phase = 'over'; return; }
    const elapsed = b.t - this.execStart;
    const done = elapsed > 0.3 && b.chars.every(c => !c.alive || planFinished(c)) && this.settled();
    if (done || elapsed > RULES.budgetSeconds + 3) {
      for (const c of b.chars) {
        if (!planFinished(c)) b.emit({ text: 'ターンの時間切れで残りの行動は打ち切られた', kind: 'fail', actor: c });
        c.runner.plan = null;
        c.runner.step = null;
        c.pendingPlan = null;
        c.windup = null;
        c.status.guardUntil = 0;
      }
      this.beginInput();
    }
  }
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
