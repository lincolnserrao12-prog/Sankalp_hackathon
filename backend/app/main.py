import os, uuid, hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
import jwt
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, String, Float, Integer, DateTime, ForeignKey, Text, select, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session, relationship
from passlib.context import CryptContext

DATABASE_URL=os.getenv('DATABASE_URL','sqlite:///./iwitness.db')
engine=create_engine(DATABASE_URL, pool_pre_ping=True)
pwd=CryptContext(schemes=['bcrypt'], deprecated='auto'); SECRET=os.getenv('JWT_SECRET','dev-secret-change-me')
class Base(DeclarativeBase): pass
class User(Base):
 __tablename__='users'; id:Mapped[int]=mapped_column(primary_key=True); name:Mapped[str]=mapped_column(String(100)); email:Mapped[str]=mapped_column(String(150),unique=True); password:Mapped[str]=mapped_column(String(255)); role:Mapped[str]=mapped_column(String(20),default='citizen'); created_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow)
class Incident(Base):
 __tablename__='incidents'; id:Mapped[int]=mapped_column(primary_key=True); title:Mapped[str]=mapped_column(String(200)); hazard:Mapped[str]=mapped_column(String(50)); severity:Mapped[int]=mapped_column(Integer); risk_score:Mapped[int]=mapped_column(Integer); status:Mapped[str]=mapped_column(String(30),default='reported'); lat:Mapped[float]=mapped_column(Float); lng:Mapped[float]=mapped_column(Float); address:Mapped[str]=mapped_column(String(250),default=''); assigned_to:Mapped[str]=mapped_column(String(100),default=''); created_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow); updated_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow); reports=relationship('Report',back_populates='incident'); events=relationship('Event',back_populates='incident')
class Report(Base):
 __tablename__='reports'; id:Mapped[int]=mapped_column(primary_key=True); incident_id:Mapped[int]=mapped_column(ForeignKey('incidents.id')); user_id:Mapped[int]=mapped_column(ForeignKey('users.id')); text:Mapped[str]=mapped_column(Text); image_url:Mapped[str]=mapped_column(String(300),default=''); voice_text:Mapped[str]=mapped_column(Text,default=''); created_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow); incident=relationship('Incident',back_populates='reports')
class Event(Base):
 __tablename__='events'; id:Mapped[int]=mapped_column(primary_key=True); incident_id:Mapped[int]=mapped_column(ForeignKey('incidents.id')); actor:Mapped[str]=mapped_column(String(100)); action:Mapped[str]=mapped_column(String(100)); note:Mapped[str]=mapped_column(Text,default=''); created_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow); incident=relationship('Incident',back_populates='events')
Base.metadata.create_all(engine)
def db():
 with Session(engine) as s: yield s
def token(u): return jwt.encode({'sub':str(u.id),'role':u.role,'exp':datetime.now(timezone.utc)+timedelta(days=7)},SECRET,algorithm='HS256')
def me(authorization:str=None, s:Session=Depends(db)):
 # FastAPI header injection handled below explicitly
 return None
from fastapi import Header
def current(authorization: str=Header(...), s:Session=Depends(db)):
 try: data=jwt.decode(authorization.replace('Bearer ',''),SECRET,algorithms=['HS256']); u=s.get(User,int(data['sub']))
 except Exception: raise HTTPException(401,'Invalid token')
 if not u: raise HTTPException(401,'User not found')
 return u
def role(*roles):
 def check(u:User=Depends(current)):
  if u.role not in roles: raise HTTPException(403,'Insufficient role')
  return u
 return check
VISION_MODEL_PATH=Path(os.getenv('VISION_MODEL_PATH',str(Path(__file__).resolve().parent.parent/'models'/'civic_hazard_classifier.pt')))
_vision_model=None
def detect_image(image_path:Path):
 global _vision_model
 if not VISION_MODEL_PATH.exists(): return None
 try:
  import torch
  from PIL import Image
  from torchvision import models, transforms
  if _vision_model is None:
   checkpoint=torch.load(VISION_MODEL_PATH,map_location='cpu',weights_only=False)
   architecture=checkpoint.get('architecture')
   if architecture=='efficientnet_b0':model=models.efficientnet_b0(weights=None);model.classifier[1]=torch.nn.Linear(model.classifier[1].in_features,len(checkpoint['classes']))
   elif architecture=='mobilenet_v3_small':model=models.mobilenet_v3_small(weights=None);model.classifier[3]=torch.nn.Linear(model.classifier[3].in_features,len(checkpoint['classes']))
   else:raise ValueError(f'Unsupported classifier checkpoint: {architecture}')
   model.load_state_dict(checkpoint['state_dict']);model.eval()
   size=checkpoint.get('image_size',224);transform=transforms.Compose([transforms.Resize((size,size)),transforms.ToTensor(),transforms.Normalize((0.485,0.456,0.406),(0.229,0.224,0.225))]);_vision_model=(model,checkpoint,transform)
  model,checkpoint,transform=_vision_model
  with Image.open(image_path) as photo,torch.inference_mode(): probabilities=torch.softmax(model(transform(photo.convert('RGB')).unsqueeze(0)),dim=1)[0]
  index=int(probabilities.argmax());confidence=float(probabilities[index])
  detections=[{'hazard':checkpoint['hazard_labels'][index],'confidence':round(confidence,4)}] if confidence>=.65 else []
  return {'mode':architecture,'detections':detections,'no_issue_detected':not bool(detections),'top_confidence':round(confidence,4)}
 except Exception as error:
  print(f'Vision inference unavailable: {error}')
  return None
