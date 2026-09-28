/**
 * Whether the hero runs the three.js particle network or keeps the
 * video/poster. The particles are decoration; anyone who asked for less motion
 * or less data, is on a small screen, or has no WebGL gets the still.
 */
export interface HeroEnvironment {
  reducedMotion: boolean
  width: number
  saveData: boolean
  /** Lazy: probing creates a GL context, so it runs only if nothing else says no. */
  webgl: () => boolean
}

export const MIN_WIDTH = 768

export const shouldRunParticles = (env: HeroEnvironment) =>
  !env.reducedMotion && env.width >= MIN_WIDTH && !env.saveData && env.webgl()

export function hasWebGL(): boolean {
  // jsdom and very old browsers: no constructor, and no noisy getContext call.
  if (typeof window === 'undefined' || typeof window.WebGLRenderingContext === 'undefined') return false
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return !!gl
  } catch {
    return false
  }
}

/** Chrome/Android's Data Saver; absent everywhere else, which reads as "no". */
export const saveDataRequested = () =>
  !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
