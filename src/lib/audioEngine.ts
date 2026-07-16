/**
 * Module-level singleton. `createMediaElementSource` can only ever be called
 * once per <audio> element, and React StrictMode mounts effects/components
 * twice in dev — if this lived inside a component, the second mount would
 * throw. Living here, outside React entirely, means it only ever runs once
 * no matter how React treats the component tree.
 *
 * Signal chain per deck: audio element -> volume GainNode -> crossfader
 * GainNode -> destination.
 */

export type Deck = 'a' | 'b'

const SOURCES: Record<Deck, string> = {
  a: '/audio/deck-a.mp3',
  b: '/audio/deck-b.mp3',
}

// setTargetAtTime time constant, in seconds: roughly how long the ramp takes
// to close ~63% of the gap to the target value. Small enough to feel
// instant to a slider drag, large enough to avoid the click/zipper noise
// that comes from snapping gain.value directly.
const RAMP_TIME_CONSTANT = 0.03

let audioContext: AudioContext | null = null
let elements: Record<Deck, HTMLAudioElement> | null = null
let volumeGains: Record<Deck, GainNode> | null = null
let crossfaderGains: Record<Deck, GainNode> | null = null

function initialize() {
  if (audioContext) {
    void audioContext.resume()
    return
  }

  audioContext = new AudioContext()

  const a = new Audio(SOURCES.a)
  const b = new Audio(SOURCES.b)
  a.loop = true
  b.loop = true
  a.preload = 'auto'
  b.preload = 'auto'
  elements = { a, b }

  volumeGains = { a: audioContext.createGain(), b: audioContext.createGain() }
  crossfaderGains = { a: audioContext.createGain(), b: audioContext.createGain() }

  for (const deck of ['a', 'b'] as const) {
    const source = audioContext.createMediaElementSource(elements[deck])
    source.connect(volumeGains[deck])
    volumeGains[deck].connect(crossfaderGains[deck])
    crossfaderGains[deck].connect(audioContext.destination)
  }

  // Seed the crossfader gains to match a centered slider (0.5) so the audio
  // graph's actual state matches what the UI defaults to before the user
  // ever touches the crossfader control.
  setCrossfader(0.5)

  void audioContext.resume()
}

function toggle(deck: Deck): boolean {
  initialize()
  const el = elements![deck]
  if (el.paused) {
    void el.play()
  } else {
    el.pause()
  }
  return !el.paused
}

function setVolume(deck: Deck, value: number) {
  initialize()
  const clamped = Math.min(1, Math.max(0, value))
  volumeGains![deck].gain.setTargetAtTime(
    clamped,
    audioContext!.currentTime,
    RAMP_TIME_CONSTANT,
  )
}

function setCrossfader(value: number) {
  initialize()
  const clamped = Math.min(1, Math.max(0, value))
  const gainA = Math.cos((clamped * Math.PI) / 2)
  const gainB = Math.sin((clamped * Math.PI) / 2)
  const now = audioContext!.currentTime
  crossfaderGains!.a.gain.setTargetAtTime(gainA, now, RAMP_TIME_CONSTANT)
  crossfaderGains!.b.gain.setTargetAtTime(gainB, now, RAMP_TIME_CONSTANT)
}

export const audioEngine = { initialize, toggle, setVolume, setCrossfader }
