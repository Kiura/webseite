'use strict';
const D=require('./domain'),sharp=require('sharp'),I=require('../assets/case-intake');
const BASE='https://app.autoixpert.de/externalApi/v1';
const pick=o=>Object.fromEntries(Object.entries(o).filter(([,v])=>v!==undefined&&v!==''&&v!==null));
const yes=v=>v==='yes'?true:v==='no'?false:undefined;
function payload(c,assessor){const n=c.mobile?.fields||{},d={...c.intake};
 for(const [key,native] of Object.entries({ownerCompany:'claimant.company',ownerFirstName:'claimant.first',ownerLastName:'claimant.last',ownerStreet:'claimant.street',ownerPostcode:'claimant.zip',ownerCity:'claimant.city',ownerPhone:'claimant.phone',customerEmail:'claimant.email',ownerIban:'claimant.iban',vin:'vin',plate:'plate',accidentDate:'accident.date',location:'accident.place',description:'accident.description'}))if(!d[key]&&n[native])d[key]=n[native];
 const normalized=I.normalize(d),notes=I.fields.filter(f=>Object.hasOwn(d,f.name)&&I.visible(f,normalized)).map(f=>f.label+': '+I.display(f,normalized)).join('\n');return {
 type:'liability',external_id:'UNFALLX-'+c.id,responsible_assessor:assessor,token:c.number,
 claimant:pick({first_name:d.ownerFirstName,last_name:d.ownerLastName,organization_name:d.ownerCompany,email:d.customerEmail,phone:d.ownerPhone||d.ownerContact,street_and_housenumber_or_lockbox:[d.ownerStreet,d.ownerHouseNumber].filter(Boolean).join(' '),zip:d.ownerPostcode,city:d.ownerCity,iban:d.ownerIban,may_deduct_taxes:yes(d.vatDeductible),is_owner:d.ownership==='owned'?true:undefined,notes:'UNFALLX Aufnahme – Angaben vor Gutachtenerstellung prüfen.\n'+notes+(c.mobile?.fields?'\nNative Aufnahme:\n'+Object.entries({...c.mobile.retainedFields,...c.mobile.fields}).map(([k,v])=>k+': '+v).join('\n'):'' )}),
 car:pick({license_plate:d.plate,vin:d.vin,make:d.vehicleMake||n.make,model:d.vehicle,first_registration_date:d.firstRegistration,mileage_as_stated:/^\d+$/.test(d.mileage||'')?Number(d.mileage):undefined,mileage_unit:'km',condition_comment:d.previousDamageDescription}),
 accident:pick({location:d.location,date:d.accidentDate,police_recorded:yes(d.policeInvolved),police_case_number:d.policeFileNumber,police_department:d.policeAuthority,circumstances:[d.accidentTime?'Angegebene Unfallzeit: '+d.accidentTime:'',d.description].filter(Boolean).join('\n')}),
 author_of_damage:pick({first_name:d.opponentFirstName,last_name:d.opponentLastName,organization_name:d.opponentCompany,email:d.opponentEmail,phone:d.opponentPhone,license_plate:d.opponentPlate,street_and_housenumber_or_lockbox:[d.opponentStreet,d.opponentHouseNumber].filter(Boolean).join(' '),zip:d.opponentPostcode,city:d.opponentCity}),
 visits:d.inspectionDate?[pick({date:d.inspectionDate,location_name:d.inspectionAddressExtra,street:[d.inspectionStreet,d.inspectionHouseNumber].filter(Boolean).join(' '),zip:d.inspectionPostcode,city:d.inspectionCity,conditions:d.inspectionConditionsAdequate==='yes'?'ausreichend':d.inspectionConditionsNote,auxiliary_devices:(d.inspectionTools||[]).map(x=>I.options.inspectionTools[x]||x)})]:[]
};}
function signedURL(value){let u;try{u=new URL(value);}catch{throw new D.Problem(502,'Ungültige autoiXpert-Uploadadresse.');}const buckets=['photos-autoixpert','user-uploaded-documents-autoixpert'];const valid=u.hostname==='s3.eu-central-1.amazonaws.com'&&buckets.some(b=>u.pathname.startsWith('/'+b+'/'))||buckets.some(b=>u.hostname===b+'.s3.eu-central-1.amazonaws.com');D.assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&valid,'Nicht freigegebene autoiXpert-Uploadadresse.',502);return u.href;}
function createAutoixpert({env,tx,caseAccess,audit,blobs,refreshUser,fetcher=fetch}){
 const running=new Set(),configured=()=>!!env.AUTOIXPERT_API_KEY&&!!env.AUTOIXPERT_ASSESSOR_ID;
 async function request(path,method='GET',data){let r;try{r=await fetcher(BASE+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+env.AUTOIXPERT_API_KEY,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});}catch{const e=new D.Problem(502,'autoiXpert hat die Anfrage nicht bestätigt. Bitte den Übertragungsstand prüfen.');e.uncertain=method!=='GET';throw e;}
  let result;try{result=await r.json();}catch{const e=new D.Problem(502,'Die autoiXpert-Antwort konnte nicht bestätigt werden.');e.uncertain=method!=='GET';throw e;}
  if(!r.ok||result.error_code){const e=new D.Problem(502,'autoiXpert meldet einen Fehler (HTTP '+r.status+'). Zugang, Rechte und Feldangaben prüfen.');e.uncertain=method!=='GET'&&r.status>=500;e.definite=r.status>=400&&r.status<500;throw e;}return result;
 }
 const view=job=>job?{state:job.state,reportId:job.reportId||null,total:job.files.length,completed:job.files.filter(f=>f.done).length,error:job.error||null,updatedAt:job.updatedAt}:null;
 async function state(user,cid){return tx(async s=>{await caseAccess(s,user,cid);D.assert(user.role==='admin','Nur intern durch die Administration verfügbar.',403);return {configured:configured(),job:view(await s.get('autoixpert_export',cid))};});}
 async function save(job){job.updatedAt=new Date().toISOString();await tx(async s=>{const previous=await s.get('autoixpert_export',job.caseId);D.assert(previous?.lock?.token===job.lock?.token,'Übertragung wird bereits von einer anderen Sitzung fortgesetzt.',409);await s.put('autoixpert_export',job,job.caseId);});}
 async function step(user,cid,data){
  D.assert(configured(),'autoiXpert-Zugang noch nicht eingerichtet.',503);D.assert(user.role==='admin','Nur intern durch die Administration verfügbar.',403);D.assert(!running.has(cid),'Die Übergabe läuft bereits.',409);running.add(cid);
  let job;const token=D.id();
  try{
   job=await tx(async s=>{const c=await caseAccess(s,user,cid);let j=await s.get('autoixpert_export',cid);
    if(!j){D.assert(data.reviewed===true,'Bitte zuerst die Falldaten und Unterlagen prüfen.');D.assert(data.confirmed===true,'Bitte die kostenpflichtige autoiXpert-Übergabe bestätigen.');D.assert(c.version===data.version,'Der Fall wurde geändert. Bitte neu laden.',409);D.assert(!['draft','recording','ready_to_submit','closed','declined'].includes(c.status),'Bitte zuerst den Eingang prüfen.');const files=(await s.list('file',cid)).filter(f=>!f.deletedAt&&!f.chatAttachment&&['photo','document','registration','authorization','case_bundle'].includes(f.kind)&& (f.type.startsWith('image/')||f.type==='application/pdf'));D.assert(files.length,'Keine Originaldateien zum Übertragen vorhanden.');j={id:cid,caseId:cid,state:'ready',payload:payload(c,env.AUTOIXPERT_ASSESSOR_ID),files:files.map(f=>({id:f.id,sha256:f.sha256,name:f.name,type:f.type,size:f.size,kind:f.kind})),createdAt:new Date().toISOString()};await s.put('autoixpert_export',j,cid);}
    // An interrupted metadata POST might have succeeded externally. Never blindly duplicate it.
    D.assert(!j.lock||j.lock.expires<Date.now(),'Die Übergabe läuft bereits in einer anderen Sitzung.',409);
    D.assert(j.state!=='uncertain'&&j.state!=='creating','Übergabe unbestätigt. Bitte in autoiXpert prüfen; es wird kein zweiter Datensatz automatisch erstellt.',409);if(j.state!=='complete'){j.lock={token,expires:Date.now()+300000};await s.put('autoixpert_export',j,cid);}return j;
   });
   if(job.state==='complete')return {job:view(job)};
   if(!job.reportId){job.state='creating';await save(job);const r=await request('/reports','POST',job.payload);const id=r.document?.id||r.report?.id||r.id;D.assert(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id),'autoiXpert hat keine Gutachten-ID bestätigt.',502);job.reportId=id;job.state='ready';await save(job);return {job:view(job)};}
   const item=job.files.find(f=>!f.done);
   if(item){const bytes=await blobs.read(item.id,async s=>{if(refreshUser)user=await refreshUser(s,user);await caseAccess(s,user,cid);const file=await s.get('file',item.id);D.assert(file&&!file.deletedAt&&file.caseId===cid&&file.sha256===item.sha256,'Die Quelldatei wurde geändert.',409);});D.assert(D.hash(bytes)===item.sha256,'Originaldatei konnte nicht verifiziert werden.',409);
    const photo=item.type.startsWith('image/'),group=photo?'photos':'documents',path='/reports/'+encodeURIComponent(job.reportId)+'/'+group;
    if(!item.remoteId){job.state='creating';await save(job);let meta=photo?{title:item.name,original_name:item.name,mimetype:item.type,size:item.size,included_in_report:item.kind==='photo',included_in_residual_value_exchange:false}: {title:item.name,type:'manually_uploaded_pdf'};
     if(photo)try{const d=await sharp(bytes).metadata();meta.width=d.width;meta.height=d.height;}catch{}
     const r=await request(path,'POST',meta);item.remoteId=r.photo?.id||r.document?.id||r.id;D.assert(typeof item.remoteId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(item.remoteId),'Datei-ID von autoiXpert nicht bestätigt.',502);job.state='ready';await save(job);
    }
    const upload=await request(path+'/'+encodeURIComponent(item.remoteId)+'/upload');const target=signedURL(upload.upload_url);
    let response;try{response=await fetcher(target,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(120000),headers:{'Content-Type':item.type}});}catch{throw new D.Problem(502,'Dateiübertragung unterbrochen. Die Übertragung derselben Datei kann wiederholt werden.');}D.assert(response.ok,'Originaldatei wurde von autoiXpert noch nicht bestätigt.',502);item.done=true;job.state='ready';job.error=null;await save(job);
   }
   if(job.files.every(f=>f.done)){job.state='complete';await tx(async s=>{const c=await caseAccess(s,user,cid);c.autoixpert={reportId:job.reportId,exportedAt:new Date().toISOString(),fileCount:job.files.length};await audit(s,user,c,'An autoiXpert übergeben',job.files.length+' Originaldateien bestätigt.',true);await s.put('autoixpert_export',job,cid);});}
   return {job:view(job)};
  }catch(e){if(job){job.state=e.uncertain||job.state==='creating'&&!e.definite?'uncertain':'error';job.error=e.message;await save(job);}throw e;}finally{running.delete(cid);if(job?.lock?.token===token)await tx(async s=>{const current=await s.get('autoixpert_export',cid);if(current?.lock?.token===token){delete current.lock;await s.put('autoixpert_export',current,cid);}});}
 }
 return {state,step};
}
module.exports={createAutoixpert,payload,signedURL};
