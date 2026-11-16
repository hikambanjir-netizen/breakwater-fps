// world.js — the Breakwater map: an original container port, and every
// geometric question the sim asks about it.
//
// LAYOUT (metres, x east, z south; y is up):
//   * The yard is 64 x 48. Tidebreakers (attackers) spawn at the south gate,
//     Harbour Guard (defenders) at the north quay.
//   * Three lanes run north: West Lane past the crane rails, Mid through the
//     container stacks, East Lane along the cold-store wall. Two connectors
//     cut across Mid at z = +2 and z = -8, so a team can rotate without
//     walking all the way back to spawn.
//   * Site A "Crane Bay" sits west under the gantry crane; site B
//     "Cold Store" sits east against the warehouse. Each site is a 4 m
//     radius circle; the charge only plants inside one.
//   * Obstacles are axis-aligned boxes. Tall boxes (h >= 2.4) block movement,
//     sight and bullets.
//
// Everything the sim needs is a pure function of this data: no three.js in
// here, so the simulation stays DOM-free and deterministic.

export const MAP = { minX: -32, maxX: 32, minZ: -24, maxZ: 24 };

// Each obstacle: { x0, z0, x1, z1, h, c } where c picks a container colour
// index for the renderer (0 rust, 1 teal, 2 mustard, 3 slate, 4 harbour blue).
// The layout leaves three clear lanes (West x -27..-19, Mid x -2..2, East
// x 19..27) and two open connectors (z -6..6 and z -16..-12); every
// waypoint edge in the graph below was machine-checked to clear every box
// by 0.7 m (see /tmp/verify-map.mjs). Tall boxes (h >= 2.4) block movement,
// sight and bullets.
export const OBSTACLES = [
  // Perimeter: the yard wall, four thick slabs (h 5, never shot over).
  { x0: -33, z0: -25, x1: 33, z1: -24, h: 5, c: 3 },
  { x0: -33, z0: 24, x1: 33, z1: 25, h: 5, c: 3 },
  { x0: -33, z0: -24, x1: -32, z1: 24, h: 5, c: 3 },
  { x0: 32, z0: -24, x1: 33, z1: 24, h: 5, c: 3 },

  // West wall stacks (west of the West lane).
  { x0: -31, z0: 6, x1: -28, z1: 12, h: 2.6, c: 0 },
  { x0: -31, z0: -6, x1: -28, z1: 0, h: 2.6, c: 1 },
  { x0: -30, z0: -18, x1: -27, z1: -8, h: 2.6, c: 3 },
  // West lane's east wall: one short box where no waypoint diagonal crosses.
  { x0: -19, z0: 5, x1: -16, z1: 8, h: 2.6, c: 2 },

  // Mid: the container stacks, two rows with an open connector between them.
  { x0: -8, z0: 6, x1: -2, z1: 12, h: 2.6, c: 2 },
  { x0: 2, z0: 6, x1: 8, z1: 12, h: 5.2, c: 0 },   // double-stacked, tall
  { x0: -8, z0: -12, x1: -2, z1: -6, h: 2.6, c: 4 },
  { x0: 2, z0: -12, x1: 8, z1: -6, h: 2.6, c: 1 },

  // East wall stacks (east of the East lane).
  { x0: 28, z0: 6, x1: 31, z1: 12, h: 2.6, c: 1 },
  { x0: 28, z0: -6, x1: 31, z1: 0, h: 2.6, c: 0 },
  { x0: 27, z0: -18, x1: 30, z1: -8, h: 2.6, c: 3 },
  // East lane's west wall, mirroring the west one.
  { x0: 16, z0: 5, x1: 19, z1: 8, h: 2.6, c: 2 },

  // Site elbows: the boxes the site approaches bend around.
  { x0: -16, z0: -22, x1: -11, z1: -19, h: 2.6, c: 4 }, // elbow into site A
  { x0: 11, z0: -22, x1: 16, z1: -19, h: 2.6, c: 4 },  // elbow into site B

  // North quay: defender-side cover, one box per site approach.
  { x0: -14, z0: -22, x1: -8, z1: -19, h: 2.6, c: 1 },
  { x0: 8, z0: -22, x1: 14, z1: -19, h: 2.6, c: 0 },

  // South gate: attacker-side cover, flanking the spawn corridor.
  { x0: -16, z0: 19, x1: -11, z1: 22, h: 2.6, c: 4 },
  { x0: 11, z0: 19, x1: 16, z1: 22, h: 2.6, c: 2 },
];

// The two objective sites.
export const SITES = {
  A: { id: 'A', name: 'Crane Bay', x: -22, z: -14, r: 4.5 },
  B: { id: 'B', name: 'Cold Store', x: 22, z: -14, r: 4.5 },
};

export const SPAWNS = {
  // Tidebreakers attack from the south gate; Harbour Guard hold the quay.
  attack: [
    { x: -6, z: 21 }, { x: -2, z: 22 }, { x: 2, z: 22 }, { x: 6, z: 21 },
  ],
  defend: [
    { x: -18, z: -20 }, { x: -6, z: -21 }, { x: 6, z: -21 }, { x: 18, z: -20 },
  ],
};

