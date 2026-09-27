'use strict';
// Native apps own the PKCE verifier. Browser callbacks contain only a short-lived code.
const {createHash,timingSafeEqual}=require('node:crypto');
const {assert,hash,random,Problem}=require('./domain');
const callback='unfallxpartner://oauth/callback';
const base64url=value=>createHash('sha256').update(value).digest('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
function createNativeAuth({env,tx,body,rate,ip,auth,issueSession,requestOrigin,providers,begin}) {
 const sessionName=env.NODE_ENV==='test'?'ux_session':'__Host-ux_session';
 const readToken=cookie=>String(cookie||'').match(new RegExp('^'+sessionName+'=([a-f0-9]{64});'))?.[1];
 const current=r=>r&&r.expires>Date.now()&&r.origin===requestOrigin();
 async function start(req) {
  const data=await body(req);
  assert(['ios','android'].includes(data.platform)&&valid(data.challenge)&&valid(data.state),'Ungültiger App-Anmeldevorgang.');
  assert(providers().some(p=>p.id===data.provider&&p.enabled),'Diese Anmeldemethode ist noch nicht eingerichtet.',503);
  const ticket=random();
  await tx(async s=>{await rate(s,'native-start:'+ip(req),20);await s.put('native_auth',{id:hash(ticket),provider:data.provider,platform:data.platform,challenge:data.challenge,state:data.state,origin:requestOrigin(),status:'created',expires:Date.now()+10*60000});});
  return {authorizationURL:requestOrigin()+'/api/portal/mobile/auth/browser?ticket='+ticket,expiresIn:600};
 }
 async function browser(req,res,url) {
  const ticket=url.searchParams.get('ticket');assert(/^[a-f0-9]{64}$/.test(ticket||''),'Ungültiger App-Anmeldevorgang.',400);
  const r=await tx(async s=>{const r=await s.get('native_auth',hash(ticket));assert(current(r)&&r.status==='created','Bitte die Anmeldung in der App erneut starten.',401);r.status='browser';await s.put('native_auth',r);return r;});
  const next=await begin(req,res,{provider:r.provider},r.id);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.writeHead(303,{Location:next.redirect});res.end();return null;
 }
 async function complete(req,res,id,outcome) {
  const code=random();
  const r=await tx(async s=>{
   const r=await s.get('native_auth',id);assert(current(r)&&r.status==='browser','App-Anmeldung abgelaufen.',401);
   let failure=outcome.error||null;const token=readToken(outcome.cookie);
   const session=token?await s.get('session',hash(token)):null;
   const user=session?await s.get('user',session.userId):null;
   if(outcome.pending){await s.remove('oauth_pending',hash(outcome.pending));failure='registration_required';}
   else if(outcome.redirect==='/login?oauth=link_required')failure='link_required';
   else if(!failure&&(!session||user?.role!=='partner'))failure='partner_required';
   // Retain only the hashed session identifier; never persist the session cookie.
   r.sessionId=session?.id||null;r.failure=failure;r.status='ready';r.expires=Date.now()+120000;
   if(session){session.expires=Math.min(session.expires,r.expires);await s.put('session',session,session.userId);}
   await s.put('native_auth',r);await s.put('native_grant',{id:hash(code),requestId:r.id,expires:r.expires});return r;
  });
  const target=callback+'?code='+encodeURIComponent(code)+'&state='+encodeURIComponent(r.state);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.writeHead(303,{Location:target});res.end();return null;
 }
 async function exchange(req,res) {
  const data=await body(req);
  assert(/^[a-f0-9]{64}$/.test(data.code||'')&&valid(data.verifier)&&valid(data.state),'Ungültige App-Anmeldung.',400);
  await tx(s=>rate(s,'native-exchange:'+ip(req),60));
  const outcome=await tx(async s=>{
   const grant=await s.get('native_grant',hash(data.code));
   const r=grant?await s.get('native_auth',grant.requestId):null;
   assert(grant&&current(r)&&grant.expires>Date.now()&&r.status==='ready'&&equal(r.state,data.state)&&equal(r.challenge,base64url(data.verifier)),'App-Anmeldung abgelaufen oder ungültig.',401);
   await s.remove('native_grant',grant.id);await s.remove('native_auth',r.id);
   const prior=r.sessionId?await s.get('session',r.sessionId):null;
   if(prior)await s.remove('session',prior.id);
   if(r.failure)return {failure:r.failure};
   assert(prior&&prior.expires>Date.now(),'App-Anmeldung abgelaufen.',401);
   const user=await s.get('user',prior.userId);
   assert(user?.active&&user.role==='partner'&&user.verifiedAt,'Partnerzugang nicht verfügbar.',403);
   // issueSession rechecks suspension and creates pending MFA when required.
   return issueSession(s,user);
  });
  if(outcome.failure){const messages={link_required:'Bitte zuerst mit E-Mail anmelden und Google oder Apple in den Portal-Einstellungen mit deinem bestehenden Konto verbinden.',registration_required:'Bitte zuerst deinen Partnerbetrieb registrieren. UNFALLX prüft und aktiviert deinen Zugang.',partner_required:'Bitte verwende deinen Partnerzugang. Interne Zugänge gehören zum Admin-Dashboard.',provider_failed:'Anmeldung abgebrochen oder vom Anbieter nicht bestätigt.'};throw new Problem(401,messages[outcome.failure]||messages.provider_failed);}
  assert(outcome.cookie,'Anmeldung konnte nicht bestätigt werden.',401);
  res.setHeader('Set-Cookie',outcome.cookie);return {ok:true,mfaRequired:!!outcome.mfaRequired};
 }
 async function route(path,req,res,url) {
  assert(!req.headers.origin||req.headers.origin===requestOrigin(),'Anfrageherkunft nicht erlaubt.',403);
  if(req.method==='POST')assert(req.headers.origin===requestOrigin(),'Anfrageherkunft nicht erlaubt.',403);
  if(path==='/mobile/auth/config'&&req.method==='GET')return {version:1,providers:providers()};
  if(path==='/mobile/auth/start'&&req.method==='POST')return start(req);
  if(path==='/mobile/auth/browser'&&req.method==='GET')return browser(req,res,url);
  if(path==='/mobile/auth/exchange'&&req.method==='POST')return exchange(req,res);
  throw new Problem(404,'Nicht gefunden.');
 }
 return {route,complete};
}
module.exports={createNativeAuth,base64url};
