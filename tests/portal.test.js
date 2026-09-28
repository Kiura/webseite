'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const sharp=require('sharp');
const {createPortal}=require('../portal/app');const {createStore}=require('../portal/store');
const D=require('../portal/domain');
test('Real HTTP, durable database, tenant boundaries and full case/payment workflow',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ux-test-'));const env={NODE_ENV:'test',PORTAL_LOCAL_DB:path.join(dir,'test.sqlite'),PORTAL_ADMIN_EMAIL:'info@unfallx.com',PORTAL_ORIGIN:'http://localhost'};const sent=[];let failMail=false;const mail={ready:true,send:async(to,subject,text,attachments,html)=>{sent.push({to,subject,text,html});if(failMail)throw new Error('TEST_SMTP_FAILURE');}};let portal=createPortal({env,mail});await portal.ready();const server=http.createServer((req,res)=>portal.handle(req,res,{}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let checks=0;
 async function call(route,data,actor={},method=data===undefined?'GET':'POST',headers={}){const response=await fetch(base+'/api/portal'+route,{method,headers:{Origin:env.PORTAL_ORIGIN,'Content-Type':'application/json',...(actor.cookie?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf||''}:{}),...headers},body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)});const json=await response.json();return {status:response.status,json,cookie:response.headers.get('set-cookie')};}
 const valid={company:'Testwerkstatt GmbH',contact:'Test Partner',type:'Werkstatt',street:'Teststraße 1',postcode:'12345',city:'Teststadt',phone:'030123456',privacy:true,terms:true,password:'Mein sicherer Test Merksatz 2026!'};
 async function signIn(address,registration){await call(registration?'/register':'/login',{email:address,...registration});const msg=sent.findLast(m=>m.to===address);assert.ok(msg);const token=msg.text.match(/#token=([a-f0-9]+)/)[1];const response=await call('/exchange',{token,password:'Mein sicherer Test Merksatz 2026!'});assert.equal(response.status,200);const actor={cookie:response.cookie.split(';')[0]};const me=await call('/me',undefined,actor);actor.csrf=me.json.csrf;actor.user=me.json.user;actor.company=me.json.company;return {actor,token};}
 try{
 await t.test('Unauthenticated access, CSRF, bootstrap admin, single-use tokens',async()=>{assert.equal((await call('/cases')).status,401);assert.equal((await call('/login',{email:'info@unfallx.com'},{},'POST',{Origin:'https://evil.example'})).status,403);checks+=2;});
 const {actor:admin,token}=await signIn('info@unfallx.com');assert.equal(admin.user.role,'admin');assert.equal((await call('/exchange',{token,password:'Mein sicherer Test Merksatz 2026!'})).status,401);assert.match(admin.cookie,/ux_session/);checks+=3;
 const {actor:p1}=await signIn('one@example.com',valid);const {actor:p2}=await signIn('two@example.com',{...valid,company:'Andere Firma'});assert.equal(p1.company.status,'pending');
 await t.test('Settings persist, reject privilege changes and revoke only other sessions',async()=>{
 const pref={name:'Test Neuer Name',phone:'030123',jobTitle:'Aufnahme',startPage:'faelle',theme:'dark',compact:true,reducedMotion:true,role:'admin',email:'attack@example.com',companyId:p2.company.id};
 assert.equal((await call('/settings')).status,401);
 assert.equal((await call('/settings',pref,{cookie:p1.cookie})).status,403);
 assert.equal((await call('/settings',{...pref,compact:'true'},p1)).status,400);
 const r=await call('/settings',pref,p1);assert.equal(r.status,200);assert.equal(r.json.user.role,'partner');assert.equal(r.json.user.email,'one@example.com');assert.equal(r.json.user.companyId,p1.company.id);
 const settings=(await call('/settings',undefined,p1)).json;assert.equal(settings.preferences.theme,'light');assert.equal(settings.profile.name,pref.name);assert.equal(settings.storage,null);
 assert.equal((await call('/settings',undefined,p2)).json.preferences.theme,'light');
 const {actor:secondAdmin}=await signIn('info@unfallx.com');assert.equal((await call('/settings',undefined,admin)).json.activeSessions,2);
 assert.equal((await call('/sessions/revoke-others',{confirmed:false},admin)).status,400);
 assert.equal((await call('/sessions/revoke-others',{confirmed:true},admin)).json.revoked,1);
 assert.equal((await call('/me',undefined,secondAdmin)).status,401);assert.equal((await call('/me',undefined,admin)).status,200);assert.equal((await call('/me',undefined,p1)).status,200);
 assert.ok((await call('/settings',undefined,admin)).json.storage.limit>0);
 const reg=sent.find(m=>m.to==='one@example.com');assert.match(reg.subject,/Willkommen/);assert.match(reg.html,/E-Mail bestätigen/);assert.match(reg.html,/15 Minuten/);assert.match(reg.html,/Freigabe erhalten/);
});
 const intake={...require('./fixtures/intake')(),vehicle:'BMW Test',plate:'TEST',accidentDate:'2026-09-08',location:'Leipzig',owner:'Testkunde',ownerContact:'customer@example.com',description:'Testschaden',authority:true,shareWithLawyer:false};
 assert.equal((await call('/cases',intake,p1)).status,403);assert.equal((await call('/admin/overview',undefined,p1)).status,403);assert.equal((await call('/admin/company',{id:p1.company.id,status:'approved'},p1)).status,403);checks+=3;
 for(const p of [p1,p2])assert.equal((await call('/admin/company',{id:p.company.id,status:'approved'},admin)).status,200);
 await t.test('administration cannot create direct cases or create on behalf of a partner',async()=>{
  const before=(await call('/cases',undefined,admin)).json.cases;
  for(const data of [intake,{...intake,companyId:p1.company.id}]){
   const result=await call('/cases',data,admin);
   assert.equal(result.status,403);assert.match(result.json.error,/ausschließlich freigeschaltete Partner/);
  }
  assert.deepEqual((await call('/cases',undefined,admin)).json.cases,before);
 });
 const created=await call('/cases',intake,p1);assert.equal(created.status,200,JSON.stringify(created.json));const cid=created.json.case.id;let c=created.json.case;
 assert.equal((await call('/cases/'+cid,undefined,p2)).status,404);assert.equal((await call('/cases',undefined,p2)).json.cases.length,0);assert.equal((await call('/cases/'+cid,{action:'finance',version:c.version},p1)).status,403);assert.equal((await call('/cases/'+cid,{action:'comment',note:'x',version:c.version},{cookie:p1.cookie})).status,403);checks+=4;
 assert.equal((await call('/cases/'+cid,{action:'submit',version:c.version},p1)).status,400);checks++;
 async function upload(actor,kind,bytes,type,name){return call('/cases/'+cid+'/files',bytes,actor,'POST',{'Content-Type':type,'X-File-Kind':kind,'X-File-Name':name});}
 assert.equal((await upload(p1,'photo',Buffer.from('<html>bad</html>'),'image/jpeg','fake.jpg')).status,400);checks++;
 const pic=await sharp({create:{width:8,height:8,channels:3,background:'#ff0000'}}).jpeg().toBuffer();const photo=await upload(p1,'photo',pic,'image/jpeg','test.jpg');assert.equal(photo.status,200,JSON.stringify(photo.json));
 const denied=await fetch(base+'/api/portal/files/'+photo.json.file.id,{headers:{Cookie:p2.cookie}});assert.equal(denied.status,404);checks++;
 const downloaded=await fetch(base+'/api/portal/files/'+photo.json.file.id,{headers:{Cookie:p1.cookie}});assert.match(downloaded.headers.get('cache-control'),/no-store/);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pic);checks+=2;
 async function reload(){c=(await call('/cases/'+cid,undefined,admin)).json.case;return c;}
 async function action(actor,data,expected=200){await reload();const r=await call('/cases/'+cid,{...data,version:c.version},actor);assert.equal(r.status,expected,JSON.stringify(r.json));checks++;return r;}
 assert.equal((await upload(p1,'case_bundle',Buffer.from('%PDF-1.4\n%%EOF'),'application/pdf','fixture-auftrag-und-schein.pdf')).status,200);await action(p1,{action:'submit'});await action(admin,{action:'status',status:'report_ready'},400);await action(admin,{action:'status',status:'accepted'});await action(admin,{action:'status',status:'in_progress'});
 let expert;
 await t.test('Admin invitation delivers HTML, resend revokes old links and mail failure is recoverable',async()=>{
 const invite={name:'Test Gutachter',email:'expert@example.com'};
 assert.equal((await call('/admin/invite',invite,p1)).status,403);
 assert.equal((await call('/admin/resend-invitation',{id:p2.user.id},admin)).status,404);
 assert.equal((await call('/admin/invite',invite,admin)).json.invitationSent,true);
 const first=sent.findLast(m=>m.to===invite.email);assert.match(first.subject,/Einladung/);assert.match(first.html,/24 Stunden/);assert.match(first.html,/Einladung annehmen/);
 const oldToken=first.text.match(/#token=([a-f0-9]+)/)[1];
 assert.equal((await call('/admin/resend-invitation',{id:D.hash(invite.email)},admin)).json.invitationSent,true);
 assert.equal((await call('/exchange',{token:oldToken})).status,401);
 const newToken=sent.findLast(m=>m.to===invite.email).text.match(/#token=([a-f0-9]+)/)[1];
 const r=await call('/exchange',{token:newToken});assert.equal(r.status,200);expert={cookie:r.cookie.split(';')[0]};const me=(await call('/me',undefined,expert)).json;expert.csrf=me.csrf;expert.user=me.user;assert.ok(me.user.verifiedAt);assert.equal(me.user.role,'appraiser');
 assert.equal((await call('/exchange',{token:newToken})).status,401);
 failMail=true;const failure=await call('/admin/invite',{name:'Failed Delivery',email:'failed@example.com'},admin);failMail=false;
 assert.equal(failure.status,200);assert.equal(failure.json.invitationSent,false);
 const failedToken=sent.findLast(m=>m.to==='failed@example.com').text.match(/#token=([a-f0-9]+)/)[1];assert.equal((await call('/exchange',{token:failedToken})).status,401);
 const team=(await call('/admin/overview',undefined,admin)).json.team;assert.equal(team.find(u=>u.email==='failed@example.com').invitationStatus,'failed');
 assert.equal((await call('/admin/resend-invitation',{id:D.hash('failed@example.com')},admin)).json.invitationSent,true);
 await call('/admin/team',{id:D.hash('failed@example.com'),active:false},admin);
 const blockedToken=sent.findLast(m=>m.to==='failed@example.com').text.match(/#token=([a-f0-9]+)/)[1];assert.equal((await call('/exchange',{token:blockedToken})).status,403);
 });assert.equal((await call('/cases',intake,expert)).status,403);assert.equal((await call('/cases/'+cid,undefined,expert)).status,404);await action(admin,{action:'assign',assignee:expert.user.id});assert.equal((await call('/cases/'+cid,undefined,expert)).status,200);await action(expert,{action:'payment',amount:'1'},403);checks+=3;
 const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');const report=await upload(expert,'report',pdf,'application/pdf','gutachten.pdf');assert.equal(report.status,200);assert.equal((await fetch(base+'/api/portal/files/'+report.json.file.id,{headers:{Cookie:p1.cookie}})).status,403);checks++;
 await action(expert,{action:'internal_note',note:'Interne fachliche Notiz'});assert.equal((await call('/cases/'+cid,undefined,expert)).json.case.internalNote,'Interne fachliche Notiz');assert.equal((await call('/cases/'+cid,undefined,p1)).json.case.internalNote,undefined);checks+=2;await action(expert,{action:'status',status:'report_ready'});await action(expert,{action:'status',status:'report_sent',confirmed:true,reference:'Testversand, autorisierter Empfänger'});
 await action(admin,{action:'finance',invoiceNumber:'UX-TEST-1',invoiceNet:'1000',invoiceGross:'1190',partnerNet:'400',agreement:'Individuelle Testvereinbarung'});await action(p1,{action:'accept_terms'});await action(admin,{action:'payment',amount:'600',date:'2026-09-09',reference:'Teilzahlung 1'});
 assert.equal((await upload(p1,'partner_invoice',pdf,'application/pdf','rechnung.pdf')).status,400);checks++;
 await action(admin,{action:'payout',confirmed:true,date:'2026-09-09',reference:'verfrüht'},400);await action(admin,{action:'payment',amount:'591',date:'2026-09-09',reference:'zu viel'},400);await action(admin,{action:'payment',amount:'590',date:'2026-09-09',reference:'Restzahlung'});
 const partnerInvoice=await upload(p1,'partner_invoice',pdf,'application/pdf','rechnung.pdf');assert.equal(partnerInvoice.status,200);assert.equal((await fetch(base+'/api/portal/files/'+partnerInvoice.json.file.id,{headers:{Cookie:expert.cookie}})).status,404);checks++;await action(admin,{action:'finance',invoiceNumber:'X'},400);await action(admin,{action:'approve_invoice',confirmed:true});
 await t.test('payout planning is admin-only, versioned and never marks a bank transfer',async()=>{
  await action(p1,{action:'payout_plan',date:'2099-01-02',confirmed:true},403);
  await action(expert,{action:'payout_plan',date:'2099-01-02',confirmed:true},403);
  await action(admin,{action:'payout_plan',date:'2020-01-01',confirmed:true},400);
  await action(admin,{action:'payout_plan',date:'2099-01-02',confirmed:false},400);
  await action(admin,{action:'payout_plan',date:'2099-01-02',confirmed:true});
  const own=(await call('/mobile/payout/'+cid,undefined,p1)).json;assert.equal(own.scheduledAt,'2099-01-02');assert.equal(own.paidOutAt,null);
  assert.equal((await upload(admin,'payout_receipt',pdf,'application/pdf','beleg.pdf')).status,400);
  await action(admin,{action:'payout_plan',date:'',confirmed:true});assert.equal((await call('/mobile/payout/'+cid,undefined,p1)).json.scheduledAt,null);
 });
 await action(admin,{action:'payout',confirmed:true,date:'2026-09-09',reference:'Bank-Test'});await action(admin,{action:'payout',confirmed:true,date:'2026-09-09',reference:'doppelt'},400);await action(admin,{action:'status',status:'closed'});
 await t.test('paid receipt is PDF-only, admin-uploaded and visible only in the owning partner case',async()=>{
  assert.equal((await upload(p1,'payout_receipt',pdf,'application/pdf','beleg.pdf')).status,403);
  assert.equal((await upload(expert,'payout_receipt',pdf,'application/pdf','beleg.pdf')).status,403);
  assert.equal((await upload(admin,'payout_receipt',pic,'image/jpeg','beleg.jpg')).status,400);
  const result=await upload(admin,'payout_receipt',pdf,'application/pdf','beleg.pdf');assert.equal(result.status,200,JSON.stringify(result.json));
  const id=result.json.file.id;assert.equal((await call('/mobile/payout/'+cid,undefined,p1)).json.receiptFileID,id);
  for(const actor of [p2,expert])assert.equal((await fetch(base+'/api/portal/files/'+id,{headers:{Cookie:actor.cookie}})).status,404);
  const r=await fetch(base+'/api/portal/files/'+id,{headers:{Cookie:p1.cookie}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),pdf);
 });

 const visible=(await call('/cases/'+cid,undefined,p1)).json;assert.equal(visible.case.finance.paymentStatus,'paid_out');assert.equal(visible.case.finance.invoiceGross,undefined);assert.equal(visible.case.internalNote,undefined);assert.equal(visible.events.some(e=>e.internal),false);checks+=4;
 await portal.close();portal=createPortal({env,mail});await portal.ready();assert.equal((await call('/cases/'+cid,undefined,p1)).json.case.status,'closed');const preserved=await fetch(base+'/api/portal/files/'+photo.json.file.id,{headers:{Cookie:p1.cookie}});assert.deepEqual(Buffer.from(await preserved.arrayBuffer()),pic);checks+=2;
 await call('/admin/company',{id:p1.company.id,status:'suspended'},admin);assert.equal((await call('/cases/'+cid,undefined,p1)).status,403);await call('/logout',{},admin);assert.equal((await call('/me',undefined,admin)).status,401);checks+=2;
 console.log('Verified security/workflow assertions:',checks);
 }finally{await new Promise(r=>server.close(r));await portal.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Financial calculations are integer cents and invalid inputs fail closed',()=>{assert.equal(D.money('1000,49'),100049);for(const bad of ['-1','1.999','Infinity',NaN,1.23])assert.throws(()=>D.money(bad));assert.equal(D.payable({status:'report_sent',finance:{partnerNet:40000,agreement:'A',agreedAt:'date',invoiceGross:119000,received:119000}}),false);});

test('Email HTML safely escapes company and recipient text and retains a complete text alternative',()=>{
 const {accessEmail}=require('../portal/email-templates');
 for(const kind of ['login','registration','invitation']){const m=accessEmail({kind,name:'<script>alert(1)</script>',company:'Test <img src=x>',url:'https://unfallx.com/login#token=not-a-live-token'});assert.doesNotMatch(m.html,/<script>|<img src=x>/);assert.match(m.html,/&lt;script&gt;/);assert.match(m.html,/role="presentation"/);assert.match(m.text,/https:\/\/unfallx.com\/app-hilfe/);assert.match(m.text,/not-a-live-token/);assert.match(m.html,/Datenschutz/);}
});
