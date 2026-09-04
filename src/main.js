// Game bootstrap: waves, pickups, scoring, screens and the main loop.
import * as THREE from 'three';
import { InkRenderer, INK, makeInkMaterial } from './render.js';
import { World } from './physics.js';
import { Input } from './input.js';
import { buildLevel, LEVELS } from './level.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { EnemyManager } from './enemies.js';
import { Player } from './player.js';
import { HUD, CONTROLS_HTML } from './hud.js';
import { audio } from './audio.js';
import { rand, choose, clamp } from './util.js';

const canvas = document.getElementById('c');
const R = new InkRenderer(canvas);
const world = new World();
let mapKey = localStorage.getItem('doodle_map') || 'district';
if (!LEVELS.some((m) => m.key === mapKey)) mapKey = 'district';
let level = buildLevel(R.scene, world, mapKey);
let nav = new NavGrid(world, level.bounds, 1).build();
console.log(`map ${mapKey}: ${nav.nodes.length} nav nodes, ${world.boxes.length} colliders`);
// Swap maps in place: the same World and scene are reused so every system keeps its references.
function loadMap(key) {
  if (key === mapKey && level) return;
  mapKey = key; localStorage.setItem('doodle_map', key);
  for (const m of level.meshes) { R.scene.remove(m); if (m.geometry) m.geometry.dispose(); }
  level.animated.length = 0; world.clear();
  level = buildLevel(R.scene, world, key);
  nav = new NavGrid(world, level.bounds, 1).build();
  ctx.level = level; ctx.nav = nav;
  console.log(`map ${key}: ${nav.nodes.length} nav nodes, ${world.boxes.length} colliders`);
}
const input = new Input(canvas);
const hud = new HUD(document.getElementById('hud'));
const effects = new Effects(R.scene, world);
const ctx = { scene: R.scene, camera: R.camera, world, level, nav, input, hud, effects, audio, renderer: R };
let best = Number(localStorage.getItem('doodle_best') || 0);
let musicWanted = localStorage.getItem('doodle_music') !== '0';
const settings = { sens: Number(localStorage.getItem('doodle_sens') || 100), invert: localStorage.getItem('doodle_invert') === '1' };
let devWave = Math.max(1, Math.round(Number(localStorage.getItem('doodle_devwave') || 1)));
function applySettings() {
  input.mouseSens = 0.0022 * settings.sens / 100; input.padSensX = 3.4 * settings.sens / 100; input.padSensY = 2.6 * settings.sens / 100;
  input.invertY = settings.invert;
  localStorage.setItem('doodle_sens', String(settings.sens)); localStorage.setItem('doodle_invert', settings.invert ? '1' : '0');
}
const game = ctx.game = {
  state: 'start', time: 0, hitstopT: 0, hitstopScale: 1, wave: 0, score: 0, combo: 0, comboT: 0, kills: 0, intermission: 0, queue: [], spawnT: 0, maxAlive: 6, deathT: 0,
  hitstop(d, s) { this.hitstopT = Math.max(this.hitstopT, d); this.hitstopScale = s; },
  addScore(pts, label) { const mult = 1 + Math.min(this.combo, 9) * 0.25; const p = Math.round(pts * mult); this.score += p; if (label) hud.kill(label, p); hud.setScore(this.score, this.combo); },
  onPlayerDeath() { this.state = 'dying'; this.deathT = 0; endFocus(); },
  focus: { active: false, t: 0, chain: 0, target: null, dash: null, arm: 0, ready: false }, katanaStreak: 0,
};
const enemies = ctx.enemies = new EnemyManager(ctx);
enemies.onBoss = (e) => { if (!e.alive) { hud.setBoss(null, null); game.boss = null; } else { game.boss = e; hud.setBoss(e.T.name, e.hp / e.maxHp); } };
const player = ctx.player = new Player(ctx);
window.__game = { ctx, game, player, enemies, nav, world, level, hud, effects, input };

