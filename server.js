/**
 * UNFALLX – Webserver
 * Liefert die statischen Seiten aus und nimmt Anfragen des Formulars
 * unter POST /api/anfrage entgegen (siehe anfrage.js).
 * Node-Standardbibliothek; nodemailer ist optional (Mailversand).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
require('./portal/hostinger-env').loadHostingerGoogleEnv(__dirname);
require('./portal/hostinger-env').loadHostingerAppleEnv(__dirname);
require('./portal/hostinger-env').loadHostingerStorageEnv(__dirname);
require('./portal/hostinger-env').loadHostingerAutoixpertEnv(__dirname);
const anfrage = require('./anfrage');
const hosts = require('./portal/hosts');
const help = require('./assets/help-content');
const portal = require('./portal/app').createPortal();
portal.ready().catch(() => {});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* Dateien, die nie ausgeliefert werden dürfen */
const BLOCKED = /(^|[\\/])(\.git|\.env[^\\/]*|node_modules|partials|data|portal|tests|docs|scripts|pnpm-lock\.yaml|anfrage\.js|server\.js|package(-lock)?\.json)([\\/]|$)/i;

/**
 * Gemeinsame Bausteine aus partials/ werden in die Seiten eingesetzt.
 * In den HTML-Dateien steht dafuer z. B. <!--#include:header-->.
 * So sind Kopf- und Fussbereich auf allen Seiten garantiert identisch.
 */
const PARTIAL_DIR = path.join(ROOT, 'partials');

function loadPartials() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(PARTIAL_DIR); } catch (e) { return out; }
  files.filter((f) => f.toLowerCase().endsWith('.html')).forEach((f) => {
    try {
      out[path.basename(f, '.html')] = fs.readFileSync(path.join(PARTIAL_DIR, f), 'utf8').trim();
    } catch (e) { /* ignorieren */ }
  });
  return out;
}

const PARTIALS = loadPartials();

function applyPartials(html) {
  return html.replace(/<!--#include:([a-z0-9_-]+)-->/gi, (match, name) => {
    const key = name.toLowerCase();
    if(key==='storage-privacy'&&!['PORTAL_S3_BUCKET','PORTAL_S3_REGION','PORTAL_S3_ACCOUNT_ID','PORTAL_S3_ACCESS_KEY_ID','PORTAL_S3_SECRET_ACCESS_KEY'].every(k=>process.env[k]))return '';
    return Object.prototype.hasOwnProperty.call(PARTIALS, key) ? PARTIALS[key] : '';
  });
}

/**
 * Asset-Versionierung gegen veraltete Browser-Caches.
 * Beim Start wird je Datei in assets/ eine Pruefsumme gebildet und beim
 * Ausliefern an die URL gehaengt (/assets/styles.css?v=ab12cd34). Aendert
 * sich eine Datei, aendert sich die URL - der Browser laedt sie zwingend neu.
 */
const ASSET_VERSIONS = (function () {
  const crypto = require('crypto');
  const out = {};
  const dir = path.join(ROOT, 'assets');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return out; }
  files.forEach((f) => {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      out['/assets/' + f] = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    } catch (e) { /* ignorieren */ }
  });
  return out;
})();

