'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
function fixture({loseAck=false,badReceipt=false}={}){
 const cid=crypto.randomUUID(),fileId=crypto.randomUUID(),eventId=crypto.randomUUID(),calls=[],notes=[],refreshes=[],nodes=new Map();let uploads=0;
 function node(){return {handlers:{},children:[],disabled:false,dataset:{},classList:{toggle(){}},addEventListener(k,fn){this.handlers[k]=fn;},setAttribute(){},replaceChildren(){this.children=[];},append(...children){this.children.push(...children);},scrollIntoView(){}};}
 const form=node();form.elements={note:{value:'Bitte diese Unterlage prüfen',readOnly:false}};form.querySelector=s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);};
 const doc={querySelector:s=>s==='#case-message'?form:s.includes('data-dirty')?null:node(),querySelectorAll:()=>[],createElement:node};
 const scope={Intl,Date,File,URL,crypto:crypto.webcrypto,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval:()=>0,clearInterval(){},document:doc,window:{addEventListener(){},UnfallxWorkspace:{}},location:{hash:'#fall/'+cid+'/messages'},UnfallxSessionGuard:require('../assets/session-guard'),UnfallxUploads:{...require('../assets/uploads'),bindDropZone:()=>{}},cid,
  refresh:id=>refreshes.push(id),log:(text)=>notes.push(text),post:async(path,method,data)=>{calls.push({path,method,data:structuredClone(data)});if(loseAck&&calls.length===1)throw Error('Lost response');return {ok:true,id:eventId,caseId:cid,clientMessageId:data.clientMessageId};},upload:async(id,item)=>{uploads++;return {file:{id:fileId,caseId:cid,chatAttachment:true,size:item.file.size,sha256:badReceipt?'wrong':crypto.createHash('sha256').update(Buffer.from(await item.file.arrayBuffer())).digest('hex')}};}};
 const src=fs.readFileSync(require.resolve('../assets/portal'),'utf8'),end=src.indexOf("$('#portal-search').addEventListener('submit'");
 vm.runInNewContext(src.slice(0,end)+`me={user:{role:'admin',preferences:{}}};current={case:{id:cid,version:1},files:[]};api=post;uploadOriginal=upload;detail=refresh;message=log;bindChatComposer(cid);globalThis.controls={state:activeChat,unsent:unsentChat,guard:requireSavedCaseData,rebind:saved=>{bindChatComposer(cid,saved);return activeChat}};})();`,scope);
 return {calls,notes,refreshes,form,nodes,cid,get uploads(){return uploads;},state:scope.controls.state,guard:scope.controls.guard,rebind:scope.controls.rebind,unsent:scope.controls.unsent,submit:()=>form.handlers.submit({preventDefault(){}})};
}
test('Web chat retries the identical message after lost acknowledgement and never uploads its original twice',async()=>{
 const f=fixture({loseAck:true});f.state.batch.add([new File(['%PDF-1.4 TEST %%EOF'],'test.pdf')],'document');
 await f.submit();assert.equal(f.calls.length,1);assert.equal(f.uploads,1);assert.equal(f.refreshes.length,0);assert(f.unsent());assert.equal(f.form.elements.note.readOnly,true);assert.equal(f.nodes.get('[data-chat-files]').disabled,true);
 f.form.elements.note.value='Changed while pending';await f.submit();assert.equal(f.calls.length,2);assert.equal(f.uploads,1);assert.deepEqual(f.calls[0].data,f.calls[1].data);assert.deepEqual(f.refreshes,[f.cid]);assert.equal(f.unsent(),false);
});
test('Web chat rejects a mismatched original receipt and sends no message before upload confirmation',async()=>{
 const f=fixture({badReceipt:true});f.state.batch.add([new File(['test'],'test.pdf')],'document');await f.submit();assert.equal(f.calls.length,0);assert.equal(f.refreshes.length,0);assert(f.unsent());assert.equal(f.form.elements.note.readOnly,false);assert(f.notes.some(n=>/Dateien fehlen/.test(n)));
});
test('Attachment-only messages are supported and empty messages cannot be sent',async()=>{
 const empty=fixture();empty.form.elements.note.value=' ';await empty.submit();assert.equal(empty.calls.length,0);
 const f=fixture();f.form.elements.note.value='';f.state.batch.add([new File(['PDF'],'test.pdf')],'document');await f.submit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].data.note,'');assert.equal(f.calls[0].data.fileIds.length,1);
});
test('Conversation shows protected attachments and audio, escapes content and hides removed originals',()=>{
 const scope={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workspace-ui'),'utf8'),scope);const f=crypto.randomUUID(),gone=crypto.randomUUID();
 const html=scope.window.UnfallxWorkspace.messages([{action:'Nachricht',actor:'<img>',note:'<script>alert(1)</script>',at:'2026-10-02',fileIds:[f,gone]},{action:'Nachricht',internal:true,note:'INTERNAL'}],[{id:f,name:'Voice<script>.wav',type:'audio/wav'},{id:gone,name:'SECRET.pdf',deletedAt:'2026-10-02',type:'application/pdf'}]);
 assert(html.includes('<audio controls'));assert(html.includes('/api/portal/files/'+f));assert(!html.includes('/api/portal/files/'+gone));assert(!html.includes('SECRET.pdf'));assert(!html.includes('INTERNAL'));assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('Anhang nicht mehr verfügbar'));
});

