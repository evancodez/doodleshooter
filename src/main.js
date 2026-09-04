// Game bootstrap: modes (solo, co-op, team deathmatch, free for all), lobbies, waves, checkpoints,
// scoring, screens and the main loop. Online play is peer-to-peer: the host's browser runs the
// bots and the waves, every player runs their own body, and each tells the others what it did.
import * as THREE from 'three';
import { InkRenderer, INK, makeInkMaterial } from './render.js';
import { World } from './physics.js';
import { Input } from './input.js';
import { buildLevel, LEVELS } from './level.js';
import { NavGrid } from './nav.js';
import { Effects } from './effects.js';
import { EnemyManager, BOSSES } from './enemies.js';
import { Player } from './player.js';
import { RemotePlayer, encodeLocal } from './players.js';
import { Net } from './net.js';
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
const input = new Input(canvas);
const hud = new HUD(document.getElementById('hud'));
const effects = new Effects(R.scene, world);
const ctx = { scene: R.scene, camera: R.camera, world, level, nav, input, hud, effects, audio, renderer: R };
function loadMap(key) {
  if (key === mapKey && level) return;
  mapKey = key; localStorage.setItem('doodle_map', key);
  for (const m of level.meshes) { R.scene.remove(m); if (m.geometry) m.geometry.dispose(); }
  level.animated.length = 0; world.clear();
  level = buildLevel(R.scene, world, key); nav = new NavGrid(world, level.bounds, 1).build();
  ctx.level = level; ctx.nav = nav;
}

// ---------------- persistent bits ----------------
let best = Number(localStorage.getItem('doodle_best') || 0);
let musicWanted = localStorage.getItem('doodle_music') !== '0';
let checkpoint = Number(localStorage.getItem('doodle_checkpoint') || 0);
let myName = (localStorage.getItem('doodle_name') || '').slice(0, 14) || 'doodle' + Math.floor(Math.random() * 90 + 10);
const settings = { sens: Number(localStorage.getItem('doodle_sens') || 100), invert: localStorage.getItem('doodle_invert') === '1' };
function applySettings() {
  input.mouseSens = 0.0022 * settings.sens / 100; input.padSensX = 3.4 * settings.sens / 100; input.padSensY = 2.6 * settings.sens / 100; input.invertY = settings.invert;
  localStorage.setItem('doodle_sens', String(settings.sens)); localStorage.setItem('doodle_invert', settings.invert ? '1' : '0');
}
let devWave = Math.max(1, Math.round(Number(localStorage.getItem('doodle_devwave') || 1)));

// ---------------- modes ----------------
const MODES = {
  solo: { name: 'SOLO', blurb: 'survive the waves alone', online: false, pvp: false, focus: 'slowmo' },
  coop: { name: 'CO-OP', blurb: 'survive the waves together', online: true, pvp: false, focus: 'dash' },
  tdm: { name: 'TEAM DEATHMATCH', blurb: 'two teams, first to 30', online: true, pvp: true, focus: 'off', target: 30, teams: true },
  ffa: { name: 'FREE FOR ALL', blurb: 'everyone, first to 20', online: true, pvp: true, focus: 'off', target: 20, teams: false },
};
const game = ctx.game = {
  state: 'start', mode: 'solo', time: 0, hitstopT: 0, hitstopScale: 1, wave: 0, score: 0, combo: 0, comboT: 0, kills: 0, intermission: 0, queue: [], spawnT: 0, maxAlive: 6, deathT: 0,
  focus: { active: false, t: 0, chain: 0, target: null, dash: null, arm: 0, ready: false }, katanaStreak: 0, boss: null, respawnT: 0, matchT: 0, over: null,
  hitstop(d, s) { this.hitstopT = Math.max(this.hitstopT, d); this.hitstopScale = s; },
  addScore(pts, label) { const mult = 1 + Math.min(this.combo, 9) * 0.25; const p = Math.round(pts * mult); this.score += p; if (label) hud.kill(label, p); hud.setScore(this.score, this.combo); },
  onPlayerDeath() { endFocus(); onLocalDeath(); },
};
const rules = () => MODES[game.mode];
const enemies = ctx.enemies = new EnemyManager(ctx);
const player = ctx.player = new Player(ctx);
player.name = myName;
const net = new Net();
const remote = new Map();          // peer id -> RemotePlayer
const lobby = { players: new Map(), mode: 'coop', map: mapKey, isPublic: false, startWave: 1, status: '' };
const scores = new Map();          // peer id -> { name, team, kills, deaths, score }
window.__game = { ctx, game, player, enemies, nav, world, level, hud, effects, input, net, remote };

// everything enemies and weapons may aim at
ctx.targets = () => [player, ...remote.values()];
ctx.canHurt = (t) => rules().pvp && (!rules().teams || t.team !== player.team);
ctx.raycastPlayers = (o, d, maxDist) => {
  let best = null;
  for (const t of remote.values()) {
    if (!t.alive || !ctx.canHurt(t)) continue;
    for (let i = 0; i < t.hit.length; i++) {
      const c = t.hitSpheres[i], r = t.hit[i][1];
      _v.subVectors(c, o); const tca = _v.dot(d); if (tca < 0 || tca > maxDist) continue;
      const d2 = _v.lengthSq() - tca * tca; if (d2 > r * r) continue;
      const tt = tca - Math.sqrt(r * r - d2); if (tt < 0) continue;
      if (!best || tt < best.dist) best = { player: t, part: t.hit[i][0], dist: tt, point: new THREE.Vector3(o.x + d.x * tt, o.y + d.y * tt, o.z + d.z * tt) };
    }
  }
  return best;
};
ctx.playersInArc = (pos, dir, range, cosHalf) => { const out = []; for (const t of remote.values()) { if (!t.alive || !ctx.canHurt(t)) continue; _v.subVectors(t.center, pos); const d = _v.length(); if (d > range + 0.3) continue; if (d > 0.3 && _v.normalize().dot(dir) < cosHalf) continue; out.push(t); } return out; };
ctx.hitPlayer = (t, dmg, info) => {
  effects.blood(info.point, info.dir, clamp(0.4 + dmg / 80, 0.4, 1.6), { ink: INK.RED }); hud.hitmarker(false, info.crit); audio.hitEnemy(t.center); t.flash();
  net.sendTo(t.id, 'pdmg', { amount: Math.round(dmg), from: player.center.toArray().map((v) => +v.toFixed(1)), by: net.id, crit: !!info.crit });
};
const _v = new THREE.Vector3();

