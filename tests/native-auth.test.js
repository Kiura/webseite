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

test('Native Google login binds PKCE, browser, origin and one-use code, and retains MFA',async()=>{
 const crypto=require('node:crypto'),{base64url}=require('../portal/native-auth');
 const {generateKeyPair,exportJWK,SignJWT}=await import('jose'),pair=await generateKeyPair('RS256'),key=await exportJWK(pair.publicKey);key.kid='native-test';key.alg='RS256';key.use='sig';
 const h=await harness({GOOGLE_CLIENT_ID:'native-client',GOOGLE_CLIENT_SECRET:'test-only'}),originalFetch=global.fetch;let nextJWT='';
 global.fetch=async(input,options)=>{const url=String(input);if(url==='https://www.googleapis.com/oauth2/v3/certs')return new Response(JSON.stringify({keys:[key]}),{headers:{'Content-Type':'application/json'}});if(url==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({id_token:nextJWT}),{headers:{'Content-Type':'application/json'}});return originalFetch(input,options);};
 const proof=()=>({verifier:crypto.randomBytes(32).toString('base64url'),state:crypto.randomBytes(32).toString('base64url')});
 const begin=async(p=proof(),extra={})=>{const r=await h.call('/mobile/auth/start',{provider:'google',platform:'ios',challenge:base64url(p.verifier),state:p.state,...extra});return {...r,p};};
 async function flow(subject,address,{p=proof(),cancel=false,wrongBrowser=false}={}) {
  const start=await begin(p);assert.equal(start.status,200,JSON.stringify(start));const entry=new URL(start.json.authorizationURL);
  const opened=await h.call(entry.pathname.replace('/api/portal','')+entry.search);assert.equal(opened.status,303);const target=new URL(opened.location);
  assert.equal((await h.call(entry.pathname.replace('/api/portal','')+entry.search)).status,401,'browser ticket is one use');
  nextJWT=await new SignJWT({sub:subject,email:address,email_verified:true,nonce:target.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:key.kid}).setIssuer('https://accounts.google.com').setAudience('native-client').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const route='/oauth/google/callback?state='+target.searchParams.get('state')+(cancel?'&error=access_denied':'&code=test-only');
  if(wrongBrowser)assert.equal((await h.call(route)).location,'/login?oauth=failed');
  const result=await h.call(route,undefined,{cookie:opened.cookie.split(';')[0]});assert.equal(result.status,303,JSON.stringify(result));
  const callback=new URL(result.location);assert.equal(callback.protocol,'unfallxpartner:');assert.equal(callback.host,'oauth');assert.equal(callback.searchParams.get('state'),p.state);assert.equal([...callback.searchParams].length,2);
  assert.doesNotMatch(result.cookie||'',/(?:^|[,;\s])ux_session=/,'browser never receives the app session');
  return {code:callback.searchParams.get('code'),verifier:p.verifier,state:p.state};
 }
 try {
  const config=await h.call('/mobile/auth/config');assert.equal(config.status,200);assert.equal(config.json.version,1);assert.equal(config.json.providers.find(p=>p.id==='apple').enabled,false);
  assert.equal((await begin(proof(),{provider:'apple'})).status,503);assert.equal((await begin(proof(),{challenge:'weak'})).status,400);
  const p=proof();assert.equal((await h.call('/mobile/auth/start',{provider:'google',platform:'android',challenge:base64url(p.verifier),state:p.state},{},{headers:{Origin:'https://evil.test'}})).status,403);
  const partner=await h.register('native@example.com');await h.store.transaction(s=>s.put('identity',{id:D.hash('google:native-subject'),provider:'google',userId:partner.user.id},partner.user.id));
  const grant=await flow('native-subject',partner.user.email,{wrongBrowser:true});
  assert.equal((await h.call('/mobile/auth/exchange',{...grant,verifier:proof().verifier})).status,401);
  assert.equal((await h.call('/mobile/auth/exchange',{...grant,state:proof().state})).status,401);
  assert.equal((await h.call('/mobile/auth/exchange',grant,{},{headers:{Origin:'https://evil.test'}})).status,403);
  const exchanged=await h.call('/mobile/auth/exchange',grant);assert.equal(exchanged.status,200,JSON.stringify(exchanged));assert.equal(exchanged.json.mfaRequired,false);
  const actor=await h.actor(exchanged);assert.equal(actor.user.id,partner.user.id);assert.equal((await h.call('/mobile/auth/exchange',grant)).status,401);
  assert.equal((await h.store.transaction(s=>s.list('native_grant'))).length,0);
  const existing=await flow('unlinked',partner.user.email);const link=await h.call('/mobile/auth/exchange',existing);assert.equal(link.status,401);assert.match(link.json.error,/verbinden/);
  const newcomer=await flow('new-native','new-native@example.com');const register=await h.call('/mobile/auth/exchange',newcomer);assert.equal(register.status,401);assert.match(register.json.error,/registrieren/);assert.equal((await h.store.transaction(s=>s.list('oauth_pending'))).length,0);
  const canceled=await flow('native-subject',partner.user.email,{cancel:true});assert.equal((await h.call('/mobile/auth/exchange',canceled)).status,401);
  const expired=await flow('native-subject',partner.user.email);await h.store.transaction(async s=>{const row=await s.get('native_grant',D.hash(expired.code));row.expires=Date.now()-1;await s.put('native_grant',row);});assert.equal((await h.call('/mobile/auth/exchange',expired)).status,401);
  await h.store.transaction(s=>s.put('security',{id:partner.user.id,mfaEnabled:true,epoch:1,phone:'+4917612345678',verifiedAt:new Date().toISOString(),recovery:[]},partner.user.id));
  const guarded=await h.call('/mobile/auth/exchange',await flow('native-subject',partner.user.email));assert.equal(guarded.status,200);assert.equal(guarded.json.mfaRequired,true);
  assert.equal((await h.call('/me',undefined,{cookie:guarded.cookie.split(';')[0]})).status,401);
  const safety=await h.call('/security/login',undefined,{cookie:guarded.cookie.split(';')[0]});assert.equal(safety.status,200);assert.ok(safety.json.csrf);
  const revoked=await flow('native-subject',partner.user.email);await h.store.transaction(async s=>{const co=await s.get('company',partner.user.companyId);co.status='suspended';await s.put('company',co);});assert.equal((await h.call('/mobile/auth/exchange',revoked)).status,403);
 } finally {global.fetch=originalFetch;await h.close();}
});
