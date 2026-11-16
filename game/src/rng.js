// rng.js — deterministic random numbers for Breakwater.
//
// The simulation must be reproducible: screenshot staging (?shot=...&seed=7)
// and bot behaviour both run off this one generator, so a staged scene looks
// the same on every load. A mulberry32 core is small, fast and good enough
// for gameplay randomness; nothing here is used for security.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A tiny helper object the sim keeps in one place: one generator, one set of
// helpers, so call sites read like `rng.range(2, 5)` instead of raw math.
export class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  // Uniform float in [0, 1).
  float() { return this.next(); }
  // Uniform float in [min, max).
  range(min, max) { return min + (max - min) * this.next(); }
  // Uniform integer in [min, max] inclusive.
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  // Pick one element of an array.
  pick(list) { return list[Math.floor(this.next() * list.length)]; }
  // Fisher–Yates shuffle, in place, returning the same array.
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }
  // True with probability p.
  chance(p) { return this.next() < p; }
  // Gaussian-ish spread in [-1, 1] (average of two uniforms): used for
  // bullet dispersion and bot aim error so extreme misses are rare.
  bell() { return (this.next() + this.next()) - 1; }
}
