'use strict';
const APP_ORIGIN='https://app.unfallx.com',ADMIN_ORIGIN='https://admin.unfallx.com',MOBILE_ORIGIN='https://mobile.unfallx.com',PUBLIC_ORIGIN='https://unfallx.com',REPORT_ORIGIN='https://gutachten.unfallx.com';
const workspaces={partner:{origin:APP_ORIGIN,title:'Partner-Portal',roles:['partner']},admin:{origin:ADMIN_ORIGIN,title:'UNFALLX Dashboard',roles:['admin','appraiser']}};
const isRetiredHost=host=>String(host||'').toLowerCase().split(':')[0]==='mobile.unfallx.com';
const workspaceForHost=host=>Object.keys(workspaces).find(k=>new URL(workspaces[k].origin).hostname===String(host||'').toLowerCase().split(':')[0])||null;
const appPages=new Set(['/empfehlungsbedingungen','/app','/app-demo','/app-hilfe','/portal-datenschutz','/login','/portal','/partner-app','/gutachter-portal','/mobile','/kundenportal','/registrieren','/mitglied-werden','/schaden-melden','/passwort','/konto-vervollstaendigen','/benachrichtigungen','/status','/kundenaufnahme','/kanzleipartner','/empfehlen']);
const reportPages=new Set(['/unfallgutachten','/wertgutachten','/kostenvoranschlag','/kfz-gutachten','/kfz-gutachter-berlin','/kfz-gutachter-brandenburg','/einsatzgebiete','/unfall-checkliste','/wertminderung','/nutzungsausfall','/mietwagen','/totalschaden']);
const reportAnchors=new Set(['gutachten','anfrage','leistungen','vorteile','ablauf','halle','unfallservice','ueber-uns','vertrauen','desag-zertifikat','bewertungen','einsatzgebiet','ratgeber','faq','schadenbilder','standort']);
const reportTarget=(p,search='')=>PUBLIC_ORIGIN+'/ueber-uns'+search+(reportPath(p)?'#'+clean(p).slice(1):'');
const reportAnchorTargets={gutachten:'leistungen',anfrage:'kontakt',leistungen:'leistungen',vorteile:'arbeitsweise',ablauf:'begutachtung',halle:'halle',unfallservice:'unfallservice','ueber-uns':'unternehmen',vertrauen:'desag-zertifikat','desag-zertifikat':'desag-zertifikat',bewertungen:'bewertungen',einsatzgebiet:'einsatzgebiete',ratgeber:'ratgeber',faq:'gutachten-fragen',schadenbilder:'schadenbilder',standort:'standort'};
const sharedPages=new Set(['/impressum','/datenschutz','/agb']);
const clean=p=>p.replace(/\.html$/i,'').replace(/\/$/,'');
const appPath=p=>appPages.has(clean(p)),reportPath=p=>reportPages.has(clean(p));
const assetPath=p=>/^\/(?:api\/|assets\/|health$|ready$|(?:app|site)\.webmanifest$|apple-touch-icon(?:-precomposed)?\.png$|favicon\.ico$|robots\.txt$|sitemap\.xml$)/.test(p);
const educationPages=new Set(['/bildung','/bildung-foerderung','/kfz-gutachter-werden','/schadenfotos-lernen','/gutachten-aufbau']);
const educationPath=p=>educationPages.has(clean(p).toLowerCase())||/^\/bildung\//i.test(p);
const educationApi=p=>/^\/api\/portal\/(?:admin\/)?academy(?:\/|$)/i.test(p);
function hostPolicy(host,url){
 const u=new URL(url,PUBLIC_ORIGIN),name=String(host||'').toLowerCase().split(':')[0],workspace=workspaceForHost(host);
 if(educationPath(u.pathname))return {gone:true,production:true,origin:workspaces[workspace]?.origin||PUBLIC_ORIGIN};
 if(isRetiredHost(host)){const p=clean(u.pathname),target=['','/app'].includes(p)?'/':['/mobile','/mobile-app','/partner-app'].includes(p)?'/portal':p==='/app-demo'?'/portal':p==='/mitglied-werden'?'/registrieren':u.pathname;return {retired:true,production:true,redirect:APP_ORIGIN+target+u.search};}
 if(name==='gutachten.unfallx.com'){
  const p=clean(u.pathname),old=reportAnchorTargets[u.hash.slice(1)];
  const target=reportPath(p)?reportTarget(p,u.search):!p||['/index','/gutachten-start'].includes(p)?PUBLIC_ORIGIN+'/ueber-uns'+u.search+(old?'#'+old:''):appPath(p)||['/mobile-app','/partner-start'].includes(p)?hostPolicy('unfallx.com',u.pathname+u.search).redirect:PUBLIC_ORIGIN+u.pathname+u.search;
  return {retiredReport:true,production:true,redirect:target||PUBLIC_ORIGIN+'/ueber-uns'};
 }
 const isApp=!!workspace,isReport=false,isPublic=['unfallx.com','www.unfallx.com'].includes(name),production=isApp||isReport||isPublic;
 const p=clean(u.pathname),own=workspaces[workspace]?.origin;
 if(p==='/workspace-login')return {redirect:(production?(own||APP_ORIGIN):'')+'/login'+u.search};
 if(['/mobile','/mobile-app'].includes(p))return {redirect:(production?APP_ORIGIN:'')+'/portal'+u.search};
 if(p==='/app-demo')return {redirect:production?PUBLIC_ORIGIN+'/#app':'/#app'};
 if(p==='/mitglied-werden')return {redirect:(production?(workspace==='admin'?ADMIN_ORIGIN:APP_ORIGIN):'')+(workspace==='admin'?'/login':'/registrieren')+u.search};
 if(['/kundenportal','/schaden-melden'].includes(p))return {redirect:(production?APP_ORIGIN:'')+(p==='/kundenportal'?'/login':'/mitglied-werden')+u.search};
 if(reportPath(p)||p==='/gutachten-start')return {redirect:production?reportTarget(p,u.search):'/ueber-uns'+u.search+(reportPath(p)?'#'+p.slice(1):'')};
 if(!production)return {isApp:false,isReport:false,production:false,workspace:null};
 const info={isApp,isReport,production,workspace,origin:own||PUBLIC_ORIGIN};
 if(p==='/partner-start')return {redirect:APP_ORIGIN+'/'+u.search};
 if(p==='/gutachter-portal'&&workspace!=='admin')return {redirect:ADMIN_ORIGIN+u.pathname+u.search};
 if(workspace==='admin'&&['/registrieren','/mitglied-werden','/konto-vervollstaendigen','/app-demo','/empfehlen','/kanzleipartner'].includes(p))return {redirect:ADMIN_ORIGIN+'/login'};
 if(appPath(p)&&!isApp)return {redirect:APP_ORIGIN+(p==='/app'?'/':u.pathname)+u.search};
 if(isApp&&p==='/app')return {redirect:own+'/'+u.search};
 if(isApp&&new URLSearchParams(u.search).get('bereich')==='team'&&p==='/login')return {redirect:ADMIN_ORIGIN+'/login'};
 if(name==='www.unfallx.com')return {redirect:PUBLIC_ORIGIN+u.pathname+u.search};
 if(isApp&&p&&!assetPath(u.pathname)&&!sharedPages.has(p)&&!appPath(p))return {redirect:PUBLIC_ORIGIN+u.pathname+u.search};
 return info;
}
function links(html,isApp,production,isReport=false,workspace='partner'){
 if(!production)return html;
 const origin=isApp?(workspaces[workspace]?.origin||APP_ORIGIN):PUBLIC_ORIGIN;
 let out=html.replace(/href="((?:https:\/\/(?:(?:app|admin|mobile|gutachten)\.)?unfallx\.com)?\/(?!\/)[^"]*)"/g,(m,value)=>{
  const u=new URL(value,PUBLIC_ORIGIN),p=clean(u.pathname),suffix=u.search+u.hash;
  if(u.hostname==='gutachten.unfallx.com'){const retired=hostPolicy(u.host,u.pathname+u.search+u.hash);return 'href="'+retired.redirect+(u.hash&&!retired.redirect.includes('#')?u.hash:'')+'"';}
  if(isRetiredHost(u.host)){const retired=hostPolicy(u.host,u.pathname+u.search);return 'href="'+retired.redirect+u.hash+'"';}
  if(p==='/app-demo')return 'href="'+PUBLIC_ORIGIN+'/#app"';
  if(p==='/mitglied-werden')return 'href="'+APP_ORIGIN+'/registrieren'+suffix+'"';
  if(assetPath(u.pathname))return m;
  // Explicit cross-domain destinations must survive page-context rewriting.
  if(/^https:\/\//.test(value)&&(!p||sharedPages.has(p)))return m;
  if(p==='/gutachter-portal'||p==='/login'&&u.searchParams.get('bereich')==='team')return 'href="'+ADMIN_ORIGIN+(p==='/login'?'/login':u.pathname)+u.hash+'"';
  if(['/mobile','/mobile-app'].includes(p))return 'href="'+APP_ORIGIN+'/portal'+suffix+'"';
  if(appPath(p)){const explicit=workspaceForHost(u.host);return 'href="'+(explicit?workspaces[explicit].origin:isApp?origin:APP_ORIGIN)+(p==='/app'?'/':u.pathname)+suffix+'"';}
  if(reportPath(p))return 'href="'+reportTarget(p,u.search)+'"';
  if(!p&&reportAnchors.has(u.hash.slice(1))&&!isApp)return 'href="'+PUBLIC_ORIGIN+'/ueber-uns'+u.search+'#'+reportAnchorTargets[u.hash.slice(1)]+'"';
  if(!p||sharedPages.has(p))return 'href="'+origin+u.pathname+suffix+'"';
  return 'href="'+PUBLIC_ORIGIN+u.pathname+suffix+'"';
 });
 out=out.replace(/(<(?:link rel="canonical" href|meta property="og:url" content)=")https:\/\/unfallx\.com([^" ]*)/g,(_,a,p)=>a+origin+(isApp&&p==='/app'?'/':p));
 return out;
}
module.exports={APP_ORIGIN,ADMIN_ORIGIN,MOBILE_ORIGIN,PUBLIC_ORIGIN,REPORT_ORIGIN,workspaces,educationPath,educationApi,isRetiredHost,workspaceForHost,appPath,reportPath,reportTarget,hostPolicy,links};