// ---------------- pickups ----------------
const pickups = [];
const pmat = { ammo: makeInkMaterial({ ink: INK.BLUE }), health: makeInkMaterial({ ink: INK.GREEN }), cap: makeInkMaterial({ ink: INK.BLACK }) };
function makePickup(kind) {
  const g = new THREE.Group();
  if (kind === 'ammo') { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), pmat.ammo); g.add(b); const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), pmat.cap); c.position.y = 0.33; g.add(c); const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), pmat.cap); l.position.set(0, 0, 0.24); g.add(l); }
  else { const a = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), pmat.health); const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pmat.health); g.add(a, b); }
  return g;
}
function spawnPickup(kind, pos) { const m = makePickup(kind); m.position.copy(pos); m.position.y += 0.6; R.scene.add(m); pickups.push({ kind, mesh: m, base: m.position.y, t: rand(0, 6), life: 45 }); }
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.life -= dt; p.mesh.position.y = p.base + Math.sin(p.t * 2.5) * 0.12; p.mesh.rotation.y += dt * 1.8;
    if (player.alive && p.mesh.position.distanceTo(player.center) < 1.5) {
      if (p.kind === 'ammo') { player.addAmmoAll(0.4); hud.kill('+AMMO (all guns)', 0); } else { player.hp = Math.min(player.maxHp, player.hp + 35); hud.kill('+35 HP', 0); }
      audio.pickup(); effects.strokeBurst(p.mesh.position, p.kind === 'ammo' ? INK.BLUE : INK.GREEN, 12, 4, { life: 0.3 }); p.life = 0;
    }
    if (p.life <= 0) { R.scene.remove(p.mesh); pickups.splice(i, 1); }
  }
}

