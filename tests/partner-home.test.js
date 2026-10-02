'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../assets/portal.js'),'utf8');
async function render({role='partner',status='approved',hash='',failMoney=false,rows=[]}={}){
 const nodes=new Map(),calls=[],redirects=[];
 const make=()=>({value:'',innerHTML:'',textContent:'',dataset:{},hidden:false,classList:{toggle(){}},setAttribute(){},getAttribute(){return 'false'},addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},scrollIntoView(){}});
 const find=s=>{if(!nodes.has(s))nodes.set(s,make());return nodes.get(s);};
 const data={user:{role,name:'Test Partner',preferences:{startPage:'faelle'}},company:{status,name:'Testbetrieb'},csrf:'test',states:{draft:'Entwurf'}};
 const location={hash,pathname:'/portal',replace:x=>redirects.push(x)};
 const sandbox={UnfallxSessionGuard:require('../assets/session-guard'),AbortController,AbortSignal,setInterval:()=>0,clearInterval(){},console,Intl,Date,URL,File:class{},FormData:class{},setTimeout,clearTimeout,matchMedia:()=>({matches:false}),location,history:{replaceState(_a,_b,url){redirects.push(url);if(url.includes('#'))location.hash='#'+url.split('#')[1];}},UnfallxHelp:{contextual:()=> 'orientierung'},document:{addEventListener(){},getElementById:id=>find("#"+id),body:make(),querySelector:find,querySelectorAll:()=>[]},window:{addEventListener(){},scrollTo(){}},fetch:async url=>{calls.push(url);const route=url.replace('/api/portal','');let result;
  if(route==='/me')result=data;
  else if(route==='/chat/inbox')result={messages:[]};
  else if(route==='/cases'||route.startsWith('/cases?folder=')){const folder=route.split('=')[1]||'active';result={cases:rows.filter(c=>folder==='all'||(c.filing?.folder||'active')===folder),folders:{active:rows.filter(c=>(c.filing?.folder||'active')==='active').length,archived:rows.filter(c=>c.filing?.folder==='archived').length,deleted:rows.filter(c=>c.filing?.folder==='deleted').length}};}
  else if(route==='/mobile/overview')return {ok:!failMoney,status:failMoney?503:200,json:async()=>failMoney?{error:'Verbindung unterbrochen'}:{totals:{expectedCents:3750,payableCents:1250,paidCents:8100},items:[]}};
  else throw Error('Unexpected request '+route);
  return {ok:true,status:200,json:async()=>result};
 }};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../assets/workspace-ui.js'),'utf8'),sandbox);vm.runInNewContext(source,sandbox);for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 return {html:find('#portal-root').innerHTML,nav:find('#portal-nav').innerHTML,mobile:find('#portal-mobile-nav').innerHTML,top:find('#portal-top-action').innerHTML,calls,redirects};
}
test('approved partner opens the overview even with the legacy case-list preference',async()=>{const r=await render();assert.match(r.html,/Dein Überblick/);assert.match(r.html,/Schaden aufnehmen/g);assert.match(r.html,/25,00/);assert.doesNotMatch(r.html,/37,50/);assert.match(r.html,/12,50/);assert.match(r.html,/81,00/);assert(!r.html.includes('50,00'));assert(!r.redirects.some(x=>x.includes('#faelle')));assert.match(r.nav,/#verguetung/);});
test('an explicit case-list deep link remains intact',async()=>{const r=await render({hash:'#faelle'});assert.match(r.html,/Meine Fälle/);assert.match(r.html,/case-search/);assert(!r.html.includes('partner-wallet'));assert(!r.calls.some(x=>x.includes('/mobile/overview')));});
test('pending partner cannot start intake and does not request commission data',async()=>{const r=await render({status:'pending'});assert.match(r.html,/Prüfung ausstehend/);assert(!r.html.includes('partner-capture'));assert(!r.calls.some(x=>x.includes('/mobile/overview')));assert(!r.html.includes('37,50'));});
test('commission read failure leaves unknown amounts, exposes retry and preserves intake',async()=>{const r=await render({failMoney:true});assert.match(r.html,/ws-commission-strip/);assert.match(r.html,/data-retry-partner/);assert.match(r.html,/Schaden aufnehmen/g);assert(!r.html.includes('0,00'));});
test('admin keeps the existing case-list preference and internal navigation',async()=>{const r=await render({role:'admin'});assert.match(r.html,/Fallübersicht/);assert(!r.html.includes('partner-wallet'));assert(r.redirects.some(x=>x.includes('#faelle')));assert(!r.calls.some(x=>x.includes('/mobile/overview')));assert.match(r.nav,/href="#verwaltung"/);assert.doesNotMatch(r.nav,/href="#team"/);});
test('case display escapes untrusted customer and vehicle text',async()=>{const r=await render({rows:[{id:'11111111-1111-4111-8111-111111111111',number:'<img onerror=alert(1)>',status:'draft',updatedAt:'2026-09-11T08:00:00Z',intake:{vehicle:'<script>unsafe</script>',owner:'A & B',plate:'B UX 1'}}]});assert(!r.html.includes('<script>unsafe'));assert.match(r.html,/&lt;script&gt;unsafe/);assert.match(r.html,/&lt;img onerror=alert\(1\)&gt;/);});

test('capture is directly reachable from overview, primary navigation, mobile bar and header',async()=>{const r=await render();for(const html of [r.html,r.nav,r.mobile,r.top])assert.match(html,/href="#neu"/);assert(r.html.indexOf('partner-capture')<r.html.indexOf('ws-commission-strip'));assert(r.nav.indexOf('href="#neu"')<r.nav.indexOf('Firmenprofil & Konto'));assert.match(r.mobile,/aria-label="Schaden übermitteln"/);assert.match(r.top,/Schaden übermitteln/);});
test('unapproved partners see approval guidance instead of active capture links',async()=>{for(const status of ['pending','rejected','suspended']){const r=await render({status});for(const html of [r.html,r.nav,r.mobile,r.top])assert.doesNotMatch(html,/href="#neu"/);assert.match(r.top,/Hilfe zum Einstieg/);}});
test('unapproved partner cannot open intake via a copied deep link',async()=>{const r=await render({status:'pending',hash:'#neu'});assert.match(r.html,/Prüfung ausstehend/);assert.doesNotMatch(r.html,/id="case-new"/);});

test('internal roles have no creation action and old intake links open the case list',async()=>{
 for(const role of ['admin','appraiser'])for(const hash of ['','#faelle','#neu']){
  const r=await render({role,hash});
  assert.match(r.html,/Fallübersicht/);
  for(const html of [r.html,r.nav,r.mobile,r.top])assert.doesNotMatch(html,/href="#neu"|id="case-new"|Neuer Fall/);
  if(hash==='#neu')assert(r.redirects.some(url=>url.endsWith('#faelle')));
 }
});

test('partner and admin can reach independent archive and trash with correct empty states',async()=>{for(const role of ['partner','admin'])for(const [hash,folder,title]of [['#faelle/archiv','archived','Dein Archiv ist leer'],['#faelle/papierkorb','deleted','Dein Papierkorb ist leer']]){const r=await render({role,hash});assert(r.calls.includes('/api/portal/cases?folder='+folder));assert.match(r.html,/aria-label="Fallablage"/);assert.match(r.html,/href="#faelle\/archiv"/);assert.match(r.html,/href="#faelle\/papierkorb"/);assert.match(r.html,/href="#hilfe\/fallablage"/);}});

test('internal administration remains reachable through the focused management hub',async()=>{const r=await render({role:'admin',hash:'#verwaltung'});assert.match(r.html,/href="#team"/);assert.match(r.html,/href="#kanzleien"/);assert.match(r.html,/href="#system"/);assert.match(r.html,/href="#versand"/);});
test('mobile More keeps partner billing, profile and help accessible without internal links',async()=>{const r=await render({hash:'#mehr'});for(const path of ['verguetung','einstellungen','hilfe'])assert.match(r.html,new RegExp('href="#'+path+'"'));assert.doesNotMatch(r.html,/href="#team"|href="#system"/);});

test('navigation obtains unread counts from the authorized inbox and skips pending accounts',async()=>{const approved=await render();assert(approved.calls.includes('/api/portal/chat/inbox'));const pending=await render({status:'pending'});assert(!pending.calls.includes('/api/portal/chat/inbox'));});
