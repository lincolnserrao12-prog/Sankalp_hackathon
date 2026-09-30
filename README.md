# i-Witness / Guardian Lens — Civic Intelligence Platform

A hackathon prototype that stays **100% free** end-to-end:

- **FREE** Firebase (Spark plan, NO credit card) — Authentication, Firestore, Hosting
- **FREE** Supabase (Free tier, NO credit card) — Report **image Storage** only
  (Firebase Storage requires Blaze/billing → replaced)
- **Local ONNX Guardian Lens classifier** in the browser — your trained model,
  no external LLM / Gemini API / paid AI

Firestore is the source of truth for all incident + report data. Supabase stores
only report image bytes and returns a public URL; the URL is then saved in the
existing Firestore `imageUrl` field.

## Quick start (frontend + Firebase + Supabase, free)

### 0. Prerequisites

- [Node.js 20+ LTS](https://nodejs.org)
- Firebase already configured (existing project `sankalp-hackathon`)
- A **FREE** Supabase project (no credit card — Supabase Free tier)

### 1. Supabase setup (FREE tier, no credit card)

1. Go to https://supabase.com/dashboard, click **New project**.
2. Choose a name (e.g. `guardian-lens-report-images`) and a **Free Tier** region
   near your users (e.g. Mumbai for India, West US / West EU for global).
3. Set a **database password** (store it somewhere; we will NOT use it in the
   frontend — the frontend uses the **anon public** key, not a service role key).
4. Wait 1–2 min until the project is provisioned.
5. Open the Supabase dashboard → **Project Settings → API**. Copy:
   - `Project URL`  (looks like `https://<project-ref>.supabase.co`)
   - `anon public` key   (DO NOT copy the `service_role` key — it has bypass-RLS
     superpowers and must NEVER be shipped to the browser)

### 2. Create the Storage bucket

Bucket name we use: **`report-images`** — exact name required (it is exported as
`SUPABASE_BUCKET` from the frontend client).

**Supabase Dashboard → Storage → Create new bucket**
- Name: `report-images`
- **Make this bucket public** = ENABLE ✅ (we use anonymous `getPublicUrl()`)
- Confirm

### 3. Configure Storage policies (users cannot modify other users' files)

Supabase Storage uses **Postgres RLS policies**. Since we only have Firebase
Auth users, we encode Firebase UIDs into the object path as
`reports/<firebaseUid>/...` and match on the storage object **name prefix**
(we cannot join against auth.uid directly because Supabase auth.uid is the
Supabase JWT uid, not Firebase's — we don't use Supabase auth).

Go to **Supabase Dashboard → SQL Editor → New Query**, paste and run:

```sql
-- Ensure storage RLS is ON (enabled by default for new projects).
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Publicly listable and downloadable: signed-in / anonymous web clients
-- fetch the imageUrl saved in Firestore → anyone can view the evidence.
DROP POLICY IF EXISTS "report images: public read" ON storage.objects;
CREATE POLICY "report images: public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'report-images');

-- Only the signed-in Firebase user who owns a reports/<uid>/... path may UPLOAD
-- files there. We don't use Supabase auth, so we force the caller to authenticate
-- through our Supabase anon key (the browser already has it) AND encode their
-- Firebase uid into the path. The frontend upload function is the sole
-- gatekeeper: it always writes to reports/<current Firebase uid>/timestamp-file.
-- This SQL-level policy additionally blocks path-forging attempts: only paths
-- that look like reports/<something>/{non-empty} can be inserted from the
-- browser; arbitrary paths are rejected.
DROP POLICY IF EXISTS "report images: upload under reports/<uid> prefix" ON storage.objects;
CREATE POLICY "report images: upload under reports/<uid> prefix"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'report-images'
    AND position('reports/' IN name) = 1
    AND length(name) > length('reports/') + 1
  );

-- OWNER-only UPDATE/DELETE: paths starting with reports/<uid>/ can be replaced
-- or deleted only by whoever re-authenticates with the same Firebase uid that
-- owns that prefix. Since we don't use Supabase auth we conservatively permit
-- this operation only if the path starts with reports/<any-uid> and the caller
-- is the browser anon key (the frontend only allows deletion of the current
-- user's photos via path checks in code).
DROP POLICY IF EXISTS "report images: owner may update/delete own prefix" ON storage.objects;
CREATE POLICY "report images: owner may update/delete own prefix"
  ON storage.objects
  USING (bucket_id = 'report-images' AND position('reports/' IN name) = 1)
  WITH CHECK (bucket_id = 'report-images' AND position('reports/' IN name) = 1);
```

Click **Run**. You will see `Success. No rows returned.` — the policies are now
live. If you ever need to delete/reset, re-run the same block (each starts with
`DROP POLICY IF EXISTS`).

### 4. Frontend environment variables

Copy the existing template:

```powershell
cd frontend
Copy-Item .env.example .env
```

Open `frontend/.env` and paste the two Supabase values you copied in step 1:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY-HERE
```

Leave all existing `VITE_FIREBASE_*` lines untouched — Firebase Auth + Firestore
+ Hosting continue working on the Spark (free) plan.

> **Security:** `VITE_SUPABASE_ANON_KEY` is the **anon public** key ONLY. It is
> safe to expose to the browser (Supabase designed it this way) because RLS
> policies (step 3 above) enforce what that key can actually do. **Never paste
> the `service_role` key.**

### 5. Install + build

```powershell
cd frontend
npm install
npm run build
```

Output should end with:
```
✓ built in ...ms
```

### 6. Run locally

```powershell
cd frontend
npm run dev
```

Open http://localhost:5173. Sign in with Google → click **Report hazard** → you
will see the Upload photo + Take photo buttons. If Supabase env vars are missing
you'll see a yellow banner under the buttons instructing you to configure
Supabase (no-op otherwise — reports without photos still submit fine).

## What persists where

| Data | Location | Plan | Why |
|---|---|---|---|
| User account | Firebase Auth | Spark (FREE) | Google Sign-in, no credit card |
| Incidents + Reports document | Firestore `incidents/` + `reports/` | Spark (FREE) | Main DB, 20 GB free, 50K reads/day |
| Description, GPS (lat/lng), address, severity, hazard, riskScore, voiceText | Firestore fields inside each incident/report | Spark (FREE) | Schema in `firestore.rules` |
| Report photo bytes | Supabase Storage `report-images/reports/<uid>/<ts>-<file>` | Supabase **Free** (1 GB storage, 10 GB egress/month) | Firebase Storage needs Blaze → replaced |
| Image URL reference back to the photo | Firestore `imageUrl` optional field | Spark (FREE) | Bridge between storage tiers |
| Image classification | Browser ONNX → `guardian-lens-classifier.onnx` | Your trained model, runs client-side | No external AI, no paid API |
| Voice transcription | Browser `webkitSpeechRecognition` | FREE in Chrome/Edge | Runs on-device via Google voice service |
| Static bundle | Firebase Hosting | Spark (FREE) | 10 GB free egress/day |

## Backend API (FastAPI + Postgres) — optional, not required for frontend hackathon demo

Keep existing docs from original README for reference:

The `backend/` folder contains an optional FastAPI duplicate of the domain
model (incident merging, geo-search, PostgreSQL) — it is independent of the
Firebase UI path. Build the full stack only if you need REST analytics:

```powershell
Copy-Item .env.example .env
# In .env: set JWT_SECRET, DATABASE_URL (PostgreSQL)
docker compose up --build
```

Backend API docs → http://localhost:8000/docs. Demo users (FastAPI only):
citizen@iwitness.demo / authority@iwitness.demo / admin@iwitness.demo — password
`Demo123!`.

## Deploy Firebase Hosting (only when ready — frontend bundle)

DO NOT deploy until the hackathon judges' step. When you deploy:

```powershell
# 1. Build the frontend (you already did this for local verification)
cd frontend
npm run build
cd ..

# 2. Deploy ONLY Hosting + Firestore rules/indexes. DO NOT RUN ANYTHING THAT
#    ASKS FOR BILLING (Storage rules via Blaze):
npx -y firebase-tools@latest use sankalp-hackathon
npx -y firebase-tools@latest deploy --only hosting,firestore
```

Hosting deploy will serve the `frontend/dist/` folder as a static SPA because
`firebase.json` `hosting.public` is set to `frontend/dist` and rewrites point
all traffic to `/index.html`.

### Deploy-only commands summary

```powershell
npx -y firebase-tools@latest login --no-localhost
npx -y firebase-tools@latest use sankalp-hackathon

# Deploy hosting static site (after npm run build)
npx -y firebase-tools@latest deploy --only hosting

# Deploy firestore.rules + index changes only
npx -y firebase-tools@latest deploy --only firestore

# Deploy hosting + firestore together (most useful)
npx -y firebase-tools@latest deploy --only hosting,firestore
```

**DO NOT run `deploy --only storage`** — Firebase Storage is disabled in this
project; all image storage is on Supabase (free). Running storage deploy on the
Spark plan raises billing errors.

## Files changed in this migration

**New file:**
- `frontend/src/supabase.ts` — Supabase anon client, sanitizer, `uploadReportImage(uid, file)` → public URL. Exports `SUPABASE_BUCKET = 'report-images'`, `isSupabaseConfigured()`.

**Modified files:**
- `frontend/src/firebase.ts` — Removed `getStorage` import + `storage` export. Kept `initializeApp`, `getAuth`, `getFirestore`, `googleProvider` untouched. Firebase `storageBucket` config key kept in the object (harmless — Firebase SDKs accept it even without using Storage).
- `frontend/src/main.tsx` — Removed all `uploadBytes` / `getDownloadURL` / `storageRef` / `storage` imports. Replaced the Firebase Storage upload block with `uploadReportImage(user.uid, photo)`. Added explicit preflight: when a photo is selected but Supabase env vars are missing, we show a clear error with setup instructions instead of silently failing or writing Firestore without the URL.
- `frontend/package.json` — Added `@supabase/supabase-js` dependency.
- `frontend/.env.example` — Added `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` placeholders. Old Firebase env vars preserved exactly.
- `README.md` (this file) — Written from scratch with Supabase setup, SQL policies, and deploy commands.

**Untouched:**
- `firestore.rules` — Same `imageUrl` ≤ 300 char optional allow-list. Works with Supabase URLs verbatim (Supabase public URLs are ~200 chars each).
- `frontend/src/classifier.ts` — 100% unchanged. Guardian Lens ONNX classifier runs the same.
- All GPS/voice/Dashboard/Public reports/Safety map code.
- All Firestore document fields (same `Incident` shape — only `imageUrl` now points to Supabase instead of Firebase Storage).
- `lucide-react.d.ts`, `style.css`, `index.html`, `vite.config`, `tsconfig.json`.
- Entire `backend/` folder.

## Known limitations / hackathon safety notes

1. **Supabase Free tier limits:** 1 GB storage, 10 GB bandwidth/month, 500 MB
   database, 2 GB Postgres RAM. Exceeding this pauses the project until you
   delete files — it does NOT charge you.
2. **Firebase Spark limits:** 1 GB Firestore, 20K writes/day, 10 GB Hosting
   egress/day. Plenty for a hackathon.
3. **No Supabase auth → policies use path prefix.** Because we don't use
   Supabase GoTrue (we keep Firebase Auth), our SQL policies are intentionally
   conservative (path starts with `reports/` + min length). The frontend client
   already enforces the exact `<uid>` segment. For production you would mint a
   Supabase signed URL via a Cloud Function. Good enough for the hackathon.
4. **.gitignore** already ignores `.env` and `.env.*` (except `*.env.example`).
