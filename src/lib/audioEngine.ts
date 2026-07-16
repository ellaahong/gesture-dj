/**
 * Module-level singleton. `createMediaElementSource` can only ever be called
 * once per <audio> element, and React StrictMode mounts effects/components
 * twice in dev — if this lived inside a component, the second mount would
 * throw. Living here, outside React entirely, means it only ever runs once
 * no matter how React treats the component tree.
 */

let audioContext: AudioContext | null = null
let audioElement: HTMLAudioElement | null = null
let gainNode: GainNode | null = null

function init(src: string) {
  if (audioContext) return // already initialized, do nothing

  audioContext = new AudioContext()
  audioElement = new Audio(src)
  audioElement.loop = true

  const sourceNode = audioContext.createMediaElementSource(audioElement)
  gainNode = audioContext.createGain()
  gainNode.gain.value = 0

  sourceNode.connect(gainNode).connect(audioContext.destination)
}

async function play(src: string) {
  init(src)
  if (audioContext!.state === 'suspended') {
    await audioContext!.resume()
  }
  await audioElement!.play()
}

function setGain(value: number) {
  if (!gainNode) return
  gainNode.gain.value = value
}

export const audioEngine = { play, setGain }
