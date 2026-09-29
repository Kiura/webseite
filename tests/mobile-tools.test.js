'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {normalize,payoutCheck,diagnosticReport,createMobileTools,pruneDiagnostics}=require('../portal/mobile-tools');
const {createStore}=require('../portal/store');
const {commission}=require('../portal/mobile-intake');
const id=()=>crypto.randomUUID(),actor={user:{id:'partner',role:'partner'},company:{id:'co'}};
const invoice={partnerNet:5000,invoiceNet:10000,invoiceGross:11900,agreement:'50 % netto',agreedAt:'2026-09-28',partnerAcceptedAt:'2026-09-28',received:11900};
async function setup(){const s=await createStore({NODE_ENV:'test',PORTAL_LOCAL_DB:':memory:'});return {s:{close:()=>s.close(),put:(...args)=>s.transaction(q=>q.put(...args)),list:(...args)=>s.transaction(q=>q.list(...args)),transaction:fn=>s.transaction(fn)},api:createMobileTools({tx:fn=>s.transaction(fn),body:async req=>req.payload,rate:async()=>{}})};}
test('payout gates match overview eligibility and never confuse payment with release',()=>{
 const c={id:id(),version:2,status:'report_sent',finance:{...invoice}};
 assert.equal(payoutCheck(c).canUpload,true);assert.equal(commission(c).payable,false);
 for(const field of ['partnerAcceptedAt','agreedAt','agreement','received']){const x={...c,finance:{...invoice,[field]:null}};assert.equal(payoutCheck(x).canUpload,false);}
 for(const status of ['draft','submitted','needs_info','declined'])assert.equal(payoutCheck({...c,status}).canUpload,false);
 for(const finance of [undefined,{...invoice,partnerInvoiceId:'f'},{...invoice,partnerInvoiceId:'f',partnerInvoiceApproved:true},{...invoice,partnerInvoiceId:'f',partnerInvoiceApproved:true,paidOutAt:'2026-09-29'}]){
  const x={...c,finance},check=payoutCheck(x);assert.equal(check.canUpload,false);
  assert.equal(check.steps.find(s=>s.id==='approval').done,commission(x).payable||commission(x).stage==='paid');
 }
 assert.equal(payoutCheck({...c,finance:{...invoice,partnerAcceptedAt:null}}).canConfirm,true);
 assert.equal(payoutCheck({...c,finance:{...invoice,partnerNet:0}}).canConfirm,false);
});
test('duplicates normalize separators but preserve distinct umlaut registration districts',()=>{
 assert.equal(normalize(' b - ux 123 '),'BUX123');assert.notEqual(normalize('MÜ A 1'),normalize('MU A 1'));assert.equal(normalize('MU\u0308-A 1'),'MÜA1');
});
test('vehicle search only returns own company, deduplicates VIN and plate, excludes self and hides customer data',async()=>{
 const {s,api}=await setup();try{const same=id(),other=id(),self=id();
 for(const [cid,co]of [[same,'co'],[other,'foreign'],[self,'co']])await s.put('case',{id:cid,companyId:co,number:'TEST',status:'submitted',intake:{plate:'B-UX 123',vin:'WVWZZZ1JZXW000001',owner:'DO NOT EXPOSE'},finance:{secret:'NO'}},co);
 const call=payload=>api.route('/mobile/duplicates',{method:'POST',payload},actor);
 const result=await call({plate:'b ux123',vin:'WVWZZZ1JZXW000001',excludeID:self});assert.deepEqual(result.matches.map(m=>m.id),[same]);assert.equal(result.matches[0].reason,'vin');assert(!JSON.stringify(result).includes('EXPOSE'));assert(!JSON.stringify(result).includes('secret'));
 assert.equal((await call({plate:'',vin:'WVWZZZ1JZXW000001',excludeID:self})).matches.length,1);
 assert.equal((await call({plate:'',vin:'123',excludeID:''})).matches.length,0);
 await assert.rejects(api.route('/mobile/payout/'+other,{method:'GET'},actor),e=>e.status===404);
 assert.equal((await api.route('/mobile/payout/'+same,{method:'GET'},actor)).caseID,same);
 }finally{await s.close();}
});
test('diagnostic schema rejects content, paths, unknown fields and impossible counts/dates',()=>{
 const base={id:id(),day:'2026-09-28',version:'2.7',build:'16',counts:{crash:1}},now=new Date('2026-09-28T15:00:00Z');
 assert.deepEqual(diagnosticReport(base,now),base);
 for(const changed of [{...base,photo:'secret'},{...base,counts:{name:1}},{...base,counts:{crash:'secret'}},{...base,counts:{hang:-1}},{...base,counts:{crash:1001}},{...base,version:'/private/name'},{...base,day:'2026-02-30'},{...base,day:'2026-09-29'},{...base,day:'2026-08-01'}])assert.throws(()=>diagnosticReport(changed,now));
});
test('diagnostics retries idempotently aggregate without account/device identifiers and age out',async()=>{
 const {s,api}=await setup();try{
 const data={id:id(),day:new Date().toISOString().slice(0,10),version:'2.7',build:'16',counts:{upload_network:2}};
 const send=payload=>api.route('/mobile/diagnostics',{method:'POST',payload},actor);
 await send(data);await send(data);let rows=await s.list('mobile_diagnostic');assert.equal(rows.length,1);assert.equal(rows[0].counts.upload_network,2);assert.equal(rows[0].reports,1);assert(!JSON.stringify(rows).includes('partner'));assert(!('userId'in rows[0]));
 await assert.rejects(send({...data,counts:{upload_network:3}}),e=>e.status===409);
 await send({...data,id:id(),counts:{hang:1}});assert.equal((await s.list('mobile_diagnostic'))[0].counts.hang,1);
 await s.transaction(q=>pruneDiagnostics(q,new Date(Date.now()+32*86400000)));assert.equal((await s.list('mobile_diagnostic')).length,0);assert.equal((await s.list('mobile_diagnostic_receipt')).length,0);
 }finally{await s.close();}
});
