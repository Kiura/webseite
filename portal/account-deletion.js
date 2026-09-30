'use strict';
const D=require('./domain');
const day=86400000;
const notice='Dein persönlicher Zugang und die zugehörigen Anmeldedaten werden innerhalb von 30 Tagen gelöscht. Wir prüfen vorher, welche Geschäftsunterlagen weiterhin aufbewahrt werden müssen. Du erhältst eine Bestätigung mit den verbleibenden Daten und dem Grund. Bis zum Abschluss kannst du den Antrag zurücknehmen.';
function createAccountDeletion({tx,rate,oauth,notifications}){
 const recent=session=>D.assert(session&&!session.pendingMfa&&session.expires>Date.now()&&Date.now()-Date.parse(session.createdAt)<15*60000,'Bitte erneut anmelden und die Kontolöschung anschließend bestätigen.',409);
 const partner=user=>D.assert(user.role==='partner','Dieser Löschvorgang ist für Partnerkonten vorgesehen.',403);
 const publicRequest=r=>r?{id:r.id,status:r.status,requestedAt:r.requestedAt,dueAt:r.dueAt,completedAt:r.completedAt||null}:null;
 async function current(s,user){return (await s.list('account_deletion',user.id)).find(r=>r.status==='pending');}
 async function view(user){partner(user);return tx(async s=>({request:publicRequest(await current(s,user)),notice}));}
 async function request(user,session,data){
  partner(user);recent(session);D.assert(data.confirmed===true&&D.email(data.email)===user.email,'Bitte die eigene E-Mail-Adresse und die Löschung bestätigen.');
  return tx(async s=>{
   const fresh=await s.get('user',user.id),active=await s.get('session',session.id);D.assert(fresh?.active&&active?.userId===user.id,'Bitte erneut anmelden.',401);recent(active);
   const existing=await current(s,user);if(existing)return {request:publicRequest(existing),notice};
   await rate(s,'deletion-request:'+user.id,3,day);
   const row={id:D.id(),userId:user.id,status:'pending',requestedAt:new Date().toISOString(),dueAt:new Date(Date.now()+30*day).toISOString()};await s.put('account_deletion',row,user.id);
   return {request:publicRequest(row),notice};
  });
 }
 async function cancel(user,data){partner(user);return tx(async s=>{const r=await current(s,user);D.assert(r&&r.id===data.id,'Offener Löschauftrag nicht gefunden.',404);await s.remove('account_deletion',r.id);return {request:null,notice,message:'Der Löschauftrag wurde zurückgenommen.'};});}
 async function overview(){return tx(async s=>({requests:await Promise.all((await s.list('account_deletion')).filter(r=>r.status==='pending').map(async r=>{const u=await s.get('user',r.userId),co=u?.companyId?await s.get('company',u.companyId):null;return {...publicRequest(r),name:u?.name||'',email:u?.email||'',company:co?.name||'',companyId:co?.id||null,caseCount:(await s.list('case')).filter(c=>u&&(c.companyId===u.companyId||c.ownerUserId===u.id)).length};}))}));}
 async function complete(actor,session,data){
  D.assert(actor.role==='admin','Nur die Administration darf Löschaufträge abschließen.',403);recent(session);
  D.assert(data.confirmed===true&&data.reviewed===true,'Bitte Datenprüfung und endgültige Löschung bestätigen.');
  const retained=D.text(data.retained,2000,true);
  const snapshot=await tx(async s=>{const r=await s.get('account_deletion',D.text(data.id,128,true));D.assert(r?.status==='pending','Offener Löschauftrag nicht gefunden.',404);const u=await s.get('user',r.userId);D.assert(u?.role==='partner','Partnerkonto nicht gefunden.',404);return {r,u,identities:await s.list('identity',u.id)};});
  // A failed provider revocation leaves the account and its deletion request intact.
  for(const identity of snapshot.identities)await oauth.revoke(identity);
  const result=await tx(async s=>{
   const r=await s.get('account_deletion',snapshot.r.id),u=await s.get('user',snapshot.u.id),adminSession=await s.get('session',session.id),admin=await s.get('user',actor.id);
   D.assert(admin?.active&&admin.role==='admin'&&adminSession?.userId===actor.id,'Bitte erneut anmelden.',401);recent(adminSession);
   D.assert(r?.status==='pending'&&u?.role==='partner','Löschauftrag wurde inzwischen geändert.',409);
   const identities=await s.list('identity',u.id);
   D.assert(JSON.stringify(identities)===JSON.stringify(snapshot.identities),'Anmeldemethoden wurden inzwischen geändert. Bitte erneut prüfen.',409);
   const sessions=await s.list('session',u.id),sessionIds=new Set(sessions.map(x=>x.id));
   for(const kind of ['session','identity','security','sms_challenge','sms_guard','security_event','password_token','referral_code','case_request','chat_read'])for(const row of await s.list(kind,u.id))await s.remove(kind,row.id);
   for(const row of await s.list('token',u.email))await s.remove('token',row.id);
   for(const row of await s.list('oauth_pending'))if(row.email===u.email)await s.remove('oauth_pending',row.id);
   for(const row of await s.list('oauth_state'))if(row.userId===u.id)await s.remove('oauth_state',row.id);
   for(const row of await s.list('native_auth'))if(sessionIds.has(row.sessionId)){for(const grant of await s.list('native_grant'))if(grant.requestId===row.id)await s.remove('native_grant',grant.id);await s.remove('native_auth',row.id);}
   for(const row of await s.list('push_device',u.id))await s.remove('push_device',row.id);
   for(const row of await s.list('push_notification',u.id))await s.remove('push_notification',row.id);
   for(const row of await s.list('notification'))if(row.userId===u.id||row.to===u.email)await s.remove('notification',row.id);
   // Email-derived login IDs are reusable. Retained financial records must not
   // become accessible to a newly registered account with the same email.
   const erasedOwner='erased:'+r.id;
   const rewards=await s.list('referral_reward',u.id);
   for(const reward of rewards){reward.referrerId=erasedOwner;await s.put('referral_reward',reward,erasedOwner);}
   for(const entry of await s.list('referral_attribution'))if(entry.id===u.id||entry.referrerId===u.id)await s.remove('referral_attribution',entry.id);
   for(const c of await s.list('case'))if(c.referrerId===u.id){c.referrerId=erasedOwner;await s.put('case',c,c.companyId||c.ownerUserId);}
   // Cases belong to the business and its customers, not to the operator's login.
   // Their retention/purge is reviewed separately and must be described before completion.
   await s.remove('user',u.id);
   const companyUsers=(await s.list('user',u.companyId)).filter(x=>x.role==='partner');
   const businessRecords=(await s.list('case')).some(c=>c.companyId===u.companyId)||(await s.list('vault_document')).some(d=>d.companyId===u.companyId)||rewards.length>0;
   if(!companyUsers.length&&!businessRecords&&u.companyId)await s.remove('company',u.companyId);
   const completedAt=new Date().toISOString();
   await s.put('account_deletion',{id:r.id,status:'completed',requestedAt:r.requestedAt,completedAt,retained,actor:actor.id,expires:Date.now()+90*day});
   await notifications.queue(s,{key:'account-deleted:'+r.id,to:u.email,title:'Dein UNFALLX-Zugang wurde gelöscht',copy:'Dein persönliches Partnerkonto einschließlich Passwort, Anbieterverknüpfungen und aktiven Sitzungen wurde gelöscht.\n\nVerbleibende Geschäftsunterlagen und Begründung:\n'+retained+'\n\nSicherungskopien und verbleibende Unterlagen werden im Rahmen der oben beschriebenen Datenprüfung berücksichtigt.',url:'https://unfallx.com/datenschutz',cta:'Datenschutz'});
   // A restore must reapply these deletion IDs before releasing restored account data.
   await s.put('account_erasure',{id:u.id,requestId:r.id,deletedAt:completedAt});
   return {message:'Partnerkonto gelöscht. Die Abschlussbestätigung liegt in der Versandwarteschlange.'};
  });
  void notifications.flush().catch(()=>{});return result;
 }
 return {view,request,cancel,overview,complete};
}
module.exports={createAccountDeletion};
