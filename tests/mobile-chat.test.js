'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../portal/domain'),{createStore}=require('../portal/store'),{createPortal}=require('../portal/app');
test('Durable chat HTTP: PDF upload, replay, unread and tenant isolation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ux-chat-')),env={NODE_ENV:'test',PORTAL_LOCAL_DB:path.join(dir,'chat.sqlite'),PORTAL_ORIGIN:'http://localhost'};
 const store=await createStore(env),companyId=D.id(),otherCompany=D.id(),caseId=D.id(),otherCase=D.id(),user={id:D.id(),name:'Partner Test',role:'partner',active:true,verifiedAt:new Date().toISOString(),createdAt:new Date().toISOString(),companyId};
 const secret=D.random(),csrf=D.random();
 await store.transaction(async s=>{await s.put('user',user,companyId);await s.put('company',{id:companyId,status:'approved'});await s.put('session',{id:D.hash(secret),userId:user.id,csrf,expires:Date.now()+3600000},user.id);for(const [id,company]of [[caseId,companyId],[otherCase,otherCompany]])await s.put('case',{id,number:'UX-TEST',companyId:company,intake:{plate:'B TEST 42'},status:'review',version:1},company);});
 const portal=createPortal({env,store,mail:{ready:false,send:async()=>{throw new Error('No email in test');}}});await portal.ready();
 const server=http.createServer((req,res)=>portal.handle(req,res,{}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(route,data,headers={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/portal'+route,{method:data===undefined?'GET':'POST',headers:{Origin:env.PORTAL_ORIGIN,Cookie:'ux_session='+secret,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)});return {status:response.status,json:await response.json()};};
 try {
  await t.test('Contract and existing intake restrictions',async()=>{assert.equal((await call('/mobile/chat/config')).json.version,1);assert.equal((await call('/cases/'+caseId+'/files',Buffer.from('%PDF-1.4\n%%EOF'),{'Content-Type':'application/pdf','X-File-Kind':'document','X-File-Name':'test.pdf'})).status,400);});
  let fileId,job={clientMessageId:D.id(),note:'Bitte PDF prüfen.',fileIds:[]};
  await t.test('PDF upload during review and deduplication',async()=>{
   const headers={'Content-Type':'application/pdf','X-File-Kind':'document','X-File-Name':'Chat-Test.pdf','X-Chat-Attachment':'1'},bytes=Buffer.from('%PDF-1.4\n%%EOF');
   const first=await call('/cases/'+caseId+'/files',bytes,headers),second=await call('/cases/'+caseId+'/files',bytes,headers);assert.equal(first.status,200,JSON.stringify(first.json));assert.equal(first.json.file.chatAttachment,true);assert.equal(second.json.file.id,first.json.file.id);fileId=first.json.file.id;job.fileIds=[fileId];assert.equal((await call('/cases/'+otherCase+'/files',bytes,headers)).status,404);
  });
  await t.test('Lost-ack replay creates exactly one event and rejects changed payload',async()=>{
   const first=await call('/cases/'+caseId+'/messages',job);assert.equal(first.status,200,JSON.stringify(first.json));assert.deepEqual((await call('/cases/'+caseId+'/messages',job)).json,first.json);assert.equal((await call('/cases/'+caseId+'/messages',{...job,note:'changed'})).status,409);
   const detail=await call('/cases/'+caseId),events=detail.json.events.filter(e=>e.action==='Nachricht');assert.equal(events.length,1);assert.deepEqual(events[0].fileIds,[fileId]);assert.equal(events[0].actorId,user.id);
  });
  await t.test('Invalid attachments, cross-tenant access, CSRF and limits',async()=>{
   assert.equal((await call('/cases/'+caseId+'/messages',{...job,clientMessageId:D.id(),fileIds:[D.id()]})).status,403);assert.equal((await call('/cases/'+caseId+'/messages',{...job,clientMessageId:D.id(),fileIds:Array(7).fill(fileId)})).status,400);assert.equal((await call('/cases/'+caseId+'/messages',{...job,clientMessageId:D.id()},{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await call('/cases/'+otherCase+'/messages',job)).status,404);assert.equal((await call('/cases/'+caseId+'/messages',{clientMessageId:D.id(),note:'',fileIds:[]})).status,400);
  });
  await t.test('Read cursors exclude own/internal messages and preserve newer replies',async()=>{
   const events=[{id:D.id(),actorId:'admin',sequence:100},{id:D.id(),actorId:'admin',sequence:101},{id:D.id(),actorId:'admin',sequence:102,internal:true}];await store.transaction(async s=>{for(const e of events)await s.put('event',{actor:'UNFALLX',action:'Nachricht',note:'Antwort',at:new Date().toISOString(),caseId,...e},caseId);});
   assert.equal((await call('/mobile/chat/inbox')).json.unreadCount,2);assert.equal((await call('/cases/'+caseId+'/messages/read',{throughEventId:events[0].id})).status,200);assert.equal((await call('/mobile/chat/inbox')).json.unreadCount,1);assert.equal((await call('/cases/'+caseId+'/messages/read',{throughEventId:events[2].id})).status,404);await call('/cases/'+caseId+'/messages/read',{throughEventId:events[1].id});await call('/cases/'+caseId+'/messages/read',{throughEventId:events[0].id});assert.equal((await call('/mobile/chat/inbox')).json.unreadCount,0);
  });
  await t.test('Suspension immediately blocks reads and replay',async()=>{await store.transaction(s=>s.put('company',{id:companyId,status:'suspended'}));assert.equal((await call('/mobile/chat/inbox')).status,403);assert.equal((await call('/cases/'+caseId+'/messages',job)).status,403);});
 } finally {await new Promise(r=>server.close(r));await portal.close();fs.rmSync(dir,{recursive:true,force:true});}
});
