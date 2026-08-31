'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Player-adjustable settings (pause menu): mouse sensitivity + key bindings.
// Persisted to localStorage. Bindings store KeyboardEvent.code values.

export type BindableAction =
  | 'forward' | 'back' | 'left' | 'right'
  | 'jump' | 'dodge' | 'reload'
  | 'weapon1' | 'weapon2' | 'weapon3'

export const ACTION_LABELS: Record<BindableAction, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  jump: 'Jump',
  dodge: 'Dodge',
  reload: 'Reload',
  weapon1: 'Pistol',
  weapon2: 'Bat',
  weapon3: 'Molotov',
}

export const DEFAULT_BINDINGS: Record<BindableAction, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  dodge: 'ShiftLeft',
  reload: 'KeyR',
  weapon1: 'Digit1',
  weapon2: 'Digit2',
  weapon3: 'Digit3',
}

/** Human-readable label for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT', AltRight: 'R-ALT',
    Tab: 'TAB', CapsLock: 'CAPS', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: 'ENTER', Backspace: 'BKSP',
  }
  return map[code] ?? code.toUpperCase()
}

export type GraphicsQuality = 'potato' | 'smooth' | 'pretty' | 'auto'

/** A concrete tier — what 'auto' resolves to. Mirrors quality.ts ResolvedTier. */
export type ConcreteQuality = Exclude<GraphicsQuality, 'auto'>

interface SettingsState {
  lookSensitivity: number // multiplier, 0.3 .. 2.5 (1 = default)
  bindings: Record<BindableAction, string>
  /**
   * The USER'S choice (persisted). 'auto' delegates the concrete tier to the
   * adaptive controller; explicit tiers pin it.
   */
  quality: GraphicsQuality
  /**
   * TRANSIENT (never persisted, see partialize): the concrete tier the adaptive
   * controller resolved 'auto' to. quality.ts resolvedTier() reads it via
   * getState() with a 'smooth'/'potato' fallback — keep the field name stable.
   */
  resolvedQuality: ConcreteQuality | null
  /**
   * TRANSIENT: adaptive render-scale override (an exact dpr within the current
   * tier's dpr band). null = use the tier's default band. Driven through React
   * state so R3F Canvas re-configures never stomp it.
   */
  adaptiveDpr: number | null
  setSensitivity: (v: number) => void
  /** Bind `code` to `action`. If the code is already bound elsewhere, the two actions swap. */
  setBinding: (action: BindableAction, code: string) => void
  setQuality: (q: GraphicsQuality) => void
  setResolvedQuality: (q: ConcreteQuality | null) => void
  setAdaptiveDpr: (v: number | null) => void
  resetDefaults: () => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      lookSensitivity: 1,
      bindings: { ...DEFAULT_BINDINGS },
      quality: 'auto',
      resolvedQuality: null,
      adaptiveDpr: null,

      setSensitivity: (v) => set({ lookSensitivity: Math.min(2.5, Math.max(0.3, v)) }),

      // manual tier picks drop any adaptive render-scale override (band differs)
      setQuality: (q) => set({ quality: q, adaptiveDpr: null }),

      setResolvedQuality: (q) => set({ resolvedQuality: q }),

      setAdaptiveDpr: (v) => set({ adaptiveDpr: v }),

      setBinding: (action, code) => {
        const b = { ...get().bindings }
        const holder = (Object.keys(b) as BindableAction[]).find((a) => b[a] === code)
        if (holder && holder !== action) b[holder] = b[action] // swap to avoid dead actions
        b[action] = code
        set({ bindings: b })
      },

      resetDefaults: () =>
        set({ lookSensitivity: 1, bindings: { ...DEFAULT_BINDINGS }, quality: 'auto', adaptiveDpr: null }),
    }),
    {
      name: 'attackagi-settings',
      version: 1,
      // persist only the user's own choices — resolvedQuality/adaptiveDpr are
      // the adaptive controller's transient outputs
      partialize: (s) => ({
        lookSensitivity: s.lookSensitivity,
        bindings: s.bindings,
        quality: s.quality,
      }),
      migrate: (persisted, version) => {
        const p = persisted as { lookSensitivity: number; bindings: Record<BindableAction, string>; quality: GraphicsQuality }
        // v0 persisted 'smooth' as its default — almost always "never chose",
        // so move those onto adaptive AUTO (which starts at smooth anyway).
        // Deliberate v0 'pretty' picks are kept.
        if (version === 0 && (p.quality as string) === 'smooth') p.quality = 'auto'
        return p
      },
    },
  ),
)

/** Convenience: is this KeyboardEvent.code bound to the action right now? */
export function isBound(code: string, action: BindableAction): boolean {
  return useSettings.getState().bindings[action] === code
}
