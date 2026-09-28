'use strict';
const D=require('./domain');
const kinds={registration:'Fahrzeugschein ergänzen',authorization:'Unterschriebenen Auftrag ergänzen',photo:'Schadenfotos ergänzen',data:'Falldaten ergänzen',document:'Weitere Unterlagen ergänzen'};
const photoPerspectives=new Set(['frontLeft','frontRight','rearRight','rearLeft','damageOverview','damageDetail','plate','vin','odometer','other']);
function dueDate(value){if(!value)return '';D.assert(/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Bitte ein gültiges Fälligkeitsdatum wählen.');return value;}
async function apply(s,user,c,data,audit){
 const a=data.action;if(!['request_create','request_reply','request_resolve','request_reopen','task','files_confirm'].includes(a))return false;
 const internal=['admin','appraiser'].includes(user.role),now=new Date().toISOString();
 if(a==='files_confirm'){
  D.assert(Array.isArray(data.fileIds),'Bitte Dateien auswählen.');const ids=[...new Set(data.fileIds)];D.assert(ids.length>0&&ids.length<=100,'Bitte die gespeicherten Dateien bestätigen.');
  const files=await Promise.all(ids.map(id=>s.get('file',id)));D.assert(files.every(f=>f&&f.caseId===c.id&&require('./presentation').fileVisible(f,c,user)),'Datei nicht gefunden.',404);
  const key=D.hash(c.id+':'+ids.sort().join(':'));if(!await s.get('upload_receipt',key)){await s.put('upload_receipt',{id:key,caseId:c.id,fileIds:ids,at:now},c.id);await audit(s,user,c,'Unterlagen ergänzt',files.filter(f=>f.kind==='photo').length+' Fotos und '+files.filter(f=>f.kind!=='photo').length+' Dokumente vollständig gespeichert.');}
  return true;
 }
 if(a==='task'){
  D.assert(internal,'Nur intern verfügbar.',403);
  c.nextTask={text:D.text(data.task,500,true),due:dueDate(data.due),done:data.done===true,updatedAt:now};
  await audit(s,user,c,'Interne Aufgabe aktualisiert','',true);return true;
 }
 D.assert(!['closed','declined'].includes(c.status),'Der Fall ist abgeschlossen.');
 c.requests=c.requests||[];
 if(a==='request_create'){
  D.assert(internal&&c.companyId,'Nur intern für Partnerfälle verfügbar.',403);D.assert(kinds[data.kind],'Bitte eine Anforderung auswählen.');D.assert(c.requests.filter(r=>r.state!=='resolved').length<30,'Bitte zuerst bestehende Rückfragen klären.');
  const perspective=data.kind==='photo'?D.text(data.perspective,30):'';D.assert(!perspective||photoPerspectives.has(perspective),'Ungültige Fotoperspektive.');
  const request={id:D.id(),kind:data.kind,perspective:perspective||null,title:kinds[data.kind],note:D.text(data.note,2000,true),due:dueDate(data.due),state:'open',createdAt:now,createdBy:user.name,replies:[]};
  c.requests.push(request);if(!['draft','recording','ready_to_submit'].includes(c.status))c.status='needs_info';
  await audit(s,user,c,'Unterlagen angefordert',request.title+': '+request.note);return true;
 }
 const request=c.requests.find(r=>r.id===data.requestId);D.assert(request,'Rückfrage nicht gefunden.',404);
 if(a==='request_reply'){
  D.assert(user.role==='partner','Die Antwort erfolgt durch den Partner.',403);const clientReplyId=D.text(data.clientReplyId,36);D.assert(!clientReplyId||/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(clientReplyId),'Ungültige Antwortkennung.');
  D.assert(data.fileIds===undefined||Array.isArray(data.fileIds),'Bitte eine Dateiliste senden.');
  const previous=clientReplyId&&request.replies.find(r=>r.clientReplyId===clientReplyId);
  if(previous){D.assert(previous.note===D.text(data.note,2000)&&JSON.stringify([...previous.fileIds].sort())===JSON.stringify([...new Set(data.fileIds||[])].sort()),'Diese Antwortkennung wurde bereits verwendet.',409);return true;}
  D.assert(request.state!=='resolved','Diese Rückfrage wurde bereits erledigt.');
  const note=D.text(data.note,2000),ids=[...new Set(Array.isArray(data.fileIds)?data.fileIds:[])];D.assert(note||ids.length,'Bitte eine Antwort oder Unterlagen ergänzen.');D.assert(ids.length<=100,'Zu viele Dateien.');
  const files=await Promise.all(ids.map(id=>s.get('file',id)));D.assert(files.every(f=>f&&!f.deletedAt&&f.caseId===c.id&&!['report','partner_invoice'].includes(f.kind)),'Unterlage nicht gefunden.',404);
  D.assert(request.replies.length<50,'Bitte UNFALLX direkt kontaktieren.');request.replies.push({id:D.id(),clientReplyId:clientReplyId||null,note,fileIds:ids,at:now,actor:user.name});request.state='answered';
  await audit(s,user,c,'Rückfrage beantwortet',request.title);return true;
 }
 D.assert(internal,'Nur UNFALLX kann Rückfragen abschließen.',403);D.assert(a==='request_reopen'||request.state!=='resolved','Rückfrage bereits erledigt.');
 request.state=a==='request_resolve'?'resolved':'open';request.reviewNote=D.text(data.note,2000);request.reviewedAt=now;
 await audit(s,user,c,a==='request_resolve'?'Rückfrage erledigt':'Rückfrage erneut geöffnet',request.title+(request.reviewNote?': '+request.reviewNote:''));return true;
}
module.exports={apply,kinds,dueDate};
