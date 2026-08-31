# Attack AGI — Game Spec

A 3D fast-paced first-person horde shooter with roguelike elements. The player fights 5 waves of robot hordes dropped into an arena by a giant AGI (a monitor-headed sky god), picks a buff after each wave, then fights the AGI itself in a bullet-hell boss fight.

All tuning numbers live in `src/game/constants.ts` (referenced here by constant name). Shared runtime state contracts live in `src/game/world.ts`, `store.ts`, `types.ts`, `events.ts`.

## Game flow (phase machine, owned by Director)

`menu` → click Start → `wave` (1) → wave cleared → `buffSelect` (3 random buffs, pick 1) → `wave` (2) … through wave 5 → `smash` (AGI smashes the floor: whole ground glows red with a big "JUMP!" countdown at top of screen ticking down over `SMASH_WARN_TIME` (4s); the player must be airborne at impact or is **instantly killed**; smash **clears all obstacles**) → `boss` (boss health bar appears at top) → boss HP 0 → `victory` (AGI makes a surprised `:0` face, then blows up). Player HP 0 at any point → `dead` (retry restarts the whole run — roguelike).

## Player

First-person camera at eye height `PLAYER_EYE`. Fast base walk speed `PLAYER_SPEED`. WASD move, mouse look (pointer lock), Space jump (`JUMP_VELOCITY`, gravity `GRAVITY`), Shift dodge: dashes in current movement direction (`DODGE_SPEED`, `DODGE_TIME`), grants i-frames (`DODGE_IFRAMES`), cooldown `DODGE_COOLDOWN` (2s). Player HP `PLAYER_HP`. Capsule collision vs obstacles and arena bounds (radius `ARENA_RADIUS`).

## Weapons (keys 1/2/3 to select)

