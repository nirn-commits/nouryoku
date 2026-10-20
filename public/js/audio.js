// 効果音：public/sound の音声ファイルを Web Audio で鳴らす（読み込めなければ鳴らさない）
// 出どころは public/sound/README.md（Kenney の CC0 素材と、このゲーム用に合成した音）

const FILES = [
  'hit_heavy', 'hit_light', 'guard', 'swing', 'crash', 'break', 'glass', 'door', 'fall', 'ko',
  'launch', 'flick', 'ricochet', 'scratch', 'roar', 'flame', 'stand', 'ability', 'siren', 'alarm',
];

export class Sound {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.enabled = true;
    this.last = {}; // 同じ音の連打を間引く
    this.ambience = null;
  }

  // ブラウザの制限で、最初のクリックなどの操作の後でないと音を出せないので、その時に呼ぶ
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    for (const name of [...FILES, 'ambience_town']) {
      fetch(`sound/${name}.mp3`).then(r => (r.ok ? r.arrayBuffer() : Promise.reject())).then(a => this.ctx.decodeAudioData(a))
        .then(buf => { this.buffers[name] = buf; if (name === 'ambience_town' && this.wantAmbience) this.startAmbience(); })
        .catch(() => { /* 無い音は鳴らさない */ });
    }
  }

  has(name) {
    return !!this.buffers[name];
  }

  // vol：0〜1、rate：再生速度（スロー中は低く）
  play(name, vol = 1, rate = 1) {
    if (!this.enabled || !this.ctx || !this.buffers[name] || vol <= 0.02) return false;
    const now = this.ctx.currentTime;
    if (this.last[name] && now - this.last[name] < 0.05) return true;
    this.last[name] = now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
    const g = this.ctx.createGain();
    g.gain.value = Math.min(1, vol);
    src.connect(g);
    g.connect(this.master);
    src.start();
    return true;
  }

  // 住宅街の環境音（小さく流し続ける）
  startAmbience() {
    this.wantAmbience = true;
    if (!this.enabled || !this.ctx || !this.buffers.ambience_town || this.ambience) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.ambience_town;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0.18;
    src.connect(g);
    g.connect(this.master);
    src.start();
    this.ambience = src;
  }

  stopAmbience() {
    this.wantAmbience = false;
    if (this.ambience) { try { this.ambience.stop(); } catch { /* 既に止まっている */ } }
    this.ambience = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stopAmbience();
  }
}
