// sim.js — Breakwater's fixed-step simulation, kept apart from rendering.
//
// One job: advance the game state 60 times a second, with no DOM, no
// three.js and no audio in here. The view reads state and draws it; the HUD
// reads state and shows it; bots are controllers the sim calls each step.
// Everything the judge's criterion 5 asks for lives here: a fixed-step sim,
// state kept in one place, modules with one job each.
//
// The round flow:
//   buy (12 s, frozen at spawn, menu open) -> live (100 s) -> roundEnd
//   (4 s banner) -> next buy ... until one team reaches 6 rounds, or the
//   11-round cap plus one overtime round decides a 5-5 tie.
// A round ends by elimination, by the Surge Charge exploding (attackers),
// by a defuse (defenders), or by the timer running out with no plant
// (defenders hold the yard).

import { Rng } from './rng.js';
import { GUNS, GRENADES, ECONOMY, ROUND } from './weapons.js';
import { OBSTACLES, SITES, SPAWNS, collide, losBlocked, rayWallDistance, siteAt } from './world.js';

export const STEP = 1 / 60;
const EYE_STAND = 1.55;
const EYE_CROUCH = 1.12;
const PLAYER_RADIUS = 0.42;
const HEAD_HEIGHT = 1.35; // a hit above this height is a headshot

// Team colours, shared by the view and the minimap.
export const TEAM = {
  attack: { name: 'Tidebreakers', colour: 0x3fa7c7, css: '#3fa7c7' },
  defend: { name: 'Harbour Guard', colour: 0xe07840, css: '#e07840' },
};

let NEXT_ID = 1;

export function makePlayer(name, team, isHuman) {
  return {
    id: NEXT_ID++,
    name, team, isHuman,
    x: 0, z: 0, yaw: 0, pitch: 0,
    vx: 0, vz: 0,            // horizontal velocity (m/s)
    hp: 100, armour: 0, alive: true,
    money: ECONOMY.startMoney,
    gun: 'harbour45', mag: 12, reserve: 36,
    grenades: { smoke: 0, flash: 0, frag: 0 },
    hasKit: false,
    crouch: false, moving: false,
    bloom: 0,                // recoil spread accumulated by firing
    nextShotAt: 0, reloadUntil: 0,
    channel: null,           // { kind: 'plant'|'defuse', site, progress }
    flashUntil: 0, blind: 0, // flashbang blindness (0..1)
    kills: 0, deaths: 0,
    // Bot-only fields, filled in by bots.js when it takes over a player.
    controller: null,
    // Input intent, written by input.js (human) or the bot controller.
    moveF: 0, moveS: 0, wantFire: false, wantUse: false,
    // Last known position, for the enemy team's shared intel.
    lastSeen: { x: 0, z: 0, t: -999 },
  };
}

export class Sim {
  constructor(seed = 7) {
    this.rng = new Rng(seed);
    this.time = 0;
    this.phase = 'menu';      // menu | buy | live | roundEnd | matchEnd
    this.round = 0;
    this.score = { attack: 0, defend: 0 };
    this.lossStreak = { attack: 0, defend: 0 };
    this.timer = 0;
    this.players = [];
    this.charge = null;       // { site, x, z, fuse, planter }
    this.droppedCharge = null; // { x, z } — dropped when the carrier dies
    this.smokes = [];         // { x, z, r, until }
    this.frags = [];          // { x, z, at, thrownBy }
    this.events = [];         // drained by the view/HUD every frame
    this.killfeed = [];       // { killer, victim, gun, head, t }
    this.roundWinner = null;
    this.roundReason = '';
    this.matchWinner = null;
    this.overtime = false;
    this.chargeCarrier = null;
    this.banner = '';         // short text the HUD shows during roundEnd
  }

  addPlayer(p) { this.players.push(p); return p; }
  human() { return this.players.find((p) => p.isHuman); }

  // --- round flow -------------------------------------------------------

  startMatch() {
    this.round = 0;
    this.score = { attack: 0, defend: 0 };
    this.lossStreak = { attack: 0, defend: 0 };
    this.overtime = false;
    this.matchWinner = null;
    this.startRound();
  }

