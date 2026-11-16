// main.js — Breakwater's bootstrap: build the sim, the view, the HUD and
// the input, then run the fixed-step loop.
//
// The loop is two clocks: the sim advances in fixed 1/60 s steps (so a
// round plays the same on any machine), and the renderer draws the latest
// state once per animation frame. Sim events are drained after every step
// and handed to the view (visuals) and the HUD (sound + text).
//
// SCREENSHOT STAGING (?shot=cover|buy|firefight|plant&seed=7):
// the same game, the same code, with the sim placed into a chosen moment —
// no separate scene, no edited pixels. Each staged shot sets
// window.__shotReady once the scene has settled, which is what the
// screenshot tool waits for.

import { Sim, makePlayer, STEP } from './sim.js';
import { BotController, BOT_NAMES } from './bots.js';
import { View } from './view.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { AudioSys } from './audio.js';
import { SITES } from './world.js';

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') || null;
const SEED = Number(params.get('seed') || 7);
// Staging state for screenshot shots (see stageShot): readiness and the
// firefight burst are both measured in sim seconds.
const staging = { readyAfter: 0, since: 0, fireUntil: 0 };

const sim = new Sim(SEED);

// The human plays as a Tidebreaker, first seat, so round 1's charge
// carrier is the player.
const human = sim.addPlayer(makePlayer('You', 'attack', true));
for (const name of BOT_NAMES.attack) {
  const bot = sim.addPlayer(makePlayer(name, 'attack', false));
  bot.controller = new BotController(sim, bot);
}
for (const name of BOT_NAMES.defend) {
  const bot = sim.addPlayer(makePlayer(name, 'defend', false));
  bot.controller = new BotController(sim, bot);
}

const audio = new AudioSys();
const view = new View(sim, document.getElementById('game'));
const hud = new Hud(sim, audio, (item) => sim.buy(human, item), () => {
  if (sim.phase === 'menu') sim.startMatch();
});
const input = new Input(sim, view.renderer.domElement, audio);

window.addEventListener('resize', () => view.resize());

// --- screenshot staging ---------------------------------------------------

function yawTo(x0, z0, x1, z1) {
  return Math.atan2(-(x1 - x0), -(z1 - z0));
}

function stageShot(kind) {
  sim._shotMode = true;
  sim._staging = true; // bots hold their poses and never fight during staging
  document.getElementById('overlay').hidden = true;
  sim.startMatch();
  const defenders = sim.players.filter((p) => p.team === 'defend');
  const attackers = sim.players.filter((p) => p.team === 'attack' && !p.isHuman);

  if (kind === 'cover') {
    // The cover: the player at Mid's west edge, looking up the lane at the
    // gantry crane over site A, a defender holding the connector and a
    // teammate pushing beside them. Live round, 78 s on the clock.
    sim.phase = 'live';
    sim.timer = 78;
    human.x = -6; human.z = 4;
    human.yaw = yawTo(-6, 4, SITES.A.x, SITES.A.z);
    human.pitch = 0.02;
    defenders[0].x = -14; defenders[0].z = -9;
    defenders[0].yaw = yawTo(-14, -9, 0, 14);
    defenders[1].x = -25; defenders[1].z = -6;
    defenders[1].yaw = yawTo(-25, -6, -14, 2);
    attackers[0].x = -12; attackers[0].z = -1;
    attackers[0].yaw = yawTo(-12, -1, -22, -14);
  } else if (kind === 'buy') {
    // The buy menu, open over the spawn yard, 10 s left to spend $800+.
    sim.phase = 'buy';
    sim.timer = 10;
    human.x = 0; human.z = 21;
    human.yaw = Math.PI;
    human.money = 3250;
    hud.openBuy();
  } else if (kind === 'firefight') {
    // A duel down Mid: a defender 12 m ahead in the open, the player
    // firing a burst — tracer, muzzle flash and hitmarker in frame.
    sim.phase = 'live';
    sim.timer = 64;
    human.x = 0; human.z = 8;
    human.yaw = yawTo(0, 8, 0, -4);
    human.pitch = 0;
    human.gun = 'breaker'; human.mag = 30; human.reserve = 90;
    const foe = defenders[0];
    foe.x = 0; foe.z = -4;
    foe.yaw = yawTo(0, -4, 0, 8);
    // The staged target survives the burst: a dead bot reads as a finished
    // fight, not a firefight in progress. (A horizontal burst at eye
    // height lands as headshots, so the pool needs to be generous.)
    foe.hp = 20000;
    // Hold the trigger for the whole staged shot: the human is mid-burst
    // when the screenshot lands — tracer, muzzle flash and hitmarker all
    // in frame.
    staging.fireUntil = sim.time + 60;
    // A teammate firing across the lane, so a tracer streaks diagonally
    // through the frame (a shooter's own tracer points away from the
    // camera and foreshortens to a dot).
    const mate = attackers[0];
    mate.x = -4; mate.z = 2;
    mate.yaw = yawTo(-4, 2, 0, -4);
    mate.gun = 'breaker'; mate.mag = 30; mate.reserve = 90;
    mate.stageFireUntil = sim.time + 60;
  } else if (kind === 'plant') {
    // The plant: the player inside Crane Bay's ring, the Surge Charge
    // channel three-quarters done, the gantry crane framing the site and
    // the A marker overhead. Staging freezes the bots, so nothing resets
    // the channel with damage.
    sim.phase = 'live';
    sim.timer = 41;
    // Inside the site's north-west corner, facing the connector the
    // defenders retake through: the ring curves in the foreground, the
    // crane leg frames the left, and the yard opens up ahead.
    human.x = -24; human.z = -16;
    human.yaw = yawTo(-24, -16, -13, -8);
    human.pitch = 0.0;
    human.wantUse = true;
    // The carrier plants; make sure it is the human, then let the channel run.
    sim.chargeCarrier = human;
  }
  // Readiness is measured in SIM seconds, not wall seconds: headless
  // rendering runs slower than real time, and the frame loop caps catch-up
  // steps, so wall-clock waits would fire before the scene settled.
  // cover 2.0 s (bots posed, timer ticking), buy 0.5 s (menu open),
  // firefight 0.9 s (burst mid-flight), plant 2.2 s (channel ~65%).
  staging.readyAfter = kind === 'plant' ? 2.2 : kind === 'cover' ? 2.0 : kind === 'firefight' ? 0.9 : 0.5;
  staging.since = sim.time;
}

if (SHOT) stageShot(SHOT);

// --- fixed-step loop ------------------------------------------------------

let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25; // a tab that slept does not fast-forward the sim
  acc += dt;
  let steps = 0;
  // Staged firefight burst, held in sim time.
  if (SHOT === 'firefight') human.wantFire = sim.time < staging.fireUntil;
  while (acc >= STEP && steps < 5) {
    input.poll();
    sim.step(STEP);
    acc -= STEP;
    steps++;
    // Drain this step's events to the view and the HUD.
    const events = sim.events.splice(0, sim.events.length);
    for (const e of events) {
      view.onEvent(e);
      hud.onEvent(e);
    }
  }
  if (steps === 5) acc = 0;
  // Staged readiness, in sim seconds (see stageShot).
  if (SHOT && !window.__shotReady && sim.time - staging.since >= staging.readyAfter) {
    window.__shotReady = true;
  }
  view.render(dt, now / 1000);
  hud.update();
}

requestAnimationFrame(frame);
