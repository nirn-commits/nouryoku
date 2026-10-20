// CPU の思考タイミング管理。Gemini（remote）に問い合わせている間も戦場の時間は進み、
// 応答が遅い・失敗した場合はローカル思考で「安全な代替行動」を取る
import { compilePlan, planFinished } from './plan.js';
import { buildObservation } from './perception.js';
import { localCpuPlan } from './localAI.js';

export class CpuBrain {
  constructor(battle, char, { remote = null, minInterval = 2.5, periodic = 7 } = {}) {
    this.b = battle;
    this.c = char;
    this.remote = remote;
    this.minInterval = minInterval;
    this.periodic = periodic;
    this.pending = null;
    this.lastRequest = -99;
    this.lastLocal = -99;
    this.lastHeardCount = 0;
    this.lastDamaged = -99;
    this.status = 'idle';
    this.remoteFailures = 0;
  }

  triggers() {
    const b = this.b, c = this.c;
    if (planFinished(c)) return 'plan_done';
    if (b.t - this.lastRequest < this.minInterval) return null;
    if (c.lastDamagedAt > this.lastDamaged) return 'damaged';
    if (c.memory.newlySpotted) return 'spotted';
    const speech = c.memory.heard.filter(h => h.kind === 'speech').length;
    if (speech > this.lastHeardCount) return 'heard_speech';
    if (b.t - this.lastRequest > this.periodic) return 'periodic';
    return null;
  }

  useLocal(reason) {
    const plan = compilePlan(this.b, this.c, localCpuPlan(this.b, this.c), 'local');
    plan.reason = reason;
    this.b.setPlan(this.c, plan);
  }

  update() {
    const b = this.b, c = this.c;
    if (b.over || !c.alive) return;
    const why = this.triggers();
    if (!why) return;

    if (this.pending) {
      // 応答待ちで手持ちの計画が尽きた → 安全な代替行動
      if (why === 'plan_done' && b.t - this.lastRequest > 0.6) this.useLocal('応答待ちの代替行動');
      return;
    }
    // 直前の問い合わせから間もない場合は、AI に聞き直さずローカル思考でつなぐ
    if (why === 'plan_done' && b.t - this.lastRequest < this.minInterval) {
      if (b.t - this.lastLocal > 0.5) { this.lastLocal = b.t; this.useLocal('問い合わせ間隔の調整'); }
      return;
    }
    this.lastRequest = b.t;
    this.lastDamaged = c.lastDamagedAt;
    c.memory.newlySpotted = false;
    this.lastHeardCount = c.memory.heard.filter(h => h.kind === 'speech').length;

    if (!this.remote || this.remoteFailures >= 3) {
      this.useLocal(why);
      return;
    }
    const obs = buildObservation(b, c);
    obs.trigger = why;
    this.status = 'thinking';
    const battleRef = b;
    this.pending = this.remote(obs)
      .then(raw => {
        if (battleRef.over || !c.alive) return;
        const plan = compilePlan(battleRef, c, raw, 'gemini');
        if (!plan.steps.length && !plan.speech) throw new Error('empty plan');
        plan.reason = why;
        battleRef.setPlan(c, plan);
        this.remoteFailures = 0;
        this.status = 'ok';
      })
      .catch(() => {
        this.remoteFailures++;
        this.status = 'fallback';
        if (!battleRef.over && c.alive && planFinished(c)) this.useLocal('AI応答失敗の代替行動');
      })
      .finally(() => { this.pending = null; });
  }
}
