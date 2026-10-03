(() => {
  'use strict';
  const form = document.getElementById('contact-form');
  if (!form) return;
  const started = Date.now();
  const message = document.getElementById('contact-message');

  /* Vorauswahl aus Links wie /?anliegen=wertgutachten#kontakt oder /?ort=Berlin%20Tegel#kontakt */
  const params = new URLSearchParams(location.search);
  const ANLIEGEN = { wertgutachten: 'Wertgutachten', kostenvoranschlag: 'Kostenvoranschlag', unfallgutachten: 'Unfallgutachten' };
  const anliegen = ANLIEGEN[params.get('anliegen')] || '';
  const ort = (params.get('ort') || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
  if (anliegen || ort) {
    if (form.elements.thema) form.elements.thema.value = 'Kfz-Gutachten';
    const text = form.elements.beschreibung;
    if (text && !text.value) {
      text.value = 'Ich interessiere mich für ' + (anliegen ? 'ein ' + anliegen : 'ein Kfz-Gutachten') +
        (ort ? ' in ' + ort : '') + '.\n\n';
    }
  }

  /* Alte Links mit #anfrage führen direkt zum Formular. */
  if (location.hash === '#anfrage') {
    const ziel = document.getElementById('kontakt');
    if (ziel) requestAnimationFrame(() => ziel.scrollIntoView());
  }

  const clearInvalid = () => form.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.reportValidity() || form.dataset.sending) return;
    const button = form.querySelector('[type=submit]');
    form.dataset.sending = 'true';
    button.disabled = true;
    clearInvalid();
    message.textContent = 'Deine Nachricht wird gesendet …';
    try {
      if (Date.now() - started < 3000) throw new Error('Bitte prüfe deine Nachricht kurz und sende sie dann erneut.');
      const d = Object.fromEntries(new FormData(form));
      const response = await fetch('/api/anfrage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...d,
          ort,
          beschreibung: d.thema + (anliegen ? ' – ' + anliegen : '') + '\n\n' + d.beschreibung,
          anliegen: 'sonstiges',
          kontaktweg: 'email',
          datenschutz: form.elements.datenschutz.checked,
          t0: started,
          sprache: 'de',
          fotos: []
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        const felder = result.felder || {};
        Object.keys(felder).forEach(name => {
          const el = form.elements[name];
          if (el && el.setAttribute) el.setAttribute('aria-invalid', 'true');
        });
        const first = Object.keys(felder).map(n => form.elements[n]).find(el => el && el.focus);
        if (first) first.focus();
        throw new Error(Object.values(felder).join(' ') || result.error || 'Bitte prüfe deine Angaben.');
      }
      if (result.delivery === 'stored' || result.warning || result.attachmentErrors) {
        message.textContent = 'Deine Anfrage wurde gespeichert. Der E-Mail-Versand ist derzeit verzögert. Für dringende Anliegen erreichst du uns unter 0176 64 365 185.';
      } else {
        message.textContent = 'Vielen Dank. Deine Nachricht wurde an UNFALLX übermittelt. Wir melden uns persönlich bei dir.';
        form.reset();
      }
    } catch (error) {
      message.textContent = error.message || 'Die Übermittlung war nicht möglich. Bitte erneut versuchen oder info@unfallx.com kontaktieren.';
    } finally {
      delete form.dataset.sending;
      button.disabled = false;
    }
  });
})();
