'use strict';
// Full application handler and real SQLite/blob store; no TCP server or external services.
const {test}=require('node:test'),assert=require('node:assert/strict'),{Readable,Writable}=require('node:stream'),{finished}=require('node:stream/promises'),sharp=require('sharp');
const D=require('../portal/domain'),{createPortal}=require('../portal/app'),{createStore}=require('../portal/store');
async function fixture(t,provider='database'){
 const s3=provider==='s3'?require('./fixtures/s3').fakeS3():null;
 const store=await createStore({...(s3?require('./fixtures/s3').env:{}),NODE_ENV:'test',PORTAL_LOCAL_DB:':memory:'},s3?{fileStorage:s3.files}:{});
 const mail=[],env={NODE_ENV:'production',PORTAL_MOBILE_INTAKE_ENABLED:'true'},portal=createPortal({store,env,mail:{ready:true,send:async(to,subject,text,attachments,html)=>mail.push({to,subject,text,html})}});await portal.ready();t.after(()=>portal.close());
 const users={};for(const name of ['partner','other','pending','admin','appraiser','unassigned']){
  const role=['admin','appraiser','unassigned'].includes(name)?name==='unassigned'?'appraiser':name:'partner',companyId=role==='partner'?'company-'+name:null,token=D.random();users[name]={id:D.id(),name:'TEST '+name,email:name+'@example.test',active:true,role,companyId,createdAt:new Date().toISOString(),verifiedAt:new Date().toISOString()};
  await store.transaction(async s=>{if(companyId)await s.put('company',{id:companyId,name:'TEST Betrieb '+name,status:name==='pending'?'pending':'approved'});await s.put('user',users[name],companyId||'internal');await s.put('session',{id:D.hash(token),userId:users[name].id,csrf:'test',workspace:role==='partner'?'partner':'admin',expires:Date.now()+3600000},users[name].id);});users[name].cookie='__Host-ux_session='+token;
 }
 async function call(route,who='partner',data,extra={}){
  const u=users[who],host=u&&u.role!=='partner'?'admin.unfallx.com':'app.unfallx.com',bytes=data===undefined?null:Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data));
  const req=Readable.from(bytes?[bytes]:[]);Object.assign(req,{method:bytes?'POST':'GET',url:'/api/portal'+route,headers:{host,origin:'https://'+host,cookie:u?.cookie||'','x-csrf-token':'test','content-type':'application/json',...extra},socket:{remoteAddress:'127.0.0.1'}});
  const chunks=[],res=new Writable({write(chunk,enc,done){this.headersSent=true;chunks.push(Buffer.from(chunk));done();}});res.headers={};res.statusCode=200;res.setHeader=(k,v)=>res.headers[k]=v;res.writeHead=(status,h)=>{res.statusCode=status;Object.assign(res.headers,h);res.headersSent=true;return res;};res.setTimeout=()=>res;
  await portal.handle(req,res,{});await finished(res);const body=Buffer.concat(chunks);return {status:res.statusCode,headers:res.headers,bytes:body,json:()=>JSON.parse(body.toString())};
 }
 const read=async(cid,who='partner')=>(await call('/cases/'+cid,who)).json();
 const action=async(cid,who,data,status=200)=>{const c=(await read(cid,'admin')).case,r=await call('/cases/'+cid,who,{version:c.version,...data});assert.equal(r.status,status,r.bytes.toString());return r;};
 const upload=async(cid,who,kind,bytes,type='application/pdf',chat=false)=>{const r=await call('/cases/'+cid+'/files',who,bytes,{'content-type':type,'x-file-kind':kind,'x-file-name':'TEST.'+(type==='application/pdf'?'pdf':type==='audio/wav'?'wav':'jpg'),...(chat?{'x-chat-attachment':'1'}:{})});assert.equal(r.status,200,r.bytes.toString());return r.json().file;};
 return {store,portal,call,read,action,upload,users,mail,s3};
}
const pdf=tag=>Buffer.from('%PDF-1.4\n% FICTIONAL TEST '+tag+'\n%%EOF');
function wav(){const b=Buffer.alloc(32044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);return b;}
for(const provider of ['database','s3'])test(provider+': original bulk uploads, trash/restore, ZIP, status and independent filing through both portals',async t=>{
 const f=await fixture(t,provider),data={...require('./fixtures/intake')(),requestId:D.id()};
 const first=await f.call('/cases','partner',data);assert.equal(first.status,200);const cid=first.json().case.id;
 assert.equal((await f.call('/cases','partner',data)).json().case.id,cid);
 assert.equal((await f.call('/cases','pending',data)).status,403);assert.equal((await f.call('/cases','admin',data)).status,403);
 const originals=[];for(let i=0;i<35;i++){const bytes=await sharp({create:{width:16,height:16,channels:3,background:{r:i*5,g:30,b:40}}}).jpeg().toBuffer();const file=await f.upload(cid,'partner','photo',bytes,'image/jpeg');originals.push({file,bytes});}
 const bundle=await f.upload(cid,'partner','case_bundle',pdf('order+registration'));const before=await f.read(cid);assert.equal(before.files.length,36);
 assert.equal((await f.upload(cid,'partner','case_bundle',pdf('order+registration'))).id,bundle.id);
 assert.equal((await f.call('/cases/'+cid,'other')).status,404);assert.equal((await f.call('/files/'+bundle.id,'other')).status,404);assert.equal((await f.call('/files/'+bundle.id,null)).status,401);
 await f.action(cid,'partner',{action:'file_delete',fileId:bundle.id,confirmed:true});
 assert.equal((await f.read(cid)).files.length,35);assert.equal((await f.read(cid,'admin')).deletedFiles[0].canRestore,true);assert.equal((await f.call('/files/'+bundle.id,'admin')).status,404);
 await f.action(cid,'partner',{action:'submit'},400);
 assert.equal((await f.call('/cases/'+cid,'partner',{version:before.case.version,action:'file_restore',fileId:bundle.id,confirmed:true})).status,409);
 await f.action(cid,'partner',{action:'file_restore',fileId:bundle.id,confirmed:true});assert.deepEqual((await f.call('/files/'+bundle.id)).bytes,pdf('order+registration'));
 await f.action(cid,'partner',{action:'submit'});await f.action(cid,'partner',{action:'file_delete',fileId:bundle.id,confirmed:true},403);
 await f.action(cid,'admin',{action:'status',status:'review'});await f.action(cid,'admin',{action:'request_create',kind:'photo',note:'Fiktive Rückfrage: Detailfoto prüfen.'});
 assert.equal((await f.read(cid)).case.status,'needs_info');const request=(await f.read(cid)).case.requests[0];
 await f.action(cid,'partner',{action:'request_reply',requestId:request.id,clientReplyId:D.id(),note:'Testantwort mit Original',fileIds:[originals[0].file.id]});assert.equal((await f.read(cid,'admin')).case.requests[0].state,'answered');
 const archive=await f.call('/cases/'+cid+'/archive?scope=all','admin');assert.equal(archive.status,200);assert.equal(archive.bytes.readUInt32LE(0),0x04034b50);
 assert.equal(archive.bytes.readUInt16LE(archive.bytes.length-14),36);for(const o of originals){assert(archive.bytes.includes(o.bytes));assert.deepEqual((await f.call('/files/'+o.file.id,'admin')).bytes,o.bytes);}
 await f.call('/cases/'+cid+'/filing','partner',{folder:'deleted',version:0,confirmed:true});assert.equal((await f.call('/cases')).json().cases.length,0);assert.equal((await f.call('/cases','admin')).json().cases.length,1);
 assert.equal((await f.read(cid,'admin')).files.length,36);assert.equal((await f.call('/cases?folder=deleted')).json().cases.length,1);
 await f.call('/cases/'+cid+'/filing','partner',{folder:'active',version:1});assert.equal((await f.call('/cases')).json().cases.length,1);
 if(f.s3)assert.equal(f.s3.calls.filter(c=>c.name==='DeleteObjectCommand').length,0);
});
test('chat crosses Admin, Web and native; protected original media, replay, unread and role boundaries',async t=>{
 const f=await fixture(t),cid=(await f.call('/cases','partner',require('./fixtures/intake')())).json().case.id;
 await f.action(cid,'admin',{action:'assign',assignee:f.users.appraiser.id});await f.action(cid,'admin',{action:'status',status:'review'});
 const bytes=wav(),file=await f.upload(cid,'partner','document',bytes,'audio/wav',true),message={clientMessageId:D.id(),note:'',fileIds:[file.id]};
 const sent=await f.call('/cases/'+cid+'/messages','partner',message);assert.equal(sent.status,200,sent.bytes.toString());assert.deepEqual((await f.call('/cases/'+cid+'/messages','partner',message)).json(),sent.json());
 assert.equal((await f.call('/cases/'+cid+'/messages','partner',{...message,note:'changed'})).status,409);
 assert.equal((await f.call('/mobile/chat/config')).json().audioAttachments,true);assert.equal((await f.call('/mobile/chat/config','admin')).status,403);
 assert.deepEqual((await f.call('/files/'+file.id,'admin')).bytes,bytes);assert.equal((await f.call('/files/'+file.id,'other')).status,404);
 const summary=(await f.call('/cases','admin')).json().cases[0];assert.equal(summary.lastMessage.attachmentCount,1);assert.match(summary.lastMessage.note,/Anhang/);
 await f.action(cid,'admin',{action:'file_kind',fileId:file.id,kind:'authorization'},403);
 assert.equal((await f.call('/cases/'+cid+'/files','partner',bytes,{'content-type':'audio/wav','x-file-name':'bad.wav','x-file-kind':'document'})).status,415);
 const answerFile=await f.upload(cid,'admin','document',pdf('answer'),'application/pdf',true),answer={clientMessageId:D.id(),note:'Bitte den Anhang prüfen',fileIds:[answerFile.id]};
 const answerResponse=await f.call('/cases/'+cid+'/messages','admin',answer);assert.equal(answerResponse.status,200,answerResponse.bytes.toString());assert.equal((await f.call('/mobile/chat/inbox')).json().unreadCount,1);
 assert.equal((await f.call('/cases/'+cid+'/messages','appraiser',{clientMessageId:D.id(),note:'Gutachterantwort',fileIds:[]})).status,200);
 assert.equal((await f.call('/cases/'+cid+'/messages','unassigned',{clientMessageId:D.id(),note:'Unzulässig',fileIds:[]})).status,404);
 assert.equal((await f.call('/cases/'+cid+'/messages','partner',{clientMessageId:D.id(),note:'Fremder Anhang',fileIds:[answerFile.id]})).status,403);
 assert.equal((await f.call('/cases/'+cid+'/messages','other',answer)).status,404);
 const latest=(await f.read(cid)).events.filter(e=>e.action==='Nachricht').at(-1);assert.equal((await f.call('/cases/'+cid+'/messages/read','partner',{throughEventId:latest.id})).status,200);assert.equal((await f.call('/mobile/chat/inbox')).json().unreadCount,0);
 await f.call('/cases/'+cid+'/messages/read','partner',{throughEventId:answerResponse.json().id});assert.equal((await f.call('/mobile/chat/inbox')).json().unreadCount,0);
 const webInbox=(await f.call('/chat/inbox','admin')).json();assert.equal(webInbox.messages.length,1);assert.equal(webInbox.messages[0].caseId,cid);assert.equal(webInbox.unreadCount,2);
 assert.equal((await f.call('/chat/inbox','appraiser')).json().messages.length,1);assert.equal((await f.call('/chat/inbox','unassigned')).json().messages.length,0);assert.equal((await f.call('/chat/inbox','other')).json().messages.length,0);assert.equal((await f.call('/chat/inbox',null)).status,401);
 await f.call('/cases/'+cid+'/messages/read','admin',{throughEventId:latest.id});assert.equal((await f.call('/chat/inbox','admin')).json().unreadCount,0);
 const rows=(await f.call('/messages','admin')).json().messages;assert(rows.some(r=>r.attachmentCount===1));
 await f.store.transaction(s=>s.put('company',{id:f.users.partner.companyId,status:'suspended'}));assert.equal((await f.call('/files/'+file.id,'partner')).status,403);assert.equal((await f.call('/cases/'+cid+'/messages','partner',message)).status,403);
});
test('new native snapshots retain old first registration without changing the signed field snapshot',async t=>{
 const f=await fixture(t),cid=D.id(),authorization='Bearer '+D.random(),fields={'claimant.first':'Alex','claimant.last':'Test',plate:'TEST-UX','claimant.street':'Teststraße 1','claimant.zip':'10115','claimant.city':'Berlin'};
 const save=values=>f.call('/mobile/cases','partner',{id:cid,reference:'TEST',fields:values,fieldsHash:D.hash(JSON.stringify(values))},{authorization});
 assert.equal((await save({...fields,firstRegistration:'2019-01'})).status,200);assert.equal((await save(fields)).status,200);
 let c=(await f.read(cid,'admin')).case;assert.deepEqual(c.mobile.fields,fields);assert.equal(c.mobile.fieldsHash,D.hash(JSON.stringify(fields)));assert.equal(c.mobile.retainedFields.firstRegistration,'2019-01');
 assert.equal((await f.call('/cases/'+cid+'/handover','admin')).json().retainedNativeIntake.firstRegistration,'2019-01');
 await save({...fields,firstRegistration:''});c=(await f.read(cid,'admin')).case;assert.equal(c.mobile.retainedFields.firstRegistration,undefined);
});
test('marked copies are removable before submission; original protection and restore order stay consistent',async t=>{
 const f=await fixture(t),cid=(await f.call('/cases','partner',require('./fixtures/intake')())).json().case.id;
 const bytes=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).jpeg().toBuffer(),original=await f.upload(cid,'partner','photo',bytes,'image/jpeg'),copyId=D.id();
 await f.store.transaction(async s=>{await s.put('file',{...original,id:copyId,kind:'photo_annotation',sourceFileId:original.id},cid);await s.blob(copyId,bytes);});
 let detail=await f.read(cid);assert.equal(detail.files.find(f=>f.id===copyId).canDelete,true);assert.equal(detail.files.find(f=>f.id===original.id).canDelete,false);
 await f.action(cid,'partner',{action:'file_delete',fileId:original.id,confirmed:true},403);
 await f.action(cid,'partner',{action:'file_delete',fileId:copyId,confirmed:true});await f.action(cid,'partner',{action:'file_delete',fileId:original.id,confirmed:true});
 detail=await f.read(cid);assert.equal(detail.deletedFiles.find(f=>f.id===copyId).canRestore,false);await f.action(cid,'partner',{action:'file_restore',fileId:copyId,confirmed:true},403);
 await f.action(cid,'partner',{action:'file_restore',fileId:original.id,confirmed:true});await f.action(cid,'partner',{action:'file_restore',fileId:copyId,confirmed:true});
 await f.store.transaction(async s=>{const c=await s.get('case',cid);c.mobile={customerHandoff:{state:'active'}};await s.put('case',c,c.companyId);});detail=await f.read(cid);assert(detail.files.every(f=>!f.canDelete));assert(detail.files.every(f=>f.removalBlockedReason.includes('Kundenzugang')));
});
test('registration email, password reset, manual approval and host-bound sessions use the real auth handler',async t=>{
 const f=await fixture(t),address='fictional-new@example.test',password='Fiktiver Test Merksatz 42!',nextPassword='Neuer Test Merksatz 73!';
 const registration={email:address,password,company:'Fiktiver Testbetrieb GmbH',contact:'Alex Test',street:'Teststraße 1',postcode:'10115',city:'Berlin',phone:'030123456',type:'Werkstatt',privacy:true,terms:true};
 assert.equal((await f.call('/register',null,registration)).status,200);const mail=f.mail.find(m=>m.to===address);assert(mail);assert.match(mail.html,/logo/i);assert(mail.text.includes('https://app.unfallx.com/login#token='));
 const token=mail.text.match(/#token=([a-f0-9]+)/)[1];assert.equal((await f.call('/exchange',null,{token,password:'wrong'})).status,401);
 const exchange=await f.call('/exchange',null,{token,password});assert.equal(exchange.status,200);const cookie=exchange.headers['Set-Cookie'].split(';')[0];let me=(await f.call('/me',null,undefined,{cookie})).json();assert.equal(me.company.status,'pending');assert.equal(me.user.role,'partner');assert(!JSON.stringify(me).includes('passwordHash'));
 assert.equal((await f.call('/cases',null,require('./fixtures/intake')(),{cookie,'x-csrf-token':me.csrf})).status,403);
 assert.equal((await f.call('/admin/company','admin',{id:me.company.id,status:'approved',note:'Fiktive Testfreigabe'})).status,200);
 assert.equal((await f.call('/cases',null,require('./fixtures/intake')(),{cookie,'x-csrf-token':me.csrf})).status,200);
 const headers={cookie,host:'admin.unfallx.com',origin:'https://admin.unfallx.com'};assert.equal((await f.call('/me',null,undefined,headers)).status,403);
 assert.equal((await f.call('/password/request',null,{email:address})).status,200);const reset=f.mail.findLast(m=>m.to===address&&m.text.includes('/passwort#token='));assert.match(reset.html,/logo/i);const resetToken=reset.text.match(/#token=([a-f0-9]+)/)[1];
 assert.equal((await f.call('/password/finish',null,{token:resetToken,password:nextPassword})).status,200);assert.equal((await f.call('/me',null,undefined,{cookie})).status,401);
 assert.equal((await f.call('/password/finish',null,{token:resetToken,password:nextPassword})).status,401);assert.equal((await f.call('/password-login',null,{email:address,password})).status,401);
 const login=await f.call('/password-login',null,{email:address,password:nextPassword});assert.equal(login.status,200);assert.equal(login.json().redirect,'/portal');
 const invite=await f.call('/admin/invite','admin',{name:'Fiktiver Gutachter',email:'internal-test@example.test'});assert.equal(invite.status,200);assert.equal(invite.json().invitationSent,true);const invitation=f.mail.find(m=>m.to==='internal-test@example.test');assert(invitation.text.includes('https://admin.unfallx.com/login#token='));assert.match(invitation.html,/logo/i);
});
