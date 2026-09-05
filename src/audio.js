// Procedural WebAudio sound effects (no external assets).
import * as THREE from 'three';
import { clamp, rand, choose } from './util.js';

class Sfx {
  constructor() {
    this.ctx = null; this.master = null; this.noiseBuf = null; this.volume = 0.55;
    this.listenerPos = new THREE.Vector3(); this.listenerRight = new THREE.Vector3(1, 0, 0);
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -16; this.comp.ratio.value = 5;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2; this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setListener(pos, right) { this.listenerPos.copy(pos); this.listenerRight.copy(right); }
  _out(pos, base = 1) {
    const ctx = this.ctx; const g = ctx.createGain(); let vol = base;
    if (pos) {
      const dx = pos.x - this.listenerPos.x, dy = pos.y - this.listenerPos.y, dz = pos.z - this.listenerPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      vol *= 1 / (1 + dist * 0.09);
      if (dist > 0.5 && ctx.createStereoPanner) {
        const pan = clamp((dx * this.listenerRight.x + dz * this.listenerRight.z) / dist, -1, 1) * 0.75;
        const p = ctx.createStereoPanner(); p.pan.value = pan; g.gain.value = vol; g.connect(p); p.connect(this.master); return g;
      }
    }
    g.gain.value = vol; g.connect(this.master); return g;
  }
  noise({ dur = 0.1, gain = 0.5, type = 'lowpass', freq = 1000, freqEnd = null, q = 1, attack = 0.002, pos = null, delay = 0, hp = 0, at }) {
    if (!this.ctx) return; const ctx = this.ctx; const t0 = at !== undefined ? at : ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.loopEnd = 2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur); f.Q.value = q;
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + attack); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); let last = f;
    if (hp > 0) { const h = ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; last.connect(h); last = h; }
    last.connect(env); env.connect(this._out(pos));
    src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
  tone({ freq = 440, freqEnd = null, dur = 0.2, gain = 0.3, type = 'sine', attack = 0.005, pos = null, delay = 0, at, out }) {
    if (!this.ctx) return; const ctx = this.ctx; const t0 = at !== undefined ? at : ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    const env = ctx.createGain(); env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + attack); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(env); env.connect(out || this._out(pos)); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // ---------- game sounds ----------
  shot() {
    this.noise({ dur: 0.17, gain: 0.7, type: 'bandpass', freq: 1200, freqEnd: 250, q: 0.7 });
    this.noise({ dur: 0.06, gain: 0.45, type: 'highpass', freq: 2800 });
    this.tone({ freq: 160, freqEnd: 40, dur: 0.15, gain: 0.6, type: 'triangle' });
  }
  enemyShot(pos) {
    this.noise({ dur: 0.14, gain: 0.5, type: 'bandpass', freq: rand(900, 1500), freqEnd: 200, q: 0.8, pos });
    this.tone({ freq: 220, freqEnd: 60, dur: 0.1, gain: 0.3, type: 'square', pos });
  }
  shotgun(pos) {
    this.noise({ dur: 0.3, gain: 0.7, type: 'lowpass', freq: 1500, freqEnd: 150, pos });
    this.tone({ freq: 90, freqEnd: 30, dur: 0.25, gain: 0.5, type: 'triangle', pos });
  }
  sniperShot(pos) {
    this.noise({ dur: 0.35, gain: 0.7, type: 'bandpass', freq: 700, freqEnd: 120, q: 0.5, pos });
    this.tone({ freq: 400, freqEnd: 50, dur: 0.3, gain: 0.35, type: 'sawtooth', pos });
  }
  sniperAim(pos) { this.tone({ freq: 1800, dur: 0.12, gain: 0.12, type: 'sine', pos }); }
  empty() { this.noise({ dur: 0.03, gain: 0.3, type: 'highpass', freq: 3000 }); }
  winded() { this.tone({ freq: 220, freqEnd: 140, dur: 0.14, gain: 0.1, type: 'triangle' }); }
  reload() {
    this.noise({ dur: 0.04, gain: 0.35, type: 'highpass', freq: 2500 });
    this.noise({ dur: 0.12, gain: 0.2, type: 'bandpass', freq: 600, q: 2, delay: 0.25 });
    this.noise({ dur: 0.05, gain: 0.4, type: 'highpass', freq: 2000, delay: 0.9 });
    this.tone({ freq: 900, freqEnd: 500, dur: 0.06, gain: 0.15, type: 'square', delay: 1.25 });
  }
  katanaSwing() { this.noise({ dur: 0.2, gain: 0.35, type: 'bandpass', freq: 500, freqEnd: 3000, q: 1.5 }); }
  katanaHit() {
    this.noise({ dur: 0.14, gain: 0.6, type: 'lowpass', freq: 900, freqEnd: 200 });
    this.noise({ dur: 0.1, gain: 0.35, type: 'bandpass', freq: 2500, q: 0.6 });
    this.tone({ freq: 180, freqEnd: 70, dur: 0.12, gain: 0.4, type: 'triangle' });
  }
  parry() {
    for (const f of [2200, 3300, 4700]) this.tone({ freq: f, freqEnd: f * 0.92, dur: 0.35, gain: 0.16, type: 'sine' });
    this.noise({ dur: 0.05, gain: 0.5, type: 'highpass', freq: 4000 });
  }
  perfectParry() { this.parry(); this.tone({ freq: 880, freqEnd: 1760, dur: 0.25, gain: 0.2, type: 'triangle', delay: 0.03 }); }
  grappleFire() { this.noise({ dur: 0.1, gain: 0.4, type: 'highpass', freq: 1500 }); this.tone({ freq: 500, freqEnd: 1500, dur: 0.18, gain: 0.18, type: 'sawtooth' }); }
  grappleHit() { this.noise({ dur: 0.04, gain: 0.45, type: 'highpass', freq: 2000 }); this.tone({ freq: 300, freqEnd: 200, dur: 0.08, gain: 0.25, type: 'square' }); }
  grappleRelease() { this.tone({ freq: 900, freqEnd: 300, dur: 0.12, gain: 0.12, type: 'sawtooth' }); }
  reelLoop(on) {
    if (!this.ctx) return;
    if (on && !this._reel) { const ctx = this.ctx; const o = ctx.createBufferSource(); o.buffer = this.noiseBuf; o.loop = true; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 0.7; const g = ctx.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(0.05, ctx.currentTime, 0.12); o.connect(f); f.connect(g); g.connect(this.master); o.start(); this._reel = { o, g }; }
    else if (!on && this._reel) { const r = this._reel; this._reel = null; r.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); r.o.stop(this.ctx.currentTime + 0.3); }
  }
  footstep(speedFrac = 1) { this.noise({ dur: 0.07, gain: 0.12 * speedFrac, type: 'lowpass', freq: rand(400, 800) }); }
  jump() { this.tone({ freq: 260, freqEnd: 480, dur: 0.1, gain: 0.1, type: 'triangle' }); this.noise({ dur: 0.05, gain: 0.1, type: 'lowpass', freq: 600 }); }
  land(hard = 0.5) { this.noise({ dur: 0.14, gain: 0.15 + 0.35 * hard, type: 'lowpass', freq: 350 }); }
  slide() { this.noise({ dur: 0.45, gain: 0.18, type: 'lowpass', freq: 1200, freqEnd: 300 }); }
  wallJump() { this.noise({ dur: 0.08, gain: 0.25, type: 'lowpass', freq: 700 }); this.tone({ freq: 300, freqEnd: 600, dur: 0.12, gain: 0.12, type: 'triangle' }); }
  mantle() { this.noise({ dur: 0.2, gain: 0.2, type: 'lowpass', freq: 900, freqEnd: 300 }); }
  dash() { this.noise({ dur: 0.25, gain: 0.3, type: 'bandpass', freq: 800, freqEnd: 2500, q: 1 }); }
  hurt() { this.tone({ freq: 200, freqEnd: 90, dur: 0.2, gain: 0.35, type: 'sawtooth' }); this.noise({ dur: 0.12, gain: 0.3, type: 'lowpass', freq: 500 }); }
  death() { this.tone({ freq: 220, freqEnd: 30, dur: 1.2, gain: 0.4, type: 'sawtooth' }); this.noise({ dur: 0.8, gain: 0.35, type: 'lowpass', freq: 800, freqEnd: 80 }); }
  hitEnemy(pos) { this.noise({ dur: 0.06, gain: 0.3, type: 'lowpass', freq: 900, pos }); this.tone({ freq: rand(200, 260), freqEnd: 120, dur: 0.1, gain: 0.15, type: 'square', pos }); }
  headshot(pos) { this.noise({ dur: 0.05, gain: 0.5, type: 'highpass', freq: 3000, pos }); this.tone({ freq: 1500, freqEnd: 500, dur: 0.09, gain: 0.2, type: 'triangle', pos }); }
  enemyDie(pos) {
    this.tone({ freq: rand(160, 220), freqEnd: 40, dur: 0.4, gain: 0.3, type: 'sawtooth', pos });
    this.noise({ dur: 0.3, gain: 0.4, type: 'lowpass', freq: 600, freqEnd: 100, pos });
    this.noise({ dur: 0.12, gain: 0.3, type: 'bandpass', freq: 1400, q: 1, pos, delay: 0.03 });
  }
  gib(pos) { this.noise({ dur: 0.2, gain: 0.45, type: 'lowpass', freq: 500, freqEnd: 120, pos }); this.noise({ dur: 0.1, gain: 0.3, type: 'bandpass', freq: 2000, q: 0.8, pos, delay: 0.02 }); }
  splat(pos) { this.noise({ dur: 0.08, gain: 0.15, type: 'lowpass', freq: 700, pos }); }
  spawn(pos) { for (let i = 0; i < 5; i++) this.noise({ dur: 0.04, gain: 0.25, type: 'bandpass', freq: rand(2500, 5000), q: 2, pos, delay: i * 0.05 }); }
  lunge(pos) { this.tone({ freq: 200, freqEnd: 700, dur: 0.3, gain: 0.25, type: 'sawtooth', pos }); }
  bulletImpact(pos) { this.noise({ dur: 0.05, gain: 0.25, type: 'highpass', freq: 1500, pos }); }
  ricochet(pos) { this.tone({ freq: rand(2000, 3500), freqEnd: 800, dur: 0.15, gain: 0.12, type: 'sine', pos }); }
  pickup() { this.tone({ freq: 700, freqEnd: 1100, dur: 0.1, gain: 0.2, type: 'triangle' }); this.tone({ freq: 1100, freqEnd: 1500, dur: 0.15, gain: 0.2, type: 'triangle', delay: 0.09 }); }
  wave() { const notes = [440, 554, 659, 880]; notes.forEach((f, i) => this.tone({ freq: f, dur: 0.22, gain: 0.18, type: 'triangle', delay: i * 0.11 })); }
  waveClear() { const notes = [659, 880, 1108, 1318]; notes.forEach((f, i) => this.tone({ freq: f, dur: 0.3, gain: 0.16, type: 'triangle', delay: i * 0.13 })); }
  tick() { this.noise({ dur: 0.02, gain: 0.2, type: 'highpass', freq: 4000 }); }
  hitstop() { this.tone({ freq: 60, dur: 0.1, gain: 0.3, type: 'sine' }); }
  switchWeapon() { this.noise({ dur: 0.05, gain: 0.25, type: 'bandpass', freq: 1800, q: 1.5 }); }
  heartbeat() { this.tone({ freq: 55, dur: 0.15, gain: 0.35, type: 'sine' }); this.tone({ freq: 50, dur: 0.12, gain: 0.25, type: 'sine', delay: 0.18 }); }

  // ---------- more weapons / movement ----------
  shotgunFire() {
    this.noise({ dur: 0.32, gain: 0.9, type: 'lowpass', freq: 1800, freqEnd: 120 }); this.noise({ dur: 0.08, gain: 0.5, type: 'highpass', freq: 2500 });
    this.tone({ freq: 110, freqEnd: 30, dur: 0.28, gain: 0.7, type: 'triangle' });
  }
  revolver() {
    this.noise({ dur: 0.22, gain: 0.85, type: 'bandpass', freq: 900, freqEnd: 180, q: 0.6 }); this.noise({ dur: 0.05, gain: 0.6, type: 'highpass', freq: 3000 });
    this.tone({ freq: 200, freqEnd: 35, dur: 0.22, gain: 0.7, type: 'sawtooth' }); this.tone({ freq: 2600, freqEnd: 900, dur: 0.12, gain: 0.12, type: 'sine' });
  }
  sniperFire() {
    this.noise({ dur: 0.45, gain: 0.95, type: 'bandpass', freq: 1400, freqEnd: 90, q: 0.5 });
    this.noise({ dur: 0.07, gain: 0.7, type: 'highpass', freq: 3500 });
    this.tone({ freq: 260, freqEnd: 30, dur: 0.4, gain: 0.8, type: 'sawtooth' });
    this.tone({ freq: 1800, freqEnd: 400, dur: 0.5, gain: 0.16, type: 'sine', delay: 0.05 });
  }
  focusIn() { this.tone({ freq: 1200, freqEnd: 420, dur: 0.45, gain: 0.3, type: 'sine' }); this.noise({ dur: 0.35, gain: 0.2, type: 'bandpass', freq: 2400, freqEnd: 500, q: 1.2 }); }
  focusSlash() { this.noise({ dur: 0.3, gain: 0.55, type: 'bandpass', freq: 600, freqEnd: 4000, q: 1.2 }); this.tone({ freq: 180, freqEnd: 60, dur: 0.3, gain: 0.55, type: 'triangle' }); for (const f of [1600, 2400]) this.tone({ freq: f, freqEnd: f * 0.6, dur: 0.35, gain: 0.14, type: 'sine', delay: 0.04 }); }
  pump() { this.noise({ dur: 0.05, gain: 0.35, type: 'bandpass', freq: 1500, q: 1.5 }); this.noise({ dur: 0.06, gain: 0.35, type: 'bandpass', freq: 900, q: 1.5, delay: 0.09 }); }
  shell() { this.noise({ dur: 0.04, gain: 0.3, type: 'highpass', freq: 2500 }); this.tone({ freq: 1400, freqEnd: 900, dur: 0.05, gain: 0.08, type: 'square' }); }
  cylinder() { this.noise({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 2000 }); this.tone({ freq: 700, freqEnd: 400, dur: 0.12, gain: 0.1, type: 'square', delay: 0.05 }); this.noise({ dur: 0.06, gain: 0.35, type: 'highpass', freq: 1800, delay: 1.6 }); }
  explosion(pos) { this.noise({ dur: 0.7, gain: 0.9, type: 'lowpass', freq: 900, freqEnd: 60, pos }); this.tone({ freq: 80, freqEnd: 25, dur: 0.6, gain: 0.7, type: 'triangle', pos }); this.noise({ dur: 0.15, gain: 0.4, type: 'bandpass', freq: 3000, q: 0.7, pos }); }
  fuse(pos) { this.noise({ dur: 0.12, gain: 0.25, type: 'highpass', freq: 5000, pos }); }
  flyerDive(pos) { this.tone({ freq: 900, freqEnd: 300, dur: 0.35, gain: 0.2, type: 'sawtooth', pos }); this.noise({ dur: 0.3, gain: 0.15, type: 'bandpass', freq: 2500, freqEnd: 800, q: 1, pos }); }
  flyerBuzz(pos) { this.tone({ freq: rand(380, 460), dur: 0.14, gain: 0.05, type: 'sawtooth', pos }); }
  stomp(pos) { this.noise({ dur: 0.4, gain: 0.8, type: 'lowpass', freq: 400, freqEnd: 60, pos }); this.tone({ freq: 60, freqEnd: 25, dur: 0.5, gain: 0.7, type: 'sine', pos }); }
  bossRoar(pos) { this.tone({ freq: 90, freqEnd: 60, dur: 0.9, gain: 0.5, type: 'sawtooth', pos }); this.noise({ dur: 0.8, gain: 0.4, type: 'bandpass', freq: 500, q: 0.8, pos }); }
  shieldHit(pos) { this.tone({ freq: rand(600, 800), freqEnd: 300, dur: 0.12, gain: 0.2, type: 'square', pos }); this.noise({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 3000, pos }); }
  airdrop() { this.tone({ freq: 660, dur: 0.15, gain: 0.15, type: 'triangle' }); this.tone({ freq: 880, dur: 0.2, gain: 0.15, type: 'triangle', delay: 0.15 }); }
  crateLand(pos) { this.noise({ dur: 0.3, gain: 0.6, type: 'lowpass', freq: 500, freqEnd: 80, pos }); }
  // ---------- music: an 8-bit theme, two pulse voices, a triangle bass, an arpeggio and drums ----------
  musicOn(on) {
    if (!this.ctx) return;
    if (on && !this._mus) { this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.13; this.musicGain.connect(this.master); this._mus = { step: 0, next: this.ctx.currentTime + 0.1, timer: setInterval(() => this._musicTick(), 100) }; }
    else if (!on && this._mus) { clearInterval(this._mus.timer); this._mus = null; if (this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2); }
  }
  get musicPlaying() { return !!this._mus; }
  setIntensity(v) { this._intensity = clamp(v, 0, 1); }
  _musicTick() {
    const ctx = this.ctx, m = this._mus; if (!m) return; const I = this._intensity || 0; const out = this.musicGain;
    const bpm = 156, step = 60 / bpm / 4; const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    // a throttled tab can fall far behind; skip forward rather than replaying every missed note
    if (m.next < ctx.currentTime - 0.8) m.next = ctx.currentTime + 0.05;
    while (m.next < ctx.currentTime + 0.7) {
      const t = m.next, i = m.step % TUNE.length, bar = Math.floor(i / 16) % 8, s16 = i % 16;
      const chord = TUNE.chords[bar]; const root = chord[0];
      // lead: pulse, with a soft octave shadow on the second half of the loop for lift
      const n = TUNE.lead[i];
      if (n > 0) { const len = TUNE.len[i] * step; this.tone({ freq: midi(n), dur: len * 0.92, gain: 0.11, type: 'square', at: t, out }); if (m.step % (TUNE.length * 2) >= TUNE.length) this.tone({ freq: midi(n + 12), dur: len * 0.6, gain: 0.03, type: 'square', at: t, out }); }
      // bass: root with octave and fifth bounces on eighth notes
      if (s16 % 2 === 0) { const b = [0, 0, 12, 0, 0, 7, 0, 12][s16 / 2]; this.tone({ freq: midi(root - 12 + b), dur: step * 1.6, gain: 0.16, type: 'triangle', at: t, out }); }
      // arpeggio: chord tones on every sixteenth, quiet
      { const tones = [root, root + chord[1], root + 7, root + 12]; this.tone({ freq: midi(tones[s16 % 4] + 12), dur: step * 0.8, gain: 0.03 + I * 0.02, type: 'square', at: t, out }); }
      // drums: kick, snare, hats; more hats and a ghost kick when things heat up
      if (s16 === 0 || s16 === 8 || (I > 0.5 && s16 === 10) || (s16 === 14 && bar % 4 === 3)) this.tone({ freq: 160, freqEnd: 45, dur: 0.12, gain: 0.8, type: 'sine', at: t, out });
      if (s16 === 4 || s16 === 12) this._noiseAt(t, 0.11, 0.42, 'bandpass', 2200, out);
      if (s16 % 2 === 0 || I > 0.4) this._noiseAt(t, s16 % 4 === 2 ? 0.05 : 0.025, s16 % 4 === 2 ? 0.2 : 0.12, 'highpass', 8000, out);
      m.next += step; m.step++;
    }
  }
  _noiseAt(t0, dur, gain, type, freq, out) {
    const ctx = this.ctx; const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.loopEnd = 2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0); env.gain.linearRampToValueAtTime(gain, t0 + 0.003); env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(env); env.connect(out); src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
}

