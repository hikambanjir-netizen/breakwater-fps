// bots.js — the seven bots that fill Breakwater's other seats.
//
// A bot is a controller object the sim calls once per step. It has one job:
// turn what its player can see and hear into movement, aim and fire intents.
// Bots never cheat: they see only what is inside their vision cone with a
// clear line of sight (smoke blocks it, exactly like for the human), they
// hear only loud events near them, and they share what they learn through
// the sim's lastSeen intel — the same information the human gets as
// minimap pings.
//
// Behaviour, by role:
//   * Attackers pick a site and a lane (West / Mid / East), walk the
//     waypoint graph to it, and the charge carrier plants once the site is
//     clear. After a plant they hold the site in pairs.
//   * Defenders hold: two on A, one on B, one roaming Mid. On a plant they
//     retake together; the first defender to reach the charge defuses.
//   * Every bot aims with error that grows with distance and target speed,
//     waits a human-like reaction time (0.35–0.65 s) after first spotting a
//     target, and fires in bursts with pauses — so a player who stops,
//     bursts and strafes between shots wins the duel.

import { GUNS } from './weapons.js';
import { SITES, WAYPOINTS, findPath, nearestWaypoint } from './world.js';

export const BOT_NAMES = {
  attack: ['Rook', 'Mara', 'Kelpie'],
  defend: ['Anchor', 'Gull', 'Whelk', 'Brine'],
};

// Lane entry waypoints, by site: each lane is a waypoint that begins a
// route to that site.
const LANES = {
  A: { west: 4, mid: 5, east: 10 },
  B: { west: 8, mid: 5, east: 6 },
};
// Where defenders hold, by assignment.
const HOLDS = {
  A: [16, 19],   // two bots hold Crane Bay
  B: [18],       // one holds the Cold Store
  mid: [17],     // one roams Mid
};

