// Level construction. Two maps share one builder: everything is merged ink geometry plus
// axis-aligned box colliders, which is what the navigation grid is generated from.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeInkMaterial, INK } from './render.js';
import { rand, choose, TAU } from './util.js';

export const LEVELS = [
  { key: 'district', name: 'DOODLE DISTRICT', blurb: 'streets, rooftops and fire escapes' },
  { key: 'desk', name: 'THE DESK', blurb: 'two inches tall on somebody\'s desk' },
];

function createBuilder(scene, world) {
  const geos = {}; const L = { rings: [], spawns: [], snipers: [], pickups: [], animated: [], meshes: [], playerStart: new THREE.Vector3(0, 0, 42), bounds: { minX: -52, maxX: 52, minZ: -52, maxZ: 52 } };
  const addGeo = (g, ink) => (geos[ink] || (geos[ink] = [])).push(g);
  const collider = (x, y, z, w, h, d, o = {}) => world.addBox({ x: x - w / 2, y, z: z - d / 2 }, { x: x + w / 2, y: y + h, z: z + d / 2 }, { noNav: !!o.noNav, noShoot: !!o.noShoot, tag: o.tag });
  function box(x, y, z, w, h, d, o = {}) {
    const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y + h / 2, z); addGeo(g, o.ink ?? INK.BLUE);
    if (!o.noCollide) collider(x, y, z, w, h, d, o);
  }
  const slab = (x1, z1, x2, z2, y, t, o = {}) => box((x1 + x2) / 2, y - t, (z1 + z2) / 2, x2 - x1, t, z2 - z1, o); // top surface at y
  // Wall pieces along an axis with rectangular gaps [a1, a2, yBottom = 0, yTop = h]; gaps may overlap.
  function wallPieces(a1, a2, h, gaps) {
    const xs = new Set([a1, a2]);
    for (const g of gaps) { xs.add(Math.min(Math.max(g[0], a1), a2)); xs.add(Math.min(Math.max(g[1], a1), a2)); }
    const sorted = [...xs].sort((a, b) => a - b); const runs = new Map(); const out = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const s1 = sorted[i], s2 = sorted[i + 1]; if (s2 - s1 < 0.005) continue; const mid = (s1 + s2) / 2;
      const cuts = gaps.filter((g) => g[0] <= mid && g[1] >= mid).map((g) => [g[2] ?? 0, g[3] ?? h]).sort((a, b) => a[0] - b[0]);
      const pieces = []; let y = 0;
      for (const [gb, gt] of cuts) { if (gb > y + 0.005) pieces.push([y, gb]); y = Math.max(y, gt); }
      if (y < h - 0.005) pieces.push([y, h]);
      const keys = new Set();
      for (const [yb, yt] of pieces) { const k = yb.toFixed(3) + ',' + yt.toFixed(3); keys.add(k); const r = runs.get(k); if (r && Math.abs(r[1] - s1) < 0.005) r[1] = s2; else runs.set(k, [s1, s2, yb, yt]); }
      for (const [k, r] of [...runs]) if (!keys.has(k)) { out.push(r); runs.delete(k); }
    }
    for (const r of runs.values()) out.push(r);
    return out;
  }
  function wallX(x1, x2, z, y, h, t, gaps = [], o = {}) {
    for (const [a, b, yb, yt] of wallPieces(x1, x2, h, gaps)) box((a + b) / 2, y + yb, z, b - a, yt - yb, t, o);
  }
  function wallZ(z1, z2, x, y, h, t, gaps = [], o = {}) {
    for (const [a, b, yb, yt] of wallPieces(z1, z2, h, gaps)) box(x, y + yb, (a + b) / 2, t, yt - yb, b - a, o);
  }
  function stairs(x, y, z, dir, steps, width, o = {}) {
    const rise = o.rise ?? 4 / 14, run = o.run ?? 0.45;
    const dx = dir === '+x' ? 1 : dir === '-x' ? -1 : 0, dz = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
    for (let i = 0; i < steps; i++) {
      const c = (i + 0.5) * run, h = (i + 1) * rise; const cx = x + dx * c, cz = z + dz * c;
      box(cx, y, cz, dx ? run + 0.004 : width, h, dz ? run + 0.004 : width, o);
    }
    return { x: x + dx * steps * run, z: z + dz * steps * run, y: y + steps * rise };
  }
  // railing along an axis-aligned segment: visual posts + bar, one collider
  function rail(x1, z1, x2, z2, y, o = {}) {
    const len = Math.hypot(x2 - x1, z2 - z1); const ax = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;
    box(cx, y + 0.9, cz, ax ? len : 0.12, 0.12, ax ? 0.12 : len, { noCollide: true, ink: o.ink });
    const n = Math.max(1, Math.round(len / 2));
    for (let i = 0; i <= n; i++) { const t = i / n; box(x1 + (x2 - x1) * t, y, z1 + (z2 - z1) * t, 0.1, 0.9, 0.1, { noCollide: true, ink: o.ink }); }
    collider(cx, y, cz, ax ? len : 0.12, 1.0, ax ? 0.12 : len, { noNav: true, noShoot: true });
  }
  function cyl(x, y, z, r, h, o = {}) {
    const g = new THREE.CylinderGeometry(r, r, h, o.seg ?? 12); g.translate(x, y + h / 2, z); addGeo(g, o.ink ?? INK.BLUE);
    if (!o.noCollide) collider(x, y, z, r * 1.6, h, r * 1.6, o);
  }
  function sphere(x, y, z, r, o = {}) { const g = new THREE.SphereGeometry(r, o.seg ?? 10, o.seg ?? 8); g.translate(x, y, z); addGeo(g, o.ink ?? INK.BLUE); }
  function ring(x, y, z, axis = 'z') {
    const g = new THREE.TorusGeometry(0.6, 0.1, 8, 20);
    if (axis === 'x') g.rotateY(Math.PI / 2); else if (axis === 'y') g.rotateX(Math.PI / 2);
    g.translate(x, y, z); addGeo(g, INK.ORANGE);
    L.rings.push(new THREE.Vector3(x, y, z));
  }
  const spawn = (x, y, z) => L.spawns.push(new THREE.Vector3(x, y, z));
  const sniper = (x, y, z) => L.snipers.push(new THREE.Vector3(x, y, z));
  const pickup = (x, y, z) => L.pickups.push(new THREE.Vector3(x, y, z));
  // ---------------- shared finish ----------------
  function finish() {
    for (const ink in geos) {
      const merged = mergeGeometries(geos[ink], false);
      const mesh = new THREE.Mesh(merged, makeInkMaterial({ ink: Number(ink) }));
      mesh.matrixAutoUpdate = false; scene.add(mesh); L.meshes.push(mesh);
    }
    world.finalize();
    return L;
  }
  // a paper plane that loops overhead, purely decorative
  function planes(n, baseR, baseH) {
    for (let i = 0; i < n; i++) {
      const g = new THREE.ConeGeometry(1.2, 4, 3); g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, makeInkMaterial({ ink: INK.BLUE })); scene.add(m); L.meshes.push(m);
      const r = baseR + i * 12, h = baseH + i * 6, ph = i * 2.1, sp = 0.12 + i * 0.03;
      L.animated.push({ mesh: m, update: (t) => { const a = t * sp + ph; m.position.set(Math.cos(a) * r, h + Math.sin(a * 2.3) * 3, Math.sin(a) * r * 0.7); m.lookAt(Math.cos(a + 0.05) * r, h + Math.sin((a + 0.05) * 2.3) * 3, Math.sin(a + 0.05) * r * 0.7); m.rotateZ(Math.sin(a * 3) * 0.6); } });
    }
  }
  return { L, addGeo, collider, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, finish, planes };
}

