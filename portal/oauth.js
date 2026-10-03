'use strict';
const {assert,text,email,hash,random,id,companyData,Problem}=require('./domain');
const {notice}=require('./brand-mail');
const {assertPortalUser}=require('./access');
const jose=()=>import('jose');
// Reihenfolge bestimmt die Reihenfolge der Anmeldeschaltflächen: 0account zuerst.
// 0account-Adressen unterscheiden sich je Umgebung (Test/Produktion) und werden
// deshalb aus ZEROACCOUNT_ISSUER abgeleitet, siehe zeroaccount() unten.
const ZEROACCOUNT_DEFAULT_ISSUER='https://v1.0account.com';
function zeroaccount(env){const base=String(env.ZEROACCOUNT_ISSUER||ZEROACCOUNT_DEFAULT_ISSUER).replace(/\/+$/,'');return {name:'0account',auth:base+'/oauth/authorize',token:base+'/oauth/token',keys:base+'/.well-known/jwks.json',userinfo:base+'/oauth/userinfo',issuer:base,alg:'EdDSA'};}
// Für die Abmeldung: der Endpunkt erwartet den ursprünglichen ID-Token als Hinweis.
const ZEROACCOUNT_END_SESSION='/oauth/logout';
// Empfangsadresse für den Back-Channel-Logout von 0account (Server zu Server).
const ZEROACCOUNT_BACKCHANNEL='/oauth/0account/backchannel-logout';
const providers={
 '0account':zeroaccount(process.env),
 google:{name:'Google',auth:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',keys:'https://www.googleapis.com/oauth2/v3/certs',issuer:['https://accounts.google.com','accounts.google.com']},
 apple:{name:'Apple',auth:'https://appleid.apple.com/auth/authorize',token:'https://appleid.apple.com/auth/token',keys:'https://appleid.apple.com/auth/keys',issuer:'https://appleid.apple.com'}
};
const keysets=new Map();
// Google liefert "name", 0account nur "given_name"/"family_name" (OIDC Core
// §5.1 macht keines davon zur Pflicht). Ohne diese Zusammensetzung bliebe der
// Ansprechpartner bei 0account leer.
const personName=identity=>text(identity.name||[identity.given_name,identity.family_name].filter(Boolean).join(' '),120);
// Eigene Felder eines Anbieters stehen bei 0account unter einem Namensraum,
// nicht als Standard-Claims. Fehlt der Namensraum, bleibt alles leer und das
// Formular verhält sich wie bisher.
const ZEROACCOUNT_FIELDS='https://0account.com/claims/fields';
const companyFields=identity=>{
 const fields=identity[ZEROACCOUNT_FIELDS];
 if(!fields||typeof fields!=='object')return {};
 const pick=(key,max)=>text(typeof fields[key]==='string'?fields[key]:'',max);
 // Zustimmungen kommen als Häkchen zurück; sie werden im Formular vorbelegt,
 // bleiben aber abwählbar, weil sie dort bestätigt werden müssen.
 const consented=value=>value===true||value==='true';
 return {name:pick('companyName',180),street:pick('streetAddress',180),postcode:pick('postalCode',12),city:pick('city',100),type:pick('companyType',30),referralCode:pick('referralCode',32).toUpperCase(),terms:consented(fields.termsAndConditions),privacy:consented(fields.privacyPolicy)};
};
// Der Anbieter ersetzt das Formular nur, wenn er alles mitbringt, was
// companyData verlangt, einschließlich beider Zustimmungen. Fehlt eine Angabe,
// wird weiterhin das Formular gezeigt: eine halb ausgefüllte Registrierung ist
// schlechter als eine, die zwei Angaben erfragt.
const COMPANY_TYPES=['Werkstatt','Gutachter / Fotopartner','Abschleppdienst','Sonstiges Unternehmen'];
// Die Unternehmensart ist die einzige Angabe, die 0account nicht führen kann:
// dort sind nur diese vier Werte zulässig und ein Auswahl-Typ existiert nicht.
// Sie deshalb zur Pflicht zu machen hieße, dass dieser Weg nie greift.
//
// Das Formular stellt dieselbe Frage bereits mit Vorauswahl: das Auswahlfeld
// hat keinen leeren Eintrag, es sendet ohne Zutun "Werkstatt". Wer das Formular
// abschickt, ohne die Auswahl anzufassen, legt denselben Wert an. Hier wird das
// also nicht schlechter, sondern gleich — und die Administration prüft den
// Betrieb ohnehin vor der Freischaltung und kann die Art dort richtigstellen.
const DEFAULT_COMPANY_TYPE='Werkstatt';
function completeRegistration(identity,contact,phone,company){
 const fields=identity[ZEROACCOUNT_FIELDS];
 if(!fields||typeof fields!=='object')return null;
 const consented=value=>value===true||value==='true';
 if(!consented(fields.termsAndConditions)||!consented(fields.privacyPolicy))return null;
 if(!contact||!phone)return null;
 if(!company.name||!company.street||!company.postcode||!company.city)return null;
 // Eine mitgegebene Art wird nur übernommen, wenn sie zulässig ist; ein
 // unbekannter Wert fällt auf die Vorauswahl zurück statt die Eingabe zu
 // zerbrechen.
 const type=COMPANY_TYPES.includes(company.type)?company.type:DEFAULT_COMPANY_TYPE;
 return {company:company.name,contact,phone,street:company.street,postcode:company.postcode,city:company.city,type};
}
// config überschreibt den Tabelleneintrag, damit 0account seine umgebungs-
// abhängigen Adressen mitgeben kann. Der Schlüsselcache hängt deshalb an der
// JWKS-Adresse, nicht am Anbieternamen: sonst würde Test gegen Produktion prüfen.
async function verifyIdentity(token,provider,clientId,nonce,keySet,config){const {jwtVerify,createRemoteJWKSet}=await jose();const p=config||providers[provider];assert(p,'Unbekannter Anbieter.');if(!keysets.has(p.keys))keysets.set(p.keys,createRemoteJWKSet(new URL(p.keys),{timeoutDuration:10000}));const {payload}=await jwtVerify(token,keySet||keysets.get(p.keys),{issuer:p.issuer,audience:clientId,algorithms:[p.alg||'RS256'],clockTolerance:30,maxTokenAge:'10m',requiredClaims:['exp','iat','sub','nonce']});assert(payload.nonce===nonce&&typeof payload.sub==='string'&&payload.sub.length>0&&payload.sub.length<=255,'Anmeldung konnte nicht bestätigt werden.',401);return payload;}
function createOAuth({env,origin,tx,rate,ip,body,auth,issueSession,mail,referrals,requestOrigin=()=>origin,checkWorkspace=()=>{},onVerified=()=>{},nativeComplete=null}){
 const vault=require('./oauth-tokens').tokenVault(env);
 const local=env.NODE_ENV==='test';const bindingName=local?'ux_oauth':'__Host-ux_oauth',pendingName=local?'ux_onboarding':'__Host-ux_onboarding';
 // Anbietertabelle dieser Instanz: 0account aus der übergebenen Umgebung.
 const table={...providers,'0account':zeroaccount(env)};
 const settings=p=>table[p];
 // Eigene Felder liefert 0account nur unter /userinfo, nicht im ID-Token.
 // Nur ergänzende Angaben werden übernommen: sub, email und email_verified
 // bleiben die geprüften Werte aus dem ID-Token, damit eine abweichende
 // Antwort an dieser Stelle keine andere Identität unterschieben kann.
 // Scheitert der Abruf, wird die Anmeldung nicht abgebrochen; das Formular
 // ist dann nur weniger vorausgefüllt.
 async function extraClaims(p,accessToken){
  const info=settings(p).userinfo;
  if(!info||typeof accessToken!=='string'||!accessToken)return {};
  try{
   const response=await fetch(info,{headers:{Authorization:'Bearer '+accessToken},signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!response.ok)return {};
   const claims=await response.json();
   const {sub,email,email_verified,...rest}=claims&&typeof claims==='object'?claims:{};
   return rest;
  }catch{return {};}
 }
 const cookie=(name,value,seconds=600,cross=false)=>`${name}=${value}; Path=/; HttpOnly; SameSite=${cross&&!local?'None':'Lax'}; Max-Age=${seconds}${local?'':'; Secure'}`;
 const readCookie=(req,name)=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
 const clientId=p=>p==='0account'?env.ZEROACCOUNT_CLIENT_ID:p==='google'?env.GOOGLE_CLIENT_ID:env.APPLE_CLIENT_ID;
 const configured=p=>p==='0account'?!!(env.ZEROACCOUNT_CLIENT_ID&&env.ZEROACCOUNT_CLIENT_SECRET):p==='google'?!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET):!!(env.APPLE_CLIENT_ID&&env.APPLE_TEAM_ID&&env.APPLE_KEY_ID&&env.APPLE_PRIVATE_KEY&&vault.ready);
 const config=()=>Object.keys(table).map(p=>({id:p,name:table[p].name,enabled:configured(p)}));
 const callback=p=>requestOrigin()+'/api/portal/oauth/'+p+'/callback';
 const redirect=(res,to)=>{res.writeHead(303,{Location:to});res.end();return null;};
 async function secret(p){if(p==='0account')return env.ZEROACCOUNT_CLIENT_SECRET;if(p==='google')return env.GOOGLE_CLIENT_SECRET;const {SignJWT,importPKCS8}=await jose();const key=await importPKCS8(env.APPLE_PRIVATE_KEY.replace(/\\n/g,'\n'),'ES256');return new SignJWT({}).setProtectedHeader({alg:'ES256',kid:env.APPLE_KEY_ID}).setIssuer(env.APPLE_TEAM_ID).setSubject(env.APPLE_CLIENT_ID).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);}
 async function pending(req,s){const value=readCookie(req,pendingName);assert(/^[a-f0-9]{64}$/.test(value),'Bitte den Anbieter-Login erneut starten.',401);const r=await s.get('oauth_pending',hash(value));assert(r&&r.expires>Date.now()&&r.origin===requestOrigin(),'Bitte den Anbieter-Login erneut starten.',401);return r;}
 async function finish(req,res,url,p){
  let nativeRequest=null;
  try{
   assert(configured(p),'Anbieter nicht eingerichtet.',503);let data;if(req.method==='POST'){assert((req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'),'Ungültige Rückmeldung.',415);data=Object.fromEntries(new URLSearchParams((await body(req,16000,true)).toString()));}else data=Object.fromEntries(url.searchParams);
   assert(/^[a-f0-9]{64}$/.test(data.state||''),'Ungültiger Anmeldevorgang.',401);
   const state=await tx(async s=>{const r=await s.get('oauth_state',hash(data.state));assert(r&&r.expires>Date.now()&&r.provider===p&&r.origin===requestOrigin()&&r.binding===hash(readCookie(req,bindingName)),'Dieser Login gehört nicht zu diesem Browser oder ist abgelaufen.',401);await s.remove('oauth_state',r.id);return r;});
   nativeRequest=state.nativeRequest||null;
   res.setHeader('Set-Cookie',cookie(bindingName,'',0,true));assert(!data.error&&typeof data.code==='string'&&data.code.length<=4096,'Anmeldung abgebrochen.',401);
   const form={client_id:clientId(p),client_secret:await secret(p),code:data.code,grant_type:'authorization_code',redirect_uri:callback(p)};if(p==='google'||p==='0account')form.code_verifier=state.verifier;
   const response=await fetch(settings(p).token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(10000),redirect:'error'});assert(response.ok,'Anbieter konnte den Login nicht bestätigen.',401);const result=await response.json();assert(typeof result.id_token==='string','Anbieter konnte den Login nicht bestätigen.',401);const identity={...await verifyIdentity(result.id_token,p,clientId(p),state.nonce,undefined,settings(p)),...await extraClaims(p,result.access_token)};
   const key=hash(p+':'+identity.sub);const protectedToken=p==='apple'?vault.seal(result.refresh_token||result.access_token,key):null;const tokenType=result.refresh_token?'refresh_token':'access_token';const outcome=await tx(async s=>{
    let mapping=await s.get('identity',key);if(mapping&&protectedToken){mapping={...mapping,protectedToken,tokenType};await s.put('identity',mapping,mapping.userId);}
    if(state.userId){const session=await s.get('session',state.sessionId),user=await s.get('user',state.userId);assert(session&&session.expires>Date.now()&&session.userId===state.userId&&user?.active,'Bitte erneut anmelden und den Anbieter verbinden.',401);assertPortalUser(user);checkWorkspace(user);const company=user.role==='partner'?await s.get('company',user.companyId):null,erasure=await s.get('account_erasure',user.id);assert(!session.pendingMfa&&Date.now()-Date.parse(session.createdAt)<15*60000&&user.verifiedAt&&(!erasure||Date.parse(user.createdAt)>Date.parse(erasure.deletedAt))&&(user.role!=='partner'||company&&company.status!=='suspended'),'Bitte erneut anmelden und den Anbieter verbinden.',401);assert(!mapping||mapping.userId===user.id,'Dieser Anbieter-Zugang ist bereits mit einem anderen Konto verbunden.',409);await s.put('identity',{id:key,provider:p,userId:user.id,...(protectedToken?{protectedToken,tokenType}:{}),createdAt:new Date().toISOString()},user.id);return {linked:true,redirect:user.role==='partner'?'/portal#einstellungen':'/gutachter-portal#einstellungen'};}
    if(mapping){const user=await s.get('user',mapping.userId);assert(user?.verifiedAt,'Bitte zuerst deine E-Mail bestätigen.',401);return issueSession(s,user,null,{provider:p,idToken:result.id_token,sid:identity.sid});}
    assert(identity.email_verified===true||identity.email_verified==='true','Deine E-Mail-Adresse muss beim Anbieter bestätigt sein.',401);const address=email(identity.email);
    // Existing accounts must explicitly link from an authenticated, recent session; never merge by email.
    if(await s.get('user',hash(address))||address===(env.PORTAL_ADMIN_EMAIL||'info@unfallx.com'))return {redirect:'/login?oauth=link_required'};
    checkWorkspace({role:'partner'});const contact=personName(identity),phone=text(identity.phone_number||'',40),company=companyFields(identity);
    // Bringt der Anbieter alles mit, entsteht das Partnerkonto direkt; der
    // Betrieb wird wie bei jeder Registrierung erst nach Prüfung freigegeben.
    const direct=completeRegistration(identity,contact,phone,company);
    if(direct){
     const co=companyData(direct),companyId=id();
     await s.put('company',{...co,id:companyId,email:address,status:'pending',createdAt:new Date().toISOString(),reviewNote:''});
     const user={id:hash(address),email:address,name:co.contact,phone:co.phone,role:'partner',companyId,active:true,verifiedAt:new Date().toISOString(),createdAt:new Date().toISOString(),termsVersion:'2026-09-09'};
     await s.put('user',user,companyId||'internal');
     await s.put('identity',{id:key,provider:p,userId:user.id,...(protectedToken?{protectedToken,tokenType}:{}),createdAt:new Date().toISOString()},user.id);
     // Wie über das Formular: ein mitgegebener Empfehlungscode wird zugeordnet.
     if(company.referralCode)await referrals.attribute(s,user,company.referralCode);
     return {...await issueSession(s,user,null,{provider:p,idToken:result.id_token,sid:identity.sid}),registered:address};
    }
    const value=random();await s.put('oauth_pending',{id:hash(value),origin:requestOrigin(),identityId:key,provider:p,protectedToken,tokenType,email:address,idToken:result.id_token,sid:identity.sid,name:contact,phone,company,csrf:random(),expires:Date.now()+10*60000});return {pending:value,redirect:'/konto-vervollstaendigen'};
   });
   onVerified(p);
   // Dieselbe Begrüßung wie nach dem Formular. Ein fehlgeschlagener Versand
   // darf das bereits angelegte Konto nicht zurücknehmen.
   if(outcome.registered){const e=notice({title:'Willkommen bei UNFALLX Connect',copy:'Dein Partnerkonto ist angelegt. Wir prüfen jetzt deinen Betrieb und stimmen die Zusammenarbeit persönlich mit dir ab.',url:requestOrigin()+outcome.redirect,origin});try{await mail.send(outcome.registered,e.subject,e.text,[],e.html);}catch{console.error('OAuth welcome notice: delivery unavailable');}}
   if(nativeRequest&&nativeComplete)return await nativeComplete(req,res,nativeRequest,outcome);
   if(outcome.cookie)res.setHeader('Set-Cookie',[cookie(bindingName,'',0,true),outcome.cookie]);if(outcome.pending)res.setHeader('Set-Cookie',[cookie(bindingName,'',0,true),cookie(pendingName,outcome.pending)]);return redirect(res,outcome.redirect);
  }catch(e){console.error('OAuth callback failed:',p,e.code||e.status||'provider');if(nativeRequest&&nativeComplete)return nativeComplete(req,res,nativeRequest,{error:'provider_failed'});return redirect(res,'/login?oauth=failed');}
 }
 // Back-Channel-Logout: 0account meldet sich ohne Browser, Cookies oder CSRF
 // und nennt die endende Sitzung über die sid. Genau die hierzu gehörigen
 // Sitzungen enden; Fehler antworten gemäß Spezifikation mit 400 und stören
 // sonst nichts.
 async function backchannel(req,res){
  try{
   assert(configured('0account'),'Anbieter nicht eingerichtet.',503);
   assert((req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'),'Ungültige Rückmeldung.',415);
   const data=Object.fromEntries(new URLSearchParams((await body(req,16000,true)).toString()));
   assert(typeof data.logout_token==='string'&&data.logout_token.length<=8192,'Ungültige Rückmeldung.',400);
   const {jwtVerify,createRemoteJWKSet}=await jose();
   const address=settings('0account').keys;
   if(!keysets.has(address))keysets.set(address,createRemoteJWKSet(new URL(address),{timeoutDuration:10000}));
   const {payload}=await jwtVerify(data.logout_token,keysets.get(address),{issuer:settings('0account').issuer,audience:clientId('0account'),algorithms:['EdDSA'],clockTolerance:30,requiredClaims:['exp','iat','iss','aud','events','sid']});
   // Spezifikation: ein Abmelde-Hinweis trägt niemals einen nonce und immer ein
   // exp. 0account sendet exp jetzt (fünf Minuten nach iat), deshalb wird es
   // hier verlangt statt nur geprüft, wenn es zufällig vorhanden ist.
   assert(!('nonce'in payload),'Ungültige Rückmeldung.',400);
   assert(payload.events&&typeof payload.events==='object'&&'http://schemas.openid.net/event/backchannel-logout'in payload.events,'Ungültige Rückmeldung.',400);
   assert(typeof payload.sid==='string'&&payload.sid.length>0&&payload.sid.length<=64,'Ungültige Rückmeldung.',400);
   await tx(async s=>{await rate(s,'backchannel:'+ip(req),60);for(const session of await s.list('session'))if(session.idp?.provider==='0account'&&session.idp.sid===payload.sid)await s.remove('session',session.id);});
   return {ok:true};
  }catch(e){
   // Fehlkonfiguration und Ausfälle behalten ihren Status; nur ein ungültiger
   // Hinweis antwortet gemäß Spezifikation mit 400.
   if(e instanceof Problem)throw e;
   console.error('Back-channel logout failed:',e.code||'invalid');
   res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid_request'}));return null;}
 }
 async function begin(req,res,data,nativeRequest=null,nativeLink=null){
const p=text(data.provider,20,true);assert(table[p]&&configured(p),'Diese Anmeldemethode wird noch eingerichtet.',503);const state=random(),binding=random(),nonce=random(),verifier=random();let actor=null;
   await tx(async s=>{await rate(s,'oauth-start:'+ip(req),20);if(data.link===true){if(nativeLink&&nativeRequest){const user=await s.get('user',nativeLink.userId),session=await s.get('session',nativeLink.sessionId),company=user&&await s.get('company',user.companyId);assert(user?.active&&user.verifiedAt&&user.role==='partner'&&session?.userId===user.id&&session.expires>Date.now()&&!session.pendingMfa&&company&&company.status!=='suspended','Bitte erneut anmelden.',401);checkWorkspace(user);actor={user,session};}else actor=await auth(req,s);assert(Date.now()-Date.parse(actor.session.createdAt)<15*60000,'Bitte für das Verknüpfen erneut anmelden (höchstens 15 Minuten).',401);}await s.put('oauth_state',{id:hash(state),origin:requestOrigin(),binding:hash(binding),nonce,verifier,provider:p,nativeRequest,userId:actor?.user.id||null,sessionId:actor?.session.id||null,expires:Date.now()+10*60000});});
   res.setHeader('Set-Cookie',cookie(bindingName,binding,600,true));const destination=new URL(settings(p).auth);Object.entries({client_id:clientId(p),redirect_uri:callback(p),response_type:'code',scope:p==='apple'?'email':'openid email profile',state,nonce}).forEach(([k,v])=>destination.searchParams.set(k,v));if(p==='google'||p==='0account'){destination.searchParams.set('code_challenge',Buffer.from(hash(verifier),'hex').toString('base64url'));destination.searchParams.set('code_challenge_method','S256');if(p==='google')destination.searchParams.set('prompt','select_account');}else destination.searchParams.set('response_mode','form_post');return {redirect:destination.href};
 }
 async function route(path,req,res,url){
  const cb=path.match(/^\/oauth\/(0account|google|apple)\/callback$/);if(cb)return finish(req,res,url,cb[1]);
  if(path===ZEROACCOUNT_BACKCHANNEL&&req.method==='POST')return backchannel(req,res);
  if(path==='/oauth/providers'&&req.method==='GET')return {providers:config()};
  if(path==='/oauth/start'&&req.method==='POST')return begin(req,res,await body(req));
  if(path==='/oauth/profile'&&req.method==='GET')return tx(async s=>{const r=await pending(req,s);return {email:r.email,name:r.name,phone:r.phone||'',company:r.company||{},provider:r.provider,csrf:r.csrf};});
  if(path==='/oauth/complete'&&req.method==='POST'){
   checkWorkspace({role:'partner'});const data=await body(req);assert(data.privacy===true&&data.terms===true,'Bitte Datenschutz und Nutzungsbedingungen bestätigen.');assert(data.typeOfAccount==='partner','Neue Zugänge sind ausschließlich für Partnerbetriebe vorgesehen.');const co=companyData(data),name=co.contact,phone=co.phone;
   const result=await tx(async s=>{const r=await pending(req,s);assert(req.headers['x-csrf-token']===r.csrf,'Bitte die Seite neu laden.',403);assert(!await s.get('user',hash(r.email))&&!await s.get('identity',r.identityId),'Zu dieser Adresse besteht bereits ein Zugang. Bitte normal anmelden und den Anbieter in den Einstellungen verbinden.',409);const companyId=id();await s.put('company',{...co,id:companyId,email:r.email,status:'pending',createdAt:new Date().toISOString(),reviewNote:''});const user={id:hash(r.email),email:r.email,name,phone,role:'partner',companyId,active:true,verifiedAt:new Date().toISOString(),createdAt:new Date().toISOString(),termsVersion:'2026-09-09'};await s.put('user',user,companyId||'internal');await s.put('identity',{id:r.identityId,provider:r.provider,userId:user.id,...(r.protectedToken?{protectedToken:r.protectedToken,tokenType:r.tokenType}:{}),createdAt:new Date().toISOString()},user.id);if(data.referralCode)await referrals.attribute(s,user,text(data.referralCode,32).toUpperCase());await s.remove('oauth_pending',r.id);return {...await issueSession(s,user,null,{provider:r.provider,idToken:r.idToken,sid:r.sid}),email:r.email};});
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
module.exports={createOAuth,verifyIdentity,zeroaccount,ZEROACCOUNT_END_SESSION,ZEROACCOUNT_BACKCHANNEL};
