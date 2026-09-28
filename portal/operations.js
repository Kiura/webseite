'use strict';
const D=require('./domain');
const {storageConfig}=require('./file-storage');
const {classifyDeliveryError}=require('./mail');
const deadline=(promise,ms=3000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CHECK_TIMEOUT')),ms);Promise.resolve(promise).then(resolve,reject).finally(()=>clearTimeout(timer));});
function createOperations({tx,db,env,mail,storage,rate,oauth}){
 const recent=new Map();let probing=null;
 async function record(id,ok,kind='connection',detail=''){
  const at=new Date().toISOString(),local={id,ok,kind,checkedAt:at,detail};recent.set(id,local);
  try{await tx(async s=>{const old=await s.get('system_status',id)||{};await s.put('system_status',{...old,...local,lastSuccessAt:ok?at:old.lastSuccessAt||null,lastFailureAt:ok?old.lastFailureAt||null:at});});}catch{/* An unavailable database must not turn a successful external operation into a retry. */}
 }
 async function readiness(){if(probing)return probing;probing=(async()=>{try{await deadline((async()=>{const s=await db();await s.ping();})());recent.set('mysql',{id:'mysql',ok:true,kind:'query',checkedAt:new Date().toISOString()});return true;}catch{recent.set('mysql',{id:'mysql',ok:false,kind:'query',checkedAt:new Date().toISOString(),detail:'Datenbankabfrage nicht rechtzeitig bestätigt.'});return false;}finally{probing=null;}})();return probing;}
 async function observe(id,kind,fn){let result;try{result=await fn();}catch(e){if(!e.status||e.status>=500)void record(id,false,kind,id==='smtp'?(classifyDeliveryError(e)==='definite'?'Mailserver hat den Versand nicht angenommen.':'SMTP-Annahme unklar; vor Wiederholung prüfen.'):'Verbindung oder Dateiintegrität nicht bestätigt.');throw e;}void record(id,true,kind);return result;}
 async function overview(){
  await readiness();
  const mobileDiagnostics=await tx(async s=>{await require('./mobile-tools').pruneDiagnostics(s);return (await s.list('mobile_diagnostic')).sort((a,b)=>b.day.localeCompare(a.day));});
  const saved=await tx(async s=>({statuses:await s.list('system_status'),notices:await s.list('notification'),backups:await s.get('system','backup-plan'),contacts:await s.list('contact_request'),exports:await s.list('autoixpert_export')}));
  const completed=saved.exports.filter(j=>j.state==='complete').sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))[0];if(completed&&!saved.statuses.some(r=>r.id==='autoixpert'))saved.statuses.push({id:'autoixpert',ok:true,kind:'export',checkedAt:completed.updatedAt,lastSuccessAt:completed.updatedAt});
  const sf=storageConfig(env),providers=oauth.config();
  const list=[
   ['mysql','Hostinger · MySQL',!!(env.DB_NAME&&env.DB_USER&&env.DB_PASSWORD)||env.NODE_ENV==='test','Aktuelle kurze Datenbankabfrage. Bei Fehlern Hostinger-Datenbank und App-Protokoll prüfen.','mysql'],
   ['s3',sf.backend==='s3'?'AWS S3 · Originaldateien':'Datenbank · Originaldateien',sf.backend==='database'||['PORTAL_S3_BUCKET','PORTAL_S3_REGION','PORTAL_S3_ACCOUNT_ID','PORTAL_S3_ACCESS_KEY_ID','PORTAL_S3_SECRET_ACCESS_KEY'].every(k=>!!env[k]),'Schreiben, Zurücklesen und Prüfsumme testen. Die Bereinigung läuft separat und wird bei Störungen wiederholt.','s3'],
   ['smtp','E-Mail-Versand',mail.ready,'Verbindungstest sendet keine E-Mail. SMTP-Annahme ist kein Nachweis für die Zustellung im Posteingang.','smtp'],
   ['google','Google-Anmeldung',providers.find(x=>x.id==='google')?.enabled,'Beide Rücksprungadressen in Google Cloud abgleichen und Anmeldung je Portal testen.',null],
   ['apple','Apple-Anmeldung',providers.find(x=>x.id==='apple')?.enabled,'Optional. Erst nach vollständiger Einrichtung im Login verfügbar.',null],
   ['sms','SMS-Verifizierung',env.SMS_PROVIDER==='seven'&&!!env.SEVEN_API_KEY&&!!env.PORTAL_OTP_SECRET,'Optional. Einrichtung und kontrollierter Versandtest erforderlich; hier wird keine SMS versandt.',null],
   ['autoixpert','autoiXpert',!!env.AUTOIXPERT_API_KEY&&!!env.AUTOIXPERT_ASSESSOR_ID,'Fall intern prüfen und Übergabe aus der Fallakte starten. Hier wird kein kostenpflichtiger Test ausgelöst.',null]
  ];
  const services=list.map(([id,name,configured,nextStep,test])=>{const prior=saved.statuses.find(x=>x.id===id)||{},latest=recent.get(id)||prior;return {id,name,configured:!!configured,test,checkedAt:latest.checkedAt||null,lastSuccessAt:latest.ok?latest.checkedAt:prior.lastSuccessAt||null,lastFailureAt:!latest.ok&&latest.checkedAt?latest.checkedAt:prior.lastFailureAt||null,ok:typeof latest.ok==='boolean'?latest.ok:null,kind:latest.kind||null,error:latest.ok?null:latest.detail||null,nextStep};});
  const queue={pending:0,sending:0,uncertain:0,failed:0,sent:0};for(const n of saved.notices)if(Object.hasOwn(queue,n.state))queue[n.state]++;
  return {mobileDiagnostics,services,queue,storage:await storage.overview(),openContacts:saved.contacts.filter(c=>c.state!=='done').length,backups:saved.backups||null,callbacks:['https://app.unfallx.com/api/portal/oauth/google/callback','https://admin.unfallx.com/api/portal/oauth/google/callback'],responsibility:'UNFALLX Administration · Hosting und Dienstkonten im Firmenzugang verwalten.'};
 }
 async function check(user,service){D.assert(user.role==='admin','Nur die Administration darf Verbindungen prüfen.',403);D.assert(['mysql','s3','smtp'].includes(service),'Unbekannte Prüfung.');await tx(s=>rate(s,'system-check:'+user.id+':'+service,6));
  if(service==='mysql'){const ok=await readiness();if(ok)await record('mysql',true,'query');return {ok,message:ok?'Datenbankabfrage erfolgreich.':'Datenbank aktuell nicht erreichbar.'};}
  if(service==='s3')return observe('s3','write-read-sha256',()=>storage.check(user));
  D.assert(mail.ready,'SMTP ist noch nicht eingerichtet.',409);D.assert(mail.verify,'Verbindungstest nicht verfügbar.',409);await observe('smtp','connection',()=>deadline(mail.verify(),15000));return {ok:true,message:'SMTP-Verbindung und Zugang bestätigt. Es wurde keine E-Mail gesendet.'};
 }
 async function backupPlan(user,data){D.assert(user.role==='admin','Nur die Administration darf Sicherungsangaben pflegen.',403);const row={id:'backup-plan',owner:D.text(data.owner,120,true),interval:D.text(data.interval,120,true),retention:D.text(data.retention,160,true),rpo:D.text(data.rpo,120,true),rto:D.text(data.rto,120,true),evidence:D.text(data.evidence,1500),updatedAt:new Date().toISOString(),updatedBy:user.id};await tx(s=>s.put('system',row));return {message:'Betriebsangaben gespeichert. Dies ersetzt keinen durchgeführten Wiederherstellungstest.'};}
 return {readiness,observe,overview,check,record,backupPlan};
}
module.exports={createOperations,deadline};
