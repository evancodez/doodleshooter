# Doodle District

A pen-on-paper survival shooter in three.js: the whole world is drawn as ballpoint ink on lined
notebook paper (inspired by the a-ha "Take On Me" look). Enemies are red-ink doodles that scribble
themselves onto the page in waves. First person, mouse/keyboard or PS5 controller, no build step.

## Run it

ES modules need to be served over HTTP (opening `index.html` directly will not work):

```bash
python3 serve.py 8901
```

Then open http://127.0.0.1:8901 and click to start. A DualSense controller is picked up
automatically once you touch a stick or button. Look sensitivity, invert-Y and music are on the
start and pause screens and persist between sessions.

## Controls

| Action | Mouse + keyboard | PS5 controller |
| --- | --- | --- |
| Move / look | WASD / mouse | Left stick / right stick |
| Fire, katana slash | Left mouse | R2 |
| Aim down sights (guns), block & deflect (katana) | Right mouse | L2 |
| Jump, wall jump (jump again while touching a wall) | Space | Cross |
| Slide on the ground, air dash in the air | C / Ctrl / X | Circle |
| Grapple: tap to swing, hold to reel, tap to let go, jump to launch | Q / E / G | L1 |
| Quick katana slash (then back to your gun) | F / V | R1 |
| Dash-slash (only when the gauge is lit) | Both mouse buttons | L2 + R2 |
| Reload | R | Square |
| Double jump | Space again in the air | Cross again in the air |
| Weapons: rifle, shotgun, revolver, sniper, katana | 1-5 / wheel | Triangle / d-pad |
| Sprint | Shift | L3 |
| Pause / music | Esc / M | Options / Share |

Mantling is automatic: hold forward into a ledge while airborne. Holding forward mid-swing pumps
the grapple to build speed.

## Weapons

- **Rifle** — automatic, holo sight, 30-round magazine, strong headshot multiplier.
- **Shotgun** — 9 pellets with damage falloff, pump between shots, shell-by-shell reload you can
  cancel by firing.
- **Revolver** — 62 damage a shot, triple headshot damage, swing-out cylinder reload.
- **Sniper** — bolt action, 150 damage a body shot and 450 to the head, with a drawn scope
  overlay at high zoom. The gun model hides once you are properly behind the glass.
- **Katana** — alternating combo slashes that dismember, lunges when sprinting or airborne, and a
  block that returns enemy bullets. Blocking within 0.22s of a shot is a perfect parry that sends
  the bullet back at whoever fired it for triple damage.

### Focus slash

A gauge beside the crosshair fills with katana kills. Four of them light it, and it catches fire
to say a slash is ready. That opens a slow-motion window. A bracket marks whoever is nearest your
crosshair. Hold **both triggers** (or both mouse buttons) and you physically sprint the whole
distance to them at about 46 m/s while the world crawls, then cut them down on arrival. It is
real movement, not a teleport, so walls and ledges still apply and you can watch yourself cross
the room. Each execution re-opens the window, giving two dashes per charge. If a wall stops the dash short
you swing at empty air; reaching them is what kills them, not starting the dash.

The dash arms a fraction of a second after the window opens, and only once the trigger combo has
been released, so holding the triggers through a kill never fires a dash you did not ask for.

## Maps

Pick one on the start or pause screen; the choice is remembered.

- **Doodle District** — streets, rooftops, fire escapes and an elevated highway.
- **The Desk** — you are two inches tall on somebody's desk. An open book whose pages are ramps,
  a field of keyboard keys to hop between, a mug you spiral up on sugar cubes, pens laid as
  beams, paper clips arching overhead to swing from. Nothing is enclosed, so every high place is
  in the open where anything can shoot you off it.

Maps rebuild in place into the same world instance, so switching does not reload the page.

## Enemies

Grunts, rushers, heavies, snipers, shield bearers, ink bombers (explode on a fuse), paper wasps
(dive from the air) and **The Doodler**, a boss with a crown and a giant pencil that appears every
fifth wave. Waves draw from a widening roster and sometimes carry a modifier such as
*Caffeinated*, *Heavy Ink* or *Swarm*.

Enemy snipers paint a single beam that **trails** you rather than sticking to you, and the shot
goes exactly where the beam is pointing, so once you see it, moving is enough to make it miss.

