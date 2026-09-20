/**
 * UNFALLX – Anfrageformular (Backend)
 *
 * Nimmt POST /api/anfrage als JSON entgegen, prueft und bereinigt die Angaben
 * und übergibt sie an den dauerhaften Datenbank-Eingang mit Versandwarteschlange.
 *
 * Schutzmassnahmen: Groessenlimit, Rate-Limit je IP, Honeypot, Mindestzeit
 * seit Seitenaufruf, serverseitige Validierung,
 * Dateiuploads nur als JPEG/PNG/WebP mit Magic-Byte-Pruefung und Groessenlimit.
 *
 * Der E-Mail-Versand laeuft ueber die Versandwarteschlange des Portals
 * (portal/contacts.js, SMTP-Konfiguration siehe .env.example).
 *
 * Konfiguration ueber Umgebungsvariablen (Hostinger: hPanel):
 *   ANFRAGE_LIMIT       Anfragen je IP und 10 Minuten (Standard: 8)
 *   PORTAL_TRUST_PROXY  "true" nur hinter dem Hostinger-Proxy: dann zaehlt der
 *                       letzte X-Forwarded-For-Eintrag als Client-IP
 */
'use strict';

const MAX_BODY = 22 * 1024 * 1024;        // Drei Fotos à 5 MB, Base64-Aufschlag und Formularfelder
const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // 5 MB je Foto
const MIN_FORM_MS = 3000;                 // Mindestzeit zwischen Laden und Senden
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = Math.max(1, parseInt(process.env.ANFRAGE_LIMIT || '8', 10) || 8);


/* ---------- Rate-Limit (im Speicher, je Prozess) ------------------------- */

const treffer = new Map();
function rateLimited(ip) {
  const jetzt = Date.now();
  const liste = (treffer.get(ip) || []).filter((t) => jetzt - t < WINDOW_MS);
  if (liste.length >= LIMIT) { treffer.set(ip, liste); return true; }
  liste.push(jetzt);
  treffer.set(ip, liste);
  if (treffer.size > 5000) {
    treffer.forEach((v, k) => { if (!v.length || jetzt - v[v.length - 1] > WINDOW_MS) treffer.delete(k); });
  }
  return false;
}

function clientIp(req) {
  // Nur hinter dem vertrauenswuerdigen Proxy den letzten Hop nehmen; der erste
  // Eintrag in X-Forwarded-For ist vom Client frei waehlbar.
  const trusted = process.env.PORTAL_TRUST_PROXY === 'true';
  const xf = trusted ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
  return xf || (req.socket && req.socket.remoteAddress) || 'unbekannt';
}

/* ---------- Hilfsfunktionen ---------------------------------------------- */

function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
}
function einzeilig(v, max) {
  return text(v, max).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
}
function istEmail(s) {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,24}$/i.test(s);
}
function istTelefon(s) {
  const ziffern = s.replace(/[^\d]/g, '');
  return /^[+\d\s()\/.-]{6,25}$/.test(s) && ziffern.length >= 6 && ziffern.length <= 15;
}
function istDatum(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const jetzt = Date.now();
  return d.getTime() <= jetzt + 86400000 && d.getTime() >= jetzt - 5 * 365 * 86400000;
}

const BILDTYPEN = {
  'image/jpeg': { ext: 'jpg', magic: [[0xFF, 0xD8, 0xFF]] },
  'image/png':  { ext: 'png', magic: [[0x89, 0x50, 0x4E, 0x47]] },
  'image/webp': { ext: 'webp', magic: [[0x52, 0x49, 0x46, 0x46]] }
};
function magicOk(buf, typ) {
  const def = BILDTYPEN[typ];
  if (!def) return false;
  return def.magic.some((m) => m.every((b, i) => buf[i] === b))
    && (typ !== 'image/webp' || buf.slice(8, 12).toString('ascii') === 'WEBP');
}

/* ---------- Validierung --------------------------------------------------- */

/* Fehlertexte fuer das deutschsprachige Formular */
const MELDUNGEN = {
  de: {
    ungueltig: 'Ungültige Anfrage.',
    name: 'Bitte geben Sie Ihren Namen an.',
    telefon: 'Bitte geben Sie eine gültige Telefonnummer an.',
    email: 'Die E-Mail-Adresse sieht nicht richtig aus.',
    datum: 'Bitte prüfen Sie das Unfalldatum.',
    beschreibung: 'Bitte beschreiben Sie kurz, was passiert ist.',
    emailNoetig: 'Für eine Antwort per E-Mail brauchen wir Ihre E-Mail-Adresse.',
    datenschutz: 'Bitte bestätigen Sie den Hinweis zum Datenschutz.',
    fotoFormat: 'Bitte nur Fotos im Format JPG, PNG oder WebP hochladen.',
    fotoGroesse: 'Jedes Foto darf höchstens 5 MB groß sein.',
    fotoKeinBild: 'Eine Datei konnte nicht als Bild erkannt werden.',
    felder: 'Bitte prüfen Sie die markierten Felder.'
  }
};

function sprache(body) {
  return 'de';
}

