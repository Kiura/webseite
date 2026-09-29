'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PDFDocument,rgb}=require('pdf-lib');
const fontkit=require('@pdf-lib/fontkit');
const D=require('./domain');
const names={unfallx:'OrderUNFALLX',nextright:'OrderNextright'};
function source(kind){D.assert(names[kind],'Unbekannter Auftrag.');return fs.readFileSync(path.join(__dirname,'order-templates',names[kind]+'.pdf'));}
function templateHash(kind){return D.hash(Buffer.concat([source(kind),...(kind==='unfallx'?[fs.readFileSync(path.join(__dirname,'order-templates/OrderTerms.pdf'))]:[])]));}
function signature(input){
 D.assert(input&&Number.isFinite(input.aspectRatio)&&input.aspectRatio>=0.5&&input.aspectRatio<=6&&Array.isArray(input.strokes)&&input.strokes.length>0&&input.strokes.length<=80,'Bitte eine gültige Unterschrift zeichnen.');
 let total=0,distance=0;
 const strokes=input.strokes.map(stroke=>{D.assert(Array.isArray(stroke)&&stroke.length<=4000,'Unterschrift zu groß.');return stroke.map((p,i)=>{D.assert(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1,'Ungültige Unterschrift.');total++;if(i)distance+=Math.hypot(p.x-stroke[i-1].x,p.y-stroke[i-1].y);return {x:p.x,y:p.y};});});
 D.assert(total>=8&&total<=8000&&distance>0.15,'Bitte vollständig unterschreiben.');return {strokes,aspectRatio:input.aspectRatio};
}
async function renderOrder({kind,fields,fieldsHash,reference,place='',signedAt=null,ink=null}){
 const pdf=await PDFDocument.load(source(kind));pdf.registerFontkit(fontkit);
 const font=await pdf.embedFont(fs.readFileSync(path.join(__dirname,'order-templates/NotoSans.ttf')),{subset:true});
 const first=pdf.getPage(0),last=pdf.getPage(pdf.getPageCount()-1);
 function textAt(page,text,x,y,w,size=9){let value=String(text||'');while(font.widthOfTextAtSize(value,size)>w&&size>5)size-=0.25;while(font.widthOfTextAtSize(value,size)>w&&value.length)value=value.slice(0,-1);page.drawText(value,{x,y:page.getHeight()-y-size,font,size,color:rgb(0.05,0.05,0.05)});}
 const name=[fields['claimant.first'],fields['claimant.last']].filter(Boolean).join(' ');
 if(kind==='unfallx'){
  [name,fields['claimant.street'],[fields['claimant.zip'],fields['claimant.city']].join(' '),fields['claimant.phone'],fields['claimant.email'],reference,fields.plate].forEach((v,i)=>textAt(first,v,216,149+i*13.25,310));textAt(first,fields['accident.date'],216,410,310);
 }
 function drawInk(page,rect){if(!ink)return;const height=Math.min(rect.h,rect.w/ink.aspectRatio),width=height*ink.aspectRatio;for(const stroke of ink.strokes)for(let i=1;i<stroke.length;i++)page.drawLine({start:{x:rect.x+stroke[i-1].x*width,y:rect.y+(1-stroke[i-1].y)*height},end:{x:rect.x+stroke[i].x*width,y:rect.y+(1-stroke[i].y)*height},thickness:0.9,color:rgb(0.03,0.03,0.03)});}
 if(signedAt){drawInk(last,kind==='unfallx'?{x:392,y:last.getHeight()-729,w:128,h:34}:{x:378,y:last.getHeight()-729,w:149,h:38});textAt(last,(kind==='unfallx'?'':place+', ')+new Date(signedAt).toLocaleDateString('de-DE',{timeZone:'Europe/Berlin'}),kind==='unfallx'?128:74,kind==='unfallx'?670:718,kind==='unfallx'?95:149,8);}
 if(kind==='unfallx'){const terms=await PDFDocument.load(fs.readFileSync(path.join(__dirname,'order-templates/OrderTerms.pdf')));for(const page of await pdf.copyPages(terms,terms.getPageIndices()))pdf.addPage(page);}
 const logo=await pdf.embedPng(fs.readFileSync(path.join(__dirname,'order-templates/Logo.png')));
 let page,y;function next(){page=pdf.addPage([595.28,841.89]);y=780;page.drawImage(logo,{x:45,y:754,width:108,height:59});y=716;}next();
 function line(label,value,size=10){let out='';for(const char of label+String(value||'—')){if(font.widthOfTextAtSize(out+char,size)>505){emit(out,size);out='';}out+=char;}if(out)emit(out,size);y-=7;}
 function emit(s,size){if(y<130)next();page.drawText(s.trim(),{x:45,y,font,size,color:rgb(.08,.08,.08)});y-=size*1.5;}
 line('',kind==='unfallx'?'Auftrag an UNFALLX':'Vollmacht für nextright',18);
 line('',signedAt?'Unterschrift und Zuordnung zum Originaldokument':'Vorschau zur Prüfung - noch nicht unterschrieben',11);
 for(const [label,value]of [['Fall: ',reference],['Kunde: ',name],['Firma: ',fields['claimant.company']],['Adresse: ',[fields['claimant.street'],fields['claimant.zip'],fields['claimant.city']].filter(Boolean).join(', ')],['Kennzeichen: ',fields.plate],['Unfall: ',[fields['accident.date'],fields['accident.place']].filter(Boolean).join(' · ')],['E-Mail: ',fields['claimant.email']],['Telefon: ',fields['claimant.phone']]])line(label,value);
 line('Unterzeichnet in: ',place);line('Zeitpunkt: ',signedAt?new Date(signedAt).toLocaleString('de-DE',{timeZone:'Europe/Berlin'})+' (Europe/Berlin)':'noch offen');
 if(y<275)next();if(ink){drawInk(page,{x:45,y:y-90,w:340,h:85});y-=112;}
 line('',signedAt?'Das Originaldokument einschließlich beigefügter Bedingungen wurde zur Einsicht bereitgestellt. Der Unterzeichner hat Lesen und Zustimmung für diesen Auftrag gesondert bestätigt.':'Bitte zuerst die Angaben und sämtliche Seiten des Auftrags prüfen.',9);
 line('Vorlage SHA-256: ',templateHash(kind),7);line('Falldaten SHA-256: ',fieldsHash,7);
 pdf.setTitle((kind==='unfallx'?'UNFALLX Auftrag':'nextright Vollmacht')+' · '+reference);pdf.setAuthor('UNFALLX');
 return Buffer.from(await pdf.save());
}
module.exports={templateHash,signature,renderOrder};