// ---------- the theme: eight bars, sixteenth grid ----------
const N = (...pairs) => { const notes = [], lens = []; for (let k = 0; k < pairs.length; k += 2) { notes.push(pairs[k]); lens.push(pairs[k + 1]); for (let j = 1; j < pairs[k + 1]; j++) { notes.push(0); lens.push(0); } } return { notes, lens }; };
const BARS = [
  N(76, 2, 79, 2, 84, 4, 83, 2, 84, 2, 79, 4),          // C: bright leap up
  N(74, 2, 76, 2, 79, 4, 81, 2, 79, 2, 76, 4),          // G
  N(81, 2, 84, 2, 88, 4, 86, 2, 84, 2, 81, 4),          // Am: the lift
  N(77, 2, 81, 2, 84, 4, 81, 2, 79, 2, 76, 2, 74, 2),   // F: tumbling back down
  N(79, 4, 76, 2, 72, 2, 76, 2, 79, 2, 84, 4),          // C
  N(83, 2, 86, 2, 79, 4, 83, 2, 81, 2, 79, 4),          // G
  N(81, 2, 84, 2, 89, 4, 88, 2, 86, 2, 84, 4),          // F: the high point
  N(86, 2, 83, 2, 79, 4, 77, 2, 76, 2, 74, 4),          // G: lands you back at the top
];
const TUNE = { lead: BARS.flatMap((b) => b.notes), len: BARS.flatMap((b) => b.lens), length: 128, chords: [[60, 4], [55, 4], [57, 3], [53, 4], [60, 4], [55, 4], [53, 4], [55, 4]] };
export const audio = new Sfx();