function versionAssets(html) {
  return html.replace(/(["'(])(\/assets\/[A-Za-z0-9._-]+)(["')])/g, (match, before, url, after) => {
    const v = ASSET_VERSIONS[url];
    return v ? before + url + '?v=' + v + after : match;
  });
}

function renderPage(file, context={}) {
  let html=fs.readFileSync(file,'utf8');
  if(path.basename(file)==='app-hilfe.html'){const role=context.workspace==='admin'?'admin':'partner';html=html.replace('{{helpContent}}',help.render(role)).replace('{{helpTitle}}','Hilfe · '+hosts.workspaces[role].title);}
  if(context.isApp)html=html.replace(/<!--#include:(?:(?:app|home)-)?header-->/g,'<!--#include:workspace-header-->').replace(/<!--#include:(?:(?:app|home)-)?footer-->/g,'<!--#include:workspace-footer-->').replace(/<body(?![^>]*class=)/,'<body class="connect-public"');
  if(context.isApp&&!['workspace-login.html','passwort.html','registrieren.html','app-hilfe.html','partner-start.html'].includes(path.basename(file))&&!html.includes('/assets/app-shell.css'))html=html.replace('</head>','<link rel="stylesheet" href="/assets/portal.css"><link rel="stylesheet" href="/assets/app-shell.css"></head>');
  if(context.isApp)html=html.replace('<meta name="theme-color" content="#11151c">','<meta name="theme-color" content="#ffffff">');
  html=applyPartials(html);
  if(!context.isApp&&html.includes('ux-header'))html=html.replace('</head>','<link rel="stylesheet" href="/assets/navigation.css"><script src="/assets/navigation.js" defer></script></head>');
  if(context.isApp){const w=context.workspace||'partner',title=hosts.workspaces[w].title;
    const labels={partner:['Willkommen zurück.','Melde dich an, um Fälle, Fotos und Unterlagen an UNFALLX zu übermitteln.'],admin:['Das interne Dashboard.','Geschützter Zugang für die Administration und das UNFALLX-Team.']};
    const identity=w==='admin'?{tagline:'Eingänge prüfen.<br><span>Gutachten erstellen.</span>',purpose:'Dein interner Arbeitsplatz für Schadenaufnahmen, Rückfragen und die gemeinsame Bearbeitung im UNFALLX-Team.',steps:['Eingänge & Unterlagen prüfen','Gutachten & Rückfragen bearbeiten','Status & Abrechnung verwalten'],access:'Zugang nur für eingeladene Teammitglieder'}:{tagline:'Deine Aufnahme.<br><span>Unser Gutachten.</span>',purpose:'Fotos und Unterlagen übermitteln, Rückfragen klären und den Bearbeitungsstand deiner Fälle im Blick behalten.',steps:['Schaden vor Ort aufnehmen','Fotos & Unterlagen an UNFALLX senden','Gutachten durch UNFALLX erstellen lassen'],access:'Dein geschützter Partnerzugang'};
    html=html.replaceAll('{{workspaceTagline}}',identity.tagline).replaceAll('{{workspacePurpose}}',identity.purpose).replaceAll('{{workspaceAccess}}',identity.access).replaceAll('{{workspaceSteps}}',identity.steps.map((text,index)=>'<li><span>0'+(index+1)+'</span>'+text+'</li>').join(''));
    html=html.replace('<body','<body data-workspace="'+w+'"').replaceAll('{{workspaceTitle}}',title).replaceAll('{{workspaceHeading}}',labels[w][0]).replaceAll('{{workspaceCopy}}',labels[w][1]).replaceAll('{{workspaceEnrollment}}',w==='admin'?'<p class="workspace-enrollment">Interne Zugänge werden durch UNFALLX eingeladen.</p>':'<p class="workspace-enrollment">Noch kein Partnerkonto?<a href="/registrieren">Als Partner registrieren →</a></p>');
    if(path.basename(file)!=='partner-start.html'&&!html.includes('/assets/workspace.css'))html=html.replace('</head>','<link rel="stylesheet" href="/assets/workspace.css"></head>');
  }
  if(context.isApp&&!html.includes('/assets/workspace-unified.css'))html=html.replace('</head>','<link rel="stylesheet" href="/assets/workspace-unified.css"></head>');
  return versionAssets(html);
}

/**
 * Inline-Skripte (z. B. der JSON-LD-Block für Suchmaschinen) werden beim Start
 * gehasht, damit die Content-Security-Policy ohne 'unsafe-inline' auskommt.
 * Neue Inline-Skripte werden dadurch automatisch berücksichtigt.
 */
function inlineScriptHashes() {
  const crypto = require('crypto');
  const hashes = new Set();
  let files = [];
  [''].forEach((dir) => {
    try {
      fs.readdirSync(path.join(ROOT, dir))
        .filter((f) => f.toLowerCase().endsWith('.html'))
        .forEach((f) => files.push(path.join(ROOT, dir, f)));
    } catch (e) { /* ignorieren */ }
  });

  files.forEach((file) => {
    let html = '';
    try { html = renderPage(file); } catch (e) { return; }
    const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const code = m[1];
      if (!code.trim()) continue;
      hashes.add("'sha256-" + crypto.createHash('sha256').update(code, 'utf8').digest('base64') + "'");
    }
  });
  return Array.from(hashes).join(' ');
}

const SCRIPT_HASHES = inlineScriptHashes();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  ...(process.env.NODE_ENV==='test'?{}:{'Strict-Transport-Security':'max-age=31536000'}),
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob: https://www.desag.de; media-src 'self'; style-src 'self'; frame-src https://www.google.com; " +
    ("script-src 'self' " + SCRIPT_HASHES).trim() + '; ' +
    "form-action 'self' mailto:; base-uri 'self'; frame-ancestors 'self'"
};

