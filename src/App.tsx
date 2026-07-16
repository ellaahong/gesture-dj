import { useRef, useState } from 'react'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { audioEngine, type Deck } from './lib/audioEngine'

// Palm-center landmarks: wrist (0) + the four knuckles (5, 9, 13, 17).
const PALM_LANDMARKS = [0, 5, 9, 13, 17]
// Exponential moving average factor: how much the new raw reading moves
// the smoothed value each frame. Lower = smoother but more laggy,
// higher = more responsive but jitterier.
const SMOOTHING_ALPHA = 0.25

// MediaPipe's own defaults are already 0.5 for all three - these were never
// set to 0.65 anywhere in this file. Named here so they're visible and easy
// to tune while testing whether looser thresholds reduce dropout leaps.
const MIN_HAND_DETECTION_CONFIDENCE = 0.5
const MIN_HAND_PRESENCE_CONFIDENCE = 0.5
const MIN_TRACKING_CONFIDENCE = 0.5

// Palm X (mirrored, 0 = left edge of frame, 1 = right edge) at or beyond
// these bounds is treated as fully committed to one deck. Linear in between.
// Keeps a resting/relaxed hand position near either edge from needing to be
// pixel-perfect to hit full volume on one side.
const CROSSFADER_DEAD_ZONE_LOW = 0.35
const CROSSFADER_DEAD_ZONE_HIGH = 0.65

