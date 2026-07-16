import { useRef, useState } from 'react'
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import { audioEngine } from './lib/audioEngine'

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

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
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
  const [gain, setGainDisplay] = useState<number | null>(null)
  const [alpha, setAlpha] = useState(SMOOTHING_ALPHA)
  const [handDetected, setHandDetected] = useState(false)
  const [dropoutCount, setDropoutCount] = useState(0)
  const [confidence, setConfidence] = useState<number | null>(null)

  async function handleStart() {
    if (startedRef.current) return
    startedRef.current = true
    setStarted(true)

    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    const video = videoRef.current!
    video.srcObject = stream
    await video.play()

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

    await audioEngine.play('/audio/deck-a.mp3')

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

        if (landmarks) {
          const raw =
            PALM_LANDMARKS.reduce((sum, i) => sum + landmarks[i].x, 0) /
            PALM_LANDMARKS.length

          const prevSmoothed = smoothedXRef.current
          const smoothed =
            prevSmoothed === null
              ? raw
              : prevSmoothed + alphaRef.current * (raw - prevSmoothed)
          smoothedXRef.current = smoothed

          audioEngine.setGain(smoothed)

          setRawX(raw)
          setSmoothedX(smoothed)
          setGainDisplay(smoothed)
          setConfidence(result.handedness[0]?.[0]?.score ?? null)
        } else {
          // No hand this frame: deliberately don't touch rawX/smoothedX/gain
          // or smoothedXRef - they hold their last known values, so the
          // gain freezes instead of snapping to 0 or jumping when tracking
          // resumes. Confidence has no meaning with no detection, so that
          // one does reset.
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

      <video ref={videoRef} muted playsInline style={{ transform: 'scaleX(-1)' }} />

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
        {'gain: ' + (gain?.toFixed(4) ?? '-')}
      </pre>
    </div>
  )
}

export default App
