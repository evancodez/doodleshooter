// Other people in the match. Each is drawn as a doodle figure in a team colour and eased between
// the snapshots its owner sends; it also exposes the same surface enemies and weapons expect of a
// target (body, center, eye, hit spheres, takeDamage) so the rest of the game does not care
// whether it is shooting at a bot or a friend.
import * as THREE from 'three';
import { makeInkMaterial, setFill, INK } from './render.js';
import { buildHumanoid, buildWeaponProp } from './enemies.js';
import { clamp, damp, angleLerp, wrapAngle } from './util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const WEAPON_KINDS = ['rifle', 'shotgun', 'revolver', 'sniper', 'blade'];
const HIT = [['head', 0.3], ['torso', 0.33], ['hips', 0.2], ['armL', 0.11], ['armR', 0.11], ['foreL', 0.1], ['foreR', 0.1], ['legL', 0.13], ['legR', 0.13], ['shinL', 0.11], ['shinR', 0.11]];

// what a player broadcasts about itself, ~15 times a second
export function encodeLocal(P, weaponIndex, extra = {}) {
  const b = P.body;
  return [+b.pos.x.toFixed(2), +b.pos.y.toFixed(2), +b.pos.z.toFixed(2), +P.yaw.toFixed(2), +P.pitch.toFixed(2), weaponIndex,
    (P.crouching ? 1 : 0) | (P.sliding ? 2 : 0) | (P.isBlocking ? 4 : 0) | (P._aiming ? 8 : 0) | (b.onGround ? 16 : 0) | (extra.firing ? 32 : 0) | (P.alive ? 64 : 0),
    Math.round(P.hp)];
}