def classify(text,image_path:Path|None=None):
 t=text.lower(); h=next((x for x in ['pothole','manhole','waterlogging','streetlight','garbage','crack'] if x in t),'unsafe infrastructure'); sev= 5 if any(x in t for x in ['danger','deep','urgent','accident','flood']) else 3
 vision=detect_image(image_path) if image_path else None
 if vision and vision['detections']:
  best=max(vision['detections'],key=lambda item:item['confidence']);h=best['hazard'];sev=max(sev,4 if best['confidence']>=.65 else 3)
 return h,sev,vision
def distance(a,b,c,d): return ((a-c)**2+(b-d)**2)**.5*111000
def score(sev,n,status): return min(100,round(sev*12+n*9+(12 if status in ['verified','in_progress'] else 0)))
class Auth(BaseModel): name:str=''; email:str; password:str; role:str='citizen'
class Update(BaseModel): status:str|None=None; assigned_to:str|None=None; note:str=''
app=FastAPI(title='i-Witness Civic Safety API',version='1.0.0'); app.add_middleware(CORSMiddleware,allow_origin_regex=r'https?://[^/]+',allow_credentials=True,allow_methods=['*'],allow_headers=['*']); Path('uploads').mkdir(exist_ok=True); app.mount('/uploads',StaticFiles(directory='uploads'),name='uploads')
@app.post('/api/auth/register')
def register(x:Auth,s:Session=Depends(db)):
 if s.scalar(select(User).where(User.email==x.email)): raise HTTPException(400,'Email already registered')
 u=User(name=x.name,email=x.email,password=pwd.hash(x.password),role=x.role if x.role in ['citizen','authority','admin'] else 'citizen'); s.add(u); s.commit(); s.refresh(u); return {'token':token(u),'user':userout(u)}
@app.post('/api/auth/login')
def login(x:Auth,s:Session=Depends(db)):
 u=s.scalar(select(User).where(User.email==x.email))
 if not u or not pwd.verify(x.password,u.password): raise HTTPException(401,'Invalid email or password')
 return {'token':token(u),'user':userout(u)}
def userout(u): return {'id':u.id,'name':u.name,'email':u.email,'role':u.role}
def incidentout(i): return {'id':i.id,'title':i.title,'hazard':i.hazard,'severity':i.severity,'risk_score':i.risk_score,'status':i.status,'lat':i.lat,'lng':i.lng,'address':i.address,'assigned_to':i.assigned_to,'created_at':i.created_at,'updated_at':i.updated_at,'evidence_count':len(i.reports),'risk_explanation':f'Severity ({i.severity}/5), {len(i.reports)} independent reports, and {i.status.replace("_"," ")} status.'}
@app.get('/api/incidents')
def incidents(status:str|None=None,hazard:str|None=None,location:str|None=None,lat:float|None=None,lng:float|None=None,radius_m:float=5000,s:Session=Depends(db)):
 q=select(Incident)
 if status:q=q.where(Incident.status==status)
 if hazard:q=q.where(Incident.hazard==hazard)
 rows=s.scalars(q.order_by(Incident.risk_score.desc())).all()
 if location:rows=[i for i in rows if location.lower() in i.address.lower() or location.lower() in i.title.lower()]
 if lat is not None and lng is not None:rows=[i for i in rows if distance(lat,lng,i.lat,i.lng)<=max(1,min(radius_m,50000))]
 return [incidentout(i) for i in rows]
@app.get('/api/incidents/{iid}')
def getincident(iid:int,s:Session=Depends(db)):
 i=s.get(Incident,iid)
 if not i:raise HTTPException(404,'Incident not found')
 d=incidentout(i);d['reports']=[{'id':r.id,'text':r.text,'voice_text':r.voice_text,'image_url':r.image_url,'created_at':r.created_at} for r in i.reports];d['timeline']=[{'action':e.action,'actor':e.actor,'note':e.note,'created_at':e.created_at} for e in sorted(i.events,key=lambda x:x.created_at,reverse=True)];return d
