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
test('Password verification, migration, reset replay and secret redaction over real HTTP',async t=>{const h=await harness();const {call,store,messages}=h;try{
 const data={email:'new@example.com',company:'Testbetrieb GmbH',contact:'Testpartner',street:'Teststraße 1',postcode:'10115',city:'Berlin',type:'Werkstatt',phone:'123',privacy:true,terms:true,password};
 assert.equal((await call('/register',{...data,password:'short'})).status,400);assert.equal((await call('/register',{...data,terms:false})).status,400);
 await call('/register',data);const token=messages.at(-1).text.match(/#token=([a-f0-9]+)/)[1];assert.equal((await call('/password-login',{email:data.email,password})).status,401);assert.equal((await call('/exchange',{token})).status,401);assert.equal((await call('/exchange',{token,password:'wrong'})).status,401);
 const customer=await h.actor(await call('/exchange',{token,password}));assert.equal(customer.user.hasPassword,true);assert.equal((await call('/exchange',{token,password})).status,401);
 const persisted=await store.transaction(s=>s.get('user',customer.user.id));assert.match(persisted.passwordHash,/^scrypt-v1\$/);assert.ok(!JSON.stringify(persisted).includes(password));assert.equal(customer.user.passwordHash,undefined);
 assert.equal((await call('/password-login',{email:data.email,password:'incorrect'})).status,401);const second=await h.actor(await call('/password-login',{email:data.email,password}));
 for(const route of ['/me','/export','/settings'])assert.ok(!JSON.stringify((await call(route,undefined,customer)).json).includes('scrypt-v1'));
 // Re-registering an existing account must not overwrite its password.
 await call('/register',{...data,password:'Anderer ausreichend langer Test Merksatz!'});assert.equal((await call('/password-login',{email:data.email,password})).status,200);
 await call('/password/request',{email:data.email});const reset=messages.findLast(m=>m.to===data.email).text.match(/#token=([a-f0-9]+)/)[1];const newPassword='Mein komplett neuer Test Merksatz 2026!';
 assert.equal((await call('/password/finish',{token:reset,password:newPassword},{},{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await call('/password/finish',{token:reset,password:newPassword})).status,200);assert.equal((await call('/password/finish',{token:reset,password:newPassword})).status,401);assert.equal((await call('/me',undefined,customer)).status,401);assert.equal((await call('/me',undefined,second)).status,401);assert.equal((await call('/password-login',{email:data.email,password})).status,401);assert.equal((await call('/password-login',{email:data.email,password:newPassword})).status,200);
 const admin=await h.admin();assert.equal(admin.user.hasPassword,false);await call('/password/request',{email:admin.user.email});const adminToken=messages.findLast(m=>m.to===admin.user.email).text.match(/#token=([a-f0-9]+)/)[1];await call('/password/finish',{token:adminToken,password});assert.equal((await call('/password-login',{email:admin.user.email,password})).status,200);
 // Generic reset response and token invalidation on mail failure.
 const unknown=await call('/password/request',{email:'unknown@example.com'});assert.equal(unknown.status,200);h.fail(true);assert.equal((await call('/password/request',{email:data.email})).status,503);h.fail(false);assert.equal((await store.transaction(s=>s.list('password_token',customer.user.id))).length,0);
 const saltA=await P.encode(password),saltB=await P.encode(password);assert.notEqual(saltA,saltB);assert.ok(await P.verify(password,saltA));assert.equal(await P.verify('bad',saltA),false);
 }finally{await h.close();}});
test('Real referral attribution, isolated statistics, double-opt-in notifications and guarded commission payout',async t=>{const h=await harness();const {call,store,messages}=h;try{
 const admin=await h.admin(),referrer=await h.register('referrer@example.com');assert.equal((await call('/referrals/join',{accepted:false},referrer)).status,410);assert.equal((await call('/referrals/join',{accepted:true},referrer)).status,410);await store.transaction(s=>s.put('referral_code',{id:'UX-AAAAAAAAAAAA',userId:referrer.user.id,active:true},referrer.user.id));const ref=(await call('/referrals',undefined,referrer)).json;assert.match(ref.code,/^UX-[A-F0-9]{12}$/);
 const client=await h.register('referred@example.com',{referralCode:ref.code}),other=await h.register('unrelated@example.com');assert.equal((await call('/referrals',undefined,referrer)).json.referredAccounts,0);await store.transaction(s=>s.put('referral_attribution',{id:client.user.id,userId:client.user.id,companyId:client.user.companyId,referrerId:referrer.user.id,code:ref.code},referrer.user.id));assert.equal((await call('/referrals',undefined,referrer)).json.referredAccounts,1);assert.equal((await call('/admin/referrals',undefined,client)).status,403);
 const intake={...require('./fixtures/intake')(),vehicle:'Testfahrzeug',plate:'GEHEIM',accidentDate:'2026-09-09',location:'Berlin',owner:'Vertraulicher Name',ownerContact:'123',description:'Vertraulicher Schaden',authority:true,customerEmail:'additional@example.com',notifyCustomer:true};
 const made=await call('/cases',intake,client),cid=made.json.case.id;await store.transaction(async s=>{const c=await s.get('case',cid);c.status='submitted';c.submittedAt=new Date(Date.now()-86400000).toISOString();await s.put('case',c,client.user.companyId);});
 async function action(actor,data){const c=(await call('/cases/'+cid,undefined,admin)).json.case;return call('/cases/'+cid,{...data,version:c.version},actor);}
 // Resubmission invokes additional recipient verification without disclosing case data.
 await action(admin,{action:'status',status:'needs_info',note:'Bitte ergänzen'});await store.transaction(s=>s.put('file',{id:D.id(),caseId:cid,kind:'photo',size:1},cid));await store.transaction(s=>s.put('file',{id:D.id(),caseId:cid,kind:'case_bundle',size:1},cid));await action(client,{action:'submit'});await h.drain();const invite=messages.find(m=>m.to==='additional@example.com');assert.ok(invite);assert.doesNotMatch(invite.text,/GEHEIM|Vertraulicher/);const verify=invite.text.match(/#token=([a-f0-9]+)/)[1];
 await action(admin,{action:'status',status:'accepted'});await h.drain();assert.equal(messages.filter(m=>m.to==='additional@example.com').length,1);
 assert.equal((await call('/notifications/verify',{token:verify})).status,200);assert.equal((await call('/notifications/verify',{token:verify})).status,401);
 await action(admin,{action:'status',status:'in_progress'});await h.drain();const update=messages.findLast(m=>m.to==='additional@example.com');assert.match(update.text,/Gutachten in Arbeit/);assert.doesNotMatch(update.text,/GEHEIM|Vertraulicher/);assert.match(update.html,/cid:unfallx-logo/);
 const before=messages.length;await action(admin,{action:'internal_note',note:'Interner geheimer Text'});await h.drain();assert.equal(messages.length,before);
 const unsub=update.text.match(/#unsubscribe=([a-f0-9]+)/)[1];await call('/notifications/verify',{token:unsub});await action(admin,{action:'comment',note:'Geheimer Nachrichtentext'});await h.drain();assert.equal(messages.filter(m=>m.to==='additional@example.com').length,2);assert.ok(messages.every(m=>!m.text.includes('Geheimer Nachrichtentext')));
 // SMTP uncertainty stays visible, rather than rolling back the case or silently retrying.
 h.fail(true);await action(admin,{action:'comment',note:'Zustelltest'});await h.drain();h.fail(false);const log=(await call('/admin/notifications',undefined,admin)).json.notifications;const uncertain=log.find(n=>n.state==='uncertain');assert.ok(uncertain);assert.equal((await call('/admin/notifications/retry',{id:uncertain.id,confirmed:true},other)).status,403);assert.equal((await call('/admin/notifications/retry',{id:uncertain.id,confirmed:false},admin)).status,400);await call('/admin/notifications/retry',{id:uncertain.id,confirmed:true},admin);await h.drain();
 await store.transaction(s=>s.put('file',{id:D.id(),caseId:cid,kind:'report',size:1},cid));await action(admin,{action:'status',status:'report_ready'});await action(admin,{action:'status',status:'report_sent',confirmed:true,reference:'Versand geprüft'});await h.drain();
 const statistics=(await call('/statistics',undefined,client)).json;assert.equal(statistics.total,1);assert.equal(statistics.reports,1);assert.equal(statistics.averageDays,1);assert.equal((await call('/statistics',undefined,other)).json.total,0);assert.equal((await call('/statistics',undefined,referrer)).json.total,0);
 let reward=(await call('/referrals',undefined,referrer)).json.rewards[0];assert.ok(reward);assert.equal(reward.amount,0);assert.ok(!JSON.stringify(reward).includes(cid));assert.ok(!JSON.stringify(reward).includes(intake.owner));assert.equal((await call('/referrals',undefined,client)).json.rewards.length,0);
 const offer={id:reward.id,version:reward.version,action:'offer',amount:'100,50',settledGross:'1190',invoiceReference:'TEST-RE-1',paymentReference:'TEST-BANK-1',agreement:'Individuelle Testvereinbarung: 100,50 Euro Gesamtbetrag.',paymentConfirmed:true};assert.equal((await call('/admin/referrals',offer,other)).status,403);assert.equal((await call('/admin/referrals',{...offer,paymentConfirmed:false},admin)).status,400);assert.equal((await call('/admin/referrals',offer,admin)).status,200);assert.equal((await call('/admin/referrals',offer,admin)).status,409);
 reward=(await call('/referrals',undefined,referrer)).json.rewards[0];assert.equal((await call('/admin/referrals',{id:reward.id,version:reward.version,action:'paid',confirmed:true},admin)).status,400);assert.equal((await call('/referrals/accept',{id:reward.id,version:reward.version,accepted:true},other)).status,404);await call('/referrals/accept',{id:reward.id,version:reward.version,accepted:true},referrer);reward=(await call('/referrals',undefined,referrer)).json.rewards[0];const paid={id:reward.id,version:reward.version,action:'paid',confirmed:true,date:'2026-09-09',reference:'Banküberweisung TEST',receiptReference:'Beleg TEST'};assert.equal((await call('/admin/referrals',paid,admin)).status,200);assert.equal((await call('/admin/referrals',paid,admin)).status,409);assert.equal((await call('/referrals',undefined,referrer)).json.totals.paid,10050);
 }finally{await h.close();}});
test('OAuth JWT signature, audience, issuer, nonce, expiry and browser state fail closed',async()=>{
 const {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet}=await import('jose'),{privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='test-key';const keys=createLocalJWKSet({keys:[jwk]});
 const sign=claims=>new SignJWT({sub:'subject-1',email:'oauth@example.com',email_verified:true,nonce:'nonce-1',...claims}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(claims?.iss||'https://accounts.google.com').setAudience(claims?.aud||'test-client').setIssuedAt().setExpirationTime(claims?.exp||'5m').sign(privateKey);
 const jwt=await sign();assert.equal((await verifyIdentity(jwt,'google','test-client','nonce-1',keys)).sub,'subject-1');await assert.rejects(verifyIdentity(jwt,'google','other-client','nonce-1',keys));await assert.rejects(verifyIdentity(jwt,'google','test-client','wrong-nonce',keys));await assert.rejects(verifyIdentity(await sign({iss:'https://evil.example'}),'google','test-client','nonce-1',keys));await assert.rejects(verifyIdentity(await sign({exp:Math.floor(Date.now()/1000)-120}),'google','test-client','nonce-1',keys));const parts=jwt.split('.');parts[1]=Buffer.from(JSON.stringify({sub:'admin'})).toString('base64url');await assert.rejects(verifyIdentity(parts.join('.'),'google','test-client','nonce-1',keys));
 const h=await harness({GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'not-a-real-secret'});try{assert.equal((await h.call('/oauth/start',{provider:'apple'})).status,503);const start=await h.call('/oauth/start',{provider:'google'});assert.equal(start.status,200);const url=new URL(start.json.redirect);assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');const state=url.searchParams.get('state');assert.ok(state&&url.searchParams.get('nonce'));const cookie=start.cookie.split(';')[0];
 // Wrong browser is rejected before exchanging a code.
 assert.equal((await h.call('/oauth/google/callback?state='+state+'&code=unused')).location,'/login?oauth=failed');assert.equal((await h.call('/oauth/google/callback?state='+state+'&error=access_denied',undefined,{cookie})).location,'/login?oauth=failed');assert.equal((await h.store.transaction(s=>s.get('oauth_state',D.hash(state)))),null);
 assert.equal((await h.call('/oauth/complete',{typeOfAccount:'admin'})).status,400);assert.equal((await h.call('/oauth/start',{provider:'google',link:true})).status,401);
 }finally{await h.close();}
});

test('OAuth authorization-code success, onboarding and explicit linking never merge existing emails',async()=>{
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('RS256'),key=await exportJWK(pair.publicKey);key.kid='oauth-flow-test';key.alg='RS256';key.use='sig';
 const h=await harness({GOOGLE_CLIENT_ID:'flow-client',GOOGLE_CLIENT_SECRET:'test-client-secret'}),originalFetch=global.fetch;let nextJWT='',lastExchange=null;
 global.fetch=async(input,options)=>{const url=String(input);if(url==='https://www.googleapis.com/oauth2/v3/certs')return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});if(url==='https://oauth2.googleapis.com/token'){lastExchange=Object.fromEntries(options.body);return new Response(JSON.stringify({id_token:nextJWT}),{status:200,headers:{'Content-Type':'application/json'}});}return originalFetch(input,options);};
 async function flow(subject,address,actor,link=false){const start=await h.call('/oauth/start',{provider:'google',link},actor||{});assert.equal(start.status,200);const url=new URL(start.json.redirect),state=url.searchParams.get('state');nextJWT=await new SignJWT({sub:subject,email:address,email_verified:true,nonce:url.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:key.kid}).setIssuer('https://accounts.google.com').setAudience('flow-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);const result=await h.call('/oauth/google/callback?state='+state+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});assert.equal(result.status,303);assert.equal(lastExchange.redirect_uri,'http://localhost/api/portal/oauth/google/callback');assert.equal(Buffer.from(D.hash(lastExchange.code_verifier),'hex').toString('base64url'),url.searchParams.get('code_challenge'));return result;}
 try{
 const existing=await h.register('existing-oauth@example.com');const denied=await flow('subject-existing',existing.user.email);assert.equal(denied.location,'/login?oauth=link_required');assert.equal((await h.store.transaction(s=>s.list('identity'))).length,0);
 const linked=await flow('subject-existing',existing.user.email,existing,true);assert.equal(linked.location,'/portal#einstellungen');assert.deepEqual((await h.call('/identities',undefined,existing)).json.linked,['google']);
 const signedIn=await flow('subject-existing','changed-at-provider@example.com');assert.equal(signedIn.location,'/portal');assert.match(signedIn.cookie,/ux_session=/);
 await h.store.transaction(s=>s.put('security',{id:existing.user.id,mfaEnabled:true,epoch:1,phone:'+4917612345678',verifiedAt:new Date().toISOString(),recovery:[]},existing.user.id));const guarded=await flow('subject-existing',existing.user.email);assert.equal(guarded.location,'/login?factor=1');const guardedCookie=guarded.cookie.match(/ux_session=[a-f0-9]{64}/)[0];assert.equal((await h.call('/me',undefined,{cookie:guardedCookie})).status,401);

 const registration=await flow('subject-new','new-oauth@example.com');assert.equal(registration.location,'/konto-vervollstaendigen');const cookie=registration.cookie.match(/ux_onboarding=[a-f0-9]{64}/)[0],profile=(await h.call('/oauth/profile',undefined,{cookie})).json;assert.equal(profile.email,'new-oauth@example.com');
 const body={typeOfAccount:'partner',company:'Testbetrieb GmbH',contact:'Testpartner',street:'Teststraße 1',postcode:'10115',city:'Berlin',type:'Werkstatt',phone:'030000',privacy:true,terms:true};assert.equal((await h.call('/oauth/complete',body,{cookie})).status,403);const complete=await h.call('/oauth/complete',body,{cookie,csrf:profile.csrf});assert.equal(complete.status,200);assert.equal(complete.json.redirect,'/portal');assert.equal((await h.call('/oauth/complete',body,{cookie,csrf:profile.csrf})).status,401);const user=await h.store.transaction(s=>s.get('user',D.hash('new-oauth@example.com')));assert.equal(user.role,'partner');assert.ok(user.verifiedAt);assert.equal(user.passwordHash,undefined);assert.equal((await h.store.transaction(s=>s.list('identity'))).length,2);
 }finally{global.fetch=originalFetch;await h.close();}
});

test('0account signs EdDSA and registers a partner through the same authorization-code flow',async()=>{
 // 0account signiert mit EdDSA statt RS256 und liefert seine Adressen je Umgebung.
 const ISSUER='https://staging-v1.0account.com';
 const {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet}=await import('jose'),pair=await generateKeyPair('Ed25519'),key=await exportJWK(pair.publicKey);key.kid='zeroaccount-test';key.alg='EdDSA';key.use='sig';
 const settings={name:'0account',auth:ISSUER+'/oauth/authorize',token:ISSUER+'/oauth/token',keys:ISSUER+'/.well-known/jwks.json',issuer:ISSUER,alg:'EdDSA'};
 const sign=claims=>new SignJWT({sub:'zero-subject',email:'zero@example.com',email_verified:true,nonce:'nonce-1',...claims}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(claims?.iss||ISSUER).setAudience(claims?.aud||'zero-client').setIssuedAt().setExpirationTime(claims?.exp||'5m').sign(pair.privateKey);
 // Ein RS256-Token darf für 0account niemals akzeptiert werden und umgekehrt.
 const keys=createLocalJWKSet({keys:[key]});
 assert.equal((await verifyIdentity(await sign(),'0account','zero-client','nonce-1',keys,settings)).sub,'zero-subject');
 await assert.rejects(verifyIdentity(await sign({iss:'https://evil.example'}),'0account','zero-client','nonce-1',keys,settings));
 await assert.rejects(verifyIdentity(await sign(),'0account','other-client','nonce-1',keys,settings));
 await assert.rejects(verifyIdentity(await sign(),'0account','zero-client','wrong-nonce',keys,settings));

 const h=await harness({ZEROACCOUNT_CLIENT_ID:'zero-client',ZEROACCOUNT_CLIENT_SECRET:'zero-secret',ZEROACCOUNT_ISSUER:ISSUER}),originalFetch=global.fetch;let nextJWT='',lastExchange=null;
 global.fetch=async(input,options)=>{const url=String(input);if(url===settings.keys)return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});if(url===settings.token){lastExchange=Object.fromEntries(options.body);return new Response(JSON.stringify({id_token:nextJWT}),{status:200,headers:{'Content-Type':'application/json'}});}return originalFetch(input,options);};
 try{
  // Die Schaltfläche steht vor Google und nennt 0account beim Namen.
  const offered=(await h.call('/oauth/providers')).json.providers;
  assert.deepEqual(offered.map(p=>p.id),['0account','google','apple']);
  assert.equal(offered[0].enabled,true);

  const start=await h.call('/oauth/start',{provider:'0account'});assert.equal(start.status,200);
  const url=new URL(start.json.redirect);assert.equal(url.origin,ISSUER);
  assert.equal(url.pathname,'/oauth/authorize');
  // 0account verlangt PKCE S256 und openid im Scope, sonst verweigert es den Start.
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.match(url.searchParams.get('scope'),/openid/);
  assert.equal(url.searchParams.get('client_id'),'zero-client');
  const state=url.searchParams.get('state');
  nextJWT=await sign({nonce:url.searchParams.get('nonce')});
  const result=await h.call('/oauth/0account/callback?state='+state+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});
  assert.equal(result.status,303);
  assert.equal(result.location,'/konto-vervollstaendigen');
  assert.equal(lastExchange.redirect_uri,'http://localhost/api/portal/oauth/0account/callback');
  assert.equal(lastExchange.client_secret,'zero-secret');
  assert.equal(Buffer.from(D.hash(lastExchange.code_verifier),'hex').toString('base64url'),url.searchParams.get('code_challenge'));
  const cookie=result.cookie.match(/ux_onboarding=[a-f0-9]{64}/)[0];
  assert.equal((await h.call('/oauth/profile',undefined,{cookie})).json.email,'zero@example.com');
 }finally{global.fetch=originalFetch;await h.close();}
});

test('0account prefills the partner form from its claims and never lets /userinfo change the identity',async()=>{
 // Eigene Adresse je Test: der Schlüsselcache hängt an der JWKS-Adresse, ein
 // zweiter Test mit derselben Adresse bekäme sonst die Schlüssel des ersten.
 const ISSUER='https://prefill-v1.0account.test';
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('Ed25519'),key=await exportJWK(pair.publicKey);key.kid='zeroaccount-prefill';key.alg='EdDSA';key.use='sig';
 const h=await harness({ZEROACCOUNT_CLIENT_ID:'zero-client',ZEROACCOUNT_CLIENT_SECRET:'zero-secret',ZEROACCOUNT_ISSUER:ISSUER}),originalFetch=global.fetch;
 let nextJWT='',userinfo={};
 global.fetch=async(input,options)=>{const url=String(input);
  if(url===ISSUER+'/.well-known/jwks.json')return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/token')return new Response(JSON.stringify({id_token:nextJWT,access_token:'zero-access-token'}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/userinfo'){assert.equal(options.headers.Authorization,'Bearer zero-access-token');return new Response(JSON.stringify(userinfo),{status:200,headers:{'Content-Type':'application/json'}});}
  return originalFetch(input,options);};
 try{
  // Der Anbieter kennt Firma und Anschrift; das Formular übernimmt sie.
  // Ohne Zustimmung zum Datenschutz greift der Rückfall aufs Formular, und
  // genau dessen Vorbelegung wird hier geprüft.
  userinfo={'https://0account.com/claims/fields':{companyName:'Musterwerkstatt GmbH',streetAddress:'Teststraße 5',postalCode:'10115',city:'Berlin',companyType:'Werkstatt',referralCode:'ux-aaaaaaaaaaaa',termsAndConditions:true},
   // Ein abweichendes sub/E-Mail aus /userinfo darf die geprüfte Identität nicht ersetzen.
   sub:'attacker-subject',email:'attacker@example.com'};
  const start=await h.call('/oauth/start',{provider:'0account'});
  const url=new URL(start.json.redirect),state=url.searchParams.get('state');
  nextJWT=await new SignJWT({sub:'zero-subject',email:'partner@example.com',email_verified:true,given_name:'Erika',family_name:'Musterfrau',phone_number:'+4930123456',nonce:url.searchParams.get('nonce')}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setAudience('zero-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const result=await h.call('/oauth/0account/callback?state='+state+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});
  assert.equal(result.location,'/konto-vervollstaendigen');
  const cookie=result.cookie.match(/ux_onboarding=[a-f0-9]{64}/)[0],profile=(await h.call('/oauth/profile',undefined,{cookie})).json;
  // Identität stammt aus dem ID-Token, nicht aus /userinfo.
  assert.equal(profile.email,'partner@example.com');
  // given_name + family_name ergeben den Ansprechpartner; 0account sendet kein "name".
  assert.equal(profile.name,'Erika Musterfrau');
  assert.equal(profile.phone,'+4930123456');
  // Empfehlungscodes werden in Großschreibung geführt; Zustimmungen kommen als Häkchen zurück.
  assert.deepEqual(profile.company,{name:'Musterwerkstatt GmbH',street:'Teststraße 5',postcode:'10115',city:'Berlin',type:'Werkstatt',referralCode:'UX-AAAAAAAAAAAA',terms:true,privacy:false});
  // Ohne eigene Felder bleibt das Formular leer und weiterhin benutzbar.
  userinfo={};
  const second=await h.call('/oauth/start',{provider:'0account'});
  const secondUrl=new URL(second.json.redirect);
  nextJWT=await new SignJWT({sub:'zero-subject-2',email:'zweiter@example.com',email_verified:true,given_name:'Max',nonce:secondUrl.searchParams.get('nonce')}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setAudience('zero-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const plain=await h.call('/oauth/0account/callback?state='+secondUrl.searchParams.get('state')+'&code=test-code',undefined,{cookie:second.cookie.split(';')[0]});
  const plainCookie=plain.cookie.match(/ux_onboarding=[a-f0-9]{64}/)[0],plainProfile=(await h.call('/oauth/profile',undefined,{cookie:plainCookie})).json;
  assert.equal(plainProfile.name,'Max');assert.equal(plainProfile.phone,'');assert.deepEqual(plainProfile.company,{});
 }finally{global.fetch=originalFetch;await h.close();}
});

test('0account registers the partner without the form when it supplies every required field',async()=>{
 const ISSUER='https://noform-v1.0account.test',NS='https://0account.com/claims/fields';
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('Ed25519'),key=await exportJWK(pair.publicKey);key.kid='zeroaccount-noform';key.alg='EdDSA';key.use='sig';
 const h=await harness({ZEROACCOUNT_CLIENT_ID:'zero-client',ZEROACCOUNT_CLIENT_SECRET:'zero-secret',ZEROACCOUNT_ISSUER:ISSUER}),originalFetch=global.fetch;
 let nextJWT='',userinfo={};
 global.fetch=async(input,options)=>{const url=String(input);
  if(url===ISSUER+'/.well-known/jwks.json')return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/token')return new Response(JSON.stringify({id_token:nextJWT,access_token:'zero-access-token'}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/userinfo')return new Response(JSON.stringify(userinfo),{status:200,headers:{'Content-Type':'application/json'}});
  return originalFetch(input,options);};
 // Ohne companyType: die App kann die Unternehmensart nicht führen, genau so
 // sieht der Produktivfall aus.
 const complete={companyName:'Musterwerkstatt GmbH',streetAddress:'Teststraße 5',postalCode:'10115',city:'Berlin',termsAndConditions:true,privacyPolicy:true};
 async function flow(address,fields){
  userinfo={[NS]:fields};
  const start=await h.call('/oauth/start',{provider:'0account'});
  const url=new URL(start.json.redirect);
  nextJWT=await new SignJWT({sub:'sub-'+address,email:address,email_verified:true,given_name:'Erika',family_name:'Musterfrau',phone_number:'+4930123456',nonce:url.searchParams.get('nonce')}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setAudience('zero-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  return h.call('/oauth/0account/callback?state='+url.searchParams.get('state')+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});
 }
 try{
  const registered=await flow('vollstaendig@example.com',complete);
  // Direkt im Portal, ohne Zwischenformular.
  assert.equal(registered.location,'/portal');
  assert.match(registered.cookie,/ux_session=/);
  const user=await h.store.transaction(s=>s.get('user',D.hash('vollstaendig@example.com')));
  assert.equal(user.role,'partner');assert.equal(user.name,'Erika Musterfrau');assert.equal(user.phone,'+4930123456');
  assert.ok(user.verifiedAt);assert.equal(user.passwordHash,undefined);
  const company=await h.store.transaction(s=>s.get('company',user.companyId));
  assert.equal(company.name,'Musterwerkstatt GmbH');assert.equal(company.city,'Berlin');
  // Ohne Angabe gilt dieselbe Vorauswahl, die das Formular ungefragt sendet.
  assert.equal(company.type,'Werkstatt');
  // Der Betrieb wird wie immer erst nach Prüfung freigegeben.
  assert.equal(company.status,'pending');
  // Dieselbe Begrüßung wie nach dem Formular.
  assert.equal(h.messages.filter(m=>m.to==='vollstaendig@example.com').length,1);

  // Ein mitgegebener Empfehlungscode geht denselben Weg wie über das Formular
  // (referrals.attribute ist derzeit wirkungslos, neue Zuordnungen sind
  // pausiert) und darf die Registrierung nicht stören.
  const werber=await flow('geworben@example.com',{...complete,referralCode:'ux-bbbbbbbbbbbb'});
  assert.equal(werber.location,'/portal');
  assert.ok(await h.store.transaction(s=>s.get('user',D.hash('geworben@example.com'))));

  // Eine zulässige Art wird übernommen, eine unbekannte fällt auf die
  // Vorauswahl zurück, statt die Registrierung scheitern zu lassen.
  await flow('abschlepp@example.com',{...complete,companyType:'Abschleppdienst'});
  const towing=await h.store.transaction(async s=>s.get('company',(await s.get('user',D.hash('abschlepp@example.com'))).companyId));
  assert.equal(towing.type,'Abschleppdienst');
  await flow('unbekannt@example.com',{...complete,companyType:'Autohaus'});
  const unknown=await h.store.transaction(async s=>s.get('company',(await s.get('user',D.hash('unbekannt@example.com'))).companyId));
  assert.equal(unknown.type,'Werkstatt');

  // Fehlt eine Angabe oder eine Zustimmung, bleibt es beim Formular.
  for(const missing of [{...complete,city:''},{...complete,companyName:''},{...complete,termsAndConditions:false},{...complete,privacyPolicy:undefined}]){
   const partial=await flow('teil-'+D.hash(JSON.stringify(missing)).slice(0,8)+'@example.com',missing);
   assert.equal(partial.location,'/konto-vervollstaendigen');
  }
 }finally{global.fetch=originalFetch;await h.close();}
});

test('0account sessions carry the ID-token hint so their logout also ends the 0account session',async()=>{
 const ISSUER='https://rplogout-v1.0account.test',NS='https://0account.com/claims/fields';
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('Ed25519'),key=await exportJWK(pair.publicKey);key.kid='zeroaccount-rplogout';key.alg='EdDSA';key.use='sig';
 const h=await harness({ZEROACCOUNT_CLIENT_ID:'zero-client',ZEROACCOUNT_CLIENT_SECRET:'zero-secret',ZEROACCOUNT_ISSUER:ISSUER}),originalFetch=global.fetch;
 let nextJWT='',userinfo={};
 global.fetch=async(input,options)=>{const url=String(input);
  if(url===ISSUER+'/.well-known/jwks.json')return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/token')return new Response(JSON.stringify({id_token:nextJWT,access_token:'zero-access-token'}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/userinfo')return new Response(JSON.stringify(userinfo),{status:200,headers:{'Content-Type':'application/json'}});
  return originalFetch(input,options);};
 const complete={companyName:'Musterwerkstatt GmbH',streetAddress:'Teststraße 5',postalCode:'10115',city:'Berlin',termsAndConditions:true,privacyPolicy:true};
 async function oauthSession(address,fields){userinfo={[NS]:fields};const start=await h.call('/oauth/start',{provider:'0account'});const url=new URL(start.json.redirect);nextJWT=await new SignJWT({sub:'sub-'+address,email:address,email_verified:true,given_name:'Erika',family_name:'Musterfrau',phone_number:'+4930123456',nonce:url.searchParams.get('nonce')}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setAudience('zero-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);return h.call('/oauth/0account/callback?state='+url.searchParams.get('state')+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});}
 // Parst die Abmeldeadresse statt sie zu zerschneiden: hinter id_token_hint
 // stehen jetzt weitere Parameter, die ein split() mit in den Token gezogen hätte.
 const hint=value=>{const u=new URL(value);assert.equal(u.origin+u.pathname,ISSUER+'/oauth/logout');const token=u.searchParams.get('id_token_hint');assert.ok(token,'id_token_hint fehlt');assert.equal(token.split('.').length,3);
  // Ohne Ziel beendet 0account die Sitzung und der Browser bleibt auf dem
  // dortigen Endpunkt stehen -- genau der Fall, der beim Testen aufgefallen ist.
  const back=u.searchParams.get('post_logout_redirect_uri');assert.ok(back,'post_logout_redirect_uri fehlt');assert.equal(new URL(back).pathname,'/login');
  return token;};
 try{
  // Direkte Registrierung: die Abmeldung liefert den Abmeldeendpunkt mit Hinweis.
  const direct=await oauthSession('rplogout@example.com',complete);
  assert.equal(direct.location,'/portal');
  const directActor={cookie:direct.cookie.match(/ux_session=[a-f0-9]{64}/)[0]};directActor.csrf=(await h.call('/me',undefined,directActor)).json.csrf;
  const ended=await h.call('/logout',{},directActor);
  assert.equal(ended.json.ok,true);hint(ended.json.idpLogout);

  // Weg über das Formular: der Hinweis wandert aus dem Zwischenstand mit.
  const pending=await oauthSession('rpform@example.com',{...complete,privacyPolicy:false});
  assert.equal(pending.location,'/konto-vervollstaendigen');
  const onboarding=pending.cookie.match(/ux_onboarding=[a-f0-9]{64}/)[0],profile=(await h.call('/oauth/profile',undefined,{cookie:onboarding})).json;
  const finished=await h.call('/oauth/complete',{typeOfAccount:'partner',company:'Musterwerkstatt GmbH',contact:'Erika Musterfrau',street:'Teststraße 5',postcode:'10115',city:'Berlin',type:'Werkstatt',phone:'+4930123456',privacy:true,terms:true},{cookie:onboarding,csrf:profile.csrf});
  assert.equal(finished.status,200);
  const formActor={cookie:finished.cookie.match(/ux_session=[a-f0-9]{64}/)[0]};formActor.csrf=(await h.call('/me',undefined,formActor)).json.csrf;
  const endedForm=await h.call('/logout',{},formActor);
  assert.equal(endedForm.json.ok,true);hint(endedForm.json.idpLogout);

  // Passwort-Sitzungen haben keinen Anbieter; dort fehlt der Endpunkt.
  const password=await h.register('pwonly@example.com');
  const plain=await h.call('/logout',{},password);
  assert.equal(plain.json.ok,true);assert.equal(plain.json.idpLogout,undefined);
 }finally{global.fetch=originalFetch;await h.close();}
});
test('Back-channel logout from 0account ends exactly the matching local sessions',async()=>{
 const ISSUER='https://bcl-v1.0account.test',NS='https://0account.com/claims/fields',EVENT='http://schemas.openid.net/event/backchannel-logout';
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('Ed25519'),key=await exportJWK(pair.publicKey);key.kid='zeroaccount-bcl';key.alg='EdDSA';key.use='sig';
 const h=await harness({ZEROACCOUNT_CLIENT_ID:'zero-client',ZEROACCOUNT_CLIENT_SECRET:'zero-secret',ZEROACCOUNT_ISSUER:ISSUER}),originalFetch=global.fetch;
 let nextJWT='',userinfo={};
 global.fetch=async(input,options)=>{const url=String(input);
  if(url===ISSUER+'/.well-known/jwks.json')return new Response(JSON.stringify({keys:[key]}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/token')return new Response(JSON.stringify({id_token:nextJWT,access_token:'zero-access-token'}),{status:200,headers:{'Content-Type':'application/json'}});
  if(url===ISSUER+'/oauth/userinfo')return new Response(JSON.stringify(userinfo),{status:200,headers:{'Content-Type':'application/json'}});
  return originalFetch(input,options);};
 const fields={companyName:'Musterwerkstatt GmbH',streetAddress:'Teststraße 5',postalCode:'10115',city:'Berlin',termsAndConditions:true,privacyPolicy:true};
 async function oauthSession(address,sid){userinfo={[NS]:fields};const start=await h.call('/oauth/start',{provider:'0account'});const url=new URL(start.json.redirect);nextJWT=await new SignJWT({sub:'sub-'+address,email:address,email_verified:true,given_name:'Erika',family_name:'Musterfrau',phone_number:'+4930123456',sid,nonce:url.searchParams.get('nonce')}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setAudience('zero-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);return h.call('/oauth/0account/callback?state='+url.searchParams.get('state')+'&code=test-code',undefined,{cookie:start.cookie.split(';')[0]});}
 async function backchannel(claims,header={alg:'EdDSA',kid:key.kid}){const logoutToken=await new SignJWT(claims).setProtectedHeader(header).setIssuer(claims.iss||ISSUER).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);return fetch(h.base+'/api/portal/oauth/0account/backchannel-logout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Forwarded-For':'bcl'},body:new URLSearchParams({logout_token:logoutToken})});}
 const sidSessions=sid=>h.store.transaction(async s=>(await s.list('session')).filter(x=>x.idp?.sid===sid).length);
 try{
  const first=await oauthSession('bcl-1@example.com','zero-session-A');
  assert.equal(first.location,'/portal');
  const second=await oauthSession('bcl-2@example.com','zero-session-B');
  assert.equal(second.location,'/portal');
  // Die sid der 0account-Sitzung hängt an den örtlichen Sitzungen.
  assert.equal(await sidSessions('zero-session-A'),1);
  assert.equal(await sidSessions('zero-session-B'),1);
  const password=await h.register('bcl-pw@example.com');

  // Der Abmeldehinweis endet genau die genannte Sitzung.
  const ok=await backchannel({aud:'zero-client',sub:'sub-bcl-1@example.com',sid:'zero-session-A',events:{[EVENT]:{}}});
  assert.equal(ok.status,200);
  assert.equal(await sidSessions('zero-session-A'),0);
  assert.equal(await sidSessions('zero-session-B'),1);
  assert.ok(await h.store.transaction(s=>s.get('user',D.hash('bcl-pw@example.com'))));

  // Ohne Ereignis, mit nonce, fremdem Aussteller oder fremdem Schlüssel: 400, nichts endet.
  for(const claims of [{aud:'zero-client',sub:'sub',sid:'zero-session-B',events:{}},{aud:'zero-client',sub:'sub',sid:'zero-session-B',events:{[EVENT]:{}},nonce:'n'},{aud:'other-client',sub:'sub',sid:'zero-session-B',events:{[EVENT]:{}}}])assert.equal((await backchannel(claims)).status,400);
  assert.equal(await sidSessions('zero-session-B'),1);

  // Ohne exp ebenfalls 400. Die Spezifikation verlangt exp; solange wir es nur
  // geprüft haben, wenn es vorhanden war, wäre ein abgefangener Hinweis
  // unbegrenzt gültig geblieben.
  const ohneExp=await new SignJWT({aud:'zero-client',sub:'sub',sid:'zero-session-B',events:{[EVENT]:{}}}).setProtectedHeader({alg:'EdDSA',kid:key.kid}).setIssuer(ISSUER).setIssuedAt().sign(pair.privateKey);
  assert.equal((await fetch(h.base+'/api/portal/oauth/0account/backchannel-logout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Forwarded-For':'bcl'},body:new URLSearchParams({logout_token:ohneExp})})).status,400);
  assert.equal(await sidSessions('zero-session-B'),1);

  // Aber ein korrekter Hinweis für die zweite Sitzung endet auch sie.
  assert.equal((await backchannel({aud:'zero-client',sub:'sub-bcl-2@example.com',sid:'zero-session-B',events:{[EVENT]:{}}})).status,200);
  assert.equal(await sidSessions('zero-session-B'),0);
 }finally{global.fetch=originalFetch;await h.close();}
});

test('Registration mail failure leaves no account or usable token; retry delivers one complete branded email',async()=>{const h=await harness();try{const data={email:'mail-failure@example.com',company:'Testbetrieb GmbH',contact:'Testpartner',street:'Teststraße 1',postcode:'10115',city:'Berlin',type:'Werkstatt',phone:'030123456',privacy:true,terms:true,password};h.fail(true);assert.equal((await h.call('/register',data)).status,503);assert.equal(await h.store.transaction(s=>s.get('user',D.hash(data.email))),null);assert.equal((await h.store.transaction(s=>s.list('token'))).length,0);h.fail(false);assert.equal((await h.call('/register',data)).status,200);assert.equal(h.messages.length,1);assert.match(h.messages[0].html,/data-unfallx-email="v2"/);assert.equal((h.messages[0].html.match(/cid:unfallx-logo/g)||[]).length,1);}finally{await h.close();}});
