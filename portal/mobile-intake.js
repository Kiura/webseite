'use strict';
const {storageConfig}=require('./file-storage');
const {assert,text,id,hash,Problem,payable}=require('./domain');
const sharp=require('sharp');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields=new Set(['claimant.company','claimant.first','claimant.last','claimant.street','claimant.zip','claimant.city','claimant.phone','claimant.email','claimant.birthdate','claimant.iban','plate','vin','make','model','subtype','firstRegistration','kw','displacement','fuel','color','accident.date','accident.place','accident.description','inspection.at','previousOwners','purchase','serviceHistory','claimant.vat','leased','financed','policeRecorded','policeAttached','legalProtection']);
const required=['claimant.first','claimant.last','claimant.street','claimant.zip','claimant.city','plate'];
const perspectives=new Set(['frontLeft','frontRight','rearRight','rearLeft','damageOverview','damageDetail','plate','vin','odometer','registration','other']);
function clean(input){
 assert(input&&typeof input==='object'&&!Array.isArray(input),'Falldaten fehlen.');
 const result={};for(const [key,value]of Object.entries(input)){assert(fields.has(key),'Unbekanntes Feld.');result[key]=text(value,key==='accident.description'?4000:400);}
 for(const key of required)assert(result[key]?.trim(),'Bitte Name, Vorname, Kennzeichen und vollständige Adresse angeben.');return result;
}
function capability(req){const match=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');assert(match,'Fallzugang fehlt.',401);return hash(match[1]);}
function asIntake(f){return {ownerType:f['claimant.company']?'company':'person',ownerCompany:f['claimant.company']||'',ownerFirstName:f['claimant.first'],ownerLastName:f['claimant.last'],owner:[f['claimant.company'],f['claimant.first']+' '+f['claimant.last']].filter(Boolean).join(' · '),ownerStreet:f['claimant.street'],ownerPostcode:f['claimant.zip'],ownerCity:f['claimant.city'],customerEmail:f['claimant.email']||'',ownerContact:f['claimant.phone']||'',ownerPhone:f['claimant.phone']||'',ownerIban:f['claimant.iban']||'',plate:f.plate,vehicle:[f.make,f.model].filter(Boolean).join(' '),vin:f.vin||'',accidentDate:f['accident.date']||'',location:f['accident.place']||'',description:f['accident.description']||''};}
function commission(c){
 const f=c.finance,amount=Number.isSafeInteger(f?.partnerNet)&&f.partnerNet>=0&&f.invoiceNet>0?f.partnerNet:null;
 const paid=!!f?.paidOutAt,received=!!f?.invoiceGross&&f.received>=f.invoiceGross,eligible=payable(c)&&!!f?.partnerInvoiceApproved&&!paid;
 let stage='calculation',label='Wird kalkuliert';
 if(amount!==null){
  stage='payment_pending';label='Zahlungseingang ausstehend';
  if(!f.partnerAcceptedAt){stage='agreement_pending';label='Vergütung bitte bestätigen';}
  else if(received){stage='invoice_pending';label='Partnerabrechnung offen';}
  if(eligible){stage='payable';label='Zur Auszahlung freigegeben';}
  if(paid){stage='paid';label='Ausgezahlt';}
  if(amount===0){stage='no_commission';label='Keine Provision vereinbart';}
 }
 return {amountCents:amount,invoiceNetCents:f?.invoiceNet||null,percent:f?.calculation?.partnerMode!=='fixed'&&amount!==null&&f?.invoiceNet>0?Math.round(amount/f.invoiceNet*10000)/100:null,stage,label,payable:eligible,paidOutAt:f?.paidOutAt||null,receivedInFull:received};
}
function overview(cases){
 const items=cases.sort((a,b)=>(b.updatedAt||b.createdAt).localeCompare(a.updatedAt||a.createdAt)).map(c=>({id:c.id,reference:c.mobile?.reference||c.number,plate:c.intake.plate||'',vehicle:c.intake.vehicle||'',customer:c.intake.owner||'',status:c.status,source:c.source,createdAt:c.createdAt||null,submittedAt:c.submittedAt||null,updatedAt:c.updatedAt||null,fileCount:c.fileCount??null,photoCount:c.photoCount??null,documentCount:c.documentCount??null,thumbnailFileId:c.thumbnailFileId||null,latestRequest:c.latestRequest||null,commission:commission(c)}));
 const totals={expectedCents:0,payableCents:0,paidCents:0};
 for(const c of items){const f=c.commission;if(f.amountCents===null)continue;if(f.stage==='paid')totals.paidCents+=f.amountCents;else{totals.expectedCents+=f.amountCents;if(f.payable)totals.payableCents+=f.amountCents;}}
 return {items,totals,updatedAt:new Date().toISOString(),notice:'Voraussichtliche Beträge sind keine Auszahlung. Freigabe erst nach vollständigem Zahlungseingang bei UNFALLX, bestätigter Vergütung und geprüfter Partnerabrechnung.'};
}
function createMobileIntake({tx,body,rate,ip,env,blobs,authorize,onSubmitted=async()=>{}}){
 const isEnabled=()=>env.PORTAL_MOBILE_INTAKE_ENABLED!=='false';
 async function actor(req){assert(typeof authorize==='function','Anmeldung erforderlich.',401);const a=await authorize(req);assert(a?.user?.role==='partner'&&a.company?.id===a.user.companyId,'Partnerzugang erforderlich.',403);assert(a.company.status==='approved','Dein Zugang wartet auf die Freischaltung durch UNFALLX.',403);return a;}
 async function access(s,cid,key,a,completed=false){
  const secret=await s.get('mobile_access',cid);assert(secret&&secret.secretHash===key,'Fall nicht gefunden.',404);
  const c=await s.get('case',cid);assert(c&&c.source==='mobile'&&c.companyId===a.company.id,'Fall nicht gefunden.',404);
  assert((completed&&['submitted','review','accepted','in_progress','report_ready','report_sent','closed'].includes(c.status))||['draft','recording','needs_info'].includes(c.status),'Der Fall wird bereits bearbeitet. Bitte UNFALLX kontaktieren.',409);return c;
 }
 async function event(s,c,a,action){const e={id:id(),caseId:c.id,actor:a.user.name,action,internal:false,at:new Date().toISOString()};await s.put('event',e,c.id);c.updatedAt=new Date().toISOString();c.version++;await s.put('case',c,c.companyId);return e;}
 async function save(req,a){
  const key=capability(req),data=await body(req,25000);assert(uuid.test(data.id||''),'Ungültige Fallkennung.');assert(/^[a-f0-9]{64}$/.test(data.fieldsHash||''),'Datenstand fehlt.');const values=clean(data.fields);
  return tx(async s=>{
   await rate(s,'mobile-save:'+a.user.id,180);let c=await s.get('case',data.id);
   if(c){c=await access(s,data.id,key,a,true);if(!['draft','recording','needs_info'].includes(c.status)){assert(c.mobile?.fieldsHash===data.fieldsHash,'Dieser Fall wird bereits bearbeitet.',409);return {ok:true,id:c.id};}}
   else{await rate(s,'mobile-new:'+a.company.id,100,86400000);assert(!await s.get('mobile_access',data.id),'Fallkennung nicht verfügbar.',409);c={id:data.id,number:'UX-'+new Date().getUTCFullYear()+'-'+data.id.slice(0,8).toUpperCase(),companyId:a.company.id,ownerUserId:a.user.id,source:'mobile',companyName:a.company.name,status:'recording',version:0,intake:{},assignee:null,finance:null,createdAt:new Date().toISOString()};await s.put('mobile_access',{id:c.id,secretHash:key,createdAt:new Date().toISOString()});}
   const changed=c.mobile?.fieldsHash!==data.fieldsHash;
   if(changed){c.intake={...c.intake,...asIntake(values)};c.mobile={...c.mobile,fields:values,fieldsHash:data.fieldsHash,reference:text(data.reference,100),updatedAt:new Date().toISOString()};await event(s,c,a,'Kundendaten aus iPhone-App gespeichert');}
   return {ok:true,id:c.id};
  });
 }
 let inFlight=0;
 async function guardedUpload(req,cid,a){assert(inFlight<4,'Upload ausgelastet.',429);inFlight++;try{return await upload(req,cid,a);}finally{inFlight--;}}
 async function upload(req,cid,a){
  const key=capability(req);await tx(async s=>{await access(s,cid,key,a);await rate(s,'mobile-upload:'+cid,200);});
  const kind=req.headers['x-file-kind'],asset=req.headers['x-asset-id'],type=String(req.headers['content-type']||'').split(';')[0],perspective=req.headers['x-perspective']||'other';
  assert(['photo','registration','authorization'].includes(kind)&&uuid.test(asset||''),'Ungültige Dateiart oder Kennung.');
  const bytes=await body(req,25*1024*1024,true);assert(bytes.length>0,'Die Datei ist leer.');let name;try{name=decodeURIComponent(req.headers['x-file-name']||'');}catch{throw new Problem(400,'Ungültiger Dateiname.');}name=text(name,180,true).replace(/[\/\\\r\n"<>]/g,'_');
  if(kind==='authorization'){assert(type==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-'&&bytes.subarray(-2048).includes(Buffer.from('%%EOF')),'Ungültiges PDF.');assert(['unfallx','nextright'].includes(req.headers['x-order-kind'])&&/^[a-f0-9]{64}$/.test(req.headers['x-fields-hash']||''),'Dokumentzuordnung fehlt.');}
  else{assert(type==='image/jpeg'&&perspectives.has(perspective),'Bitte ein JPEG mit Perspektive senden.');try{const meta=await sharp(bytes,{limitInputPixels:60000000}).metadata();assert(meta.format==='jpeg'&&meta.width>0&&meta.height>0&&!meta.pages);await sharp(bytes,{limitInputPixels:60000000}).resize(1,1).toBuffer();}catch{throw new Problem(400,'Das Bild kann nicht gelesen werden.');}}
  const prepare=async s=>{
   const fresh=await s.get('user',a.user.id);assert(fresh?.active&&fresh.role==='partner'&&fresh.companyId===a.user.companyId&&(await s.get('company',fresh.companyId))?.status==='approved','Der Zugang ist gesperrt.',403);const c=await access(s,cid,key,a),files=(await s.list('file',cid)).filter(f=>!f.deletedAt),sha=hash(bytes),existing=files.find(f=>f.mobileAssetId===asset);
   if(existing){assert(existing.sha256===sha&&existing.kind===kind&&existing.perspective===perspective&&(kind!=='authorization'||existing.orderKind===req.headers['x-order-kind']&&existing.fieldsHash===req.headers['x-fields-hash']),'Diese Dateikennung wurde bereits verwendet.',409);return {existing};}
   assert(files.length<100&&files.reduce((n,f)=>n+f.size,0)+bytes.length<=750*1024*1024,'Das Upload-Limit dieses Falls ist erreicht.',413);
   const usage=await s.get('system','storage')||{id:'storage',bytes:0};assert(usage.bytes+bytes.length<=storageConfig(env).limit,'Dokumentenspeicher ist belegt.',507);
   return {c,usage,sha};};const early=await tx(prepare);if(early.existing)return {ok:true,id:early.existing.id,alreadyStored:true};return blobs.write(bytes,async(s,staged)=>{const {c,usage,sha,existing}=await prepare(s);if(existing)return {ok:true,id:existing.id,alreadyStored:true};
   const f={id:staged.id,caseId:cid,kind,name,type,size:bytes.length,sha256:sha,at:new Date().toISOString(),by:a.user.name,uploadedBy:a.user.id,uploadedByRole:a.user.role,mobileAssetId:asset,perspective,orderKind:kind==='authorization'?req.headers['x-order-kind']:null,fieldsHash:kind==='authorization'?req.headers['x-fields-hash']:null};
   await staged.attach(s);await s.put('file',f,cid);usage.bytes+=bytes.length;await s.put('system',usage);await event(s,c,a,'Datei aus iPhone-App: '+name);return {ok:true,id:f.id};
  });
 }
 async function finish(req,cid,a){const key=capability(req),data=await body(req,1000);const submissionID=data?.submissionID;assert(submissionID===undefined||uuid.test(submissionID),'Ungültige Übermittlungskennung.');return tx(async s=>{
  const c=await access(s,cid,key,a,true);if(submissionID&&c.mobile?.submittedRequestID===submissionID)return {ok:true,id:c.id,submissionID};if(c.submittedAt&&c.status!=='needs_info')return {ok:true,id:c.id};const files=(await s.list('file',cid)).filter(f=>!f.deletedAt);
  for(const p of perspectives)if(p!=='other')assert(files.some(f=>f.perspective===p&&(p==='registration'?f.kind==='registration':f.kind==='photo')),'Es fehlen Fahrzeugfotos oder der Fahrzeugschein.');
  for(const kind of ['unfallx','nextright'])assert(files.some(f=>f.kind==='authorization'&&f.orderKind===kind&&f.fieldsHash===c.mobile.fieldsHash),'Es fehlen aktuelle unterschriebene Dokumente.');
  c.status='submitted';c.submittedAt=new Date().toISOString();if(submissionID)c.mobile.submittedRequestID=submissionID;const completedEvent=await event(s,c,a,'Kundenaufnahme abgeschlossen');await onSubmitted(s,a.user,c,completedEvent);return {ok:true,id:c.id};
 });}
 async function route(path,req){
  if(path==='/mobile/config'&&req.method==='GET')return {version:2,enabled:isEnabled(),authentication:'approved-partner-session'};
  assert(isEnabled(),'Die iPhone-Schnittstelle ist vorübergehend deaktiviert.',501);const a=await actor(req);
  const extra=await require('./mobile-tools').createMobileTools({tx,body,rate}).route(path,req,a);if(extra)return extra;
  if(path==='/mobile/overview'&&req.method==='GET')return tx(async s=>overview(await require('./presentation').summarizeCases(s,(await s.list('case',a.company.id)).filter(c=>c.companyId===a.company.id),a.user)));
  assert(req.method==='POST','Methode nicht erlaubt.',405);
  if(path==='/mobile/cases')return save(req,a);const m=/^\/mobile\/cases\/([a-f0-9-]{36})\/(files|finish)$/.exec(path);assert(m&&uuid.test(m[1]),'Nicht gefunden.',404);return m[2]==='files'?guardedUpload(req,m[1],a):finish(req,m[1],a);
 }
 return {route};
}
module.exports={createMobileIntake,clean,asIntake,commission,overview};
