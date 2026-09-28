'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
let port,child,closed,temporary;
before(async()=>{
 temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ux-http-security-'));
 port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 child=spawn(process.execPath,['server.js'],{cwd:root,env:{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),PORTAL_LOCAL_DB:path.join(temporary,'test.sqlite'),PORTAL_ORIGIN:'http://127.0.0.1:'+port},stdio:['ignore','pipe','pipe']});
 closed=new Promise(resolve=>child.once('exit',resolve));
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Server did not start')),8000);child.stdout.on('data',data=>{if(String(data).includes('Webseite laeuft')){clearTimeout(timeout);resolve();}});child.once('error',reject);child.stderr.resume();});
});
after(async()=>{if(child){child.kill('SIGTERM');await closed;}if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
function request(host,url,method='GET'){
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers:{Host:host}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,bytes,body:bytes.toString('utf8')});});});req.on('error',reject);req.end();});
}
function policyOf(body){const match=body.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);assert(match,'Document must preserve CSP even if the hosting proxy changes its header');return match[1].replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&amp;/g,'&');}
test('HTML preserves CSP before resources, without weakening scripts, with correct UTF-8 and HEAD lengths',async()=>{
 for(const [host,url] of [['unfallx.com','/'],['app.unfallx.com','/login'],['app.unfallx.com','/portal'],['admin.unfallx.com','/gutachter-portal'],['app.unfallx.com','/app-hilfe'],['unfallx.com','/missing-page']]){
  const r=await request(host,url),policy=policyOf(r.body);
  assert.equal(r.status,url==='/missing-page'?404:200);
  assert.match(policy,/default-src 'self'/);assert.match(policy,/script-src 'self'/);assert.match(policy,/base-uri 'self'/);assert.match(policy,/form-action 'self' mailto:/);
  assert(!/unsafe-inline|unsafe-eval|frame-ancestors/.test(policy));
  assert.equal(policy,r.headers['content-security-policy'].split(';').map(s=>s.trim()).filter(s=>s&&!s.startsWith('frame-ancestors')).join('; '));
  assert.match(r.headers['content-security-policy'],/frame-ancestors 'self'/);assert.equal(r.headers['x-frame-options'],'SAMEORIGIN');
  assert(r.body.indexOf('http-equiv="Content-Security-Policy"')<r.body.search(/<(?:script|link)\b/i));
  assert.equal(Number(r.headers['content-length']),r.bytes.length);
  const head=await request(host,url,'HEAD');assert.equal(head.status,r.status);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-length'],r.headers['content-length']);
  for(const match of r.body.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)){
   if(match[1].trim())assert(policy.includes("'sha256-"+crypto.createHash('sha256').update(match[1],'utf8').digest('base64')+"'"),'Rendered inline script must have an allowed hash');
  }
 }
});
test('Private source paths return 404 directly on every domain instead of redirecting between portals',async()=>{
 for(const host of ['unfallx.com','app.unfallx.com','admin.unfallx.com']){
  for(const url of ['/portal/app.js','/%70ortal/app.js','/server.js','/.env','/%2eenv','/node_modules/sharp/package.json','/docs/operations-and-backups.md','/scripts/restore-drill.js','/assets/../portal/store.js']){
   const r=await request(host,url);assert.equal(r.status,404,host+url);assert.equal(r.headers.location,undefined);assert(!r.body.includes('require('));
  }
  const invalid=await request(host,'/%ZZ');assert.equal(invalid.status,400);assert(!invalid.headers.location);
 }
 const workspace=await request('app.unfallx.com','/portal');assert.equal(workspace.status,200);assert.match(workspace.body,/id="portal-root"/);
 const slash=await request('app.unfallx.com','/portal/');assert.equal(slash.status,301);assert.equal(slash.headers.location,'/portal');
});
test('The HTML policy fallback leaves API authentication and asset bytes intact',async()=>{
 for(const host of ['app.unfallx.com','admin.unfallx.com']){
  const api=await request(host,'/api/portal/me');assert.equal(api.status,401);assert(!api.body.includes('<meta'));
  const asset=await request(host,'/assets/uploads.js');assert.equal(asset.status,200);assert.deepEqual(asset.bytes,fs.readFileSync(path.join(root,'assets/uploads.js')));assert.equal(Number(asset.headers['content-length']),asset.bytes.length);
 }
});
test('Customer document viewer is self-hosted, no-store and cannot expose private templates or dependencies',async()=>{
 const page=await request('app.unfallx.com','/kundenaufnahme');assert.equal(page.status,200);assert.match(page.headers['cache-control'],/no-store/);assert.equal(page.headers['referrer-policy'],'no-referrer');
 const policy=policyOf(page.body);assert.match(policy,/worker-src 'self'/);assert(!/unsafe-eval|unsafe-inline/.test(policy));assert.match(page.body,/customer-handoff.js/);assert(!page.body.includes('google-analytics'));
 for(const asset of ['/assets/customer-pdf/pdf.js','/assets/customer-pdf/pdf.worker.js','/assets/customer-logo.png'])assert.equal((await request('app.unfallx.com',asset)).status,200);
 for(const asset of ['/portal/order-templates/OrderUNFALLX.pdf','/portal/order-templates/NotoSans.ttf','/assets/customer-pdf/package.json','/assets/customer-pdf/fonts/..%2f..%2fpackage.json'])assert.equal((await request('app.unfallx.com',asset)).status,404);
 assert.equal((await request('app.unfallx.com','/api/portal/customer/handoff')).status,405);
});
