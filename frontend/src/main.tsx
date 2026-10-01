import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, Camera, ExternalLink, ImagePlus, LogIn, LogOut, MapPin, Mic, MicOff, Navigation, Plus, ShieldCheck } from 'lucide-react'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { addDoc, collection, doc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from './firebase'
import { classifyImage, pickFirestoreSafeHazard, visionSeverityBoost, type VisionResult } from './classifier'
import { isSupabaseConfigured, uploadReportImage, configIssues, describeConfigIssues } from './supabase'
import './style.css'

type Incident = { id: string; title: string; hazard: string; severity: number; riskScore: number; status: 'reported'|'verified'|'in_progress'|'resolved'; lat: number; lng: number; address: string; evidenceCount: number; imageUrl?: string; voiceText?: string }
const ADMIN_EMAIL = 'lincolnserrao12@gmail.com'
const hazards = ['pothole', 'manhole', 'waterlogging', 'streetlight', 'garbage', 'crack']
const classify = (text: string) => ({ hazard: hazards.find(item => text.toLowerCase().includes(item)) ?? 'unsafe infrastructure', severity: /danger|deep|urgent|accident|flood/.test(text.toLowerCase()) ? 5 : 3 })
const score = (severity: number) => Math.min(100, Math.round(severity * 12 + 9))

function validLatLng(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}
function googleMapsTrackUrl(item: { lat: number; lng: number; title?: string; address?: string }): string {
  const q = encodeURIComponent(item.address || item.title || 'Hazard location')
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(item.lat)},${encodeURIComponent(item.lng)}&destination_place_id=&dir_action=navigate&query=${q}`
}
function osmTrackUrl(item: { lat: number; lng: number; title?: string }): string {
  const layer = 17
  return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(item.lat)}&mlon=${encodeURIComponent(item.lng)}#map=${layer}/${encodeURIComponent(item.lat)}/${encodeURIComponent(item.lng)}`
}
function openTrack(item: Incident, provider: 'google' | 'osm' = 'google'): void {
  if (!validLatLng(item.lat, item.lng)) return
  const url = provider === 'google' ? googleMapsTrackUrl(item) : osmTrackUrl(item)
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch {}
}

