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

export type GraphicsQuality = 'smooth' | 'pretty'

interface SettingsState {
  lookSensitivity: number // multiplier, 0.3 .. 2.5 (1 = default)
  bindings: Record<BindableAction, string>
  /** 'smooth' trades AO + render scale for frame rate; 'pretty' is the full pipeline */
  quality: GraphicsQuality
  setSensitivity: (v: number) => void
  /** Bind `code` to `action`. If the code is already bound elsewhere, the two actions swap. */
  setBinding: (action: BindableAction, code: string) => void
  setQuality: (q: GraphicsQuality) => void
  resetDefaults: () => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      lookSensitivity: 1,
      bindings: { ...DEFAULT_BINDINGS },
      quality: 'smooth',

      setSensitivity: (v) => set({ lookSensitivity: Math.min(2.5, Math.max(0.3, v)) }),

      setQuality: (q) => set({ quality: q }),

      setBinding: (action, code) => {
        const b = { ...get().bindings }
        const holder = (Object.keys(b) as BindableAction[]).find((a) => b[a] === code)
        if (holder && holder !== action) b[holder] = b[action] // swap to avoid dead actions
        b[action] = code
        set({ bindings: b })
      },

      resetDefaults: () => set({ lookSensitivity: 1, bindings: { ...DEFAULT_BINDINGS }, quality: 'smooth' }),
    }),
    { name: 'attackagi-settings' },
  ),
)

/** Convenience: is this KeyboardEvent.code bound to the action right now? */
export function isBound(code: string, action: BindableAction): boolean {
  return useSettings.getState().bindings[action] === code
}
