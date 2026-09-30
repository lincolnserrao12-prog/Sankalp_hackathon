import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export const SUPABASE_BUCKET = 'report-images'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let supabaseClient: SupabaseClient | null = null
let warned = false

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey)
}

function getClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    if (!warned) {
      console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Image uploads are disabled until Supabase free-tier project is set up.')
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
  | { ok: false; error: string }

export async function uploadReportImage(
  uid: string,
  file: File,
): Promise<UploadOutcome> {
  const client = getClient()
  if (!client) return { ok: false, error: 'supabase-not-configured' }
  if (!uid) return { ok: false, error: 'upload-requires-signed-in-user' }
  if (!file.type.startsWith('image/')) return { ok: false, error: 'upload-only-images' }
  if (file.size > 10 * 1024 * 1024) return { ok: false, error: 'upload-too-large' }

  const path = `reports/${uid}/${Date.now()}-${sanitizeFilename(file.name)}`
  try {
    const { error } = await client.storage
      .from(SUPABASE_BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
    if (error) return { ok: false, error: `${error.name}: ${error.message}` }

    const { data: urlInfo } = client.storage.from(SUPABASE_BUCKET).getPublicUrl(path)
    const imageUrl = urlInfo?.publicUrl
    if (!imageUrl) return { ok: false, error: 'public-url-missing' }
    return { ok: true, imageUrl }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
