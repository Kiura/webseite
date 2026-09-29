import { getDocument, GlobalWorkerOptions } from '/assets/customer-pdf/pdf.js';
GlobalWorkerOptions.workerSrc = '/assets/customer-pdf/pdf.worker.js';
let current;
export function closePDF() { current?.destroy(); current = null; }
export async function showPDF(blob, host) {
 closePDF(); host.replaceChildren(); host.classList.remove('pdf-wide');
 const loading = document.createElement('p'); loading.textContent = 'Alle Dokumentseiten werden geladen …'; host.append(loading);
 try {
  const task = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, useWasm: false, standardFontDataUrl: '/assets/customer-pdf/fonts/' }); current = task;
  const pdf = await task.promise;
  if(current !== task) return;
  host.replaceChildren();
  const zoom = document.createElement('button'); zoom.type='button'; zoom.className='secondary pdf-zoom'; zoom.textContent='Schrift vergrößern'; zoom.onclick=()=>{ const wide=host.classList.toggle('pdf-wide'); zoom.textContent=wide?'Ganze Seiten anzeigen':'Schrift vergrößern'; }; host.append(zoom);
  for(let i=1;i<=pdf.numPages;i++) {
   const page = await pdf.getPage(i), base=page.getViewport({scale:1}), viewport=page.getViewport({scale:1400/base.width});
   if(current !== task) return;
   const figure=document.createElement('figure'), canvas=document.createElement('canvas'), caption=document.createElement('figcaption');
   canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height); canvas.setAttribute('aria-label',`Dokumentseite ${i} von ${pdf.numPages}`); canvas.setAttribute('role','img');
   caption.textContent=`Seite ${i} von ${pdf.numPages}`; figure.append(canvas,caption);host.append(figure);
   await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
   const text=await page.getTextContent(), details=document.createElement('details'), summary=document.createElement('summary'), paragraph=document.createElement('p');
   summary.textContent='Seitentext lesen'; paragraph.textContent=text.items.map(t=>t.str+(t.hasEOL?'\n':' ')).join('');details.append(summary,paragraph);figure.append(details);
   page.cleanup();
  }
 } catch(e) {
  host.replaceChildren(); const p=document.createElement('p');p.textContent='Die Vorschau konnte nicht geladen werden. Bitte öffne das vollständige PDF über den Link darüber und lies alle Seiten.';host.append(p);
 }
}