function App() {
  const [user, setUser] = useState<User | null>(null); const [incidents, setIncidents] = useState<Incident[]>([]); const [page, setPage] = useState<'dashboard'|'report'|'reports'|'map'>('dashboard'); const [notice, setNotice] = useState('')
  const isAdmin = user?.email === ADMIN_EMAIL
  useEffect(() => onAuthStateChanged(auth, current => setUser(current)), [])
  useEffect(() => onSnapshot(query(collection(db, 'incidents'), orderBy('createdAt', 'desc')), snapshot => setIncidents(snapshot.docs.map(item => ({ id: item.id, ...item.data() } as Incident))), error => setNotice(`Could not load reports: ${error.message}`)), [])
  const login = async () => { try { googleProvider.setCustomParameters({ prompt: 'select_account' }); await signInWithPopup(auth, googleProvider) } catch (error) { setNotice(error instanceof Error ? error.message : 'Google sign-in failed.') } }
  if (!user) return <div className="auth"><div className="authcard"><div className="brand"><ShieldCheck/> Gaurdian Lens</div><h1>Public safety reports</h1><p>Sign in with Google to report a civic hazard with location and evidence.</p>{notice&&<p className="notice">{notice}</p>}<button className="primary" onClick={login}><LogIn/> Continue with Google</button><p><small>{incidents.length} live reports visible after sign-in.</small></p></div></div>
  const open = incidents.filter(item => item.status !== 'resolved').length; const critical = incidents.filter(item => item.riskScore >= 70).length
  return <div className="shell"><aside><div className="brand"><ShieldCheck/> Gaurdian Lens</div><small>COMMUNITY SAFETY</small>{([['dashboard','Overview'],['report','Report hazard'],['reports','Public reports'],['map','Safety map']] as const).map(([key,label])=><button key={key} className={page===key?'active':''} onClick={()=>setPage(key)}>{key==='report'?<Plus/>:key==='map'?<MapPin/>:<Activity/>}{label}</button>)}<div className="profile">{user.displayName||user.email}<span>{isAdmin?'admin':'citizen'}</span><button onClick={()=>signOut(auth)}><LogOut/> Sign out</button></div></aside><main><header><div><p className="eyebrow">LIVE CIVIC INTELLIGENCE</p><h1>{page==='dashboard'?'Safety at a glance':page==='report'?'Report a hazard':page==='map'?'City safety map':'Public reports'}</h1></div><button className="primary" onClick={()=>setPage('report')}><Plus/> Report hazard</button></header>{notice&&<p className="notice">{notice}</p>}{page==='dashboard'&&<><section className="stats"><article className="stat"><i><Activity/></i><b>{incidents.length}</b><span>Total incidents</span></article><article className="stat"><i><Activity/></i><b>{open}</b><span>Open incidents</span></article><article className="stat"><i><Activity/></i><b>{critical}</b><span>Critical risk</span></article></section><section className="hero"><div><p className="eyebrow">COMMUNITY-POWERED</p><h2>Turn safety observations into actionable civic evidence.</h2><p>Guardian Lens triages reports by hazard, severity, and reported location.</p></div><ShieldCheck size={75}/></section>{incidents.length?<IncidentList incidents={incidents.slice(0,5)} isAdmin={isAdmin}/>:<section className="panel"><h2>No reports yet</h2><p>Submit the first hazard report to populate the dashboard.</p></section>}</>}{page==='report'&&<Report user={user} done={message=>{setNotice(message);setPage('reports')}}/>}{page==='reports'&&<section className="panel"><div className="sectiontitle"><h2>All incident reports</h2><span>{incidents.length} total</span></div><IncidentList incidents={incidents} isAdmin={isAdmin}/></section>}{page==='map'&&<Map incidents={incidents}/>}</main></div>
}

