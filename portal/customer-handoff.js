'use strict';
const D=require('./domain'),orders=require('./customer-orders');
const {storageConfig}=require('./file-storage');
const editable=['draft','recording','needs_info'];
const customerKeys=['claimant.company','claimant.first','claimant.last','claimant.street','claimant.zip','claimant.city','claimant.phone','claimant.email','plate','accident.date','accident.place'];
const canonical=f=>JSON.stringify(Object.fromEntries(Object.keys(f).sort().map(k=>[k,f[k]]))).replace(/\//g,'\\/');
const fieldsDigest=f=>D.hash(canonical(f));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function createCustomerHandoff({tx,body,rate,ip,env,blobs,access,capability,clean,asIntake,event}){
 async function fresh(s,c,h){
  const user=await s.get('user',h.ownerUserId),co=await s.get('company',c.companyId);
  D.assert(user?.active&&user.role==='partner'&&user.companyId===c.companyId&&co?.status==='approved','Kundenzugang nicht verfügbar.',410);
  D.assert(c.source==='mobile'&&editable.includes(c.status),'Diese Aufnahme kann nicht mehr geändert werden.',409);
 }
 async function expire(s,c){const h=c.mobile?.customerHandoff;if(h?.state==='active'&&h.expires<Date.now()){h.state='expired';await s.put('case',c,c.companyId);}return h;}
 function state(c,files){const h=c.mobile?.customerHandoff;return {ok:true,id:c.id,handoff:h?{state:h.state,revision:h.revision,expires:h.expires}:null,fields:h?c.mobile.fields:null,fieldsHash:c.mobile?.fieldsHash,orders:h?files.filter(f=>!f.deletedAt&&f.kind==='authorization'&&f.customerHandoff&&f.fieldsHash===c.mobile.fieldsHash).map(f=>({fileID:f.id,id:f.mobileAssetId,kind:f.orderKind,signedAt:f.signedAt,name:f.signerName,place:f.signerPlace,templateHash:f.templateHash,fieldsHash:f.fieldsHash,signature:f.signature})):[]};}
 async function partner(req,cid,a,operation){const key=capability(req),data=await body(req,2000);return tx(async s=>{
  await rate(s,'handoff-partner:'+a.user.id,90);const c=await access(s,cid,key,a,true);let h=await expire(s,c);
  if(operation==='status')return state(c,await s.list('file',cid));
  D.assert(editable.includes(c.status),'Fall bereits eingereicht.',409);
  if(operation==='create'){
   D.assert(!h||!['active','completed'].includes(h.state),'Bitte den bisherigen Kundenzugang zuerst abschließen oder sperren.',409);
   D.assert(data.fieldsHash===c.mobile.fieldsHash,'Bitte zuerst alle Änderungen übertragen.',409);
   const files=(await s.list('file',cid)).filter(f=>!f.deletedAt);
   for(const p of ['registration','frontLeft','frontRight','rearRight','rearLeft','damageOverview','damageDetail','plate','vin','odometer'])D.assert(files.some(f=>f.perspective===p&&f.kind===(p==='registration'?'registration':'photo')),'Bitte Fahrzeugschein und neun Fotoansichten zuerst übertragen.');
   const token=D.random(),hash=D.hash(token);h={state:'active',revision:D.id(),expires:Date.now()+48*3600000,tokenHash:hash,ownerUserId:a.user.id};
   c.mobile.customerHandoff=h;await s.put('customer_handoff',{id:hash,caseId:cid,expires:h.expires},cid);await event(s,c,a,'Kundenzugang für 48 Stunden erstellt');
   return {...state(c,files),url:'https://app.unfallx.com/kundenaufnahme#'+token};
  }
  D.assert(h&&data.revision===h.revision,'Kundenzugang wurde inzwischen geändert. Bitte aktualisieren.',409);
  if(operation==='revoke'){h.state='revoked';await event(s,c,a,'Kundenzugang gesperrt');}
  else if(operation==='ack'){D.assert(['completed','revoked','expired','imported'].includes(h.state),'Kunde bearbeitet die Aufnahme noch.',409);D.assert(data.fieldsHash===c.mobile.fieldsHash,'Datenstand stimmt nicht überein.',409);h.state='imported';await s.put('case',c,c.companyId);}
  else throw new D.Problem(404,'Nicht gefunden.');return state(c,await s.list('file',cid));
 });}
 async function authorize(s,data){
  D.assert(/^[a-f0-9]{64}$/.test(data.token||''),'Kundenzugang ungültig.',401);const row=await s.get('customer_handoff',D.hash(data.token));
  D.assert(row&&row.expires>Date.now(),'Der Link ist abgelaufen. Bitte einen neuen Link bei UNFALLX anfordern.',410);
  const c=await s.get('case',row.caseId),h=c?.mobile?.customerHandoff;
  D.assert(h&&h.tokenHash===row.id&&['active','completed'].includes(h.state),'Dieser Kundenzugang wurde gesperrt.',410);await fresh(s,c,h);return {c,h};
 }
 function customerState(c,files){return {ok:true,reference:c.mobile.reference||c.number,revision:c.mobile.customerHandoff.revision,expires:c.mobile.customerHandoff.expires,state:c.mobile.customerHandoff.state,fields:Object.fromEntries(customerKeys.map(k=>[k,c.mobile.fields[k]||''])),orders:['unfallx','nextright'].map(kind=>({kind,title:kind==='unfallx'?'Auftrag an UNFALLX':'Vollmacht für nextright',templateHash:orders.templateHash(kind),signed:files.some(f=>!f.deletedAt&&f.orderKind===kind&&f.customerHandoff&&f.fieldsHash===c.mobile.fieldsHash)}))};}
 let rendering=0;
 async function publicRoute(req,res){
  D.assert(req.method==='POST','Methode nicht erlaubt.',405);const data=await body(req,180000);
  await tx(s=>rate(s,'handoff-ip:'+ip(req),180));
  const {c,h}=await tx(async s=>{const a=await authorize(s,data);await rate(s,'handoff:'+a.h.tokenHash,120);return a;});
  if(data.action==='read')return tx(async s=>{const {c}=await authorize(s,data);return customerState(c,await s.list('file',c.id));});
  if(data.action==='save')return tx(async s=>{const {c,h}=await authorize(s,data);D.assert(h.state==='active'&&data.revision===h.revision,'Die Angaben wurden inzwischen geändert. Bitte neu laden.',409);
   D.assert(data.fields&&Object.keys(data.fields).every(k=>customerKeys.includes(k)),'Ungültige Kundenangaben.');const values=clean({...c.mobile.fields,...data.fields});if(values['accident.date'])D.date(values['accident.date']);if(values['claimant.email'])D.email(values['claimant.email']);
   if(fieldsDigest(values)!==c.mobile.fieldsHash){c.mobile.fields=values;c.mobile.fieldsHash=fieldsDigest(values);c.intake={...c.intake,...asIntake(values)};h.revision=D.id();await event(s,c,{user:{name:'Kunde · Kundenlink'}},'Kundendaten ergänzt');}
   return customerState(c,await s.list('file',c.id));
  });
  if(data.action==='document'){
   D.assert(['unfallx','nextright'].includes(data.kind),'Unbekannter Auftrag.');const files=await tx(s=>s.list('file',c.id));const signed=files.find(f=>!f.deletedAt&&f.customerHandoff&&f.orderKind===data.kind&&f.fieldsHash===c.mobile.fieldsHash);
   D.assert(rendering<3,'Dokument wird vorbereitet. Bitte gleich erneut versuchen.',429);rendering++;let bytes;
   try{bytes=signed?await blobs.read(signed.id,async s=>{const fresh=await authorize(s,data);D.assert(fresh.c.mobile.fieldsHash===signed.fieldsHash,'Dokument geändert.',409);}):await orders.renderOrder({kind:data.kind,fields:c.mobile.fields,fieldsHash:c.mobile.fieldsHash,reference:c.mobile.reference||c.number});}finally{rendering--;}
   await tx(async s=>{const fresh=await authorize(s,data);D.assert(fresh.h.revision===h.revision,'Datenstand geändert.',409);});
   res.setHeader('Content-Type','application/pdf');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition','attachment; filename="'+data.kind+'.pdf"');res.end(bytes);return null;
  }
  D.assert(data.action==='sign'&&['unfallx','nextright'].includes(data.kind),'Unbekannte Aktion.');
  D.assert(data.read===true&&data.agreed===true&&uuid.test(data.requestID||''),'Bitte den Auftrag lesen und ausdrücklich bestätigen.');
  D.assert(data.templateHash===orders.templateHash(data.kind),'Auftragsvorlage geändert. Bitte neu öffnen.',409);
  const ink=orders.signature(data.signature),place=D.text(data.place,120,true),digest=D.hash(JSON.stringify({...data,token:undefined}));
  const prepare=async s=>{const {c,h}=await authorize(s,data),files=(await s.list('file',c.id)).filter(f=>!f.deletedAt);const existing=files.find(f=>f.customerRequestID===data.requestID);if(existing){D.assert(existing.customerDigest===digest,'Unterschriftskennung bereits verwendet.',409);return {c,h,existing,files};}
   D.assert(h.state==='active'&&h.revision===data.revision,'Die Angaben haben sich geändert. Bitte erneut prüfen.',409);
   D.assert(c.mobile.fields['accident.date']&&c.mobile.fields['accident.place'],'Bitte Unfalldatum und Unfallort ergänzen.');
   D.assert(!files.some(f=>f.customerHandoff&&f.orderKind===data.kind&&f.fieldsHash===c.mobile.fieldsHash),'Dieser Auftrag ist bereits unterschrieben.',409);D.assert(files.length<100,'Dateilimit erreicht.',413);return {c,h,files};};
  const initial=await tx(prepare);if(initial.existing)return customerState(initial.c,initial.files);
  D.assert(rendering<3,'Dokument wird vorbereitet. Bitte gleich erneut versuchen.',429);rendering++;
  const signedAt=new Date().toISOString();let bytes;try{bytes=await orders.renderOrder({kind:data.kind,fields:c.mobile.fields,fieldsHash:c.mobile.fieldsHash,reference:c.mobile.reference||c.number,place,signedAt,ink});}finally{rendering--;}
  return blobs.write(bytes,async(s,staged)=>{const {c,h,existing,files}=await prepare(s);if(existing)return customerState(c,files);const usage=await s.get('system','storage')||{id:'storage',bytes:0};D.assert(usage.bytes+bytes.length<=storageConfig(env).limit&&files.reduce((n,f)=>n+(f.size||0),0)+bytes.length<=750*1024*1024,'Dokumentenspeicher belegt.',507);
   const name=c.mobile.fields['claimant.first']+' '+c.mobile.fields['claimant.last'];const f={id:staged.id,caseId:c.id,name:(data.kind==='unfallx'?'Auftrag UNFALLX':'Vollmacht nextright')+'.pdf',kind:'authorization',type:'application/pdf',size:bytes.length,sha256:D.hash(bytes),at:signedAt,by:name,uploadedByRole:'customer',customerHandoff:true,customerRequestID:data.requestID,customerDigest:digest,mobileAssetId:D.id(),orderKind:data.kind,fieldsHash:c.mobile.fieldsHash,templateHash:data.templateHash,signedAt,signerName:name,signerPlace:place,signature:{name,date:signedAt,strokes:ink.strokes,aspectRatio:ink.aspectRatio}};
   await staged.attach(s);await s.put('file',f,c.id);usage.bytes+=bytes.length;await s.put('system',usage);files.push(f);
   if(['unfallx','nextright'].every(k=>files.some(f=>f.customerHandoff&&f.orderKind===k&&f.fieldsHash===c.mobile.fieldsHash)))h.state='completed';
   await event(s,c,{user:{name:'Kunde · Kundenlink'}},data.kind==='unfallx'?'UNFALLX-Auftrag unterschrieben':'nextright-Vollmacht unterschrieben');return customerState(c,files);
  });
 }
 return {partner,publicRoute};
}
module.exports={createCustomerHandoff,fieldsDigest,customerKeys};
