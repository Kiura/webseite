'use strict';
const D = require('./domain');
const {fileVisible} = require('./presentation');
const editable = ['draft', 'recording', 'ready_to_submit', 'needs_info'];
const ordinary = ['photo', 'photo_annotation', 'document', 'registration', 'authorization', 'case_bundle'];
const activeFiles = files => files.filter(f => !f.deletedAt);

function blockedReason(user, c, file, exportIds = new Set()) {
  if (!fileVisible({...file, deletedAt:null}, c, user)) return 'Diese Datei ist nicht freigegeben.';
  if (['active','completed'].includes(c.mobile?.customerHandoff?.state)) return 'Bitte zuerst den Kundenzugang in der App abschließen oder sperren.';
  if (file.deletedAt && file.sourceFileId && file.sourceUnavailable) return 'Bitte zuerst das zugehörige Originalfoto wiederherstellen.';
  if (file.hasActiveAnnotation) return 'Das Original gehört zu einer markierten Kopie und bleibt erhalten.';
  if (['closed', 'declined'].includes(c.status)) return 'Der Fall ist abgeschlossen. Die Unterlagen bleiben dokumentiert.';
  if (exportIds.has(file.id)) return 'Diese Originaldatei gehört zu einer autoiXpert-Übergabe und bleibt dokumentiert.';
  if (file.kind === 'report') {
    if (user.role === 'partner') return 'Gutachten werden von UNFALLX verwaltet.';
    if (['report_sent', 'closed'].includes(c.status) || c.dispatch && c.dispatch.state !== 'failed') return 'Versandte oder gerade versendete Gutachten bleiben dokumentiert.';
  } else if (file.kind === 'partner_invoice') {
    if (user.role === 'appraiser') return 'Rechnungen werden von der Administration verwaltet.';
    if (c.finance?.partnerInvoiceApproved || c.finance?.paidOutAt) return 'Freigegebene oder ausgezahlte Rechnungen bleiben dokumentiert.';
    if (file.deletedAt && c.finance?.partnerInvoiceId && c.finance.partnerInvoiceId !== file.id) return 'Es liegt bereits eine neuere Partnerrechnung vor.';
  } else if (!ordinary.includes(file.kind)) return 'Diese Datei kann nicht entfernt werden.';
  else if (user.role === 'partner') {
    if (!editable.includes(c.status)) return 'Der Fall wurde eingereicht. Bitte UNFALLX um eine Korrektur bitten.';
    if (file.uploadedByRole && file.uploadedByRole !== 'partner') return 'Intern hochgeladene Unterlagen werden von UNFALLX verwaltet.';
  }
  return '';
}

async function exportIds(s, c) {
  const job = await s.get('autoixpert_export', c.id);
  return new Set((job?.files || []).map(f => f.id));
}
async function listing(s, user, c, files) {
  const ids = await exportIds(s, c), visible = files.filter(f => fileVisible({...f, deletedAt:null}, c, user));
  const view = f => {const reason = blockedReason(user, c, {...f,sourceUnavailable:!!f.sourceFileId&&!files.some(source=>source.id===f.sourceFileId&&!source.deletedAt),hasActiveAnnotation:files.some(copy=>!copy.deletedAt&&copy.sourceFileId===f.id)}, ids); return {...f, canDelete:!f.deletedAt && !reason, canRestore:!!f.deletedAt && !reason, removalBlockedReason:reason};};
  return {files:visible.filter(f => !f.deletedAt).map(view), deletedFiles:visible.filter(f => f.deletedAt).map(view)};
}
async function apply(s, user, c, data, audit) {
  if (!['file_delete', 'file_restore'].includes(data.action)) return false;
  D.assert(data.confirmed === true, 'Bitte die Dateiaktion bestätigen.');
  const file = await s.get('file', D.text(data.fileId, 128, true));
  D.assert(file && file.caseId === c.id && fileVisible({...file, deletedAt:null}, c, user), 'Datei nicht gefunden.', 404);
  if (user.role === 'partner') D.assert((await s.get('company', user.companyId))?.status === 'approved', 'Der Betrieb ist nicht freigeschaltet.', 403);
  D.assert(!(await s.list('file',c.id)).some(f=>!f.deletedAt&&f.sourceFileId===file.id),'Das Original gehört zu einer markierten Kopie und bleibt erhalten.',403);
  D.assert(!c.mobile?.customerHandoff || !['active','completed'].includes(c.mobile.customerHandoff.state),'Bitte zuerst den Kundenzugang in der App abschließen oder sperren.',409);
  const source = file.sourceFileId ? await s.get('file',file.sourceFileId) : null;
  const reason = blockedReason(user, c, {...file,sourceUnavailable:!!file.sourceFileId&&(!source||source.deletedAt||source.caseId!==c.id)}, await exportIds(s, c));
  D.assert(!reason, reason, 403);
  const restoring = data.action === 'file_restore';
  D.assert(restoring ? !!file.deletedAt : !file.deletedAt, 'Die Datei wurde bereits geändert. Bitte neu laden.', 409);
  if (restoring) {
    const active = activeFiles(await s.list('file', c.id));
    D.assert(active.length < 100 && active.reduce((n, f) => n + f.size, 0) + file.size <= 750 * 1024 * 1024, 'Das Dateilimit ist erreicht. Bitte zuerst andere Dateien entfernen.');
    if (file.kind === 'partner_invoice') D.assert(D.payable(c) && c.finance.partnerAcceptedAt, 'Die Rechnung ist noch nicht freigabefähig.');
    delete file.deletedAt; delete file.deletedBy; delete file.deletedByRole;
    if (file.kind === 'partner_invoice') c.finance.partnerInvoiceId = file.id;
  } else {
    file.deletedAt = new Date().toISOString(); file.deletedBy = user.name; file.deletedByRole = user.role;
    if (file.kind === 'partner_invoice' && c.finance?.partnerInvoiceId === file.id) {c.finance.partnerInvoiceId = null; c.finance.partnerInvoiceApproved = false;}
  }
  await s.put('file', file, c.id);
  const files = activeFiles(await s.list('file', c.id));
  if (!restoring && c.status === 'ready_to_submit' && D.submissionErrors(c, files).length) c.status = 'recording';
  if (!restoring && file.kind === 'report' && c.status === 'report_ready' && !files.some(f => f.kind === 'report')) c.status = 'in_progress';
  await audit(s, user, c, restoring ? 'Unterlage wiederhergestellt' : 'Unterlage entfernt', file.name, file.kind === 'report' || file.kind === 'partner_invoice');
  return true;
}
module.exports = {activeFiles, blockedReason, listing, apply};
