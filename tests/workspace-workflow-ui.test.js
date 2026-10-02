'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const box={};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/workspace-ui'),'utf8'),box);const W=box.UnfallxWorkspace;
const record=(status,extra={})=>({id:'case-a',status,createdAt:'2026-09-01T12:00:00Z',intake:{},...extra});
const finance={partnerNet:100000,invoiceGross:238000,received:238000,agreement:'Test agreement',agreedAt:'2026-09-01',partnerAcceptedAt:'2026-09-01',partnerInvoiceApproved:true,partnerInvoiceId:'invoice'};

test('finance release requires payment, acceptance, report dispatch and invoice approval',()=>{
 assert.equal(W.financeStage(record('report_sent',{finance})).stage,'released');
 for(const [key,value] of [['received',100],['partnerAcceptedAt',null],['agreement',''],['partnerInvoiceApproved',false]])assert.notEqual(W.financeStage(record('report_sent',{finance:{...finance,[key]:value}})).bucket,'released');
 assert.notEqual(W.financeStage(record('report_ready',{finance})).bucket,'released');
 assert.equal(W.financeStage(record('closed',{finance:{...finance,paidOutAt:'2026-10-01'}})).stage,'paid');
});
test('partner public finance uses server eligibility and cannot imply payout from report completion',()=>{
 const f={partnerNet:100000,partnerAcceptedAt:'2026-09-01',paymentStatus:'approved',payable:false};
 assert.equal(W.financeStage(record('closed',{finance:f})).bucket,'expected');
 assert.equal(W.financeStage(record('closed',{finance:{...f,payable:true}})).bucket,'released');
 assert.equal(W.financeStage(record('closed',{finance:{...f,paidOutAt:'2026-10-01'}})).bucket,'paid');
});
test('finance totals are disjoint and unknown amounts are not invented',()=>{
 const rows=[record('in_progress',{finance:{...finance,partnerNet:123450,partnerInvoiceApproved:false}}),record('report_sent',{finance}),record('closed',{finance:{...finance,partnerNet:75000,paidOutAt:'2026-10-01'}}),record('submitted')];
 assert.equal(JSON.stringify(W.financeTotals(rows)),JSON.stringify({expected:123450,released:100000,paid:75000}));
 assert.equal(W.financeStage(rows[3]).amount,null);
});
test('partner queue prioritizes overdue requests, then recoverable drafts and agreements',()=>{
 const rows=[record('draft'),record('needs_info',{id:'case-b',requests:[{id:'r',state:'open',title:'Foto fehlt',due:'2026-10-01'}]}),record('in_progress',{id:'case-c',finance:{partnerNet:12345}})];
 const tasks=W.tasks(rows,'partner','2026-10-03');assert.equal(tasks[0].key,'case-b:request-r');assert.equal(tasks[0].overdue,true);
 assert(tasks.some(t=>t.key==='case-a:draft'&&t.href==='#fall/case-a/overview'));assert(tasks.some(t=>t.key==='case-c:agreement'));
});
test('archived and trashed cases do not create active tasks; closed cases can retain payout tasks',()=>{
 const rows=[record('draft',{filing:{folder:'archived'}}),record('submitted',{filing:{folder:'deleted'}}),record('closed',{id:'closed',finance})];
 assert.equal(W.tasks(rows,'partner').length,0);const tasks=W.tasks(rows,'admin');assert.equal(tasks.length,1);assert.equal(tasks[0].key,'closed:payout');
});
test('internal and partner queues respect their distinct responsibilities',()=>{
 const rows=[record('submitted',{requests:[{id:'r',state:'answered',title:'Foto'}],nextTask:{text:'Intern geheim',done:false}})];
 assert.equal(W.tasks(rows,'partner').length,0);const tasks=W.tasks(rows,'admin');assert(tasks.some(t=>t.key==='case-a:inbox'));assert(tasks.some(t=>t.title==='Intern geheim'));assert(tasks.some(t=>t.title==='Ergänzung prüfen: Foto'));
 assert.equal(W.tasks([record('report_sent',{finance})],'appraiser').length,0);
});
test('every required intake field maps to a visible wizard data step',()=>{
 const I=require('../assets/case-intake'),scope={window:{UnfallxIntake:I}};vm.runInNewContext(fs.readFileSync(require.resolve('../assets/case-intake-ui'),'utf8'),scope);
 const UI=scope.window.UnfallxIntakeUI;for(const f of I.fields)assert([0,1].includes(UI.wizardStepFor(f.name)),f.name);assert.equal(UI.wizardStepFor('photo'),2);assert.equal(UI.wizardStepFor('ownerFirstName'),0);assert.equal(UI.wizardStepFor('lawyerChoice'),0);assert.equal(UI.wizardStepFor('inspectionDate'),1);
});
