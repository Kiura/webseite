'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const D=require('../portal/domain'),P=require('../portal/passwords'),{createPortal}=require('../portal/app'),{createStore}=require('../portal/store'),{verifyIdentity}=require('../portal/oauth');
const password='Dies ist mein sicherer Test Merksatz!';
async function harness(config={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ux-auth4-')),env={NODE_ENV:'test',PORTAL_LOCAL_DB:path.join(dir,'test.sqlite'),PORTAL_ORIGIN:'http://localhost',PORTAL_TRUST_PROXY:'true',...config};const messages=[];let fail=false;const mail={ready:true,send:async(to,subject,text,attachments,html,messageId)=>{if(fail)throw Error('TEST_SMTP_UNCERTAIN');messages.push({to,subject,text,html,messageId});}};const store=await createStore(env),portal=createPortal({env,store,mail});await portal.ready();const server=http.createServer((req,res)=>portal.handle(req,res,{}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let n=0;
 async function call(route,data,actor={},more={}){const res=await fetch(base+'/api/portal'+route,{method:data===undefined?'GET':'POST',headers:{Origin:env.PORTAL_ORIGIN,'Content-Type':'application/json','X-Forwarded-For':'test-'+(++n),...(actor.cookie?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf||''}:{}),...(more.headers||{})},body:data===undefined?undefined:JSON.stringify(data),redirect:'manual'});return {status:res.status,json:res.headers.get('content-type')?.includes('json')?await res.json():{},cookie:res.headers.get('set-cookie'),location:res.headers.get('location')};}
 async function actor(response){assert.equal(response.status,200,JSON.stringify(response.json));const a={cookie:response.cookie.split(';')[0]};const me=await call('/me',undefined,a);return {...a,csrf:me.json.csrf,user:me.json.user,company:me.json.company};}
 async function register(email,extra={}){const r=await call('/register',{email,company:'Testbetrieb GmbH',contact:'Testpartner',street:'Teststraße 1',postcode:'10115',city:'Berlin',type:'Werkstatt',phone:'030123456',privacy:true,terms:true,password,...extra});assert.equal(r.status,200,JSON.stringify(r.json));const token=messages.findLast(m=>m.to===email).text.match(/#token=([a-f0-9]+)/)[1];const a=await actor(await call('/exchange',{token,password}));await store.transaction(async s=>{const co=await s.get('company',a.user.companyId);co.status='approved';await s.put('company',co);});return a;}
 async function admin(){await call('/login',{email:'info@unfallx.com'});const token=messages.findLast(m=>m.to==='info@unfallx.com').text.match(/#token=([a-f0-9]+)/)[1];return actor(await call('/exchange',{token}));}
 async function drain(){for(let i=0;i<100;i++){const rows=await store.transaction(s=>s.list('notification'));if(!rows.some(r=>['pending','sending'].includes(r.state)))return;await new Promise(r=>setTimeout(r,10));}assert.fail('outbox did not drain');}
 return {env,store,portal,base,call,actor,register,admin,messages,drain,fail(value){fail=value;},async close(){await drain();await new Promise(r=>server.close(r));await portal.close();fs.rmSync(dir,{recursive:true,force:true});}};}


test('Partner deletion uses fresh proof, owner isolation, cancellation and actual credential erasure',async()=>{
 const h=await harness();try{
  const a=await h.register('delete-me@example.com'),b=await h.register('keep-me@example.com'),admin=await h.admin();
  assert.equal((await h.call('/account/deletion')).status,401);
  assert.equal((await h.call('/account/deletion',undefined,a)).json.request,null);
  assert.equal((await h.call('/account/deletion',{confirmed:true,email:a.user.email},{cookie:a.cookie,csrf:'bad'})).status,403);
  assert.equal((await h.call('/account/deletion',{confirmed:true,email:b.user.email},a)).status,400);
  const first=await h.call('/account/deletion',{confirmed:true,email:a.user.email},a);assert.equal(first.status,200);
  const repeat=await h.call('/account/deletion',{confirmed:true,email:a.user.email},a);assert.equal(first.json.request.id,repeat.json.request.id);
  assert.equal((await h.call('/account/deletion/cancel',{id:first.json.request.id},b)).status,404);
  assert.equal((await h.call('/admin/account-deletions',undefined,a)).status,403);
  assert.equal((await h.call('/account/deletion/cancel',{id:first.json.request.id},a)).status,200);
  const requested=await h.call('/account/deletion',{confirmed:true,email:a.user.email},a);
  const requestID=requested.json.request.id;
  const token='b'.repeat(64);await h.store.transaction(async s=>{
   await s.put('token',{id:D.hash(token),email:a.user.email,expires:Date.now()+60000},a.user.email);
   await s.put('password_token',{id:'password-token',userId:a.user.id,expires:Date.now()+60000},a.user.id);
   await s.put('identity',{id:'google-mapping',provider:'google',userId:a.user.id},a.user.id);
   await s.put('chat_read',{id:'test-read',userId:a.user.id,sequence:1},a.user.id);
   await s.put('security',{id:a.user.id,mfaEnabled:false,phone:'test-only'},a.user.id);
  });
  const body={id:requestID,confirmed:true,reviewed:true,retained:'Keine personenbezogenen Geschäftsunterlagen vorhanden.'};
  assert.equal((await h.call('/admin/account-deletions/complete',{...body,reviewed:false},admin)).status,400);
  const overview=await h.call('/admin/account-deletions',undefined,admin);assert.equal(overview.json.requests.length,1);
  const completed=await h.call('/admin/account-deletions/complete',body,admin);assert.equal(completed.status,200,JSON.stringify(completed));
  assert.equal((await h.call('/me',undefined,a)).status,401);
  assert.equal((await h.call('/me',undefined,b)).status,200);
  assert.equal((await h.call('/exchange',{token})).status,401);
  assert.equal((await h.call('/admin/account-deletions/complete',body,admin)).status,404);
  await h.store.transaction(async s=>{assert.equal(await s.get('user',a.user.id),null);assert.equal(await s.get('company',a.company.id),null);for(const kind of ['identity','security','password_token','session','chat_read'])assert.equal((await s.list(kind,a.user.id)).length,0);const r=await s.get('account_deletion',requestID);assert.equal(r.status,'completed');assert.equal(r.userId,undefined);assert.equal(r.email,undefined);});
  await h.drain();assert.ok(h.messages.some(m=>m.to===a.user.email&&m.subject.includes('gelöscht')));
 }finally{await h.close();}
});
test('A stale login cannot request deletion, and required business records stay intact',async()=>{
 const h=await harness();try{
  const a=await h.register('business-delete@example.com'),admin=await h.admin();
  const sid=D.hash(a.cookie.split('=')[1]);
  await h.store.transaction(async s=>{const r=await s.get('session',sid);r.createdAt=new Date(Date.now()-16*60000).toISOString();await s.put('session',r,a.user.id);});
  assert.equal((await h.call('/account/deletion',{confirmed:true,email:a.user.email},a)).status,409);
  const fresh=await h.actor(await h.call('/password-login',{email:a.user.email,password}));
  const c={id:D.id(),companyId:a.company.id,status:'submitted',number:'TEST-KEEP'};
  await h.store.transaction(s=>s.put('case',c,a.company.id));
  const r=await h.call('/account/deletion',{confirmed:true,email:a.user.email},fresh);
  assert.equal((await h.call('/admin/account-deletions/complete',{id:r.json.request.id,confirmed:true,reviewed:true,retained:'Fall TEST-KEEP: Vertragsnachweis, Aufbewahrungsende intern geprüft.'},admin)).status,200);
  await h.store.transaction(async s=>{assert.deepEqual(await s.get('case',c.id),c);assert.ok(await s.get('company',a.company.id));assert.equal(await s.get('user',a.user.id),null);});
 }finally{await h.close();}
});
test('Apple revocation failure preserves the account and deletion request',async()=>{
 const h=await harness();try{
  const a=await h.register('apple-delete@example.com'),admin=await h.admin();
  await h.store.transaction(s=>s.put('identity',{id:'apple-mapping',provider:'apple',userId:a.user.id},a.user.id));
  const r=await h.call('/account/deletion',{confirmed:true,email:a.user.email},a);
  assert.equal((await h.call('/admin/account-deletions/complete',{id:r.json.request.id,confirmed:true,reviewed:true,retained:'Keine.'},admin)).status,409);
  assert.equal((await h.call('/me',undefined,a)).status,200);
  assert.equal((await h.call('/account/deletion',undefined,a)).json.request.status,'pending');
 }finally{await h.close();}
});
test('Provider token encryption authenticates ciphertext, identity and deployment key',()=>{
 const {tokenVault}=require('../portal/oauth-tokens'),env={OAUTH_TOKEN_ENCRYPTION_KEY:'a'.repeat(64)},vault=tokenVault(env);
 const sealed=vault.seal('synthetic-refresh-token','apple-user');assert.equal(vault.open(sealed,'apple-user'),'synthetic-refresh-token');assert.doesNotMatch(sealed,/synthetic/);
 assert.throws(()=>vault.open(sealed,'other-user'));assert.throws(()=>tokenVault({OAUTH_TOKEN_ENCRYPTION_KEY:'b'.repeat(64)}).open(sealed,'apple-user'));assert.equal(tokenVault({}).ready,false);
});

test('Retained rewards never attach to a new account registered with the deleted email',async()=>{
 const h=await harness();try{
  const a=await h.register('returning@example.com'),admin=await h.admin();
  const reward={id:'old-reward',referrerId:a.user.id,state:'paid',amount:5000,createdAt:new Date().toISOString()};
  await h.store.transaction(async s=>{await s.put('referral_reward',reward,a.user.id);await s.put('sms_guard',{id:a.user.id,expires:Date.now()+60000},a.user.id);await s.put('case_request',{id:'old-request',caseId:'old-case'},a.user.id);});
  const r=await h.call('/account/deletion',{confirmed:true,email:a.user.email},a);
  assert.equal((await h.call('/admin/account-deletions/complete',{id:r.json.request.id,confirmed:true,reviewed:true,retained:'Abgeschlossene Provisionsabrechnung wird separat aufbewahrt.'},admin)).status,200);
  const b=await h.register(a.user.email);
  const overview=await h.call('/referrals',undefined,b);assert.equal(overview.status,200);assert.deepEqual(overview.json.rewards,[]);
  await h.store.transaction(async s=>{const kept=await s.get('referral_reward',reward.id);assert.equal(kept.amount,5000);assert.notEqual(kept.referrerId,b.user.id);assert.equal(await s.get('sms_guard',a.user.id),null);assert.equal(await s.get('case_request','old-request'),null);});
 }finally{await h.close();}
});
test('Apple tokens are revoked with the configured client before credentials are erased',async()=>{
 const crypto=require('node:crypto'),{createOAuth}=require('../portal/oauth'),{tokenVault}=require('../portal/oauth-tokens');
 const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const env={APPLE_CLIENT_ID:'com.example.test.service',APPLE_TEAM_ID:'TESTTEAM',APPLE_KEY_ID:'TESTKEY',APPLE_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}),OAUTH_TOKEN_ENCRYPTION_KEY:'c'.repeat(64)};
 const identity={id:'test-apple-identity',provider:'apple',protectedToken:tokenVault(env).seal('synthetic-apple-token','test-apple-identity'),tokenType:'refresh_token'};
 const oauth=createOAuth({env}),original=global.fetch;let calls=0;
 global.fetch=async(url,opts)=>{calls++;assert.equal(url,'https://appleid.apple.com/auth/revoke');assert.equal(opts.redirect,'error');assert.equal(opts.body.get('client_id'),env.APPLE_CLIENT_ID);assert.equal(opts.body.get('token'),'synthetic-apple-token');assert.equal(opts.body.get('token_type_hint'),'refresh_token');assert.equal(opts.body.get('client_secret').split('.').length,3);return {ok:calls===1};};
 try{await oauth.revoke(identity);await assert.rejects(oauth.revoke(identity),e=>e.status===503);assert.equal(calls,2);}finally{global.fetch=original;}
});
