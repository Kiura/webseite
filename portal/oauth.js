'use strict';
const {assert,text,email,hash,random,id,companyData,Problem}=require('./domain');
const {notice}=require('./brand-mail');
const {assertPortalUser}=require('./access');
const jose=()=>import('jose');
const providers={
 google:{name:'Google',auth:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',keys:'https://www.googleapis.com/oauth2/v3/certs',issuer:['https://accounts.google.com','accounts.google.com']},
 apple:{name:'Apple',auth:'https://appleid.apple.com/auth/authorize',token:'https://appleid.apple.com/auth/token',keys:'https://appleid.apple.com/auth/keys',issuer:'https://appleid.apple.com'}
};
const keysets=new Map();
async function verifyIdentity(token,provider,clientId,nonce,keySet){const {jwtVerify,createRemoteJWKSet}=await jose();const p=providers[provider];assert(p,'Unbekannter Anbieter.');if(!keysets.has(provider))keysets.set(provider,createRemoteJWKSet(new URL(p.keys),{timeoutDuration:10000}));const {payload}=await jwtVerify(token,keySet||keysets.get(provider),{issuer:p.issuer,audience:clientId,algorithms:['RS256'],clockTolerance:30,maxTokenAge:'10m',requiredClaims:['exp','iat','sub','nonce']});assert(payload.nonce===nonce&&typeof payload.sub==='string'&&payload.sub.length>0&&payload.sub.length<=255,'Anmeldung konnte nicht bestätigt werden.',401);return payload;}
function createOAuth({env,origin,tx,rate,ip,body,auth,issueSession,mail,referrals,requestOrigin=()=>origin,checkWorkspace=()=>{},onVerified=()=>{},nativeComplete=null}){
 const vault=require('./oauth-tokens').tokenVault(env);
 const local=env.NODE_ENV==='test';const bindingName=local?'ux_oauth':'__Host-ux_oauth',pendingName=local?'ux_onboarding':'__Host-ux_onboarding';
 const cookie=(name,value,seconds=600,cross=false)=>`${name}=${value}; Path=/; HttpOnly; SameSite=${cross&&!local?'None':'Lax'}; Max-Age=${seconds}${local?'':'; Secure'}`;
 const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
 const clientId=p=>p==='google'?env.GOOGLE_CLIENT_ID:env.APPLE_CLIENT_ID;
 const configured=p=>p==='google'?!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET):!!(env.APPLE_CLIENT_ID&&env.APPLE_TEAM_ID&&env.APPLE_KEY_ID&&env.APPLE_PRIVATE_KEY&&vault.ready);
 const config=()=>Object.keys(providers).map(p=>({id:p,name:providers[p].name,enabled:configured(p)}));
 const callback=p=>requestOrigin()+'/api/portal/oauth/'+p+'/callback';
 const redirect=(res,to)=>{res.writeHead(303,{Location:to});res.end();return null;};
 async function secret(p){if(p==='google')return env.GOOGLE_CLIENT_SECRET;const {SignJWT,importPKCS8}=await jose();const key=await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n'),'ES256');return new SignJWT({}).setProtectedHeader({alg:'ES256',kid:env.APPLE_KEY_ID}).setIssuer(env.APPLE_TEAM_ID).setSubject(env.APPLE_CLIENT_ID).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);}
 async function pending(req,s){const value=readCookie(req,pendingName);assert(/^[a-f0-9]{64}$/.test(value),'Bitte den Anbieter-Login erneut starten.',401);const r=await s.get('oauth_pending',hash(value));assert(r&&r.expires>Date.now()&&r.origin===requestOrigin(),'Bitte den Anbieter-Login erneut starten.',401);return r;}
 async function finish(req,res,url,p){
  let nativeRequest=null;
  try{
   assert(configured(p),'Anbieter nicht eingerichtet.',503);let data;if(req.method==='POST'){assert((req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'),'Ungültige Rückmeldung.',415);data=Object.fromEntries(new URLSearchParams((await body(req,16000,true)).toString()));}else data=Object.fromEntries(url.searchParams);
   assert(/^[a-f0-9]{64}$/.test(data.state||''),'Ungültiger Anmeldevorgang.',401);
   const state=await tx(async s=>{const r=await s.get('oauth_state',hash(data.state));assert(r&&r.expires>Date.now()&&r.provider===p&&r.origin===requestOrigin()&&r.binding===hash(readCookie(req,bindingName)),'Dieser Login gehört nicht zu diesem Browser oder ist abgelaufen.',401);await s.remove('oauth_state',r.id);return r;});
   nativeRequest=state.nativeRequest||null;
   res.setHeader('Set-Cookie',cookie(bindingName,'',0,true));assert(!data.error&&typeof data.code==='string'&&data.code.length<=4096,'Anmeldung abgebrochen.',401);
   const form={client_id:clientId(p),client_secret:await secret(p),code:data.code,grant_type:'authorization_code',redirect_uri:callback(p)};if(p==='google')form.code_verifier=state.verifier;
   const response=await fetch(providers[p].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(10000),redirect:'error'});assert(response.ok,'Anbieter konnte den Login nicht bestätigen.',401);const result=await response.json();assert(typeof result.id_token==='string','Anbieter konnte den Login nicht bestätigen.',401);const identity=await verifyIdentity(result.id_token,p,clientId(p),state.nonce);
   const key=hash(p+':'+identity.sub);const protectedToken=p==='apple'?vault.seal(result.refresh_token||result.access_token,key):null;const tokenType=result.refresh_token?'refresh_token':'access_token';const outcome=await tx(async s=>{
    let mapping=await s.get('identity',key);if(mapping&&protectedToken){mapping={...mapping,protectedToken,tokenType};await s.put('identity',mapping,mapping.userId);}
    if(state.userId){const session=await s.get('session',state.sessionId),user=await s.get('user',state.userId);assert(session&&session.expires>Date.now()&&session.userId===state.userId&&user?.active,'Bitte erneut anmelden und den Anbieter verbinden.',401);assertPortalUser(user);checkWorkspace(user);assert(!mapping||mapping.userId===user.id,'Dieser Anbieter-Zugang ist bereits mit einem anderen Konto verbunden.',409);await s.put('identity',{id:key,provider:p,userId:user.id,...(protectedToken?{protectedToken,tokenType}:{}),createdAt:new Date().toISOString()},user.id);return {linked:true,redirect:user.role==='partner'?'/portal#einstellungen':'/gutachter-portal#einstellungen'};}
    if(mapping){const user=await s.get('user',mapping.userId);assert(user?.verifiedAt,'Bitte zuerst deine E-Mail bestätigen.',401);return issueSession(s,user);}
    assert(identity.email_verified===true||identity.email_verified==='true','Deine E-Mail-Adresse muss beim Anbieter bestätigt sein.',401);const address=email(identity.email);
    // Existing accounts must explicitly link from an authenticated, recent session; never merge by email.
    if(await s.get('user',hash(address))||address===(env.PORTAL_ADMIN_EMAIL||'info@unfallx.com'))return {redirect:'/login?oauth=link_required'};
    checkWorkspace({role:'partner'});const value=random();await s.put('oauth_pending',{id:hash(value),origin:requestOrigin(),identityId:key,provider:p,protectedToken,tokenType,email:address,name:text(identity.name||'',120),csrf:random(),expires:Date.now()+10*60000});return {pending:value,redirect:'/konto-vervollstaendigen'};
   });
   onVerified(p);
   if(nativeRequest&&nativeComplete)return await nativeComplete(req,res,nativeRequest,outcome);
   if(outcome.cookie)res.setHeader('Set-Cookie',[cookie(bindingName,'',0,true),outcome.cookie]);if(outcome.pending)res.setHeader('Set-Cookie',[cookie(bindingName,'',0,true),cookie(pendingName,outcome.pending)]);return redirect(res,outcome.redirect);
  }catch(e){console.error('OAuth callback failed:',p,e.code||e.status||'provider');if(nativeRequest&&nativeComplete)return nativeComplete(req,res,nativeRequest,{error:'provider_failed'});return redirect(res,'/login?oauth=failed');}
 }
 async function begin(req,res,data,nativeRequest=null){
const p=text(data.provider,20,true);assert(providers[p]&&configured(p),'Diese Anmeldemethode wird noch eingerichtet.',503);const state=random(),binding=random(),nonce=random(),verifier=random();let actor=null;
   await tx(async s=>{await rate(s,'oauth-start:'+ip(req),20);if(data.link===true){actor=await auth(req,s);assert(Date.now()-Date.parse(actor.session.createdAt)<15*60000,'Bitte für das Verknüpfen erneut anmelden (höchstens 15 Minuten).',401);}await s.put('oauth_state',{id:hash(state),origin:requestOrigin(),binding:hash(binding),nonce,verifier,provider:p,nativeRequest,userId:actor?.user.id||null,sessionId:actor?.session.id||null,expires:Date.now()+10*60000});});
   res.setHeader('Set-Cookie',cookie(bindingName,binding,600,true));const destination=new URL(providers[p].auth);Object.entries({client_id:clientId(p),redirect_uri:callback(p),response_type:'code',scope:p==='google'?'openid email profile':'email',state,nonce}).forEach(([k,v])=>destination.searchParams.set(k,v));if(p==='google'){destination.searchParams.set('code_challenge',Buffer.from(hash(verifier),'hex').toString('base64url'));destination.searchParams.set('code_challenge_method','S256');destination.searchParams.set('prompt','select_account');}else destination.searchParams.set('response_mode','form_post');return {redirect:destination.href};
 }
 async function route(path,req,res,url){
  const cb=path.match(/^\/oauth\/(google|apple)\/callback$/);if(cb)return finish(req,res,url,cb[1]);
  if(path==='/oauth/providers'&&req.method==='GET')return {providers:config()};
  if(path==='/oauth/start'&&req.method==='POST')return begin(req,res,await body(req));
  if(path==='/oauth/profile'&&req.method==='GET')return tx(async s=>{const r=await pending(req,s);return {email:r.email,name:r.name,provider:r.provider,csrf:r.csrf};});
  if(path==='/oauth/complete'&&req.method==='POST'){
   checkWorkspace({role:'partner'});const data=await body(req);assert(data.privacy===true&&data.terms===true,'Bitte Datenschutz und Nutzungsbedingungen bestätigen.');assert(data.typeOfAccount==='partner','Neue Zugänge sind ausschließlich für Partnerbetriebe vorgesehen.');const co=companyData(data),name=co.contact,phone=co.phone;
   const result=await tx(async s=>{const r=await pending(req,s);assert(req.headers['x-csrf-token']===r.csrf,'Bitte die Seite neu laden.',403);assert(!await s.get('user',hash(r.email))&&!await s.get('identity',r.identityId),'Zu dieser Adresse besteht bereits ein Zugang. Bitte normal anmelden und den Anbieter in den Einstellungen verbinden.',409);const companyId=id();await s.put('company',{...co,id:companyId,email:r.email,status:'pending',createdAt:new Date().toISOString(),reviewNote:''});const user={id:hash(r.email),email:r.email,name,phone,role:'partner',companyId,active:true,verifiedAt:new Date().toISOString(),createdAt:new Date().toISOString(),termsVersion:'2026-09-09'};await s.put('user',user,companyId||'internal');await s.put('identity',{id:r.identityId,provider:r.provider,userId:user.id,...(r.protectedToken?{protectedToken:r.protectedToken,tokenType:r.tokenType}:{}),createdAt:new Date().toISOString()},user.id);if(data.referralCode)await referrals.attribute(s,user,text(data.referralCode,32).toUpperCase());await s.remove('oauth_pending',r.id);return {...await issueSession(s,user),email:r.email};});
   res.setHeader('Set-Cookie',[cookie(pendingName,'',0),result.cookie]);const e=notice({title:'Willkommen bei UNFALLX Connect',copy:'Dein Partnerkonto ist angelegt. Wir prüfen jetzt deinen Betrieb und stimmen die Zusammenarbeit persönlich mit dir ab.',url:requestOrigin()+result.redirect,origin});try{await mail.send(result.email,e.subject,e.text,[],e.html);}catch{console.error('OAuth welcome notice: delivery unavailable');}return {redirect:result.redirect};
  }
  throw new Problem(404,'Nicht gefunden.');
 }
 async function revoke(identity){
  if(identity.provider!=='apple')return;
  assert(identity.protectedToken,'Vor der Löschung bitte die Apple-Verknüpfung durch erneute Apple-Anmeldung aktualisieren.',409);
  const token=vault.open(identity.protectedToken,identity.id);
  const response=await fetch('https://appleid.apple.com/auth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId('apple'),client_secret:await secret('apple'),token,token_type_hint:identity.tokenType||'refresh_token'}),signal:AbortSignal.timeout(10000),redirect:'error'});
  assert(response.ok,'Apple hat die Trennung noch nicht bestätigt. Bitte später erneut versuchen.',503);
 }
 return {route,config,begin,revoke};
}
module.exports={createOAuth,verifyIdentity};
