# Attack AGI

Fast-paced first-person 3D horde shooter with roguelike buff picks. Next.js 16 (App Router, `src/`), Tailwind v4, shadcn/ui, three.js + @react-three/fiber.

## Conventions

- **Package manager: pnpm.** Never npm/yarn.
- **UI: adhere to shadcn/ui conventions as much as possible.** All 61 components live in `src/components/ui/` (imported via `shadcn add --all`). Build HUD/menus from these primitives + the `cn()` helper + the CSS-variable theme tokens in `globals.css`. Do not hand-roll buttons/cards/dialogs that shadcn already provides.
- **R3F is an orchestration layer, not a ceiling.** Write real custom shaders (`ShaderMaterial`, `onBeforeCompile` chunk injection), procedural geometry, and imperative three.js freely inside R3F components. Never avoid a technique because "it's React".
- **Visual depth bible** (applies to terrain, architecture, characters, props, interactives):
  - Modeled relief wherever the silhouette should change (bevels, greebles, panel insets — not flat boxes).
  - Normal/bump/parallax detail elsewhere; displacement where it reads at gameplay camera distance.
  - Coherent roughness + albedo variation (use `src/game/gfx/textures.ts` generators for a unified material identity).
  - Forms must stay readable under reduced direct light: texture-authored shading, AO (n8ao pass), contact darkening. Lighting supports depth; it never *creates* it.
  - Textures detailed and pleasant at the intended camera distance (player eye height 1.7m, enemies at 2–40m, boss at ~60m).

## Architecture

- `src/game/` — non-visual core. `constants.ts` (all tuning), `types.ts`, `events.ts` (typed bus), `store.ts` (zustand, UI-reactive state only), `world.ts` (mutable per-frame registry: player, enemies, projectiles, telegraphs, hazards, obstacles + collision/damage APIs). **Never put per-frame data in zustand.**
- `src/game/gfx/` — shared procedural textures + material factories.
- `src/components/game/` — R3F modules, one system per file. Each runs its own `useFrame` with a fixed priority (see `constants.ts` `FRAME_PRIO`) so simulation order is deterministic: Director → Player → Weapons → Enemies → Boss → Projectiles/Hazards → render-sync.
- Systems communicate through `world` (mutable state + queues) and `events` (transient effects: VFX, audio). React state is for the HUD only.
- Full game spec: `docs/GAME_SPEC.md`. Tuning numbers live **only** in `src/game/constants.ts` — the spec doc references them by name.

## Commands

- `pnpm dev` — dev server. `pnpm build` — production build. `pnpm tsc --noEmit` — typecheck.
