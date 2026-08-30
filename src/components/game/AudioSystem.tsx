'use client'
// AudioSystem — fully procedural WebAudio SFX + ambient bed (no audio files).
// Renders null. The AudioContext is created lazily on the first user gesture;
// every handler drops silently until then. One-shots are stateless, so nothing
// needs a hard reset on runId.

import { useEffect } from 'react'
import { events } from '@/game/events'
import { useGame } from '@/game/store'
import { audioEngine } from './AudioSystem.engine'

export function AudioSystem() {
  useEffect(() => {
    audioEngine.setMuted(false)

    // Lazy context creation on first gesture (also resumes a suspended context).
    const onGesture = () => {
      audioEngine.init()
      if (audioEngine.ready()) {
        window.removeEventListener('pointerdown', onGesture)
        window.removeEventListener('keydown', onGesture)
      }
    }
    window.addEventListener('pointerdown', onGesture)
    window.addEventListener('keydown', onGesture)

    const subs: Array<() => void> = [
      events.on('shot', () => audioEngine.shot()),
      events.on('reloadStart', (p) => audioEngine.reload(p.duration)),
      events.on('batSwing', (p) => audioEngine.batSwing(p.charged)),
      events.on('batHit', (p) => audioEngine.batHit(p.charged)),
      events.on('molotovThrow', () => audioEngine.molotovThrow()),
      events.on('fireIgnite', (p) => audioEngine.fireIgnite(p.pos)),
      events.on('explosion', (p) => audioEngine.explosion(p.pos, p.radius, p.kind)),
      events.on('enemyHit', (p) => audioEngine.enemyHit(p.pos)),
      events.on('enemyDeath', (p) => audioEngine.enemyDeath(p.pos)),
      events.on('shieldBlock', (p) => audioEngine.shieldBlock(p.pos)),
      events.on('playerHit', () => audioEngine.playerHit()),
      events.on('playerDodge', () => audioEngine.playerDodge()),
      events.on('playerJump', () => audioEngine.playerJump()),
      events.on('beamFire', (p) => audioEngine.beamFire(p.kind)),
      events.on('minigunSpinup', () => audioEngine.minigunSpinup()),
      events.on('bossHit', (p) => audioEngine.bossHit(p.pos)),
      events.on('smashImpact', () => audioEngine.smashImpact()),
      events.on('bossDead', () => audioEngine.bossDead()),
      events.on('waveStart', () => audioEngine.waveStart()),
      events.on('waveClear', () => audioEngine.waveClear()),
      events.on('pickup', (p) => audioEngine.pickup(p.pos)),
      events.on('cratePop', (p) => audioEngine.cratePop(p.pos)),
      events.on('weaponSwitch', () => audioEngine.weaponSwitch()),
      events.on('uiClick', () => audioEngine.uiClick()),
    ]

    // Bat-charge shimmer follows store.batCharge (rising pair, ready ding at 1).
    const unsubStore = useGame.subscribe((s, prev) => {
      if (s.batCharge !== prev.batCharge) audioEngine.setBatCharge(s.batCharge)
    })

    return () => {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
      for (const u of subs) u()
      unsubStore()
      audioEngine.setBatCharge(0)
      // keep the context alive for remounts (strict mode); just go quiet
      audioEngine.setMuted(true)
    }
  }, [])

  return null
}