function mapPalmXToCrossfader(mirroredX: number): number {
  if (mirroredX <= CROSSFADER_DEAD_ZONE_LOW) return 0
  if (mirroredX >= CROSSFADER_DEAD_ZONE_HIGH) return 1
  return (
    (mirroredX - CROSSFADER_DEAD_ZONE_LOW) /
    (CROSSFADER_DEAD_ZONE_HIGH - CROSSFADER_DEAD_ZONE_LOW)
  )
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recognizerRef = useRef<GestureRecognizer | null>(null)
  const smoothedXRef = useRef<number | null>(null)
  const startedRef = useRef(false)
  // The rAF loop below is a long-lived closure, so it reads alpha from this
  // ref (not the state) to always see the latest slider value each frame.
  const alphaRef = useRef(SMOOTHING_ALPHA)
  // Tracks the previous frame's detection state so we can count *transitions*
  // into dropout (hand was there, now it's gone) rather than counting every
  // frame a dropout continues.
  const wasHandDetectedRef = useRef(false)
  const dropoutCountRef = useRef(0)

  const [started, setStarted] = useState(false)
  const [rawX, setRawX] = useState<number | null>(null)
  const [smoothedX, setSmoothedX] = useState<number | null>(null)
  const [gestureMapped, setGestureMapped] = useState<number | null>(null)
  const [alpha, setAlpha] = useState(SMOOTHING_ALPHA)
  const [handDetected, setHandDetected] = useState(false)
  const [dropoutCount, setDropoutCount] = useState(0)
  const [confidence, setConfidence] = useState<number | null>(null)

  const [playingA, setPlayingA] = useState(false)
  const [playingB, setPlayingB] = useState(false)
  const [volumeA, setVolumeA] = useState(1)
  const [volumeB, setVolumeB] = useState(1)
  const [crossfader, setCrossfaderState] = useState(0.5)

  function handleToggle(deck: Deck) {
    const playing = audioEngine.toggle(deck)
    if (deck === 'a') setPlayingA(playing)
    else setPlayingB(playing)
  }

  function handleVolume(deck: Deck, value: number) {
    audioEngine.setVolume(deck, value)
    if (deck === 'a') setVolumeA(value)
    else setVolumeB(value)
  }

  function handleCrossfader(value: number) {
    audioEngine.setCrossfader(value)
    setCrossfaderState(value)
  }

  async function handleStart() {
    if (startedRef.current) return
    startedRef.current = true
    setStarted(true)

    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    const video = videoRef.current!
    video.srcObject = stream
    await video.play()

    const canvas = canvasRef.current!
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    )
    recognizerRef.current = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: '/models/gesture_recognizer.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: MIN_HAND_DETECTION_CONFIDENCE,
      minHandPresenceConfidence: MIN_HAND_PRESENCE_CONFIDENCE,
      minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
    })

    const ctx = canvas.getContext('2d')!

    const loop = () => {
      const recognizer = recognizerRef.current
      if (recognizer && video.readyState >= 2) {
        const result = recognizer.recognizeForVideo(video, performance.now())
        const landmarks = result.landmarks[0]
        const detected = !!landmarks

        // Count each detected -> not-detected transition as one dropout.
        if (wasHandDetectedRef.current && !detected) {
          dropoutCountRef.current += 1
          setDropoutCount(dropoutCountRef.current)
        }
        wasHandDetectedRef.current = detected
        setHandDetected(detected)

        ctx.clearRect(0, 0, canvas.width, canvas.height)

        if (landmarks) {
          // Canvas is CSS-mirrored to match the video, so draw with the raw
          // (unmirrored) landmark coordinates - the mirroring is handled
          // once, visually, not by flipping numbers here.
          ctx.fillStyle = 'red'
          for (const point of landmarks) {
            ctx.beginPath()
            ctx.arc(point.x * canvas.width, point.y * canvas.height, 4, 0, Math.PI * 2)
            ctx.fill()
          }

          const palmRawX =
            PALM_LANDMARKS.reduce((sum, i) => sum + landmarks[i].x, 0) /
            PALM_LANDMARKS.length
          const palmRawY =
            PALM_LANDMARKS.reduce((sum, i) => sum + landmarks[i].y, 0) /
            PALM_LANDMARKS.length

          ctx.fillStyle = 'lime'
          ctx.beginPath()
          ctx.arc(palmRawX * canvas.width, palmRawY * canvas.height, 14, 0, Math.PI * 2)
          ctx.fill()

          // Mirrored so x=0 is the user's left in the mirrored video, matching
          // what they see on screen, not the raw camera sensor's left edge.
          const mirroredX = 1 - palmRawX

          const prevSmoothed = smoothedXRef.current
          const smoothed =
            prevSmoothed === null
              ? mirroredX
              : prevSmoothed + alphaRef.current * (mirroredX - prevSmoothed)
          smoothedXRef.current = smoothed

          const mapped = mapPalmXToCrossfader(smoothed)
          handleCrossfader(mapped)

          setRawX(mirroredX)
          setSmoothedX(smoothed)
          setGestureMapped(mapped)
          setConfidence(result.handedness[0]?.[0]?.score ?? null)
        } else {
          // No hand this frame: deliberately don't touch rawX/smoothedX,
          // smoothedXRef, or the crossfader - they hold their last known
          // values, so the crossfader freezes instead of snapping when
          // tracking resumes. Confidence has no meaning with no detection,
          // so that one does reset.
          setConfidence(null)
        }
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }

  return (
    <div>
      <button onClick={handleStart} disabled={started}>
        START
      </button>

      <div style={{ position: 'relative', display: 'inline-block' }}>
        <video ref={videoRef} muted playsInline style={{ transform: 'scaleX(-1)' }} />
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transform: 'scaleX(-1)',
          }}
        />
      </div>

      <div>
        <label>
          smoothing alpha:
          <input
            type="range"
            min={0.05}
            max={0.5}
            step={0.01}
            value={alpha}
            onChange={(e) => {
              const value = Number(e.target.value)
              setAlpha(value)
              alphaRef.current = value
            }}
          />
        </label>
        {' ' + alpha.toFixed(2)}
      </div>

      <pre>
        {'hand: ' +
          (handDetected ? 'DETECTED' : 'LOST') +
          '    dropouts since start: ' +
          dropoutCount +
          '    confidence: ' +
          (confidence?.toFixed(4) ?? '-') +
          '\n'}
        {'raw X: ' +
          (rawX?.toFixed(4) ?? '-') +
          '    smoothed X: ' +
          (smoothedX?.toFixed(4) ?? '-') +
          '\n'}
        {'gesture-mapped crossfader: ' + (gestureMapped?.toFixed(4) ?? '-')}
      </pre>

      <hr />

      <div>
        <button onClick={() => handleToggle('a')}>
          Deck A: {playingA ? 'PAUSE' : 'PLAY'}
        </button>
        <label>
          {' vol A: '}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeA}
            onChange={(e) => handleVolume('a', Number(e.target.value))}
          />
        </label>
      </div>

      <div>
        <button onClick={() => handleToggle('b')}>
          Deck B: {playingB ? 'PAUSE' : 'PLAY'}
        </button>
        <label>
          {' vol B: '}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeB}
            onChange={(e) => handleVolume('b', Number(e.target.value))}
          />
        </label>
      </div>

      <div>
        <label>
          crossfader (0 = A, 1 = B):
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={crossfader}
            onChange={(e) => handleCrossfader(Number(e.target.value))}
          />
        </label>
      </div>

      <pre>
        {'deck A: ' +
          (playingA ? 'PLAYING' : 'PAUSED') +
          '    volume A: ' +
          volumeA.toFixed(4) +
          '\n'}
        {'deck B: ' +
          (playingB ? 'PLAYING' : 'PAUSED') +
          '    volume B: ' +
          volumeB.toFixed(4) +
          '\n'}
        {'crossfader: ' +
          crossfader.toFixed(4) +
          '    gainA: ' +
          Math.cos((crossfader * Math.PI) / 2).toFixed(4) +
          '    gainB: ' +
          Math.sin((crossfader * Math.PI) / 2).toFixed(4)}
      </pre>
    </div>
  )
}

export default App