export class RemotePlayer {
  constructor(ctx, id, name, team, ink) {
    this.ctx = ctx; this.id = id; this.name = name || 'doodle'; this.team = team; this.ink = ink;
    this.isLocal = false; this.alive = true; this.hp = 100; this.maxHp = 100; this.speed = 0; this.weaponIndex = 0;
    this.body = { pos: new THREE.Vector3(0, -50, 0), vel: new THREE.Vector3(), halfW: 0.35, height: 1.75, onGround: true };
    this.center = new THREE.Vector3(); this.eye = new THREE.Vector3(); this.forward = new THREE.Vector3(0, 0, -1); this.right = new THREE.Vector3(1, 0, 0);
    this.yaw = 0; this.pitch = 0; this.crouching = false; this.sliding = false; this.blocking = false; this.aiming = false; this.firing = false;
    this.snapA = null; this.snapB = null; this.phase = 0; this.walk = 0; this.flashT = 0; this.deadT = 0; this.kills = 0; this.deaths = 0; this.score = 0;
    this.mat = makeInkMaterial({ ink, shadeScale: 0, shadeBias: 1 }); this.solid = makeInkMaterial({ ink: INK.BLACK, fill: true, side: THREE.DoubleSide });
    this.T = { weapon: 'rifle', scale: 1.0, hat: 'cap', build: { bodyW: 1, headS: 1, limbR: 0.033 }, blockRadius: 0 };
    const model = buildHumanoid(this.mat, this.solid, this.T);
    this.root = model.root; this.parts = model.parts; this.J = model.J; this.face = model.face; this.hit = HIT; this.hitSpheres = HIT.map(() => new THREE.Vector3());
    this.root.visible = false; ctx.scene.add(this.root);
    // a name tag: a little flag above the head so you know who is who
    this.tagG = new THREE.Group(); this.root.add(this.tagG); this.tagG.position.y = 2.25;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.02), makeInkMaterial({ ink, fill: true, side: THREE.DoubleSide })); this.tagG.add(flag);
  }
  get isBlocking() { return this.blocking; }
  get blockRadius() { return 0; }
  setWeapon(i) {
    if (i === this.weaponIndex && this.J.gun.children.length) return; this.weaponIndex = i;
    const gun = this.J.gun; while (gun.children.length) gun.remove(gun.children[0]);
    buildWeaponProp(gun, this.mat, this.solid, { weapon: WEAPON_KINDS[i] || 'rifle' });
  }
  push(snap, t) {
    if (!snap) return;
    this.snapA = this.snapB || { p: new THREE.Vector3(snap[0], snap[1], snap[2]), yaw: snap[3], pitch: snap[4], t: t - 0.07 };
    this.snapB = { p: new THREE.Vector3(snap[0], snap[1], snap[2]), yaw: snap[3], pitch: snap[4], t };
    this.setWeapon(snap[5]); const f = snap[6];
    this.crouching = !!(f & 1); this.sliding = !!(f & 2); this.blocking = !!(f & 4); this.aiming = !!(f & 8); this.body.onGround = !!(f & 16); this.firing = !!(f & 32);
    const wasAlive = this.alive; this.alive = !!(f & 64); this.hp = snap[7];
    if (wasAlive && !this.alive) this.deadT = 0;
    if (!this.root.visible) { this.body.pos.copy(this.snapB.p); this.root.visible = true; }
  }
  // damage dealt to this player by the host's bots or by another player's shot goes to its owner
  takeDamage(amount, fromPos) { if (this.onDamage) this.onDamage(this, amount, fromPos); }
  knockback() { /* the owner's client applies its own physics */ }
  tryBlockMelee(e) {
    if (!this.alive || !this.blocking) return false;
    _v.subVectors(e.center, this.eye).normalize(); return _v.dot(this.forward) > 0.35;
  }
  tryDeflect() { return false; }
  flash() { this.flashT = 0.08; setFill(this.mat, true); }
  update(dt, now) {
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) setFill(this.mat, false); }
    if (this.snapA && this.snapB) {
      const span = Math.max(0.02, this.snapB.t - this.snapA.t); const k = clamp((now - 0.1 - this.snapA.t) / span, 0, 1.25);
      _v.lerpVectors(this.snapA.p, this.snapB.p, k);
      this.body.vel.subVectors(_v, this.body.pos).divideScalar(Math.max(dt, 1e-3)).clampLength(0, 40); this.body.pos.copy(_v);
      this.yaw = angleLerp(this.snapA.yaw, this.snapB.yaw, k); this.pitch = this.snapA.pitch + (this.snapB.pitch - this.snapA.pitch) * k;
    }
    this.speed = this.body.vel.length();
    this.body.height = this.crouching ? 1.05 : 1.75;
    this.eye.set(this.body.pos.x, this.body.pos.y + (this.crouching ? 0.88 : 1.6), this.body.pos.z);
    this.center.set(this.body.pos.x, this.body.pos.y + this.body.height * 0.55, this.body.pos.z);
    this.forward.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.root.position.copy(this.body.pos); this.root.rotation.y = this.yaw + Math.PI;
    this._animate(dt);
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < HIT.length; i++) this.hitSpheres[i].setFromMatrixPosition(this.parts[HIT[i][0]].matrixWorld);
    if (!this.alive) { this.deadT += dt; }
  }
  _animate(dt) {
    const J = this.J, b = this.body; const sp = Math.hypot(b.vel.x, b.vel.z);
    this.walk = damp(this.walk, clamp(sp / 4, 0, 1), 10, dt); const w = this.walk;
    this.phase += dt * (sp * 2.2 + (sp > 0.4 ? 3 : 0)); const s = Math.sin(this.phase), c = Math.cos(this.phase);
    if (!this.alive) {
      // slumped on the page until they respawn
      J.hips.parent.rotation.x = damp(J.hips.parent.rotation.x, Math.PI / 2, 5, dt); if (this.face) { this.face.eyes.visible = false; this.face.xeyes.visible = true; }
      return;
    }
    J.hips.parent.rotation.x = damp(J.hips.parent.rotation.x, 0, 8, dt); if (this.face) { this.face.eyes.visible = true; this.face.xeyes.visible = false; }
    J.legL.rotation.x = s * 0.9 * w; J.legR.rotation.x = -s * 0.9 * w; J.shinL.rotation.x = Math.max(0, c) * 1.1 * w; J.shinR.rotation.x = Math.max(0, -c) * 1.1 * w;
    if (!b.onGround) { J.legL.rotation.x = -0.5; J.legR.rotation.x = 0.6; J.shinL.rotation.x = 1.0; J.shinR.rotation.x = 0.5; }
    const blade = this.weaponIndex === 4; const aim = blade ? 0 : (this.aiming ? 1 : 0.55);
    if (blade) {
      const g = this.blocking ? 1 : 0;
      J.armR.rotation.x = -0.9 - g * 0.9 - s * 0.6 * w * (1 - g); J.armR.rotation.z = -0.3 - g * 0.5; J.foreR.rotation.x = -1.0 - g * 0.6; J.armL.rotation.x = s * 0.8 * w * (1 - g) - g * 1.4; J.foreL.rotation.x = -0.5;
    } else {
      J.armR.rotation.x = -1.35 * aim - s * 0.6 * w * (1 - aim); J.armR.rotation.z = -0.2 * (1 - aim); J.foreR.rotation.x = -0.25;
      J.armL.rotation.x = -1.2 * aim + s * 0.6 * w * (1 - aim); J.armL.rotation.y = 0.6 * aim; J.foreL.rotation.x = -0.5;
    }
    J.torso.rotation.x = -0.2 * w + (this.sliding ? 0.5 : 0) + (this.crouching ? 0.25 : 0); J.torso.rotation.y = -0.3 * aim;
    J.hips.position.y = (this.crouching ? 0.55 : 0.86) + Math.abs(c) * 0.07 * w;
    J.headG.rotation.x = clamp(-this.pitch, -0.7, 0.7) * 0.7;
    this.tagG.rotation.y = -this.root.rotation.y + (this.ctx.player ? Math.atan2(this.ctx.player.eye.x - this.body.pos.x, this.ctx.player.eye.z - this.body.pos.z) : 0);
  }
  dispose() { this.ctx.scene.remove(this.root); }
}