1. **Revolver** (key 1): full-auto hitscan — fires while left mouse is held (cadence `PISTOL_FIRE_INTERVAL`, deliberately slower than a sidearm but hits hard). Cylinder `PISTOL_MAG` = 6, must reload (R or auto on empty, `PISTOL_RELOAD` s — swing-out cylinder animation) every 6 shots. Starts with 6 in the cylinder + `PISTOL_RESERVE_START` = 90 reserve. Damage `PISTOL_DAMAGE` = 20; **headshots** (the ray must pass through the enemy's glowing head-display sphere — `HEADSHOT_ZONE` in world.ts, `raycastShot.headshot`) deal **2×** and flash a red hit marker (body hits flash white). Ammo crates refill the **entire reserve**. Fitted with a **red dot sight** (no irons): hold **RMB to aim** — the view model centers so the dot sits on the camera axis, FOV zooms 78→`ADS_FOV` 60, sway damps 85%, recoil 45% tamer, and the HUD crosshair hides. Reloading or switching drops back to hip.
2. **Baseball bat** (key 2): melee, left-click swings (`BAT_DAMAGE`, range `BAT_RANGE`, arc `BAT_ARC`) — hits at most the **3 nearest** targets in the arc per swing (`BAT_MAX_TARGETS` in Weapons.tsx; a focused hit, not an area wipe) and can't reach flyers more than ~2.5m overhead. **Holding** left mouse charges the swing — reaching full charge takes `BAT_CHARGE_TIME` = 2.5s; the bat **flashes when max charged**; a max-charged swing does **3×** damage (`BAT_CHARGED_MULT`). Partial charge scales linearly between 1× and 3×.
3. **Molotov cocktail** (key 3): right-click aims — show the arc trajectory line silhouette + landing area disc. Left-click (while aiming) throws: ballistic arc, explodes on impact (`MOLOTOV_DAMAGE`, radius `MOLOTOV_RADIUS`) and ignites a ground fire patch lasting `FIRE_DURATION` doing `FIRE_DPS` damage/s — **friendly fire**: standing in your own flames burns you at the same rate. Starts with `MOLOTOV_START` = 2 bottles; an ammo crate gives `MOLOTOV_PER_CRATE` = 2 more (up to capacity).

**Ammo crates**: spawned by the Director during waves (`CRATE_INTERVAL`, max `CRATE_MAX` alive). Walk over to collect: refills full pistol reserve + 2 molotovs.

## Enemies (5 kinds, all robots, dropped onto the arena by the AGI's hands)

| kind | behavior | HP | damage |
|---|---|---|---|
| **melee** | walks at player, sword swing when in `MELEE_RANGE` | `MELEE_HP` | `MELEE_DAMAGE` |
| **ranger** | stands still, shoots slow dodgeable laser bolts (`RANGER_BOLT_SPEED`) every `RANGER_INTERVAL` | `RANGER_HP` (lower than melee) | `RANGER_DAMAGE` |
| **tank** | melee-bot with a **shield**, no sword. Walks at player; near range stops, telegraphs for `TANK_WINDUP` = 1.5s with a **red rectangle floor indicator** along its dash path, then shield-bashes (dash `TANK_BASH_SPEED`, `TANK_DAMAGE`). Shield **blocks player bullets** from the front (~`TANK_SHIELD_ARC`). HP = melee's. | `TANK_HP` | `TANK_DAMAGE` |
| **sniper** | robot with a sniper rifle + lens over one eye. Every `SNIPER_INTERVAL` = 5s: telegraphs a **red floor line indicator** where its beam will go (`SNIPER_AIM_TIME`), then fires an instant laser beam. HP = ranger's. | `SNIPER_HP` | `SNIPER_DAMAGE` |
| **drone** | purple-glowing quad-rotor bomber gunship, **flying**: its AGI-hand drop arrests mid-air at `DRONE_ALTITUDE` (~8m) instead of the ground. It **dive-bombs**: rests/loiters 12–18m out cruising at `DRONE_LOITER_SPEED`, then makes a fast attack run straight at the player at `DRONE_SPEED` (17 m/s); when it passes overhead it telegraphs a **red circle floor indicator** at the player's position (`DRONE_BOMB_RADIUS`, `DRONE_BOMB_TELEGRAPH`) and drops a bomb timed to land at the telegraph's resolve — the player has to dodge the drop — then peels away and waits `DRONE_REST` (~10s, desynced per drone) before the next run. Out of bat reach; headshots require hitting the little probe head thrust ahead of the nose on a chin boom (it faces the player during attack runs, and the hit sphere tracks the dive tilt); on death its rotors stop and it tumble-falls to the floor. HP = ranger's. | `DRONE_HP` | `DRONE_BOMB_DAMAGE` |

**Terrain favors the player**: obstacles block shield bashes, sniper/boss laser beams, and ranger bolts (line-of-sight checks via `world.segmentBlocked`).

## Waves (`WAVES` table)

| wave | melee | ranger | tank | sniper | drone |
|---|---|---|---|---|---|
| 1 | 20 | 10 | – | – | 5 |
| 2 | 20 | 10 | 5 | – | 10 |
| 3 | 20 | 10 | 10 | 5 | 15 |
| 4 | 20 | 10 | 20 | 10 | 15 |
| 5 | 10 | 20 | 20 | 10 | 15 |

Enemies are drip-fed: the Director pushes drop requests (`world.dropRequests`); the AGI grabs a cluster in a hand, reaches down, and releases them (→ `world.pendingSpawns`, consumed by Enemies). Keep concurrent enemies ≤ `MAX_CONCURRENT_ENEMIES`.

## Buffs (after each wave: 3 random distinct choices, pick 1; stack across waves)

Pool in `constants.ts` `BUFFS`: pistol damage, mag size, reserve size, fire rate, reload speed, bat damage, reduced charge-up time, molotov capacity, molotov radius/fire damage, move speed, dodge cooldown, max HP/heal, heal-on-wave-clear. Picking recomputes `store.stats` — **all systems read live stats from `useStore.getState().stats`**, never raw constants, for anything buffable.

## The AGI (boss)

Visuals: a **big computer monitor in the sky** as the head, with a **pixelated face** (canvas texture, chunky pixels) showing expressions; a body below/behind it; **two large arms** that extend/telescope to reach anywhere. Faces: waiting `:)` happy · attacking `>:(` angry · when hit `:'(` pained · tired `:|` · on death `:0` surprised.

During waves it hovers beyond the arena rim dropping enemies. After wave 5 it smashes the floor (see flow), then fights directly — **bullet hell**. The player **cannot damage the AGI while it attacks**; after every **3 attack patterns** it gets tired (`:|`), lowers its hands onto the arena for `BOSS_TIRED_TIME` — hands + monitor are vulnerable then. Then it raises its hands and resumes. Boss HP `BOSS_HP` shown in a top bar.

**Attack patterns** (telegraph everything on the floor in red; all beams/projectiles blocked by nothing during boss phase — obstacles are gone):

1. **Rocket Barrage** — many rockets up, carpet-bomb the arena; red circles show landing spots (`ROCKET_*`).
2. **Death Beam** — giant sweeping laser with a red floor-line indicator; **instantly kills** if it hits. Fires **twice per pattern**: each sweep covers a **third of the arena** anchored near the player, then the cannon recharges (~1.2s) and re-anchors for a second third-arena sweep. Long wind-up before each firing (`DEATHBEAM_TELEGRAPH` = 2.6s).
3. **Laser Bullets** — arms morph into miniguns, spin up for `MINIGUN_SPINUP` = 5s with a floor aim marker tracking the player's position, then hose fast-but-dodgeable bolts (`BOSS_BOLT_SPEED`) — dodge by strafing/running.
4. **Punch** — both hands punch down (red circle telegraphs, `PUNCH_DAMAGE`), then the hands **stay on the arena** for `PUNCH_LINGER` letting the player deal a little damage.
5. **Laser Beam Barrage** — stripes of parallel lasers across the arena floor (red stripe telegraphs first); 3 barrages, alternating side/angle so safe lanes shift.

Lasers aimed at the player travel slow enough to dodge. Telegraph shapes use `world.addTelegraph` (circle/rect), rendered by Vfx, damage resolved centrally by the Hazards system at `tHit`.

## HUD (shadcn/ui, DOM overlay)

Crosshair (+ bat charge ring, flashes at max), HP bar, ammo `8/40`, molotov count, weapon selector 1/2/3, wave banner + enemies-remaining, buff select modal (3 cards), boss health bar, giant "JUMP! n" countdown during smash, dodge cooldown pip, damage vignette, death screen (retry), victory screen.