// ---------------- waves ----------------
enemies.onKill = (e, info, over) => {
  game.kills++; game.combo++; game.comboT = 3.5;
  let label = e.T.name, pts = e.T.score;
  if (info.crit) { label = 'HEADSHOT'; pts += 60; }
  if (info.source === 'katana') { label = over ? 'SLICED' : 'CUT DOWN'; pts += 50; }
  if (info.source === 'focus') { label = 'EXECUTED'; pts += 150; }
  if (info.source === 'katana' || info.source === 'focus') {
    game.katanaStreak++;
    player.weapons[player.katanaIndex].addBlood(0.42);
    if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus();
  } else if (info.source !== 'blast') game.katanaStreak = 0;
  if (info.source === 'deflect') { label = 'RETURN TO SENDER'; pts += 120; }
  if (info.source === 'fall') { label = 'FELL OFF THE PAGE'; }
  else if (!player.body.onGround && info.source !== 'deflect') { label += ' · AIRBORNE'; pts += 40; }
  game.addScore(pts, label);
  const r = Math.random(); if (r < 0.5) spawnPickup('ammo', e.body.pos); else if (r < 0.62) spawnPickup('health', e.body.pos);
};
// Each wave draws from a widening roster; every fifth wave is a boss fight.
const ROSTER = [
  { t: 'grunt', from: 1, w: 10 }, { t: 'rusher', from: 2, w: 6 }, { t: 'bomber', from: 3, w: 3 },
  { t: 'sniper', from: 3, w: 4 }, { t: 'flyer', from: 4, w: 4 }, { t: 'heavy', from: 5, w: 4 }, { t: 'shield', from: 6, w: 4 },
];
const MODIFIERS = [
  { name: '', apply: () => { enemies.mods.speed = 1; enemies.mods.damage = 1; } },
  { name: 'CAFFEINATED · they move fast', apply: () => { enemies.mods.speed = 1.35; enemies.mods.damage = 0.85; } },
  { name: 'HEAVY INK · they hit harder', apply: () => { enemies.mods.speed = 0.9; enemies.mods.damage = 1.4; } },
  { name: 'SWARM · more of them, thinner', apply: () => { enemies.mods.speed = 1.15; enemies.mods.damage = 0.9; } },
];
const TIPS = [
  'hold <b>Q</b> to reel in · tap it again to let go mid-swing',
  'block with <b>right mouse</b> and their bullets go back at them',
  'kills in the air are worth more · stay off the floor',
  'grapple an enemy to yank them off a ledge',
  'press <b>1-4</b> to swap weapons · the shotgun ends heavies',
];
function startWave(n) {
  game.wave = n; game.queue = []; game.spawnT = 2; game.intermission = 0;
  game.boss = null; hud.setBoss(null, null);
  const boss = n > 0 && n % 5 === 0;
  // modifiers stay off early, and the swarm one waits until you have the tools for it
  const allowed = boss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length;
  const mod = MODIFIERS[Math.floor(Math.random() * allowed)];
  mod.apply(); hud.setModifier(mod.name);
  const swarm = mod.name.startsWith('SWARM');
  game.maxAlive = Math.min(3 + Math.floor(n * 0.8) + (swarm ? 3 : 0), swarm ? 15 : 12);
  let count = Math.round(Math.min(4 + n * 1.7, 28) * (swarm ? 1.35 : 1));
  if (boss) { count = Math.min(6 + n, 14); game.queue.push('boss'); }
  // a type is rare on the wave it debuts and only reaches full weight a few waves later
  const pool = ROSTER.filter((r) => n >= r.from).map((r) => ({ t: r.t, w: r.w * Math.min(1, 0.3 + 0.25 * (n - r.from)) }));
  const total = pool.reduce((a, r) => a + r.w, 0);
  for (let i = 0; i < count; i++) { let r = Math.random() * total, t = pool[0].t; for (const c of pool) { r -= c.w; if (r <= 0) { t = c.t; break; } } game.queue.push(t); }
  if (boss) { hud.message('WAVE ' + n, 'THE DOODLER IS COMING', 3); audio.bossRoar(player.center); }
  else hud.message('WAVE ' + n, n === 1 ? 'they are crawling off the page' : mod.name || choose(['ink harder', 'keep scribbling', 'stay off the ground', 'swing for it', 'return their bullets']), 2.6);
  audio.wave();
  if (n <= TIPS.length) hud.tip(TIPS[n - 1], 7);
  for (let i = 0; i < 7; i++) spawnPickup(i < 5 ? 'ammo' : 'health', choose(level.pickups));
}
function pickSpawn(type) {
  const spots = type === 'sniper' ? level.snipers : level.spawns; const pp = player.body.pos;
  if (type === 'flyer') { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 10; return new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -46, 46), pp.y + 12 + Math.random() * 6, clamp(pp.z + Math.sin(a) * r, -46, 46)); }
  if (type === 'boss') {
    const fits = (sp) => !world.overlapsAABB({ x: sp.x - 1.1, y: sp.y + 0.1, z: sp.z - 1.1 }, { x: sp.x + 1.1, y: sp.y + 5.2, z: sp.z + 1.1 });
    const open = spots.filter((sp) => sp.y < 2 && fits(sp));
    const far = open.filter((sp) => sp.distanceTo(pp) > 20);
    if (far.length) return choose(far).clone();
    if (open.length) return choose(open).clone();
    // nothing on the spawn list is big enough: find clear ground out in the plaza instead
    for (let i = 0; i < 200; i++) {
      const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 18;
      const c = new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -44, 44), 0, clamp(pp.z + Math.sin(a) * r, -44, 44));
      c.y = world.groundBelow(c.x, 30, c.z, 40);
      if (c.y > -1 && c.y < 2 && fits(c)) return c;
    }
    return new THREE.Vector3(0, 0, 44);
  }
  let cands = spots.filter((s) => { const d = s.distanceTo(pp); return d > 14 && d < 48; });
  if (cands.length < 2) cands = spots.filter((s) => s.distanceTo(pp) > 14);
  const hidden = cands.filter((s) => !world.hasLineOfSight(player.eye, new THREE.Vector3(s.x, s.y + 1.2, s.z)));
  return (choose(hidden.length ? hidden : cands.length ? cands : spots)).clone();
}
function updateWaves(dt) {
  if (game.intermission > 0) {
    game.intermission -= dt; hud.setTimer('next wave in ' + Math.ceil(game.intermission));
    if (game.intermission <= 0) { hud.setTimer(''); startWave(game.wave + 1); }
    return;
  }
  if (game.queue.length && enemies.alive < game.maxAlive) {
    game.spawnT -= dt;
    if (game.spawnT <= 0) { game.spawnT = Math.max(0.7, 2.9 - game.wave * 0.13); const t = game.queue.shift(); enemies.spawn(t, pickSpawn(t)); }
  }
  if (!game.queue.length && enemies.alive === 0) {
    game.intermission = 8; hud.message('WAVE ' + game.wave + ' CLEARED', 'catch your breath · +' + 200 * game.wave, 2.5);
    game.addScore(200 * game.wave, null); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40);
  }
  hud.setWave(game.wave, enemies.alive + game.queue.length);
}

