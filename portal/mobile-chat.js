'use strict';
const D=require('./domain'),{fileVisible}=require('./presentation');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const publicMessage=e=>!e.internal&&e.action==='Nachricht';
const identity=u=>D.hash([u.id,u.companyId||'',u.createdAt||''].join(':'));
function createMobileChat({tx,caseAccess,visible,audit,rate}) {
 async function approved(s,user){D.assert(user.role==='partner'&&(await s.get('company',user.companyId))?.status==='approved','Nur für freigeschaltete Partner.',403);}
 const readKey=(u,c)=>D.hash(identity(u)+':'+c.id);
 async function route(path,req,user,data){
  if(path==='/mobile/chat/config'&&req.method==='GET')return tx(async s=>{await approved(s,user);return {version:1,maxAttachments:6,maxBytes:25*1024*1024};});
  if(path==='/mobile/chat/inbox'&&req.method==='GET')return tx(async s=>{
   await approved(s,user);const conversations=[];let unreadCount=0;
   for(const c of (await s.list('case',user.companyId)).filter(c=>visible(user,c))){
    const events=(await s.list('event',c.id)).filter(publicMessage).sort((a,b)=>a.at.localeCompare(b.at)||(a.sequence||0)-(b.sequence||0)||a.id.localeCompare(b.id));
    const latest=events.at(-1);if(!latest)continue;
    const read=await s.get('chat_read',readKey(user,c));
    const unread=events.filter(e=>e.actorId&&e.actorId!==user.id&&(e.sequence||0)>(read?.sequence||0)).length;unreadCount+=unread;
    conversations.push({id:latest.id,caseId:c.id,caseNumber:c.number,vehicle:c.intake.vehicle||'',plate:c.intake.plate||'',actor:latest.actor,note:latest.note||'',at:latest.at,unread,attachmentCount:latest.fileIds?.length||0});
   }
   return {version:1,unreadCount,messages:conversations.sort((a,b)=>b.at.localeCompare(a.at)||a.caseId.localeCompare(b.caseId))};
  });
  const match=path.match(/^\/cases\/([a-f0-9-]{36})\/messages(\/read)?$/);if(!match||req.method!=='POST')return undefined;
  return tx(async s=>{
   await approved(s,user);const c=await caseAccess(s,user,match[1]);
   if(match[2]){
    D.assert(uuid(data.throughEventId),'Ungültige Lesemarkierung.');const event=await s.get('event',data.throughEventId);
    D.assert(event&&event.caseId===c.id&&publicMessage(event),'Nachricht nicht gefunden.',404);
    const key=readKey(user,c),old=await s.get('chat_read',key);
    await s.put('chat_read',{id:key,caseId:c.id,userId:user.id,sequence:Math.max(old?.sequence||0,event.sequence||0),at:new Date().toISOString()},user.id);return {ok:true};
   }
   D.assert(uuid(data.clientMessageId),'Ungültige Nachrichtenkennung.');const note=D.text(data.note,4000);
   D.assert(Array.isArray(data.fileIds)&&data.fileIds.length<=6&&data.fileIds.every(uuid)&&new Set(data.fileIds).size===data.fileIds.length,'Ungültige Anhänge.');
   D.assert(note||data.fileIds.length,'Bitte Nachricht oder Anhang ergänzen.');
   const key=D.hash(identity(user)+':'+c.id+':'+data.clientMessageId),fingerprint=D.hash(JSON.stringify([note,[...data.fileIds].sort()]));
   const prior=await s.get('chat_receipt',key);
   if(prior){D.assert(prior.fingerprint===fingerprint,'Diese Nachrichtenkennung wurde bereits für einen anderen Inhalt verwendet.',409);return {ok:true,id:prior.eventId,caseId:c.id,clientMessageId:data.clientMessageId};}
   await rate(s,'chat-send:'+user.id,120);
   for(const id of data.fileIds){const file=await s.get('file',id);D.assert(file&&file.caseId===c.id&&fileVisible(file,c,user)&&file.chatAttachment===true&&file.uploadedBy===user.id,'Anhang ist nicht verfügbar oder gehört zu einem anderen Fall.',403);}
   const event=await audit(s,user,c,'Nachricht',note,false,{clientMessageId:data.clientMessageId,fileIds:data.fileIds});
   await s.put('chat_receipt',{id:key,caseId:c.id,eventId:event.id,fingerprint,at:event.at},c.id);
   return {ok:true,id:event.id,caseId:c.id,clientMessageId:data.clientMessageId};
  });
 }
 return {route};
}
module.exports={createMobileChat};
