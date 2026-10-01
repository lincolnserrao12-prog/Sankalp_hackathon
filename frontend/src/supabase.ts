import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export const SUPABASE_BUCKET = 'report-images'

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()

const PLACEHOLDER_URLS = new Set<string>([
  '',
  'https://your-project-id.supabase.co',
  'http://your-project-id.supabase.co',
  'your-project-id.supabase.co',
])
const PLACEHOLDER_KEYS = new Set<string>([
  '',
  'your-anon-key-not-service-role',
  'your-service-role-key-keep-secret',
  'REPLACE_WITH_YOUR_ANON_KEY',
])

export type ConfigIssue =
  | { kind: 'missing-url' }
  | { kind: 'missing-anon-key' }
  | { kind: 'placeholder-url' }
  | { kind: 'placeholder-key' }
  | { kind: 'bad-url-protocol' }
  | { kind: 'bad-url-host' }
  | { kind: 'service-role-key' }
  | { kind: 'bad-key-prefix' }

let supabaseClient: SupabaseClient | null = null
let warned = false
let cachedIssues: ConfigIssue[] | null = null

function cacheBustingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const initCopy: RequestInit = { ...(init || {}) }
  const noCacheHeaders = new Headers(initCopy.headers || {})
  noCacheHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  noCacheHeaders.set('Pragma', 'no-cache')
  noCacheHeaders.set('Expires', '0')
  initCopy.headers = noCacheHeaders
  initCopy.cache = 'no-store'
  return fetch(input, initCopy)
}

function extractProjectRef(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const dotIdx = host.indexOf('.')
    if (dotIdx > 0 && host.endsWith('.supabase.co')) return host.slice(0, dotIdx)
  } catch {}
  return '(your project ref)'
}

function diagnoseConfig(): ConfigIssue[] {
  if (cachedIssues !== null) return cachedIssues
  const issues: ConfigIssue[] = []
  if (!supabaseUrl) issues.push({ kind: 'missing-url' })
  else if (PLACEHOLDER_URLS.has(supabaseUrl)) issues.push({ kind: 'placeholder-url' })
  else {
    let parsed: URL | null = null
    try { parsed = new URL(supabaseUrl) } catch { parsed = null }
    if (!parsed) issues.push({ kind: 'bad-url-host' })
    else {
      if (parsed.protocol !== 'https:') issues.push({ kind: 'bad-url-protocol' })
      const host = parsed.hostname.toLowerCase()
      if (!host.endsWith('.supabase.co') && host !== 'supabase.co') issues.push({ kind: 'bad-url-host' })
    }
  }

  if (!supabaseAnonKey) issues.push({ kind: 'missing-anon-key' })
  else if (PLACEHOLDER_KEYS.has(supabaseAnonKey)) issues.push({ kind: 'placeholder-key' })
  else {
    const looksJwt = supabaseAnonKey.startsWith('eyJhbGciOi')
    const looksPublishable = supabaseAnonKey.startsWith('sb_publishable_')
    if (supabaseAnonKey.startsWith('sb_secret_') || (looksJwt && /service_role|role["']?\s*:\s*["']?service_role/.test(supabaseAnonKey))) {
      issues.push({ kind: 'service-role-key' })
    } else if (!looksPublishable && !looksJwt) {
      issues.push({ kind: 'bad-key-prefix' })
    } else {
      if (looksPublishable) {
        const token = supabaseAnonKey.slice('sb_publishable_'.length)
        if (token.length < 20) issues.push({ kind: 'bad-key-prefix' })
      } else if (looksJwt) {
        const dotCount = (supabaseAnonKey.match(/\./g) || []).length
        if (dotCount < 2 || supabaseAnonKey.length < 60) issues.push({ kind: 'bad-key-prefix' })
      }
    }
  }
  cachedIssues = issues
  return issues
}

export function configIssues(): ConfigIssue[] { return diagnoseConfig() }

export function describeConfigIssues(issues: ConfigIssue[]): string[] {
  return issues.map(i => {
    switch (i.kind) {
      case 'missing-url': return 'VITE_SUPABASE_URL is missing.'
      case 'missing-anon-key': return 'VITE_SUPABASE_ANON_KEY is missing.'
      case 'placeholder-url': return 'VITE_SUPABASE_URL is still the placeholder "https://your-project-id.supabase.co". Rebuild the frontend with your real project URL before deploying.'
      case 'placeholder-key': return 'VITE_SUPABASE_ANON_KEY is still the placeholder value "your-anon-key-not-service-role". Rebuild with your real public anon key.'
      case 'bad-url-protocol': return 'VITE_SUPABASE_URL must start with https:// (Supabase project URL).'
      case 'bad-url-host': return 'VITE_SUPABASE_URL is not a valid Supabase project URL. It should look like https://<project-ref>.supabase.co'
      case 'service-role-key': return 'Detected what looks like a service-role / secret key in VITE_SUPABASE_ANON_KEY. Replace with the public anon key (usually starts with sb_publishable_). Never ship secret keys to the browser.'
      case 'bad-key-prefix': return 'VITE_SUPABASE_ANON_KEY does not look like a Supabase public anon key (expected sb_publishable_… or eyJhbGciOi… JWT).'
    }
  })
}

export function isSupabaseConfigured(): boolean { return diagnoseConfig().length === 0 }

function getClient(): SupabaseClient | null {
  const issues = diagnoseConfig()
  if (issues.length > 0) {
    if (!warned) {
      console.warn('[Supabase] Skipping client creation:', describeConfigIssues(issues).join(' '))
      warned = true
    }
    return null
  }
  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storage: null as any },
      global: {
        fetch: cacheBustingFetch,
        headers: { 'X-Client-Info': 'guardian-lens-frontend' },
      },
    })
  }
  return supabaseClient
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_') || 'upload.bin'
}