test('Saving case fields preserves an unsent chat selection and does not deadlock the composer',async()=>{
 const f=fixture();f.state.batch.add([new File(['PDF'],'test.pdf')],'document');
 assert.doesNotThrow(()=>f.guard('save'));assert.throws(()=>f.guard('file_delete'),/Nachricht/);
 const saved={batch:f.state.batch,attempt:null,note:f.form.elements.note.value};f.form.elements.note.value='';const restored=f.rebind(saved);
 assert.equal(restored.batch,saved.batch);assert.equal(f.form.elements.note.value,saved.note);assert.equal(restored.batch.items.length,1);
 await f.submit();assert.equal(f.calls.length,1);assert.equal(f.uploads,1);assert.equal(f.calls[0].data.note,saved.note);
});

test('Gallery exposes removable annotated copies beside originals without rendering trashed files',()=>{
 const scope={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workspace-ui'),'utf8'),scope);
 const original=crypto.randomUUID(),marked=crypto.randomUUID(),trashed=crypto.randomUUID();
 const html=scope.window.UnfallxWorkspace.photos([{id:original,kind:'photo',type:'image/jpeg',name:'Original',size:123,canDelete:false},{id:marked,kind:'photo_annotation',type:'image/jpeg',name:'Markierung',size:124,canDelete:true},{id:trashed,kind:'photo_annotation',name:'Entfernt',deletedAt:'2026-10-02'}]);
 assert(html.includes('Originalfoto'));assert(html.includes('Markierte Kopie'));assert(html.includes('data-case-photo="'+marked+'"'));assert(html.includes('data-file-delete="'+marked+'"'));assert(!html.includes('data-file-delete="'+original+'"'));assert(!html.includes(trashed));
});


test('Plate and chat rendering escape input, preserve originals and group one latest conversation per case',()=>{
 const scope={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workspace-ui'),'utf8'),scope);const W=scope.window.UnfallxWorkspace;
 const value='  b  ux 1234  ';assert(W.plate(value).includes('B UX 1234'));assert.equal(value,'  b  ux 1234  ');assert(W.plate('').includes('Kennzeichen offen'));assert(!W.plate('<img src=x>').includes('<img'));
 const cases=[{id:'one',number:'UX1',companyName:'<Partner>',intake:{plate:'B UX 1'}},{id:'two',number:'UX2',intake:{plate:''}}];
 const rows=W.conversations(cases,[{caseId:'one',note:'old',at:'2026-10-01'},{caseId:'one',note:'<latest>',at:'2026-10-02',unread:2},{caseId:'foreign',note:'HIDDEN',at:'2026-10-03'}]);
 assert.equal(rows.length,2);assert.equal(rows[0].message.note,'<latest>');const html=W.chatList(rows,false);assert(html.includes('&lt;Partner&gt;'));assert(html.includes('&lt;latest&gt;'));assert(!html.includes('HIDDEN'));assert.equal((html.match(/href="#chat\/one"/g)||[]).length,1);assert(html.includes('2 ungelesene Nachrichten'));
 const history=W.messages([{actorId:'self',actor:'Me',action:'Nachricht',note:'OWN',at:'2026-10-02'},{actorId:'other',actor:'Other',action:'Nachricht',note:'RECEIVED',at:'2026-10-02'}],[],'self');assert.equal((history.match(/is-own/g)||[]).length,1);
});