// ============================ map 1: Doodle District ============================
function buildDistrict(B) {
  const { L, box, slab, wallX, wallZ, stairs, rail, cyl, sphere, ring, spawn, sniper, pickup, planes, addGeo, collider } = B;
  // ---------------- ground + perimeter ----------------
  box(0, -1, 0, 130, 1, 130);
  const P = 55, T = 6, PH = 18;
  box(0, 0, -P, 2 * P + T, PH, T); box(0, 0, P, 2 * P + T, PH, T); box(-P, 0, 0, T, PH, 2 * P + T); box(P, 0, 0, T, PH, 2 * P + T);
  // ledges / balconies on the perimeter (grapple + stand)
  for (const [x, z, w, d] of [[-30, -51.2, 8, 1.6], [30, -51.2, 8, 1.6], [-51.2, 40, 1.6, 8], [51.2, -10, 1.6, 8], [-51.2, -30, 1.6, 6], [51.2, 35, 1.6, 6], [10, 51.2, 8, 1.6], [-40, 51.2, 6, 1.6]]) {
    box(x, 9, z, w, 0.4, d); box(x, 5.5, z, w, 0.4, d);
  }
  // spawn doorways in the perimeter (visual frames)
  const doorFrame = (x, z, alongX) => { if (alongX) { box(x - 1.2, 0, z, 0.3, 3.2, 0.5, { noCollide: true, ink: INK.BLACK }); box(x + 1.2, 0, z, 0.3, 3.2, 0.5, { noCollide: true, ink: INK.BLACK }); box(x, 3.0, z, 2.7, 0.3, 0.5, { noCollide: true, ink: INK.BLACK }); } else { box(x, 0, z - 1.2, 0.5, 3.2, 0.3, { noCollide: true, ink: INK.BLACK }); box(x, 0, z + 1.2, 0.5, 3.2, 0.3, { noCollide: true, ink: INK.BLACK }); box(x, 3.0, z, 0.5, 0.3, 2.7, { noCollide: true, ink: INK.BLACK }); } };
  for (const [x, z] of [[-52, 0], [52, 0], [-52, 30], [52, -30], [-52, -30], [52, 30]]) { doorFrame(x, z, false); spawn(x + (x < 0 ? 1.2 : -1.2), 0, z); }
  for (const [x, z] of [[0, -52], [0, 52], [-30, 52], [30, 52]]) { doorFrame(x, z, true); spawn(x, 0, z + (z < 0 ? 1.2 : -1.2)); }

  // ---------------- central tower ----------------
  {
    const W = 14, H = 4, hw = W / 2;
    for (let f = 1; f <= 4; f++) slab(-hw, -hw, hw, hw, f * H, 0.4);
    for (const [px, pz] of [[-6.6, -6.6], [6.6, -6.6], [-6.6, 6.6], [6.6, 6.6], [0, -6.6], [0, 6.6], [-6.6, 0], [6.6, 0]]) box(px, 0, pz, 0.8, 16, 0.8);
    for (let f = 1; f <= 3; f++) {
      const y = f * H;
      rail(-hw, hw, -1.5, hw, y); rail(1.5, hw, hw, hw, y); // south edge with a gap
      rail(-hw, -hw, hw, -hw, y); // west
      rail(hw, -hw, hw, hw, y); // east
      rail(-hw, -hw, -6.5, -hw, y); rail(3.5, -hw, hw, -hw, y); // north edge with landing gaps
    }
    // roof parapet with gaps, crane
    rail(-5, -hw, hw, -hw, 16); rail(-hw, hw, -1.5, hw, 16); rail(1.5, hw, hw, hw, 16); rail(-hw, -hw, -hw, hw, 16); rail(hw, -hw, hw, 3, 16);
    box(5.5, 16, 5.5, 1, 10, 1); box(5.5, 25.2, 5.5, 1.6, 1.4, 1.6, { noCollide: true });
    box(11.5, 25, 5.5, 16, 0.8, 0.8); box(1, 25, 5.5, 5, 0.8, 0.8); box(-0.5, 23.6, 5.5, 2, 1.6, 1.6);
    box(19, 20.5, 5.5, 0.08, 4.6, 0.08, { noCollide: true, ink: INK.BLACK });
    ring(19, 19.8, 5.5, 'x'); ring(19.5, 24.6, 5.5, 'z');   // only the crane keeps its rings
    // exterior switchback stairs on the north face (x runs -5..1.3, landings each side)
    // two-lane switchback: flights alternate between lanes so no flight sits directly under the next one
    let y = 0;
    for (let f = 0; f < 4; f++) {
      const dir = f % 2 === 0 ? '+x' : '-x'; const sx = dir === '+x' ? -5 : 1.3; const lane = f % 2 === 0 ? -8.3 : -10.3;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '+x' ? 2.4 : -6.1; slab(lx - 1.1, -11.4, lx + 1.1, -7, y, 0.4);
      rail(lx - 1.1, -11.4, lx + 1.1, -11.4, y);
    }
    spawn(0, 8, 0); spawn(0, 4, 3); sniper(0, 16, -3); pickup(0, 12, 0); pickup(-4, 8, 4); pickup(0, 16, 0);
  }

  // ---------------- building A (west): 3 floors, fire escape, ruler bridge to the tower ----------------
  {
    const x1 = -43, x2 = -25, z1 = 4, z2 = 20, H = 4;
    for (let f = 1; f <= 3; f++) slab(x1, z1, x2, z2, f * H, 0.4);
    // exterior walls with doors/windows
    wallZ(z1, z2, x2, 0, 12, 0.4, [[10, 13, 0, 3.2], [6, 9, 5, 7], [14, 17, 5, 7], [6, 9, 9, 11], [14, 17, 9, 11]]); // east face
    wallZ(z1, z2, x1, 0, 12, 0.4, [[8, 11, 0, 3.2], [8, 11, 4.5, 7.5], [8, 11, 8.5, 11.5]]); // west face
    wallX(x1, x2, z1, 0, 12, 0.4, [[-36, -33, 0, 3.2], [-40, -37, 5, 7], [-31, -28, 5, 7], [-36, -32, 8.5, 11.5]]); // north face
    wallX(x1, x2, z2, 0, 12, 0.4, [[-36, -32, 0, 3.2], [-31, -27, 0, 3.2], [-42, -39, 0, 3.2], [-37.2, -33.5, 4.05, 7.2], [-36, -32, 8.4, 11.4], [-41, -27, 4.6, 7.6], [-29, -25.5, 8.05, 11.2]]); // south face
    // interior partitions
    wallX(x1, x2, 12, 0, 4, 0.3, [[-40, -37.5], [-30, -27.5]]);
    wallX(x1, x2, 12, 4, 4, 0.3, [[-36, -32]]);
    wallZ(z1, z2, -34, 8, 4, 0.3, [[8, 11], [14, 17]]);
    // roof parapet with gaps
    rail(x1, z1, -37, z1, 12); rail(-31, z1, x2, z1, 12); rail(x1, z2, -37.4, z2, 12); rail(-34.4, z2, x2, z2, 12); rail(x1, z1, x1, z2, 12); rail(x2, z1, x2, 9, 12); rail(x2, 15, x2, z2, 12);
    // fire escape: switchback on the south face (z 21..23)
    let y = 0;
    for (let f = 0; f < 3; f++) {
      const dir = f % 2 === 0 ? '-x' : '+x'; const sx = dir === '-x' ? -28.5 : -34.8; const lane = f % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '-x' ? -35.9 : -27.4; slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
    // ruler bridge A roof -> tower floor 3 (y=12)
    box(-16, 11.6, 6, 18.4, 0.4, 2.4, { ink: INK.ORANGE });
    for (let i = 0; i <= 18; i++) box(-25 + i, 12, 5, 0.06, 0.02, i % 5 === 0 ? 0.6 : 0.35, { noCollide: true, ink: INK.BLACK });
    rail(-25, 7.2, -7, 7.2, 12, { ink: INK.ORANGE });
    
    spawn(-34, 12, 12); spawn(-40, 0, 18); sniper(-27, 12, 6); pickup(-34, 4, 12); pickup(-30, 12, 16); pickup(-40, 8, 8);
  }

  // ---------------- building B (east): warehouse with catwalk + skylight ----------------
  {
    const x1 = 24, x2 = 44, z1 = 4, z2 = 20;
    // roof with a 6x6 skylight hole in the middle
    slab(x1, z1, x2, 9, 12, 0.4); slab(x1, 15, x2, z2, 12, 0.4); slab(x1, 9, 31, 15, 12, 0.4); slab(37, 9, x2, 15, 12, 0.4);
    wallZ(z1, z2, x1, 0, 12, 0.4, [[10, 14, 0, 3.6], [6, 9, 7, 10], [15, 18, 7, 10]]); // west face
    wallZ(z1, z2, x2, 0, 12, 0.4, [[7, 10, 0, 3.2], [14, 17, 0, 3.2], [8, 16, 7, 10]]); // east face
    wallX(x1, x2, z1, 0, 12, 0.4, [[32, 36, 0, 3.6], [27, 30, 7, 10], [38, 41, 7, 10]]); // north face
    wallX(x1, x2, z2, 0, 12, 0.4, [[26, 29, 0, 3.2], [39, 42, 0, 3.2], [33.5, 36.5, 4.05, 7.2], [25.5, 28.5, 8.05, 11.2], [32, 36, 8, 11]]); // south face
    // catwalk at y=6 around the inside walls (1.6 wide), interior stairs along the west wall
    slab(x1 + 0.4, z1 + 0.4, x1 + 2, z2 - 0.4, 6, 0.3); slab(x2 - 2, z1 + 0.4, x2 - 0.4, z2 - 0.4, 6, 0.3);
    slab(x1 + 2, z1 + 0.4, x2 - 2, z1 + 2, 6, 0.3); slab(x1 + 2, z2 - 2, x2 - 2, z2 - 0.4, 6, 0.3);
    rail(x1 + 2, z1 + 2, x1 + 2, 9, 6); rail(x1 + 2, 15, x1 + 2, 17, 6); rail(x2 - 2, z1 + 2, x2 - 2, z2 - 2, 6);
    rail(x1 + 2, z1 + 2, 31, z1 + 2, 6); rail(37, z1 + 2, x2 - 2, z1 + 2, 6); rail(x1 + 2, z2 - 2, x2 - 2, z2 - 2, 6);
    stairs(26.2, 0, 8.6, '+z', 21, 1.6, { rise: 6 / 21, run: 0.45 }); // arrives at z=18.05, y=6 onto the catwalk
    // crates inside
    box(34, 0, 12, 2.4, 2.4, 2.4); box(36.4, 0, 12, 2.4, 1.2, 2.4); box(30, 0, 16, 1.6, 1.6, 1.6, { ink: INK.GREEN });
    // exterior switchback on the south face to the roof (z 21..23)
    let y = 0;
    for (let f = 0; f < 3; f++) {
      const dir = f % 2 === 0 ? '+x' : '-x'; const sx = dir === '+x' ? 27.5 : 33.8; const lane = f % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, lane, dir, 14, 1.8); y += 4;
      const lx = dir === '+x' ? 34.9 : 26.4; slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
    rail(x1, z1, 31, z1, 12); rail(37, z1, x2, z1, 12); rail(x1, z2, 33.4, z2, 12); rail(36.4, z2, x2, z2, 12); rail(x2, z1, x2, z2, 12); rail(x1, z1, x1, 9, 12); rail(x1, 15, x1, z2, 12);
    // plank bridge tower floor 3 -> B roof
    box(15.5, 11.6, 6, 17.4, 0.4, 2.2); rail(7, 4.9, 24, 4.9, 12);
    
    spawn(34, 12, 18); spawn(40, 0, 8); sniper(26, 12, 18); pickup(34, 0, 12); pickup(34, 6, 19); pickup(42, 12, 6);
  }

  // ---------------- highway ----------------
  {
    const z = -30, y = 7;
    slab(-52, z - 4.5, 52, z + 4.5, y, 0.6);
    wallX(-52, 52, z - 4.3, y, 0.9, 0.4, [[-33, -29], [27, 31], [-2, 2]]); // north barrier gaps: bridges to houses
    wallX(-52, 52, z + 4.3, y, 0.9, 0.4, [[-36.5, -33], [33, 36.5]]); // south barrier gaps: stairs
    for (let x = -48; x <= 48; x += 12) box(x, 0, z, 1.4, 6.4, 1.4);
    stairs(-46.5, 0, z + 5.5, '+x', 25, 2, { rise: 0.28, run: 0.45 }); stairs(46.5, 0, z + 5.5, '-x', 25, 2, { rise: 0.28, run: 0.45 });
    
    // road markings
    for (let x = -50; x < 50; x += 4) box(x + 1, y, z, 2, 0.02, 0.2, { noCollide: true, ink: INK.BLACK });
    spawn(-48, y, z); spawn(48, y, z); sniper(0, y, z); pickup(-10, y, z); pickup(24, y, z);
  }

  // ---------------- row houses (north) ----------------
  {
    const z = -45;
    box(-30, 0, z, 14, 7, 10); box(-8, 0, z, 14, 11, 10); box(16, 0, z, 14, 7, 10);
    // bridges from the highway to house 1 and house 3 (y=7)
    box(-31, 6.7, -37.25, 2.6, 0.3, 5.5); box(29, 6.7, -37.25, 2.6, 0.3, 5.5); box(0, 6.7, -37.25, 2.6, 0.3, 5.5);
    rail(-32.3, -40, -32.3, -34.5, 7); rail(-29.7, -40, -29.7, -34.5, 7); rail(27.7, -40, 27.7, -34.5, 7); rail(30.3, -40, 30.3, -34.5, 7);
    // stairs house1 roof -> house2 roof (over the gap)
    stairs(-23, 7, z, '+x', 14, 2.2); slab(-16.9, z - 1.1, -15, z + 1.1, 11, 0.4);
    // stairs house3 roof -> house2 roof
    stairs(9, 7, z, '-x', 14, 2.2); slab(-1, z - 1.1, 2.9, z + 1.1, 11, 0.4);
    // chimneys, water tank, doodle antenna
    box(-33, 7, z - 3, 1.2, 1.6, 1.2); box(19, 7, z + 3, 1.2, 1.4, 1.2); cyl(-10, 11, z - 2.5, 1.4, 2.6, { seg: 14 });
    box(-5, 11, z + 3, 0.1, 4, 0.1, { noCollide: true, ink: INK.BLACK });
    
    spawn(-8, 11, z); spawn(-30, 7, z - 3); spawn(16, 7, z); sniper(-8, 11, z - 3); sniper(16, 7, z + 2); pickup(-8, 11, z + 2); pickup(-30, 7, z);
  }

  // ---------------- south plaza: containers, crates, bus, doodle props ----------------
  {
    box(-14, 0, 34, 2.5, 2.6, 6.2, { ink: INK.GREEN }); box(-14, 2.6, 34, 2.5, 2.6, 6.2, { ink: INK.ORANGE });
    box(14, 0, 36, 6.2, 2.6, 2.5); box(17, 2.6, 36, 3, 2.6, 2.5, { ink: INK.GREEN });
    box(-6, 0, 28, 1.4, 1.4, 1.4); box(-4.5, 0, 28.5, 1.2, 1.2, 1.2); box(-5.3, 1.4, 28.2, 1.0, 1.0, 1.0);
    box(8, 0, 26, 1.6, 1.6, 1.6); box(9.6, 0, 26.4, 1.2, 1.2, 1.2);
    // bus
    box(24, 0.6, 40, 11, 3.2, 2.8); box(24, 0, 40, 10, 0.6, 2.6, { noCollide: true }); for (const x of [20, 28]) { cyl(x, 0, 41.5, 0.55, 0.4, { noCollide: true, seg: 10, ink: INK.BLACK }); cyl(x, 0, 38.5, 0.55, 0.4, { noCollide: true, seg: 10, ink: INK.BLACK }); }
    // giant pencil lying on the ground (orange body, black tip, pink eraser)
    { const g = new THREE.CylinderGeometry(0.8, 0.8, 16, 6); g.rotateZ(Math.PI / 2); g.translate(-30, 0.8, 44); addGeo(g, INK.ORANGE); collider(-30, 0, 44, 16, 1.6, 1.6);
      const tip = new THREE.ConeGeometry(0.8, 2.4, 6); tip.rotateZ(-Math.PI / 2); tip.translate(-20.8, 0.8, 44); addGeo(tip, INK.BLACK); collider(-20.8, 0, 44, 2.4, 1.6, 1.6);
      const er = new THREE.CylinderGeometry(0.82, 0.82, 1.6, 8); er.rotateZ(Math.PI / 2); er.translate(-38.8, 0.8, 44); addGeo(er, INK.PINK); collider(-38.8, 0, 44, 1.6, 1.64, 1.64); }
    // giant eraser block (pink) + coffee mug (blue) props to climb
    box(38, 0, 40, 6, 2.2, 3.2, { ink: INK.PINK }); box(38, 2.2, 40, 6, 0.8, 3.2, { ink: INK.BLUE });
    cyl(-40, 0, 32, 2.6, 3.4, { seg: 16 }); { const h = new THREE.TorusGeometry(1.4, 0.35, 8, 16); h.translate(-36.6, 1.8, 32); addGeo(h, INK.BLUE); }
    // lamp posts + benches
    for (const [x, z] of [[-10, 46], [10, 46], [-22, 24], [22, 24]]) { box(x, 0, z, 0.25, 6, 0.25); box(x, 6, z, 1.4, 0.3, 0.5, { noCollide: true }); }
    for (const [x, z] of [[-4, 46], [4, 46]]) { box(x, 0.4, z, 3, 0.15, 0.6); box(x, 0, z, 2.6, 0.4, 0.2, { noCollide: true }); }
    pickup(-6, 0, 36); pickup(6, 0, 36); pickup(-30, 1.6, 44); pickup(38, 3, 40); pickup(0, 0, 10);
    // scattered cover in the open middle areas
    box(-16, 0, -8, 2.2, 1.2, 2.2); box(18, 0, -10, 2.2, 1.6, 2.2); box(-20, 0, 8, 1.6, 1.0, 3); box(20, 0, -2, 3, 1.0, 1.6);
    box(-8, 0, -18, 4, 1.1, 1.2); box(8, 0, -18, 4, 1.1, 1.2); box(0, 0, 22, 5, 0.5, 1.4); box(-24, 0, -18, 2.4, 2.6, 2.4, { ink: INK.ORANGE }); box(26, 0, -18, 2.4, 2.6, 2.4, { ink: INK.GREEN });
  }

  // ---------------- sky doodles ----------------
  {
    sphere(-90, 110, -160, 12, { seg: 12 });
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const g = new THREE.BoxGeometry(6, 0.7, 0.7); g.rotateZ(a); g.translate(-90 + Math.cos(a) * 19, 110 + Math.sin(a) * 19, -160); addGeo(g, INK.BLUE); }
    for (const [cx, cy, cz, s] of [[60, 70, -170, 1], [-20, 75, -190, 1.3], [140, 60, -80, 0.9], [-150, 65, 40, 1.1], [30, 80, 180, 1.2], [-90, 60, 170, 0.8]]) {
      for (let i = 0; i < 6; i++) sphere(cx + (i - 2.5) * 5 * s, cy + Math.sin(i * 1.7) * 2.5 * s, cz, (4 + (i % 3)) * s, { seg: 10 });
    }
  }

  planes(3, 45, 30);
  return B.finish();
}