// ---------------- focus slash ----------------
// Two katana kills in a row open a slow-motion window: look at anyone nearby and click to dash
// through them. Each execution re-opens the window, so a good read chains into a whole room.
const FOCUS_TIME = 2.6, FOCUS_SCALE = 0.26, FOCUS_RANGE = 24, FOCUS_MAX_CHAIN = 2;
const FOCUS_ARM = 0.18, DASH_SPEED = 46, KATANA_CHARGE_KILLS = 4;
const _fv = new THREE.Vector3();
function focusCandidate() {
  let best = null, bestScore = -1;
  for (const e of enemies.enemies) {
    if (!e.alive || e.state === 'spawn') continue;
    _fv.subVectors(e.center, player.eye); const d = _fv.length();
    if (d > FOCUS_RANGE || d < 0.5) continue;
    const aim = _fv.divideScalar(d).dot(player.forward);
    if (aim < 0.4) continue;
    if (!world.hasLineOfSight(player.eye, e.center)) continue;
    const score = aim * 3 - d / FOCUS_RANGE;   // prefer whoever is closest to the crosshair
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
function enterFocus() {
  if (game.focus.chain >= FOCUS_MAX_CHAIN) return;
  if (!focusCandidate()) return;
  const fresh = !game.focus.active;
  game.focus.active = true; game.focus.t = FOCUS_TIME; game.focus.chain++;
  // arm after a beat, and only once the trigger combo has been released, so simply holding
  // the triggers through a kill never fires a dash you did not ask for
  game.focus.arm = FOCUS_ARM; game.focus.ready = false;
  if (fresh) { audio.focusIn(); hud.tip(input.usingGamepad ? '<b>SLASH READY</b> · hold L2 + R2 to dash' : '<b>SLASH READY</b> · hold both mouse buttons to dash', 2.2); }
}
function endFocus() {
  if (!game.focus.active && !game.focus.dash) return;
  game.focus.active = false; game.focus.target = null; game.focus.chain = 0; game.focus.dash = null; game.katanaStreak = 0;
  player.dashLock = false; hud.setFocusMark(null);
}
// Sprint the body to the target rather than snapping to it, so the dash reads as the player
// sprinting across the room. Movement runs on real time while the world stays in slow motion.
function startFocusDash(target) {
  game.focus.dash = { target, t: 0, trail: player.center.clone(), lastTrail: 0 };
  player.dashLock = true; player.body.vel.set(0, 0, 0);
  audio.dash(); player.kickFov(5); input.rumble(0.5, 0.4, 120);
  hud.setFocusMark(null);
}
function marchBody(b, nx, nz, dist) {
  let moved = 0;
  for (let step = Math.min(0.22, dist); moved + 1e-4 < dist; ) {
    const s2 = Math.min(step, dist - moved);
    b.pos.x += nx * s2; b.pos.z += nz * s2;
    if (world.overlapsBody(b)) {
      b.pos.y += 0.65;                                  // try to ride up a kerb or stair
      if (world.overlapsBody(b)) { b.pos.y -= 0.65; b.pos.x -= nx * s2; b.pos.z -= nz * s2; return moved; }
    }
    moved += s2;
  }
  return moved;
}
function updateFocusDash(dt) {
  const d = game.focus.dash; if (!d) return true;
  const target = d.target; d.t += dt;
  if (!target.alive || d.t > 1.2) { endDash(false); return true; }
  const b = player.body;
  const dx = target.body.pos.x - b.pos.x, dz = target.body.pos.z - b.pos.z;
  const flat = Math.hypot(dx, dz);
  const nx = dx / (flat || 1), nz = dz / (flat || 1);
  // keep looking at them as we close
  player.yaw = Math.atan2(-dx, -dz);
  _fv.subVectors(target.center, player.eye);
  player.pitch = clamp(Math.atan2(_fv.y, Math.hypot(_fv.x, _fv.z)), -1.2, 1.2);
  const want = Math.max(0, flat - 1.1);
  const moved = marchBody(b, nx, nz, Math.min(DASH_SPEED * dt, want));
  // you fly during the dash, so an enemy on a roof or in the air is reachable
  const aimY = target.body.pos.y + (target.T.flying ? 0.2 : 0);
  const dy = aimY - b.pos.y;
  if (Math.abs(dy) > 0.05) {
    const y = b.pos.y; b.pos.y += clamp(dy, -DASH_SPEED * dt, DASH_SPEED * dt);
    if (world.overlapsBody(b)) { b.pos.y = y; d.stuckY = (d.stuckY || 0) + dt; } else d.stuckY = 0;
  }
  // ink streaking off the player as they go
  d.lastTrail += dt;
  if (d.lastTrail > 0.02) { d.lastTrail = 0; effects.tracer(d.trail, player.center, INK.BLUE, 0.045, 0.28); d.trail.copy(player.center); effects.strokeBurst(player.center, INK.BLUE, 2, 5, { life: 0.22, size: 0.03 }); }
  const reach = Math.hypot(flat, Math.max(0, Math.abs(dy) - 0.6));
  if (reach <= 1.5) { focusExecute(target); return true; }
  // walled off: the dash just ends where it stopped. No free kill through the wall.
  if (moved < 1e-4 && want > 0.05 && (d.stuckY || 0) > 0.08) { endDash(true); return true; }
  return false;
}
// End a dash that never arrived. The swing still happens, it just does not connect.
function endDash(blocked) {
  player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0);
  if (blocked) {
    player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
    audio.katanaSwing(); hud.tip('blocked · the dash did not reach', 1.2);
  }
}
function focusExecute(target) {
  player.dashLock = false; game.focus.dash = null;
  player.body.vel.set(0, 0, 0);
  player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
  _fv.subVectors(target.center, player.eye);
  const dir = _fv.clone().normalize();
  const chainBefore = game.focus.chain;
  enemies.damage(target, 100000, { point: target.center.clone(), dir, part: 'head', source: 'focus', crit: true });
  audio.focusSlash(); game.hitstop(0.1, 0.08); effects.shakeAmt += 0.35; input.rumble(0.9, 0.7, 140);
  player.kickFov(6); player.hp = Math.min(player.maxHp, player.hp + 6);
  // the kill re-arms the window if anyone is left; otherwise let it run out quickly
  if (game.focus.chain === chainBefore) game.focus.t = Math.min(game.focus.t, 0.35);
  game.focus.target = null; hud.setFocusMark(null);
}
function updateFocus(dt) {
  const f = game.focus; if (!f.active) return;
  if (f.dash) { updateFocusDash(dt); return; }
  f.t -= dt; f.arm -= dt;
  if (f.t <= 0 || !player.alive) { endFocus(); return; }
  // dash input: both triggers together, or R1 / the dedicated key
  const combo = (input.down('aim') && input.down('fire')) || input.down('focusdash');
  if (!combo) f.ready = true;
  const target = focusCandidate(); f.target = target;
  if (!target) { hud.setFocusMark(null); return; }
  _fv.copy(target.center).project(R.camera);
  if (_fv.z < 1) hud.setFocusMark((_fv.x * 0.5 + 0.5) * window.innerWidth, (-_fv.y * 0.5 + 0.5) * window.innerHeight);
  else hud.setFocusMark(null);
  if (combo && f.ready && f.arm <= 0) { input.consume('fire'); startFocusDash(target); }
}

// ---------------- screens / state ----------------
function showStart() {
  hud.setGameplayVisible(false);
  hud.showScreen(`<h1>DOODLE DISTRICT</h1><h2>a scribbled survival shooter</h2>${CONTROLS_HTML}<div class="tip">grapple anything (tap to swing, hold to reel, tap again to let go, jump to launch) · hook enemies to yank them · katana block returns bullets · slide, wall-jump, mantle</div>${mapHTML()}${settingsHTML()}${devJumpHTML('START HERE')}<div class="go">CLICK ANYWHERE (or press ✕) TO START DRAWING</div>${best ? `<div class="beststat">best score: ${best}</div>` : ''}`);
  wireSettings(); wireMap(); wireDevJump((n) => beginAtWave(n));
}
function mapHTML() {
  return `<div class="mapsel" id="mapsel"><span>map</span>` +
    LEVELS.map((m) => `<button type="button" class="mapbtn${m.key === mapKey ? ' on' : ''}" data-map="${m.key}">${m.name}<i>${m.blurb}</i></button>`).join('') + `</div>`;
}
function wireMap() {
  const box = hud.el.panel.querySelector('#mapsel'); if (!box) return;
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('.mapbtn'); if (!b) return;
    loadMap(b.dataset.map); resetGame();
    for (const el of box.querySelectorAll('.mapbtn')) el.classList.toggle('on', el.dataset.map === mapKey);
  });
}
function settingsHTML() {
  return `<div class="settings" id="settings">
    <label>look sensitivity <input type="range" id="setSens" min="25" max="250" step="5" value="${settings.sens}"><b id="setSensV">${settings.sens}%</b></label>
    <label><input type="checkbox" id="setInv" ${settings.invert ? 'checked' : ''}> invert vertical look</label>
    <label><input type="checkbox" id="setMus" ${musicWanted ? 'checked' : ''}> music <span class="k">(M)</span></label>
  </div>`;
}
// Dev tool: jump straight to any wave. `label` is what the button says; on the pause screen it
// jumps the run in progress forward, on the start screen it begins a fresh run at that wave.
function devJumpHTML(label) {
  return `<div class="devjump" id="devjump">
    <label>dev: start at wave <input type="number" id="devWave" min="1" max="99" value="${devWave}"></label>
    <button type="button" id="devGo">${label}</button>
  </div>`;
}
function wireDevJump(onGo) {
  const box = hud.el.panel.querySelector('#devjump'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('keydown', (e) => e.stopPropagation());
  const inp = box.querySelector('#devWave');
  const go = () => { devWave = clamp(Math.round(Number(inp.value) || 1), 1, 99); localStorage.setItem('doodle_devwave', String(devWave)); onGo(devWave); };
  box.querySelector('#devGo').addEventListener('click', go);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
function wireSettings() {
  const box = hud.el.panel.querySelector('#settings'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation());
  const sens = box.querySelector('#setSens'), out = box.querySelector('#setSensV');
  sens.addEventListener('input', () => { settings.sens = Number(sens.value); out.textContent = settings.sens + '%'; applySettings(); });
  box.querySelector('#setInv').addEventListener('change', (e) => { settings.invert = e.target.checked; applySettings(); });
  box.querySelector('#setMus').addEventListener('change', (e) => { musicWanted = e.target.checked; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); });
}
function showPause() {
  hud.showScreen(`<h1>PAUSED</h1><h2>wave ${game.wave} · score ${game.score}</h2>${CONTROLS_HTML}${mapHTML()}${settingsHTML()}${devJumpHTML('JUMP')}<div class="go">CLICK ANYWHERE (or press ✕) TO RESUME</div>`);
  wireSettings(); wireMap(); wireDevJump((n) => jumpToWave(n));
}
function showDead() {
  hud.setGameplayVisible(false); const nb = game.score > best; if (nb) { best = game.score; localStorage.setItem('doodle_best', String(best)); }
  hud.showScreen(`<h1>ERASED</h1><div class="stats">you survived <b>${game.wave}</b> wave${game.wave === 1 ? '' : 's'} · <b>${game.kills}</b> kills · score <b>${game.score}</b>${nb ? ' · <b>NEW BEST</b>' : ` · best ${best}`}</div><div class="go">CLICK (or press ✕) TO DRAW AGAIN</div>`);
}
function resetGame() {
  enemies.clear(); effects.clear(); for (const p of pickups) R.scene.remove(p.mesh); pickups.length = 0;
  player.reset(level.playerStart); enemies.mods.speed = 1; enemies.mods.damage = 1; hud.setModifier(''); hud.setBoss(null, null); game.boss = null;
  endFocus(); game.katanaStreak = 0;
  game.score = 0; game.kills = 0; game.combo = 0; game.wave = 0; game.intermission = 0; game.queue = []; game.time = 0; hud.setScore(0, 0); hud.setTimer('');
}
function begin() {
  audio.init(); audio.resume(); if (!input.usingGamepad) input.requestLock();
  if (musicWanted && !audio.musicPlaying) audio.musicOn(true);
  hud.hideScreen(); hud.setGameplayVisible(true);
  if (game.state === 'start' || game.state === 'dead') { resetGame(); startWave(1); }
  game.state = 'play';
}
// Dev tool: begin a brand-new run but skip straight to wave n.
function beginAtWave(n) {
  audio.init(); audio.resume(); if (!input.usingGamepad) input.requestLock();
  if (musicWanted && !audio.musicPlaying) audio.musicOn(true);
  hud.hideScreen(); hud.setGameplayVisible(true);
  resetGame(); startWave(n); game.state = 'play';
}
// Dev tool: cut the run in progress to wave n, keeping score/kills/health as they are.
function jumpToWave(n) {
  enemies.clear(); effects.clear(); enemies.mods.speed = 1; enemies.mods.damage = 1;
  endFocus(); game.intermission = 0; game.queue = []; startWave(n);
  hud.hideScreen(); hud.setGameplayVisible(true); game.state = 'play'; audio.reelLoop(false);
}
function pause() { if (game.state !== 'play') return; game.state = 'pause'; showPause(); audio.reelLoop(false); }
Object.assign(window.__game, { startWave, updateWaves, begin, beginAtWave, jumpToWave, resetGame, spawnPickup, focusCandidate, enterFocus, FOCUS_RANGE, pickSpawn });
hud.onScreenClick = () => { if (['start', 'pause', 'dead'].includes(game.state)) begin(); };
canvas.addEventListener('click', () => { if (game.state === 'play' && !input.pointerLocked && !input.usingGamepad) input.requestLock(); });
input.onLockChange = (locked) => { if (!locked && game.state === 'play' && !input.usingGamepad) pause(); };
applySettings();
hud.setWeapon(player.weapon.name, player.weapon.hint);
showStart();

// ---------------- loop ----------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  input.update(dt);
  const st = game.state;
  const playing = st === 'play' || st === 'dying';
  if (st === 'start' || st === 'pause' || st === 'dead') { if (input.pressed('jump') || input.pressed('confirm')) begin(); }
  else if (st === 'play' && input.pressed('pause')) { pause(); input.exitLock(); }
  if (input.pressed('music')) { musicWanted = !musicWanted; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); hud.tip(musicWanted ? 'music on' : 'music off', 1.5); }
  let scale = 1;
  if (game.hitstopT > 0) { game.hitstopT -= dt; scale = game.hitstopScale; }
  else if (game.focus.active) scale = FOCUS_SCALE;
  const sdt = dt * scale;
  if (st === 'play') updateFocus(dt); else endFocus();
  if (st === 'play' || st === 'dying') {
    game.time += sdt;
    player.update(sdt); enemies.update(sdt); effects.update(sdt); updatePickups(sdt);
    if (st === 'play') updateWaves(sdt);
    if (game.boss) { if (game.boss.alive) hud.setBoss(game.boss.T.name, game.boss.hp / game.boss.maxHp); else { hud.setBoss(null, null); game.boss = null; } }
    if (game.comboT > 0) { game.comboT -= sdt; if (game.comboT <= 0) { game.combo = 0; hud.setScore(game.score, 0); } }
    if (st === 'dying') { game.deathT += dt; if (game.deathT > 1.7) { game.state = 'dead'; showDead(); input.exitLock(); } }
  } else {
    game.time += dt; if (st === 'start' || st === 'dead') player.idleCam(game.time); effects.update(dt);
  }
  for (const a of level.animated) a.update(game.time);
  audio.setListener(player.eye, player.right);
  const w = player.weapon; if (w.isGun) hud.setAmmo(w.mag, w.reserve, w.magSize, w.reloading); else hud.setKatana();
  hud.setSlots(player.weapons.map((wp, i) => ({ name: wp.name, active: i === player.weaponIndex, ammo: wp.isGun ? wp.mag + '/' + wp.reserve : '\u221e', empty: wp.isGun && wp.mag === 0 && wp.reserve === 0 })));
  hud.setHealth(player.hp, player.maxHp); hud.setSpread(w.spreadPx); hud.update(dt);
  const kat = player.weapons[player.katanaIndex];
  hud.setFocusMeter(playing && (w.kind === 'katana' || game.katanaStreak > 0 || game.focus.active),
    game.focus.active ? 1 : clamp(game.katanaStreak / KATANA_CHARGE_KILLS, 0, 1), game.focus.active);
  audio.setIntensity(clamp((enemies.alive + game.queue.length) / 12, 0, 1) * (game.intermission > 0 ? 0.25 : 1));
  R.render(game.time, { hurt: player.hurtFx, flash: player.flashFx, slow: scale < 1 ? 1 : 0, lowHp: player.alive && player.hp < 30 ? 1 - player.hp / 30 : 0 });
}
requestAnimationFrame(frame);