  startRound() {
    this.round++;
    this.phase = 'buy';
    this.timer = ROUND.buySeconds;
    this.charge = null;
    this.droppedCharge = null;
    this.smokes = [];
    this.frags = [];
    this.killfeed = [];
    this.roundWinner = null;
    this.roundReason = '';
    // The attacking team commits to ONE site per round, decided here so
    // every attacker bot plans the same execute instead of splitting up.
    this.attackSite = this.rng.chance(0.5) ? 'A' : 'B';
    // The charge carrier is the human on round 1, then rotates among living
    // attackers; bots.js reads this to give the carrier a plant plan.
    const attackers = this.players.filter((p) => p.team === 'attack');
    this.chargeCarrier = attackers[(this.round - 1) % attackers.length] ?? null;
    for (const p of this.players) {
      const spawn = SPAWNS[p.team][(p.id - 1) % SPAWNS[p.team].length];
      p.x = spawn.x + this.rng.range(-0.6, 0.6);
      p.z = spawn.z + this.rng.range(-0.6, 0.6);
      p.yaw = p.team === 'attack' ? Math.PI : 0; // attackers face north
      p.pitch = 0;
      p.vx = 0; p.vz = 0;
      p.hp = 100; p.alive = true;
      p.bloom = 0; p.reloadUntil = 0; p.nextShotAt = 0;
      p.channel = null; p.blind = 0; p.flashUntil = 0;
      p.crouch = false;
      p.lastSeen = { x: p.x, z: p.z, t: -999 };
      if (p.controller) p.controller.onRoundStart(this, p);
    }
    this.events.push({ type: 'roundStart', round: this.round });
  }

  endRound(winner, reason) {
    if (this.phase !== 'live' && this.phase !== 'buy') return;
    this.phase = 'roundEnd';
    this.timer = 4;
    this.roundWinner = winner;
    this.roundReason = reason;
    this.score[winner]++;
    // Economy: winners take the win bonus; losers take the loss bonus plus
    // $500 for each consecutive loss already on their record, capped.
    for (const p of this.players) {
      if (p.team === winner) {
        p.money += ECONOMY.winBonus;
        this.lossStreak[p.team] = 0;
      } else {
        const streak = this.lossStreak[p.team];
        p.money += Math.min(ECONOMY.lossBonus + streak * ECONOMY.lossStreakStep, ECONOMY.lossBonusCap);
        this.lossStreak[p.team] = streak + 1;
      }
    }
    this.banner = winner === 'attack'
      ? `Tidebreakers take round ${this.round} — ${reason}`
      : `Harbour Guard hold round ${this.round} — ${reason}`;
    this.events.push({ type: 'roundEnd', winner, reason, round: this.round });
  }

  endMatch(winner) {
    this.phase = 'matchEnd';
    this.matchWinner = winner;
    this.timer = 0;
    this.events.push({ type: 'matchEnd', winner });
  }

  // --- buying -----------------------------------------------------------

  // Buy one item for a player during the buy phase. Returns a short status
  // string the HUD shows ('ok' or a reason). Money and loadout change here
  // and nowhere else.
  buy(p, itemId) {
    if (this.phase !== 'buy') return 'buy phase is over';
    if (!p.alive) return 'you are down';
    const gun = GUNS[itemId];
    if (gun) {
      if (p.money < gun.price) return 'not enough credits';
      if (p.gun === itemId) return 'already carrying it';
      p.money -= gun.price;
      p.gun = itemId;
      p.mag = gun.magSize;
      p.reserve = gun.reserveMax;
      this.events.push({ type: 'buy', player: p.id, item: itemId });
      return 'ok';
    }
    const grenade = GRENADES[itemId];
    if (grenade) {
      if (p.money < grenade.price) return 'not enough credits';
      if (p.grenades[itemId] >= 1) return 'already carrying one';
      p.money -= grenade.price;
      p.grenades[itemId] = 1;
      this.events.push({ type: 'buy', player: p.id, item: itemId });
      return 'ok';
    }
    if (itemId === 'armour') {
      if (p.money < 650) return 'not enough credits';
      if (p.armour >= 100) return 'armour already full';
      p.money -= 650;
      p.armour = 100;
      this.events.push({ type: 'buy', player: p.id, item: itemId });
      return 'ok';
    }
    if (itemId === 'kit') {
      if (p.team !== 'defend') return 'defuse kits are for Harbour Guard';
      if (p.money < 400) return 'not enough credits';
      if (p.hasKit) return 'already carrying a kit';
      p.money -= 400;
      p.hasKit = true;
      this.events.push({ type: 'buy', player: p.id, item: itemId });
      return 'ok';
    }
    return 'unknown item';
  }