export type UploadOutcome =
  | { ok: true; imageUrl: string }
  | { ok: false; stage: 'config' | 'input' | 'upload-network' | 'supabase-storage' | 'public-url'; error: string; detail?: string }

function isLikelyNetworkTypeError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const m = String(err.message).toLowerCase()
    return m.includes('failed to fetch') || m.includes('load failed') || m.includes('networkerror') || m.includes('failed to load')
  }
  return false
}

function isStorageUnknownError(err: any): boolean {
  if (!err) return false
  const name = String(err?.name || '')
  const message = String(err?.message || '')
  const code = String(err?.code || '')
  return /StorageUnknownError/i.test(name) || /StorageUnknownError/i.test(message) || /StorageUnknownError/i.test(code)
}

function summarizeStorageError(err: any): string {
  if (!err) return 'Unknown Supabase Storage error'
  const parts: string[] = []
  if (err.name) parts.push(`name=${String(err.name)}`)
  if (err.statusCode != null) parts.push(`status=${String(err.statusCode)}`)
  if (err.code) parts.push(`code=${String(err.code)}`)
  const cause = err.cause instanceof Error ? String(err.cause.message) : (typeof err.cause === 'string' ? err.cause : '')
  if (cause) parts.push(`cause=${cause}`)
  const msg = err instanceof Error ? err.message : String(err.message || err || '')
  const tail = parts.length ? ` [${parts.join(', ')}]` : ''
  return `${msg}${tail}`
}

