'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {waveDuration,quietUntil,validQuietHours}=require('../portal/mobile-media');
function wave(seconds=1){const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
test('WAVE accepts mono PCM only and bounds every chunk and duration',()=>{
 assert.equal(waveDuration(wave()),1);assert.equal(waveDuration(wave(120)),120);assert.equal(waveDuration(wave(121)),null);assert.equal(waveDuration(wave(120+2/32000)),null);assert.equal(waveDuration(wave(.1)),.1);assert.equal(waveDuration(wave(.1-2/32000)),null);
 for(const b of [wave().subarray(0,50),Buffer.from('invalid')])assert.equal(waveDuration(b),null);
 for(const [offset,value]of [[20,3],[22,2],[24,44100],[40,0xffffffff]]){const b=wave();b.writeUInt32LE(value,offset);assert.equal(waveDuration(b),null);}
});
test('Quiet hours handle Berlin midnight, bounds and both DST transitions',()=>{
 const q={enabled:true,startMinute:1320,endMinute:420,timeZone:'Europe/Berlin'};
 assert.equal(quietUntil(q,Date.parse('2026-09-30T21:12:00Z')),Date.parse('2026-10-01T05:00:00Z'));
 assert.equal(quietUntil(q,Date.parse('2026-10-01T05:00:00Z')),null);
 assert.equal(quietUntil(q,Date.parse('2026-03-28T22:00:00Z')),Date.parse('2026-03-29T05:00:00Z'));
 assert.equal(quietUntil(q,Date.parse('2026-10-24T22:00:00Z')),Date.parse('2026-10-25T06:00:00Z'));
 assert.equal(quietUntil({...q,enabled:false},Date.parse('2026-10-24T22:00:00Z')),null);
 for(const bad of [{...q,startMinute:-1},{...q,endMinute:1440},{...q,endMinute:1320},{...q,timeZone:'evil'},{...q,enabled:'true'}])assert.equal(validQuietHours(bad),false);
});
