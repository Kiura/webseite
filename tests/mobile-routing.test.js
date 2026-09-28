'use strict';
// Run from the website root, or set UNFALLX_PORTAL_ROOT to its local path.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),{Readable}=require('node:stream');
const root=process.env.UNFALLX_PORTAL_ROOT||path.resolve(__dirname,'..');
const {createPortal}=require(path.join(root,'portal/app')),{createStore}=require(path.join(root,'portal/store'));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const fields={'claimant.first':'Alex','claimant.last':'Beispiel','claimant.street':'Musterstraße 12','claimant.zip':'10115','claimant.city':'Berlin',plate:'B UX 123'};
async function fixture(extra={}){
 const store=await createStore({NODE_ENV:'test',PORTAL_LOCAL_DB:':memory:'});
 const portal=createPortal({store,env:{NODE_ENV:'production',PORTAL_MOBILE_INTAKE_ENABLED:'true'},mail:{ready:false,send:async()=>{throw new Error('No mail in tests');}},...extra});await portal.ready();
 async function call(host,route,data,headers={}){
  const bytes=data===undefined?null:Buffer.from(JSON.stringify(data));const req=Readable.from(bytes?[bytes]:[]);
  Object.assign(req,{method:bytes?'POST':'GET',url:'/api/portal'+route,headers:{host,'content-type':'application/json',...headers},socket:{remoteAddress:'127.0.0.1'}});
  const res={statusCode:200,headersSent:false,headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(code,h){this.statusCode=code;Object.assign(this.headers,h);},end(value){this.value=JSON.parse(String(value));this.headersSent=true;}};
  await portal.handle(req,res,{});return {status:res.statusCode,json:res.value};
 }
 const sessions={};
 for(const role of ['admin','partner','other','pending','mfa']){
  const secret=crypto.randomBytes(32).toString('hex');sessions[role]=secret;
  await store.transaction(async s=>{
   const companyId=role==='admin'?null:'company-'+role;
   if(companyId)await s.put('company',{id:companyId,status:role==='pending'?'pending':'approved',name:'Testfirma '+role});
   await s.put('user',{id:role,role:role==='admin'?'admin':'partner',name:'TEST '+role,email:role+'@example.test',active:true,companyId});
   await s.put('session',{id:hash(secret),userId:role,workspace:role==='admin'?'admin':'partner',expires:Date.now()+60000,pendingMfa:role==='mfa',csrf:'test'},role);
  });
 }
 const headers=(role='partner')=>({cookie:'__Host-ux_session='+sessions[role],'x-csrf-token':'test',origin:role==='admin'?'https://admin.unfallx.com':'https://app.unfallx.com'});
 return {store,portal,call,headers};
}
test('production mobile API requires approved session, MFA, CSRF and correct host',async()=>{
 const {portal,call,headers}=await fixture();try{
  const data={id:crypto.randomUUID(),reference:'TEST',fields,fieldsHash:hash(JSON.stringify(fields))},cap={authorization:'Bearer '+crypto.randomBytes(32).toString('hex')};
  assert.equal((await call('app.unfallx.com','/mobile/config')).json.version,2);
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,cap)).status,401);
  for(const role of ['pending','mfa'])assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers(role),...cap})).status,role==='pending'?403:401);
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers(),...cap,'x-csrf-token':'wrong'})).status,403);
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers(),...cap})).status,200);
  assert.equal((await call('admin.unfallx.com','/mobile/cases',data,{...headers('admin'),...cap})).status,403);
  assert.equal((await call('mobile.unfallx.com','/mobile/cases',data,{...headers(),...cap})).status,410);
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers(),...cap,origin:'https://evil.example'})).status,403);
  assert.equal((await call('app.unfallx.com','/mobile/cases',undefined,headers())).status,405);
 }finally{await portal.close();}
});
test('admin receives native case; own company sees it; other companies cannot read or write even with its capability',async()=>{
 const {store,portal,call,headers}=await fixture();try{
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),data={id,reference:'TEST',fields,fieldsHash:hash(JSON.stringify(fields))};
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers(),authorization:'Bearer '+token})).status,200);
  const admin=await call('admin.unfallx.com','/cases/'+id,undefined,headers('admin'));
  assert.equal(admin.status,200);assert.equal(admin.json.case.intake.owner,'Alex Beispiel');assert.deepEqual(admin.json.case.mobile.fields,fields);assert(!JSON.stringify(admin.json).includes(token));
  assert.equal((await call('app.unfallx.com','/cases/'+id,undefined,headers())).status,200);
  assert.equal((await call('app.unfallx.com','/cases/'+id,undefined,headers('other'))).status,404);
  assert.equal((await call('app.unfallx.com','/mobile/cases',data,{...headers('other'),authorization:'Bearer '+token})).status,404);
  assert.equal((await call('app.unfallx.com','/mobile/overview',undefined,headers())).json.items.length,1);
  assert.equal((await call('app.unfallx.com','/mobile/overview',undefined,headers('other'))).json.items.length,0);
  assert.equal((await call('app.unfallx.com','/mobile/overview')).status,401);
  const overview=await call('app.unfallx.com','/mobile/overview',undefined,headers());
  assert.equal(overview.json.items[0].commission.amountCents,null);
  assert.deepEqual(overview.json.totals,{expectedCents:0,payableCents:0,paidCents:0});
 }finally{await portal.close();}
});
test('optional customer company is persisted, editable and independent of the partner company',async()=>{
 const {portal,call,headers}=await fixture();try{
  const id=crypto.randomUUID(),authorization='Bearer '+crypto.randomBytes(32).toString('hex');
  const save=f=>call('app.unfallx.com','/mobile/cases',{id,reference:'TEST-FIRMA',fields:f,fieldsHash:hash(JSON.stringify(f))},{...headers(),authorization});
  const read=async()=> (await call('admin.unfallx.com','/cases/'+id,undefined,headers('admin'))).json.case;
  assert.equal((await save({...fields,'claimant.company':'  Musterfirma GmbH  '})).status,200);
  let c=await read();
  assert.equal(c.mobile.fields['claimant.company'],'Musterfirma GmbH');
  assert.equal(c.intake.ownerCompany,'Musterfirma GmbH');assert.equal(c.intake.ownerType,'company');
  assert.equal(c.intake.owner,'Musterfirma GmbH · Alex Beispiel');
  assert.equal(c.companyId,'company-partner');assert.equal(c.companyName,'Testfirma partner');
  assert.equal((await save({...fields,'claimant.company':'Andere Firma GmbH'})).status,200);
  assert.equal((await read()).intake.ownerCompany,'Andere Firma GmbH');
  assert.equal((await save({...fields,'claimant.company':'Firma','claimant.first':''})).status,400);
  assert.equal((await save({...fields,'claimant.unknown':'Nicht erlaubt'})).status,400);
  assert.equal((await save({...fields,'claimant.company':''})).status,200);
  c=await read();assert.equal(c.intake.ownerCompany,'');assert.equal(c.intake.ownerType,'person');assert.equal(c.intake.owner,'Alex Beispiel');
  assert.equal((await save(fields)).status,200);
 }finally{await portal.close();}
});
test('real admin finance calculation flows into native 50% commission and payment gates',async()=>{
 const {store,portal,call,headers}=await fixture();try{
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  await call('app.unfallx.com','/mobile/cases',{id,reference:'TEST',fields,fieldsHash:hash(JSON.stringify(fields))},{...headers(),authorization:'Bearer '+token});
  const action=async(data)=>{const row=await store.transaction(s=>s.get('case',id));return call('admin.unfallx.com','/cases/'+id,{version:row.version,...data},headers('admin'));};
  const calc=await action({action:'finance',calculation:{amount:'100',basis:'net',vatPercent:'19',partnerPercent:'50',partnerVatPercent:'0'},invoiceNumber:'TEST-100',agreement:'Testvereinbarung 50 % netto'});
  assert.equal(calc.status,200,JSON.stringify(calc));
  const view=async()=> (await call('app.unfallx.com','/mobile/overview',undefined,headers())).json;
  let v=await view();assert.equal(v.items[0].commission.amountCents,5000);assert.equal(v.items[0].commission.percent,50);assert.equal(v.items[0].commission.invoiceNetCents,10000);assert.equal(v.totals.payableCents,0);
  await store.transaction(async s=>{const c=await s.get('case',id);c.status='report_sent';c.finance.partnerAcceptedAt=new Date().toISOString();await s.put('case',c,c.companyId);});
  assert.equal((await action({action:'payment',amount:'50',date:'2026-09-11',reference:'Test Teilzahlung'})).status,200);
  v=await view();assert.equal(v.items[0].commission.stage,'payment_pending');assert.equal(v.totals.payableCents,0);
  assert.equal((await action({action:'payment',amount:'69',date:'2026-09-11',reference:'Test Restzahlung'})).status,200);
  assert.equal((await view()).items[0].commission.stage,'invoice_pending');
  assert.notEqual((await action({action:'payout',confirmed:true,date:'2026-09-11',reference:'Unzulässig'})).status,200);
  await store.transaction(async s=>{const c=await s.get('case',id);c.finance.partnerInvoiceId='fixture-invoice';await s.put('case',c,c.companyId);});
  assert.equal((await action({action:'approve_invoice',confirmed:true})).status,200);
  v=await view();assert.equal(v.totals.payableCents,5000);assert.equal(v.totals.expectedCents,5000);
  assert.equal((await action({action:'payout',confirmed:true,date:'2026-09-11',reference:'Testüberweisung'})).status,200);
  v=await view();assert.equal(v.totals.expectedCents,0);assert.equal(v.totals.payableCents,0);assert.equal(v.totals.paidCents,5000);
 }finally{await portal.close();}
});

 test('production push routes enforce host, origin, CSRF, MFA and approval',async()=>{
 const {store,portal,call,headers}=await fixture({pushTransport:{ready:true,send:async()=>({status:200})}});try{
  const data={installationId:crypto.randomUUID(),enabled:true,token:'aa'.repeat(32),environment:'production',preferences:{requests:true,accepted:true,commission:true}};
  assert.equal((await call('app.unfallx.com','/mobile/push/config')).status,401);
  assert.equal((await call('app.unfallx.com','/mobile/push/config',undefined,headers())).json.enabled,true);
  assert.equal((await call('app.unfallx.com','/mobile/push/device',data,headers())).status,200);
  assert.equal((await call('admin.unfallx.com','/mobile/push/device',data,headers('admin'))).status,403);
  for(const role of ['pending','mfa'])assert.equal((await call('app.unfallx.com','/mobile/push/device',data,headers(role))).status,role==='mfa'?401:403);
  assert.equal((await call('app.unfallx.com','/mobile/push/device',data,{...headers(),'x-csrf-token':'wrong'})).status,403);
  assert.equal((await call('app.unfallx.com','/mobile/push/device',data,{...headers(),origin:'https://evil.test'})).status,403);
  assert.equal((await store.transaction(s=>s.list('push_device'))).length,1);
 }finally{await portal.close();}
});

