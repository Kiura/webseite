'use strict';
const http2 = require('node:http2');
const crypto = require('node:crypto');
const D = require('./domain');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const kinds = ['requests', 'accepted', 'commission'];
const topic = 'de.schadenakte.ios';
const recipient = user => D.hash(user.id + ':' + (user.companyId || '') + ':' + (user.createdAt || ''));
function eventKind(actor, c, event) {
  if (event.internal || actor.role === 'partner' || ['draft', 'recording', 'ready_to_submit'].includes(c.status)) return null;
  if (['Unterlagen angefordert', 'Rückfrage erneut geöffnet', 'Nachricht', 'Status: Rückfrage'].includes(event.action)) return 'requests';
  if (event.action === 'Status: Angenommen') return 'accepted';
  if (event.action === 'Partnerrechnung freigegeben' && D.payable(c) && c.finance?.partnerInvoiceApproved) return 'commission';
  return null;
}
function payload(row) {
  const copy = {requests: 'Eine Rückfrage wartet auf dich. Öffne den Fall in der App.', accepted: 'Ein Auftrag wurde angenommen. Den aktuellen Stand findest du in der App.', commission: 'Eine Provision wurde zur Auszahlung freigegeben. Details findest du in der App.'};
  return {aps: {alert: {title: 'UNFALLX', body: row.target === 'chat' ? 'Eine neue Nachricht von UNFALLX wartet auf dich.' : copy[row.kind]}, sound: 'default'}, version: 1, caseID: row.caseId, kind: row.kind, recipient: row.recipient, ...(row.target === 'chat' ? {target: 'chat'} : {})};
}
function createAPNs(env, connect = http2.connect) {
  let key, cached;
  try {
    if (/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID || '') && /^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID || '') && env.APNS_TOPIC === topic) {
      const parsed = crypto.createPrivateKey(String(env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n'));
      if (parsed.asymmetricKeyType === 'ec' && parsed.asymmetricKeyDetails?.namedCurve === 'prime256v1') key = parsed;
    }
  } catch { /* Never log credentials or key-parser errors. */ }
  function token() {
    if (cached && cached.at > Date.now() - 40 * 60000) return cached.value;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({alg: 'ES256', kid: env.APNS_KEY_ID}) + '.' + encode({iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000)});
    const signature = crypto.sign('sha256', Buffer.from(unsigned), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url');
    cached = {at: Date.now(), value: unsigned + '.' + signature}; return cached.value;
  }
  async function send(device, row) {
    D.assert(key, 'Push ist noch nicht eingerichtet.', 503);
    return new Promise((resolve, reject) => {
      const client = connect(device.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      let done = false, request;
      const timer = setTimeout(() => finish(Error('APNS_TIMEOUT')), 15000);
      function finish(error, result) { if (done) return; done = true; clearTimeout(timer); request?.close(); client.destroy(); error ? reject(error) : resolve(result); }
      client.on('error', () => finish(Error('APNS_CONNECTION')));
      client.on('connect', () => {
        try {
        request = client.request({':method': 'POST', ':path': '/3/device/' + device.token, authorization: 'bearer ' + token(), 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-id': row.apnsId, 'apns-collapse-id': row.id, 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600)});
        let status = 0, bytes = '';
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { bytes += chunk; if (bytes.length > 8192) finish(Error('APNS_RESPONSE')); });
        request.on('error', () => finish(Error('APNS_REQUEST')));
        request.on('end', () => { let reason; try { reason = JSON.parse(bytes).reason; } catch {} finish(null, {status, reason}); });
        request.end(JSON.stringify(payload(row)));
        } catch { finish(Error('APNS_REQUEST')); }
      });
    });
  }
  return {ready: !!key, send};
}
function createMobilePush({env, tx, auth, body, rate, transport = createAPNs(env)}) {
  let flushing = false;
  async function valid(s, row) {
    const device = await s.get('push_device', row.deviceId), user = device && await s.get('user', device.userId), session = device && await s.get('session', device.sessionId);
    const company = user && await s.get('company', user.companyId), c = await s.get('case', row.caseId);
    if (!device?.active || device.userId !== row.userId || device.sessionId !== row.sessionId || !device.preferences[row.kind] || !user?.active || !user.verifiedAt || user.role !== 'partner' || recipient(user) !== row.recipient || !session || session.expires <= Date.now() || session.pendingMfa || session.userId !== user.id || company?.status !== 'approved' || c?.companyId !== user.companyId) return null;
    if (row.kind === 'commission' && (!D.payable(c) || !c.finance?.partnerInvoiceApproved || c.finance.paidOutAt)) return null;
    return device;
  }
  async function route(path, req) {
    const actor = await tx(s => auth(req, s));
    D.assert(actor.user.role === 'partner', 'Nur für Partnerzugänge.', 403);
    if (path === '/mobile/push/config' && req.method === 'GET') return {version: 1, enabled: transport.ready};
    D.assert(path === '/mobile/push/device' && req.method === 'POST', 'Nicht gefunden.', 404);
    const data = await body(req);
    D.assert(uuid.test(data.installationId || ''), 'Ungültiges Gerät.');
    return tx(async s => {
      const {user, session} = await auth(req, s);
      await rate(s, 'push-device:' + user.id, 60);
      const id = D.hash(data.installationId), old = await s.get('push_device', id);
      if (data.enabled === false) { if (old?.userId === user.id) { old.active = false; await s.put('push_device', old, user.id); } return {ok: true, enabled: false}; }
      D.assert(transport.ready, 'Push ist noch nicht eingerichtet.', 503);
      D.assert((await s.get('company', user.companyId))?.status === 'approved', 'Bitte die Partnerfreischaltung abwarten.', 403);
      D.assert(typeof data.token === 'string' && /^[a-f0-9]{32,512}$/.test(data.token) && data.token.length % 2 === 0, 'Ungültiger Gerätetoken.');
      D.assert(data.environment === 'production' || data.environment === 'sandbox' && env.APNS_ALLOW_SANDBOX === 'true', 'Diese Push-Umgebung ist nicht freigeschaltet.');
      D.assert(data.preferences && kinds.every(k => typeof data.preferences[k] === 'boolean'), 'Bitte Benachrichtigungen auswählen.');
      // A token can belong to only one current account/installation. Never keep an old recipient.
      for (const other of await s.list('push_device')) if (other.id !== id && other.token === data.token && other.environment === data.environment) { other.active = false; await s.put('push_device', other, other.userId); }
      await s.put('push_device', {id, userId: user.id, sessionId: session.id, recipient: recipient(user), token: data.token, environment: data.environment, preferences: Object.fromEntries(kinds.map(k => [k, data.preferences[k]])), active: true, updatedAt: new Date().toISOString()}, user.id);
      return {ok: true, enabled: true};
    });
  }
  async function event(s, actor, c, event) {
    const kind = eventKind(actor, c, event); if (!kind) return;
    for (const device of await s.list('push_device')) {
      if (!device.active || !device.preferences[kind]) continue;
      const user = await s.get('user', device.userId);
      if (!user || user.companyId !== c.companyId) continue;
      const id = D.hash(event.id + ':' + device.id + ':' + kind);
      if (await s.get('push_notification', id)) continue;
      const row = {id, apnsId: D.id(), deviceId: device.id, userId: user.id, sessionId: device.sessionId, recipient: recipient(user), caseId: c.id, kind, ...(event.action === 'Nachricht' ? {target: 'chat'} : {}), state: 'pending', attempts: 0, nextAttempt: Date.now(), expires: Date.now() + 86400000, createdAt: new Date().toISOString()};
      if (await valid(s, row)) await s.put('push_notification', row, user.id);
    }
  }
  async function flush() {
    if (flushing || !transport.ready) return; flushing = true;
    try { for (let i = 0; i < 12; i++) {
      const job = await tx(async s => {
        const all = await s.list('push_notification');
        for (const row of all) {
          if (row.expires <= Date.now()) { await s.remove('push_notification', row.id); continue; }
          if (row.state === 'sending' && row.claimedAt < Date.now() - 60000) { row.state = 'pending'; await s.put('push_notification', row, row.userId); }
        }
        const row = all.find(r => r.state === 'pending' && r.expires > Date.now() && r.nextAttempt <= Date.now()); if (!row) return null;
        const device = await valid(s, row);
        if (!device) { row.state = 'cancelled'; await s.put('push_notification', row, row.userId); return {skip: true}; }
        row.state = 'sending'; row.claimedAt = Date.now(); row.attempts++; await s.put('push_notification', row, row.userId); return {row, device};
      });
      if (!job) break; if (job.skip) continue;
      let result; try { result = await transport.send(job.device, job.row); } catch { result = {status: 0}; }
      await tx(async s => {
        const row = await s.get('push_notification', job.row.id); if (!row || row.state !== 'sending') return;
        const invalid = result.status === 410 || result.status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(result.reason);
        const retry = result.status === 0 || result.status === 429 || result.status >= 500;
        row.state = result.status === 200 ? 'sent' : retry && row.attempts < 5 ? 'pending' : 'failed';
        row.lastStatus = result.status; row.nextAttempt = Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts);
        await s.put('push_notification', row, row.userId);
        if (invalid) { const device = await s.get('push_device', job.device.id); if (device?.token === job.device.token && device.sessionId === job.device.sessionId) { device.active = false; await s.put('push_device', device, device.userId); } }
      });
    } } catch { /* Queue remains durable; no customer or credential data in logs. */ }
    finally { flushing = false; }
  }
  return {route, event, flush};
}
module.exports = {createMobilePush, createAPNs, eventKind, payload, recipient};