Waves ramp gently: wave one is six grunts with only three alive at a time, and each new enemy type
is rare on the wave it debuts, reaching full frequency a few waves later. Wave modifiers stay off
until wave four, and the swarm modifier until wave six. The Doodler is checked for headroom before
it spawns so it never appears wedged inside a building.

Each enemy claims its own approach angle around you (evenly spaced, not random) and its own
preferred standoff range, so a group fans out and arrives from several sides instead of forming
one queue behind a single pathfinding line.

## How the look works

`src/render.js` renders the scene into a data buffer (shade, ink id, view normal) plus depth, then
a full-screen pass draws it as pen on paper: outlines from depth and normal discontinuities,
screen-space hatching that follows each surface, paper grain, ruled lines, the red margin and a
scribble vignette when you are hurt.

Three details matter for keeping it stable rather than flickery:

- The paper wobble is a **static** noise field. An earlier version re-seeded it on a timer, which
  read as doodles flashing on and off even when nothing moved.
- Hatching is anchored in **world space**, not screen space. The fragment's world position is
  rebuilt from depth and strokes are laid out in world units on whichever plane the surface most
  faces, with spacing quantised to powers of two so on-screen density stays constant. Deriving
  the stroke direction from the view normal instead made flat walls hatch into axis-aligned
  rectangles that slid around as the camera turned. The held weapon is the exception: it rides
  with the camera, so for anything within two metres the screen is the stable frame.
- Edges are detected in **inverse depth** (`1/d`), which is affine across the screen for any plane
  including one seen at a grazing angle, so the second difference is zero there. Testing the raw
  depth buffer instead painted large false outlines across the floor. The test is compared against
  `1/d` itself so it is scale invariant and distant outlines stay as crisp as near ones.

Enemies are drawn flat (no hatching) from bowed tube strokes, oval bodies and big heads with solid
ink faces, so they read as drawings rather than as shaded 3D primitives.

Blood is not a single flat quad. Each splat is a cluster of smaller marks, and every mark is
raycast onto whatever surface is really there, so a hit beside a crate wraps over the edge and
continues on the floor instead of leaving half a decal hanging in the air. Marks stretch along the
spray direction, and blood on a wall runs a little way down it.

Railings are solid to movement but tagged see-through, so shots, enemy fire and line-of-sight all
pass under the top bar where you can visibly see a gap.

The grapple fires at whatever the crosshair is actually on. Enemies and rings get only a few
degrees of assist, and never when they sit behind what you are pointing at, so the hook stops
snapping to rings overhead that you never aimed at.

Blocking with the katana is held on the aim trigger only, never while swinging. It covers a
0.95 m reach in front of you, judged by the direction a round is travelling rather than where it
happens to be, and the blade needs a fifth of a second to recover between parries. Roughly a
third of what you block gets sent back at whoever fired it; the rest is simply knocked out of
the air. Against three shooters head on that cuts incoming damage by about half, five shooters
overwhelm it, and shots from your flank ignore it entirely.

The blade stains as it kills. Streaks are built in the plane of the steel and inset inside its
silhouette so nothing overhangs an edge, beads gather along the edge when it is soaked, and it
sheds slowly back to clean.

## Source map

- `src/render.js` — the ink renderer and both shaders.
- `src/level.js` — the arena: central tower with a crane, two flanking buildings with fire escapes
  and a warehouse catwalk, an elevated highway, row houses, bridges, and props like a giant pencil.
  Colliders are axis-aligned boxes; the enemy navigation grid is generated from them.
- `src/physics.js` — swept AABB movement with step-up, ground snapping, sub-stepping, raycasts.
- `src/nav.js` — multi-level navigation grid and A*. Head clearance is measured from knee height
  up, otherwise the next tread of a staircase reads as a wall and no nav node is ever placed on
  stairs, which leaves enemies unable to use them.
- `src/player.js` — movement, grapple, camera feel, health, weapon handling.
- `src/weapons.js` — view models and firing for all four weapons.
- `src/enemies.js` — enemy models, AI, projectiles, dismemberment.
- `src/effects.js` — ink particles, blood decals and pools, gibs, shells, smoke, explosions.
- `src/audio.js` — every sound and the music, synthesised with WebAudio; no asset files.
- `src/hud.js`, `style.css` — handwritten-style HUD and screens.