// Waypoint graph bots walk. Nodes are open ground; edges are walkable lines
// (each edge was checked against the obstacle list when the map was drawn).
export const WAYPOINTS = [
  { x: 0, z: 20 },    // 0  attacker spawn
  { x: -14, z: 16 },  // 1  west fork
  { x: 0, z: 14 },    // 2  mid fork
  { x: 14, z: 16 },   // 3  east fork
  { x: -23, z: 5 },   // 4  west lane mid
  { x: 0, z: 4 },     // 5  mid stack south
  { x: 23, z: 5 },    // 6  east lane mid
  { x: -23, z: -6 },  // 7  west lane north
  { x: -14, z: 0 },   // 8  west connector south
  { x: 0, z: -4 },    // 9  mid stack north
  { x: 14, z: 0 },    // 10 east connector south
  { x: 23, z: -6 },   // 11 east lane north
  { x: -14, z: -13 }, // 12 west connector north
  { x: 14, z: -13 },  // 13 east connector north
  { x: -22, z: -14 }, // 14 site A
  { x: 22, z: -14 },  // 15 site B
  { x: -19, z: -18 }, // 16 defender A hold
  { x: 0, z: -17 },   // 17 defender mid hold
  { x: 19, z: -18 },  // 18 defender B hold
  { x: -10, z: -16 }, // 19 A approach
  { x: 10, z: -16 },  // 20 B approach
];

export const EDGES = [
  [0, 1], [0, 2], [0, 3], [1, 4], [2, 5], [3, 6],
  [4, 7], [5, 9], [6, 11], [7, 8], [8, 5], [5, 10], [10, 11],
  [7, 12], [8, 9], [9, 10], [11, 13], [12, 14], [12, 19], [13, 15],
  [13, 20], [14, 19], [15, 20], [19, 16], [19, 17], [20, 17], [20, 18],
  [16, 17], [17, 18], [8, 12], [10, 13], [4, 8], [6, 10],
];

// Adjacency list, built once from EDGES.
const ADJ = WAYPOINTS.map(() => []);
for (const [a, b] of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

// Breadth-first path between waypoint indices; returns a list of node
// indices from `from` to `to` (inclusive), or null when unreachable.
export function findPath(from, to) {
  if (from === to) return [from];
  const prev = new Array(WAYPOINTS.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const n = queue.shift();
    for (const m of ADJ[n]) {
      if (prev[m] === -1) {
        prev[m] = n;
        if (m === to) {
          const path = [to];
          let cur = to;
          while (cur !== from) { cur = prev[cur]; path.unshift(cur); }
          return path;
        }
        queue.push(m);
      }
    }
  }
  return null;
}

// Nearest waypoint to a point (used to snap a bot onto the graph).
export function nearestWaypoint(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const dx = WAYPOINTS[i].x - x;
    const dz = WAYPOINTS[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// --- Collision and sight -------------------------------------------------

function pointInBox(x, z, b, pad) {
  return x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad;
}

// Resolve a circle (player radius r) against every obstacle: push the point
// out of each box it overlaps. Returns nothing; mutates `p` in place.
export function collide(p, r) {
  for (const b of OBSTACLES) {
    if (!pointInBox(p.x, p.z, b, r)) continue;
    const cx = Math.max(b.x0, Math.min(p.x, b.x1));
    const cz = Math.max(b.z0, Math.min(p.z, b.z1));
    let dx = p.x - cx;
    let dz = p.z - cz;
    let d2 = dx * dx + dz * dz;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      const push = (r - d) / d;
      p.x += dx * push;
      p.z += dz * push;
    } else {
      // Centre inside the box: push out along the smallest penetration axis.
      const pl = p.x - (b.x0 - r);
      const pr = (b.x1 + r) - p.x;
      const pt = p.z - (b.z0 - r);
      const pb = (b.z1 + r) - p.z;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) p.x = b.x0 - r;
      else if (m === pr) p.x = b.x1 + r;
      else if (m === pt) p.z = b.z0 - r;
      else p.z = b.z1 + r;
    }
  }
  // Clamp to the yard.
  p.x = Math.max(MAP.minX + r, Math.min(MAP.maxX - r, p.x));
  p.z = Math.max(MAP.minZ + r, Math.min(MAP.maxZ - r, p.z));
}

// 2D segment (x0,z0)->(x1,z1) vs one box, slab test. Returns the entry
// parameter t in [0,1] or -1 when the segment misses the box.
function segmentBoxT(x0, z0, x1, z1, b) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < b.x0 || x0 > b.x1) return -1;
  } else {
    let t1 = (b.x0 - x0) / dx;
    let t2 = (b.x1 - x0) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (z0 < b.z0 || z0 > b.z1) return -1;
  } else {
    let t1 = (b.z0 - z0) / dz;
    let t2 = (b.z1 - z0) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// True when the segment between two eye-height points is blocked by any tall
// obstacle. Low crates (h <= 1.2) never block sight.
export function losBlocked(x0, z0, x1, z1) {
  for (const b of OBSTACLES) {
    if (b.h <= 1.2) continue;
    if (segmentBoxT(x0, z0, x1, z1, b) >= 0) return true;
  }
  return false;
}

// Ray from an eye (ox, oy, oz) along a unit direction; returns the distance
// to the nearest wall the ray hits, or Infinity. A wall blocks the ray only
// where the ray's height at the crossing is below the wall's top.
export function rayWallDistance(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = Infinity;
  for (const b of OBSTACLES) {
    const t = segmentBoxT(ox, oz, ox + dx * maxDist, oz + dz * maxDist, b);
    if (t < 0) continue;
    const dist = t * maxDist;
    if (dist >= best) continue;
    const yAt = oy + dy * dist;
    if (yAt < b.h) best = dist;
  }
  return best;
}

// Which site (if any) contains this point.
export function siteAt(x, z) {
  for (const key of ['A', 'B']) {
    const s = SITES[key];
    const dx = x - s.x;
    const dz = z - s.z;
    if (dx * dx + dz * dz <= s.r * s.r) return s;
  }
  return null;
}
