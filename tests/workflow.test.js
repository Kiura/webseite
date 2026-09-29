'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const D=require('../portal/domain'),{createStore}=require('../portal/store'),{createPortal}=require('../portal/app');
test('scoped requests, task privacy, upload receipts and recoverable case creation work over HTTP',async()=>{
 const env={NODE_ENV:'test',PORTAL_ORIGIN:'http://localhost',PORTAL_LOCAL_DB:':memory:'},store=await createStore(env),mail={ready:true,send:async()=>{}},portal=createPortal({env,store,mail});await portal.ready();
 const server=http.createServer((req,res)=>portal.handle(req,res,{}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 async function actor(role,companyId){const id=D.id(),token=D.random(),csrf=D.random();await store.transaction(async s=>{if(companyId)await s.put('company',{id:companyId,name:companyId,status:'approved'});await s.put('user',{id,name:role,email:id+'@example.test',role,companyId,active:true,verifiedAt:new Date().toISOString()},companyId||'internal');await s.put('session',{id:D.hash(token),userId:id,csrf,expires:Date.now()+600000},id);});return {id,cookie:'ux_session='+token,csrf};}
 async function call(path,u={},data){const r=await fetch(base+'/api/portal'+path,{method:data===undefined?'GET':'POST',headers:{Origin:env.PORTAL_ORIGIN,Cookie:u.cookie||'','X-CSRF-Token':u.csrf||'','Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,json:await r.json()};}
 try{
  const partner=await actor('partner','p'),other=await actor('partner','other'),admin=await actor('admin'),worker=await actor('appraiser');
  const requestId=D.id(),create={requestId,vehicle:'Testwagen',plate:'TEST'};
  const made=await call('/cases',partner,create),cid=made.json.case.id;
  assert.equal(made.status,200);assert.equal((await call('/cases',partner,create)).json.case.id,cid);assert.equal((await call('/cases',partner)).json.cases.length,1);
  assert.notEqual((await call('/cases',other,create)).json.case.id,cid);
  await store.transaction(async s=>{const c=await s.get('case',cid);c.status='submitted';c.assignee=worker.id;await s.put('case',c,'p');});
  async function action(u,data){const c=(await call('/cases/'+cid,admin)).json.case;return call('/cases/'+cid,u,{version:c.version,...data});}
  assert.equal((await action(partner,{action:'task',task:'private'})).status,403);
  assert.equal((await action(worker,{action:'task',task:'PRIVATE: Kalkulation prüfen',due:'2026-09-15'})).status,200);
  assert.equal((await call('/cases/'+cid,partner)).json.case.nextTask,undefined);assert(!JSON.stringify((await call('/cases',partner)).json).includes('PRIVATE'));
  assert.equal((await action(admin,{action:'task',task:'x',due:'2026-02-31'})).status,400);
  assert.equal((await action(partner,{action:'request_create',kind:'registration',note:'secret'})).status,403);
  assert.equal((await action(admin,{action:'request_create',kind:'registration',note:'Vollständig lesbar fotografieren',due:'2026-09-16'})).status,200);
  let c=(await call('/cases/'+cid,partner)).json.case;assert.equal(c.status,'needs_info');assert.equal(c.requests.length,1);const rid=c.requests[0].id;
  assert.equal((await call('/cases/'+cid,other)).status,404);
  assert.equal((await call('/cases/'+cid,partner,{action:'request_reply',requestId:rid,note:'Antwort',version:c.version-1})).status,409);
  assert.equal((await action(admin,{action:'request_create',kind:'photo',perspective:'invalid',note:'Detail'})).status,400);
  assert.equal((await action(admin,{action:'request_create',kind:'photo',perspective:'rearLeft',note:'Bitte hinten links aufnehmen'})).status,200);
  assert.equal((await call('/cases/'+cid,partner)).json.case.requests[1].perspective,'rearLeft');
  const file=D.id(),foreign=D.id();await store.transaction(async s=>{await s.put('file',{id:file,caseId:cid,kind:'registration',size:42,type:'application/pdf',name:'Schein.pdf',sha256:'a'.repeat(64)},cid);await s.put('file',{id:foreign,caseId:'other',kind:'registration',size:42},'other');});
  assert.equal((await action(partner,{action:'request_reply',requestId:rid,fileIds:[foreign]})).status,404);
  const clientReplyId=D.id();
  const responseBody={action:'request_reply',requestId:rid,fileIds:[file],note:'Ergänzt',clientReplyId};
  assert.equal((await action(partner,responseBody)).status,200);
  const responseVersion=(await call('/cases/'+cid,partner)).json.case.version;
  assert.equal((await action(partner,responseBody)).status,200);
  assert.equal((await call('/cases/'+cid,partner)).json.case.version,responseVersion);
  assert.equal((await action(partner,{...responseBody,note:'Geändert'})).status,409);
  assert.equal((await action(partner,{...responseBody,fileIds:{bad:true}})).status,400);
  assert.equal((await call('/cases/'+cid,partner)).json.case.requests[0].replies.length,1);
  c=(await call('/cases/'+cid,admin)).json.case;assert.equal(c.requests[0].state,'answered');assert.equal(c.requests[0].replies[0].fileIds[0],file);
  assert.equal((await action(partner,{action:'request_resolve',requestId:rid})).status,403);
  assert.equal((await action(worker,{action:'request_resolve',requestId:rid,note:'Lesbar und vollständig'})).status,200);
  assert.equal((await action(partner,{action:'request_reply',requestId:rid,note:'Zu spät'})).status,400);
  assert.equal((await action(admin,{action:'request_reopen',requestId:rid,note:'Rückseite fehlt'})).status,200);
  assert.equal((await action(partner,{action:'files_confirm',fileIds:[foreign]})).status,404);
  assert.equal((await action(partner,{action:'files_confirm',fileIds:{bad:true}})).status,400);
  assert.equal((await action(partner,{action:'files_confirm',fileIds:[file]})).status,200);
  const version=(await call('/cases/'+cid,partner)).json.case.version;
  assert.equal((await action(partner,{action:'files_confirm',fileIds:[file,file]})).status,200);assert.equal((await call('/cases/'+cid,partner)).json.case.version,version);
  await store.transaction(async s=>{assert.equal((await s.list('event',cid)).filter(e=>e.action==='Unterlagen ergänzt').length,1);const notifications=await s.list('notification');assert(notifications.some(n=>n.to&&n.html.includes('/requests')));assert(notifications.every(n=>!n.text.includes('PRIVATE')));});
  assert.equal((await call('/cases/'+cid+'/handover',partner)).status,403);
  const exportData=await call('/cases/'+cid+'/handover',worker);assert.equal(exportData.status,200);assert.equal(exportData.json.files[0].sha256,'a'.repeat(64));assert(!JSON.stringify(exportData.json).includes('PRIVATE'));
 }finally{await new Promise(r=>server.close(r));await portal.close();}
});

test('completed native recordings notify partner and administration once; draft updates stay silent',async()=>{
 const {createNotifications}=require('../portal/notifications'),store=await createStore({NODE_ENV:'test',PORTAL_LOCAL_DB:':memory:'}),tx=f=>store.transaction(f),notice=createNotifications({tx,mail:{ready:false},origin:'https://app.unfallx.com',rate:async()=>{},recipientOrigin:u=>u.role==='admin'?'https://admin.unfallx.com':'https://app.unfallx.com'});
 try{await tx(async s=>{for(const role of ['partner','admin'])await s.put('user',{id:role,role,companyId:role==='partner'?'co':null,email:role+'@example.test',active:true,verifiedAt:'2026-09-12'});const c={id:'native',number:'NATIVE-TEST',status:'recording',companyId:'co',intake:{}};const e={id:'event',action:'Kundenaufnahme abgeschlossen'};await notice.event(s,{role:'partner'},c,e);assert.equal((await s.list('notification')).length,0);c.status='submitted';await notice.event(s,{role:'partner'},c,e);await notice.event(s,{role:'partner'},c,e);const rows=await s.list('notification');assert.equal(rows.length,2);assert(rows.some(r=>r.to==='admin@example.test'&&r.html.includes('https://admin.unfallx.com/gutachter-portal')));assert(rows.some(r=>r.to==='partner@example.test'&&r.html.includes('https://app.unfallx.com/portal')));});}finally{await store.close();}
});