function Report({user,done}:{user:User;done:(message:string)=>void}) {
  const [text,setText]=useState('')
  const [lat,setLat]=useState('')
  const [lng,setLng]=useState('')
  const [address,setAddress]=useState('')
  const [busy,setBusy]=useState(false)
  const [locating,setLocating]=useState(false)
  const [geoStatus,setGeoStatus]=useState('')
  const [photo,setPhoto]=useState<File|null>(null)
  const [previewUrl,setPreviewUrl]=useState('')
  const [recording,setRecording]=useState(false)
  const [voiceText,setVoiceText]=useState('')
  const [vision,setVision]=useState<VisionResult|null>(null)
  const [analyzing,setAnalyzing]=useState(false)
  const fileRef=useRef<HTMLInputElement|null>(null)
  const captureRef=useRef<HTMLInputElement|null>(null)
  const addressRef=useRef<HTMLInputElement|null>(null)
  const recRef=useRef<any>(null)
  const ADDRESS_FIELD='address'

  const buildConciseAddress = (a: any): string => {
    if (!a || typeof a !== 'object') return ''
    const bits: string[] = []
    const named = (a.amenity || a.shop || (a.building && a.building !== 'yes' && a.building) || a.name) as string | undefined
    if (named) bits.push(String(named))
    const street = [a.house_number, a.road, a.pedestrian, a.footway].filter(Boolean).join(' ')
    if (street) bits.push(street)
    const local = [a.neighbourhood, a.suburb, a.hamlet].filter(Boolean)[0]
    if (local) bits.push(String(local))
    const city = [a.village, a.town, a.city_district, a.city].filter(Boolean)[0]
    if (city) bits.push(String(city))
    else if (a.county) bits.push(String(a.county))
    if (a.state) bits.push(String(a.state))
    if (a.postcode) bits.push(String(a.postcode))
    return bits.join(', ')
  }

  const locate = () => {
    if (!navigator.geolocation) { done('Geolocation is not supported in this browser. Use Chrome or Edge over HTTPS and enable location permissions.'); return }
    setLocating(true)
    setGeoStatus('Getting your GPS coordinates (high accuracy)…')
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const la = position.coords.latitude
        const ln = position.coords.longitude
        setLat(String(la))
        setLng(String(ln))
        setGeoStatus('Looking up your street address (OpenStreetMap Nominatim)…')
        try {
          const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(la)}&lon=${encodeURIComponent(ln)}&zoom=18&addressdetails=1&accept-language=en`
          const res = await fetch(url, {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'GuardianLens-Hackathon/1.0 (local civic reporting; low-volume interactive single requests per user)',
            },
          })
          if (!res.ok) throw new Error(`reverse lookup HTTP ${res.status}`)
          const data = await res.json()
          const raw = typeof data?.display_name === 'string' ? data.display_name : ''
          const concise = buildConciseAddress(data?.address)
          const chosen = (concise || raw || '').slice(0, 250)
          setAddress(chosen)
          if (addressRef.current) {
            try {
              (addressRef.current as any).value = chosen
              const ev = new Event('input', { bubbles: true })
              ;(addressRef.current as any).dispatchEvent(ev)
            } catch {}
          }
          setGeoStatus(chosen ? `✅ Address found: ${chosen.length > 95 ? chosen.slice(0, 95) + '…' : chosen}` : '✅ Got your coordinates. Type any extra landmark note below.')
        } catch (e) {
          setGeoStatus('✅ Got coordinates. Address lookup skipped — you can still fill it by hand.')
        } finally {
          setLocating(false)
        }
      },
      (error) => {
        setLocating(false)
        setGeoStatus('')
        done(`Could not get location: ${error.message}. Enable GPS/ Location permissions and try again.`)
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    )
  }

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      if (recRef.current) { try { recRef.current.onend = null; recRef.current.stop() } catch {} }
    }
  }, [previewUrl])

  const onPickFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0] || null
    setPhoto(f)
    setVision(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(f ? URL.createObjectURL(f) : '')
    if (f) {
      setAnalyzing(true)
      try {
        const r = await classifyImage(f)
        setVision(r)
      } catch {
        setVision({ available: false, detections: [], noIssueDetected: true, error: 'analysis-failed' })
      } finally { setAnalyzing(false) }
    }
  }

  const startStopSpeech = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setVoiceText(''); setText((prev) => prev ? prev + ` (Voice note: your browser doesn't support speech-to-text. Type the description instead.)` : 'Voice-to-text not supported in this browser. Use Chrome or Edge.'); return }
    if (recording) { try { recRef.current?.stop() } catch {} setRecording(false); return }
    const r = new SR(); r.continuous = false; r.interimResults = true; r.lang = 'en-US'
    r.onresult = (e: any) => {
      let finalChunk = ''; let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) { const piece = e.results[i][0].transcript; if (e.results[i].isFinal) finalChunk += piece; else interim += piece }
      const combined = finalChunk || interim
      setVoiceText(combined)
      setText((prev) => prev ? prev + `${prev.endsWith(' ') || prev.endsWith('\n') ? '' : ' '}${combined}` : combined)
    }
    r.onerror = (e: any) => { done(`Speech error: ${e.error}. Allow microphone permissions and try again.`); setRecording(false) }
    r.onend = () => { setRecording(false) }
    try { r.start(); recRef.current = r; setRecording(true) } catch (e: any) { done(`Could not start microphone: ${e?.message ?? e}`) }
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      const latNum = Number(lat); const lngNum = Number(lng)
      if (!validLatLng(latNum, lngNum)) {
        done('Enter a valid latitude/longitude first, or tap "Use my live location (GPS + auto address)". Empty coordinates will not be silently accepted.')
        return
      }
      if (photo && !isSupabaseConfigured()) {
        const issueMsgs = describeConfigIssues(configIssues())
        const hint = issueMsgs.length ? ` Details: ${issueMsgs.join(' ')}` : ' Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in frontend/.env (Supabase FREE plan — no credit card required).'
        done(`Photo selected but Supabase is not set up for free image storage. Remove the photo, or rebuild the frontend with valid Supabase settings.${hint}`)
        return
      }
      const baseline = classify(text + ' ' + voiceText)
      let hazard = baseline.hazard
      let severity = baseline.severity
      let visionResult: VisionResult | null = vision
      if (photo && !visionResult) visionResult = await classifyImage(photo)
      if (visionResult) { hazard = pickFirestoreSafeHazard(visionResult, baseline.hazard); severity = visionSeverityBoost(visionResult, baseline.severity) }
      const addressValue = (address || (new FormData(event.currentTarget).get(ADDRESS_FIELD) as string) || '').slice(0, 250)
      let imageUrl: string | undefined
      if (photo) {
        const result = await uploadReportImage(user.uid, photo)
        if (!result.ok) {
          const hint = result.detail ? ` — ${result.detail}` : ''
          done(`Image upload failed (stage: ${result.stage}). ${result.error}${hint}`)
          return
        }
        imageUrl = result.imageUrl
      }
      const locationLabel = addressValue || `${latNum.toFixed(4)}, ${lngNum.toFixed(4)}`
      const visionTopConfidence = visionResult?.detections?.length ? visionResult.detections.reduce((m, d) => Math.max(m, d.confidence), 0) : undefined
      const visionSnapshot = visionResult && visionResult.available
        ? {
            visionMode: visionResult.mode || 'onnx-efficientnet_b0',
            ...(typeof visionTopConfidence === 'number' ? { visionTopConfidence } : {}),
            ...(visionResult.detections.length ? { visionDetections: visionResult.detections.slice(0, 8).map(d => ({ h: d.hazard, c: Math.round(d.confidence * 1000) / 1000 })) } : {}),
          }
        : {}
      const incidentBase = {
        title: `${hazard.replace(/\b\w/g, x => x.toUpperCase())} reported near ${locationLabel}`,
        hazard,
        severity,
        riskScore: score(severity),
        status: 'reported' as const,
        lat: latNum,
        lng: lngNum,
        address: addressValue,
        evidenceCount: 1,
        createdAt: serverTimestamp(),
        createdBy: user.uid,
      }
      const incidentDoc = { ...incidentBase, ...(imageUrl ? { imageUrl } : {}), ...(voiceText ? { voiceText } : {}), ...visionSnapshot }
      let incidentId = ''
      try {
        const ref = await addDoc(collection(db, 'incidents'), incidentDoc)
        incidentId = ref.id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        done(`Incident Firestore write failed. ${msg}. Public incident was not created.`)
        return
      }
      try {
        const reportBase = { text, hazard, severity, lat: latNum, lng: lngNum, address: addressValue, authorUid: user.uid, createdAt: serverTimestamp(), incidentId }
        await addDoc(collection(db, 'reports'), { ...reportBase, ...(imageUrl ? { imageUrl } : {}), ...(voiceText ? { voiceText } : {}) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        done(`Report (evidence) Firestore write failed. The incident was created (ID: ${incidentId}), but the private reporter record could not be saved. ${msg}`)
        return
      }
      let mode = 'deterministic text fallback'
      if (visionResult && visionResult.available) mode = visionResult.mode || 'onnx'
      else if (visionResult && !visionResult.available && visionResult.error !== 'onnx-session-unavailable') mode = `onnx unavailable (${visionResult.error})`
      const detectionNote = visionResult && visionResult.detections.length ? `; vision detections: ${visionResult.detections.map(d => `${d.hazard} ${Math.round(d.confidence * 100)}%`).join(', ')}` : ''
      const voiceNote = voiceText ? '; voice transcription saved.' : ''
      const storageNote = photo ? ' (image stored free on Supabase Storage).' : ''
      done(`Report submitted (incident ${incidentId}). Guardian Lens identified ${hazard} at severity ${severity}/5 using ${mode}${detectionNote}${voiceNote}${storageNote}`)
    } catch (error) { done(error instanceof Error ? error.message : 'Could not submit report.') } finally { setBusy(false) }
  }

  return (
    <form className="report panel" onSubmit={submit}>
      <div className="photosection">
        <label className="photolabel">
          <span><ImagePlus/> Evidence photo <small>(optional, stored FREE on Supabase Storage, classified with your ONNX model)</small></span>
          <div className="photoactions">
            <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} hidden/>
            <button type="button" className="secondary" onClick={() => fileRef.current?.click()}><ImagePlus size={16}/> Upload photo</button>
            <input ref={captureRef} type="file" accept="image/*" capture="environment" onChange={onPickFile} hidden/>
            <button type="button" className="secondary" onClick={() => captureRef.current?.click()}><Camera size={16}/> Take photo (camera)</button>
          </div>
        </label>
        {!isSupabaseConfigured() && <p className="notice"><small>💡 Photo uploads are disabled until Supabase is configured (FREE tier, no credit card). Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in frontend/.env. Follow README.md step-by-step.</small></p>}
      </div>

      {previewUrl && (
        <div className="preview">
          <img src={previewUrl} alt="Photo preview" onClick={() => fileRef.current?.click()}/>
          <button type="button" className="link" onClick={() => { setPhoto(null); setVision(null); URL.revokeObjectURL(previewUrl); setPreviewUrl('') }}>Remove photo</button>
        </div>
      )}

      {analyzing && <div className="analysis analyzing"><ShieldCheck size={18}/> <span>Analysing your photo with the ONNX model… this usually takes 1–3 seconds.</span></div>}

      {!analyzing && photo && vision && (
        <div className={'analysis ' + (vision.detections.length ? 'issues' : 'ok')}>
          {vision.detections.length ? (
            <>
              <h3><ShieldCheck size={18}/> Model report — issues found ({vision.detections.length})</h3>
              <ul>{vision.detections.map((d, i) => <li key={i}><b>{d.hazard.replace(/_/g, ' ')}</b><span>{Math.round(d.confidence * 100)}% confidence</span></li>)}</ul>
              <p className="hint">Confidence threshold: 65%. Top detection will be used for hazard classification and severity boost. Add any extra details below.</p>
            </>
          ) : (
            <>
              <h3><ShieldCheck size={18}/> Model report — no issues found</h3>
              <p>Your trained ONNX model did not flag any recognised hazard above the 65% confidence threshold.{vision.available ? '' : ` (Model unavailable: ${vision.error})`}</p>
              <p className="hint">Still add a description below — the text classifier will also contribute, and a human reviewer will see your photo.</p>
            </>
          )}
        </div>
      )}

      <div className="twocol">
        <label>Latitude<input type="number" step="any" value={lat} onChange={event => setLat(event.target.value)} required/></label>
        <label>Longitude<input type="number" step="any" value={lng} onChange={event => setLng(event.target.value)} required/></label>
      </div>

      <div className="locaterow">
        <button type="button" className="secondary locatesize" onClick={locate} disabled={locating}>
          <MapPin size={16}/>{locating ? 'Getting location + address…' : 'Use my live location (GPS + auto address)'}
        </button>
        {geoStatus && <small className="geostatus">{geoStatus}</small>}
      </div>

      <label>
        Location / landmark <small>(auto-filled when possible, fully editable)</small>
        <input ref={addressRef} name={ADDRESS_FIELD} value={address} onChange={event => setAddress(event.target.value)} placeholder="e.g., Opposite park gate, near bus stop #14"/>
      </label>

      <label>
        Description
        <div className="inputrow">
          <textarea value={text} onChange={event => setText(event.target.value)} placeholder="Describe the hazard and danger level. Type here or tap the mic to speak." required/>
        </div>
        <div className="inputactions">
          <button type="button" className={'mic ' + (recording ? 'live' : '')} onClick={startStopSpeech} title={recording ? 'Stop recording' : 'Describe with your voice (Chrome/Edge on Android/Desktop)'}>
            {recording ? <><MicOff size={16}/> Stop… dictating</> : <><Mic size={16}/> Tap to speak description</>}
          </button>
          <small>{recording ? 'Listening… tap again when done.' : voiceText ? `Transcribed: ${voiceText.length > 90 ? voiceText.slice(0, 90) + '…' : voiceText}` : 'Speech-to-text uses Chrome/Edge Web Speech. Privacy: runs in your browser via Google voice service.'}</small>
        </div>
      </label>

      <button className="primary" disabled={busy}>{busy ? 'Submitting…' : 'Analyse and submit report'}</button>
    </form>
  )
}

