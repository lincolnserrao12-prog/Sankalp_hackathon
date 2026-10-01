export type VisionDetection = { hazard: string; confidence: number }

export type VisionResult = {
  available: boolean
  mode?: string
  detections: VisionDetection[]
  noIssueDetected: boolean
  topConfidence?: number
  error?: string
  gpsLat?: number
  gpsLng?: number
  gpsSource?: 'exif' | undefined
}

const MODEL_RELATIVE_URL = '/models/guardian-lens-classifier.onnx'
const MODEL_URL = new URL(MODEL_RELATIVE_URL, import.meta.url).href
const MODEL_EXTERNAL_DATA_URL = new URL(MODEL_RELATIVE_URL + '.data', import.meta.url).href
const EXTERNAL_DATA_PATH_INSIDE_ONNX = 'guardian-lens-classifier.onnx.data'
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
  Tensor: any
  session: any
  providerUsed: string
}

let sessionPromise: Promise<SessionHandle | null> | null = null
let cachedInitFailure: string | null = null

function hasSharedArrayBuffer(): boolean {
  try { return typeof SharedArrayBuffer !== 'undefined' } catch { return false }
}
function hasCrossOriginIsolation(): boolean {
  try {
    if (typeof crossOriginIsolated !== 'undefined') return Boolean(crossOriginIsolated)
    return false
  } catch { return false }
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const tag = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    const msg = error.message || String(error)
    return `${tag}${msg}`
  }
  try { return String(error) } catch { return 'unknown error' }
}

function configureOrtEnv(ort: any): void {
  if (!ort || !ort.env) return
  ort.env.debug = false
  ort.env.logLevel = 'warning'
  try {
    if (!hasCrossOriginIsolation() || !hasSharedArrayBuffer()) {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.simd = true
    } else {
      ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator as any).hardwareConcurrency || 2))
      ort.env.wasm.simd = true
    }
  } catch {}
  try {
    if (ort.env.wasm != null && typeof ort.env.wasm === 'object') {
      Object.defineProperty(ort.env.wasm, 'overwriteFlag', { value: true, configurable: true, writable: true })
    }
  } catch {}
}

function buildProviderPermutations(): string[][] {
  const list: string[][] = []
  const isHTTPS = typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  if (isHTTPS) list.push(['wasm', 'webgl'])
  else list.push(['wasm'])
  list.push(['wasm'])
  list.push(['webgl'])
  try {
    if (typeof (navigator as any).gpu !== 'undefined') list.push(['webgpu', 'wasm'])
  } catch {}
  const deduped: string[][] = []
  const seen = new Set<string>()
  for (const perm of list) {
    const key = perm.join('|')
    if (!seen.has(key)) { seen.add(key); deduped.push(perm) }
  }
  return deduped
}