@app.post('/api/reports')
async def submit(text:str=Form(...),lat:float=Form(...),lng:float=Form(...),address:str=Form(''),voice_text:str=Form(''),photo:UploadFile|None=File(None),s:Session=Depends(db),u:User=Depends(current)):
 image=''; image_path=None
 if photo:
  ext=Path(photo.filename or '.jpg').suffix; image=f'/uploads/{uuid.uuid4()}{ext}'; image_path=Path(image[1:]); image_path.write_bytes(await photo.read())
 h,sev,vision=classify(text+' '+voice_text,image_path)
 candidates=s.scalars(select(Incident).where(Incident.status!='resolved')).all(); i=next((x for x in candidates if distance(lat,lng,x.lat,x.lng)<120 and (x.hazard==h or h in x.title.lower())),None)
 merged=bool(i)
 if not i: i=Incident(title=f'{h.title()} reported near {address or "your location"}',hazard=h,severity=sev,risk_score=score(sev,1,'reported'),lat=lat,lng=lng,address=address);s.add(i);s.flush();s.add(Event(incident_id=i.id,actor=u.name,action='Incident created',note='AI demo classification: '+h))
 r=Report(incident_id=i.id,user_id=u.id,text=text,image_url=image,voice_text=voice_text);s.add(r);s.flush(); i.severity=max(i.severity,sev);i.risk_score=score(i.severity,len(i.reports),'verified' if i.status=='verified' else i.status);i.updated_at=datetime.utcnow();s.add(Event(incident_id=i.id,actor=u.name,action='Evidence merged' if merged else 'Report submitted',note='Duplicate matching uses hazard, 120m proximity and active incident status.'));s.commit();return {'incident':incidentout(i),'merged':merged,'ai':{'hazard':h,'severity':sev,'mode':vision['mode'] if vision else 'deterministic demo fallback','detections':vision['detections'] if vision else [],'no_issue_detected':vision.get('no_issue_detected',False) if vision else False,'top_confidence':vision.get('top_confidence') if vision else None}}
@app.patch('/api/incidents/{iid}')
def update(iid:int,x:Update,s:Session=Depends(db),u:User=Depends(role('authority','admin'))):
 i=s.get(Incident,iid)
 if not i:raise HTTPException(404,'Incident not found')
 old=i.status
 if x.status:i.status=x.status
 if x.assigned_to is not None:i.assigned_to=x.assigned_to
 i.risk_score=score(i.severity,len(i.reports),i.status);i.updated_at=datetime.utcnow();s.add(Event(incident_id=i.id,actor=u.name,action=f'{old} → {i.status}' if x.status else 'Assignment updated',note=x.note));s.commit();return incidentout(i)
@app.get('/api/analytics')
def analytics(s:Session=Depends(db),u:User=Depends(role('authority','admin'))):
 rows=s.scalars(select(Incident)).all(); return {'total':len(rows),'open':sum(i.status!='resolved' for i in rows),'critical':sum(i.risk_score>=70 for i in rows),'hotspots':[incidentout(i) for i in sorted(rows,key=lambda x:len(x.reports),reverse=True)[:5]],'deterioration':[incidentout(i) for i in sorted(rows,key=lambda x:x.risk_score,reverse=True)[:5]]}
@app.get('/api/users')
def users(s:Session=Depends(db),u:User=Depends(role('admin'))): return [userout(x) for x in s.scalars(select(User)).all()]
def seed():
 with Session(engine) as s:
  if s.scalar(select(func.count(User))):return
  users=[User(name='Asha Citizen',email='citizen@iwitness.demo',password=pwd.hash('Demo123!'),role='citizen'),User(name='Ravi Authority',email='authority@iwitness.demo',password=pwd.hash('Demo123!'),role='authority'),User(name='System Admin',email='admin@iwitness.demo',password=pwd.hash('Demo123!'),role='admin'),User(name='Meera Citizen',email='meera@iwitness.demo',password=pwd.hash('Demo123!'),role='citizen')];s.add_all(users);s.flush();p=Incident(title='Deep pothole worsening at MG Road junction',hazard='pothole',severity=5,risk_score=87,status='verified',lat=12.9716,lng=77.5946,address='MG Road Junction, Bengaluru',assigned_to='Road Works Team');m=Incident(title='Open manhole near metro entrance',hazard='manhole',severity=5,risk_score=72,status='in_progress',lat=12.9724,lng=77.5954,address='Church Street Metro, Bengaluru',assigned_to='Drainage Team');w=Incident(title='Recurring waterlogging on Residency Road',hazard='waterlogging',severity=4,risk_score=63,status='reported',lat=12.9698,lng=77.5968,address='Residency Road, Bengaluru');r=Incident(title='Streetlight failure reopened after repair',hazard='streetlight',severity=3,risk_score=48,status='reopened',lat=12.974,lng=77.592,address='Brigade Road, Bengaluru');s.add_all([p,m,w,r]);s.flush()
  for txt,user in [('Large deep pothole, cars swerving dangerously',users[0]),('Same pothole getting worse after rain',users[3]),('My bike nearly fell here',users[0])]:s.add(Report(incident_id=p.id,user_id=user.id,text=txt))
  for i,action,note in [(p,'Verified','Three reports in 2 days; deterioration trend detected.'),(m,'Assigned','Crew dispatched.'),(r,'Resolved','Closed after repair.'),(r,'Reopened','Light failed again; repeat-failure signal.')]:s.add(Event(incident_id=i.id,actor='Ravi Authority',action=action,note=note))
  s.commit()
seed()
