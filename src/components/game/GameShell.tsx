'use client'
import dynamic from 'next/dynamic'
import { AudioSystem } from './AudioSystem'
import { Hud } from './Hud'

const GameCanvas = dynamic(() => import('./GameCanvas'), { ssr: false })

export function GameShell() {
  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <GameCanvas />
      <Hud />
      <AudioSystem />
    </div>
  )
}
