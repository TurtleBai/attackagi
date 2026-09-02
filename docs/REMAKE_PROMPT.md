# Prompt: Build "Attack AGI" from scratch

Copy everything below the line into a fresh Claude Code session in an empty directory.

---

Build me a complete, polished browser game called **ATTACK AGI** — a fast-paced first-person 3D horde shooter with roguelike buff picks, ending in a bullet-hell boss fight against a giant AGI. Work autonomously: scaffold, implement, verify in the browser yourself, and commit in green batches as you go.

## Stack & setup

- Next.js (App Router, `src/` dir) + Tailwind + **shadcn/ui** — scaffold with the real CLIs, package manager **pnpm** (never npm/yarn). Import the full shadcn component set and build ALL menus/HUD from those primitives + the CSS-variable theme tokens. Do not hand-roll buttons, cards, dialogs, sliders, or collapsibles that shadcn provides.
- three.js + @react-three/fiber + drei + @react-three/postprocessing (bloom, n8ao ambient occlusion) + zustand.
- R3F is an **orchestration layer, not a ceiling**: write real custom `ShaderMaterial`s, `onBeforeCompile` chunk injection, procedural geometry, and imperative three.js freely inside R3F components. Never avoid a technique because "it's React".

## Architecture (non-negotiable)

- A mutable **`world` singleton** holds all per-frame state: player, enemies (Map), projectiles, telegraphs, hazards, obstacles, plus collision/damage/raycast APIs. **Never put per-frame data in React state or zustand.**
- A **zustand store** holds only UI-reactive state (phase, hp, ammo, wave, buffs, warnings). A typed **event bus** carries transient effects (VFX, audio).
- One R3F system per file, each with its own `useFrame` at a **fixed priority** so simulation order is deterministic: Director → Player → Weapons → Enemies → Boss → Projectiles/Hazards → VFX/render-sync.
- **Every tuning number lives in one `constants.ts`** — systems read buffable values via computed `stats` in the store, never raw constants.
- Restarting a run bumps a `runId`; the Director is the sole caller of `world.reset()`.

## Player

100 HP, eye height 1.7 m, capsule r 0.45, walk **9.5 m/s**, jump velocity 9.5 (gravity 26), pointer-lock mouse look. **Dodge** (Shift): 26 m/s dash for 0.22 s with 0.38 s of i-frames, 2.0 s cooldown, HUD pip. Arena: a 42 m-radius rooftop disc (helipad markings, crates/barriers as obstacles with collision).

## Weapons (slots 1/2/3, scroll or keys)

1. **Revolver** ("R6 Judge"): 20 dmg, 6-round cylinder, full-auto while held at 0.26 s interval, 1.5 s swing-out speedloader reload, 90 reserve (crates refill), 120 m hitscan. **Red-dot sight** on the barrel; RMB = ADS (FOV zoom + centered model). Visible viewmodel with recoil.
2. **Baseball bat**: 30 dmg, 3.0 m range, ~126° arc, 0.32 s swing; hold to charge 2.5 s → 3× damage (crosshair ring flashes at max). Hits at most the **3 nearest** targets per swing. Can smack the boss's lingering hands.
3. **Molotov**: RMB shows arc trajectory + landing disc, LMB throws (22 m/s ballistic). 45 impact dmg, 4.5 m blast, leaves a fire puddle: 22 dps for 6 s — **friendly fire: your own puddle burns you too**. Start 2, capacity 4, can't aim when empty. Ammo crates (max 3 alive, every 14 s) give +2 and refill revolver reserve.

**Headshots**: every enemy carries a small **glowing head display** (an AI-lab-logo screen); headshots require the ray to pass through a tight per-kind sphere on that display — not merely the top of the body cylinder — for 2× damage + red hitmarker. Body raycasts are **capped** cylinders (test the end caps — shots from directly under a flying enemy must hit).

## Enemies (robots, instanced crowds)

| kind | hp | behavior |
|---|---|---|
| melee | 36 | chases 5.2 m/s, 10 dmg swing at 2.2 m |
| ranger | 22 | holds range, slow dodgeable bolts (15 m/s, 7 dmg) every 2.4 s; visibly holds its gun |
| tank | 36 | slow 3.6 m/s, frontal shield (~112° arc **blocks bullets**), 1.5 s telegraphed bash charge: 18 m/s, 12 m, 22 dmg |
| sniper | 22 | live green laser sight while tracking, 1.4 s aim-lock telegraph line, 26 dmg beam every 5 s |
| drone | 22 | purple quad-rotor bomber flying at 8 m. **Dive-bombs**: rests/loiters 12–18 m out at 6 m/s, then attack-runs straight at you at **17 m/s**, drops a bomb on your position (red circle telegraph, 2.8 m, 1.5 s fall = telegraph time, 22 dmg), peels away, waits ~10 s (desynced). Headshot target: a little probe head on a chin boom at the **nose** (hit sphere tracks its dive tilt). Death = rotors stop, tumble-fall |

Concurrent cap 22 on the field; the AGI's hands physically **drop enemies in** batches of 5 every 4 s. `enemiesRemaining` must be **derived every frame** from alive + pending + in-flight + bag (never decrement-bookkeeping — it drifts and cascades). When ≤ 5 remain in a wave, stragglers get a glowing outline.

