'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function fixture({dirty=false,pending=false,role='admin'}={}){
 const calls=[],refreshed=[],nodes=new Map(),caseData={id:'test-case',version:7,intake:{vehicle:'Testwagen'}};
 const node=()=>({innerHTML:'',textContent:'',value:'',addEventListener(){},classList:{toggle(){}},scrollIntoView(){},querySelector(){return null;},querySelectorAll(){return[];}});
 const chatBadge={dataset:{navCount:'chat'},hidden:true,textContent:'',setAttribute(){}};
 const find=selector=>{
  if(selector==='form[data-dirty="true"] [data-intake-fields]')return dirty?{}:null;
  if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);
 };
 const ws={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workspace-ui'),'utf8'),ws);
 const sandbox={UnfallxSessionGuard:require('../assets/session-guard'),AbortController,AbortSignal,setInterval:()=>0,clearInterval(){},Intl,Date,URL,File:class{},FormData:class{constructor(form){this.entries=Object.entries(form.data||{});}[Symbol.iterator](){return this.entries[Symbol.iterator]();}},
  document:{querySelector:find,querySelectorAll:selector=>selector==='[data-nav-count]'?[chatBadge]:[]},window:{addEventListener(){},UnfallxWorkspace:ws.window.UnfallxWorkspace},location:{hash:'#nachrichten'},
  UnfallxHelp:{contextual:()=> 'nachrichten'},UnfallxIntake:{errors:()=>[],fileErrors:()=>[]},
  fetch:async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>url.endsWith('/chat/inbox')?{messages:[{caseId:'case-123',caseNumber:'UX-TEST',vehicle:'Testwagen',note:'Nachfrage <test>',unread:2,actor:'Partner',at:'2026-09-12T12:00:00Z'}]}:url.endsWith('/cases')?{cases:[{id:'case-123',number:'UX-TEST',intake:{vehicle:'Testwagen'}}]}:{case:caseData}};},
  seed:{user:{role,preferences:{}}},fixturePending:pending,onRefresh:cid=>refreshed.push(cid),caseData
 };
 // Run the real case-action handlers, omitting only page boot and its global listeners.
 const source=fs.readFileSync(require.resolve('../assets/portal'),'utf8'),end=source.indexOf("$('#portal-search').addEventListener('submit'");assert(end>0);
 vm.runInNewContext(source.slice(0,end)+`me=seed;csrf='test-csrf';current={case:caseData,files:[]};activeUpload={batch:{pending:()=>fixturePending},destroy(){}};detail=async cid=>onRefresh(cid);globalThis.actions={applyCaseAction,dispatchCase,messageCentre};})();`,sandbox);
 const form=(action,data={})=>({dataset:{caseAction:action},data,querySelector:()=>null,querySelectorAll:()=>[]});
 return {calls,refreshed,nodes,chatBadge,run:(action,data)=>sandbox.actions.applyCaseAction(form(action,data),caseData.id,caseData,{dataset:{dirty:String(dirty)}}),dispatch:()=>sandbox.actions.dispatchCase(caseData.id,{fileId:'report',confirmed:true}),messages:()=>sandbox.actions.messageCentre()};
}

test('unsaved case data blocks unrelated mutations and report dispatch before requests or re-rendering',async()=>{
 for(const role of ['partner','admin','appraiser']){
  const f=fixture({dirty:true,role});
  for(const action of ['status','comment','finance','request_create','request_reply','task','assign','lawyer','file_kind','submit'])await assert.rejects(f.run(action),/Falldaten zuerst/);
  await assert.rejects(f.dispatch(),/Falldaten zuerst/);
  assert.equal(f.calls.length,0);assert.equal(f.refreshed.length,0);
 }
});
test('saving edited data remains possible and sends the current version',async()=>{
 const f=fixture({dirty:true,pending:true});await f.run('save',{vehicle:'Geänderter Testwagen'});
 assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(f.calls[0].body),{action:'save',vehicle:'Geänderter Testwagen',version:7});assert.deepEqual(f.refreshed,['test-case']);
});
test('pending uploads block status changes and dispatch; clean case actions continue normally',async()=>{
 const pending=fixture({pending:true});await assert.rejects(pending.run('status',{status:'closed'}),/vollständig hochladen/);await assert.rejects(pending.dispatch(),/vollständig hochladen/);assert.equal(pending.calls.length,0);
 const clean=fixture();await clean.run('status',{status:'in_progress'});await clean.run('comment',{note:'Geprüft'});await clean.dispatch();
 assert.equal(clean.calls.length,3);assert.equal(clean.calls[2].url,'/api/portal/cases/test-case/dispatch');assert.equal(JSON.parse(clean.calls[2].body).version,7);assert.deepEqual(clean.refreshed,['test-case','test-case','test-case']);
});
test('chat centre links to a dedicated case conversation and escapes message text',async()=>{
 const f=fixture();await f.messages();const html=f.nodes.get('#chat-conversations').innerHTML;
 assert.match(html,/href="#chat\/case-123"/);assert.match(html,/Nachfrage &lt;test&gt;/);assert.doesNotMatch(html,/<test>/);assert.equal(f.chatBadge.textContent,'2');assert.equal(f.chatBadge.hidden,false);
});