// ============================ map 2: The Desk ============================
// You are two inches tall on somebody's desk. Everything is a stationery object at monstrous
// scale: an open book whose pages are ramps, keyboard keys you hop between, a mug you spiral up,
// pen barrels laid as beams, paper clips arching overhead to swing from. Wide open in between,
// nothing enclosed, and every high place is in the open where anyone can shoot you off it.
function buildDesk(B) {
  const { L, box, slab, rail, cyl, sphere, ring, spawn, sniper, pickup, planes, addGeo, collider } = B;
  L.playerStart.set(0, 0, 36);
  L.bounds = { minX: -52, maxX: 52, minZ: -52, maxZ: 52 };

  // stepped slope: reads as a smooth ramp and is walkable by player and enemies alike
  function ramp(x, z, dir, len, top, width, o = {}) {
    // rise per step has to stay well under the navigation grid's clearance floor, otherwise the
    // tread above reads as a wall and no path is ever generated up the slope
    const steps = Math.max(4, Math.round(len / 0.55), Math.ceil(top / 0.3));
    const run = len / steps, rise = top / steps;
    const dx = dir === '+x' ? 1 : dir === '-x' ? -1 : 0, dz = dir === '+z' ? 1 : dir === '-z' ? -1 : 0;
    for (let i = 0; i < steps; i++) {
      const c = (i + 0.5) * run;
      box(x + dx * c, o.base ?? 0, z + dz * c, dx ? run + 0.006 : width, (i + 1) * rise - (o.base ?? 0), dz ? run + 0.006 : width, o);
    }
  }
  // a flat-topped object with a thin lip; you can stand on it and be seen from everywhere
  function slab3(x, z, w, d, h, o = {}) { box(x, o.base ?? 0, z, w, h - (o.base ?? 0), d, o); }
  // long round barrel lying on the ground, walkable along the top
  function barrel(x, y, z, len, r, axis, ink) {
    const g = new THREE.CylinderGeometry(r, r, len, 9);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else g.rotateX(Math.PI / 2);
    g.translate(x, y + r, z); addGeo(g, ink);
    collider(x, y, z, axis === 'x' ? len : r * 1.7, r * 2, axis === 'x' ? r * 1.7 : len);
  }
  function post(x, z, y0, h, r, ink) { box(x, y0, z, r * 2, h, r * 2, { ink, noNav: true }); }
  // a wire arch: two uprights and a curved span, used as a swing line
  function clipArch(x, z, span, h, axis, ink) {
    const seg = 9, r = 0.19;
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const a0 = Math.PI * t0, a1 = Math.PI * t1;
      const p0 = [Math.cos(a0) * span / 2, Math.sin(a0) * h], p1 = [Math.cos(a1) * span / 2, Math.sin(a1) * h];
      const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 0.1;
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const g = new THREE.BoxGeometry(len, r, r); g.rotateZ(ang);
      if (axis === 'z') g.rotateY(Math.PI / 2);
      g.translate(x + (axis === 'x' ? mx : 0), my, z + (axis === 'z' ? mx : 0));
      addGeo(g, ink);
    }
  }

  // ---------------- the desk surface ----------------
  box(0, -1, 0, 132, 1, 132);
  // wood grain, drawn only
  for (let i = -12; i <= 12; i++) {
    const z = i * 4.2 + Math.sin(i * 1.7) * 1.1;
    box(0, 0, z, 120, 0.02, 0.16 + 0.1 * Math.abs(Math.sin(i * 2.3)), { noCollide: true, ink: INK.ORANGE });
  }
  // desk edge: a raised rim rather than a wall, plus a fence of standing books behind it
  const P = 50, T = 4;
  for (const [cx, cz, w, d] of [[0, -P, 2 * P + T, T], [0, P, 2 * P + T, T], [-P, 0, T, 2 * P + T], [P, 0, T, 2 * P + T]]) {
    box(cx, 0, cz, w, 1.6, d, { ink: INK.BLACK });
    collider(cx, 1.6, cz, w, 14, d, { noNav: true });
  }
  // standing books forming the back wall, each a different height and colour
  const inks = [INK.BLUE, INK.GREEN, INK.ORANGE, INK.PINK, INK.RED, INK.BLACK];
  for (let i = 0; i < 26; i++) {
    const t = (i / 25) * 2 - 1, h = 7 + Math.abs(Math.sin(i * 1.9)) * 7, w = 2.6 + (i % 3) * 0.7;
    box(t * 46, 1.6, -P - 0.6, w, h, 3.4, { noCollide: true, ink: inks[i % inks.length] });
    box(t * 46, 1.6, P + 0.6, w, h * 0.8, 3.4, { noCollide: true, ink: inks[(i + 2) % inks.length] });
  }
  for (let i = 0; i < 22; i++) {
    const t = (i / 21) * 2 - 1, h = 6 + Math.abs(Math.cos(i * 1.6)) * 7;
    box(-P - 0.6, 1.6, t * 46, 3.4, h, 2.8 + (i % 2) * 0.6, { noCollide: true, ink: inks[(i + 1) % inks.length] });
    box(P + 0.6, 1.6, t * 46, 3.4, h * 0.85, 2.8 + (i % 2) * 0.6, { noCollide: true, ink: inks[(i + 4) % inks.length] });
  }
  for (const [x, z] of [[-47, 0], [47, 0], [0, -47], [0, 47], [-34, -34], [34, 34], [34, -34], [-34, 34]]) spawn(x, 0, z);

  // ---------------- the open book: two page slopes meeting in a valley ----------------
  {
    const cz = -24, w = 30;
    // spine
    box(0, 0, cz, 2.2, 1.1, 20, { ink: INK.BLACK });
    // page ramps rising away from the spine on both sides
    ramp(1.1, cz, '+x', w / 2 - 1, 5.2, 20, { ink: INK.BLUE });
    ramp(-1.1, cz, '-x', w / 2 - 1, 5.2, 20, { ink: INK.BLUE });
    // ruled lines drawn across the pages
    for (let i = 1; i < 9; i++) { const zz = cz - 10 + i * 2.2; box(8, 5.3, zz, 13, 0.02, 0.18, { noCollide: true, ink: INK.BLUE }); box(-8, 5.3, zz, 13, 0.02, 0.18, { noCollide: true, ink: INK.BLUE }); }
    sniper(13, 5.2, cz); sniper(-13, 5.2, cz); pickup(0, 1.1, cz); pickup(13, 5.2, cz - 5); pickup(-13, 5.2, cz + 5);
  }

  // ---------------- the keyboard: a field of keys at staggered heights ----------------
  {
    const ox = -26, oz = 12, cols = 7, rows = 5, pitch = 4.0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if ((r === 2 && c === 3)) continue;                              // a missing key, a gap to fall through
      const x = ox + c * pitch + r * 0.9, z = oz + r * pitch;
      const h = 1.0 + ((r * 3 + c * 5) % 4) * 0.6;                     // staggered, but each within one step of its neighbour
      box(x, 0, z, 3.6, h, 3.6, { ink: c % 3 === 0 ? INK.GREEN : INK.BLUE });
      box(x, h, z, 3.8, 0.12, 3.8, { noCollide: true, ink: INK.BLACK });
      if ((r + c) % 5 === 0) pickup(x, h, z);
    }
    // a long space bar along the front edge
    box(ox + 12, 0, oz + rows * pitch + 1.4, 20, 1.9, 3.4, { ink: INK.BLUE });
    ramp(ox + 12, oz + rows * pitch + 4.6, '-z', 3.2, 1.9, 20, { ink: INK.BLUE });
    sniper(ox + 12, 1.9, oz + rows * pitch + 1.4);
    spawn(ox - 4, 0, oz + 8);
  }

  // ---------------- the mug: spiral up a stack of sugar cubes to a wide rim ----------------
  {
    const mx = 24, mz = -6, R = 7.5, H = 9.5;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const g = new THREE.BoxGeometry(3.0, H, 1.6); g.rotateY(-a); g.translate(mx + Math.cos(a) * R, H / 2, mz + Math.sin(a) * R); addGeo(g, INK.BLUE);
      collider(mx + Math.cos(a) * R, 0, mz + Math.sin(a) * R, 3.0, H, 3.0, { noNav: true });
    }
    slab(mx - R + 1.4, mz - R + 1.4, mx + R - 1.4, mz + R - 1.4, H, 0.5);   // the drink surface, standable
    // handle
    const hnd = new THREE.TorusGeometry(3.2, 0.75, 8, 14, Math.PI * 1.1); hnd.rotateY(Math.PI / 2); hnd.translate(mx + R + 1.4, H * 0.55, mz); addGeo(hnd, INK.BLUE);
    // a stack of sugar cubes wrapping the mug as a continuous stair up to the rim
    const stepsUp = Math.ceil(H / 0.42);
    for (let i = 0; i <= stepsUp; i++) {
      const a = -1.5 + i * (3.4 / stepsUp), rr = R + 3.1;
      box(mx + Math.cos(a) * rr, 0, mz + Math.sin(a) * rr, 3.0, 0.42 * (i + 1), 3.0, { ink: INK.PINK });
    }
    sniper(mx, H, mz); pickup(mx, H, mz); pickup(mx + R + 4, 1, mz - 4);
  }

  // ---------------- pens and pencils laid across the desk as beams ----------------
  barrel(-14, 0, 30, 30, 1.15, 'x', INK.ORANGE);
  { const t = new THREE.ConeGeometry(1.15, 3.2, 7); t.rotateZ(-Math.PI / 2); t.translate(2.6, 1.15, 30); addGeo(t, INK.BLACK); collider(2.6, 0, 30, 3.2, 2.3, 2.3); }
  ramp(-33.5, 30, '+x', 4.4, 2.25, 2.6, { ink: INK.PINK });
  barrel(18, 0, 34, 26, 1.05, 'x', INK.GREEN);
  ramp(35.4, 34, '-x', 4.2, 2.05, 2.4, { ink: INK.GREEN });
  barrel(38, 0, 6, 24, 1.1, 'z', INK.BLUE);
  ramp(38, -10.4, '+z', 4.4, 2.15, 2.5, { ink: INK.BLUE });

  // ---------------- eraser and sticky-note blocks in the open ground ----------------
  // Each block gets a slope generated from its own footprint, so the slope always starts on open
  // ground and finishes flush with the top rather than burying itself in the block.
  function blockWithRamp(x, z, w, d, h, ink, side) {
    box(x, 0, z, w, h, d, { ink });
    box(x, h, z, w + 0.25, 0.12, d + 0.25, { noCollide: true, ink: INK.BLACK });
    const len = Math.max(3.2, h * 1.7), rw = Math.min(w, d, 4.2);
    if (side === '-z') ramp(x, z - d / 2 - len, '+z', len, h, rw, { ink });
    else if (side === '+z') ramp(x, z + d / 2 + len, '-z', len, h, rw, { ink });
    else if (side === '-x') ramp(x - w / 2 - len, z, '+x', len, h, rw, { ink });
    else ramp(x + w / 2 + len, z, '-x', len, h, rw, { ink });
    sniper(x, h, z); pickup(x, h, z);
  }
  for (const [x, z, w, d, h, ink, side] of [
    [-38, -8, 8, 6, 3.4, INK.PINK, '-z'], [-20, -6, 6, 6, 5.0, INK.ORANGE, '+z'], [10, 8, 7, 7, 2.4, INK.GREEN, '-z'],
    [4, 22, 9, 6, 4.0, INK.PINK, '+z'], [-6, -6, 5, 5, 6.2, INK.BLUE, '+z'], [30, 22, 7, 7, 3.0, INK.ORANGE, '+z'],
    [-40, 40, 7, 7, 5.6, INK.GREEN, '+x'], [40, -40, 7, 7, 5.6, INK.PINK, '-x'],
  ]) blockWithRamp(x, z, w, d, h, ink, side);

  // ---------------- paper clips arching overhead: the swing network ----------------
  clipArch(-14, 30, 34, 15, 'x', INK.BLACK);
  clipArch(18, 34, 30, 13, 'x', INK.BLACK);
  clipArch(38, 6, 28, 14, 'z', INK.BLACK);
  clipArch(0, -24, 34, 17, 'x', INK.BLACK);
  clipArch(-26, 22, 30, 12, 'z', INK.BLACK);
  // a desk lamp arcing over the middle: the one thing with a grapple ring on it
  {
    const lx = 34, lz = 40;
    cyl(lx, 0, lz, 3.2, 1.0, { seg: 14, ink: INK.BLACK });
    post(lx, lz, 1.0, 17, 0.5, INK.BLACK);
    for (let i = 0; i < 8; i++) {
      const t = i / 7, a = t * Math.PI * 0.55;
      const g = new THREE.BoxGeometry(0.85, 0.85, 4.6); g.rotateX(a * 0.4);
      g.translate(lx - Math.sin(a) * 16 * t, 17.4 + Math.cos(a) * 1.5, lz - Math.cos(a) * 4 * t - t * 10); addGeo(g, INK.BLACK);
    }
    const shade = new THREE.ConeGeometry(5.2, 6, 10, 1, true); shade.rotateX(Math.PI * 0.86); shade.translate(lx - 15, 15.5, lz - 17); addGeo(shade, INK.ORANGE);
    ring(lx - 15, 12.4, lz - 17, 'y');
    sphere(lx - 15, 13.6, lz - 17, 1.6, { seg: 10, ink: INK.ORANGE });
  }
  // and one more ring hanging from the tallest clip, for a long swing across the middle
  ring(0, 15.4, -24, 'x');

  // ---------------- odds and ends, low cover in the open ----------------
  for (const [x, z, r, ink] of [[-30, 44, 1.5, INK.BLUE], [16, -38, 1.7, INK.GREEN], [-46, 20, 1.4, INK.ORANGE],
    [46, -18, 1.5, INK.PINK], [22, 44, 1.3, INK.BLUE], [-16, -44, 1.6, INK.BLACK]]) {
    cyl(x, 0, z, r, r * 1.6, { seg: 10, ink });
  }
  for (const [x, z] of [[-10, 40], [12, -14], [-44, -30], [44, 30], [26, -30], [-28, -40]]) {
    box(x, 0, z, 3.4, 1.5, 3.4, { ink: INK.BLUE }); box(x, 1.5, z, 3.6, 0.1, 3.6, { noCollide: true, ink: INK.BLACK });
  }
  for (const [x, y, z] of [[0, 0, 8], [-16, 0, 0], [16, 0, 16], [0, 0, -8], [-34, 0, 30], [34, 0, -22], [0, 0, 40]]) pickup(x, y, z);

  // ---------------- above the desk ----------------
  sphere(-80, 96, -150, 12, { seg: 12 });
  for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; const g = new THREE.BoxGeometry(5.5, 0.7, 0.7); g.rotateZ(a); g.translate(-80 + Math.cos(a) * 18, 96 + Math.sin(a) * 18, -150); addGeo(g, INK.BLUE); }
  for (const [cx, cy, cz, sc] of [[60, 80, -180, 1.1], [-40, 88, -200, 1], [130, 72, 70, 1], [-130, 76, 80, 1.1]])
    for (let i = 0; i < 6; i++) sphere(cx + (i - 2.5) * 5 * sc, cy + Math.sin(i * 1.7) * 2.5 * sc, cz, (4 + (i % 3)) * sc, { seg: 10 });

  planes(3, 44, 30);
  return B.finish();
}

export function buildLevel(scene, world, key = 'district') {
  const B = createBuilder(scene, world);
  return key === 'desk' ? buildDesk(B) : buildDistrict(B);
}
