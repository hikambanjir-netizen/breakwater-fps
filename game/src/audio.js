// audio.js — every sound in Breakwater is synthesised with WebAudio.
//
// No audio files ship in game/: the gunshot is filtered noise, the plant
// beep is a sine blip, the explosion is a low sine drop under noise. That
// keeps game/ small, the dossier honest, and the sounds original.

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
  }

  // Created on the first user gesture (browsers block audio before one).
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
  }

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _burst({ dur, freq, q, gain, type = 'bandpass' }) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur);
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  _tone({ freq, dur, gain, type = 'sine', slideTo = null }) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  // One sound per sim event the HUD/view cares about.
  shot(gunId) {
    const table = {
      harbour45: { freq: 900, gain: 0.5, dur: 0.12 },
      gale: { freq: 1400, gain: 0.32, dur: 0.09 },
      breaker: { freq: 700, gain: 0.55, dur: 0.14 },
      longshore: { freq: 500, gain: 0.7, dur: 0.22 },
      tide: { freq: 600, gain: 0.65, dur: 0.2 },
    };
    const s = table[gunId] ?? table.breaker;
    this._burst({ dur: s.dur, freq: s.freq, q: 0.8, gain: s.gain });
    this._tone({ freq: 160, dur: 0.08, gain: 0.25, type: 'triangle', slideTo: 70 });
  }

  hit(head) {
    this._tone({ freq: head ? 1900 : 1400, dur: 0.06, gain: 0.3, type: 'square' });
  }

  reload() {
    this._tone({ freq: 700, dur: 0.04, gain: 0.2, type: 'square' });
    setTimeout(() => this._tone({ freq: 500, dur: 0.04, gain: 0.2, type: 'square' }), 120);
  }

  plantBeep() { this._tone({ freq: 1200, dur: 0.09, gain: 0.3 }); }

  explosion() {
    this._burst({ dur: 1.1, freq: 180, q: 0.6, gain: 0.9, type: 'lowpass' });
    this._tone({ freq: 90, dur: 0.9, gain: 0.6, type: 'sine', slideTo: 32 });
  }

  roundWin() {
    [523, 659, 784].forEach((f, i) => setTimeout(() => this._tone({ freq: f, dur: 0.18, gain: 0.25 }), i * 110));
  }

  roundLose() {
    [392, 330].forEach((f, i) => setTimeout(() => this._tone({ freq: f, dur: 0.22, gain: 0.22 }), i * 140));
  }

  click() { this._tone({ freq: 900, dur: 0.03, gain: 0.15, type: 'square' }); }

  step() { this._burst({ dur: 0.05, freq: 300, q: 1, gain: 0.08, type: 'lowpass' }); }
}
