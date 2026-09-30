'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),D=require('../portal/domain');
const {createMobilePush,createAPNs,eventKind,payload,recipient}=require('../portal/mobile-push');
function harness(){
 const records=new Map(),sent=[];
 const s={async get(type,id){return structuredClone(records.get(type+':'+id));},async put(type,row){records.set(type+':'+row.id,structuredClone(row));},async list(type){return [...records].filter(([k])=>k.startsWith(type+':')).map(([,v])=>structuredClone(v));},async remove(type,id){records.delete(type+':'+id);}};
 const user={id:D.id(),companyId:D.id(),createdAt:new Date().toISOString(),active:true,verifiedAt:new Date().toISOString(),role:'partner'},session={id:D.id(),userId:user.id,expires:Date.now()+3600000},c={id:D.id(),companyId:user.companyId,status:'accepted'};
 const transport={ready:true,answer:{status:200},async send(device,row){sent.push({device,row,payload:payload(row)});return this.answer;}};
 const push=createMobilePush({env:{},tx:fn=>fn(s),auth:async req=>{if(!req.actor)throw new D.Problem(401,'Login');return req.actor;},body:async req=>req.data,rate:async()=>{},transport});
 const actor={user,session},device={installationId:D.id(),token:'aa'.repeat(32),environment:'production',enabled:true,preferences:{requests:true,accepted:true,commission:true}};
 const register=(data=device,a=actor)=>push.route('/mobile/push/device',{method:'POST',data,actor:a});
 const event=(action='Status: Angenommen',extra={})=>push.event(s,{role:'admin'},c,{id:D.id(),action,...extra});
 async function setup(){await s.put('user',user);await s.put('company',{id:user.companyId,status:'approved'});await s.put('session',session);await s.put('case',c);await register();}
 return {s,push,transport,sent,user,session,c,actor,device,register,event,setup};
}
test('Push opt-in validates devices, preferences, environment and partner approval',async()=>{
 const h=harness();await h.setup();
 for(const data of [{...h.device,installationId:'../bad'},{...h.device,token:'secret'},{...h.device,token:'a'.repeat(33)},{...h.device,environment:'sandbox'},{...h.device,preferences:{requests:'true'}}]) await assert.rejects(h.register(data));
 await assert.rejects(h.register(h.device,{...h.actor,user:{...h.user,role:'admin'}}),{status:403});
 await h.s.put('company',{id:h.user.companyId,status:'pending'});await assert.rejects(h.register(),{status:403});
 await h.register({...h.device,enabled:false});assert.equal((await h.s.list('push_device'))[0].active,false);
 h.transport.ready=false;assert.deepEqual(await h.push.route('/mobile/push/config',{method:'GET',actor:h.actor}),{version:1,enabled:false});
});
test('Only relevant external events are queued once, with private lock-screen payloads',async()=>{
 const h=harness();await h.setup();const e={id:D.id(),action:'Status: Angenommen',note:'CUSTOMER SECRET'};
 await h.push.event(h.s,{role:'admin'},h.c,e);await h.push.event(h.s,{role:'admin'},h.c,e);
 await h.event('Nachricht',{internal:true});await h.push.event(h.s,{role:'partner'},h.c,{id:D.id(),action:'Nachricht'});await h.push.event(h.s,{role:'admin'},{...h.c,status:'draft'},{id:D.id(),action:'Nachricht'});
 await h.push.flush();assert.equal(h.sent.length,1);assert.equal((await h.s.list('push_notification'))[0].state,'sent');
 const p=h.sent[0].payload;assert.equal(p.recipient,recipient(h.user));assert.equal(p.caseID,h.c.id);assert.doesNotMatch(JSON.stringify(p),/CUSTOMER|token|amount|plate|email/);assert.deepEqual(Object.keys(p).sort(),['aps','caseID','kind','recipient','version']);
 assert.equal(eventKind({role:'admin'},h.c,{action:'Partnerrechnung freigegeben'}),null);
});
test('Queued pushes stop after opt-out, logout, suspension, account replacement or case transfer',async()=>{
 for(const mutate of [async h=>h.register({...h.device,enabled:false}),async h=>h.s.remove('session',h.session.id),async h=>h.s.put('company',{id:h.user.companyId,status:'suspended'}),async h=>h.s.put('user',{...h.user,createdAt:'2099-01-01T00:00:00Z'}),async h=>h.s.put('case',{...h.c,companyId:D.id()}),async h=>h.s.put('session',{...h.session,pendingMfa:true})]){
  const h=harness();await h.setup();await h.event();await mutate(h);await h.push.flush();assert.equal(h.sent.length,0);assert.equal((await h.s.list('push_notification'))[0].state,'cancelled');
 }
});
test('Devices from another company or with disabled event category never receive an event',async()=>{
 const h=harness();await h.setup();await h.register({...h.device,preferences:{requests:false,accepted:true,commission:true}});await h.event('Nachricht');assert.equal((await h.s.list('push_notification')).length,0);
 await h.push.event(h.s,{role:'admin'},{...h.c,companyId:D.id()},{id:D.id(),action:'Status: Angenommen'});await h.push.flush();assert.equal(h.sent.length,0);
});
test('Commission pushes require payment and approved invoice and are suppressed after payout',async()=>{
 const h=harness();await h.setup();h.c.status='report_sent';h.c.finance={partnerNet:50,agreement:'yes',agreedAt:'today',partnerAcceptedAt:'today',invoiceGross:119,received:119,partnerInvoiceApproved:true};await h.s.put('case',h.c);
 await h.event('Partnerrechnung freigegeben');assert.equal((await h.s.list('push_notification')).length,1);
 h.c.finance.paidOutAt=new Date().toISOString();await h.s.put('case',h.c);await h.push.flush();assert.equal(h.sent.length,0);
});
test('Transient APNs failures retry durably, invalid tokens deactivate and re-registration stays isolated',async()=>{
 const h=harness();await h.setup();await h.event();h.transport.answer={status:503};await h.push.flush();let row=(await h.s.list('push_notification'))[0];assert.equal(row.state,'pending');assert.equal(row.attempts,1);
 await h.push.flush();assert.equal(h.sent.length,1);row.nextAttempt=0;await h.s.put('push_notification',row);h.transport.answer={status:410,reason:'Unregistered'};await h.push.flush();assert.equal((await h.s.list('push_device'))[0].active,false);assert.equal((await h.s.list('push_notification'))[0].state,'failed');
 await h.register();const replacement={...h.device,installationId:D.id()};await h.register(replacement);assert.equal((await h.s.list('push_device')).filter(d=>d.active).length,1);
});
test('APNs uses valid ES256 token, correct topic and minimal payload, never follows HTTP redirects',async()=>{
 const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),env={APNS_TOPIC:'de.schadenakte.ios',APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_PRIVATE_KEY:pair.privateKey.export({format:'pem',type:'pkcs8'})};
 let headers,url,body;const connect=target=>{url=target;const client=new EventEmitter();client.destroy=()=>{};client.request=h=>{headers=h;const req=new EventEmitter();req.close=()=>{};req.end=bytes=>{body=JSON.parse(bytes);queueMicrotask(()=>{req.emit('response',{':status':200});req.emit('end');});};return req;};queueMicrotask(()=>client.emit('connect'));return client;};
 const apns=createAPNs(env,connect),row={apnsId:D.id(),id:D.hash('event'),caseId:D.id(),kind:'requests',recipient:D.hash('recipient')};assert.equal(apns.ready,true);assert.deepEqual(await apns.send({token:'ab'.repeat(32),environment:'production'},row),{status:200,reason:undefined});
 assert.equal(url,'https://api.push.apple.com');assert.equal(headers['apns-topic'],env.APNS_TOPIC);assert.equal(headers['apns-push-type'],'alert');assert.equal(headers['apns-collapse-id'],row.id);assert.deepEqual(body,payload(row));
 const parts=headers.authorization.slice(7).split('.');assert.deepEqual(JSON.parse(Buffer.from(parts[0],'base64url')),{alg:'ES256',kid:env.APNS_KEY_ID});assert.equal(JSON.parse(Buffer.from(parts[1],'base64url')).iss,env.APNS_TEAM_ID);assert.ok(crypto.verify('sha256',Buffer.from(parts.slice(0,2).join('.')),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));
 assert.equal(createAPNs({...env,APNS_TOPIC:'wrong'}).ready,false);assert.equal(createAPNs({...env,APNS_PRIVATE_KEY:'invalid'}).ready,false);
});

test('Chat push opens the matching conversation and keeps message and attachments off the lock screen', async()=>{
 const h=harness();await h.setup();await h.event('Nachricht',{note:'PRIVATE MESSAGE',fileIds:['private-document.pdf']});await h.push.flush();
 assert.equal(h.sent.length,1);const p=h.sent[0].payload;
 assert.equal(p.target,'chat');assert.equal(p.caseID,h.c.id);assert.equal(p.recipient,recipient(h.user));assert.equal(p.kind,'requests');
 assert.equal(p.aps.alert.body,'Eine neue Nachricht von UNFALLX wartet auf dich.');assert.doesNotMatch(JSON.stringify(p),/PRIVATE|private-document/);
});