function IncidentList({incidents,isAdmin}:{incidents:Incident[];isAdmin:boolean}) {
  const resolve=async(item:Incident)=>updateDoc(doc(db,'incidents',item.id),{status:'resolved',updatedAt:serverTimestamp()})
  return (
    <>
      {incidents.map(item => (
        <article className="incident" key={item.id}>
          <span className={'risk r'+Math.floor(item.riskScore/20)}>{item.riskScore}</span>
          <div className="incidentbody">
            <b>{item.title}</b>
            <p className="locationrow">
              <MapPin size={13}/>
              <button
                type="button"
                className="addresslink"
                onClick={()=>validLatLng(item.lat,item.lng) && openTrack(item,'google')}
                title={validLatLng(item.lat,item.lng) ? 'Click to track this location in Google Maps' : 'No valid coordinates on this report'}
                disabled={!validLatLng(item.lat,item.lng)}
              >
                <span className="addresstext" title={item.address || `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`}>
                  {item.address || `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`}
                </span>
              </button>
            </p>
            <p>{item.hazard} · Severity {item.severity}/5 · {item.evidenceCount} report{item.evidenceCount===1?'':'s'}</p>
            {item.imageUrl && <img className="thumb" src={item.imageUrl} alt="" loading="lazy"/>}
            <div className="trackrow">
              <button type="button" className="trackbtn" onClick={()=>openTrack(item,'google')} disabled={!validLatLng(item.lat,item.lng)}>
                <Navigation size={13}/> Track location
              </button>
              <button type="button" className="trackbtn ghost" onClick={()=>openTrack(item,'osm')} disabled={!validLatLng(item.lat,item.lng)} title="Open in OpenStreetMap">
                <ExternalLink size={13}/> OSM
              </button>
              {isAdmin && item.status !== 'resolved' && <button type="button" className="resolvelink" onClick={()=>resolve(item)}>Mark resolved</button>}
            </div>
          </div>
          <em className={'status '+item.status}>{item.status.replace('_',' ')}</em>
        </article>
      ))}
    </>
  )
}
function Map({incidents}:{incidents:Incident[]}) {
  return (
    <section className="map panel">
      <div className="gridmap">
        {incidents.map((item,index) => (
          <button
            type="button"
            key={item.id}
            title={`${item.title} — click to track location`}
            style={{left:`${(20+index*21)%82}%`,top:`${(18+index*17)%70}%`}}
            className={'pin r'+Math.floor(item.riskScore/20)}
            onClick={()=>openTrack(item,'google')}
            disabled={!validLatLng(item.lat,item.lng)}
          >
            {item.riskScore}
          </button>
        ))}
        <div className="maplabel">Live Firestore incident map · click any pin to track location</div>
      </div>
      <IncidentList incidents={incidents} isAdmin={false}/>
    </section>
  )
}
createRoot(document.getElementById('root')!).render(<App/>)
