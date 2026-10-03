/* Aggregates the authenticated portal records for the internal Zentrale.
   No demo totals or browser-side persistence are used. */
(function(root){
'use strict';
const activeStatuses=new Set(['submitted','review','needs_info','accepted','in_progress','report_ready','report_sent']);
const deliveredStatuses=new Set(['report_sent','closed']);
const completedStatuses=new Set(['report_ready','report_sent','closed']);
const cents=value=>Number.isFinite(Number(value))?Math.max(0,Math.round(Number(value))):0;
const timestamp=value=>{const n=Date.parse(value||'');return Number.isFinite(n)?n:0;};
function monthKeys(now,count=6){const d=new Date(now);if(!Number.isFinite(d.getTime()))throw new TypeError('Ungültiges Datum');return Array.from({length:count},(_,i)=>new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-count+1+i,1)).toISOString().slice(0,7));}
function analyze(input={}){
 const now=input.now||new Date(),year=new Date(now).getUTCFullYear(),months=monthKeys(now).map(month=>({month,created:0,submitted:0,reports:0,paidCents:0}));
 const companyMap=new Map((input.companies||[]).map(c=>[c.id,c]));
 const lawyerMap=new Map((input.lawyers||[]).map(l=>[l.id,l]));
 const cases=(input.cases||[]).filter(c=>c&&(c.filing?.folder||'active')!=='deleted');
 const partnerMap=new Map(),lawyerStats=new Map();
 for(const company of companyMap.values())partnerMap.set(company.id,{id:company.id,name:company.name||'Unbenannter Partner',type:company.type||'Sonstiges Unternehmen',status:company.status||'pending',city:company.city||'',cases:0,yearCases:0,active:0,completed:0,rejected:0,commissionAgreedCents:0,commissionOpenCents:0,commissionPaidCents:0,lastCaseAt:null});
 for(const lawyer of lawyerMap.values())lawyerStats.set(lawyer.id,{id:lawyer.id,name:lawyer.name||'Kanzlei',status:lawyer.status||'pending',assigned:0,sent:0,closed:0,lastSentAt:null});
 const totals={cases:cases.length,active:0,completed:0,delivered:0,rejected:0,agreedCents:0,openCents:0,paidCents:0,invoiceGrossCents:0,receivedCents:0,unpaidHonorarCents:0,invoiceReview:0,payoutReady:0};
 const byStatus={};
 for(const c of cases){
  const status=String(c.status||'draft'),created=timestamp(c.createdAt),updated=timestamp(c.updatedAt||c.createdAt),submitted=timestamp(c.submittedAt),ready=timestamp(c.reportReadyAt),paid=timestamp(c.finance?.paidOutAt),net=cents(c.finance?.partnerNet),agreed=!!c.finance?.agreedAt;
  byStatus[status]=(byStatus[status]||0)+1;
  if(activeStatuses.has(status))totals.active++;
  if(completedStatuses.has(status))totals.completed++;
  if(deliveredStatuses.has(status))totals.delivered++;
  if(status==='declined')totals.rejected++;
  if(agreed){totals.agreedCents+=net;totals[paid?'paidCents':'openCents']+=net;}
  if(c.finance?.partnerInvoiceId&&!c.finance?.partnerInvoiceApproved)totals.invoiceReview++;
  if(c.finance?.partnerInvoiceApproved&&!paid)totals.payoutReady++;
  const gross=cents(c.finance?.invoiceGross),received=cents(c.finance?.received);
  totals.invoiceGrossCents+=gross;totals.receivedCents+=received;totals.unpaidHonorarCents+=Math.max(0,gross-received);
  for(const m of months){if(c.createdAt?.startsWith(m.month))m.created++;if(c.submittedAt?.startsWith(m.month))m.submitted++;if(c.reportReadyAt?.startsWith(m.month))m.reports++;if(c.finance?.paidOutAt?.startsWith(m.month))m.paidCents+=net;}
  if(c.companyId){let p=partnerMap.get(c.companyId);if(!p){p={id:c.companyId,name:c.companyName||'Ehemaliger Partner',type:'Sonstiges Unternehmen',status:'archived',city:'',cases:0,yearCases:0,active:0,completed:0,rejected:0,commissionAgreedCents:0,commissionOpenCents:0,commissionPaidCents:0,lastCaseAt:null};partnerMap.set(c.companyId,p);}p.cases++;if(submitted&&new Date(submitted).getUTCFullYear()===year)p.yearCases++;if(activeStatuses.has(status))p.active++;if(completedStatuses.has(status))p.completed++;if(status==='declined')p.rejected++;if(agreed){p.commissionAgreedCents+=net;p[paid?'commissionPaidCents':'commissionOpenCents']+=net;}if(updated>timestamp(p.lastCaseAt))p.lastCaseAt=new Date(updated).toISOString();}
  if(c.lawyerId){let l=lawyerStats.get(c.lawyerId);if(!l){l={id:c.lawyerId,name:c.lawyerHandoff?.name||'Ehemalige Kanzlei',status:'archived',assigned:0,sent:0,closed:0,lastSentAt:null};lawyerStats.set(c.lawyerId,l);}l.assigned++;if(deliveredStatuses.has(status))l.sent++;if(status==='closed')l.closed++;const sentAt=c.dispatch?.at||c.lawyerHandoff?.sentAt;if(timestamp(sentAt)>timestamp(l.lastSentAt))l.lastSentAt=sentAt;}
 }
 const partners=[...partnerMap.values()].sort((a,b)=>b.yearCases-a.yearCases||b.completed-a.completed||a.name.localeCompare(b.name,'de'));
 const lawyers=[...lawyerStats.values()].sort((a,b)=>b.sent-a.sent||b.assigned-a.assigned||a.name.localeCompare(b.name,'de'));
 const activePartners=partners.filter(p=>p.status==='approved').length;
 return {year,months,totals,byStatus,partners,lawyers,activePartners,pendingPartners:partners.filter(p=>p.status==='pending').length};
}
function inspectionWeek(records,anchor=new Date()){
 const current=new Date(anchor);if(!Number.isFinite(current.getTime()))throw new TypeError('Ungültiges Datum');
 current.setHours(12,0,0,0);current.setDate(current.getDate()-(current.getDay()+6)%7);
 const days=Array.from({length:7},(_,i)=>{const date=new Date(current);date.setDate(current.getDate()+i);return {date:[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-'),cases:[]};});
 const byDate=new Map(days.map(day=>[day.date,day]));
 for(const c of records||[]){if((c?.filing?.folder||'active')==='deleted')continue;const day=byDate.get(c?.intake?.inspectionDate);if(day)day.cases.push(c);}
 for(const day of days){day.cases.sort((a,b)=>String(a.intake?.inspectionTime||'').localeCompare(String(b.intake?.inspectionTime||''))||String(a.number||'').localeCompare(String(b.number||'')));const hall=day.cases.map(c=>c.intake).filter(i=>/halle/i.test(i.inspectionAddressExtra||'')||/lübarser/i.test(i.inspectionStreet||'')&&/^25\b/.test(i.inspectionHouseNumber||'')),times=hall.map(i=>String(i.inspectionTime||'').match(/^([01]\d|2[0-3]):([0-5]\d)$/)).filter(Boolean).map(m=>Number(m[1])*60+Number(m[2]));day.hallAppointments=hall.length;day.hallPeak=times.reduce((peak,start)=>Math.max(peak,times.filter(t=>t<=start&&t+60>start).length),0);}
 return days;
}
function inspectionIcs(records){
 const line=v=>String(v??'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g,ch=>'\\'+ch);
 const events=[];for(const c of records||[]){const i=c?.intake||{};if((c?.filing?.folder||'active')==='deleted'||!/^\d{4}-\d{2}-\d{2}$/.test(i.inspectionDate||''))continue;const start=(i.inspectionTime||'09:00').match(/^([01]\d|2[0-3]):([0-5]\d)$/);if(!start)continue;const date=new Date(i.inspectionDate+'T'+start[0]+':00');if(!Number.isFinite(date.getTime()))continue;const end=new Date(date.getTime()+60*60*1000),stamp=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('')+'T'+[String(d.getHours()).padStart(2,'0'),String(d.getMinutes()).padStart(2,'0'),'00'].join('');const address=[i.inspectionStreet,i.inspectionHouseNumber,i.inspectionPostcode,i.inspectionCity].filter(Boolean).join(' ');events.push(['BEGIN:VEVENT','UID:'+line(c.id||c.number)+'@unfallx.com','DTSTART;TZID=Europe/Berlin:'+stamp(date),'DTEND;TZID=Europe/Berlin:'+stamp(end),'SUMMARY:'+line('Besichtigung · '+(i.plate||c.number||'Fall')),'DESCRIPTION:'+line('UNFALLX Fall '+(c.number||'')),'LOCATION:'+line(address),'END:VEVENT'].join('\r\n'));}
 return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//UNFALLX//Besichtigungen//DE','CALSCALE:GREGORIAN',...events,'END:VCALENDAR',''].join('\r\n');
}
const api={analyze,monthKeys,inspectionWeek,inspectionIcs};
if(typeof module==='object'&&module.exports)module.exports=api;
if(root)root.UnfallxZentraleData=api;
})(typeof window!=='undefined'?window:null);