// ---------------- pickups ----------------
const pickups = []; let pickupId = 1;
const pmat = { ammo: makeInkMaterial({ ink: INK.BLUE }), health: makeInkMaterial({ ink: INK.GREEN }), cap: makeInkMaterial({ ink: INK.BLACK }) };
function makePickup(kind) {
  const g = new THREE.Group();
  if (kind === 'ammo') { g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 10), pmat.ammo)); const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 8), pmat.cap); c.position.y = 0.33; g.add(c); const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), pmat.cap); l.position.set(0, 0, 0.24); g.add(l); }
  else { g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.2), pmat.health), new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.2), pmat.health)); }
  return g;
}
function spawnPickup(kind, pos, id = null) {
  const m = makePickup(kind); m.position.copy(pos); m.position.y += 0.6; R.scene.add(m);
  const p = { id: id ?? pickupId++, kind, mesh: m, base: m.position.y, t: rand(0, 6), life: 45 }; pickups.push(p);
  if (net.isHost) net.send('pickup', { id: p.id, kind, pos: pos.toArray() });
  return p;
}
function removePickup(p) { R.scene.remove(p.mesh); const i = pickups.indexOf(p); if (i >= 0) pickups.splice(i, 1); }
function collectPickup(p) {
  if (p.kind === 'ammo') { player.addAmmoAll(0.4); player.grenades = Math.min(player.maxGrenades, player.grenades + 1); hud.kill('+AMMO · +GRENADE', 0); } else { player.hp = Math.min(player.maxHp, player.hp + 35); hud.kill('+35 HP', 0); }
  audio.pickup(); effects.strokeBurst(p.mesh.position, p.kind === 'ammo' ? INK.BLUE : INK.GREEN, 12, 4, { life: 0.3 });
}
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i]; p.t += dt; p.mesh.position.y = p.base + Math.sin(p.t * 2.5) * 0.12; p.mesh.rotation.y += dt * 1.8;
    if (player.alive && p.mesh.position.distanceTo(player.center) < 1.5) {
      if (net.active && !net.isHost) { net.send('take', { id: p.id }); removePickup(p); collectPickup(p); continue; }
      collectPickup(p); if (net.isHost) net.send('taken', { id: p.id }); removePickup(p); continue;
    }
    if (!net.active || net.isHost) { p.life -= dt; if (p.life <= 0) { removePickup(p); if (net.isHost) net.send('taken', { id: p.id }); } }
  }
}

// ---------------- waves (host or solo) ----------------
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
const tips = () => [
  `hold <b>${hud.key('grapple')}</b> to reel in · tap it again to let go mid-swing`,
  `block with <b>${hud.key('block')}</b> and some of their bullets go back at them`,
  'kills in the air are worth more · stay off the floor',
  `<b>${hud.key('grenade')}</b> lobs a grenade · pickups give you more`,
  `press <b>${hud.key('jump')}</b> again in the air for a double jump`,
];
const bossFor = (n) => BOSSES[(Math.floor(n / 5) - 1) % BOSSES.length];
const playerCount = () => 1 + remote.size;
function startWave(n) {
  game.wave = n; game.queue = []; game.spawnT = 2; game.intermission = 0; game.boss = null; hud.setBoss(null, null);
  const boss = n > 0 && n % 5 === 0;
  const allowed = boss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length; const mod = MODIFIERS[Math.floor(Math.random() * allowed)];
  mod.apply(); hud.setModifier(mod.name); game.modName = mod.name;
  const swarm = mod.name.startsWith('SWARM'); const pc = playerCount(); const scale = 1 + (pc - 1) * 0.55;
  game.maxAlive = Math.min(Math.round((3 + Math.floor(n * 0.8) + (swarm ? 3 : 0)) * scale), swarm ? 20 : 16);
  let count = Math.round(Math.min(4 + n * 1.7, 28) * (swarm ? 1.35 : 1) * scale);
  if (boss) { count = Math.round(Math.min(6 + n, 14) * scale); game.queue.push(bossFor(n)); }
  const pool = ROSTER.filter((r) => n >= r.from).map((r) => ({ t: r.t, w: r.w * Math.min(1, 0.3 + 0.25 * (n - r.from)) }));
  const total = pool.reduce((a, r) => a + r.w, 0);
  for (let i = 0; i < count; i++) { let r = Math.random() * total, t = pool[0].t; for (const c of pool) { r -= c.w; if (r <= 0) { t = c.t; break; } } game.queue.push(t); }
  announceWave(n, boss, mod.name); audio.wave();
  if (n <= tips().length) hud.tip(tips()[n - 1], 7);
  player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
  for (let i = 0; i < 7; i++) spawnPickup(i < 5 ? 'ammo' : 'health', choose(level.pickups));
  if (n >= 5 && n % 5 === 0 && n > checkpoint && !net.active) { checkpoint = n; localStorage.setItem('doodle_checkpoint', String(n)); hud.kill('CHECKPOINT · WAVE ' + n, 0); }
  if (net.isHost) net.send('wave', waveState());
}
function announceWave(n, boss, modName) {
  if (boss) { const nm = enemyName(bossFor(n)); hud.message('WAVE ' + n, nm + ' IS COMING', 3); audio.bossRoar(player.center); }
  else hud.message('WAVE ' + n, n === 1 ? 'they are crawling off the page' : modName || choose(['ink harder', 'keep scribbling', 'stay off the ground', 'swing for it', 'return their bullets']), 2.6);
}
const enemyName = (t) => ({ boss: 'THE DOODLER', eraser: 'THE ERASER', inkblot: 'THE INKBLOT' })[t] || t.toUpperCase();
function pickSpawn(type) {
  const spots = type === 'sniper' ? level.snipers : level.spawns; const pp = player.body.pos;
  if (type === 'flyer') { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 10; return new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, level.bounds.minX + 4, level.bounds.maxX - 4), pp.y + 12 + Math.random() * 6, clamp(pp.z + Math.sin(a) * r, level.bounds.minZ + 4, level.bounds.maxZ - 4)); }
  if (BOSSES.includes(type)) {
    const fits = (sp) => !world.overlapsAABB({ x: sp.x - 1.1, y: sp.y + 0.1, z: sp.z - 1.1 }, { x: sp.x + 1.1, y: sp.y + 5.2, z: sp.z + 1.1 });
    const open = spots.filter((sp) => fits(sp)); const far = open.filter((sp) => sp.distanceTo(pp) > 20);
    if (far.length) return choose(far).clone(); if (open.length) return choose(open).clone();
    for (let i = 0; i < 200; i++) { const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 18; const c = new THREE.Vector3(clamp(pp.x + Math.cos(a) * r, -44, 44), 0, clamp(pp.z + Math.sin(a) * r, -44, 44)); c.y = world.groundBelow(c.x, 30, c.z, 40); if (c.y > -3 && fits(c)) return c; }
    return level.playerStart.clone();
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
    if (game.spawnT <= 0) {
      game.spawnT = Math.max(0.7, 2.9 - game.wave * 0.13); const t = game.queue.shift(); const e = enemies.spawn(t, pickSpawn(t));
      if (e.T.boss) { const mul = 1 + 0.35 * Math.floor((game.wave - 5) / 15) + (playerCount() - 1) * 0.5; e.hp = e.maxHp = Math.round(e.T.hp * mul); }
    }
  }
  if (!game.queue.length && enemies.alive === 0) {
    game.intermission = 8; hud.message('WAVE ' + game.wave + ' CLEARED', 'catch your breath · +' + 200 * game.wave, 2.5);
    game.addScore(200 * game.wave, null); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40);
    if (net.isHost) net.send('waveclear', { n: game.wave });
  }
  hud.setWave(game.wave, enemies.alive + game.queue.length);
}
const waveState = () => ({ n: game.wave, left: enemies.alive + game.queue.length, inter: +game.intermission.toFixed(1), mod: game.modName || '', boss: game.boss && game.boss.alive ? { name: game.boss.T.name, f: game.boss.hp / game.boss.maxHp } : null });

