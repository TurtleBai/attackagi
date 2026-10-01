declare module 'n8ao' {
  import type { Pass } from 'postprocessing'
  import type * as THREE from 'three'
  export class N8AOPostPass extends Pass {
    constructor(scene: THREE.Scene, camera: THREE.Camera, width?: number, height?: number)
    configuration: {
      aoRadius: number
      intensity: number
      distanceFalloff: number
      gammaCorrection: boolean
      halfRes: boolean
      aoSamples: number
      denoiseSamples: number
      denoiseRadius: number
      color: THREE.Color
    }
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void
  }
}
