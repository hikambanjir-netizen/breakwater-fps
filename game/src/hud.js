// hud.js — Breakwater's DOM HUD: health, ammo, timer, score, money,
// killfeed, minimap, buy menu, channel bar and round banners.
//
// The HUD is the only module that touches the DOM. It reads sim state once
// a frame and writes text and canvas pixels; it never owns game rules.
// The buy menu is a real menu: during the 12 s buy phase it is open, the
// pointer is free, and keys 1-5 / clicks buy. Pressing B reopens it.

import { GUNS, GRENADES, GEAR, GUN_ORDER, ECONOMY, ROUND } from './weapons.js';
import { SITES, OBSTACLES, MAP } from './world.js';
import { TEAM } from './sim.js';

function el(id) { return document.getElementById(id); }

export class Hud {
  constructor(sim, audio, onBuy, onStart) {
    this.sim = sim;
    this.audio = audio;
    this.onBuy = onBuy;   // (itemId) => status string
    this.onStart = onStart; // called when the player clicks "Deploy"
    this.lastHp = 100;
    this.buyOpen = false;
    this.flashEl = el('flash');
    this.buildBuyMenu();
    this.buildMinimap();
    el('play').addEventListener('click', () => {
      this.audio.ensure();
      this.audio.click();
      el('overlay').hidden = true;
      this.onStart();
    });
    el('buy-close').addEventListener('click', () => this.closeBuy());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'b' || e.key === 'B') {
        if (this.sim.phase === 'buy') this.buyOpen ? this.closeBuy() : this.openBuy();
      }
      if (this.buyOpen && this.sim.phase === 'buy') {
        const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
        if (idx >= 0 && idx < GUN_ORDER.length) this.tryBuy(GUN_ORDER[idx]);
        if (e.key === '6') this.tryBuy('smoke');
        if (e.key === '7') this.tryBuy('flash');
        if (e.key === '8') this.tryBuy('frag');
        if (e.key === '9') this.tryBuy('armour');
        if (e.key === '0') this.tryBuy('kit');
      }
    });
  }

  buildBuyMenu() {
    const list = el('buy-list');
    const addRow = (id, name, price, blurb, key) => {
      const row = document.createElement('button');
      row.className = 'buy-row';
      row.dataset.item = id;
      row.innerHTML = `<span class="buy-key">${key}</span><span class="buy-name">${name}</span>` +
        `<span class="buy-blurb">${blurb}</span><span class="buy-price">$${price}</span>`;
      row.addEventListener('click', () => this.tryBuy(id));
      list.appendChild(row);
    };
    GUN_ORDER.forEach((id, i) => {
      const g = GUNS[id];
      addRow(id, g.name, g.price, `${g.blurb} · ${g.damage} dmg · ${g.magSize} rounds`, String(i + 1));
    });
    addRow('smoke', GRENADES.smoke.name, GRENADES.smoke.price, GRENADES.smoke.blurb, '6');
    addRow('flash', GRENADES.flash.name, GRENADES.flash.price, GRENADES.flash.blurb, '7');
    addRow('frag', GRENADES.frag.name, GRENADES.frag.price, GRENADES.frag.blurb, '8');
    addRow('armour', GEAR.armour.name, GEAR.armour.price, GEAR.armour.blurb, '9');
    addRow('kit', GEAR.kit.name, GEAR.kit.price, GEAR.kit.blurb, '0');
  }

  tryBuy(itemId) {
    const status = this.onBuy(itemId);
    const note = el('buy-note');
    if (status === 'ok') {
      this.audio.click();
      note.textContent = 'Bought. Good luck out there.';
    } else {
      note.textContent = status;
    }
    this.refreshBuy();
  }

  refreshBuy() {
    const human = this.sim.human();
    if (!human) return;
    el('buy-money').textContent = `$${human.money}`;
    for (const row of document.querySelectorAll('.buy-row')) {
      const id = row.dataset.item;
      const owned = (GUNS[id] && human.gun === id)
        || (GRENADES[id] && human.grenades[id] > 0)
        || (id === 'armour' && human.armour >= 100)
        || (id === 'kit' && human.hasKit);
      row.classList.toggle('owned', !!owned);
    }
  }

  openBuy() {
    this.buyOpen = true;
    el('buy').hidden = false;
    document.exitPointerLock?.();
    this.refreshBuy();
  }

  closeBuy() {
    this.buyOpen = false;
    el('buy').hidden = true;
  }

  buildMinimap() {
    this.mapCanvas = el('minimap');
    this.mapCtx = this.mapCanvas.getContext('2d');
  }

  drawMinimap() {
    const ctx = this.mapCtx;
    const W = this.mapCanvas.width;
    const H = this.mapCanvas.height;
    const sx = (x) => ((x - MAP.minX) / (MAP.maxX - MAP.minX)) * W;
    const sz = (z) => ((z - MAP.minZ) / (MAP.maxZ - MAP.minZ)) * H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(20,26,32,0.85)';
    ctx.fillRect(0, 0, W, H);
    // Walls.
    ctx.fillStyle = '#5a6a78';
    for (const b of OBSTACLES) {
      ctx.fillRect(sx(b.x0), sz(b.z0), sx(b.x1) - sx(b.x0), sz(b.z1) - sz(b.z0));
    }
    // Sites.
    for (const key of ['A', 'B']) {
      const s = SITES[key];
      ctx.strokeStyle = '#ffb45e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx(s.x), sz(s.z), 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffb45e';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(key, sx(s.x), sz(s.z) + 3);
    }
    // The planted charge blinks red.
    if (this.sim.charge) {
      const c = this.sim.charge;
      ctx.fillStyle = Math.sin(performance.now() / 120) > 0 ? '#ff4040' : '#7a1010';
      ctx.beginPath();
      ctx.arc(sx(c.x), sz(c.z), 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Players: teammates blue, enemies only when intel knows them.
    for (const p of this.sim.players) {
      if (!p.alive) continue;
      if (p.isHuman) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(sx(p.x), sz(p.z), 4, 0, Math.PI * 2);
        ctx.fill();
        // Facing tick.
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(sx(p.x), sz(p.z));
        ctx.lineTo(sx(p.x) - Math.sin(p.yaw) * 8, sz(p.z) - Math.cos(p.yaw) * 8);
        ctx.stroke();
      } else if (p.team === 'attack') {
        ctx.fillStyle = TEAM.attack.css;
        ctx.beginPath();
        ctx.arc(sx(p.x), sz(p.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Heard enemies: orange pings that fade with the intel's age.
    for (const p of this.sim.players) {
      if (p.team !== 'attack' || !p.alive) continue;
      const intel = p.lastSeen;
      const age = this.sim.time - intel.t;
      if (age < 6 && age >= 0) {
        ctx.fillStyle = `rgba(224,120,64,${1 - age / 6})`;
        ctx.beginPath();
        ctx.arc(sx(intel.x), sz(intel.z), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // --- per-frame refresh ------------------------------------------------

  update() {
    const sim = this.sim;
    const human = sim.human();
    if (!human) return;

    // Health: number, bar, and a red pulse on damage.
    el('hp-value').textContent = String(Math.max(0, Math.ceil(human.hp)));
    el('hp-fill').style.width = `${Math.max(0, human.hp)}%`;
    if (human.hp < this.lastHp) el('hp').classList.add('hurt');
    else el('hp').classList.remove('hurt');
    this.lastHp = human.hp;
    el('armour-value').textContent = human.armour > 0 ? `+${Math.ceil(human.armour)} armour` : '';

    // Ammo, money, weapon, grenades.
    const gun = GUNS[human.gun];
    el('ammo-mag').textContent = String(human.mag);
    el('ammo-reserve').textContent = `/ ${human.reserve}`;
    el('ammo').classList.toggle('empty', human.mag === 0);
    el('weapon-name').textContent = gun.name;
    el('money').textContent = `$${human.money}`;
    el('grenades').textContent =
      `Smoke ${human.grenades.smoke} · Flash ${human.grenades.flash} · Frag ${human.grenades.frag}` +
      (human.hasKit ? ' · Kit' : '');

    // Timer and score. The timer turns red under 10 s.
    const t = Math.max(0, Math.ceil(sim.timer));
    const mm = String(Math.floor(t / 60));
    const ss = String(t % 60).padStart(2, '0');
    const timerEl = el('timer');
    timerEl.textContent = sim.phase === 'buy' ? `BUY ${mm}:${ss}`
      : sim.phase === 'live' ? `${mm}:${ss}`
      : sim.phase === 'roundEnd' ? '—'
      : '—';
    timerEl.classList.toggle('low', sim.phase === 'live' && t <= 10);
    el('score-attack').textContent = String(sim.score.attack);
    el('score-defend').textContent = String(sim.score.defend);
    el('round-label').textContent = sim.phase === 'menu' ? 'BREAKWATER' : `ROUND ${sim.round}${sim.overtime ? ' · OT' : ''}`;
    if (sim.phase === 'buy') el('buy-round').textContent = String(sim.round);
    el('charge-state').textContent = sim.charge
      ? `CHARGE LIVE ${Math.ceil(sim.charge.fuse)}s · ${sim.charge.site.name}`
      : sim.droppedCharge
        ? 'CHARGE DROPPED — recover it'
        : (sim.chargeCarrier === human && sim.phase === 'live' ? 'YOU CARRY THE SURGE CHARGE' : (sim.phase === 'live' ? 'No charge planted' : ''));

    // Crosshair spread grows with the sim's bloom, so the player sees the
    // accuracy model instead of guessing at it.
    const spreadPx = 3 + human.bloom * 220 + (human.moving ? 5 : 0);
    el('crosshair').style.setProperty('--gap', `${spreadPx.toFixed(1)}px`);

    // Channel bar: planting or defusing.
    const ch = human.channel;
    const bar = el('channel');
    if (ch) {
      bar.hidden = false;
      el('channel-label').textContent = ch.kind === 'plant' ? 'PLANTING SURGE CHARGE' : 'DEFUSING';
      el('channel-fill').style.width = `${(ch.progress * 100).toFixed(0)}%`;
    } else {
      bar.hidden = true;
    }

    // Round banner during roundEnd, match banner at the end.
    const banner = el('banner');
    if (sim.phase === 'roundEnd') {
      banner.hidden = false;
      el('banner-text').textContent = sim.banner;
    } else if (sim.phase === 'matchEnd') {
      banner.hidden = false;
      el('banner-text').textContent = sim.matchWinner === 'attack'
        ? 'TIDEBREAKERS TAKE THE YARD — match won'
        : 'HARBOUR GUARD HOLD THE YARD — match won';
    } else {
      banner.hidden = true;
    }

    // Buy menu follows the phase: open at buy, closed once live.
    if (sim.phase === 'buy' && !this.buyOpen && !sim._shotMode) this.openBuy();
    if (sim.phase !== 'buy' && this.buyOpen) this.closeBuy();

    // Flashbang white-out for the human.
    this.flashEl.style.opacity = String(human.blind > 0 ? human.blind * 0.9 : 0);

    this.drawMinimap();
    this.updateKillfeed();
  }

  updateKillfeed() {
    const feed = el('killfeed');
    const rows = this.sim.killfeed.slice(-5).reverse();
    feed.innerHTML = rows.map((k) =>
      `<div class="kf-row"><span class="kf-killer">${k.killer}</span>` +
      `<span class="kf-gun">${k.head ? '◉ ' : ''}${k.gun}</span>` +
      `<span class="kf-victim">${k.victim}</span></div>`).join('');
  }

  // Sounds the HUD triggers from sim events (view handles the visuals).
  onEvent(e) {
    if (e.type === 'hit' && e.attacker === this.sim.human()?.id) {
      this.audio.hit(e.head);
      // Hitmarker flash: on for 120 ms, longer on a headshot.
      const hm = el('hitmarker');
      hm.classList.add('on');
      clearTimeout(this._hmTimer);
      this._hmTimer = setTimeout(() => hm.classList.remove('on'), e.head ? 220 : 120);
    }
    if (e.type === 'shot' && e.player === this.sim.human()?.id) this.audio.shot(e.gun);
    if (e.type === 'reloadStart' && e.player === this.sim.human()?.id) this.audio.reload();
    if (e.type === 'plantStart') this.audio.plantBeep();
    if (e.type === 'explosion') this.audio.explosion();
    if (e.type === 'roundEnd') {
      if (e.winner === 'attack') this.audio.roundWin();
      else this.audio.roundLose();
    }
  }
}
