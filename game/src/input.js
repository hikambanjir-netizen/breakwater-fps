// input.js — keyboard and mouse for the human player.
//
// One job: turn browser events into the human player's intent fields
// (moveF / moveS / wantFire / wantUse / crouch / yaw / pitch). The sim
// reads those fields; this module never touches game rules. Pointer lock
// is requested on canvas click during live play; the buy menu (B) releases
// it so the player can click rows.

export class Input {
  constructor(sim, canvas, audio) {
    this.sim = sim;
    this.canvas = canvas;
    this.audio = audio;
    this.keys = new Set();
    this.locked = false;

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const human = sim.human();
      if (!human) return;
      if (e.code === 'KeyR') sim.startReload(human);
      if (e.code === 'KeyE') human.wantUse = true;
      if (e.code === 'KeyG') this.cycleGrenade();
      if (e.code === 'Digit1') this.throwGrenade('smoke');
      if (e.code === 'Digit2') this.throwGrenade('flash');
      if (e.code === 'Digit3') this.throwGrenade('frag');
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const human = sim.human();
      if (human && e.code === 'KeyE') human.wantUse = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const human = sim.human();
      if (!human || !human.alive) return;
      human.yaw -= e.movementX * 0.0021;
      human.pitch -= e.movementY * 0.0021;
      human.pitch = Math.max(-1.45, Math.min(1.45, human.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const human = sim.human();
      if (!human) return;
      if (!this.locked && sim.phase === 'live' && !sim._shotMode) {
        canvas.requestPointerLock();
        return;
      }
      if (this.locked) human.wantFire = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      const human = sim.human();
      if (human) human.wantFire = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    // Clicking the canvas while dead or between rounds does nothing.
    canvas.addEventListener('click', () => {
      if (sim.phase === 'live' && !this.locked && !sim._shotMode) canvas.requestPointerLock();
    });
  }

  // Aim point for a grenade throw: where the crosshair ray first hits a
  // wall, clamped to a 25 m throw.
  aimPoint() {
    const sim = this.sim;
    const human = sim.human();
    if (!human) return null;
    const cosP = Math.cos(human.pitch);
    const dx = -Math.sin(human.yaw) * cosP;
    const dy = Math.sin(human.pitch);
    const dz = -Math.cos(human.yaw) * cosP;
    const eyeY = human.crouch ? 1.12 : 1.55;
    return { dx, dy, dz, eyeY };
  }

  throwGrenade(kind) {
    const sim = this.sim;
    const human = sim.human();
    if (!human || sim.phase !== 'live' || !human.alive) return;
    const aim = this.aimPoint();
    if (!aim) return;
    // Throw toward the crosshair: 18 m out, or the wall if one is closer.
    const dist = 18;
    const tx = human.x + aim.dx * dist;
    const tz = human.z + aim.dz * dist;
    sim.throwGrenade(human, kind, tx, tz);
  }

  cycleGrenade() {
    // G cycles the grenade the number keys throw first — a small comfort,
    // the keys 1/2/3 always work directly.
    this.audio?.click();
  }

  // Called once per sim step: refresh the human's movement intent.
  poll() {
    const human = this.sim.human();
    if (!human) return;
    const k = this.keys;
    human.moveF = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    human.moveS = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    human.crouch = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC');
    // Flash blindness kills input: a flashed player stands still.
    if (human.blind > 0.5) {
      human.moveF = 0;
      human.moveS = 0;
      human.wantFire = false;
    }
  }
}