**Waves** [melee, ranger, tank, sniper, drone]: W1 [20,10,0,0,5] · W2 [20,10,5,0,10] · W3 [20,10,10,5,15] · W4 [20,10,20,10,15] · W5 [10,20,20,10,15].

## Buffs

After each wave: 3 random cards (shadcn Card modal, keys 1–3), pick 1, stack across the run. Pool of 13: +40% pistol dmg · +4 mag · +24 reserve · +30% fire rate · 30% faster reload · +50% bat dmg · bat charges 35% faster · +1 molotov cap & +30% fire dmg · +35% molotov radius · +12% move speed · dodge −0.6 s · +25 max HP & heal · heal 10% max HP each wave clear.

## The AGI (boss)

A giant robot (~60 m away beyond the rim) with a **CRT monitor head** showing pixel-emoticon faces that react to the fight: `:)` idle · `>:(` attacking · `:'(` hurt · `:|` tired · `:0` dying. Two enormous articulated hands. Behind it, big animated **eldritch tentacles with eyes** (custom shaders, SDF eyes) for creep factor. During waves it hovers dropping enemies.

**After wave 5 — floor smash**: whole ground glows red, giant "JUMP! n" **countdown ticks down over 4 s**; airborne at impact (or dodge i-frames) or you are **instantly killed**. The smash clears all obstacles, then the boss bar (1100 HP) appears.

**Bullet hell** — can't be damaged while attacking; after every 3 patterns it gets tired (`:|`), lowers hands + head onto the arena for 7 s — both are damageable then (bat works too). Patterns:
1. **Rocket barrage** — 26 rockets carpet-bomb (red circle telegraphs, r 3.4, 24 dmg).
2. **Death beam** — arm morphs into a cannon, charges, then sweeps a giant **instakill** laser across **one third of the arena** anchored at your position (red stripe telegraphs marching across, 2.6 s warning, 2.8 s sweep) — then recharges ~1.2 s and fires a **second** third-arena sweep re-anchored on you.
3. **Miniguns** — arms morph, 5 s spin-up with a floor marker chasing you (9.5 m/s), then 4 s of fast-but-outrunnable bolts (26 m/s, 8 dmg).
4. **Punch** — both hands slam (red telegraphs, 30 dmg), then **linger on the arena 3.2 s** as damageable weak points (up to 60 dmg each).
5. **Stripe barrage** — 3 volleys of 6 parallel beam walls (3.2 m wide, 4.6 m gaps, 1.5 s telegraph, 35 dmg) — stand in the gaps.

Boss death: `:0` face, staggered explosions, "AGI NEUTRALIZED" victory screen. Player death: retry restarts the whole run.

## UI / menus (all shadcn)

Title menu over the live 3D scene: glitch-text logo, **collapsible FIELD MANUAL** card (chevron minimizes it so the boss is visible), red ENGAGE button. HUD: crosshair + charge ring, HP bar, `6|90` ammo, weapon selector cards with icons (bottom-right), molotov count, wave banner + hostiles counter, boss bar, JUMP countdown, damage vignette, dodge pip, hitmarkers. Pause (ESC): **rebindable keys** (click-to-capture), mouse sensitivity slider, graphics quality (auto/potato/smooth/pretty) + brightness. Death/victory screens. Procedural WebAudio SFX (shots, hits, explosions, boss telegraphs) — no audio assets.

Hidden dev cheat listed in no menu: **K** mid-run wipes the field and skips straight to the smash → boss sequence.

## Visual & performance bar

- Visual depth everywhere: modeled relief (bevels, greebles, panel insets — no flat boxes), procedural textures with coherent roughness/albedo variation from a shared generator module, AO + contact darkening, forms readable under low light. Night-time rooftop mood, bloom, distant city lights.
- **Instanced rendering for all crowds** (one posed template rig per kind → per-part InstancedMesh), per-kind frustum culling, pose-rate LOD at distance, quality tiers (potato = no composer; auto tier adapts via frame-time with hysteresis), demand-frameloop when paused/hidden.
- **Full mobile support**: touch joystick + drag-look + fire/aim/jump/dodge buttons, responsive layout, coarse-pointer control legend.

## Hard-won guardrails (each of these cost a debugging session — obey them)

1. **Never call GLSL `pow(x, y)` with a base that can be ≤ 0** (Metal/ANGLE → NaN → bloom propagates it → whole screen goes black). Clamp with `max(x, 1e-5)` or multiply powers out.
2. Derive wave counts from ground truth per frame; never decrement counters (drift compounds through the spawn cap into wave-skip cascades).
3. Clamp `dt` to 0.05 in every system; gate all sim `useFrame`s on a shared `simRunning(phase)` check.
4. Player damage goes through one `world.damagePlayer` (respects i-frames, handles instakill); enemy DoT ticks flagged silent so per-frame events don't flood VFX/audio pools.
5. Telegraph payloads declare `dodgeableByJump` / `instakill`; resolution checks the player's airborne state once, centrally.

Typecheck (`tsc --noEmit`) and verify in the browser after each system; keep a `docs/GAME_SPEC.md` in sync as you build.
