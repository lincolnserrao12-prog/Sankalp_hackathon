export type VisionDetection = { hazard: string; confidence: number }

export type VisionResult = {
  available: boolean
  mode?: string
  detections: VisionDetection[]
  noIssueDetected: boolean
  topConfidence?: number
  error?: string
}

const MODEL_URL = '/models/guardian-lens-classifier.onnx'
const IMAGE_SIZE = 224
const CONFIDENCE_THRESHOLD = 0.65

const MODEL_HAZARD_LABELS: string[] = [
  'broken_road_sign',
  'damaged_road',
  'illegal_parking',
  'garbage',
  'pothole',
  'vandalism',
]

const FIRESTORE_VALID_HAZARDS = new Set([
  'pothole',
  'manhole',
  'waterlogging',
  'streetlight',
  'garbage',
  'crack',
  'unsafe infrastructure',
])

type SessionHandle = {
  InferenceSession: any
  session: any
}

let sessionPromise: Promise<SessionHandle | null> | null = null

async function acquireSession(): Promise<SessionHandle | null> {
  if (sessionPromise != null) return sessionPromise
  sessionPromise = (async (): Promise<SessionHandle | null> => {
    try {
      const ort = await import('onnxruntime-web')
      const session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['webgl', 'wasm'],
      })
      return { InferenceSession: ort.InferenceSession, session }
    } catch (error) {
      return null
    }
  })()
  return sessionPromise
}

function preprocess(bitmap: ImageBitmap): Float32Array {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_SIZE
  canvas.height = IMAGE_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, IMAGE_SIZE, IMAGE_SIZE)
  const { data } = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE)
  const rgb = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  for (let i = 0; i < IMAGE_SIZE * IMAGE_SIZE; i++) {
    const src = i * 4
    const r = data[src] / 255
    const g = data[src + 1] / 255
    const b = data[src + 2] / 255
    rgb[i] = (r - mean[0]) / std[0]
    rgb[IMAGE_SIZE * IMAGE_SIZE + i] = (g - mean[1]) / std[1]
    rgb[2 * IMAGE_SIZE * IMAGE_SIZE + i] = (b - mean[2]) / std[2]
  }
  return rgb
}

function softmax(logits: Float32Array | number[]): number[] {
  const max = Math.max(...logits)
  const exps = Array.from(logits).map(v => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map(v => v / sum)
}

export async function classifyImage(file: File): Promise<VisionResult> {
  const handle = await acquireSession()
  if (!handle) {
    return {
      available: false,
      detections: [],
      noIssueDetected: true,
      error: 'onnx-session-unavailable',
    }
  }
  try {
    const bitmap = await createImageBitmap(file)
    const tensorData = preprocess(bitmap)
    bitmap.close()
    const input = new handle.InferenceSession.Tensor('float32', tensorData, [
      1,
      3,
      IMAGE_SIZE,
      IMAGE_SIZE,
    ])
    const outputs = await handle.session.run({ image: input })
    const outputTensor = outputs.logits || outputs.output0 || outputs[Object.keys(outputs)[0]]
    const probabilities = softmax(outputTensor.data as Float32Array)
    const detections: VisionDetection[] = []
    const labels = probabilities.length === MODEL_HAZARD_LABELS.length
      ? MODEL_HAZARD_LABELS
      : MODEL_HAZARD_LABELS.slice(0, probabilities.length)
    for (let i = 0; i < probabilities.length && i < labels.length; i++) {
      if (probabilities[i] >= CONFIDENCE_THRESHOLD) {
        detections.push({ hazard: labels[i], confidence: Number(probabilities[i].toFixed(4)) })
      }
    }
    const topIndex = probabilities.indexOf(Math.max(...probabilities))
    const topConfidence = Number(probabilities[topIndex].toFixed(4))
    return {
      available: true,
      mode: 'onnx-efficientnet_b0',
      detections,
      noIssueDetected: detections.length === 0,
      topConfidence,
    }
  } catch (error) {
    return {
      available: false,
      detections: [],
      noIssueDetected: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function pickFirestoreSafeHazard(
  vision: VisionResult,
  fallbackHazard: string,
): string {
  if (!vision.available || vision.detections.length === 0) return fallbackHazard
  const best = vision.detections.reduce((a, b) => (a.confidence > b.confidence ? a : b))
  return FIRESTORE_VALID_HAZARDS.has(best.hazard) ? best.hazard : fallbackHazard
}

export function visionSeverityBoost(vision: VisionResult, fallbackSeverity: number): number {
  if (!vision.available || vision.detections.length === 0) return fallbackSeverity
  const best = vision.detections.reduce((a, b) => (a.confidence > b.confidence ? a : b))
  if (best.confidence >= CONFIDENCE_THRESHOLD) return Math.max(fallbackSeverity, 4)
  return fallbackSeverity
}
