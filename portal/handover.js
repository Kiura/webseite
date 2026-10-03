'use strict';
const I=require('../assets/case-intake');
// Human-readable field names accompany lossless source data. This is an exchange
// file, not an assertion that autoiXpert supports arbitrary JSON file imports.
function handover(c,files){const data=I.normalize(c.intake);return {format:'UNFALLX-Fallakte',version:1,exportedAt:new Date().toISOString(),reference:c.number,caseId:c.id,partner:c.companyName,fields:I.fields.filter(f=>I.visible(f,data)).map(f=>({field:f.name,label:f.label,value:data[f.name],display:I.display(f,data)})),intake:c.intake,nativeIntake:c.mobile?.fields||null,retainedNativeIntake:c.mobile?.retainedFields||null,files:files.filter(f=>!f.deletedAt&&f.kind!=='partner_invoice').map(({id,kind,name,type,size,sha256})=>({id,kind,name,type,size,sha256})),instructions:'Alle Originaldateien separat als ZIP herunterladen. Angaben vor Übernahme in autoiXpert prüfen. Diese Datei ist kein freigegebenes Gutachten.'};}
module.exports={handover};