// ---------------- kills, scoring ----------------
enemies.onKill = (e, info, over) => {
  const mine = !info.by || info.by === net.id;
  if (mine) {
    game.kills++; game.combo++; game.comboT = 3.5;
    let label = e.T.name, pts = e.T.score;
    if (info.crit) { label = 'HEADSHOT'; pts += 60; }
    if (info.source === 'katana') { label = over ? 'SLICED' : 'CUT DOWN'; pts += 50; }
    if (info.source === 'focus') { label = 'EXECUTED'; pts += 150; }
    if (info.source === 'katana' || info.source === 'focus') { game.katanaStreak++; player.weapons[player.katanaIndex].addBlood(0.42); if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus(); }
    else if (info.source !== 'blast') game.katanaStreak = 0;
    if (info.source === 'deflect') { label = 'RETURN TO SENDER'; pts += 120; }
    if (info.source === 'fall') label = 'FELL OFF THE PAGE';
    else if (!player.body.onGround && info.source !== 'deflect') { label += ' · AIRBORNE'; pts += 40; }
    game.addScore(pts, label);
  }
  if (net.isHost) {
    const by = info.by || net.id; const sc = scores.get(by); if (sc) { sc.kills++; sc.score += e.T.score; }
    net.send('ekill', { id: e.id, by, info: { source: info.source, crit: !!info.crit, part: info.part, dir: info.dir ? info.dir.toArray() : null, point: info.point ? info.point.toArray() : null, score: e.T.score, name: e.T.name } });
    sendScores();
  }
  const r = Math.random(); if (r < 0.5) spawnPickup('ammo', e.body.pos); else if (r < 0.62) spawnPickup('health', e.body.pos);
};
enemies.onBoss = (e) => { if (!e.alive) { hud.setBoss(null, null); game.boss = null; } else { game.boss = e; hud.setBoss(e.T.name, e.hp / e.maxHp); } };
enemies.onSpawn = (e) => { if (net.isHost) net.send('esp', { id: e.id, t: e.type, p: e.body.pos.toArray().map((v) => +v.toFixed(2)), hp: e.maxHp }); };
enemies.projectiles.onFire = (p) => { if (net.isHost) net.send('pfire', { id: p.id, p: p.pos.toArray().map((v) => +v.toFixed(2)), v: p.vel.toArray().map((v) => +v.toFixed(2)), dmg: p.dmg, ink: p.ink, th: p.thick, bl: p.blast, o: p.owner ? p.owner.id : 0 }); };
enemies.onClientHit = (e, amount, info) => net.send('ehit', { id: e.id, amount: Math.round(amount), info: { part: info.part, crit: !!info.crit, source: info.source, dir: info.dir ? info.dir.toArray().map((v) => +v.toFixed(2)) : null, point: info.point ? info.point.toArray().map((v) => +v.toFixed(2)) : null } });
player.onThrow = (d) => { if (net.active) net.broadcast('nade', d); };

// ---------------- focus slash ----------------
const FOCUS_TIME = 2.6, FOCUS_SCALE = 0.26, FOCUS_RANGE = 24, FOCUS_MAX_CHAIN = 2, FOCUS_ARM = 0.18, DASH_SPEED = 46, KATANA_CHARGE_KILLS = 3;
const _fv = new THREE.Vector3();
function focusCandidate() {
  let best = null, bestScore = -1;
  for (const e of enemies.enemies) {
    if (!e.alive || e.state === 'spawn') continue;
    _fv.subVectors(e.center, player.eye); const d = _fv.length(); if (d > FOCUS_RANGE || d < 0.5) continue;
    const aim = _fv.divideScalar(d).dot(player.forward); if (aim < 0.4) continue;
    if (!world.hasLineOfSight(player.eye, e.center)) continue;
    const score = aim * 3 - d / FOCUS_RANGE; if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
function enterFocus() {
  if (rules().focus === 'off' || game.focus.chain >= FOCUS_MAX_CHAIN || !focusCandidate()) return;
  const fresh = !game.focus.active;
  game.focus.active = true; game.focus.t = FOCUS_TIME; game.focus.chain++; game.focus.arm = FOCUS_ARM; game.focus.ready = false;
  if (fresh) { audio.focusIn(); hud.tip(`<b>SLASH READY</b> · hold ${hud.key('focus')} to dash`, 2.2); }
}
function endFocus() { if (!game.focus.active && !game.focus.dash) return; game.focus.active = false; game.focus.target = null; game.focus.chain = 0; game.focus.dash = null; game.katanaStreak = 0; player.dashLock = false; hud.setFocusMark(null); }
function startFocusDash(target) { game.focus.dash = { target, t: 0, trail: player.center.clone(), lastTrail: 0 }; player.dashLock = true; player.body.vel.set(0, 0, 0); audio.dash(); player.kickFov(5); input.rumble(0.5, 0.4, 120); hud.setFocusMark(null); }
function marchBody(b, nx, nz, dist) {
  let moved = 0;
  for (let step = Math.min(0.22, dist); moved + 1e-4 < dist;) { const s2 = Math.min(step, dist - moved); b.pos.x += nx * s2; b.pos.z += nz * s2; if (world.overlapsBody(b)) { b.pos.y += 0.65; if (world.overlapsBody(b)) { b.pos.y -= 0.65; b.pos.x -= nx * s2; b.pos.z -= nz * s2; return moved; } } moved += s2; }
  return moved;
}
function updateFocusDash(dt) {
  const d = game.focus.dash; if (!d) return true;
  const target = d.target; d.t += dt;
  if (!target.alive || d.t > 1.2) { endDash(false); return true; }
  const b = player.body; const dx = target.body.pos.x - b.pos.x, dz = target.body.pos.z - b.pos.z; const flat = Math.hypot(dx, dz); const nx = dx / (flat || 1), nz = dz / (flat || 1);
  player.yaw = Math.atan2(-dx, -dz); _fv.subVectors(target.center, player.eye); player.pitch = clamp(Math.atan2(_fv.y, Math.hypot(_fv.x, _fv.z)), -1.2, 1.2);
  const want = Math.max(0, flat - 1.1); const moved = marchBody(b, nx, nz, Math.min(DASH_SPEED * dt, want));
  const aimY = target.body.pos.y + (target.T.flying ? 0.2 : 0); const dy = aimY - b.pos.y;
  if (Math.abs(dy) > 0.05) { const y = b.pos.y; b.pos.y += clamp(dy, -DASH_SPEED * dt, DASH_SPEED * dt); if (world.overlapsBody(b)) { b.pos.y = y; d.stuckY = (d.stuckY || 0) + dt; } else d.stuckY = 0; }
  d.lastTrail += dt; if (d.lastTrail > 0.02) { d.lastTrail = 0; effects.tracer(d.trail, player.center, INK.BLUE, 0.045, 0.28); d.trail.copy(player.center); effects.strokeBurst(player.center, INK.BLUE, 2, 5, { life: 0.22, size: 0.03 }); }
  const reach = Math.hypot(flat, Math.max(0, Math.abs(dy) - 0.6));
  if (reach <= 1.5) { focusExecute(target); return true; }
  if (moved < 1e-4 && want > 0.05 && (d.stuckY || 0) > 0.08) { endDash(true); return true; }
  return false;
}
function endDash(blocked) { player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0); if (blocked) { player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0)); audio.katanaSwing(); hud.tip('blocked · the dash did not reach', 1.2); } }
function focusExecute(target) {
  player.dashLock = false; game.focus.dash = null; player.body.vel.set(0, 0, 0);
  player.weapons[player.katanaIndex].startSlash(player._weaponState(false, false, 0));
  _fv.subVectors(target.center, player.eye); const dir = _fv.clone().normalize(); const chainBefore = game.focus.chain;
  enemies.damage(target, 100000, { point: target.center.clone(), dir, part: 'head', source: 'focus', crit: true });
  audio.focusSlash(); game.hitstop(0.1, 0.08); effects.shakeAmt += 0.35; input.rumble(0.9, 0.7, 140); player.kickFov(6); player.hp = Math.min(player.maxHp, player.hp + 6);
  if (game.focus.chain === chainBefore) game.focus.t = Math.min(game.focus.t, 0.35);
  game.focus.target = null; hud.setFocusMark(null);
}
function updateFocus(dt) {
  const f = game.focus; if (!f.active) return;
  if (f.dash) { updateFocusDash(dt); return; }
  f.t -= dt; f.arm -= dt; if (f.t <= 0 || !player.alive) { endFocus(); return; }
  const combo = (input.down('aim') && input.down('fire')) || input.down('dash'); if (!combo) f.ready = true;
  const target = focusCandidate(); f.target = target;
  if (!target) { hud.setFocusMark(null); return; }
  _fv.copy(target.center).project(R.camera);
  if (_fv.z < 1) hud.setFocusMark((_fv.x * 0.5 + 0.5) * window.innerWidth, (-_fv.y * 0.5 + 0.5) * window.innerHeight); else hud.setFocusMark(null);
  if (combo && f.ready && f.arm <= 0) { input.consume('fire'); startFocusDash(target); }
}

