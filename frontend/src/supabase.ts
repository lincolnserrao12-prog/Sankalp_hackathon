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
    if (supabaseAnonKey.startsWith('sb_secret_') || supabaseAnonKey.startsWith('eyJhbGciOi') && supabaseAnonKey.includes('role')) {
      issues.push({ kind: 'service-role-key' })
    } else if (!supabaseAnonKey.startsWith('sb_publishable_') && !supabaseAnonKey.startsWith('eyJhbGciOi')) {
      issues.push({ kind: 'bad-key-prefix' })
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
      case 'bad-key-prefix': return 'VITE_SUPABASE_ANON_KEY does not look like a Supabase public anon key (expected sb_publishable_…).'
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
      auth: { persistSession: false, autoRefreshToken: false },
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

  const path = `reports/${uid}/${Date.now()}-${sanitizeFilename(file.name)}`
  try {
    const { error } = await client.storage
      .from(SUPABASE_BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
    if (error) {
      const structured: string[] = []
      if ((error as any).name) structured.push(`name=${String((error as any).name)}`)
      if ((error as any).statusCode != null) structured.push(`status=${String((error as any).statusCode)}`)
      if ((error as any).code) structured.push(`code=${String((error as any).code)}`)
      const detail = structured.length ? `[${structured.join(', ')}] ${error.message}` : error.message
      return { ok: false, stage: 'supabase-storage', error: error.message || 'Supabase Storage returned an error.', detail }
    }

    const { data: urlInfo } = client.storage.from(SUPABASE_BUCKET).getPublicUrl(path)
    const imageUrl = urlInfo?.publicUrl
    if (!imageUrl) return { ok: false, stage: 'public-url', error: 'Supabase did not return a public URL for the uploaded image.' }
    return { ok: true, imageUrl }
  } catch (error) {
    if (isLikelyNetworkTypeError(error)) {
      const detail =
        `Your browser could not reach Supabase Storage. ` +
        `This usually means the deployed build was produced with placeholder VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY values ` +
        `(https://your-project-id.supabase.co / your-anon-key-not-service-role). ` +
        `Rebuild the frontend with real settings in .env.local, then redeploy. ` +
        `Other causes: device offline, DNS failure, or a browser ad-blocker/extension blocked the request.`
      return { ok: false, stage: 'upload-network', error: 'Could not reach Supabase Storage (network error).', detail }
    }
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, stage: 'upload-network', error: `Unexpected error uploading photo: ${msg}`, detail: error instanceof Error ? String(error.stack ?? msg) : msg }
  }
}