function cacheFor(ext, versioniert) {
  if (ext === '.html' || ext === '') return 'public, max-age=0, must-revalidate';
  if (versioniert) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function send(res, status, headers, body, isHead) {
  const responseHeaders = Object.assign({}, SECURITY_HEADERS, headers);
  // Some hosting proxies replace the CSP response header. Keep the resource
  // restrictions in the document as well, before any script or resource loads.
  // frame-ancestors is header-only; X-Frame-Options remains a separate header.
  if (/^text\/html\b/i.test(responseHeaders['Content-Type'] || '')) {
    const policy = SECURITY_HEADERS['Content-Security-Policy'].split(';')
      .map(value => value.trim()).filter(value => value && !/^frame-ancestors\b/i.test(value)).join('; ');
    const escaped = policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    body = Buffer.from(String(body).replace(/<head\b[^>]*>/i, match => match +
      '<meta http-equiv="Content-Security-Policy" content="' + escaped + '">'), 'utf8');
    responseHeaders['Content-Length'] = body.length;
  }
  res.writeHead(status, responseHeaders);
  if (isHead) return res.end();
  res.end(body);
}

function sendError(res, status, isHead, urlPath) {
  const file = status === 404 ? path.join(ROOT, '404.html') : null;
  if (file && fs.existsSync(file)) {
    const body = Buffer.from(renderPage(file), 'utf8');
    return send(res, status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }, body, isHead);
  }
  send(res, status, { 'Content-Type': 'text/plain; charset=utf-8' },
    status === 404 ? 'Nicht gefunden' : 'Fehler', isHead);
}