// ---------------- players: spawning, death, respawn ----------------
function spawnPoint(initial = false) {
  const m = rules(); let list = level.spawns;
  if (m.teams && level.teamSpawns) list = level.teamSpawns[player.team] || level.spawns;
  if (!m.online) return level.playerStart.clone();
  const ids = [...lobby.players.keys()]; const idx = Math.max(0, ids.indexOf(net.id));
  if (initial) {
    if (!m.pvp) { const a = idx * 2.4, r = idx ? 1.6 + Math.floor((idx - 1) / 6) * 1.6 : 0; return level.playerStart.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    const mates = ids.filter((id) => !m.teams || (lobby.players.get(id) || {}).team === player.team); return list[mates.indexOf(net.id) % list.length].clone();
  }
  const others = [...remote.values()].filter((r) => r.alive);
  const scored = list.map((s) => ({ s, d: others.reduce((a, r) => Math.min(a, r.body.pos.distanceTo(s)), 999) }));
  scored.sort((a, b) => b.d - a.d);
  return (scored[0] ? choose(scored.slice(0, Math.min(3, scored.length))).s : level.playerStart).clone();
}
function onLocalDeath() {
  if (!rules().online) { game.state = 'dying'; game.deathT = 0; return; }
  const killer = player.lastHitBy || null;
  net.broadcast('pdead', { killer });
  if (net.isHost) tallyDeath(net.id, killer);
  game.respawnT = rules().pvp ? 3.5 : 8; game.state = 'dying'; game.deathT = 0;
  hud.message('ERASED', rules().pvp ? 'redrawn in a moment' : 'your friends can finish the wave', 2.5);
}
function respawnLocal() {
  player.reset(spawnPoint()); player.name = myName; player.lastHitBy = null; game.state = 'play'; hud.setGameplayVisible(true);
  effects.strokeBurst(player.center, INK.BLUE, 24, 6, { life: 0.5, size: 0.03 }); audio.spawn(player.center);
}
function tallyDeath(victim, killer) {
  const v = scores.get(victim); if (v) v.deaths++;
  if (killer && killer !== victim) { const k = scores.get(killer); if (k) { k.kills++; k.score += 100; } }
  sendScores(); checkWin();
}
function sendScores() { const rows = [...scores.entries()].map(([id, s]) => ({ id, ...s })); net.send('score', rows); applyScores(rows); }
function applyScores(rows) {
  for (const r of rows) scores.set(r.id, { name: r.name, team: r.team, kills: r.kills, deaths: r.deaths, score: r.score });
  refreshScoreHud();
}
function teamKills(t) { let n = 0; for (const s of scores.values()) if (s.team === t) n += s.kills; return n; }
function refreshScoreHud() {
  const m = rules(); if (!m.pvp) return;
  if (m.teams) hud.setPvpScore(`YOU <b>${teamKills(player.team)}</b> · THEM <b>${teamKills(1 - player.team)}</b>`);
  else { const me = scores.get(net.id); const lead = Math.max(0, ...[...scores.values()].map((s) => s.kills)); hud.setPvpScore(`KILLS <b>${me ? me.kills : 0}</b> · LEADER <b>${lead}</b>`); }
  hud.setModifier('first to ' + m.target);
}
function checkWin() {
  const m = rules(); if (!net.isHost || !m.pvp || game.over) return;
  let winner = null;
  if (m.teams) { for (const t of [0, 1]) if (teamKills(t) >= m.target) winner = { team: t }; }
  else for (const [id, s] of scores) if (s.kills >= m.target) winner = { id, name: s.name };
  if (winner) { net.send('end', winner); endMatch(winner); }
}
function endMatch(winner) {
  game.over = winner; game.state = 'over'; endFocus(); input.exitLock();
  const m = rules(); const title = m.teams ? (winner.team === player.team ? 'YOUR TEAM WINS' : 'THEIR TEAM WINS') : winner.id === net.id ? 'YOU WIN' : (winner.name || 'someone') + ' WINS';
  hud.setGameplayVisible(false); hud.showScreen(`<h1>${title}</h1>${scoreboardHTML()}<div class="go">${net.isHost ? 'CLICK TO RETURN TO THE LOBBY' : 'waiting for the host…'}</div>`);
}
function scoreboardHTML() {
  const rows = [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills || a[1].deaths - b[1].deaths);
  return `<div class="scoreboard">${rows.map(([id, s]) => `<div class="${id === net.id ? 'me' : ''} t${s.team}"><span>${s.name}</span><span>${s.kills} K · ${s.deaths} D${rules().pvp ? '' : ' · ' + s.score}</span></div>`).join('')}</div>`;
}

// ---------------- networking: lobby + match sync ----------------
const teamInk = (t) => (rules().teams && t !== player.team) || (rules().pvp && !rules().teams) ? INK.RED : INK.GREEN;
function addRemote(id, name, team) {
  if (remote.has(id)) { const r = remote.get(id); r.name = name; r.team = team; return r; }
  const rp = new RemotePlayer(ctx, id, name, team, teamInk(team));
  rp.onDamage = (t, amount, fromPos) => net.sendTo(t.id, 'pdmg', { amount: Math.round(amount), from: fromPos ? fromPos.toArray().map((v) => +v.toFixed(1)) : null, by: 'bot' });
  remote.set(id, rp); return rp;
}
function removeRemote(id) { const r = remote.get(id); if (r) { r.dispose(); remote.delete(id); } lobby.players.delete(id); scores.delete(id); }
function rebalanceTeams() { let i = 0; for (const [id, p] of lobby.players) { p.team = MODES[lobby.mode].teams ? i++ % 2 : 0; if (id === net.id) player.team = p.team; else { const r = remote.get(id); if (r) r.team = p.team; } } }
function lobbyRows() { return [...lobby.players.entries()].map(([id, p]) => ({ id, name: p.name, team: p.team })); }
function broadcastLobby() { net.send('lobby', { players: lobbyRows(), mode: lobby.mode, map: lobby.map, hostId: net.id, startWave: lobby.startWave }); renderLobby(); }
net.onPeerJoin = (id) => { /* wait for hello */ };
net.onPeerLeave = (id) => { removeRemote(id); broadcastLobby(); if (game.state === 'play') hud.kill((lobby.players.get(id) || {}).name || 'someone' + ' left', 0); };
net.onDisconnect = () => { leaveOnline('lost the host'); };
net.on('refused', (d) => { lobby.status = d.reason; leaveOnline(d.reason); });
net.on('hello', (d, from) => {
  if (!net.isHost) return;
  const team = rules().teams || MODES[lobby.mode].teams ? (lobbyRows().filter((p) => p.team === 0).length <= lobbyRows().filter((p) => p.team === 1).length ? 0 : 1) : 0;
  lobby.players.set(from, { name: String(d.name || 'doodle').slice(0, 14), team }); addRemote(from, d.name, team); broadcastLobby();
});
net.on('lobby', (d) => {
  lobby.mode = d.mode; lobby.map = d.map; lobby.startWave = d.startWave || 1; lobby.hostId = d.hostId; lobby.players.clear();
  for (const p of d.players) { lobby.players.set(p.id, { name: p.name, team: p.team }); if (p.id === net.id) player.team = p.team; }
  for (const p of d.players) if (p.id !== net.id) addRemote(p.id, p.name, p.team);
  for (const id of [...remote.keys()]) if (!lobby.players.has(id)) removeRemote(id);
  for (const r of remote.values()) r.ink = teamInk(r.team);
  renderLobby();
});
net.on('team', (d, from) => { if (!net.isHost) return; const p = lobby.players.get(from); if (p) { p.team = d.team ? 1 : 0; const r = remote.get(from); if (r) r.team = p.team; broadcastLobby(); } });
net.on('leave', (d) => { removeRemote(d.id); renderLobby(); });
net.on('start', (d) => { if (net.isHost) return; game.mode = d.mode; loadMap(d.map); startMatch(d.startWave || 1); });
net.on('end', (d) => endMatch(d));
net.on('backtolobby', () => { if (!net.isHost) toLobbyScreen(); });
// state from the host
net.on('esp', (d) => { if (net.isHost) return; const e = enemies.spawn(d.t, new THREE.Vector3().fromArray(d.p), d.id); e.hp = e.maxHp = d.hp; });
net.on('es', (d) => { if (!net.isHost) enemies.applySnapshot(d, performance.now() / 1000); });
net.on('ekill', (d) => {
  if (net.isHost) return;
  const e = enemies.byId.get(d.id); const mine = d.by === net.id;
  if (mine) { game.kills++; game.combo++; game.comboT = 3.5; let label = d.info.name, pts = d.info.score; if (d.info.crit) { label = 'HEADSHOT'; pts += 60; } if (d.info.source === 'katana') { label = 'SLICED'; pts += 50; } if (d.info.source === 'focus') { label = 'EXECUTED'; pts += 150; } if (d.info.source === 'katana' || d.info.source === 'focus') { game.katanaStreak++; player.weapons[player.katanaIndex].addBlood(0.42); if (game.katanaStreak >= KATANA_CHARGE_KILLS) enterFocus(); } else if (d.info.source !== 'blast') game.katanaStreak = 0; game.addScore(pts, label); }
  if (e) enemies.killMirror(d.id, d.info);
});
net.on('ehit', (d, from) => { if (!net.isHost) return; const e = enemies.byId.get(d.id); if (!e) return; enemies.damage(e, d.amount, { part: d.info.part, crit: d.info.crit, source: d.info.source, by: from, dir: d.info.dir ? new THREE.Vector3().fromArray(d.info.dir) : undefined, point: d.info.point ? new THREE.Vector3().fromArray(d.info.point) : undefined }); });
net.on('pfire', (d) => { if (net.isHost) return; const pos = new THREE.Vector3().fromArray(d.p), vel = new THREE.Vector3().fromArray(d.v); const sp = vel.length(); enemies.projectiles.fire(pos, vel.divideScalar(sp || 1), sp, d.dmg, enemies.byId.get(d.o) || null, d.ink, d.th, d.bl, d.id); });
net.on('wave', (d) => { if (net.isHost) return; if (d.n !== game.wave) { game.wave = d.n; announceWave(d.n, d.n % 5 === 0, d.mod); player.grenades = Math.min(player.maxGrenades, player.grenades + 1); } hud.setWave(d.n, d.left); hud.setModifier(d.mod); hud.setTimer(d.inter > 0 ? 'next wave in ' + Math.ceil(d.inter) : ''); hud.setBoss(d.boss ? d.boss.name : null, d.boss ? d.boss.f : null); });
net.on('waveclear', (d) => { if (net.isHost) return; hud.message('WAVE ' + d.n + ' CLEARED', 'catch your breath', 2.5); audio.waveClear(); player.hp = Math.min(player.maxHp, player.hp + 40); });
net.on('pickup', (d) => { if (!net.isHost) spawnPickup(d.kind, new THREE.Vector3().fromArray(d.pos), d.id); });
net.on('taken', (d) => { const p = pickups.find((x) => x.id === d.id); if (p) removePickup(p); });
net.on('take', (d, from) => { if (!net.isHost) return; const p = pickups.find((x) => x.id === d.id); if (p) { removePickup(p); net.send('taken', { id: d.id }); } });
// state from other players
net.on('ps', (d, from) => { const r = remote.get(from); if (r) r.push(d, performance.now() / 1000); });
net.on('pdmg', (d) => {
  if (!player.alive) return; player.lastHitBy = d.by === 'bot' ? null : d.by;
  player.takeDamage(d.amount, d.from ? new THREE.Vector3().fromArray(d.from) : null);
});
net.on('pdead', (d, from) => { const r = remote.get(from); if (r) { effects.blood(r.center, new THREE.Vector3(0, 1, 0), 1.4); audio.enemyDie(r.center); if (d.killer === net.id) { game.addScore(100, rules().pvp ? 'ERASED ' + r.name : r.name + ' down'); } } if (net.isHost) tallyDeath(from, d.killer); });
net.on('nade', (d) => player.throwGrenade(d));
net.on('score', (rows) => { if (!net.isHost) applyScores(rows); });

let syncTick = 0;
function netUpdate(dt) {
  if (!net.active) return; const now = performance.now() / 1000; syncTick++;
  for (const r of remote.values()) r.update(dt, now);
  if (syncTick % 4 === 0) net.send('ps', encodeLocal(player, player.weaponIndex, { firing: player.firing }), true);
  if (net.isHost && syncTick % 4 === 2 && !rules().pvp) net.send('es', enemies.snapshot());
  if (net.isHost && syncTick % 30 === 0 && !rules().pvp) net.send('wave', waveState());
  if (net.isHost && rules().pvp) { game.matchT += dt; if (game.matchT > 600 && !game.over) { const m = rules(); let w; if (m.teams) w = { team: teamKills(0) >= teamKills(1) ? 0 : 1 }; else { let bid = net.id, bk = -1; for (const [id, s] of scores) if (s.kills > bk) { bk = s.kills; bid = id; } w = { id: bid, name: (scores.get(bid) || {}).name }; } net.send('end', w); endMatch(w); } }
}
function leaveOnline(reason) {
  net.leave(); for (const id of [...remote.keys()]) removeRemote(id); lobby.players.clear(); scores.clear();
  if (game.state !== 'start') { game.state = 'start'; resetGame(); }
  lobby.status = reason || ''; showStart();
}

// ---------------- screens ----------------
function modesHTML() { return `<div class="modes">${Object.entries(MODES).map(([k, m]) => `<button type="button" class="modebtn${k === (lobby.mode === 'solo' || !net.active ? game.mode : lobby.mode) ? ' on' : ''}" data-mode="${k}">${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`; }
function mapHTML(disabled) { return `<div class="mapsel" id="mapsel"><span>map</span>${LEVELS.map((m) => `<button type="button" class="mapbtn${m.key === (net.active ? lobby.map : mapKey) ? ' on' : ''}" data-map="${m.key}" ${disabled ? 'disabled' : ''}>${m.name}<i>${m.blurb}</i></button>`).join('')}</div>`; }
function settingsHTML() {
  return `<div class="settings" id="settings">
    <label>name <input type="text" class="namebox" id="setName" maxlength="14" value="${myName.replace(/"/g, '')}"></label>
    <label>look sensitivity <input type="range" id="setSens" min="25" max="250" step="5" value="${settings.sens}"><b id="setSensV">${settings.sens}%</b></label>
    <label><input type="checkbox" id="setInv" ${settings.invert ? 'checked' : ''}> invert vertical look</label>
    <label><input type="checkbox" id="setMus" ${musicWanted ? 'checked' : ''}> music <span class="k">(M)</span></label>
  </div>`;
}
function wireSettings() {
  const box = hud.el.panel.querySelector('#settings'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const sens = box.querySelector('#setSens'), out = box.querySelector('#setSensV');
  sens.addEventListener('input', () => { settings.sens = Number(sens.value); out.textContent = settings.sens + '%'; applySettings(); });
  box.querySelector('#setInv').addEventListener('change', (e) => { settings.invert = e.target.checked; applySettings(); });
  box.querySelector('#setMus').addEventListener('change', (e) => { musicWanted = e.target.checked; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); });
  box.querySelector('#setName').addEventListener('input', (e) => { myName = e.target.value.trim().slice(0, 14) || myName; localStorage.setItem('doodle_name', myName); player.name = myName; });
}
function devJumpHTML(label) { return `<div class="devjump" id="devjump"><label>dev: start at wave <input type="number" id="devWave" min="1" max="99" value="${devWave}"></label><button type="button" id="devGo">${label}</button></div>`; }
function wireDevJump(onGo) {
  const box = hud.el.panel.querySelector('#devjump'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const inp = box.querySelector('#devWave'); const go = () => { devWave = clamp(Math.round(Number(inp.value) || 1), 1, 99); localStorage.setItem('doodle_devwave', String(devWave)); onGo(devWave); };
  box.querySelector('#devGo').addEventListener('click', go); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
function checkpointHTML() {
  if (checkpoint < 5) return '';
  let h = '<div class="checkpoints"><span>checkpoints</span>';
  for (let w = 5; w <= checkpoint; w += 5) h += `<button type="button" data-cp="${w}">WAVE ${w}</button>`;
  return h + '</div>';
}
function wireCheckpoints(onGo) { const box = hud.el.panel.querySelector('.checkpoints'); if (!box) return; box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('button'); if (b) onGo(Number(b.dataset.cp)); }); }
function wireMap() {
  const box = hud.el.panel.querySelector('#mapsel'); if (!box) return;
  box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('.mapbtn'); if (!b || b.disabled) return; if (net.isHost) { lobby.map = b.dataset.map; broadcastLobby(); } else { loadMap(b.dataset.map); resetGame(); showStart(); } });
}
function wireModes() {
  const box = hud.el.panel.querySelector('.modes'); if (!box) return;
  box.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('.modebtn'); if (!b) return; const k = b.dataset.mode; if (net.active) { if (net.isHost) { lobby.mode = k; rebalanceTeams(); broadcastLobby(); } return; } game.mode = k; lobby.mode = k; showStart(); });
}
function lobbyHTML() {
  const m = MODES[net.active ? lobby.mode : game.mode];
  if (!m.online) return checkpointHTML();
  if (!net.active) return `<div class="lobby" id="lobby">
    <div class="row"><button type="button" id="hostBtn">HOST A LOBBY</button><label><input type="checkbox" id="pubBox" ${lobby.isPublic ? 'checked' : ''}> public (anyone can quick play in)</label></div>
    <div class="row"><input type="text" id="codeBox" placeholder="CODE" value="${lobby.code || ''}"><button type="button" id="joinBtn">JOIN</button><button type="button" class="alt" id="quickBtn">QUICK PLAY</button></div>
    <div class="status" id="lobbyStatus">${lobby.status || ''}</div></div>`;
  const rows = lobbyRows(); const mine = rows.find((p) => p.id === net.id);
  return `<div class="lobby" id="lobby">
    <div class="row"><span>lobby code</span><span class="code">${net.code}</span><span style="font-size:17px;opacity:.75">share it, or friends can ${net.code.startsWith('PUB') ? 'quick play in' : 'type it in'}</span></div>
    <div class="plist">${rows.map((p) => `<div class="t${p.team}${p.id === lobby.hostId || (net.isHost && p.id === net.id) ? ' host' : ''}"><span>${p.name}${p.id === net.id ? ' (you)' : ''}</span><span>${m.teams ? (p.team ? 'red' : 'blue') : ''}</span></div>`).join('')}</div>
    <div class="row">${m.teams ? '<button type="button" class="alt" id="teamBtn">SWITCH TEAM</button>' : ''}${net.isHost ? `<label>start at wave <input type="number" id="startWave" min="1" max="99" value="${lobby.startWave}" style="width:60px;font:inherit;font-size:20px;text-align:center"></label><button type="button" id="startBtn" ${m.pvp && rows.length < 2 ? 'disabled' : ''}>START</button>` : '<span class="status">waiting for the host to start…</span>'}<button type="button" class="alt" id="leaveBtn">LEAVE</button></div>
    <div class="status" id="lobbyStatus">${lobby.status || ''}</div></div>`;
}
function wireLobby() {
  const box = hud.el.panel.querySelector('#lobby'); if (!box) return;
  box.addEventListener('click', (e) => e.stopPropagation()); box.addEventListener('keydown', (e) => e.stopPropagation());
  const st = (t) => { lobby.status = t; const el = box.querySelector('#lobbyStatus'); if (el) el.textContent = t; };
  const q = (id) => box.querySelector('#' + id);
  if (q('hostBtn')) q('hostBtn').addEventListener('click', async () => { try { st('opening a lobby…'); lobby.isPublic = q('pubBox').checked; lobby.mode = game.mode; lobby.map = mapKey; await net.host({ isPublic: lobby.isPublic }); lobby.players.clear(); lobby.players.set(net.id, { name: myName, team: 0 }); player.team = 0; lobby.hostId = net.id; lobby.status = ''; game.state = 'lobby'; showStart(); } catch (err) { st(String(err.message || err)); } });
  if (q('joinBtn')) q('joinBtn').addEventListener('click', async () => { try { st('connecting…'); lobby.code = q('codeBox').value; await net.join(lobby.code); net.send('hello', { name: myName }); lobby.status = ''; game.state = 'lobby'; showStart(); } catch (err) { st(String(err.message || err)); } });
  if (q('codeBox')) q('codeBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('joinBtn').click(); });
  if (q('quickBtn')) q('quickBtn').addEventListener('click', async () => { try { await net.quickJoin(st); net.send('hello', { name: myName }); lobby.status = ''; game.state = 'lobby'; showStart(); } catch (err) { st(String(err.message || err)); } });
  if (q('teamBtn')) q('teamBtn').addEventListener('click', () => { const me = lobby.players.get(net.id); const t = me ? 1 - me.team : 1; if (net.isHost) { me.team = t; player.team = t; broadcastLobby(); } else net.send('team', { team: t }); });
  if (q('startWave')) q('startWave').addEventListener('change', (e) => { lobby.startWave = clamp(Math.round(Number(e.target.value) || 1), 1, 99); });
  if (q('startBtn')) q('startBtn').addEventListener('click', () => { if (q('startWave')) lobby.startWave = clamp(Math.round(Number(q('startWave').value) || 1), 1, 99); hostStart(); });
  if (q('leaveBtn')) q('leaveBtn').addEventListener('click', () => leaveOnline(''));
}
function renderLobby() { if (game.state === 'lobby' || game.state === 'start') showStart(); }
function showStart() {
  hud.setGameplayVisible(false);
  const online = MODES[net.active ? lobby.mode : game.mode].online;
  const go = net.active ? '' : online ? '' : `<div class="go">CLICK ANYWHERE (or press ${hud.key('confirm')}) TO START DRAWING</div>`;
  hud.showScreen(`<h1>DOODLE DISTRICT</h1><h2>a scribbled survival shooter</h2>${modesHTML()}${CONTROLS_HTML}${mapHTML(net.active && !net.isHost)}${lobbyHTML()}${settingsHTML()}${online ? '' : devJumpHTML('START HERE')}${go}${best ? `<div class="beststat">best score: ${best}</div>` : ''}`);
  wireSettings(); wireMap(); wireModes(); wireLobby(); wireCheckpoints((w) => beginAtWave(w)); wireDevJump((n) => beginAtWave(n));
}
function showPause() {
  const online = rules().online;
  hud.showScreen(`<h1>${online ? 'MENU' : 'PAUSED'}</h1><h2>${rules().pvp ? MODES[game.mode].name : 'wave ' + game.wave + ' · score ' + game.score}</h2>${online ? scoreboardHTML() : ''}${CONTROLS_HTML}${online ? '' : mapHTML(false)}${settingsHTML()}${online ? '<div class="lobby" id="lobby"><div class="row"><button type="button" class="alt" id="leaveBtn">LEAVE MATCH</button></div></div>' : devJumpHTML('JUMP')}<div class="go">CLICK ANYWHERE (or press ${hud.key('confirm')}) TO ${online ? 'KEEP PLAYING' : 'RESUME'}</div>`);
  wireSettings(); if (!online) { wireMap(); wireDevJump((n) => jumpToWave(n)); } else wireLobby();
}
function showDead() {
  hud.setGameplayVisible(false); const nb = game.score > best; if (nb) { best = game.score; localStorage.setItem('doodle_best', String(best)); }
  hud.showScreen(`<h1>ERASED</h1><div class="stats">you survived <b>${game.wave}</b> wave${game.wave === 1 ? '' : 's'} · <b>${game.kills}</b> kills · score <b>${game.score}</b>${nb ? ' · <b>NEW BEST</b>' : ` · best ${best}`}</div>${checkpointHTML()}<div class="go">CLICK (or press ${hud.key('confirm')}) TO DRAW AGAIN</div>`);
  wireCheckpoints((w) => beginAtWave(w));
}
function toLobbyScreen() { resetGame(); game.state = 'lobby'; game.over = null; hud.setGameplayVisible(false); showStart(); }

// ---------------- run control ----------------
function resetGame() {
  enemies.clear(); effects.clear(); for (const p of pickups) R.scene.remove(p.mesh); pickups.length = 0;
  player.reset(level.playerStart); player.name = myName; enemies.mods.speed = 1; enemies.mods.damage = 1; hud.setModifier(''); hud.setBoss(null, null); game.boss = null; endFocus(); game.katanaStreak = 0;
  game.score = 0; game.kills = 0; game.combo = 0; game.wave = 0; game.intermission = 0; game.queue = []; game.time = 0; game.over = null; game.matchT = 0; hud.setScore(0, 0); hud.setTimer(''); hud.setPvpScore(null); hud.setWave(1, 0);
}
function beginCommon() { audio.init(); audio.resume(); if (!input.usingGamepad) input.requestLock(); if (musicWanted && !audio.musicPlaying) audio.musicOn(true); hud.hideScreen(); hud.setGameplayVisible(true); }
function begin() { beginCommon(); if (game.state === 'start' || game.state === 'dead') { resetGame(); startWave(1); } game.state = 'play'; }
function beginAtWave(n) { if (rules().online) return; beginCommon(); resetGame(); startWave(n); game.state = 'play'; }
function jumpToWave(n) { if (rules().online) return; enemies.clear(); effects.clear(); enemies.mods.speed = 1; enemies.mods.damage = 1; endFocus(); game.intermission = 0; game.queue = []; startWave(n); hud.hideScreen(); hud.setGameplayVisible(true); game.state = 'play'; audio.reelLoop(false); }
function hostStart() {
  game.mode = lobby.mode; loadMap(lobby.map); net.accepting = false;
  net.send('start', { mode: lobby.mode, map: lobby.map, startWave: lobby.startWave }); startMatch(lobby.startWave);
}
function startMatch(startWaveN) {
  const m = rules(); enemies.mirror = !net.isHost; resetGame();
  scores.clear(); for (const [id, p] of lobby.players) scores.set(id, { name: p.name, team: p.team, kills: 0, deaths: 0, score: 0 });
  const me = lobby.players.get(net.id); player.team = me ? me.team : 0;
  for (const r of remote.values()) { r.ink = teamInk(r.team); r.mat.uniforms.uInk.value = r.ink; }
  player.reset(spawnPoint(true)); beginCommon(); game.state = 'play';
  if (m.pvp) { refreshScoreHud(); hud.message(m.name, m.teams ? (player.team ? 'you are RED' : 'you are BLUE') : 'everyone is fair game', 3); }
  else if (net.isHost) startWave(startWaveN);
}
function pause() { if (game.state !== 'play') return; if (!rules().online) game.state = 'pause'; game.menu = true; showPause(); audio.reelLoop(false); }
function resume() { if (rules().online) { game.menu = false; hud.hideScreen(); hud.setGameplayVisible(true); if (!input.usingGamepad) input.requestLock(); return; } begin(); }
Object.assign(window.__game, { startWave, updateWaves, begin, beginAtWave, jumpToWave, resetGame, spawnPickup, focusCandidate, enterFocus, pickSpawn, startMatch, loadMap, MODES });
hud.onScreenClick = () => {
  const st = game.state;
  if (st === 'over') { if (net.isHost) { net.send('backtolobby', {}); toLobbyScreen(); } return; }
  if (st === 'lobby' || (st === 'start' && MODES[game.mode].online)) return;
  if (st === 'play' && game.menu) { resume(); return; }
  if (['start', 'pause', 'dead'].includes(st)) resume();
};
canvas.addEventListener('click', () => { if (game.state === 'play' && !game.menu && !input.pointerLocked && !input.usingGamepad) input.requestLock(); });
input.onLockChange = (locked) => { if (!locked && game.state === 'play' && !game.menu && !input.usingGamepad) pause(); };
input.onDeviceChange = (pad) => { hud.setDevice(pad); hud.setWeapon(player.weapon.name, player.weapon.hint); };
hud.setDevice(input.usingGamepad); applySettings(); hud.setWeapon(player.weapon.name, player.weapon.hint); showStart();

// ---------------- loop ----------------
let last = performance.now(), rafPending = false;
function schedule() { if (!rafPending) { rafPending = true; requestAnimationFrame(frame); } }
// browsers stop animation frames in hidden tabs; a host that alt-tabs would freeze everyone's
// match, so a coarse timer keeps the simulation ticking (slowly) while the page is hidden
setInterval(() => { if (document.hidden && net.active) frame(performance.now()); }, 250);
function frame(now) {
  rafPending = false; schedule();
  const dt = Math.min(document.hidden ? 0.25 : 0.05, (now - last) / 1000); last = now;
  input.update(dt);
  const st = game.state; const playing = st === 'play' || st === 'dying';
  if (st === 'start' || st === 'pause' || st === 'dead') { if (input.pressed('jump') || input.pressed('confirm')) hud.onScreenClick(); }
  else if (st === 'play' && input.pressed('pause')) { if (game.menu) resume(); else { pause(); input.exitLock(); } }
  else if (st === 'over' && (input.pressed('jump') || input.pressed('confirm'))) hud.onScreenClick();
  if (input.pressed('music')) { musicWanted = !musicWanted; localStorage.setItem('doodle_music', musicWanted ? '1' : '0'); audio.musicOn(musicWanted); hud.tip(musicWanted ? 'music on' : 'music off', 1.5); }
  let scale = 1;
  if (game.hitstopT > 0) { game.hitstopT -= dt; scale = game.hitstopScale; }
  else if (game.focus.active && rules().focus === 'slowmo') scale = FOCUS_SCALE;
  const sdt = dt * scale;
  if (st === 'play') updateFocus(dt); else endFocus();
  if (playing) {
    game.time += sdt;
    player.update(sdt); enemies.update(sdt); effects.update(sdt); updatePickups(sdt); netUpdate(dt);
    if (st === 'play' && !rules().pvp && (!net.active || net.isHost)) updateWaves(sdt);
    if (game.comboT > 0) { game.comboT -= sdt; if (game.comboT <= 0) { game.combo = 0; hud.setScore(game.score, 0); } }
    if (st === 'dying') {
      game.deathT += dt;
      if (rules().online) { game.respawnT -= dt; hud.setTimer('back in ' + Math.ceil(game.respawnT)); if (game.respawnT <= 0) { hud.setTimer(''); respawnLocal(); } }
      else if (game.deathT > 1.7) { game.state = 'dead'; showDead(); input.exitLock(); }
    }
  } else { game.time += dt; if (st === 'start' || st === 'dead' || st === 'lobby' || st === 'over') player.idleCam(game.time); effects.update(dt); if (net.active) netUpdate(dt); }
  for (const a of level.animated) a.update(game.time);
  audio.setListener(player.eye, player.right);
  const w = player.weapon; if (w.isGun) hud.setAmmo(w.mag, w.reserve, w.magSize, w.reloading); else hud.setKatana();
  hud.setSlots(player.weapons.map((wp, i) => ({ name: wp.name, active: i === player.weaponIndex, ammo: wp.isGun ? wp.mag + '/' + wp.reserve : '∞', empty: wp.isGun && wp.mag === 0 && wp.reserve === 0 })));
  hud.setGrenades(player.grenades); hud.setHealth(player.hp, player.maxHp); hud.setSpread(w.spreadPx); hud.update(dt);
  const kat = player.weapons[player.katanaIndex];
  hud.setFocusMeter(playing && rules().focus !== 'off' && (w.kind === 'katana' || game.katanaStreak > 0 || game.focus.active), game.focus.active ? 1 : clamp(game.katanaStreak / KATANA_CHARGE_KILLS, 0, 1), game.focus.active);
  if (game.boss) { if (game.boss.alive) hud.setBoss(game.boss.T.name, game.boss.hp / game.boss.maxHp); else { hud.setBoss(null, null); game.boss = null; } }
  audio.setIntensity(clamp((enemies.alive + game.queue.length + remote.size * 2) / 12, 0, 1) * (game.intermission > 0 ? 0.25 : 1));
  R.render(game.time, { hurt: player.hurtFx, flash: player.flashFx, slow: scale < 1 ? 1 : 0, lowHp: player.alive && player.hp < 30 ? 1 - player.hp / 30 : 0 });
}
schedule();
