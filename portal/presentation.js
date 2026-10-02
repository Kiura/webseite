'use strict';

// Presentation metadata follows the same per-case visibility as original downloads.
function fileVisible(file, c, user) {
  if (file.deletedAt) return false;
  if (user.role !== 'admin' && file.kind === 'payout_receipt' && (!c.finance?.paidOutAt || c.finance.payoutReceiptId !== file.id)) return false;
  if (user.role === 'appraiser' && ['partner_invoice','payout_receipt'].includes(file.kind)) return false;
  if (user.role === 'partner' && file.kind === 'report' && !['report_ready', 'report_sent', 'closed'].includes(c.status)) return false;
  return true;
}
function summarize(c, files, events, user) {
  const visibleFiles = files.filter(f => fileVisible(f, c, user));
  const photos = visibleFiles.filter(f => f.kind === 'photo');
  const preview = photos.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
  const publicEvents = events.filter(e => !e.internal).sort((a,b) => b.at.localeCompare(a.at));
  const pendingRequest=(c.requests||[]).find(r=>r.state==='open');
  const request = pendingRequest?{...pendingRequest,at:pendingRequest.createdAt,actor:pendingRequest.createdBy}:c.requests?.length?null:publicEvents.find(e => e.action === 'Status: Rückfrage' && e.note);
  const lastMessage = publicEvents.find(e => e.action === 'Nachricht' && (e.note || e.fileIds?.length));
  const recentEvents = events.filter(e => !['partner','customer'].includes(user.role) || !e.internal).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,5).map(e=>({id:e.id,action:e.action,note:e.note,at:e.at,actor:e.actor,internal:!!e.internal}));
  const eventView = e => e ? {id:e.id, note:e.note || (e.fileIds?.length ? e.fileIds.length+' Anhang/Anhänge' : ''), at:e.at, actor:e.actor, attachmentCount:e.fileIds?.length||0} : null;
  return {...c, fileCount:visibleFiles.length, photoCount:photos.length, documentCount:visibleFiles.length-photos.length,
    thumbnailFileId:(preview.find(f => f.perspective === 'frontLeft') || preview[0])?.id || null,
    latestRequest:eventView(request), lastMessage:eventView(lastMessage), recentEvents};
}
async function summarizeCases(s, cases, user) {
  const result=[];
  for (const c of cases) result.push(summarize(c, await s.list('file',c.id), await s.list('event',c.id),user));
  return result;
}
module.exports={fileVisible,summarize,summarizeCases};
