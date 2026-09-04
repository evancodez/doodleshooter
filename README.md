# Doodle District

A first-person survival shooter drawn in blue ballpoint on lined notebook paper. Grapple across
rooftops and canyons, slice bullets back at the doodles that fired them, lob grenades, and see how
many waves you can survive. Play alone, survive with friends, or fight them.

Everything you see is generated in code with three.js. There are no models, textures or sound
files: the paper, the ink outlines, the hatching, the enemies and the music are all procedural.

## Running it

It is a static site, so any web server works. Locally:

```bash
python3 serve.py 8910
```

then open http://127.0.0.1:8910. On Vercel (or any static host) just deploy the folder as is.

## Modes

- **Solo**: survive the waves alone. Bosses every fifth wave, checkpoints unlock at wave 5, 10, 15...
- **Co-op**: the same waves with up to eight friends on one team. Waves scale with the head count.
- **Team deathmatch**: two teams, first to 30.
- **Free for all**: everyone is fair game, first to 20.

Multiplayer is peer-to-peer over WebRTC (PeerJS), so it works from a static host with no game
server. One player hosts a lobby and gets a code to share; friends type it in to join. A lobby
marked public can be found with **quick play**. The host's browser runs the enemies and the waves;
each player is authoritative over their own body and health.

## Controls

| Action | Mouse + keyboard | PS5 controller |
| --- | --- | --- |
| Move / look / sprint | WASD, mouse, Shift | L stick, R stick, L3 |
| Fire / slash | LMB | R2 |
| Aim / block (katana) | RMB | L2 |
| Jump, wall jump, double jump | Space | ✕ |
| Slide, air dash | C / Ctrl (X, Alt) | ○ |
| Grapple (hold to reel) | Q / E | L1 |
| Quick katana slash | F | R1 |
| Reload | R | □ |
| Grenade | G | R3 or d-pad up |
| Katana dash (gauge lit) | both mouse buttons or X | L2 + R2 |
| Weapons | 1-5 / wheel | △, d-pad |
| Menu | Esc | Options |

On-screen hints follow whichever device you touched last.

## Weapons and gear

Rifle, shotgun, revolver, sniper (with scope) and a katana. Holding block with the katana parries
some incoming bullets and returns a share of them. Katana kills charge a gauge; when it is lit you
can dash to a marked enemy and execute it. In solo the dash slows time; in co-op it does not; in
PvP it is off. Grenades bounce, then go off in a thick orange blast that scorches the paper.

## Maps

- **Doodle District**: streets, rooftops and fire escapes.
- **Paper Canyon**: an ink river, terraced cliffs, a rope bridge, a fallen pencil and a pipe to swing from.

## Enemies

Grunts, rushers, bombers, snipers with dodgeable lasers, flyers, heavies and shield bearers. Bosses
rotate: The Doodler, The Eraser and The Inkblot, each with its own moves.

## How the look works

The scene renders to a buffer holding shade, an ink id and view-space normals plus a float depth.
A post pass draws outlines from an inverse-depth Laplacian, adds surface-following hatching, paper
grain, ruled lines and the red margin. Wobble is static so nothing flickers.
