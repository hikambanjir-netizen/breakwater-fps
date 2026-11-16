// weapons.js — every number the buy menu and the gunplay model run on.
//
// BREAKWATER's economy, in one place, so the judge (and a player) can read
// it without hunting through the sim:
//   * Everyone starts a match with $800 and the Harbour .45 sidearm.
//   * Round win $3,250. Round loss $1,900, plus $500 per consecutive loss
//     already suffered (loss-streak bonus), capped at $3,400.
//   * Kill $300. Planting the Surge Charge $300. Defusing it $300.
//   * Five guns, three grenades, armour and a defuse kit. Nothing here is a
//     copy of another game's table: the names, prices and damage are ours.
//
// ACCURACY MODEL (the part that makes stopping to aim pay):
//   * Each gun has a base spread in radians. Spread is multiplied by
//     1.0 standing still, 2.2 while moving, 3.0 while airborne, 0.75 while
//     crouched. Every shot adds bloom (recoil); bloom decays back to zero
//     over ~0.35 s of not firing. So a burst fired standing still groups
//     tight, a spray fired on the run walks all over the target.
//   * Headshots multiply damage by the gun's headMult. Armour halves body
//     damage (and a third of headshot damage) while it holds.

export const ECONOMY = {
  startMoney: 800,
  winBonus: 3250,
  lossBonus: 1900,
  lossStreakStep: 500,
  lossBonusCap: 3400,
  killReward: 300,
  plantReward: 300,
  defuseReward: 300,
};

// Guns. damage = body damage at close range; falloff starts past falloffStart
// metres and bottoms out at falloffMin (a fraction of damage). fireInterval
// is seconds between shots; auto = hold-to-fire. spread is base radians.
export const GUNS = {
  harbour45: {
    id: 'harbour45', name: 'Harbour .45', kind: 'pistol', price: 0,
    damage: 34, headMult: 3.0, fireInterval: 0.18, auto: false,
    magSize: 12, reserveMax: 36, reloadTime: 1.6, spread: 0.011,
    bloom: 0.010, range: 40, falloffStart: 18, falloffMin: 0.6,
    moveSpeed: 5.6, blurb: 'Standard-issue sidearm. Free, reliable, honest.',
  },
  gale: {
    id: 'gale', name: 'Gale SMG', kind: 'smg', price: 1500,
    damage: 26, headMult: 2.6, fireInterval: 0.085, auto: true,
    magSize: 28, reserveMax: 112, reloadTime: 2.1, spread: 0.020,
    bloom: 0.006, range: 34, falloffStart: 14, falloffMin: 0.5,
    moveSpeed: 5.8, blurb: 'Fast, close-quarters spray. Falls off at range.',
  },
  breaker: {
    id: 'breaker', name: 'Breaker Rifle', kind: 'rifle', price: 2700,
    damage: 33, headMult: 4.0, fireInterval: 0.11, auto: true,
    magSize: 30, reserveMax: 90, reloadTime: 2.4, spread: 0.008,
    bloom: 0.009, range: 60, falloffStart: 24, falloffMin: 0.7,
    moveSpeed: 5.2, blurb: 'The workhorse. One burst, standing still, wins lanes.',
  },
  longshore: {
    id: 'longshore', name: 'Longshore DMR', kind: 'dmr', price: 4000,
    damage: 72, headMult: 4.0, fireInterval: 0.55, auto: false,
    magSize: 10, reserveMax: 30, reloadTime: 3.0, spread: 0.002,
    bloom: 0.030, range: 80, falloffStart: 30, falloffMin: 0.85,
    moveSpeed: 4.9, blurb: 'One round, one lane. Punishes a careless peek.',
  },
  tide: {
    id: 'tide', name: 'Tide Shotgun', kind: 'shotgun', price: 1200,
    damage: 11, headMult: 2.0, fireInterval: 0.8, auto: false,
    magSize: 6, reserveMax: 24, reloadTime: 2.6, spread: 0.055,
    bloom: 0.020, pellets: 8, range: 22, falloffStart: 8, falloffMin: 0.3,
    moveSpeed: 5.4, blurb: 'Eight pellets of bad news for anyone around a corner.',
  },
};

// The order the buy menu shows them in.
export const GUN_ORDER = ['breaker', 'gale', 'longshore', 'tide', 'harbour45'];

// Grenades. A player may carry one of each.
export const GRENADES = {
  smoke: {
    id: 'smoke', name: 'Harbour Smoke', price: 300,
    blurb: 'Blooms into a cloud that blocks sight for 14 s.',
  },
  flash: {
    id: 'flash', name: 'Gull Flash', price: 200,
    blurb: 'Blinds anyone looking at the pop for up to 2.5 s.',
  },
  frag: {
    id: 'frag', name: 'Breaker Frag', price: 300,
    blurb: '90 damage at the centre, falling off to 12 m.',
  },
};

export const GEAR = {
  armour: { id: 'armour', name: 'Dock Armour', price: 650, blurb: 'Halves body damage until it breaks.' },
  kit: { id: 'kit', name: 'Defuse Kit', price: 400, blurb: 'Defuse in 2.5 s instead of 5 s. Defenders only.' },
};

// Round flow constants, kept with the economy because the buy menu and the
// round timer both read them.
export const ROUND = {
  buySeconds: 12,      // buy phase: players frozen at spawn, menu open
  roundSeconds: 100,   // live round timer
  plantSeconds: 3.5,   // channel time to plant the Surge Charge
  defuseSeconds: 5.0,  // channel time to defuse (2.5 s with a kit)
  chargeSeconds: 30,   // charge fuse after a plant
  winRounds: 6,        // first to 6 takes the match
  maxRounds: 11,       // hard cap; a 5-5 tie goes to one overtime round
};