function angleTo(fromX, fromZ, toX, toZ) {
  // Yaw convention (see sim.movePlayer): forward is (-sin yaw, -cos yaw).
  return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class BotController {
  constructor(sim, player) {
    this.rng = sim.rng;
    this.player = player;
    this.state = 'plan';       // plan | move | hold | plant | retake | defuse | hunt
    this.site = 'A';
    this.path = [];
    this.pathIdx = 0;
    this.holdNode = null;
    this.holdYaw = 0;
    this.target = null;        // the enemy currently engaged
    this.reactUntil = 0;       // do not fire before this time
    this.burstLeft = 0;
    this.burstPauseUntil = 0;
    this.peekUntil = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.thinkAt = 0;          // re-plan every 0.5 s, not every step
  }

  onRoundStart(sim, p) {
    this.state = 'plan';
    this.path = [];
    this.target = null;
    this.buyLoadout(sim, p);
    this.plan(sim, p);
  }

  // Bots spend their credits like a frugal player: rifle first, then a
  // grenade, then armour — never the DMR, which wastes the team's money.
  buyLoadout(sim, p) {
    if (p.money >= 2700 && p.gun !== 'breaker') sim.buy(p, 'breaker');
    else if (p.money >= 1500 && p.gun === 'harbour45') sim.buy(p, 'gale');
    if (p.money >= 300 && p.grenades.smoke === 0 && this.rng.chance(0.5)) sim.buy(p, 'smoke');
    if (p.money >= 200 && p.grenades.flash === 0 && this.rng.chance(0.4)) sim.buy(p, 'flash');
    if (p.money >= 650 && p.armour < 50) sim.buy(p, 'armour');
    if (p.team === 'defend' && p.money >= 400 && !p.hasKit && this.rng.chance(0.5)) sim.buy(p, 'kit');
  }

  plan(sim, p) {
    if (p.team === 'attack') {
      // The whole attacking team commits to the round's one site (decided
      // in sim.startRound), with the lane split across West / Mid / East.
      // The route runs through the chosen lane's entry node and on to the site.
      this.site = sim.attackSite;
      const lanes = Object.keys(LANES[this.site]);
      const lane = lanes[p.id % lanes.length];
      const entry = LANES[this.site][lane];
      const siteNode = this.site === 'A' ? 14 : 15;
      const from = nearestWaypoint(p.x, p.z);
      const leg1 = findPath(from, entry) ?? [entry];
      const leg2 = findPath(entry, siteNode) ?? [siteNode];
      this.path = leg1.concat(leg2.slice(1));
      this.pathIdx = 0;
      this.state = 'move';
      this.destSite = this.site;
    } else {
      // Defenders: assignment is fixed by seat so both sites are covered.
      const seat = p.id % 4;
      if (seat === 0) { this.holdNode = HOLDS.A[0]; this.site = 'A'; }
      else if (seat === 1) { this.holdNode = HOLDS.A[1]; this.site = 'A'; }
      else if (seat === 2) { this.holdNode = HOLDS.B[0]; this.site = 'B'; }
      else { this.holdNode = HOLDS.mid[0]; this.site = 'mid'; }
      this.setPath(sim, p, this.holdNode);
      this.state = 'move';
      // Hold facing the approach, not the site: attackers come up the
      // connectors from the south, so a holder staring at the site would
      // never see them coming. A holders watch connector 12, B holders 13,
      // the Mid holder watches the mid stack gap (node 9).
      const faceNode = this.site === 'A' ? 12 : this.site === 'B' ? 13 : 9;
      this.holdYaw = angleTo(
        WAYPOINTS[this.holdNode].x, WAYPOINTS[this.holdNode].z,
        WAYPOINTS[faceNode].x, WAYPOINTS[faceNode].z,
      );
    }
  }

  setPath(sim, p, destNode) {
    const from = nearestWaypoint(p.x, p.z);
    this.path = findPath(from, destNode) ?? [destNode];
    this.pathIdx = 0;
  }

  // --- perception -------------------------------------------------------

  // The closest visible enemy, or null. Vision is a 100-degree cone out to
  // 30 m; a wall or a smoke cloud anywhere on the line blocks it.
  perceive(sim, p) {
    let best = null;
    let bestD = Infinity;
    for (const e of sim.players) {
      if (e === p || !e.alive || e.team === p.team) continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 30) continue;
      const ang = angleDiff(angleTo(p.x, p.z, e.x, e.z), p.yaw);
      if (Math.abs(ang) > 0.9) continue; // outside the vision cone
      if (sim.sightBlocked(p.x, p.z, e.x, e.z)) continue;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best ? { enemy: best, dist: bestD } : null;
  }

  // --- per-step update --------------------------------------------------

  update(sim, p, dt) {
    if (sim._staging) {
      // Screenshot staging: bots hold their posed positions and do not
      // fight, so the staged scene stays exactly as the shot set it up.
      // One exception: a bot the shot staged to fire (stageFireUntil)
      // keeps its trigger held, so its tracer crosses the frame.
      p.moveF = 0; p.moveS = 0; p.wantUse = false;
      p.wantFire = !!(p.stageFireUntil && sim.time < p.stageFireUntil);
      return;
    }
    if (sim.phase !== 'live') { p.moveF = 0; p.moveS = 0; p.wantFire = false; p.wantUse = false; return; }
    if (p.blind > 0.5) {
      // Flashed hard: stop, look away from the pop, wait it out.
      p.moveF = 0; p.moveS = 0; p.wantFire = false; p.wantUse = false;
      return;
    }

    // Re-plan twice a second: retakes, hunts and plant decisions live here.
    if (sim.time >= this.thinkAt) {
      this.thinkAt = sim.time + 0.5;
      this.think(sim, p);
    }

    const seen = this.perceive(sim, p);
    if (seen && !this.target) {
      // First sight: a human-like reaction delay before the first shot.
      this.reactUntil = sim.time + this.rng.range(0.35, 0.65);
      this.burstLeft = this.rng.int(3, 5);
    }
    this.target = seen ? seen.enemy : null;

    if (this.target) this.engage(sim, p, seen.dist, dt);
    else this.navigate(sim, p, dt);

    // Plant / defuse: hold USE while standing still on the objective.
    // A visible enemy interrupts the channel — the bot fights instead.
    p.wantUse = false;
    if (this.state === 'plant' && p.team === 'attack' && !this.target) {
      p.wantUse = true;
      p.moveF = 0; p.moveS = 0;
    }
    if (this.state === 'defuse' && p.team === 'defend' && sim.charge && !this.target) {
      p.wantUse = true;
      p.moveF = 0; p.moveS = 0;
    }
  }

  think(sim, p) {
    // A dropped charge rewrites the attackers' job: the closest living
    // Tidebreaker goes and recovers it, then carries on to the site.
    if (sim.droppedCharge && p.team === 'attack') {
      let closest = null;
      let bestD = Infinity;
      for (const q of sim.players) {
        if (q.team !== 'attack' || !q.alive) continue;
        const d = Math.hypot(q.x - sim.droppedCharge.x, q.z - sim.droppedCharge.z);
        if (d < bestD) { bestD = d; closest = q; }
      }
      if (closest === p && this.state !== 'recover') {
        this.setPath(sim, p, nearestWaypoint(sim.droppedCharge.x, sim.droppedCharge.z));
        this.state = 'recover';
      }
      return;
    }
    if (this.state === 'recover') {
      if (p === sim.chargeCarrier) {
        const siteNode = sim.attackSite === 'A' ? 14 : 15;
        this.setPath(sim, p, siteNode);
        this.state = 'move';
        this.destSite = sim.attackSite;
      }
      return;
    }
    // A planted charge rewrites everyone's job: defenders retake, attackers hold.
    if (sim.charge) {
      if (p.team === 'defend') {
        if (this.state !== 'retake' && this.state !== 'defuse') {
          const siteNode = sim.charge.site.id === 'A' ? 14 : 15;
          this.setPath(sim, p, siteNode);
          this.state = 'retake';
        }
      } else if (this.state === 'move' || this.state === 'hold') {
        // Attackers fall back to the planted site and hold it.
        const siteNode = sim.charge.site.id === 'A' ? 14 : 15;
        this.setPath(sim, p, siteNode);
        this.state = 'move';
        this.destSite = sim.charge.site.id;
      }
      return;
    }
    // No plant yet: attackers who reached their site wait for the carrier;
    // defenders who heard something go and look.
    if (p.team === 'attack' && this.state === 'hold' && p === sim.chargeCarrier) {
      this.state = 'plant';
    }
    if (p.team === 'defend' && this.state === 'hold') {
      const intel = p.lastSeen;
      if (sim.time - intel.t < 6) {
        // Something loud happened recently: investigate, but together is
        // safer — only the roaming defender leaves their post.
        if (this.holdNode === HOLDS.mid[0]) {
          this.setPath(sim, p, nearestWaypoint(intel.x, intel.z));
          this.state = 'hunt';
        }
      }
    }
    if (p.team === 'attack' && this.state === 'hunt') this.state = 'move';
  }

  // --- combat -----------------------------------------------------------

  engage(sim, p, dist, dt) {
    const t = this.target;
    // Aim at the target's chest with error that grows with distance and
    // with how fast the target is moving — a strafing target is hard to hit.
    const targetSpeed = Math.hypot(t.vx, t.vz);
    const err = 0.016 + dist * 0.002 + targetSpeed * 0.004;
    const aimYaw = angleTo(p.x, p.z, t.x, t.z) + this.rng.bell() * err;
    const eyeY = p.crouch ? 1.12 : 1.55;
    const aimPitch = Math.atan2(1.25 - eyeY, dist) + this.rng.bell() * err * 0.7;
    p.yaw += angleDiff(aimYaw, p.yaw) * Math.min(1, dt * 14);
    p.pitch += (aimPitch - p.pitch) * Math.min(1, dt * 14);

    // Strafe while fighting, but plant feet to fire: the accuracy model
    // punishes moving shots (spread x2.2), so a bot that strafes between
    // bursts and stands still through them wins its duels.
    const firing = sim.time >= this.reactUntil && sim.time >= this.burstPauseUntil && this.burstLeft > 0;
    if (!firing) {
      if (sim.time > this.strafeUntil) {
        this.strafeUntil = sim.time + this.rng.range(0.4, 0.9);
        this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
      }
      p.moveS = this.strafeDir * 0.7;
    } else {
      p.moveS = 0;
    }
    p.moveF = 0;

    // Fire in bursts: a few rounds, then a pause to re-aim.
    p.wantFire = false;
    if (sim.time >= this.reactUntil && sim.time >= this.burstPauseUntil) {
      if (this.burstLeft > 0) {
        p.wantFire = true;
        if (sim.time >= p.nextShotAt) this.burstLeft--;
        if (this.burstLeft === 0) {
          this.burstPauseUntil = sim.time + this.rng.range(0.45, 0.9);
          this.burstLeft = this.rng.int(3, 5);
        }
      }
    }
    // Reload early, between bursts, rather than mid-fight.
    if (p.mag <= 4 && p.reserve > 0) sim.startReload(p);
  }

  // --- navigation -------------------------------------------------------

  navigate(sim, p, dt) {
    p.wantFire = false;
    if (this.state === 'hold') {
      // On post: face the assigned lane, strafe-peek occasionally.
      p.moveF = 0; p.moveS = 0;
      if (sim.time > this.peekUntil) {
        this.peekUntil = sim.time + this.rng.range(2, 4);
        this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
      }
      p.yaw += angleDiff(this.holdYaw, p.yaw) * Math.min(1, dt * 4);
      return;
    }
    if (!this.path.length || this.pathIdx >= this.path.length) {
      if (this.state === 'retake') {
        this.state = 'defuse';
      } else if (this.state === 'hunt') {
        this.state = 'hold';
      } else if (this.state === 'recover') {
        this.state = 'hold'; // wait at the drop point for the pickup / re-plan
      } else if (this.state === 'move') {
        if (p.team === 'attack') {
          this.state = 'hold';
          // On a site, face the way the enemy retakes from (the connector),
          // not the site centre — the same rule as the defenders' holds.
          const faceNode = this.destSite === 'A' ? 12 : this.destSite === 'B' ? 13 : 9;
          this.holdYaw = angleTo(p.x, p.z, WAYPOINTS[faceNode].x, WAYPOINTS[faceNode].z);
          if (p === sim.chargeCarrier) this.state = 'plant';
        } else {
          this.state = 'hold';
        }
      }
      p.moveF = 0; p.moveS = 0;
      return;
    }
    const node = WAYPOINTS[this.path[this.pathIdx]];
    const dx = node.x - p.x;
    const dz = node.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.2) { this.pathIdx++; return; }
    // Walk toward the waypoint, facing where we walk. Clear corners slowly:
    // bots pause a beat at each waypoint before pushing on.
    const wantYaw = angleTo(p.x, p.z, node.x, node.z);
    p.yaw += angleDiff(wantYaw, p.yaw) * Math.min(1, dt * 8);
    const ux = dx / d;
    const uz = dz / d;
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    p.moveF = -ux * sin - uz * cos;
    p.moveS = ux * cos - uz * sin;
    // Crouch-walk the last stretch into a site: quieter, harder to spot.
    p.crouch = this.state === 'move' && p.team === 'attack' && this.pathIdx >= this.path.length - 1;
  }
}
