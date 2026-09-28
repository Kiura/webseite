import { showPDF, closePDF } from './customer-pdf-viewer.js';
'use strict';
(()=>{
 const token=location.hash.slice(1);
 const content=document.querySelector('#content'),error=document.querySelector('#error'),dialog=document.querySelector('dialog'),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
 let state,busy=false,selected=null,strokes=[],current=null,documentURL=null,requestID=null;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const field=(key,label,required=false,type='text')=>`<label>${label}${required?' *':''}<input name="${key}" value="${esc(state.fields[key])}" type="${type}" maxlength="400" ${required?'required':''}></label>`;
 async function api(action,data={},pdf=false){const r=await fetch('/api/portal/customer/handoff',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action,...data})});if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'Verbindung unterbrochen. Bitte erneut versuchen.');}return pdf?r.blob():r.json();}
 function fail(e){error.hidden=false;error.textContent=e.message;}
 async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);error.hidden=true;try{await fn();}catch(e){fail(e);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
 function paint(){
  const done=state.state==='completed';
  content.innerHTML=`<span class="eyebrow">${done?'VIELEN DANK':'SCHRITT 1 · ANGABEN PRÜFEN'}</span><h1>${done?'Alles unterschrieben.':'Deine Aufnahme.'}</h1><p class="ref">${esc(state.reference)}</p>${done?'<p>Beide Aufträge wurden gespeichert. Dein UNFALLX-Partner kann die Aufnahme jetzt abschließen.</p>':`<p>Prüfe deine Angaben und unterschreibe anschließend beide Aufträge. Dieser Zugang gilt bis ${esc(new Date(state.expires).toLocaleString('de-DE'))} oder bis dein Partner den Kundenstand übernimmt.</p><form class="card" id="details">${field('claimant.company','Firma (optional)')}<div class="row">${field('claimant.first','Vorname',true)}${field('claimant.last','Nachname',true)}</div>${field('plate','Kennzeichen',true)}${field('claimant.street','Straße und Hausnummer',true)}<div class="row">${field('claimant.zip','Postleitzahl',true)}${field('claimant.city','Ort',true)}</div>${field('claimant.phone','Telefon',false,'tel')}${field('claimant.email','E-Mail',false,'email')}${field('accident.date','Unfalldatum',true,'date')}${field('accident.place','Unfallort',true)}<button>Angaben speichern und weiter</button><small>Änderungen erfordern neue Unterschriften.</small></form>`}<h2>${done?'Deine Dokumente':'Schritt 2 · Zwei Unterschriften'}</h2>${state.orders.map(o=>`<section class="card"><strong>${esc(o.title)}</strong><p class="status">${o.signed?'Unterschrieben und gespeichert':'Noch offen'}</p><button class="secondary" data-order="${o.kind}">${o.signed?'Unterschriebenes PDF ansehen':'Auftrag prüfen und unterschreiben'}</button></section>`).join('')}<small>Teile diesen persönlichen Link nur mit der Person, deren Fahrzeug und Angaben hier erfasst werden.</small>`;
  document.querySelector('#details')?.addEventListener('submit',e=>{e.preventDefault();run(async()=>{state=await api('save',{revision:state.revision,fields:Object.fromEntries(new FormData(e.target))});paint();document.querySelector('h2').scrollIntoView({block:'start'});});});
  document.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>run(async()=>{
   if(!done&&document.querySelector('#details')&&!document.querySelector('#details').reportValidity())return;
   if(!done){const values=Object.fromEntries(new FormData(document.querySelector('#details')));if(Object.keys(values).some(k=>values[k]!==state.fields[k])){state=await api('save',{revision:state.revision,fields:values});paint();}}
   selected=state.orders.find(o=>o.kind===b.dataset.order);const blob=await api('document',{kind:selected.kind},true);
   if(documentURL)URL.revokeObjectURL(documentURL);documentURL=URL.createObjectURL(blob);
   document.querySelector('#pdf-link').href=documentURL;document.querySelector('#sign-title').textContent=selected.title;
   document.querySelector('#sign-place').value=state.fields['claimant.city']||'';document.querySelector('#read').checked=false;document.querySelector('#agree').checked=false;document.querySelector('#sign-error').textContent='';strokes=[];current=null;requestID=crypto.randomUUID();draw();
   document.querySelector('#sign-controls').hidden=selected.signed;
   dialog.showModal(); await showPDF(blob, document.querySelector('#document'));
  }));
 }
 function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.lineWidth=3;ctx.lineCap='round';ctx.strokeStyle='#111';for(const stroke of strokes.concat(current?[current]:[])){ctx.beginPath();stroke.forEach((p,i)=>{if(i)ctx.lineTo(p.x*canvas.width,p.y*canvas.height);else ctx.moveTo(p.x*canvas.width,p.y*canvas.height);});ctx.stroke();}}
 const point=e=>{const r=canvas.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};};
 canvas.onpointerdown=e=>{if(busy||strokes.length>=80)return;current=[point(e)];canvas.setPointerCapture(e.pointerId);};canvas.onpointermove=e=>{if(current&&current.length<4000){current.push(point(e));draw();}};canvas.onpointerup=()=>{if(current){strokes.push(current);current=null;requestID=crypto.randomUUID();draw();}};canvas.onpointercancel=()=>{current=null;draw();};document.querySelector('#clear').onclick=()=>{strokes=[];current=null;requestID=crypto.randomUUID();draw();};
 document.querySelector('#sign-submit').onclick=()=>run(async()=>{try{
  const result=await api('sign',{kind:selected.kind,revision:state.revision,templateHash:selected.templateHash,requestID,read:document.querySelector('#read').checked,agreed:document.querySelector('#agree').checked,place:document.querySelector('#sign-place').value,signature:{strokes,aspectRatio:canvas.width/canvas.height}});state=result;dialog.close();paint();
 }catch(e){document.querySelector('#sign-error').textContent=e.message;}});
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 dialog.addEventListener('close',()=>{closePDF();if(documentURL){URL.revokeObjectURL(documentURL);documentURL=null;}});
 if(!/^[a-f0-9]{64}$/.test(token)){content.innerHTML='<h1>Persönlicher Link erforderlich.</h1><p>Bitte öffne den QR-Code oder den vollständigen Link, den dein UNFALLX-Partner dir gezeigt hat.</p>';return;}
 run(async()=>{try{state=await api('read');paint();}catch(e){content.innerHTML='<h1>Zugang nicht verfügbar.</h1><p>Bitte prüfe deine Verbindung oder lass dir von deinem UNFALLX-Partner einen neuen Link erstellen.</p>';throw e;}});
})();
