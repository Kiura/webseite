'use strict';
const D=require('./domain');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Preserve umlauts: MÜ and MU identify different registration districts.
const normalize=value=>String(value||'').normalize('NFC').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g,'');
function payoutCheck(c){
 const f=c.finance||{},amount=Number.isSafeInteger(f.partnerNet)&&f.partnerNet>0&&f.invoiceNet>0;
 const agreement=!!(amount&&f.agreement&&f.agreedAt),accepted=!!(agreement&&f.partnerAcceptedAt);
 const received=!!(f.invoiceGross>0&&f.received>=f.invoiceGross),report=['report_sent','closed'].includes(c.status);
 const invoice=!!f.partnerInvoiceId,approved=!!(invoice&&f.partnerInvoiceApproved),paid=!!f.paidOutAt;
 const eligible=D.payable(c)&&approved;
 return {caseID:c.id,version:c.version,amountCents:amount?f.partnerNet:null,agreement:agreement?f.agreement:null,
  canConfirm:agreement&&!accepted&&!paid,canUpload:D.payable(c)&&!invoice&&!paid,invoiceFileID:f.partnerInvoiceId||null,
  steps:[
   {id:'agreement',title:accepted?'Vergütung bestätigt':agreement?'Vergütung bitte bestätigen':'Vergütung wird kalkuliert',done:accepted},
   {id:'report',title:report?'Gutachten versandt':'Gutachtenversand offen',done:report},
   {id:'payment',title:received?'Zahlung vollständig eingegangen':'Zahlungseingang offen',done:received},
   {id:'invoice',title:invoice?'Partnerrechnung eingegangen':'Partnerrechnung fehlt',done:invoice},
   {id:'approval',title:eligible?'Zur Auszahlung freigegeben':invoice?'Abrechnung wird geprüft':'Freigabe der Abrechnung offen',done:eligible},
   {id:'paid',title:paid?'Ausgezahlt':'Auszahlung ausstehend',done:paid}
  ]};
}
const diagnosticKinds=['crash','hang','upload_network','upload_server','upload_rejected','upload_invalid','storage_failure'];
function diagnosticReport(data,now=new Date()){
 D.assert(data&&Object.keys(data).every(k=>['id','day','version','build','counts'].includes(k)),'Ungültiger Diagnosebericht.');
 D.assert(uuid.test(data.id)&&/^\d{4}-\d{2}-\d{2}$/.test(data.day),'Ungültige Diagnosekennung.');
 const date=new Date(data.day+'T00:00:00Z');
 D.assert(Number.isFinite(+date)&&date.toISOString().slice(0,10)===data.day&&+date<=+now&&+date>=+now-8*86400000,'Diagnosezeitraum abgelaufen.');
 D.assert(typeof data.version==='string'&&typeof data.build==='string'&&/^\d{1,3}(\.\d{1,3}){0,2}$/.test(data.version)&&/^\d{1,8}$/.test(data.build),'Ungültige App-Version.');
 D.assert(data.counts&&typeof data.counts==='object'&&!Array.isArray(data.counts),'Ungültige Diagnosezähler.');
 const keys=Object.keys(data.counts);
 D.assert(keys.length>0&&keys.length<=diagnosticKinds.length&&keys.every(k=>diagnosticKinds.includes(k)&&Number.isInteger(data.counts[k])&&data.counts[k]>0&&data.counts[k]<=1000),'Ungültige Diagnosezähler.');
 return {id:data.id,day:data.day,version:data.version,build:data.build,counts:{...data.counts}};
}
async function pruneDiagnostics(s,now=new Date()){
 const cutoff=new Date(+now-30*86400000).toISOString().slice(0,10);
 for(const type of ['mobile_diagnostic','mobile_diagnostic_receipt'])for(const row of await s.list(type))if(row.day<cutoff)await s.remove(type,row.id);
}
function createMobileTools({tx,body,rate}){
 async function route(path,req,a){
  const payout=/^\/mobile\/payout\/([a-f0-9-]{36})$/.exec(path);
  if(payout&&req.method==='GET')return tx(async s=>{const c=await s.get('case',payout[1]);D.assert(c&&c.companyId===a.company.id,'Fall nicht gefunden.',404);return payoutCheck(c);});
  if(path==='/mobile/duplicates'&&req.method==='POST'){
   const data=await body(req,1000);D.assert(data&&Object.keys(data).every(k=>['plate','vin','excludeID'].includes(k)),'Ungültige Fahrzeugprüfung.');
   const plate=normalize(D.text(data.plate,30)),vin=normalize(D.text(data.vin,30)),exclude=D.text(data.excludeID,36);
   D.assert(!exclude||uuid.test(exclude),'Ungültige Fallkennung.');
   return tx(async s=>{await rate(s,'mobile-duplicates:'+a.user.id,120,3600000);
    if(plate.length<3&&vin.length!==17)return {matches:[]};
    const matches=(await s.list('case',a.company.id)).filter(c=>c.companyId===a.company.id&&c.id!==exclude&&!c.deletedAt).map(c=>{
     const byPlate=plate.length>=3&&normalize(c.intake?.plate)===plate,byVIN=vin.length===17&&normalize(c.intake?.vin)===vin;
     return byPlate||byVIN?{id:c.id,reference:c.mobile?.reference||c.number,plate:c.intake?.plate||'',status:c.status,createdAt:c.createdAt||null,reason:byVIN?'vin':'plate'}:null;
    }).filter(Boolean).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    return {matches:matches.slice(0,20)};
   });
  }
  if(path==='/mobile/diagnostics'&&req.method==='POST'){
   const data=diagnosticReport(await body(req,2000));
   return tx(async s=>{await rate(s,'mobile-diagnostics:'+a.user.id,60,3600000);await pruneDiagnostics(s);
    const receiptID=D.hash(data.id),old=await s.get('mobile_diagnostic_receipt',receiptID),digest=D.hash(JSON.stringify(data));
    if(old){D.assert(old.digest===digest,'Diagnosekennung bereits verwendet.',409);return {ok:true};}
    const rowID=D.hash(data.day+':'+data.version+':'+data.build),row=await s.get('mobile_diagnostic',rowID)||{id:rowID,day:data.day,version:data.version,build:data.build,counts:{},reports:0};
    for(const [key,count]of Object.entries(data.counts))row.counts[key]=Math.min(100000000,(row.counts[key]||0)+count);
    row.reports++;await s.put('mobile_diagnostic',row);await s.put('mobile_diagnostic_receipt',{id:receiptID,day:data.day,digest});return {ok:true};
   });
  }
  return null;
 }
 return {route};
}
module.exports={normalize,payoutCheck,diagnosticReport,pruneDiagnostics,createMobileTools};
