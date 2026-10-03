/* UNFALLX – kleine Helfer, ohne Framework */
(function () {
  'use strict';
  /* Alte Startseiten-Anker auf die Abschnitte von /ueber-uns umleiten (gleiche Zuordnung wie portal/hosts.js). */
  var ALTE_ANKER={gutachten:'leistungen',leistungen:'leistungen',vorteile:'arbeitsweise',ablauf:'begutachtung',halle:'halle',unfallservice:'unfallservice','ueber-uns':'unternehmen',vertrauen:'desag-zertifikat','desag-zertifikat':'desag-zertifikat',bewertungen:'bewertungen',einsatzgebiet:'einsatzgebiete',ratgeber:'ratgeber',faq:'gutachten-fragen',schadenbilder:'schadenbilder',standort:'standort'};
  if(['unfallx.com','www.unfallx.com'].includes(location.hostname)&&location.pathname==='/'&&Object.prototype.hasOwnProperty.call(ALTE_ANKER,location.hash.slice(1))){location.replace('/ueber-uns'+location.search+'#'+ALTE_ANKER[location.hash.slice(1)]);return;}


  /* Deutsche Oberflächentexte. */
  var T = {
    menuAuf: 'Menü öffnen', menuZu: 'Menü schließen',
    formatNicht: ' – Format nicht unterstützt', zuGross: ' – zu groß (max. 5 MB)',
    nurFotos: 'Bitte nur Fotos im Format JPG, PNG oder WebP hochladen.',
    fotoGross: 'Jedes Foto darf höchstens 5 MB groß sein.',
    fotoLesen: 'Ein Foto konnte nicht gelesen werden.',
    sendet: 'Ihre Anfrage wird übermittelt …',
    danke: 'Vielen Dank. Ihre Anfrage wurde erfolgreich übermittelt. Wir melden uns schnellstmöglich bei Ihnen.',
    felder: 'Bitte prüfen Sie die markierten Felder.',
    zuGrossAnfrage: 'Die Anfrage ist zu groß. Bitte kleinere Fotos verwenden.',
    zuViele: 'Zu viele Anfragen. Bitte versuchen Sie es in einigen Minuten erneut oder rufen Sie uns an.',
    nichtGesendet: 'Die Anfrage konnte gerade nicht übermittelt werden. Bitte rufen Sie uns an: 0176 64 365 185.',
    keinNetz: 'Keine Verbindung. Bitte prüfen Sie Ihr Netz oder rufen Sie uns an: 0176 64 365 185.'
  };

  /* Jahreszahl im Footer */
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });



  var sanft = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Lesefortschritt oben */
  var progress = document.querySelector('[data-progress]');
  if (progress && !sanft) {
    var ticking = false;
    var zeichne = function () {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var anteil = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
      progress.style.transform = 'scaleX(' + anteil + ')';
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(zeichne); }
    }, { passive: true });
    zeichne();
  }

  /* Abschnitte blenden beim Scrollen ein */
  var teile = document.querySelectorAll('.reveal');
  if (teile.length) {
    if (sanft || !('IntersectionObserver' in window)) {
      teile.forEach(function (el) { el.classList.add('is-visible'); });
    } else {
      var beobachter = new IntersectionObserver(function (eintraege) {
        eintraege.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-visible');
          beobachter.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

      /* Elemente einer Gruppe leicht versetzt einblenden */
      var gruppen = {};
      teile.forEach(function (el) {
        var key = el.getAttribute('data-group') || 'x';
        gruppen[key] = (gruppen[key] || 0);
        el.style.setProperty('--d', Math.min(gruppen[key] * 70, 350) + 'ms');
        gruppen[key]++;
        beobachter.observe(el);
      });
    }
  }

  /* Header bekommt beim Scrollen mehr Deckkraft */
  var header = document.querySelector('[data-header]');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* Mega-Menü */
  var megaTriggers = document.querySelectorAll('[data-mega-trigger]');
  if (megaTriggers.length) {
    var schliesseAlleMegas = function () {
      megaTriggers.forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    };
    megaTriggers.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var offen = btn.getAttribute('aria-expanded') === 'true';
        schliesseAlleMegas();
        btn.setAttribute('aria-expanded', String(!offen));
      });
    });
    document.querySelectorAll('.mega').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target.closest('a')) schliesseAlleMegas();
      });
    });
    document.addEventListener('click', schliesseAlleMegas);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') schliesseAlleMegas();
    });
  }

  /* Mobiles Menü (Glas-Overlay unter dem Header) */
  var toggle = document.querySelector('[data-nav-toggle]');
  var menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    var positioniereMenue = function () {
      if (!header) return;
      var unten = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
      menu.style.setProperty('--mm-top', unten + 'px');
    };
    var setzeMenue = function (offen) {
      if (offen) positioniereMenue();
      toggle.setAttribute('aria-expanded', String(offen));
      menu.setAttribute('data-open', String(offen));
      menu.setAttribute('aria-hidden', String(!offen));
      menu.inert = !offen;
      document.documentElement.classList.toggle('menu-open', offen);
      var label = toggle.querySelector('.sr-only');
      if (label) label.textContent = offen ? T.menuZu : T.menuAuf;
      if (offen) window.requestAnimationFrame(function () {
        var first = menu.querySelector('.mobile-menu-foot a[href]') || menu.querySelector('a[href], button');
        if (first) first.focus({ preventScroll: true });
      });
    };
    toggle.addEventListener('click', function () {
      setzeMenue(toggle.getAttribute('aria-expanded') !== 'true');
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setzeMenue(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.getAttribute('data-open') === 'true') { setzeMenue(false); toggle.focus(); }
      if (e.key === 'Tab' && menu.getAttribute('data-open') === 'true') {
        var focusable = [toggle].concat(Array.prototype.slice.call(menu.querySelectorAll('a[href], button:not([disabled]), summary')).filter(function (el) { return el.getClientRects().length > 0; }));
        var index = focusable.indexOf(document.activeElement);
        if (e.shiftKey && index <= 0) { e.preventDefault(); focusable[focusable.length - 1].focus(); }
        else if (!e.shiftKey && (index === focusable.length - 1 || index < 0)) { e.preventDefault(); toggle.focus(); }
      }
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1080 && menu.getAttribute('data-open') === 'true') setzeMenue(false);
      else if (menu.getAttribute('data-open') === 'true') positioniereMenue();
    });
  }

  /* Hero-Video: nur auf grossen Displays, ohne Datensparmodus und ohne reduzierte Bewegung */
  var heroVideo = document.querySelector('.hero-vid[data-src]');
  if (heroVideo) {
    var conn = navigator.connection || {};
    var gross = window.matchMedia('(min-width: 1024px)').matches;
    if (gross && !sanft && !conn.saveData) {
      heroVideo.src = heroVideo.getAttribute('data-src');
      var abspielen = heroVideo.play();
      var zeige = function () { heroVideo.classList.add('is-playing'); };
      heroVideo.addEventListener('playing', zeige, { once: true });
      if (abspielen && abspielen.catch) abspielen.catch(function () {});
    }
  }

  /* Aktiven Navigationspunkt markieren */
  var pfad = window.location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.nav-links a[href]').forEach(function (a) {
    var ziel = (a.getAttribute('href') || '').split('#')[0].replace(/\/$/, '') || '/';
    if (ziel !== '/' && ziel === pfad) a.classList.add('is-active');
  });

  /* Theme-Umschalter (Tag/Nacht) */
  document.documentElement.setAttribute("data-theme", "light");

  /* Anfrageformular: sendet die Angaben an /api/anfrage */
  var form = document.getElementById('schadenform');
  if (form) {
    var status = document.getElementById('form-status');
    var submit = form.querySelector('button[type="submit"]');
    var t0 = form.querySelector('[name="t0"]');
    if (t0) t0.value = String(Date.now());

    /* Kontaktfelder und ihre sichtbaren Hinweise folgen dem Kontaktweg. */
    var setzeKontaktpflicht = function () {
      var kontakt = form.querySelector('[name="kontaktweg"]:checked');
      var perEmail = kontakt && kontakt.value === 'email';
      ['telefon', 'email'].forEach(function (name) {
        var input = form.querySelector('[name="' + name + '"]');
        if (!input) return;
        input.required = name === 'email' ? !!perEmail : !perEmail;
        var hint = form.querySelector('label[for="' + input.id + '"] span');
        if (hint) {
          hint.className = input.required ? 'req' : 'opt';
          hint.textContent = input.required ? '*' : '(optional)';
          if (input.required) hint.setAttribute('aria-hidden', 'true');
          else hint.removeAttribute('aria-hidden');
        }
        var feld = input.closest('.field');
        if (feld) {
          feld.classList.remove('has-error');
          var error = feld.querySelector('.field-error');
          if (error) error.remove();
        }
        input.removeAttribute('aria-invalid');
      });
    };
    form.querySelectorAll('[name="kontaktweg"]').forEach(function (input) {
      input.addEventListener('change', setzeKontaktpflicht);
    });
    setzeKontaktpflicht();
    window.addEventListener('pageshow', setzeKontaktpflicht);

    /* Leistungslinks uebergeben eine explizite, erlaubte Vorauswahl. */
    var anliegen = form.querySelector('[name="anliegen"]');
    var vorauswahl = new URLSearchParams(window.location.search).get('anliegen');
    var ortVorauswahl = new URLSearchParams(window.location.search).get('ort');
    var ortFeld = form.querySelector('[name="ort"]');
    if (ortVorauswahl && ortFeld) ortFeld.value = ortVorauswahl.replace(/[\x00-\x1F]/g, '').slice(0, 120);
    if (anliegen && ['unfallgutachten', 'wertgutachten', 'kostenvoranschlag', 'sonstiges'].indexOf(vorauswahl) !== -1) {
      anliegen.value = vorauswahl;
    }

    var setzeStatus = function (text, art) {
      if (!status) return;
      status.textContent = text;
      status.className = 'form-note field-full' + (art ? ' is-' + art : '');
    };
    var markiere = function (felder) {
      form.querySelectorAll('.field.has-error').forEach(function (f) { f.classList.remove('has-error'); });
      form.querySelectorAll('.field-error').forEach(function (e) { e.remove(); });
      var erstes = null;
      Object.keys(felder || {}).forEach(function (name) {
        var input = form.querySelector('[name="' + name + '"]');
        var feld = input && input.closest('.field');
        if (!feld) return;
        feld.classList.add('has-error');
        var hint = document.createElement('span');
        hint.className = 'field-error';
        hint.setAttribute('role', 'alert');
        hint.textContent = felder[name];
        feld.appendChild(hint);
        input.setAttribute('aria-invalid', 'true');
        if (!erstes) erstes = input;
      });
      if (erstes) erstes.focus();
    };
    form.addEventListener('input', function (e) {
      var feld = e.target.closest && e.target.closest('.field.has-error');
      if (feld) {
        feld.classList.remove('has-error');
        var err = feld.querySelector('.field-error');
        if (err) err.remove();
        e.target.removeAttribute('aria-invalid');
      }
    });

    /* Fotos als Base64 einlesen (nur JPG/PNG/WebP, max. 3 Stueck, je 5 MB) */
    var fotoInput = form.querySelector('input[type="file"]');
    var fotoListe = form.querySelector('[data-foto-liste]');
    var erlaubt = ['image/jpeg', 'image/png', 'image/webp'];
    var zeigeFotos = function () {
      if (!fotoListe || !fotoInput) return;
      fotoListe.textContent = '';
      Array.prototype.slice.call(fotoInput.files || []).slice(0, 3).forEach(function (f) {
        var li = document.createElement('li');
        li.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
        if (erlaubt.indexOf(f.type) < 0) { li.textContent += T.formatNicht; li.className = 'is-error'; }
        else if (f.size > 5 * 1024 * 1024) { li.textContent += T.zuGross; li.className = 'is-error'; }
        fotoListe.appendChild(li);
      });
    };
    if (fotoInput) fotoInput.addEventListener('change', zeigeFotos);

    var leseFotos = function () {
      if (!fotoInput || !fotoInput.files || !fotoInput.files.length) return Promise.resolve([]);
      var dateien = Array.prototype.slice.call(fotoInput.files).slice(0, 3);
      return Promise.all(dateien.map(function (f) {
        return new Promise(function (resolve, reject) {
          if (erlaubt.indexOf(f.type) < 0) return reject(new Error(T.nurFotos));
          if (f.size > 5 * 1024 * 1024) return reject(new Error(T.fotoGross));
          var r = new FileReader();
          r.onload = function () {
            var data = String(r.result || '');
            resolve({ name: f.name, type: f.type, data: data.slice(data.indexOf(',') + 1) });
          };
          r.onerror = function () { reject(new Error(T.fotoLesen)); };
          r.readAsDataURL(f);
        });
      }));
    };

    var sammle = function () {
      var fd = new FormData(form);
      var get = function (k) { return (fd.get(k) || '').toString(); };
      return {
        name: get('name'), telefon: get('telefon'), email: get('email'),
        ort: get('ort'), datum: get('datum'), fahrzeug: get('fahrzeug'),
        beschreibung: get('beschreibung'), anliegen: get('anliegen'),
        kontaktweg: get('kontaktweg') || 'telefon',
        datenschutz: !!form.querySelector('[name="datenschutz"]:checked'),
        website: get('website'), t0: get('t0'),
        sprache: 'de'
      };
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.getAttribute('data-sending') === 'true') return;
      form.setAttribute('data-sending', 'true');
      if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
      setzeStatus(T.sendet, 'pending');

      var daten = sammle();
      leseFotos().then(function (fotos) {
        daten.fotos = fotos;
        return fetch('/api/anfrage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(daten)
        });
      }).then(function (res) {
        return res.json().then(function (json) { return { status: res.status, json: json }; });
      }).then(function (r) {
        if (r.json && r.json.delivery === 'stored') {
          setzeStatus(r.json.error, 'error');
          var warning = form.parentNode.querySelector('[data-delivery-warning]');
          if (warning) {
            warning.hidden = false;
            var direct = warning.querySelector('[data-mail-fallback]');
            if (direct) direct.href = 'mailto:info@unfallx.com?subject=' + encodeURIComponent('Anfrage über UNFALLX – ' + daten.name) + '&body=' + encodeURIComponent('Name: ' + daten.name + '\nTelefon: ' + daten.telefon + '\nE-Mail: ' + daten.email + '\nOrt: ' + daten.ort + '\nAnliegen: ' + daten.anliegen + '\n\n' + daten.beschreibung);
            warning.setAttribute('tabindex', '-1'); warning.focus();
          }
          return;
        }
        if (r.json && r.json.ok) {
          var priorWarning = form.parentNode.querySelector('[data-delivery-warning]');
          if (priorWarning) priorWarning.hidden = true;
          form.reset();
          setzeKontaktpflicht();
          if (fotoListe) fotoListe.textContent = '';
          var erfolg = form.parentNode.querySelector('[data-form-success]');
          if (erfolg) {
            form.hidden = true;
            erfolg.hidden = false;
            erfolg.setAttribute('tabindex', '-1');
            erfolg.focus();
          } else {
            setzeStatus(T.danke, 'success');
          }
          return;
        }
        if (r.status === 422 && r.json && r.json.felder) {
          markiere(r.json.felder);
          setzeStatus(T.felder, 'error');
          return;
        }
        setzeStatus((r.json && r.json.error) || T.nichtGesendet, 'error');
      }).catch(function (err) {
        setzeStatus((err && err.message) || T.keinNetz, 'error');
      }).then(function () {
        form.removeAttribute('data-sending');
        if (submit) { submit.disabled = false; submit.removeAttribute('aria-busy'); }
        if (t0) t0.value = String(Date.now());
      });
    });
  }
})();