const server = http.createServer(async (req, res) => {
  const isHead = req.method === 'HEAD';
  let urlPath, hatVersion;
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    urlPath = decodeURIComponent(parsed.pathname);
    hatVersion = parsed.searchParams.has('v');
  } catch (e) {
    return sendError(res, 400, isHead);
  }
  // Reject private paths before host canonicalisation, otherwise app/public
  // redirects can bounce a source-file request between the two domains.
  if (/(^|\/)\.[^/]|\\|[\x00-\x1f]/.test(urlPath)) return sendError(res, 404, isHead, urlPath);
  if (urlPath.replace(/\/+$/, '') !== '/portal' && !urlPath.startsWith('/api/portal/') && BLOCKED.test(urlPath)) {
    return sendError(res, 404, isHead, urlPath);
  }
  let hostInfo;try{hostInfo=hosts.hostPolicy(req.headers.host,req.url);}catch{return sendError(res,400,isHead);}
  if(process.env.NODE_ENV==='test'&&process.env.PORTAL_PREVIEW_WORKSPACE&&!hostInfo.production){hostInfo={...hostInfo,isApp:true,workspace:process.env.PORTAL_PREVIEW_WORKSPACE};}
  if(hostInfo.retiredReport&&(!['GET','HEAD'].includes(req.method)||req.url.split('?')[0].startsWith('/api/')))return send(res,410,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},JSON.stringify({error:'Diese Gutachten-Adresse ist stillgelegt. Bitte nutzen Sie unfallx.com/ueber-uns für Informationen oder Ihren geschützten Arbeitsbereich für Falldaten.'}),isHead);
  if(hostInfo.retired&&(!['GET','HEAD'].includes(req.method)||req.url.split('?')[0].startsWith('/api/')))return send(res,410,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},JSON.stringify({error:'Die separate Aufnahme-App wurde eingestellt. Bitte im Partnerportal unter app.unfallx.com anmelden.',redirect:hosts.APP_ORIGIN+'/login'}),isHead);
  if(hostInfo.gone)return send(res,410,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'},'<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seite nicht mehr verfügbar | UNFALLX</title><link rel="stylesheet" href="/assets/workspace.css"></head><body class="workspace-login"><main class="workspace-login-main"><h1>Diese Seite ist nicht mehr verfügbar.</h1><p>Hier geht es zu UNFALLX und deinem Portalzugang.</p><a href="'+hostInfo.origin+'/">Zur Übersicht →</a></main></body></html>',isHead);
  if(hosts.educationApi(req.url.split('?')[0]))return send(res,410,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'},JSON.stringify({error:'Dieser Bereich ist nicht mehr verfügbar.'}),isHead);
  if(hostInfo.redirect)return send(res,308,{Location:hostInfo.redirect,'Cache-Control':'no-store'},'',isHead);
  const apiPath=req.url.split('?')[0];
  if(hostInfo.production&&!hostInfo.isApp&&apiPath.startsWith('/api/portal/'))return send(res,409,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},JSON.stringify({error:'Die App ist umgezogen. Bitte app.unfallx.com/login öffnen und dort anmelden.',redirect:hosts.APP_ORIGIN+'/login'}),isHead);
  if (req.url.split('?')[0].startsWith('/api/portal/')) return portal.handle(req, res, SECURITY_HEADERS);

  /* Anfrageformular: POST /api/anfrage (JSON) */
  if (req.method === 'POST') {
    let p = '';
    try { p = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch (e) {}
    if (p === '/api/anfrage') {
      return anfrage.handle(req, res, SECURITY_HEADERS, portal.submitContact);
    }
    return send(res, 404, { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ ok: false, error: 'Nicht gefunden' }), false);
  }

  if (req.method !== 'GET' && !isHead) {
    return send(res, 405, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Allow': 'GET, HEAD, POST'
    }, 'Methode nicht erlaubt', false);
  }

  /* Alte Sprachadressen behalten ihren Weg zum entsprechenden deutschen Inhalt. */
  if (/^\/ru(?:\/|$)/i.test(urlPath)) {
    const slug = urlPath.replace(/^\/ru\/?/i, '').replace(/\/$/, '').replace(/\.html$/i, '');
    const known = new Set(["wertminderung", "unfallgutachten", "wertgutachten", "kfz-gutachter-berlin", "nutzungsausfall", "kostenvoranschlag", "unfall-checkliste", "kfz-gutachter-brandenburg", "einsatzgebiete", "impressum", "mietwagen", "totalschaden", "kfz-gutachten", "datenschutz"]);
    if (!slug || slug === 'index') return send(res, 301, { Location: '/' }, '', isHead);
    if (known.has(slug)) return send(res, 301, { Location: '/' + slug }, '', isHead);
    return sendError(res, 404, isHead, urlPath);
  }

  if(hostInfo.production&&urlPath==='/sitemap.xml'){
    const paths=hostInfo.isApp?[]:['/','/ueber-uns'];
    const domain=hosts.PUBLIC_ORIGIN;
    return send(res,200,{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-cache'},'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+paths.map(p=>'<url><loc>'+domain+p+'</loc></url>').join('')+'</urlset>',isHead);
  }
  if(hostInfo.isApp&&urlPath==='/robots.txt')return send(res,200,{'Content-Type':'text/plain','Cache-Control':'no-store'},'User-agent: *\nDisallow: /\n',isHead);
  if(hostInfo.isApp&&['/app.webmanifest','/site.webmanifest'].includes(urlPath)){
    const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'app.webmanifest'),'utf8')),w=hostInfo.workspace||'partner';
    Object.assign(manifest,{id:'/',name:'UNFALLX '+hosts.workspaces[w].title,short_name:w==='admin'?'UX Team':'UX Partner',start_url:w==='partner'?'/portal':'/',scope:'/',description:'Dein geschützter UNFALLX Arbeitsbereich.'});
    return send(res,200,{'Content-Type':MIME['.webmanifest'],'Cache-Control':'no-cache'},JSON.stringify(manifest),isHead);
  }
  // Liveness does not imply provider readiness. No credentials or tenant data are public.
  if(urlPath==='/health'||urlPath==='/ready'){
    const ok=urlPath==='/health'||await portal.readiness();
    return send(res,ok?200:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},JSON.stringify({status:ok?'ok':'unavailable',check:urlPath==='/health'?'liveness':'database-readiness'}),isHead);
  }

  /* Nachgestellten Slash entfernen: /impressum/ -> /impressum */
  if (urlPath.length > 1 && urlPath.endsWith('/')) {
    const target = urlPath.replace(/\/+$/, '');
    return send(res, 301, { Location: target }, '', isHead);
  }

  /* Startseite auf die kanonische Adresse führen. */
  if (urlPath === '/index.html' || urlPath === '/index') return send(res, 301, { Location: '/' }, '', isHead);

  /* .html in der URL auf saubere Adresse umleiten */
  if (/\.html$/i.test(urlPath)) {
    return send(res, 301, { Location: urlPath.replace(/\.html$/i, '') }, '', isHead);
  }

  const relative = hostInfo.isApp&&urlPath==='/datenschutz'?'portal-datenschutz.html':
    hostInfo.workspace==='partner'&&urlPath==='/'?'partner-start.html':
    hostInfo.isApp&&['/','/login'].includes(urlPath)?'workspace-login.html':
    urlPath==='/'?'index.html':
    urlPath==='/login'?'workspace-login.html':
    ['/portal','/gutachter-portal'].includes(urlPath)?'partner-app.html':urlPath.replace(/^\/+/,'');
  const resolved = path.resolve(ROOT, relative);

  /* Verzeichnis-Traversal verhindern */
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Verboten', isHead);
  }

  /* Kandidaten: exakter Pfad, dann .html-Variante (saubere URLs) */
  const candidates = path.extname(resolved)
    ? [resolved]
    : [resolved, resolved + '.html', path.join(resolved, 'index.html')];

  const tryNext = (i) => {
    if (i >= candidates.length) return sendError(res, 404, isHead, urlPath);
    const file = candidates[i];
    fs.stat(file, async (err, stat) => {
      if (err || !stat.isFile()) return tryNext(i + 1);
      const ext = path.extname(file).toLowerCase();
      const publicAsset=file.startsWith(path.join(ROOT,'assets')+path.sep)&&['.css','.js','.svg','.png','.jpg','.jpeg','.webp','.avif','.ico','.woff2'].includes(ext);
      const publicRoot=path.dirname(file)===ROOT&&(ext==='.html'||['robots.txt','sitemap.xml','site.webmanifest','app.webmanifest','favicon.ico','apple-touch-icon.png'].includes(path.basename(file)));
      if(!publicAsset&&!publicRoot)return sendError(res,404,isHead,urlPath);

      if (ext === '.html') {
        let page;
        try { let html=renderPage(file,hostInfo);
          page = Buffer.from(hosts.links(html,hostInfo.isApp,hostInfo.production,hostInfo.isReport,hostInfo.workspace), 'utf8'); }
        catch (e) { return sendError(res, 500, isHead); }
        return send(res, 200, {
          'Content-Type': MIME[ext],
          'Content-Length': page.length,
          'Cache-Control': (hostInfo.isApp||hosts.appPath(urlPath))?'private, no-store, max-age=0':cacheFor(ext, false),
          ...((hostInfo.isApp||hosts.appPath(urlPath))?{'CDN-Cache-Control':'no-store','Vary':'Cookie','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}:{})
        }, page, isHead);
      }

      fs.readFile(file, (readErr, data) => {
        if (readErr) return sendError(res, 500, isHead);
        send(res, 200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': cacheFor(ext, hatVersion)
        }, data, isHead);
      });
    });
  };

  tryNext(0);
});

server.requestTimeout = 180000;
server.headersTimeout = 15000;
server.maxRequestsPerSocket = 100;
server.listen(PORT, HOST, () => {
  console.log(`UNFALLX Webseite laeuft auf http://${HOST}:${PORT}`);
});
