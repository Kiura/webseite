'use strict';
function waveDuration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 4*1024*1024 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE' || bytes.readUInt32LE(4)+8!==bytes.length) return null;
  let offset=12, format=false, payload=null;
  while(offset+8<=bytes.length) {
    const size=bytes.readUInt32LE(offset+4),begin=offset+8,chunk=bytes.toString('ascii',offset,offset+4);
    if(size>bytes.length-begin)return null;
    if(chunk==='fmt ') {
      if(format||size<16||bytes.readUInt16LE(begin)!==1||bytes.readUInt16LE(begin+2)!==1||bytes.readUInt32LE(begin+4)!==16000||bytes.readUInt32LE(begin+8)!==32000||bytes.readUInt16LE(begin+12)!==2||bytes.readUInt16LE(begin+14)!==16)return null;
      format=true;
    } else if(chunk==='data') {if(payload!==null||size%2)return null;payload=size;}
    offset=begin+size+size%2;
  }
  if(offset!==bytes.length||!format||payload===null||payload<3200)return null;
  const seconds=payload/32000;return seconds<=120?seconds:null;
}
const quietDefault=()=>({enabled:false,startMinute:1320,endMinute:420,timeZone:'Europe/Berlin'});
function validQuietHours(q) {
  return q&&typeof q.enabled==='boolean'&&Number.isInteger(q.startMinute)&&q.startMinute>=0&&q.startMinute<1440&&Number.isInteger(q.endMinute)&&q.endMinute>=0&&q.endMinute<1440&&q.startMinute!==q.endMinute&&q.timeZone==='Europe/Berlin';
}
const berlin=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function quietUntil(q,now=Date.now()) {
  if(!validQuietHours(q)||!q.enabled)return null;
  function contains(time){const parts=berlin.formatToParts(new Date(time));const minute=Number(parts.find(p=>p.type==='hour').value)*60+Number(parts.find(p=>p.type==='minute').value);return q.startMinute<q.endMinute?minute>=q.startMinute&&minute<q.endMinute:minute>=q.startMinute||minute<q.endMinute;}
  if(!contains(now))return null;
  // Walk real minutes so spring-forward and repeated autumn hours are handled in Berlin time.
  for(let time=Math.floor(now/60000)*60000+60000;time<=now+26*3600000;time+=60000)if(!contains(time))return time;
  return now+26*3600000;
}
module.exports={waveDuration,quietDefault,validQuietHours,quietUntil};
