'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {createStore}=require('../portal/store'),{createMobileIntake}=require('../portal/mobile-intake'),{fieldsDigest}=require('../portal/customer-handoff'),orders=require('../portal/customer-orders');
const {PDFDocument}=require('pdf-lib');
const id=()=>crypto.randomUUID(),valid={'claimant.first':'Testkunde','claimant.last':'Prüfung','claimant.street':'Testweg 1','claimant.zip':'10115','claimant.city':'Berlin',plate:'TEST UX 28','accident.date':'2026-09-20','accident.place':'Testort'},key=()=>crypto.randomBytes(32).toString('hex');
async function fixture(beforeWrite){const s=await createStore({NODE_ENV:'test',PORTAL_LOCAL_DB:':memory:'}),tx=fn=>s.transaction(fn),cid=id(),secret=key();let revoked=false;
 const api=createMobileIntake({tx,blobs:{write:async(bytes,fn)=>{if(beforeWrite)await beforeWrite({tx,cid});return s.writeBlob(bytes,fn);},read:s.readBlob.bind(s)},body:async r=>r.payload,rate:async()=>{},ip:()=> 'test',env:{},authorize:async()=>{assert(!revoked);return {user:{id:'partner',name:'Test',role:'partner',companyId:'co'},company:{id:'co',name:'Test',status:'approved'}}}});
 await tx(async q=>{await q.put('user',{id:'partner',active:true,role:'partner',companyId:'co'});await q.put('company',{id:'co',status:'approved'});});
 const native=(op,payload={})=>api.route('/mobile/cases/'+cid+'/handoff/'+op,{method:'POST',headers:{authorization:'Bearer '+secret},payload});
 await api.route('/mobile/cases',{method:'POST',headers:{authorization:'Bearer '+secret},payload:{id:cid,fields:valid,fieldsHash:fieldsDigest(valid),reference:'TEST-KEIN-ECHTER-AUFTRAG'}});
 await tx(async q=>{for(const p of ['registration','frontLeft','frontRight','rearRight','rearLeft','damageOverview','damageDetail','plate','vin','odometer'])await q.put('file',{id:id(),caseId:cid,kind:p==='registration'?'registration':'photo',perspective:p,size:0},cid);});
 const created=await native('create',{fieldsHash:fieldsDigest(valid)}),token=created.url.split('#')[1];
 const publicCall=(action,more={})=>api.customerHandoff.publicRoute({method:'POST',payload:{token,action,...more}},{setHeader(){},end(){}});
 return {s,tx,cid,secret,api,native,created,token,publicCall};}
const ink={aspectRatio:2.22,strokes:[Array.from({length:20},(_,i)=>({x:.1+i*.035,y:.4+Math.sin(i)*.1}))]};
test('customer link is scoped, revocable, expires and never exposes finance or its token in storage',async()=>{const f=await fixture();try{
 const state=await f.publicCall('read');assert.equal(state.fields.plate,valid.plate);assert.equal(state.orders.length,2);assert.equal(state.finance,undefined);assert.equal(state.caseID,undefined);
 assert(!JSON.stringify(await f.tx(q=>q.get('case',f.cid))).includes(f.token));
 await assert.rejects(f.api.customerHandoff.publicRoute({method:'POST',payload:{token:key(),action:'read'}},{}),e=>e.status===410);
 await assert.rejects(f.publicCall('save',{revision:state.revision,fields:{partnerNet:'900000'}}),e=>e.status===400);
 await f.native('revoke',{revision:state.revision});await assert.rejects(f.publicCall('read'),e=>e.status===410);
 const c=await f.native('create',{fieldsHash:fieldsDigest(valid)});await f.tx(async q=>{const row=await q.get('customer_handoff',require('../portal/domain').hash(c.url.split('#')[1]));row.expires=Date.now()-1;await q.put('customer_handoff',row,f.cid);});
 await assert.rejects(f.api.customerHandoff.publicRoute({method:'POST',payload:{token:c.url.split('#')[1],action:'read'}},{}),e=>e.status===410);
 }finally{await f.s.close();}});
