// view.js — Breakwater's three.js renderer.
//
// One job: turn sim state into a picture. It owns the scene, the camera,
// the map geometry and every effect, and it owns nothing about rules —
// rounds, money and damage live in sim.js. Hot loops allocate nothing:
// tracers, muzzle flashes, smoke puffs and sparks come from fixed pools
// and are recycled, so the frame rate does not decay over a long match.
//
// LOOK (chosen palette, applied everywhere): a container port at dusk —
// deep slate water-blue sky, warm sodium lamps, rust-red and teal
// containers, mustard cranes. The two teams read at a glance: attackers
// are harbour blue, defenders are signal orange.

import * as THREE from 'three';
import { OBSTACLES, SITES, MAP } from './world.js';
import { TEAM } from './sim.js';

const CONTAINER_COLOURS = [0x9a4a32, 0x2e7d7b, 0xc2a13a, 0x4a5560, 0x2f5d8a];
const GROUND_COLOUR = 0x272d34;
const SKY_COLOUR = 0x2b3d4f;
const FOG_COLOUR = 0x2b3d4f;

// Pooled effect counts: enough for a busy firefight, small enough to build once.
const TRACER_POOL = 24;
const SPARK_POOL = 40;
const SMOKE_POOL = 10;

function letterTexture(letter, colour) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(20,24,28,0.55)';
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
  g.strokeStyle = colour; g.lineWidth = 6;
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.fillStyle = colour;
  g.font = 'bold 72px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(letter, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class View {
  constructor(sim, container) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOUR);
    this.scene.fog = new THREE.Fog(FOG_COLOUR, 30, 95);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 220);
    this.scene.add(this.camera);
    // A small warm fill light on the camera: it lifts the viewmodel gun
    // and the ground at the player's feet out of the dusk shadow.
    const fill = new THREE.PointLight(0xfff2dd, 5, 3.5, 2);
    fill.position.set(0.3, 0.2, -0.4);
    this.camera.add(fill);

    const hemi = new THREE.HemisphereLight(0x9fc4e0, 0x2a2620, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffc98a, 1.8);
    sun.position.set(-30, 42, 28);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
    sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
    sun.shadow.camera.far = 140;
    this.scene.add(sun);
    // One warm lamp over each site, so the objectives read at a glance.
    for (const key of ['A', 'B']) {
      const s = SITES[key];
      const lamp = new THREE.PointLight(0xffb45e, 60, 26, 1.8);
      lamp.position.set(s.x, 7, s.z);
      this.scene.add(lamp);
    }

    this.buildMap();
    this.buildAgents();
    this.buildEffects();
    this.buildViewmodel();

    this.shake = 0;
    this.flashOverlay = 0;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._tmp3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  buildMap() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 70),
      new THREE.MeshStandardMaterial({ color: GROUND_COLOUR, roughness: 0.95, metalness: 0.05 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Painted lane markings: thin pale strips along the three lanes.
    const laneMat = new THREE.MeshBasicMaterial({ color: 0x4a545e });
    for (const [x, len] of [[-23, 40], [0, 40], [23, 40]]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, len), laneMat);
      strip.position.set(x, 0.01, 0);
      this.scene.add(strip);
    }

    // Containers and walls, one mesh per obstacle, with a darker roof lip
    // so stacked boxes read as separate units.
    for (const b of OBSTACLES) {
      const w = b.x1 - b.x0;
      const d = b.z1 - b.z0;
      const mat = new THREE.MeshStandardMaterial({
        color: CONTAINER_COLOURS[b.c], roughness: 0.8, metalness: 0.25,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, b.h, d), mat);
      box.position.set((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      box.castShadow = b.h > 1.2;
      box.receiveShadow = true;
      this.scene.add(box);
      if (b.h > 1.2) {
        const lip = new THREE.Mesh(
          new THREE.BoxGeometry(w + 0.12, 0.12, d + 0.12),
          new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.9 }),
        );
        lip.position.set(box.position.x, b.h + 0.02, box.position.z);
        this.scene.add(lip);
      }
    }

    // The gantry crane over site A: two legs and a beam, mustard yellow.
    const craneMat = new THREE.MeshStandardMaterial({ color: 0xc2a13a, roughness: 0.6, metalness: 0.4 });
    for (const lx of [-27, -17]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 14, 1.2), craneMat);
      leg.position.set(lx, 7, -14);
      leg.castShadow = true;
      this.scene.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(12, 1.4, 1.6), craneMat);
    beam.position.set(-22, 14.4, -14);
    beam.castShadow = true;
    this.scene.add(beam);

    // The Cold Store warehouse behind site B: a tall pale box with a door.
    const store = new THREE.Mesh(
      new THREE.BoxGeometry(10, 8, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.7, metalness: 0.2 }),
    );
    store.position.set(22, 4, -23.4);
    store.castShadow = true;
    this.scene.add(store);

    // Site markers: a ground ring, a light beam and a floating letter.
    this.siteMarkers = {};
    for (const key of ['A', 'B']) {
      const s = SITES[key];
      const group = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(s.r - 0.35, s.r, 40),
        new THREE.MeshBasicMaterial({ color: 0xffb45e, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      group.add(ring);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffb45e, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide,
      });
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(s.r * 0.8, s.r * 0.8, 9, 24, 1, true), beamMat);
      cyl.position.y = 4.5;
      group.add(cyl);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: letterTexture(key, '#ffb45e'), transparent: true, depthTest: false,
      }));
      sprite.scale.set(3.4, 3.4, 1);
      sprite.position.y = 6.5;
      group.add(sprite);
      group.position.set(s.x, 0, s.z);
      this.scene.add(group);
      this.siteMarkers[key] = group;
    }

    // The Surge Charge device, hidden until a plant lands.
    this.chargeMesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.35, 0.45),
      new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.5, metalness: 0.6 }),
    );
    body.position.y = 0.18;
    this.chargeMesh.add(body);
    this.chargeLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff4040 }),
    );
    this.chargeLight.position.set(0, 0.42, 0);
    this.chargeMesh.add(this.chargeLight);
    this.chargeMesh.visible = false;
    this.scene.add(this.chargeMesh);
  }

  buildAgents() {
    // One group per player, built once and reposed every frame: a torso in
    // team colours, a helmeted head, legs, and a gun. No per-frame meshes.
    this.agentMeshes = new Map();
    for (const p of this.sim.players) {
      const team = TEAM[p.team];
      const group = new THREE.Group();
      const torsoMat = new THREE.MeshStandardMaterial({ color: team.colour, roughness: 0.75 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.85 });
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.36), torsoMat);
      torso.position.y = 1.05;
      torso.castShadow = true;
      group.add(torso);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), darkMat);
      head.position.y = 1.56;
      head.castShadow = true;
      group.add(head);
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.09, 0.05),
        new THREE.MeshBasicMaterial({ color: team.colour }),
      );
      visor.position.set(0, 1.56, -0.19);
      group.add(visor);
      for (const sx of [-0.14, 0.14]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.24), darkMat);
        leg.position.set(sx, 0.31, 0);
        leg.castShadow = true;
        group.add(leg);
      }
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.85), darkMat);
      gun.position.set(0.22, 1.28, -0.45);
      group.add(gun);
      // A small team ring on the ground: teammates are findable at a glance.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.58, 24),
        new THREE.MeshBasicMaterial({ color: team.colour, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      group.add(ring);
      this.scene.add(group);
      this.agentMeshes.set(p.id, { group, torso, head, ring });
    }
  }

  buildEffects() {
    // Tracers: thin additive cylinders, recycled. A 1 px line is invisible
    // in a screenshot; a cylinder reads as a bullet streak. Each tracer's
    // mesh is scaled and aimed in place, never rebuilt.
    this.tracers = [];
    const tracerGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6, 1, true);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(tracerGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    // Hit sparks: small additive points, one shared geometry per spark.
    this.sparks = [];
    const sparkGeo = new THREE.SphereGeometry(0.05, 6, 4);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true });
    for (let i = 0; i < SPARK_POOL; i++) {
      const m = new THREE.Mesh(sparkGeo, sparkMat.clone());
      m.visible = false;
      this.scene.add(m);
      this.sparks.push({ mesh: m, life: 0 });
    }
    // Smoke puffs: big soft spheres that grow and fade.
    this.smokes = [];
    const smokeGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < SMOKE_POOL; i++) {
      const m = new THREE.Mesh(smokeGeo, new THREE.MeshStandardMaterial({
        color: 0x9aa4ac, transparent: true, opacity: 0, roughness: 1,
      }));
      m.visible = false;
      this.scene.add(m);
      this.smokes.push({ mesh: m, life: 0, x: 0, z: 0 });
    }
    // Muzzle flash: one light + one quad, repositioned to whoever fired.
    this.muzzleLight = new THREE.PointLight(0xffc27a, 0, 9, 2);
    this.scene.add(this.muzzleLight);
    this.muzzleLife = 0;
  }

  buildViewmodel() {
    // The gun in the player's hands: dark metal, a warm grip, a short
    // barrel. It bobs with footsteps and kicks with every shot.
    const vm = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x4a525a, roughness: 0.45, metalness: 0.7 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 });
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), metal);
    vm.add(receiver);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 10), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.03, -0.42);
    vm.add(barrel);
    const gripMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), grip);
    gripMesh.position.set(0, -0.14, 0.12);
    gripMesh.rotation.x = 0.35;
    vm.add(gripMesh);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.1), metal);
    sight.position.set(0, 0.1, -0.1);
    vm.add(sight);
    vm.position.set(0.28, -0.24, -0.55);
    this.camera.add(vm);
    this.viewmodel = vm;
    this.viewmodelKick = 0;
  }

  // --- events from the sim ------------------------------------------------

  onEvent(e) {
    if (e.type === 'shot') {
      const from = this._tmp.set(e.x, e.y, e.z);
      // The tracer's far end is filled in by the tracerHit / tracerEnd
      // event that follows in the same step.
      this._pendingTracerFrom = from.clone();
      this.muzzleLight.position.set(e.x, e.y, e.z);
      this.muzzleLight.intensity = 26;
      this.muzzleLife = 0.06;
      this.viewmodelKick = 1;
      return;
    }
    if (e.type === 'tracerHit' || e.type === 'tracerEnd') {
      if (!this._pendingTracerFrom) return;
      const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
      // Start the tracer a little ahead of the muzzle: a streak that begins
      // at the camera reads as a blinding beam instead of a bullet path.
      const from = this._tmp.copy(this._pendingTracerFrom);
      const to = this._tmp2.set(e.x, e.y, e.z);
      const dir = this._tmp3.copy(to).sub(from);
      const len = dir.length() || 1;
      dir.divideScalar(len);
      const off = Math.min(1.4, len * 0.5);
      from.addScaledVector(dir, off);
      t.mesh.position.copy(from).add(to).multiplyScalar(0.5);
      t.mesh.scale.set(1, from.distanceTo(to), 1);
      t.mesh.quaternion.setFromUnitVectors(this._up, dir);
      t.mesh.visible = true;
      t.life = 0.12;
      this._pendingTracerFrom = null;
      if (e.type === 'tracerHit') {
        const s = this.sparks.find((x) => x.life <= 0) ?? this.sparks[0];
        s.mesh.position.set(e.x, e.y, e.z);
        s.mesh.visible = true;
        s.life = 0.18;
      }
      return;
    }
    if (e.type === 'smoke') {
      const s = this.smokes.find((x) => x.life <= 0) ?? this.smokes[0];
      s.mesh.position.set(e.x, 1.4, e.z);
      s.mesh.visible = true;
      s.life = 14;
      s.x = e.x; s.z = e.z;
      return;
    }
    if (e.type === 'explosion') {
      this.shake = 1;
      this.muzzleLight.position.set(e.x, 1.5, e.z);
      this.muzzleLight.intensity = 120;
      this.muzzleLife = 0.35;
      return;
    }
    if (e.type === 'planted') {
      const s = SITES[e.site];
      this.chargeMesh.position.set(s.x, 0, s.z);
      this.chargeMesh.visible = true;
      return;
    }
    if (e.type === 'chargeDropped') {
      this.chargeMesh.position.set(e.x, 0, e.z);
      this.chargeMesh.visible = true;
      return;
    }
    if (e.type === 'chargePickedUp') {
      this.chargeMesh.visible = false;
      return;
    }
    if (e.type === 'defused' || e.type === 'exploded') {
      this.chargeMesh.visible = false;
    }
  }

  // --- per-frame render ---------------------------------------------------

  render(dt, now) {
    const sim = this.sim;
    const human = sim.human();

    // Camera follows the human: eye height, yaw/pitch, walk bob, recoil
    // kick, explosion shake. The camera is the player's head.
    if (human) {
      const eyeY = human.crouch ? 1.12 : 1.55;
      const bobPhase = now * (human.moving ? 11 : 0);
      const bob = human.moving ? Math.sin(bobPhase) * 0.035 : 0;
      this.shake = Math.max(0, this.shake - dt * 1.8);
      const shX = (Math.random() - 0.5) * this.shake * 0.12;
      const shY = (Math.random() - 0.5) * this.shake * 0.12;
      this.camera.position.set(human.x + shX, eyeY + bob + shY, human.z);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = human.yaw;
      this.camera.rotation.x = human.pitch;
      this.camera.rotation.z = 0;
      // Viewmodel bob and recoil recovery.
      this.viewmodelKick = Math.max(0, this.viewmodelKick - dt * 7);
      this.viewmodel.position.z = -0.55 + this.viewmodelKick * 0.09;
      this.viewmodel.position.y = -0.24 + (human.moving ? Math.sin(bobPhase) * 0.012 : 0);
      this.viewmodel.rotation.x = this.viewmodelKick * 0.12;
    }

    // Agents: position, facing, crouch scale, death fall.
    for (const p of sim.players) {
      const m = this.agentMeshes.get(p.id);
      if (!m) continue;
      if (p === human) { m.group.visible = false; continue; }
      m.group.visible = true;
      m.group.position.set(p.x, 0, p.z);
      if (!p.alive) {
        m.group.rotation.z = Math.PI / 2 * 0.9;
        m.group.position.y = 0.15;
      } else {
        m.group.rotation.z = 0;
        m.group.position.y = 0;
        m.group.rotation.y = p.yaw;
        m.group.scale.y = p.crouch ? 0.78 : 1;
      }
    }

    // Charge blink: faster as the fuse runs down.
    if (this.chargeMesh.visible && sim.charge) {
      const rate = 2 + (1 - sim.charge.fuse / 30) * 8;
      this.chargeLight.material.color.setHex(Math.sin(now * rate) > 0 ? 0xff4040 : 0x400000);
    }

    // Effect pools decay.
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = Math.max(0, t.life / 0.12) * 0.9;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    for (const s of this.sparks) {
      if (s.life > 0) {
        s.life -= dt;
        s.mesh.material.opacity = Math.max(0, s.life / 0.18);
        s.mesh.scale.setScalar(1 + (0.18 - s.life) * 6);
        if (s.life <= 0) s.mesh.visible = false;
      }
    }
    for (const s of this.smokes) {
      if (s.life > 0) {
        s.life -= dt;
        const grow = 1 + (14 - s.life) * 0.25;
        s.mesh.scale.setScalar(Math.min(grow, 3.4));
        s.mesh.material.opacity = Math.min(0.85, s.life > 13 ? (14 - s.life) : 0.85);
        if (s.life <= 0) { s.mesh.visible = false; s.mesh.material.opacity = 0; }
      }
    }
    if (this.muzzleLife > 0) {
      this.muzzleLife -= dt;
      if (this.muzzleLife <= 0) this.muzzleLight.intensity = 0;
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