test('2.7 tools require approved company, CSRF, correct host and fresh agreement version',async()=>{
 const {store,portal,call,headers}=await fixture();try{
  const cid=crypto.randomUUID();await store.transaction(s=>s.put('case',{id:cid,companyId:'company-partner',number:'TEST-27',version:4,status:'report_sent',intake:{plate:'B UX 27',vin:'WVWZZZ1JZXW000027'},finance:{invoiceNet:10000,invoiceGross:11900,partnerNet:5000,agreement:'TEST Vergütung 50 % netto',agreedAt:new Date().toISOString(),received:11900}},'company-partner'));
  const diag={id:crypto.randomUUID(),day:new Date().toISOString().slice(0,10),version:'2.7',build:'16',counts:{hang:1}};
  for(const [path,data]of [['/mobile/duplicates',{plate:'B-UX27',vin:''}],['/mobile/diagnostics',diag],['/mobile/payout/'+cid,undefined]]){
   assert.equal((await call('app.unfallx.com',path,data)).status,401);
   assert.equal((await call('app.unfallx.com',path,data,headers('pending'))).status,403);
   assert.equal((await call('app.unfallx.com',path,data,headers('mfa'))).status,401);
   assert.equal((await call('admin.unfallx.com',path,data,headers('admin'))).status,403);
   if(data)assert.equal((await call('app.unfallx.com',path,data,{...headers(),'x-csrf-token':'wrong'})).status,403);
  }
  const check=(await call('app.unfallx.com','/mobile/payout/'+cid,undefined,headers())).json;
  assert.equal(check.version,4);assert.equal(check.canConfirm,true);assert.equal(check.canUpload,false);
  assert.equal((await call('app.unfallx.com','/mobile/payout/'+cid,undefined,headers('other'))).status,404);
  assert.equal((await call('app.unfallx.com','/mobile/duplicates',{plate:'B-UX27'},headers('other'))).json.matches.length,0);
  assert.equal((await call('app.unfallx.com','/mobile/duplicates',{plate:'B-UX27'},headers())).json.matches[0].id,cid);
  assert.equal((await call('app.unfallx.com','/cases/'+cid,{action:'accept_terms',version:3},headers())).status,409);
  assert.equal((await call('app.unfallx.com','/cases/'+cid,{action:'accept_terms',version:4},headers())).status,200);
  const after=(await call('app.unfallx.com','/mobile/payout/'+cid,undefined,headers())).json;assert.equal(after.canConfirm,false);assert.equal(after.canUpload,true);assert.equal(after.steps.find(s=>s.id==='approval').done,false);
  assert.equal((await call('app.unfallx.com','/mobile/diagnostics',diag,headers())).status,200);
  const admin=(await call('admin.unfallx.com','/admin/system',undefined,headers('admin'))).json;assert.equal(admin.mobileDiagnostics[0].counts.hang,1);
 }finally{await portal.close();}
});
