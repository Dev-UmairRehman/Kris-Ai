'use strict';

/* ---------------------------------------------------------------------------
   MasterPlan Digital - the page.

   Boot: ask the store page who is signed in (same handshake as Kris AI
   Memory, with its own message names), exchange that for a MasterPlan
   session, then show the three tabs.

   The session token lives only in this script's memory and goes out as a
   Bearer header - the iframe is cross-site, so cookies cannot be relied on.

   The viewer renders each PDF page onto a canvas with PDF.js. There is no
   download button, no text layer to copy from and no file URL: the bytes are
   fetched with the token and drawn. That stops casual saving; it cannot stop a
   screenshot, and nothing on the web can.
   --------------------------------------------------------------------------- */

(function () {
  var BOOT = window.MP_BOOT || {};
  /* Two homes for this script:
       embed  inside the iframe served by the app (views/app.html)
       page   pasted straight into the Uscreen page (uscreen/masterplan-page.html):
              the API is on another origin, and the member is read from the
              store's own /account page, which this page can see. */
  var PAGE = BOOT.mode === 'page';
  var BASE = (BOOT.apiOrigin || '') + '/masterplan';
  /* The page opened outside the store (a saved file, an editor preview):
     show the tool, but there is no member and no server to talk to. */
  var PREVIEW = PAGE && !/(^|\.)strategytraining\.com$/i.test(location.hostname) && !BOOT.localApi;
  if (PAGE && !BOOT.openReport) {
    try { BOOT.openReport = new URLSearchParams(location.search).get('report') || ''; } catch (e) { /* old browser */ }
  }
  var IDENTITY_WAIT_MS = 4000;
  var POLL_MS = 8000;

  var $ = function (id) { return document.getElementById(id); };
  var root = $('mp');
  /* On the Uscreen page the title is already on the page around the app. */
  if (BOOT.bare) root.classList.add('is-bare');
  var token = null;
  var email = '';
  var state = { mine: [], sharing: false, library: [] };
  var pollTimer = null;

  /* ---- api ---------------------------------------------------------------- */

  function api(method, path, body) {
    if (PREVIEW) {
      return Promise.resolve({
        ok: false,
        status: 0,
        data: { error: 'This is a preview. Publish this page on StrategyTraining.com to create a MasterPlan.' },
      });
    }
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(BASE + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      /* Our API never redirects. A redirect means the request did not reach
         the MasterPlan service (not deployed, or a proxy page), and following
         it would land on the store's join page. */
      redirect: 'manual',
    }).then(function (res) {
      var json = /json/i.test(res.headers.get('content-type') || '');
      return (json ? res.json() : Promise.reject(new Error('not json'))).catch(function () {
        /* Not an answer from the MasterPlan service. */
        return { error: 'The MasterPlan service is not reachable right now. Please try again in a few minutes.', reason: 'service_down' };
      }).then(function (data) {
        if (res.status === 401 && data.reason === 'no_session') showGate('expired');
        return { ok: res.ok && data.reason !== 'service_down', status: res.status, data: data };
      });
    }, function () {
      return {
        ok: false,
        status: 0,
        data: { error: 'The MasterPlan service is not reachable right now. Please try again in a few minutes.', reason: 'service_down' },
      };
    });
  }

  /* ---- identity handshake ------------------------------------------------- */

  var embedded = window.parent !== window;
  var parents = BOOT.allowedParentOrigins || [];

  function toParent(msg) {
    if (!embedded) return;
    parents.forEach(function (origin) {
      try { window.parent.postMessage(msg, origin); } catch (e) { /* not this one */ }
    });
  }

  /* Page mode: ask the store directly. GET /account with no Accept header
     answers 401 when signed out, 200 (the account page, carrying the email)
     when signed in, and 406 also means signed in. */
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  function probeAccount() {
    return fetch('/account', { credentials: 'same-origin' }).then(function (res) {
      var path = '';
      try { path = new URL(res.url, location.href).pathname; } catch (e) { /* ignore */ }
      if (/\/(sign_in|login|join)\b/.test(path)) return { signedIn: false, via: '/account -> ' + path };
      if (res.status === 401 || res.status === 403) return { signedIn: false, via: '/account ' + res.status };
      if (res.status === 406) return { signedIn: true, email: emailOnPage(), via: '/account 406' };
      if (!res.ok) return null;
      return res.text().then(function (t) {
        return { signedIn: true, email: emailFromAccount(t), via: '/account 200' };
      });
    }).catch(function () { return null; });
  }

  /* Same probe as the live Kris AI loader. A failed probe is tried once more
     before anyone is called signed out. */
  function identityFromStore() {
    return probeAccount().then(function (r) {
      if (r) return r;
      return new Promise(function (ok) { setTimeout(ok, 1500); }).then(probeAccount);
    }).then(function (r) {
      r = r || { signedIn: false, via: 'probe failed twice', transient: true };
      try { console.log('[st-mp] signedIn=' + r.signedIn + ' email=' + (r.email ? 'yes' : 'none') + ' via ' + r.via); } catch (e) { /* no console */ }
      return r;
    });
  }
  /* Picking the member's email must never guess: two members given the same
     guessed address would share one MasterPlan account.
       1. the value of the account form's email field;
       2. otherwise the email-like strings on the account page, minus asset
          names (logo@2x.png) and the store's own addresses - used only if
          exactly one is left, or one of them is also shown in this page's
          profile menu;
       3. otherwise nothing, and the member is asked to try again. */
  var NOT_MEMBER = /@(strategytraining|firmsconsulting|uscreen|michael)\b|\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;
  function candidates(text) {
    var all = String(text || '').match(new RegExp(EMAIL_RE.source, 'g')) || [];
    var seen = {};
    return all.filter(function (e) {
      e = e.toLowerCase();
      if (NOT_MEMBER.test(e) || seen[e]) return false;
      seen[e] = true;
      return true;
    });
  }
  function emailFromAccount(html) {
    var field = html.match(/<input[^>]*(?:type="email"|(?:name|id)="[^"]*email[^"]*")[^>]*>/i);
    var value = field && field[0].match(/value="([^"]*)"/i);
    if (value && candidates(value[1]).length === 1) return value[1].trim();
    var list = candidates(html);
    if (list.length === 1) return list[0];
    var onPage = candidates(document.body ? document.body.textContent : '').map(function (e) { return e.toLowerCase(); });
    var both = list.filter(function (e) { return onPage.indexOf(e.toLowerCase()) !== -1; });
    return both.length === 1 ? both[0] : '';
  }
  function emailOnPage() {
    var list = candidates(document.body ? document.body.textContent : '');
    return list.length === 1 ? list[0] : '';
  }

  function requestIdentity() {
    if (PAGE) return identityFromStore();
    if (!embedded) return Promise.resolve({});
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve(v || {});
      }
      function onMsg(e) {
        if (parents.indexOf(e.origin) === -1) return;
        var d = e.data;
        if (!d || d.type !== 'st-mp:identity') return;
        done({ signedIn: d.signedIn === true, email: typeof d.email === 'string' ? d.email : '' });
      }
      window.addEventListener('message', onMsg);
      toParent({ type: 'mp:ready' });
      setTimeout(function () { done({}); }, IDENTITY_WAIT_MS);
    });
  }

  var attempts = 0;
  var lastIdentity = {};
  function startSession(identity) {
    attempts++;
    lastIdentity = identity || {};
    var claim = {};
    for (var k in identity) claim[k] = identity[k];
    claim.deviceKey = deviceKey();
    return api('POST', '/api/session', claim).then(function (r) {
      if (r.ok && r.data.ok) {
        token = r.data.token;
        email = r.data.email || '';
        if (r.data.scope === 'link') showLink();
        else openApp();
      } else {
        showGate((r.data && r.data.reason) || 'service_down');
      }
    }).catch(function () { showGate('service_down'); });
  }

  /* A store page that answers late still gets the member in. */
  window.addEventListener('message', function (e) {
    if (parents.indexOf(e.origin) === -1) return;
    var d = e.data;
    if (!d || d.type !== 'st-mp:identity' || d.signedIn !== true) return;
    if (token || attempts >= 3 || $('mp-gate').hidden) return;
    startSession({ signedIn: true, email: d.email || '' });
  });

  /* ---- this browser's device key --------------------------------------------
     A random secret made once per browser and kept in its storage. The server
     only ever sees it in requests from this page; it is what proves that a
     MasterPlan account is this member's, so knowing someone's email is never
     enough to read their documents. */
  var DEVICE_STORE = 'mp_device_v1';
  var memoryKey = null;
  function newKey() {
    var bytes = new Uint8Array(32);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function deviceKey() {
    try {
      var k = window.localStorage.getItem(DEVICE_STORE);
      if (k && /^[A-Za-z0-9_-]{32,128}$/.test(k)) return k;
      k = newKey();
      window.localStorage.setItem(DEVICE_STORE, k);
      return k;
    } catch (e) {
      /* Storage blocked (private window): this visit only. */
      if (!memoryKey) memoryKey = newKey();
      return memoryKey;
    }
  }

  function showLink() {
    root.classList.remove('is-booting');
    $('mp-app').hidden = true;
    $('mp-gate').hidden = true;
    $('mp-link').hidden = false;
    showError('link-err', '');
    $('link-code').focus();
  }

  $('link-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('link-code').value.trim();
    if (!/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code)) return showError('link-err', 'Enter the 8-character code, like ABCD-1234.');
    var btn = $('link-go');
    btn.disabled = true;
    api('POST', '/api/devices/link', { code: code }).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.data.ok) return showError('link-err', (r.data && r.data.error) || 'That did not work. Please try again.');
      token = r.data.token;
      $('mp-link').hidden = true;
      openApp();
    });
  });

  function showGate(reason) {
    root.classList.remove('is-booting');
    $('mp-app').hidden = true;
    $('mp-link').hidden = true;
    $('mp-gate').hidden = false;
    $('mp-signin').href = BOOT.signInUrl || '#';
    $('mp-join').href = BOOT.joinUrl || '#';

    /* "Sign in" only for someone who really is signed out. A signed-in member
       whose session failed for another reason is told what happened, and
       gets a Try again button instead of a sign-in prompt. */
    var signedOut = reason === 'no_identity_from_store' && !lastIdentity.signedIn;
    var text;
    if (signedOut || reason === 'signed_out') text = 'Sign in to your StrategyTraining account to use the MasterPlan.';
    else if (reason === 'not_subscribed' || reason === 'customer_not_found') text = 'The MasterPlan is part of a StrategyTraining membership.';
    else if (reason === 'not_configured') text = 'The MasterPlan is being set up. Please check back soon.';
    else if (reason === 'no_email') text = 'You are signed in, but we could not read the email on your account. Open your account menu once, then press Try again.';
    else if (reason === 'expired') text = 'Your session has expired. Press Try again to continue.';
    else if (reason === 'service_down') text = 'The MasterPlan service is not reachable right now. Please try again in a few minutes.';
    else text = 'We could not open the MasterPlan just now. Please try again in a moment.';
    $('mp-gate-text').textContent = text;

    var offerSignIn = signedOut || reason === 'signed_out' || reason === 'not_subscribed' || reason === 'customer_not_found';
    $('mp-signin').hidden = !offerSignIn || reason === 'not_subscribed' || reason === 'customer_not_found';
    $('mp-join').hidden = !offerSignIn;
    $('mp-retry').hidden = offerSignIn;
  }

  $('mp-retry').addEventListener('click', function () {
    $('mp-gate').hidden = true;
    root.classList.add('is-booting');
    attempts = 0;
    token = null;
    (PAGE ? identityFromStore() : requestIdentity()).then(startSession);
  });

  /* ---- app ------------------------------------------------------------------ */

  /* On a linked browser: a code to link another one. */
  $('dev-code-btn').addEventListener('click', function () {
    var out = $('dev-code');
    api('POST', '/api/devices/code').then(function (r) {
      out.hidden = false;
      out.textContent = '';
      if (!r.ok || !r.data.ok) {
        out.textContent = (r.data && r.data.error) || 'Could not make a code. Please try again.';
        return;
      }
      out.appendChild(document.createTextNode('On the other device, open this page and enter'));
      out.appendChild(el('strong', null, r.data.code));
      out.appendChild(document.createTextNode('within 15 minutes.'));
    });
  });

  function openApp() {
    root.classList.remove('is-booting');
    $('mp-gate').hidden = true;
    $('mp-link').hidden = true;
    $('mp-app').hidden = false;
    $('g-email').textContent = email || 'you';
    refreshMine().then(function () {
      if (BOOT.openReport) {
        var r = state.mine.find(function (x) { return x.id === BOOT.openReport; });
        selectTab('mine');
        if (r && r.status === 'ready') openViewer(r.id, 'narrative', r.name + ', The MasterPlan');
        return;
      }
      /* A MasterPlan still being written: pick up where the member left it. */
      var busy = state.mine.find(function (x) { return x.status === 'queued' || x.status === 'running'; });
      if (busy) track(busy.id);
    });
  }

  /* ---- tabs ---------------------------------------------------------------- */

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.mp-tabs [data-tab]'));
  function selectTab(name) {
    tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (p) {
      p.hidden = p.dataset.panel !== name;
    });
    if (name === 'library') refreshLibrary();
    if (name === 'mine') refreshMine();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t.dataset.tab); });
  });
  document.addEventListener('click', function (e) {
    var go = e.target.closest && e.target.closest('[data-goto]');
    if (go) selectTab(go.dataset.goto);
  });

  /* ---- new: the three steps ------------------------------------------------ */

  function showStep(n) {
    Array.prototype.forEach.call(document.querySelectorAll('.mp-wiz'), function (w) {
      w.hidden = w.dataset.step !== String(n);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.mp-stepper li'), function (li) {
      var k = Number(li.dataset.for);
      li.classList.toggle('is-current', k === n);
      li.classList.toggle('is-done', k < n);
    });
    selectTab('new');
    var top = document.querySelector('.mp-stepper');
    if (top && top.scrollIntoView) top.scrollIntoView({ block: 'nearest' });
  }

  function showError(id, msg) {
    var el = $(id);
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* Step 1: the resume. */

  var file = null;
  var drop = $('mp-drop');
  var fileInput = $('f-resume');

  function takeFile(f) {
    if (!f) return;
    if (f.size > (BOOT.maxUploadBytes || 8388608)) return showError('e-1', 'That file is larger than 8 MB.');
    if (!/\.(pdf|docx|txt)$/i.test(f.name)) return showError('e-1', 'Please use a PDF, Word (.docx) or text file.');
    file = f;
    showError('e-1', '');
    drop.classList.add('has-file');
    $('mp-drop-main').textContent = f.name;
    $('mp-drop-sub').textContent = Math.max(1, Math.round(f.size / 1024)) + ' KB · click to choose a different file';
    $('to-2').disabled = false;
  }
  fileInput.addEventListener('change', function () { takeFile(fileInput.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) { takeFile(e.dataTransfer.files[0]); });

  $('to-2').addEventListener('click', function () {
    if (!file) return showError('e-1', 'Add your resume first.');
    showStep(2);
    $('f-link-1').focus();
  });
  $('back-1').addEventListener('click', function () { showStep(1); });

  function readBase64(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(f);
    });
  }

  /* Step 2: social profiles and place, then generate. */

  $('f-step2').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = function (id) { return $(id).value.trim(); };
    var err = function (msg) { showError('f-error', msg); };

    var links = ['f-link-1', 'f-link-2', 'f-link-3'].map(v).filter(Boolean);
    var badLink = links.filter(function (u) { return !/^https?:\/\/\S+\.\S+/i.test(u); });
    if (badLink.length) return err('Profile links must start with https:// - check ' + badLink[0]);
    if (!links.length && !v('f-pasted')) return err('Add at least one social profile link, or paste your bio.');
    var missing = ['f-city', 'f-country'].filter(function (id) {
      var bad = !v(id);
      $(id).setAttribute('aria-invalid', String(bad));
      return bad;
    });
    if (missing.length) return err('Please add your city and country.');
    if (!$('f-confirm').checked) return err('Please confirm the resume and profiles are yours.');
    if (!file) { showStep(1); return showError('e-1', 'Add your resume first.'); }

    var btn = $('f-submit');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    err('');

    readBase64(file).then(function (b64) {
      return api('POST', '/api/reports', {
        name: v('f-name'),
        pronouns: $('f-pronouns').value,
        city: v('f-city'),
        region: v('f-region'),
        postalCode: v('f-postal'),
        country: v('f-country'),
        links: links,
        pasted: $('f-pasted').value.trim(),
        resumeName: file.name,
        resumeBase64: b64,
        share: $('f-share').checked,
        confirm: true,
      });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.data.error || 'That did not go through. Please try again.');
      resetForm();
      track(r.data.report.id);
    }).catch(function (e2) {
      err(e2.message || 'That did not go through. Please try again.');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Generate my MasterPlan';
    });
  });

  function resetForm() {
    $('f-step2').reset();
    $('f-share').checked = state.sharing;
    fileInput.value = '';
    file = null;
    drop.classList.remove('has-file');
    $('mp-drop-main').innerHTML = 'Drop your resume here, or <u>choose a file</u>';
    $('mp-drop-sub').textContent = 'PDF, Word (.docx) or text. Up to 8 MB.';
    $('to-2').disabled = true;
  }

  /* Step 3: watch it being written. */

  var ORDER = ['queued', 'reading', 'researching', 'writing', 'rendering', 'ready'];
  var BAR = { queued: 4, reading: 14, researching: 32, writing: 58, rendering: 92, ready: 100 };
  var tracking = null;
  var trackTimer = null;

  function track(id) {
    tracking = id;
    $('g-title').textContent = 'Generating your MasterPlan';
    $('g-sub').hidden = false;
    $('g-docs').hidden = true;
    $('g-docs').textContent = '';
    showError('g-error', '');
    paintStage('queued');
    showStep(3);
    pollTrack();
  }

  function paintStage(stage) {
    var at = ORDER.indexOf(stage);
    Array.prototype.forEach.call(document.querySelectorAll('#g-stages li'), function (li) {
      var k = ORDER.indexOf(li.dataset.stage);
      li.classList.toggle('is-done', k < at);
      li.classList.toggle('is-current', k === at);
    });
    $('g-bar').style.width = (BAR[stage] || 4) + '%';
  }

  var trackFailures = 0;
  function pollTrack() {
    clearTimeout(trackTimer);
    if (!tracking) return;
    api('GET', '/api/reports').then(function (res) {
      if (!tracking) return;
      if (!res.ok) {
        /* A deploy or a network blip: keep checking, backing off, and say so
           after a few misses instead of freezing on "Generating". */
        trackFailures++;
        if (trackFailures >= 3) showError('g-error', 'Reconnecting… Your MasterPlan keeps being written on our side; we will also email you when it is ready.');
        trackTimer = setTimeout(pollTrack, Math.min(60000, 5000 * Math.pow(2, trackFailures)));
        return;
      }
      trackFailures = 0;
      showError('g-error', '');
      state.mine = res.data.reports || [];
      var r = state.mine.find(function (x) { return x.id === tracking; });
      if (!r) {
        $('g-title').textContent = 'This MasterPlan no longer exists';
        $('g-sub').hidden = true;
        showError('g-error', 'It may have been deleted. You can start a new one.');
        tracking = null;
        renderMine();
        return;
      }
      if (r.status === 'ready') {
        paintStage('ready');
        $('g-title').textContent = 'Your MasterPlan is ready';
        $('g-sub').hidden = true;
        var docs = docButtons(r);
        $('g-docs').replaceWith(docs);
        docs.id = 'g-docs';
        tracking = null;
        renderMine();
        return;
      }
      if (r.status === 'failed') {
        $('g-title').textContent = 'Your MasterPlan did not finish';
        showError('g-error', (r.error || 'Something went wrong.') + ' Use "Try again" under My MasterPlans.');
        tracking = null;
        renderMine();
        return;
      }
      paintStage(r.stage || 'queued');
      trackTimer = setTimeout(pollTrack, 5000);
    });
  }

  $('g-again').addEventListener('click', function () {
    tracking = null;
    clearTimeout(trackTimer);
    showStep(1);
  });

  /* ---- mine ------------------------------------------------------------------ */

  var STAGES = {
    queued: ['Waiting to start', 6],
    reading: ['Reading your resume and profiles', 18],
    researching: ['Researching local living costs', 36],
    writing: ['Writing your MasterPlan and case study', 62],
    rendering: ['Preparing your documents', 92],
  };

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function docButtons(r) {
    var wrap = el('div', 'mp-docs');
    var who = r.name || 'Your MasterPlan';
    [['narrative', 'The MasterPlan'], ['article', r.docs.article && r.docs.article.title]].forEach(function (d) {
      var info = r.docs[d[0]];
      if (!info) return;
      var b = el('button', 'mp-doc');
      b.type = 'button';
      b.appendChild(document.createTextNode(d[1] || 'Case study'));
      b.appendChild(el('small', null, (d[0] === 'narrative' ? 'Your MasterPlan' : 'Leadership case study') + ' · ' + info.pages + ' pages'));
      b.addEventListener('click', function () { openViewer(r.id, d[0], who + ', ' + (d[1] || '')); });
      wrap.appendChild(b);
    });
    var pod = el('button', 'mp-doc');
    pod.type = 'button';
    pod.disabled = true;
    pod.appendChild(document.createTextNode('Podcast'));
    pod.appendChild(el('small', null, r.podcast ? 'Ready' : 'Coming soon'));
    wrap.appendChild(pod);
    return wrap;
  }

  function renderMine() {
    var list = $('mine-list');
    list.textContent = '';
    $('mine-empty').hidden = state.mine.length > 0;
    var busy = 0;

    state.mine.forEach(function (r) {
      var li = el('li', 'mp-item');
      var top = el('div', 'mp-item-top');
      var left = el('div');
      left.appendChild(el('h3', null, r.name || 'Your MasterPlan'));
      left.appendChild(el('p', 'mp-sub', 'Started ' + fmtDate(r.createdAt)));
      top.appendChild(left);

      var status = el('span', 'mp-status');
      status.appendChild(el('span', 'dot'));
      if (r.status === 'ready') {
        status.appendChild(document.createTextNode('Ready'));
      } else if (r.status === 'failed') {
        status.classList.add('is-failed');
        status.appendChild(document.createTextNode('Not finished'));
      } else {
        busy++;
        status.classList.add('is-busy');
        status.appendChild(document.createTextNode((STAGES[r.stage] || STAGES.queued)[0]));
      }
      top.appendChild(status);
      li.appendChild(top);

      if (r.status === 'ready') {
        li.appendChild(docButtons(r));
      } else if (r.status === 'failed') {
        li.appendChild(el('p', 'mp-sub', r.error || 'Something went wrong.'));
      } else {
        var bar = el('div', 'mp-progress');
        var fill = el('span');
        fill.style.width = (STAGES[r.stage] || STAGES.queued)[1] + '%';
        bar.appendChild(fill);
        li.appendChild(bar);
      }

      var foot = el('div', 'mp-item-foot');
      if (r.status === 'failed') {
        var retry = el('button', 'mp-link', 'Try again');
        retry.addEventListener('click', function () {
          api('POST', '/api/reports/' + r.id + '/retry').then(refreshMine);
        });
        foot.appendChild(retry);
      }
      if (r.status !== 'running') {
        var del = el('button', 'mp-link', 'Delete');
        del.addEventListener('click', function () {
          if (!window.confirm('Delete this MasterPlan? This cannot be undone.')) return;
          api('POST', '/api/reports/' + r.id + '/delete').then(function (res) {
            if (!res.ok) window.alert(res.data.error || 'Could not delete it.');
            refreshMine();
          });
        });
        foot.appendChild(del);
      }
      if (foot.childNodes.length) li.appendChild(foot);
      list.appendChild(li);
    });

    var count = $('mp-mine-count');
    count.hidden = !busy;
    count.textContent = busy;
    schedulePoll(busy > 0);
  }

  function refreshMine() {
    return api('GET', '/api/reports').then(function (r) {
      if (!r.ok) {
        /* Keep checking while anything was still being written. */
        var busy = state.mine.some(function (x) { return x.status === 'queued' || x.status === 'running'; });
        schedulePoll(busy, POLL_MS * 3);
        return;
      }
      state.mine = r.data.reports || [];
      state.sharing = !!r.data.sharing;
      /* The form's share box starts from the member's current choice. */
      $('f-share').checked = state.sharing;
      renderMine();
    });
  }

  function schedulePoll(on, delay) {
    clearTimeout(pollTimer);
    if (on) pollTimer = setTimeout(refreshMine, delay || POLL_MS);
  }

  /* ---- library --------------------------------------------------------------- */

  function refreshLibrary() {
    return api('GET', '/api/library').then(function (r) {
      if (!r.ok) return;
      state.sharing = !!r.data.sharing;
      state.library = r.data.reports || [];
      $('lib-optin').hidden = state.sharing;
      $('lib-body').hidden = !state.sharing;
      var list = $('lib-list');
      list.textContent = '';
      /* The Library opens once one of the member's own MasterPlans is finished
         and shared: share yours, read theirs. */
      $('lib-empty').textContent = r.data.waiting
        ? 'The Library opens when your own MasterPlan is finished. It is shared automatically, and then you can read the others.'
        : 'No shared MasterPlans yet.';
      $('lib-empty').hidden = state.library.length > 0;
      state.library.forEach(function (e) {
        var li = el('li', 'mp-item');
        var top = el('div', 'mp-item-top');
        var left = el('div');
        left.appendChild(el('h3', null, e.name + (e.mine ? ' (you)' : '')));
        left.appendChild(el('p', 'mp-sub', fmtDate(e.createdAt)));
        top.appendChild(left);
        li.appendChild(top);
        li.appendChild(docButtons({ id: e.id, name: e.name, docs: { narrative: { pages: '' }, article: { title: e.articleTitle, pages: '' } }, podcast: null }));
        Array.prototype.forEach.call(li.querySelectorAll('.mp-doc small'), function (s) {
          s.textContent = s.textContent.replace(/ · +pages$/, '');
        });
        list.appendChild(li);
      });
    });
  }

  function setSharing(on) {
    return api('POST', '/api/sharing', { sharing: on }).then(refreshLibrary);
  }
  $('lib-share-on').addEventListener('click', function () { setSharing(true); });
  $('lib-share-off').addEventListener('click', function () {
    if (window.confirm('Stop sharing? Your MasterPlans leave the Library and you will no longer see other members’.')) setSharing(false);
  });

  /* ---- viewer -------------------------------------------------------------- */

  var pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      /* The version in the URL keeps the main file and its worker from the
         same release, whatever the browser cached before an upgrade. */
      var v = '?v=' + encodeURIComponent(BOOT.pdfjsVersion || '1');
      pdfjsPromise = import(BASE + '/static/pdfjs/pdf.min.mjs' + v).then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = BASE + '/static/pdfjs/pdf.worker.min.mjs' + v;
        return lib;
      });
    }
    return pdfjsPromise;
  }

  var viewer = { doc: null, task: null, scale: 1, observer: null, opener: null, load: 0 };
  var pages = $('v-pages');

  function viewerMessage(text) {
    pages.textContent = '';
    pages.appendChild(el('p', 'mp-vmsg', text));
  }

  /* Drop whatever the viewer holds: the document, its loading task and the
     page observer. */
  function releaseViewer() {
    if (viewer.observer) viewer.observer.disconnect();
    viewer.observer = null;
    if (viewer.task) viewer.task.destroy();
    viewer.task = null;
    viewer.doc = null;
  }

  function openViewer(id, doc, title) {
    /* Each open gets a number. A slow load that finishes after the member has
       closed the viewer or opened another document is thrown away, so a
       document is never drawn under another one's title. */
    var load = ++viewer.load;
    releaseViewer();
    viewer.opener = document.activeElement;
    $('v-title').textContent = title;
    $('v-page').textContent = '';
    pages.textContent = '';
    pages.appendChild(el('p', 'mp-vmsg', 'Opening…'));
    $('mp-viewer').hidden = false;
    document.body.style.overflow = 'hidden';
    $('v-close').focus();

    Promise.all([
      loadPdfJs(),
      fetch(BASE + '/api/reports/' + encodeURIComponent(id) + '/' + doc, { headers: { Authorization: 'Bearer ' + token } }).then(function (res) {
        if (!res.ok) throw new Error('not available');
        return res.arrayBuffer();
      }),
    ]).then(function (got) {
      if (load !== viewer.load) return null;
      var task = got[0].getDocument({ data: new Uint8Array(got[1]), isEvalSupported: false });
      viewer.task = task;
      return task.promise.then(function (pdf) {
        if (load !== viewer.load) {
          task.destroy();
          return null;
        }
        return pdf;
      });
    }).then(function (pdf) {
      if (!pdf) return;
      viewer.doc = pdf;
      viewer.scale = 1;
      layoutPages();
      $('v-page').textContent = 'Page 1 of ' + pdf.numPages;
    }).catch(function () {
      if (load === viewer.load) viewerMessage('This document could not be opened. Please try again.');
    });
  }

  function layoutPages() {
    var pdf = viewer.doc;
    if (!pdf) return;
    pages.textContent = '';
    drawFailures = 0;
    if (viewer.observer) viewer.observer.disconnect();
    var width = Math.min(pages.clientWidth - 24, 860) * viewer.scale;

    viewer.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) drawPage(en.target);
      });
    }, { root: pages, rootMargin: '600px 0px' });

    for (var n = 1; n <= pdf.numPages; n++) {
      var box = el('div', 'mp-page');
      box.dataset.page = n;
      box.style.width = width + 'px';
      box.style.height = Math.round(width * (11 / 8.5)) + 'px';
      pages.appendChild(box);
      viewer.observer.observe(box);
    }
  }

  var drawFailures = 0;
  function drawPage(box) {
    if (box.dataset.drawn || !viewer.doc) return;
    box.dataset.drawn = '1';
    var load = viewer.load;
    viewer.doc.getPage(Number(box.dataset.page)).then(function (page) {
      if (load !== viewer.load) return null;
      var cssWidth = box.clientWidth;
      var base = page.getViewport({ scale: 1 });
      var ratio = Math.min(window.devicePixelRatio || 1, 2);
      var vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      box.style.height = Math.round(vp.height / ratio) + 'px';
      box.appendChild(canvas);
      return page.render({ canvas: canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }).catch(function () {
      if (load !== viewer.load) return;
      box.dataset.drawn = '';
      /* A browser that cannot draw the pages at all gets told, instead of a
         column of blank boxes. */
      if (++drawFailures >= 2) viewerMessage('This browser could not display the document. Please update your browser, or try Chrome, Edge, Safari or Firefox.');
    });
  }

  function closeViewer() {
    viewer.load++;
    $('mp-viewer').hidden = true;
    document.body.style.overflow = '';
    releaseViewer();
    pages.textContent = '';
    if (viewer.opener && viewer.opener.focus) viewer.opener.focus();
  }

  $('v-close').addEventListener('click', closeViewer);
  $('v-in').addEventListener('click', function () { viewer.scale = Math.min(2, viewer.scale + 0.25); layoutPages(); });
  $('v-out').addEventListener('click', function () { viewer.scale = Math.max(0.5, viewer.scale - 0.25); layoutPages(); });
  document.addEventListener('keydown', function (e) {
    if ($('mp-viewer').hidden) return;
    if (e.key === 'Escape') closeViewer();
    /* Nothing to save or print here. */
    if ((e.ctrlKey || e.metaKey) && /^[sp]$/i.test(e.key)) e.preventDefault();
  });
  /* The page counter follows the page that fills the middle of the view. */
  pages.addEventListener('scroll', function () {
    if (!viewer.doc) return;
    var mid = pages.scrollTop + pages.clientHeight / 2;
    var boxes = pages.children;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b.offsetTop + b.offsetHeight >= mid) {
        $('v-page').textContent = 'Page ' + (i + 1) + ' of ' + viewer.doc.numPages;
        break;
      }
    }
  }, { passive: true });
  pages.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if ($('mp-viewer').hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutPages, 200);
  });

  /* ---- boot ------------------------------------------------------------------ */

  if (PREVIEW) {
    /* Show the tool as a member would see it, with a note that it is a preview. */
    var note = document.createElement('p');
    note.className = 'mp-preview';
    note.textContent = 'Preview. This page only works once it is published on StrategyTraining.com and you are signed in.';
    $('mp-app').insertBefore(note, $('mp-app').firstChild);
    openApp();
  } else if (!BOOT.ready) {
    showGate('not_configured');
  } else if (BOOT.devOpen && !embedded) {
    startSession({ signedIn: true });
  } else {
    requestIdentity().then(function (who) {
      /* On the store page a signed-out visitor is told to sign in straight
         away; there is no need to ask the server. */
      if (PAGE && who.signedIn === false && !who.transient) {
        lastIdentity = who;
        return showGate('signed_out');
      }
      return startSession(who);
    });
  }
})();
