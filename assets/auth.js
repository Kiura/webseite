(() => {
'use strict';
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const status=$('#auth-message');let csrf='',busy=false;
function message(value,error=false){if(status){status.textContent=value;status.classList.toggle('portal-error',error);}}
async function api(path,data){const r=await fetch('/api/portal'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});const result=await r.json();if(!r.ok)throw new Error(result.error||'Bitte später erneut versuchen.');return result;}
function data(form){const values=Object.fromEntries(new FormData(form));form.querySelectorAll('input[type=checkbox]').forEach(i=>values[i.name]=i.checked);if(values.passwordConfirm!==undefined&&values.password!==values.passwordConfirm)throw new Error('Die beiden Passwörter stimmen nicht überein.');delete values.passwordConfirm;return values;}
function bind(selector,fn){const form=$(selector);if(form)form.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);message('');try{await fn(data(form),form);}catch(e){message(e.message,true);}finally{busy=false;buttons.forEach(b=>b.disabled=false);}});}
const passFields=`<label>Neues Passwort<input name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" required aria-describedby="password-hint"></label><small id="password-hint">15 bis 128 Zeichen. Ein langer Satz mit mehreren Wörtern eignet sich gut.</small><label>Passwort wiederholen<input name="passwordConfirm" type="password" minlength="15" maxlength="128" autocomplete="new-password" required></label>`;
function passwordControls(){
 document.querySelectorAll('form input[type=password]').forEach((input,index)=>{
  const label=input.closest('label');if(!label||input.closest('.auth-password-field'))return;
  input.id=input.id||'auth-password-'+index;label.htmlFor=input.id;
  const group=document.createElement('div');group.className='auth-password-group';label.before(group);group.append(label);
  const field=document.createElement('div');field.className='auth-password-field';group.append(field);field.append(input);
  const hint=label.querySelector('small');if(hint)group.append(hint);
  const button=document.createElement('button');button.type='button';button.className='password-toggle';
  const name=input.name==='passwordConfirm'?'Passwortwiederholung':'Passwort';
  button.setAttribute('aria-label',name+' anzeigen');button.setAttribute('aria-controls',input.id);button.setAttribute('aria-pressed','false');button.title=name+' anzeigen';
  button.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="auth-eye-slash" d="m3 3 18 18"/></svg>';
  button.addEventListener('click',()=>{const visible=input.type==='password';input.type=visible?'text':'password';button.setAttribute('aria-pressed',String(visible));button.setAttribute('aria-label',name+(visible?' verbergen':' anzeigen'));button.title=button.getAttribute('aria-label');});
  field.append(button);
 });
}
const ref=new URLSearchParams(location.search).get('ref');if(/^UX-[A-F0-9]{12}$/.test(ref||'')){document.querySelectorAll('input[name=referralCode]').forEach(i=>i.value=ref);document.querySelectorAll('a[data-referral-link]').forEach(a=>{const u=new URL(a.href);u.searchParams.set('ref',ref);a.href=u.href;});const refNote=$('[data-referral-note]'),refCode=$('[data-referral-code]');if(refNote&&refCode){refCode.textContent=ref;refNote.hidden=false;}const refPrimary=$('[data-referral-primary]'),refLabel=$('[data-referral-primary-label]');if(refPrimary&&refLabel){const u=new URL('/registrieren',location.origin);u.searchParams.set('ref',ref);refPrimary.href=u.href;refLabel.textContent='Als Partner registrieren';const intro=$('[data-referral-intro]');if(intro)intro.textContent='Du wurdest zu UNFALLX Connect eingeladen. Als Werkstatt, Abschleppdienst oder Fotopartner übermittelst du Schadenaufnahmen, Originalfotos und unterschriebene Dokumente direkt an unser Team. UNFALLX übernimmt die Gutachtenerstellung.';}}
async function enterPortal(){let m;try{m=await api('/me');}catch{throw new Error('Die Anmeldung konnte auf diesem Gerät nicht gespeichert werden. Bitte Cookies für diese Website erlauben und erneut anmelden.');}if(!['partner','admin','appraiser'].includes(m.user.role))throw new Error('Dieser Zugang ist nicht für UNFALLX Connect freigeschaltet. Bitte kontaktiere info@unfallx.com.');const home=m.user.role==='partner'?'/portal':'/gutachter-portal';const next=new URLSearchParams(location.search).get('next')||'';const fragment=/^\/(?:portal|gutachter-portal)#(?:fall\/[a-f0-9-]{36}|[a-z-]+)$/.test(next)?next.slice(next.indexOf('#')):'';location.replace(home+(fragment||'#start'));}
async function providers(){
 const box=$('[data-oauth-buttons]');if(!box)return;
 const section=$('[data-oauth-section]'),r=await api('/oauth/providers');
 const available=r.providers.filter(p=>p.enabled&&['0account','google','apple'].includes(p.id));
 box.innerHTML=available.map(p=>`<button class="oauth-button" type="button" data-oauth="${p.id}">${p.id==='google'?'<img src="/assets/google-g.png" alt="" width="20" height="20" aria-hidden="true">':''}${p.id==='0account'?'<img src="/assets/0account-logo.svg" alt="" width="20" height="20" aria-hidden="true">':''}<span>Mit ${esc(p.name)} anmelden</span></button>`).join('');
 if(section)section.hidden=!available.length;
 box.querySelectorAll('[data-oauth]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;try{const r=await api('/oauth/start',{provider:b.dataset.oauth});location.assign(r.redirect);}catch(e){message(e.message,true);b.disabled=false;}}));
}
async function showFactor(){
 const state=await api('/security/login');csrf=state.csrf;history.replaceState(null,'',location.pathname+'?factor=1');let challenge='';
 $('#auth-root').innerHTML='<h2>Zweiter Schritt. Sicher anmelden.</h2><p>Bestätige deine Anmeldung mit einem SMS-Code an '+esc(state.security.phone)+'. Dein Arbeitsplatz bleibt bis dahin geschützt.</p><button type="button" class="btn btn-block" id="factor-send" '+(state.security.available?'':'disabled')+'>SMS-Code anfordern</button><p id="factor-delivery" role="status">'+(state.security.available?'':'SMS ist vorübergehend nicht verfügbar. Nutze einen deiner Wiederherstellungscodes.')+'</p><form id="factor-code"><label>Sicherheitscode<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6 Ziffern"></label><button class="btn btn-block" type="submit">Anmeldung bestätigen</button></form><details class="factor-recovery"><summary>Kein Zugriff auf das Handy?</summary><p>Gib einen deiner acht einmalig verwendbaren Wiederherstellungscodes ein. Ein Passwort-Reset hebt die Zwei-Faktor-Anmeldung nicht auf.</p><form id="factor-recovery"><label>Wiederherstellungscode<input name="recoveryCode" autocomplete="off" maxlength="64" required></label><button class="btn btn-block" type="submit">Mit Wiederherstellungscode anmelden</button></form></details><a href="/login">Anmeldung neu starten</a>';
 $('#factor-send').addEventListener('click',async e=>{const b=e.currentTarget;b.disabled=true;try{const r=await api('/security/login/send',{});challenge=r.challenge;$('#factor-delivery').textContent=r.message;setTimeout(()=>b.disabled=false,r.retryAfter*1000);$('#factor-code input').focus();}catch(e){message(e.message,true);b.disabled=false;}});
 bind('#factor-code',async d=>{if(!challenge)throw new Error('Bitte zuerst einen SMS-Code anfordern.');await api('/security/login/verify',{...d,challenge});await enterPortal();});
 bind('#factor-recovery',async d=>{await api('/security/login/verify',d);await enterPortal();});
}
async function boot(){
 if(new URLSearchParams(location.search).get('factor')==='1'&&$('#auth-root')){await showFactor();return;}
 await providers().catch(()=>{});
 const login=$('#login-form');
 if(login){
  bind('#login-form',async d=>{const r=await api('/password-login',d);if(r.mfaRequired)return showFactor();await enterPortal();});
  bind('#magic-form',async d=>message((await api('/login',d)).message));
  const params=new URLSearchParams(location.hash.slice(1)),token=params.get('token');
  if(token){
   history.replaceState(null,'',location.pathname);
   const info=await api('/token-info',{token});
   $('#auth-root').innerHTML='<h2>E-Mail bestätigen.</h2><p>'+(info.passwordRequired?'Gib dein bei der Registrierung gewähltes Passwort ein. Danach ist dein Konto bestätigt.':'Bestätige die Anmeldung, um deinen geschützten Arbeitsplatz zu öffnen.')+'</p><form id="exchange-form">'+(info.passwordRequired?'<label>Dein Passwort<input type="password" name="password" autocomplete="current-password" required maxlength="128"></label>':'')+'<button class="btn btn-block" type="submit">Sicher anmelden</button></form><p class="partner-muted">Dieser persönliche Link ist einmalig nutzbar.</p>';
   bind('#exchange-form',async d=>{const r=await api('/exchange',{...d,token});if(r.mfaRequired)return showFactor();await enterPortal();});
  }else{
   try{const m=await api('/me');if(document.body.classList.contains('workspace-login')){await enterPortal();return;}const box=document.createElement('div');box.className='portal-alert';box.innerHTML='<strong>Du bist angemeldet.</strong><p>'+esc(m.user.name)+' · '+esc(m.user.role==='partner'?'Partner-Portal':'UNFALLX Dashboard')+'</p><button type="button" class="btn" id="continue-portal">Meinen Arbeitsplatz öffnen →</button>';login.before(box);box.querySelector('button').addEventListener('click',()=>enterPortal().catch(e=>message(e.message,true)));}catch{}
   const state=new URLSearchParams(location.search).get('oauth');
   if(state==='link_required')message('Zu dieser E-Mail besteht bereits ein Konto. Melde dich mit Passwort oder E-Mail-Link an und verbinde Google oder Apple unter Einstellungen.',true);
   if(state==='failed')message('Der Anbieter-Login konnte nicht abgeschlossen werden. Bitte neu starten oder mit deinem Passwort anmelden.',true);
  }
 }

 bind('#register-form',async(d,f)=>{message((await api('/register',d)).message);f.reset();});
 const password=$('#password-root');if(password){const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);if(token){password.innerHTML='<h2>Dein neues Passwort.</h2><form id="new-password-form">'+passFields+'<button class="btn" type="submit">Passwort speichern</button></form>';bind('#new-password-form',async d=>{const r=await api('/password/finish',{token,password:d.password});password.innerHTML='<h2>Passwort gespeichert.</h2><p>'+esc(r.message)+'</p><a href="/login" class="btn">Zum Login →</a>';});}else bind('#password-request',async d=>message((await api('/password/request',d)).message));}
 const notify=$('#notification-root');if(notify){const p=new URLSearchParams(location.hash.slice(1)),token=p.get('token')||p.get('unsubscribe');history.replaceState(null,'',location.pathname);if(token){notify.innerHTML='<h2>'+ (p.has('unsubscribe')?'Statusmeldungen abbestellen':'Statusmeldungen bestätigen')+'</h2><form id="notification-confirm"><button type="submit" class="btn">'+(p.has('unsubscribe')?'Für diesen Vorgang abbestellen':'E-Mail-Benachrichtigungen aktivieren')+'</button></form>';bind('#notification-confirm',async()=>{const r=await api('/notifications/verify',{token});notify.innerHTML='<h2>Erledigt.</h2><p>'+esc(r.message)+'</p>'+(r.trackingUrl?'<p><a class="btn" href="'+esc(r.trackingUrl)+'">Meinen Bearbeitungsstatus ansehen →</a></p>':'')+'<a href="/app">UNFALLX Connect kennenlernen →</a>';});}}
 const onboarding=$('#oauth-complete');if(onboarding){const profile=await api('/oauth/profile');csrf=profile.csrf;onboarding.querySelector('[name=email]').value=profile.email;onboarding.querySelector('[name=contact]').value=profile.name;
  // Vom Anbieter übernommene Angaben. Nur leere Felder werden gefüllt, damit
  // eine bereits getroffene Auswahl nicht überschrieben wird; alles bleibt
  // änderbar. Die Unternehmensart nur bei exakter Übereinstimmung mit einer
  // der angebotenen Optionen, sonst bliebe ein ungültiger Wert stehen.
  const fill=(name,value)=>{const field=onboarding.querySelector('[name='+name+']');if(!field||!value||field.value)return;if(field.tagName==='SELECT'&&![...field.options].some(o=>o.value===value))return;field.value=value;};
  fill('phone',profile.phone);
  const company=profile.company||{};
  fill('company',company.name);fill('street',company.street);fill('postcode',company.postcode);fill('city',company.city);fill('type',company.type);fill('referralCode',company.referralCode);
  // Beim Anbieter erteilte Zustimmungen werden angehakt, bleiben aber
  // abwählbar: abgeschickt wird nur, was hier bestätigt ist.
  const check=(name,value)=>{const field=onboarding.querySelector('[name='+name+']');if(field&&value)field.checked=true;};
  check('terms',company.terms);check('privacy',company.privacy);
  bind('#oauth-complete',async d=>{const r=await api('/oauth/complete',d);await enterPortal();});}
}
window.addEventListener('hashchange',()=>{const p=new URLSearchParams(location.hash.slice(1));if(/^[a-f0-9]{64}$/.test(p.get('token')||p.get('unsubscribe')||''))location.reload();});
boot().catch(e=>message(e.message,true)).finally(passwordControls);
})();