async function fetchBytesOrDie(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${label} fetch failed ${response.status} ${response.statusText} (${url})`)
  }
  const ct = response.headers.get('content-type') || ''
  const size = response.headers.get('content-length')
  if (ct && ct.includes('text/html')) {
    const sample = await response.clone().text().then(t => t.slice(0, 120)).catch(() => '')
    throw new Error(`${label} fetch returned HTML (${ct}; ${sample || 'body truncated'}) from ${url}. Binary ONNX asset was not served; file is likely missing from frontend/public/models or dist/.`)
  }
  if (size != null && Number(size) < 1000) {
    throw new Error(`${label} fetch returned suspiciously small ${size} bytes from ${url}; expected the real ONNX binary or .onnx.data export.`)
  }
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

async function initSessionOnce(): Promise<SessionHandle | null> {
  if (sessionPromise != null) return sessionPromise
  sessionPromise = (async (): Promise<SessionHandle | null> => {
    let ort: any
    try {
      ort = await import('onnxruntime-web')
    } catch (err) {
      const summary = `Cannot load onnxruntime-web package: ${summarizeError(err)}`
      console.error('[GuardianLens/ONNX]', summary)
      cachedInitFailure = summary
      return null
    }
    try { configureOrtEnv(ort) } catch (_) { /* ignore env tuning failures */ }

    let modelBytes: Uint8Array | null = null
    let dataBytes: Uint8Array | null = null
    let fetchError: string | null = null
    try {
      const [onnxBuf, dataBuf] = await Promise.all([
        fetchBytesOrDie(MODEL_URL, 'guardian-lens-classifier.onnx'),
        fetchBytesOrDie(MODEL_EXTERNAL_DATA_URL, 'guardian-lens-classifier.onnx.data'),
      ])
      modelBytes = onnxBuf
      dataBytes = dataBuf
    } catch (err) {
      fetchError = summarizeError(err)
      console.warn('[GuardianLens/ONNX] Fetch-based load failed; falling back to URL-based session create.', fetchError)
    }

    const perms = buildProviderPermutations()
    const errorsByPerm: string[] = []

    if (modelBytes && dataBytes) {
      for (const perm of perms) {
        try {
          const session = await ort.InferenceSession.create(modelBytes, {
            executionProviders: perm,
            graphOptimizationLevel: 'all',
            externalData: [
              { path: EXTERNAL_DATA_PATH_INSIDE_ONNX, data: dataBytes },
            ],
          })
          const providerUsed = (session && typeof session.provider === 'string') ? session.provider : perm[0]
          console.info('[GuardianLens/ONNX] initialized via raw-bytes create. Model URL:', MODEL_URL, ' Provider used:', providerUsed)
          return { InferenceSession: ort.InferenceSession, Tensor: ort.Tensor || ort.InferenceSession?.Tensor, session, providerUsed }
        } catch (err) {
          errorsByPerm.push(`bytes(${perm.join(',')}): ${summarizeError(err)}`)
        }
      }
    }

    for (const perm of perms) {
      try {
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: perm,
          graphOptimizationLevel: 'all',
        })
        const providerUsed = (session && typeof session.provider === 'string') ? session.provider : perm[0]
        console.info('[GuardianLens/ONNX] initialized via URL-based create (fallback). Model URL:', MODEL_URL, ' Provider used:', providerUsed)
        return { InferenceSession: ort.InferenceSession, Tensor: ort.Tensor || ort.InferenceSession?.Tensor, session, providerUsed }
      } catch (err) {
        errorsByPerm.push(`url(${perm.join(',')}): ${summarizeError(err)}`)
      }
    }

    const fetchTail = fetchError ? ` Fetch summary: ${fetchError}.` : ''
    const summary = `ONNX model failed to initialize from ${MODEL_URL}. Attempts: ${errorsByPerm.join(' | ')}.${fetchTail}`
    console.error('[GuardianLens/ONNX]', summary)
    cachedInitFailure = summary
    return null
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
  const max = Math.max(...(logits as number[]))
  const exps = Array.from(logits).map(v => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map(v => v / sum)
}

export async function classifyImage(file: File): Promise<VisionResult> {
  const gps = await extractPhotoGps(file).catch(() => null)
  const handle = await initSessionOnce()
  if (!handle) {
    return {
      available: false,
      detections: [],
      noIssueDetected: false,
      error: cachedInitFailure || 'onnx-session-unavailable',
      ...(gps ? { gpsLat: gps.lat, gpsLng: gps.lng, gpsSource: 'exif' as const } : {}),
    }
  }
  try {
    if (!file || !(file instanceof File) || file.size === 0) throw new Error('Empty or missing image file.')
    const bitmap = await createImageBitmap(file)
    const tensorData = preprocess(bitmap)
    bitmap.close()
    const Tensor = handle.Tensor || handle.InferenceSession.Tensor
    const input = new Tensor('float32', tensorData, [1, 3, IMAGE_SIZE, IMAGE_SIZE])
    const outputs = await handle.session.run({ image: input })
    const keys = Object.keys(outputs)
    const outputTensor = outputs.logits || outputs.output0 || (keys.length ? outputs[keys[0]] : null)
    if (!outputTensor || !outputTensor.data) throw new Error(`ONNX run returned no logits tensor (keys: ${keys.join(',')}) from exported guardian-lens-classifier.onnx.`)
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
      mode: handle.providerUsed === 'wasm' ? 'onnx-efficientnet_b0/wasm' : handle.providerUsed === 'webgl' ? 'onnx-efficientnet_b0/webgl' : handle.providerUsed === 'webgpu' ? 'onnx-efficientnet_b0/webgpu' : `onnx-efficientnet_b0/${handle.providerUsed || 'ort'}`,
      detections,
      noIssueDetected: detections.length === 0,
      topConfidence,
      ...(gps ? { gpsLat: gps.lat, gpsLng: gps.lng, gpsSource: 'exif' as const } : {}),
    }
  } catch (error) {
    return {
      available: false,
      detections: [],
      noIssueDetected: false,
      error: summarizeError(error),
      ...(gps ? { gpsLat: gps.lat, gpsLng: gps.lng, gpsSource: 'exif' as const } : {}),
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

export function getLastInitFailure(): string | null { return cachedInitFailure }

type ExifGpsCoords = { lat: number; lng: number }

function readUint16(view: DataView, offset: number, little: boolean): number {
  return view.getUint16(offset, little)
}
function readUint32(view: DataView, offset: number, little: boolean): number {
  return view.getUint32(offset, little)
}
function readRational(view: DataView, offset: number, little: boolean): number {
  const num = readUint32(view, offset, little)
  const den = readUint32(view, offset + 4, little)
  if (den === 0) return NaN
  return num / den
}
function parseExifRational3(coords: [number, number, number], ref: string, posRef: string, negRef: string): number | null {
  if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1]) || !Number.isFinite(coords[2])) return null
  const dec = coords[0] + coords[1] / 60 + coords[2] / 3600
  if (ref === posRef) return dec
  if (ref === negRef) return -dec
  return null
}
export async function extractPhotoGps(file: File): Promise<ExifGpsCoords | null> {
  if (!file) return null
  const headBytes = Math.min(file.size, 1024 * 512)
  const headBuffer = await file.slice(0, headBytes).arrayBuffer()
  const view = new DataView(headBuffer)
  if (view.byteLength < 4 || readUint16(view, 0, false) !== 0xFFD8) return null
  let pos = 2
  while (pos + 3 < view.byteLength) {
    if (view.getUint8(pos) !== 0xFF) return null
    const marker = view.getUint8(pos + 1)
    if (marker === 0xD8 || marker === 0xD9) { pos += 2; continue }
    if (marker === 0xDA) break
    const segLen = readUint16(view, pos + 2, false)
    if (marker === 0xE1 && pos + 8 + segLen <= view.byteLength) {
      const headerStart = pos + 4
      const exifStr = String.fromCharCode(
        view.getUint8(headerStart),
        view.getUint8(headerStart + 1),
        view.getUint8(headerStart + 2),
        view.getUint8(headerStart + 3),
      )
      if (exifStr === 'Exif' && view.getUint8(headerStart + 4) === 0 && view.getUint8(headerStart + 5) === 0) {
        const tiffOffset = headerStart + 6
        const byteOrder = readUint16(view, tiffOffset, false)
        const little = byteOrder === 0x4949
        const big = byteOrder === 0x4D4D
        if (!little && !big) return null
        if (readUint16(view, tiffOffset + 2, little) !== 42) return null
        const ifd0Offset = readUint32(view, tiffOffset + 4, little)
        const ifd0Abs = tiffOffset + ifd0Offset
        if (ifd0Abs + 2 > view.byteLength) return null
        const gpsIfdEntryTag = 0x8825
        const gpsIfdPointer = (() => {
          const entries = readUint16(view, ifd0Abs, little)
          for (let i = 0; i < entries; i++) {
            const e = ifd0Abs + 2 + i * 12
            if (e + 12 > view.byteLength) return 0
            const tag = readUint16(view, e, little)
            if (tag === gpsIfdEntryTag) {
              const raw = readUint32(view, e + 8, little)
              return raw
            }
          }
          return 0
        })()
        if (!gpsIfdPointer) return null
        const gpsAbs = tiffOffset + gpsIfdPointer
        if (gpsAbs + 2 > view.byteLength) return null
        const entries = readUint16(view, gpsAbs, little)
        let latRef = ''
        let lngRef = ''
        let latRationalOffsets: [number, number, number] | null = null
        let lngRationalOffsets: [number, number, number] | null = null
        for (let i = 0; i < entries; i++) {
          const e = gpsAbs + 2 + i * 12
          if (e + 12 > view.byteLength) continue
          const tag = readUint16(view, e, little)
          const type = readUint16(view, e + 2, little)
          const count = readUint32(view, e + 4, little)
          const valueOrOffset = e + 8
          if (tag === 1 && type === 2 && count >= 1) {
            const off = count <= 4 ? valueOrOffset : (tiffOffset + readUint32(view, valueOrOffset, little))
            if (off < view.byteLength) latRef = String.fromCharCode(view.getUint8(off)).trim()
          } else if (tag === 3 && type === 2 && count >= 1) {
            const off = count <= 4 ? valueOrOffset : (tiffOffset + readUint32(view, valueOrOffset, little))
            if (off < view.byteLength) lngRef = String.fromCharCode(view.getUint8(off)).trim()
          } else if ((tag === 2 || tag === 4) && type === 5 && count === 3) {
            const arrOffset = tiffOffset + readUint32(view, valueOrOffset, little)
            if (arrOffset + 24 > view.byteLength) continue
            const v: [number, number, number] = [
              readRational(view, arrOffset + 0, little),
              readRational(view, arrOffset + 8, little),
              readRational(view, arrOffset + 16, little),
            ]
            if (tag === 2) latRationalOffsets = v
            else lngRationalOffsets = v
          }
        }
        const lat = latRationalOffsets && parseExifRational3(latRationalOffsets, latRef, 'N', 'S')
        const lng = lngRationalOffsets && parseExifRational3(lngRationalOffsets, lngRef, 'E', 'W')
        if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng }
        }
      }
    }
    if (segLen < 2) return null
    pos += 2 + segLen
  }
  return null
}