function richStorageDiagnosticsHint(retryCount: number, maxAttempts: number): string {
  const cfgTail = (() => {
    const issues = diagnoseConfig()
    if (issues.length === 0) return ''
    return ` Pre-flight config warnings: ${describeConfigIssues(issues).join(' | ')}`
  })()
  const retryLine = retryCount >= 1
    ? ` Retried ${Math.min(retryCount + 1, maxAttempts)} of ${maxAttempts} with cache-bypass and a fresh in-memory Blob copy of the photo.`
    : ''
  return (
    retryLine +
    cfgTail +
    ` Most common causes: ` +
    `(A) VITE_SUPABASE_ANON_KEY does not match your Supabase project. Re-copy from Supabase Dashboard → Project Settings → API → Project public anon (publishable) key. Expected format: sb_publishable_<token> (compact, ~50 chars) OR eyJhbGciOi…<JWT> (≥140 chars). Both are valid. ` +
    `(B) The "report-images" bucket in your Supabase project does not exist or is PRIVATE. Fix: Storage → Buckets → New bucket → Name = report-images → toggle Public bucket ON → Save. If it already exists: (three dots) → Make public. ` +
    `(C) An ad-blocker / privacy extension / corporate VPN / service-worker intercepted the Supabase Storage *.supabase.co fetch. Whitelist the page or retry in a clean profile. ` +
    `(D) HTTP origin running on plain http:// (non-localhost) cannot reach Supabase. Switch to https:// or http://localhost via Vite dev / Firebase Hosting. ` +
    `(E) The deployed frontend build still has placeholder env values (${supabaseUrl?.includes('your-project-id') ? 'DETECTED placeholder VITE_SUPABASE_URL in this build. FIX: rewrite frontend/.env.local and run npm run build + firebase deploy --only hosting.' : 'VITE_SUPABASE_URL looks non-placeholder in this build, good.'}).`
  )
}

async function readFileIntoFreshBlobCopy(file: File): Promise<{ bytes: Uint8Array; size: number; copyBlob: Blob }> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const copyBlob = new Blob([bytes], { type: file.type || 'application/octet-stream' })
  return { bytes, size: bytes.length, copyBlob }
}

type HealthProbeResult = {
  keyAuth: 'ok' | '401-invalid-key' | '403-denied' | '5xx-server' | 'network-fail' | 'unknown'
  projectReachable: boolean
  reportImagesBucketFound: boolean | null
  reportImagesPublic: boolean | null
  observations: string[]
}

