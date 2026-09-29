/* Original-file batch queue. Requests remain bounded; retries never recreate completed entries. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.UnfallxUploads=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const MAX_FILE=25*1024*1024,MAX_FILES=100,MAX_CASE=750*1024*1024;
const kinds={photo:'Schadenfoto',registration:'Fahrzeugschein',authorization:'Unterschriebener Auftrag',case_bundle:'Fahrzeugschein & Auftrag (gemeinsame Datei)',document:'Weitere Unterlage'};
function mime(file){return {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','webp':'image/webp','pdf':'application/pdf','heic':'image/heic','heif':'image/heif'}[file.name.split('.').pop().toLowerCase()]||file.type;}
class Batch{
 constructor(options={}){this.items=[];this.running=false;this.cancelled=false;this.maxFile=options.maxFile||MAX_FILE;this.pdfOnly=!!options.pdfOnly;}
 add(files,kind='auto'){for(const file of files){const type=mime(file),key=[file.name,file.size,file.lastModified||0,kind].join(':');if(this.items.some(x=>x.key===key))continue;const error=(this.pdfOnly||['report','partner_invoice','payout_receipt'].includes(kind))&&type!=='application/pdf'?'Bitte hier ausschließlich PDF-Dateien ablegen.':!['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'].includes(type)?'Bitte JPG, PNG, WebP, HEIC/HEIF oder PDF auswählen.':file.size>this.maxFile?'Größer als '+(this.maxFile/1024/1024)+' MB. Bitte die Originaldatei aufteilen oder UNFALLX kontaktieren.':!file.size?'Die Datei ist leer.':null;this.items.push({file,key,type,kind:kind==='auto'?(type==='application/pdf'?'document':'photo'):kind,state:error?'invalid':'waiting',error,progress:0});}}
 cancel(){this.cancelled=true;}
 remove(key,storedRemoved=false){if(this.running)return;this.items=this.items.filter(x=>x.key!==key||x.state==='done'&&!storedRemoved);}
 classify(item,kind){if(this.running||item.state==='done')throw new Error('Gespeicherte Unterlagen bitte in der Fallakte zuordnen.');if(!Object.hasOwn(kinds,kind)||kind==='photo'&&!item.type.startsWith('image/'))throw new Error('Bitte eine passende Dateiart auswählen.');item.kind=kind;}
 pending(){return this.items.some(x=>x.state!=='done');}
 async send(upload,changed=()=>{},existing=[]){if(this.cancelled)throw new Error('Die Upload-Auswahl wurde geschlossen.');if(this.running)throw new Error('Der Upload läuft bereits.');if(this.items.some(x=>x.state==='invalid'))throw new Error('Bitte die markierten Dateien prüfen. Gültige Originaldateien können unverändert hochgeladen werden.');this.running=true;try{let remaining=this.items.filter(x=>x.state!=='done');const overLimit=()=>existing.length+remaining.length>MAX_FILES||existing.reduce((n,f)=>n+f.size,0)+remaining.reduce((n,x)=>n+x.file.size,0)>MAX_CASE;
 if(overLimit()&&typeof crypto!=='undefined'&&crypto.subtle){for(const item of remaining){const candidates=existing.filter(f=>f.id&&f.sha256&&f.size===item.file.size&&f.kind===item.kind&&f.type===item.type);if(!candidates.length)continue;const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await item.file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');const stored=candidates.find(f=>f.sha256===hash);if(stored){item.result={file:stored,alreadyStored:true};item.state='done';item.progress=100;item.error=null;changed();}}remaining=this.items.filter(x=>x.state!=='done');}
 if(overLimit())throw new Error('Pro Fall sind bis zu 100 Dateien und insgesamt 750 MB möglich.');for(const item of remaining){if(this.cancelled)break;if(typeof navigator!=='undefined'&&navigator.onLine===false)break;item.state='uploading';item.error=null;item.progress=0;changed();try{item.result=await upload(item,p=>{item.progress=p;changed();});item.state='done';item.progress=100;}catch(e){if(e.status===401){this.cancel();throw e;}item.state='error';item.error=e.message||'Verbindung unterbrochen. Bitte erneut versuchen.';}changed();}if(this.pending())throw new Error('Einige Dateien fehlen noch. Bereits gespeicherte Dateien bleiben erhalten. Bitte „Offene Uploads wiederholen“ wählen.');}finally{this.running=false;changed();}}
}
function markup(options={}){const pdf=options.pdfOnly;return (pdf?'':'<details class="workflow-photo-guide"><summary>Foto-Anleitung: Was sollte zu sehen sein?</summary><p>Alle vier Fahrzeugecken, Kennzeichen, Fahrgestellnummer, Kilometerstand sowie den Schaden als Übersicht und aus der Nähe fotografieren. Fahrzeugschein und unterschriebenen Auftrag separat zuordnen.</p><ol><li>Fahrzeug und Schaden vollständig im Bild.</li><li>Ruhig halten, gutes Licht, keine Spiegelung über wichtigen Angaben.</li><li>In der Wischansicht prüfen; ungeeignete Aufnahmen mit × entfernen und über + ergänzen.</li></ol><p>Die Hinweise ersetzen deine Sichtprüfung nicht. Originaldateien werden unverändert übertragen.</p></details>')+'<div class="upload-picker"> <label class="upload-dropzone" data-dropzone><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7"/></svg><strong>'+ (pdf?'PDFs hier ablegen':'Fotos & PDFs hier ablegen')+'</strong><span>Mehrere Dateien hineinziehen oder auswählen</span><input type="file" data-batch-files multiple aria-label="'+(pdf?'Mehrere PDFs auswählen':'Schadenfotos, Fahrzeugschein und Auftrag gemeinsam auswählen')+'" accept="'+(pdf?'.pdf,application/pdf':'.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf')+'"></label><p class="partner-muted">'+(pdf?'Private PDF-Ablage · 6 MB pro Datei. Mehrere PDFs gemeinsam auswählen.':'Originalqualität · 25 MB pro Datei · bis 100 Dateien / 750 MB pro Fall. Du kannst die Auswahl mehrmals ergänzen. Fotos werden automatisch zugeordnet – keine Einzelbeschriftung nötig. Nur Fahrzeugschein und unterschriebenen Auftrag passend zuordnen. HEIC/HEIF wird als Original gespeichert; die Vorschau hängt vom Gerät ab.')+'</p><p class="upload-summary" data-batch-summary role="status" aria-live="polite">Noch keine Dateien ausgewählt.</p><div class="upload-review-actions"><button type="button" data-review-all hidden>Fotos durchsehen</button></div><ul class="upload-queue upload-grid" data-batch-list></ul><button class="upload-add-more" type="button" data-add-more>＋ '+(pdf?'PDFs':'Fotos & PDFs')+' hinzufügen</button></div>';}
const guardedDocuments=new WeakSet();
const fileDrag=e=>Array.from(e.dataTransfer?.types||[]).includes('Files')||!!e.dataTransfer?.files?.length;
function bindDropZone(zone,onFiles,disabled=()=>false){
 let depth=0;const reset=()=>{depth=0;zone.dataset.dragging='false';};
 zone.addEventListener('dragenter',e=>{if(!fileDrag(e))return;e.preventDefault();if(!disabled()){depth++;zone.dataset.dragging='true';}});
 zone.addEventListener('dragover',e=>{if(!fileDrag(e))return;e.preventDefault();e.dataTransfer.dropEffect=disabled()?'none':'copy';});
 zone.addEventListener('dragleave',()=>{if(--depth<=0)reset();});
 zone.addEventListener('drop',e=>{if(!fileDrag(e))return;e.preventDefault();e.stopPropagation();reset();if(!disabled())onFiles(Array.from(e.dataTransfer.files||[]));});
 // Prevent an accidental drop just outside the target from replacing the case page.
 const doc=zone.ownerDocument;if(doc&&!guardedDocuments.has(doc)){guardedDocuments.add(doc);for(const type of ['dragover','drop'])doc.addEventListener(type,e=>{if(fileDrag(e))e.preventDefault();});}
 return reset;
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mount(el,kind=()=> 'auto',options={}){
 const batch=options.batch||new Batch(options),list=el.querySelector('[data-batch-list]'),summary=el.querySelector('[data-batch-summary]'),input=el.querySelector('[data-batch-files]');
 let lastSignature='',destroyed=false,removing=false;const urls=new Map(),nodes=new Map(),reviewButton=el.querySelector('[data-review-all]'),addButton=el.querySelector('[data-add-more]');
 const imageItem=x=>x.type.startsWith('image/')&&x.state!=='invalid';
 function source(x){if(!imageItem(x))return '';if(!urls.has(x.key))urls.set(x.key,URL.createObjectURL(x.file));return urls.get(x.key);}
 async function remove(key){
  if(destroyed||batch.running||removing)return;
  const item=batch.items.find(x=>x.key===key);if(!item)return;
  if(item.state==='done'){
   if(!options.removeStored)return;
   removing=true;viewer?.close();paint();
   try{if(await options.removeStored(item)!==true)return;batch.remove(key,true);}
   catch(error){item.error=error.message||'Entfernen fehlgeschlagen. Bitte erneut versuchen.';}
   finally{removing=false;paint();}
  }else batch.remove(key);
  paint();el.dispatchEvent(new Event('change',{bubbles:true}));
 }
 const viewer=options.pdfOnly?null:window.UnfallxPhotoReview.create({items:()=>batch.items.filter(imageItem).map(x=>({key:x.key,src:source(x),name:x.file.name,removable:x.state!=='done'||!!options.removeStored})),locked:()=>batch.running||removing,remove,add:()=>input.click()});
 function card(x){
  const li=document.createElement('li');li.className=imageItem(x)?'upload-photo-card':'upload-document-card';
  const image=imageItem(x);li.innerHTML=(image?'<button type="button" class="upload-image-open" aria-label="'+esc(x.file.name)+' ansehen"><img src="'+esc(source(x))+'" alt="'+esc(x.file.name)+'" loading="lazy" decoding="async"><span class="upload-image-fallback" hidden>HEIC / Foto · Original bleibt erhalten</span></button>':'<span class="upload-document-icon">'+(x.type==='application/pdf'?'PDF':'Datei')+'</span>')+'<button type="button" class="upload-remove" aria-label="'+esc(x.file.name)+' aus der Auswahl entfernen">×</button><strong>'+esc(x.file.name)+'</strong><small data-item-status></small><progress hidden value="0" max="100" aria-label="Upload-Fortschritt für '+esc(x.file.name)+'"></progress>';
  if(!options.pdfOnly&&!['report','partner_invoice','payout_receipt'].includes(x.kind)){
   const wrap=document.createElement(image?'details':'div');wrap.className='upload-kind';wrap.innerHTML=(image?'<summary>Als Dokument zuordnen</summary>':'')+'<label>Dateiart<select aria-label="Dateiart für '+esc(x.file.name)+'">'+Object.entries(kinds).filter(([k])=>k!=='photo'||image).map(([k,t])=>'<option value="'+k+'">'+esc(t)+'</option>').join('')+'</select></label>';li.append(wrap);
   wrap.querySelector('select').onchange=e=>{batch.classify(x,e.target.value);paint();el.dispatchEvent(new Event('change',{bubbles:true}));};
  }
  li.querySelector('.upload-remove').onclick=()=>remove(x.key);
  if(image){const hint=document.createElement('small');hint.className='upload-quality';hint.textContent=x.quality||'';li.append(hint);li.querySelector('img').addEventListener('load',e=>{const img=e.target;if(img.naturalWidth<1200||img.naturalHeight<800){x.quality='Kleine Auflösung – bitte Lesbarkeit und Details prüfen.';hint.textContent=x.quality;}});li.querySelector('.upload-image-open').onclick=()=>viewer.open(x.key);li.querySelector('img').onerror=e=>{e.target.hidden=true;li.querySelector('.upload-image-fallback').hidden=false;};}
  return li;
 }
 function paint(){
  if(destroyed)return;
  const done=batch.items.filter(x=>x.state==='done').length,photos=batch.items.filter(imageItem);
  summary.textContent=batch.items.length?batch.items.length+(batch.items.length===1?' Datei · ':' Dateien · ')+Math.max(.1,batch.items.reduce((n,x)=>n+x.file.size,0)/1024/1024).toLocaleString('de-DE',{maximumFractionDigits:1})+' MB · '+done+' gespeichert':'Noch keine Dateien ausgewählt.';
  const keys=new Set(batch.items.map(x=>x.key));for(const [key,node] of nodes)if(!keys.has(key)){node.remove();nodes.delete(key);if(urls.has(key)){URL.revokeObjectURL(urls.get(key));urls.delete(key);}}
  for(const x of batch.items){let li=nodes.get(x.key);if(!li){li=card(x);nodes.set(x.key,li);list.append(li);}li.dataset.state=x.state;
   li.querySelector('[data-item-status]').textContent=x.error||({done:'Original sicher gespeichert',uploading:'Übertragung · '+Math.round(x.progress)+' %',waiting:(kinds[x.kind]||'PDF')+' · bereit'}[x.state]||'Erneut versuchen');
   const button=li.querySelector('.upload-remove');button.hidden=x.state==='done'&&!options.removeStored;button.disabled=batch.running||removing;button.setAttribute('aria-label',x.file.name+(x.state==='done'?' aus der Ablage entfernen':' aus der Auswahl entfernen'));
   const select=li.querySelector('select');if(select){select.value=x.kind;select.disabled=batch.running||removing||x.state==='done';}
   const progress=li.querySelector('progress');progress.hidden=x.state!=='uploading';progress.value=x.progress;
  }
  input.disabled=batch.running||removing;addButton.disabled=batch.running||removing;reviewButton.hidden=!photos.length;reviewButton.textContent=photos.length+(photos.length===1?' Foto ansehen':' Fotos durchsehen');viewer?.refresh();const signature=batch.items.map(x=>[x.key,x.kind,x.state,x.result?.file?.id].join(':')).join('|');if(signature!==lastSignature){lastSignature=signature;options.onChange?.();}
 }
 function add(files,override=kind()){if(destroyed||batch.running||removing)return;batch.add(files,override);paint();el.dispatchEvent(new Event('change',{bubbles:true}));}
 input.addEventListener('change',()=>{add([...input.files]);input.value='';});addButton.onclick=()=>input.click();reviewButton.onclick=()=>viewer?.open(batch.items.find(imageItem)?.key);
 bindDropZone(el.querySelector('[data-dropzone]'),add,()=>batch.running||removing);
 return {batch,paint,add,destroy(){destroyed=true;viewer?.destroy();for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();nodes.clear();}};
}
return {Batch,kinds,MAX_FILE,MAX_FILES,MAX_CASE,mime,markup,mount,bindDropZone};
});