test('handoff blocks older app overwrites; data changes invalidate signatures and stale requests',async()=>{const f=await fixture();try{
 await assert.rejects(f.api.route('/mobile/cases',{method:'POST',headers:{authorization:'Bearer '+f.secret},payload:{id:f.cid,fields:valid,fieldsHash:fieldsDigest(valid)}}),e=>e.status===409);
 const state=await f.publicCall('read'),next=await f.publicCall('save',{revision:state.revision,fields:{'claimant.first':'Testkundin'}});assert.notEqual(next.revision,state.revision);
 await assert.rejects(f.publicCall('save',{revision:state.revision,fields:{'claimant.first':'Überholt'}}),e=>e.status===409);
 await assert.rejects(f.publicCall('sign',{revision:state.revision,kind:'unfallx',templateHash:orders.templateHash('unfallx'),read:true,agreed:true,requestID:id(),signature:ink,place:'Berlin'}),e=>e.status===409);
 await f.native('revoke',{revision:next.revision});const imported=await f.native('ack',{revision:next.revision,fieldsHash:fieldsDigest({...valid,'claimant.first':'Testkundin'})});assert.equal(imported.handoff.state,'imported');assert.equal(imported.fields['claimant.first'],'Testkundin');
 }finally{await f.s.close();}});
test('both original orders are signed separately, stored atomically and retries produce no duplicate',async()=>{const f=await fixture();try{
 const state=await f.publicCall('read');let latest;
 for(const kind of ['unfallx','nextright']){
  const payload={revision:state.revision,kind,templateHash:orders.templateHash(kind),read:true,agreed:true,requestID:id(),signature:ink,place:'Berlin'};
  await assert.rejects(f.publicCall('sign',{...payload,read:false}),e=>e.status===400);
  latest=await f.publicCall('sign',payload);const repeated=await f.publicCall('sign',payload);assert.deepEqual(repeated.orders,latest.orders);
  await assert.rejects(f.publicCall('sign',{...payload,place:'Anderer Ort'}),e=>e.status===409);
 }
 assert.equal(latest.state,'completed');assert(latest.orders.every(o=>o.signed));
 const native=await f.native('status'),files=(await f.tx(q=>q.list('file',f.cid))).filter(f=>f.kind==='authorization');assert.equal(files.length,2);assert.equal(native.orders.length,2);
 fs.mkdirSync('/private/tmp/unfallx-pdf-2.8',{recursive:true});
 for(const file of files){const bytes=await f.s.readBlob(file.id,async()=>{});const pdf=await PDFDocument.load(bytes);assert(pdf.getPageCount()>=2);fs.writeFileSync('/private/tmp/unfallx-pdf-2.8/'+file.orderKind+'.pdf',bytes);assert.equal(file.fieldsHash,fieldsDigest(valid));}
 await assert.rejects(f.publicCall('save',{revision:state.revision,fields:{'claimant.first':'Nachträglich'}}),e=>e.status===409);
 await f.native('ack',{revision:state.revision,fieldsHash:fieldsDigest(valid)});await assert.rejects(f.publicCall('read'),e=>e.status===410);
 }finally{await f.s.close();}});
test('suspended partner and deactivated owner invalidate previously issued customer access',async()=>{const f=await fixture();try{
 await f.tx(q=>q.put('company',{id:'co',status:'suspended'}));await assert.rejects(f.publicCall('read'),e=>e.status===410);
 await f.tx(async q=>{await q.put('company',{id:'co',status:'approved'});await q.put('user',{id:'partner',active:false,role:'partner',companyId:'co'});});await assert.rejects(f.publicCall('read'),e=>e.status===410);
 }finally{await f.s.close();}});
test('signature rejects invalid points, oversized input and empty or tap-only drawings',()=>{
 for(const data of [{strokes:[],aspectRatio:2},{strokes:[[{x:10,y:0}]],aspectRatio:2},{strokes:[Array.from({length:10},()=>({x:.5,y:.5}))],aspectRatio:2}])assert.throws(()=>orders.signature(data));
 assert.equal(orders.signature(ink).strokes[0].length,20);
});

test('Revocation during PDF rendering cannot commit a signature or consume document storage',async()=>{
 const f=await fixture(async({tx,cid})=>tx(async q=>{const c=await q.get('case',cid);c.mobile.customerHandoff.state='revoked';await q.put('case',c,c.companyId);}));
 try{
  const state=await f.publicCall('read');
  await assert.rejects(f.publicCall('sign',{revision:state.revision,kind:'unfallx',templateHash:orders.templateHash('unfallx'),read:true,agreed:true,requestID:id(),signature:ink,place:'Berlin'}),e=>e.status===410);
  const files=await f.tx(q=>q.list('file',f.cid));assert.equal(files.filter(f=>f.kind==='authorization').length,0);assert.equal((await f.tx(q=>q.get('system','storage')))?.bytes||0,0);
 }finally{await f.s.close();}
});