async function runStorageHealthProbe(timeoutMs = 7500): Promise<HealthProbeResult> {
  const out: HealthProbeResult = {
    keyAuth: 'unknown',
    projectReachable: false,
    reportImagesBucketFound: null,
    reportImagesPublic: null,
    observations: [],
  }
  const url = supabaseUrl
  const key = supabaseAnonKey
  if (!url || !key) {
    out.observations.push('VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not present in env.')
    return out
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const listResp = await cacheBustingFetch(`${url.replace(/\/$/, '')}/storage/v1/bucket`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller ? controller.signal : undefined,
    })
    out.projectReachable = true
    if (listResp.status === 401 || listResp.status === 403) {
      out.keyAuth = listResp.status === 401 ? '401-invalid-key' : '403-denied'
      out.observations.push(
        listResp.status === 401
          ? `✅ Reached Supabase, but anon key returned HTTP 401 (Unauthenticated / invalid signature). Your VITE_SUPABASE_ANON_KEY does not match project ref ${extractProjectRef(url)}. Go to Supabase → Project Settings → API → copy the EXACT "anon public" Project API key and rebuild + redeploy.`
          : '✅ Reached Supabase, but Storage API returned HTTP 403. This usually means the project Row-Level Security (RLS) policies deny anon reads on storage.bucket. Ensure Storage RLS is toggled OFF for anon users to list buckets.',
      )
      return out
    }
    if (listResp.status >= 500) {
      out.keyAuth = '5xx-server'
      out.observations.push(`Supabase infrastructure returned HTTP ${listResp.status} (their platform outage or internal error). Retry in 2-5 minutes; nothing to fix on your end.`)
      return out
    }
    if (!listResp.ok) {
      out.observations.push(`Unexpected HTTP ${listResp.status} when listing buckets.`)
      return out
    }
    out.keyAuth = 'ok'
    let bucketList: any[] = []
    try { bucketList = await listResp.json() as any[] } catch { bucketList = [] }
    if (!Array.isArray(bucketList)) {
      out.observations.push('Storage bucket list returned non-JSON.')
      return out
    }
    const target = bucketList.find(b => b && typeof b === 'object' && (b as any).name === SUPABASE_BUCKET)
    out.reportImagesBucketFound = !!target
    if (!target) {
      out.observations.push(`❌ BUCKET MISSING: Found ${bucketList.length} buckets total (${bucketList.slice(0, 5).map((b: any) => String((b as any).name || '?')).join(', ')}…), but none named "${SUPABASE_BUCKET}". FIX: Supabase → Storage → Buckets → New bucket → Name = ${SUPABASE_BUCKET} → toggle Public bucket = ON → Save.`)
      return out
    }
    const isPublic = target && typeof target === 'object' && Boolean((target as any).public)
    out.reportImagesPublic = isPublic
    if (!isPublic) {
      out.observations.push(`❌ BUCKET NOT PUBLIC: Bucket "${SUPABASE_BUCKET}" exists but has public=false. FIX: Supabase → Storage → Buckets → ${SUPABASE_BUCKET} → (three dots menu) → Make public. This is required because reports render their image with getPublicUrl() for free tier (no signed URL credits needed).`)
      return out
    }
    out.observations.push(`✅ ${SUPABASE_BUCKET} bucket exists + is public. Upload failure is likely caused by extension/VPN/captive-portal interception, RLS on storage.objects, or a file >50MB Supabase default.`)
    return out
  } catch (err: any) {
    out.projectReachable = false
    if (err && err.name === 'AbortError') {
      out.keyAuth = 'network-fail'
      out.observations.push('Storage auth probe timed out — this origin cannot reach Supabase network stack (captive portal / corporate proxy / VPN / airgap).')
      return out
    }
    out.keyAuth = 'network-fail'
    out.observations.push('Storage auth probe failed at fetch layer — DNS, TLS, CORS or browser-privacy interception blocked request to Supabase /storage/v1/bucket.')
    return out
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function appendHealthProbe(baseDetail: string, probe: HealthProbeResult | null): string {
  if (!probe) return baseDetail
  const lines = probe.observations.slice()
  if (lines.length === 0) return baseDetail
  return `${baseDetail} 🔎 Diagnostic probe (${probe.keyAuth}): ${lines.join(' ')}`
}

export async function uploadReportImage(
  uid: string,
  file: File,
): Promise<UploadOutcome> {
  const cfgIssues = diagnoseConfig()
  if (cfgIssues.length > 0) {
    return { ok: false, stage: 'config', error: 'Supabase is not configured properly for image uploads.', detail: describeConfigIssues(cfgIssues).join(' ') }
  }
  const client = getClient()
  if (!client) return { ok: false, stage: 'config', error: 'Supabase client unavailable (configuration error).' }
  if (!uid) return { ok: false, stage: 'input', error: 'You must be signed in to upload a photo.' }
  if (!file.type.startsWith('image/')) return { ok: false, stage: 'input', error: 'Only image files can be uploaded as report evidence.' }
  if (file.size > 10 * 1024 * 1024) return { ok: false, stage: 'input', error: 'Photo must be under 10 MB.' }

  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    return {
      ok: false,
      stage: 'upload-network',
      error: 'Your app is loaded from file:// protocol which Supabase SDK cannot use for storage uploads.',
      detail: 'Open the site over http://localhost or https:// (Firebase Hosting, Vite dev server).',
    }
  }

  let freshBlob: Blob | null = null
  try {
    const { copyBlob } = await readFileIntoFreshBlobCopy(file)
    freshBlob = copyBlob
  } catch (e) {
    return { ok: false, stage: 'input', error: 'Browser could not read the selected photo before upload.', detail: e instanceof Error ? e.message : String(e) }
  }

  const path = `reports/${uid}/${Date.now()}-${sanitizeFilename(file.name)}`
  let attempt = 0
  const maxAttempts = 3
  let lastErr: any = null
  const jitter = () => 500 + Math.random() * 1000
  while (attempt < maxAttempts) {
    attempt += 1
    try {
      const { error } = await client.storage
        .from(SUPABASE_BUCKET)
        .upload(path, freshBlob as Blob, { cacheControl: '3600', upsert: false, contentType: file.type })
      if (error) {
        if (attempt < maxAttempts && (isLikelyNetworkTypeError(error) || isStorageUnknownError(error) || (error && typeof (error as any).statusCode === 'number' && (error as any).statusCode >= 500))) {
          lastErr = error
          await new Promise(r => setTimeout(r, 800 * attempt + jitter()))
          continue
        }
        const summary = summarizeStorageError(error)
        const statusCode = error && typeof (error as any).statusCode === 'number' ? (error as any).statusCode : null
        const hint = isLikelyNetworkTypeError(error) || isStorageUnknownError(error) || (statusCode != null && statusCode >= 400 && statusCode !== 404)
          ? richStorageDiagnosticsHint(attempt - 1, maxAttempts)
          : ''
        let detail = hint ? `${summary}. ${hint}` : summary
        try {
          const probe = await runStorageHealthProbe(6500)
          detail = appendHealthProbe(detail, probe)
        } catch {}
        return { ok: false, stage: 'supabase-storage', error: error.message || 'Supabase Storage returned an error.', detail }
      }

      const { data: urlInfo } = client.storage.from(SUPABASE_BUCKET).getPublicUrl(path)
      const imageUrl = urlInfo?.publicUrl
      if (!imageUrl) return { ok: false, stage: 'public-url', error: 'Supabase did not return a public URL for the uploaded image.' }
      return { ok: true, imageUrl }
    } catch (error) {
      if (attempt < maxAttempts && (isLikelyNetworkTypeError(error) || isStorageUnknownError(error))) {
        lastErr = error
        await new Promise(r => setTimeout(r, 800 * attempt + jitter()))
        continue
      }
      if (isLikelyNetworkTypeError(error)) {
        let detail = 'Could not reach Supabase Storage (network/fetch failure). ' + richStorageDiagnosticsHint(attempt - 1, maxAttempts)
        try {
          const probe = await runStorageHealthProbe(6500)
          detail = appendHealthProbe(detail, probe)
        } catch {}
        return { ok: false, stage: 'upload-network', error: 'Could not reach Supabase Storage (network error).', detail }
      }
      if (isStorageUnknownError(error)) {
        const summary = summarizeStorageError(error)
        let detail = `${summary}. ${richStorageDiagnosticsHint(attempt - 1, maxAttempts)}`
        try {
          const probe = await runStorageHealthProbe(6500)
          detail = appendHealthProbe(detail, probe)
        } catch {}
        return { ok: false, stage: 'supabase-storage', error: 'Supabase SDK internal error while preparing the upload.', detail }
      }
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, stage: 'upload-network', error: `Unexpected error uploading photo: ${msg}`, detail: error instanceof Error ? String(error.stack ?? msg) : msg }
    }
  }
  const failedAfterRetryErr = lastErr
  if (isStorageUnknownError(failedAfterRetryErr) || isLikelyNetworkTypeError(failedAfterRetryErr)) {
    let detail = `${summarizeStorageError(failedAfterRetryErr)}. ${richStorageDiagnosticsHint(maxAttempts - 1, maxAttempts)}`
    try {
      const probe = await runStorageHealthProbe(6500)
      detail = appendHealthProbe(detail, probe)
    } catch {}
    return { ok: false, stage: 'supabase-storage', error: 'Image upload failed even after retries.', detail }
  }
  let finalDetail = summarizeStorageError(failedAfterRetryErr)
  try {
    const probe = await runStorageHealthProbe(6500)
    finalDetail = appendHealthProbe(finalDetail, probe)
  } catch {}
  return { ok: false, stage: 'supabase-storage', error: 'Image upload failed.', detail: finalDetail }
}