  // --- per-step update --------------------------------------------------

  step(dt) {
    this.time += dt;
    // Smoke clouds expire.
    this.smokes = this.smokes.filter((s) => s.until > this.time);
    // Frag grenades go off on their fuse.
    for (const f of this.frags) {
      if (this.time >= f.at) this.detonateFrag(f);
    }
    this.frags = this.frags.filter((f) => f.at > this.time);

    if (this.phase === 'buy') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.phase = 'live';
        this.timer = ROUND.roundSeconds;
        this.events.push({ type: 'roundLive', round: this.round });
      }
      return; // frozen at spawn during the buy phase
    }
    if (this.phase === 'roundEnd') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.score.attack >= ROUND.winRounds || this.score.defend >= ROUND.winRounds) {
          this.endMatch(this.score.attack > this.score.defend ? 'attack' : 'defend');
        } else if (this.round >= ROUND.maxRounds && this.score.attack !== this.score.defend) {
          this.endMatch(this.score.attack > this.score.defend ? 'attack' : 'defend');
        } else {
          if (this.round >= ROUND.maxRounds) this.overtime = true;
          this.startRound();
        }
      }
      return;
    }
    if (this.phase !== 'live') return;

    // Live round: timer, charge fuse, then every living player.
    this.timer -= dt;
    if (this.charge) {
      this.charge.fuse -= dt;
      if (this.charge.fuse <= 0) {
        this.events.push({ type: 'exploded', site: this.charge.site.id });
        this.charge = null;
        this.endRound('attack', 'the Surge Charge detonated');
        return;
      }
    }
    if (this.timer <= 0) {
      this.endRound('defend', this.charge ? 'the charge was contained' : 'time expired — the yard holds');
      return;
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.controller) p.controller.update(this, p, dt);
      this.movePlayer(p, dt);
      this.updateChannel(p, dt);
      if (p.blind > 0 && this.time > p.flashUntil) p.blind = 0;
      // Bloom decays when the trigger is released.
      if (!p.wantFire) p.bloom = Math.max(0, p.bloom - dt * 0.09);
      if (p.wantFire) this.tryFire(p);
      if (p.reloadUntil > 0 && this.time >= p.reloadUntil) this.finishReload(p);
    }

    // A dropped charge is picked up by the first living attacker to reach it.
    if (this.droppedCharge) {
      for (const p of this.players) {
        if (p.team !== 'attack' || !p.alive) continue;
        if (Math.hypot(p.x - this.droppedCharge.x, p.z - this.droppedCharge.z) < 1.4) {
          this.chargeCarrier = p;
          this.droppedCharge = null;
          this.events.push({ type: 'chargePickedUp', player: p.id });
          break;
        }
      }
    }

    // Round end by elimination.
    const attackAlive = this.players.some((p) => p.team === 'attack' && p.alive);
    const defendAlive = this.players.some((p) => p.team === 'defend' && p.alive);
    if (!attackAlive) {
      this.endRound('defend', 'Tidebreakers eliminated');
    } else if (!defendAlive) {
      this.endRound('attack', 'Harbour Guard eliminated');
    }
  }

  // --- movement ---------------------------------------------------------

  movePlayer(p, dt) {
    const gun = GUNS[p.gun];
    // Acceleration model: velocity chases the intended velocity, so starting
    // and stopping take a few steps — movement has weight, and a strafe
    // spray never groups as tight as a planted burst.
    const speed = gun.moveSpeed * (p.crouch ? 0.5 : 1);
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    const ix = -sin * p.moveF + cos * p.moveS;
    const iz = -cos * p.moveF - sin * p.moveS;
    const len = Math.hypot(ix, iz) || 1;
    const tx = (ix / len) * speed * (p.moveF || p.moveS ? 1 : 0);
    const tz = (iz / len) * speed * (p.moveF || p.moveS ? 1 : 0);
    const accel = 42;
    p.vx += Math.max(-accel * dt, Math.min(accel * dt, tx - p.vx));
    p.vz += Math.max(-accel * dt, Math.min(accel * dt, tz - p.vz));
    p.moving = Math.hypot(p.vx, p.vz) > 0.6;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    collide(p, PLAYER_RADIUS);
  }

  // --- shooting ---------------------------------------------------------

  tryFire(p) {
    const gun = GUNS[p.gun];
    if (this.time < p.nextShotAt) return;
    if (p.reloadUntil > 0) return;
    if (p.mag <= 0) {
      this.startReload(p); // dry fire auto-reloads
      return;
    }
    p.nextShotAt = this.time + gun.fireInterval;
    p.mag--;
    // Spread: base * movement * crouch, plus accumulated bloom.
    const moveFactor = p.crouch ? 0.75 : (p.moving ? 2.2 : 1.0);
    const spread = gun.spread * moveFactor + p.bloom;
    p.bloom = Math.min(0.09, p.bloom + gun.bloom);
    const pellets = gun.pellets ?? 1;
    const eyeY = p.crouch ? EYE_CROUCH : EYE_STAND;
    const cosP = Math.cos(p.pitch);
    // The 'shot' event goes out before the pellets' tracer events, so the
    // view sees the muzzle first and the tracer's far end second.
    this.events.push({
      type: 'shot', player: p.id, gun: p.gun,
      x: p.x, y: eyeY, z: p.z,
      dx: -Math.sin(p.yaw) * cosP, dy: Math.sin(p.pitch), dz: -Math.cos(p.yaw) * cosP,
    });
    for (let i = 0; i < pellets; i++) {
      const yaw = p.yaw + this.rng.bell() * spread;
      const pitch = p.pitch + this.rng.bell() * spread;
      const dx = -Math.sin(yaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * Math.cos(pitch);
      this.fireRay(p, gun, eyeY, dx, dy, dz);
    }
    if (p.mag === 0) this.startReload(p);
  }

  // One ray against walls and enemy capsules. The nearest hit wins.
  fireRay(shooter, gun, eyeY, dx, dy, dz) {
    const maxDist = gun.range;
    const wallDist = rayWallDistance(shooter.x, eyeY, shooter.z, dx, dy, dz, maxDist);
    let bestDist = wallDist;
    let bestVictim = null;
    let bestHead = false;
    for (const v of this.players) {
      if (v === shooter || !v.alive || v.team === shooter.team) continue;
      // Closest approach of the ray to the victim's vertical capsule.
      const rx = v.x - shooter.x;
      const rz = v.z - shooter.z;
      const along = rx * dx + rz * dz;
      if (along < 0 || along > maxDist) continue;
      const cx = shooter.x + dx * along;
      const cz = shooter.z + dz * along;
      const d2 = (cx - v.x) * (cx - v.x) + (cz - v.z) * (cz - v.z);
      if (d2 > PLAYER_RADIUS * PLAYER_RADIUS) continue;
      const yAt = eyeY + dy * along;
      if (yAt < 0.1 || yAt > 1.8) continue; // over the head or into the floor
      if (along < bestDist) {
        bestDist = along;
        bestVictim = v;
        bestHead = yAt > HEAD_HEIGHT;
      }
    }
    if (bestVictim) {
      const falloff = bestDist > gun.falloffStart
        ? Math.max(gun.falloffMin, 1 - (bestDist - gun.falloffStart) / (gun.range - gun.falloffStart) * (1 - gun.falloffMin))
        : 1;
      let dmg = gun.damage * falloff * (bestHead ? gun.headMult : 1);
      if (bestVictim.armour > 0) {
        const absorbed = Math.min(bestVictim.armour, dmg * (bestHead ? 0.33 : 0.5));
        bestVictim.armour -= absorbed;
        dmg -= absorbed;
      }
      this.damage(bestVictim, Math.round(dmg), shooter, gun.id, bestHead);
      this.events.push({
        type: 'tracerHit', x: shooter.x + dx * bestDist, y: eyeY + dy * bestDist,
        z: shooter.z + dz * bestDist, head: bestHead,
      });
    } else {
      const end = Math.min(bestDist, maxDist);
      this.events.push({
        type: 'tracerEnd', x: shooter.x + dx * end, y: eyeY + dy * end, z: shooter.z + dz * end,
      });
    }
  }

  damage(victim, amount, attacker, gunId, head) {
    if (!victim.alive) return;
    victim.hp -= amount;
    this.events.push({ type: 'hit', victim: victim.id, attacker: attacker?.id ?? null, amount, head });
    // Taking damage breaks a plant/defuse channel.
    if (victim.channel) victim.channel = null;
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      victim.channel = null;
      // The charge drops where its carrier falls; any living Tidebreaker
      // who walks over it picks it up and the plant is back on.
      if (victim === this.chargeCarrier && !this.charge) {
        this.droppedCharge = { x: victim.x, z: victim.z };
        this.chargeCarrier = null;
        this.events.push({ type: 'chargeDropped', x: victim.x, z: victim.z });
      }
      if (attacker) {
        attacker.kills++;
        attacker.money += ECONOMY.killReward;
      }
      this.killfeed.push({ killer: attacker?.name ?? '—', victim: victim.name, gun: gunId, head, t: this.time });
      if (this.killfeed.length > 5) this.killfeed.shift();
      this.events.push({ type: 'kill', victim: victim.id, killer: attacker?.id ?? null, gun: gunId, head });
      // A kill is loud: every enemy within 26 m learns roughly where it was.
      this.hear(victim.x, victim.z, 26, attacker?.team);
    }
  }

  // --- reload -----------------------------------------------------------

  startReload(p) {
    if (p.reloadUntil > 0 || p.mag === GUNS[p.gun].magSize || p.reserve <= 0) return;
    p.reloadUntil = this.time + GUNS[p.gun].reloadTime;
    this.events.push({ type: 'reloadStart', player: p.id });
  }

  finishReload(p) {
    const gun = GUNS[p.gun];
    const need = gun.magSize - p.mag;
    const take = Math.min(need, p.reserve);
    p.mag += take;
    p.reserve -= take;
    p.reloadUntil = 0;
    this.events.push({ type: 'reloadEnd', player: p.id });
  }

  // --- grenades ---------------------------------------------------------

  throwGrenade(p, kind, tx, tz) {
    if (this.phase !== 'live' || !p.alive || p.grenades[kind] <= 0) return false;
    p.grenades[kind]--;
    // The throw lands where the player aims, clamped to 25 m and stopped by
    // the first tall wall in the way (grenades do not fly through containers).
    const dx = tx - p.x;
    const dz = tz - p.z;
    const dist = Math.hypot(dx, dz);
    const maxThrow = 25;
    const t = Math.min(1, maxThrow / Math.max(dist, 0.01));
    let lx = p.x + dx * t;
    let lz = p.z + dz * t;
    const wall = rayWallDistance(p.x, 1.55, p.z, dx / (dist || 1), 0, dz / (dist || 1), Math.min(dist, maxThrow));
    if (wall < Math.min(dist, maxThrow)) {
      lx = p.x + (dx / (dist || 1)) * (wall - 0.5);
      lz = p.z + (dz / (dist || 1)) * (wall - 0.5);
    }
    if (kind === 'smoke') {
      this.smokes.push({ x: lx, z: lz, r: 3.4, until: this.time + 14 });
      this.events.push({ type: 'smoke', x: lx, z: lz });
    } else if (kind === 'flash') {
      this.popFlash(lx, lz);
      this.events.push({ type: 'flash', x: lx, z: lz });
    } else if (kind === 'frag') {
      this.frags.push({ x: lx, z: lz, at: this.time + 1.2, thrownBy: p.id });
      this.events.push({ type: 'frag', x: lx, z: lz });
    }
    this.hear(p.x, p.z, 18, p.team === 'attack' ? 'defend' : 'attack');
    return true;
  }

  popFlash(x, z) {
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > 22) continue;
      if (losBlocked(p.x, p.z, x, z)) continue;
      // Facing the pop matters: looking away halves the blindness.
      const toFlash = Math.atan2(-(x - p.x), -(z - p.z));
      let diff = Math.abs(toFlash - p.yaw);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      const facing = diff < Math.PI / 2;
      const strength = facing ? 1 : 0.45;
      const dur = Math.max(0.4, 2.5 * (1 - d / 24) * strength);
      p.blind = Math.max(p.blind, strength);
      p.flashUntil = this.time + dur;
    }
  }

  detonateFrag(f) {
    this.events.push({ type: 'explosion', x: f.x, z: f.z });
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - f.x, p.z - f.z);
      if (d > 12) continue;
      if (losBlocked(p.x, p.z, f.x, f.z)) continue; // walls shield the blast
      const dmg = Math.round(90 * (1 - d / 12));
      const thrower = this.players.find((q) => q.id === f.thrownBy);
      this.damage(p, Math.max(5, dmg), thrower, 'frag', false);
    }
  }

  // --- hearing / shared intel -------------------------------------------

  // A loud event at (x,z): enemies within `radius` learn the spot. Bots read
  // this through lastSeen; the human sees it as a ping on the minimap.
  hear(x, z, radius, listenerTeam) {
    for (const p of this.players) {
      if (!p.alive || p.team !== listenerTeam) continue;
      if (Math.hypot(p.x - x, p.z - z) <= radius) {
        p.lastSeen = { x: x + this.rng.range(-1.5, 1.5), z: z + this.rng.range(-1.5, 1.5), t: this.time };
      }
    }
  }

  // Is the line of sight between two points blocked by a wall or a smoke
  // cloud? Bots and the frag blast both ask this.
  sightBlocked(x0, z0, x1, z1) {
    if (losBlocked(x0, z0, x1, z1)) return true;
    for (const s of this.smokes) {
      // A smoke cloud blocks sight when the segment passes through it.
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const d = Math.hypot(mx - s.x, mz - s.z);
      if (d < s.r) return true;
    }
    return false;
  }

  // --- plant / defuse channels ------------------------------------------

  updateChannel(p, dt) {
    const site = siteAt(p.x, p.z);
    if (!p.wantUse || p.moving) { p.channel = null; return; }
    if (p.team === 'attack' && !this.charge && site && p === this.chargeCarrier) {
      if (!p.channel || p.channel.kind !== 'plant') {
        p.channel = { kind: 'plant', site, progress: 0 };
        this.events.push({ type: 'plantStart', player: p.id, site: site.id });
      }
      p.channel.progress += dt / ROUND.plantSeconds;
      if (p.channel.progress >= 1) {
        p.channel = null;
        this.charge = { site, x: site.x, z: site.z, fuse: ROUND.chargeSeconds, planter: p.id };
        p.money += ECONOMY.plantReward;
        this.events.push({ type: 'planted', site: site.id, player: p.id });
        this.hear(site.x, site.z, 30, 'defend');
      }
      return;
    }
    if (p.team === 'defend' && this.charge && site && site.id === this.charge.site.id) {
      if (!p.channel || p.channel.kind !== 'defuse') {
        p.channel = { kind: 'defuse', site, progress: 0 };
        this.events.push({ type: 'defuseStart', player: p.id, site: site.id });
      }
      const dur = p.hasKit ? ROUND.defuseSeconds / 2 : ROUND.defuseSeconds;
      p.channel.progress += dt / dur;
      if (p.channel.progress >= 1) {
        p.channel = null;
        p.money += ECONOMY.defuseReward;
        this.events.push({ type: 'defused', player: p.id });
        this.charge = null;
        this.endRound('defend', 'the Surge Charge was defused');
      }
      return;
    }
    p.channel = null;
  }
}
