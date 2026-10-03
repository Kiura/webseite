'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {analyze,inspectionWeek,inspectionIcs}=require('../assets/admin-zentrale-data');
test('Zentrale aggregates partner ranking, law firm handoffs, payouts and months from real records',()=>{
 const a=analyze({now:'2026-10-03T12:00:00Z',companies:[{id:'p1',name:'Werkstatt A',type:'Werkstatt',status:'approved'},{id:'p2',name:'Werkstatt B',status:'pending'}],lawyers:[{id:'l1',name:'Kanzlei A',status:'active'}],cases:[
  {id:'1',companyId:'p1',lawyerId:'l1',status:'report_sent',createdAt:'2026-09-01T00:00:00Z',submittedAt:'2026-09-02T00:00:00Z',reportReadyAt:'2026-09-04T00:00:00Z',dispatch:{at:'2026-09-05T00:00:00Z'},finance:{partnerNet:100000,agreedAt:'2026-09-04T00:00:00Z',invoiceGross:238000,received:238000,paidOutAt:'2026-10-02T00:00:00Z'}},
  {id:'2',companyId:'p1',lawyerId:'l1',status:'closed',createdAt:'2026-10-01T00:00:00Z',submittedAt:'2026-10-01T10:00:00Z',reportReadyAt:'2026-10-02T00:00:00Z',finance:{partnerNet:140000,agreedAt:'2026-10-02T00:00:00Z',invoiceGross:333200,received:100000,partnerInvoiceId:'i2'}},
  {id:'3',companyId:'p2',status:'draft',createdAt:'2026-10-02T00:00:00Z'},
  {id:'4',companyId:'p2',status:'submitted',createdAt:'2026-10-02T00:00:00Z',submittedAt:'2026-10-02T08:00:00Z',filing:{folder:'deleted'}}
 ]});
 assert.equal(a.totals.cases,3);
 assert.equal(a.totals.paidCents,100000);
 assert.equal(a.totals.openCents,140000);
 assert.equal(a.totals.unpaidHonorarCents,233200);
 assert.equal(a.totals.invoiceReview,1);
 assert.equal(a.partners[0].name,'Werkstatt A');
 assert.equal(a.partners[0].yearCases,2);
 assert.equal(a.lawyers[0].sent,2);
 assert.equal(a.months.at(-1).paidCents,100000);
 assert.equal(a.pendingPartners,1);
});
test('Inspection calendar groups real case dates, omits trashed cases and exports appointments',()=>{
 const cases=[
  {id:'a',number:'UX-1',intake:{inspectionDate:'2026-10-05',inspectionTime:'13:30',plate:'B UX 1',inspectionCity:'Berlin',inspectionAddressExtra:'Halle Reinickendorf'}},
  {id:'b',number:'UX-2',intake:{inspectionDate:'2026-10-05',inspectionTime:'09:00',plate:'B UX 2',inspectionStreet:'Lübarser Straße',inspectionHouseNumber:'25'}},
  {id:'c',number:'UX-3',filing:{folder:'deleted'},intake:{inspectionDate:'2026-10-05',inspectionTime:'10:00'}}
 ];
 const week=inspectionWeek(cases,new Date('2026-10-07T12:00:00'));
 assert.equal(week[0].date,'2026-10-05');
 assert.deepEqual(week[0].cases.map(c=>c.id),['b','a']);
 assert.equal(week[0].hallAppointments,2);
 assert.equal(week[0].hallPeak,1);
 const ics=inspectionIcs(cases);
 assert.match(ics,/DTSTART;TZID=Europe\/Berlin:20261005T090000/);
 assert.match(ics,/SUMMARY:Besichtigung · B UX 1/);
 assert.doesNotMatch(ics,/UX-3/);
});