function pruefe(body) {
  const fehler = {};
  const d = {};
  const M = MELDUNGEN[sprache(body)];

  if (typeof body !== 'object' || body === null) return { fehler: { allgemein: MELDUNGEN.de.ungueltig } };

  /* Honeypot: das Feld ist fuer Menschen unsichtbar und muss leer bleiben */
  if (text(body.website, 200)) return { spam: true };

  /* Mindestzeit seit Laden des Formulars */
  const t0 = parseInt(body.t0, 10);
  if (!t0 || Date.now() - t0 < MIN_FORM_MS) return { spam: true };

  d.name = einzeilig(body.name, 100);
  if (d.name.length < 2) fehler.name = M.name;

  d.telefon = einzeilig(body.telefon, 30);

  d.email = einzeilig(body.email, 120).toLowerCase();
  if (d.email && !istEmail(d.email)) fehler.email = M.email;

  d.ort = einzeilig(body.ort, 120);
  d.datum = einzeilig(body.datum, 10);
  if (d.datum && !istDatum(d.datum)) fehler.datum = M.datum;

  d.fahrzeug = einzeilig(body.fahrzeug, 120);
  d.sprache = sprache(body);

  d.beschreibung = text(body.beschreibung, 4000);
  if (d.beschreibung.length < 10) fehler.beschreibung = M.beschreibung;

  d.anliegen = einzeilig(body.anliegen, 40);
  if (!['unfallgutachten', 'wertgutachten', 'kostenvoranschlag', 'sonstiges', ''].includes(d.anliegen)) d.anliegen = 'sonstiges';

  d.kontaktweg = einzeilig(body.kontaktweg, 20);
  if (!['telefon', 'whatsapp', 'email'].includes(d.kontaktweg)) d.kontaktweg = 'telefon';
  if ((d.kontaktweg !== 'email' || d.telefon) && !istTelefon(d.telefon)) fehler.telefon = M.telefon;
  if (d.kontaktweg === 'email' && !d.email) fehler.email = M.emailNoetig;

  if (body.datenschutz !== true && body.datenschutz !== 'true' && body.datenschutz !== 'on') {
    fehler.datenschutz = M.datenschutz;
  }

  /* Fotos */
  d.fotos = [];
  const fotos = Array.isArray(body.fotos) ? body.fotos.slice(0, MAX_FILES) : [];
  for (const f of fotos) {
    if (!f || typeof f !== 'object') continue;
    const typ = einzeilig(f.type, 40).toLowerCase();
    const name = einzeilig(f.name, 120).replace(/[^\w.\- ]+/g, '_') || 'foto';
    if (!BILDTYPEN[typ]) { fehler.fotos = M.fotoFormat; break; }
    let buf;
    try { buf = Buffer.from(String(f.data || ''), 'base64'); } catch (e) { buf = null; }
    if (!buf || !buf.length) continue;
    if (buf.length > MAX_FILE_BYTES) { fehler.fotos = M.fotoGroesse; break; }
    if (!magicOk(buf, typ)) { fehler.fotos = M.fotoKeinBild; break; }
    d.fotos.push({ name, typ, buf });
  }

  return Object.keys(fehler).length ? { fehler } : { daten: d };
}

/* ---------- Ausgabe ------------------------------------------------------- */

function antwort(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({}, headers || {}, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function handle(req, res, securityHeaders, submit) {
  const ip = clientIp(req);
  const ct = String(req.headers['content-type'] || '');
  if (!/application\/json/i.test(ct)) {
    return antwort(res, 415, { ok: false, error: 'Bitte als JSON senden.' }, securityHeaders);
  }
  const laenge = parseInt(req.headers['content-length'] || '0', 10);
  if (laenge > MAX_BODY) {
    return antwort(res, 413, { ok: false, error: 'Die Anfrage ist zu groß. Bitte kleinere Fotos verwenden.' }, securityHeaders);
  }
  if (rateLimited(ip)) {
    return antwort(res, 429, { ok: false, error: 'Zu viele Anfragen. Bitte versuchen Sie es in einigen Minuten erneut oder rufen Sie uns an.' }, securityHeaders);
  }

  const teile = [];
  let bytes = 0;
  let abgebrochen = false;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      abgebrochen = true;
      antwort(res, 413, { ok: false, error: 'Die Anfrage ist zu groß. Bitte kleinere Fotos verwenden.' }, securityHeaders);
      req.destroy();
      return;
    }
    teile.push(chunk);
  });
  req.on('end', async () => {
    if (abgebrochen) return;
    let body;
    try { body = JSON.parse(Buffer.concat(teile).toString('utf8')); }
    catch (e) { return antwort(res, 400, { ok: false, error: 'Die Angaben konnten nicht gelesen werden.' }, securityHeaders); }

    const ergebnis = pruefe(body);
    if (ergebnis.spam) {
      /* Bots bekommen absichtlich eine unauffaellige Erfolgsantwort */
      return antwort(res, 200, { ok: true }, securityHeaders);
    }
    if (ergebnis.fehler) {
      return antwort(res, 422, { ok: false, error: MELDUNGEN[sprache(body)].felder, felder: ergebnis.fehler }, securityHeaders);
    }

    const d = ergebnis.daten;
    const meta = { zeit: new Date().toISOString(), ip };

    try {
      if(!submit)throw new Error('CONTACT_STORE_UNAVAILABLE');
      const result=await submit(d,meta);
      return antwort(res,202,result,securityHeaders);
    } catch(e) {
      return antwort(res,e.status||503,{ok:false,error:e.status?e.message:'Ihre Anfrage konnte gerade nicht bestätigt werden. Bitte versuchen Sie es erneut oder schreiben Sie an info@unfallx.com.'},securityHeaders);
    }
  });
  req.on('error', () => {
    if (!res.headersSent) antwort(res, 400, { ok: false, error: 'Verbindung unterbrochen.' }, securityHeaders);
  });
}

module.exports = { handle, pruefe };
