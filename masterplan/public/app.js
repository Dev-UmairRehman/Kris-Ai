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
  if (PAGE) root.classList.add('is-page');
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

  /* ---- who is signed in (page mode) -----------------------------------------
     The store answers GET /account with 401 when signed out and the account
     page (200, or 406 without an Accept header) when signed in. The email is
     looked for in turn, stopping at the first place that has exactly one:
       1. the account page (asked for as HTML if it answered 406);
       2. the store's other account pages;
       3. page fragments the store loads on demand (turbo-frame src);
       4. this page itself: its text, open shadow roots and the email-like
          attributes of the store's web components (the profile menu).
     Never from scripts, styles or links: page code carries addresses such as
     an error tracker's key@o123.ingest.sentry.io, which is no one's email -
     two members given the same guessed address would share one account. */
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var NOT_MEMBER = /@(strategytraining|firmsconsulting|uscreen|michael)\b|@([a-z0-9-]+\.)*(sentry\.io|sentry-cdn\.com|ingest\.[a-z0-9.-]+|sentry\.[a-z.]+)$|^[0-9a-f]{16,}@|\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;
  var ACCOUNT_PAGES = ['/account/edit', '/account/settings', '/account/profile'];

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

  /* What a person can see in a document or shadow root, plus email fields and
     the attributes of custom elements (never src/href, never inside scripts). */
  var HIDDEN_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, IFRAME: 1, HEAD: 1, LINK: 1, META: 1 };
  var SKIP_ATTRS = /^(src|href|srcset|action|style|class|on\w+|data-action|integrity|nonce)$/i;
  function visibleText(root, depth) {
    if (!root) return '';
    depth = depth || 0;
    var out = [];
    var stack = [root.body || root];
    while (stack.length) {
      var node = stack.pop();
      if (node.nodeType === 3) {
        out.push(node.nodeValue);
        continue;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) continue;
      var tag = node.nodeName ? String(node.nodeName).toUpperCase() : '';
      if (HIDDEN_TAGS[tag]) continue;
      if (node.nodeType === 1) {
        if (tag === 'INPUT' && /email/i.test((node.type || '') + ' ' + (node.name || '') + ' ' + (node.id || ''))) {
          out.push(node.value || node.getAttribute('value') || '');
        }
        if (tag.indexOf('-') !== -1 || node.hasAttribute('data-email')) {
          for (var i = 0; i < node.attributes.length; i++) {
            var at = node.attributes[i];
            if (!SKIP_ATTRS.test(at.name)) out.push(at.value);
          }
        }
        if (node.shadowRoot && depth < 4) out.push(visibleText(node.shadowRoot, depth + 1));
      }
      for (var c = node.lastChild; c; c = c.previousSibling) stack.push(c);
    }
    return out.join(' ');
  }

  function parse(html) {
    try { return new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
  }

  /* One email from an HTML page, or ''. The email field wins; otherwise
     exactly one visible address, or the one this page also shows. */
  function emailIn(doc) {
    if (!doc) return '';
    var field = doc.querySelector('input[type="email"], input[name*="email"], input[id*="email"]');
    var value = field && (field.getAttribute('value') || '').trim();
    if (value && candidates(value).length === 1) return value;
    var list = candidates(visibleText(doc));
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      var here = candidates(visibleText(document)).map(function (e) { return e.toLowerCase(); });
      var both = list.filter(function (e) { return here.indexOf(e.toLowerCase()) !== -1; });
      if (both.length === 1) return both[0];
    }
    return '';
  }
  function emailOnPage() {
    var list = candidates(visibleText(document));
    return list.length === 1 ? list[0] : '';
  }

  function getPage(url, asHtml) {
    var opts = { credentials: 'same-origin', redirect: 'follow' };
    if (asHtml) opts.headers = { Accept: 'text/html,application/xhtml+xml' };
    return fetch(url, opts).then(function (res) {
      var path = '';
      try { path = new URL(res.url, location.href).pathname; } catch (e) { /* ignore */ }
      if (/\/(sign_in|login|join)\b/.test(path) || res.status === 401 || res.status === 403) return { out: true, status: res.status };
      if (!res.ok) return { status: res.status };
      var type = res.headers.get('content-type') || '';
      if (type && type.indexOf('html') === -1) return { status: res.status };
      return res.text().then(function (t) { return { status: res.status, doc: parse(t) }; });
    });
  }

  /* Tries the sources in order; resolves to the first email found. */
  function findEmail(firstDoc) {
    var found = emailIn(firstDoc);
    if (found) return Promise.resolve({ email: found, via: 'account page' });
    var i = 0;
    function nextPage() {
      if (i >= ACCOUNT_PAGES.length) return fromFrames();
      var url = ACCOUNT_PAGES[i++];
      return getPage(url, true).then(function (r) {
        var e = r && r.doc ? emailIn(r.doc) : '';
        return e ? { email: e, via: url } : nextPage();
      }, nextPage);
    }
    function fromFrames() {
      var srcs = [];
      Array.prototype.forEach.call(document.querySelectorAll('turbo-frame[src], [data-src*="account"], [src*="/account"]'), function (f) {
        var u = f.getAttribute('src') || f.getAttribute('data-src') || '';
        try { u = new URL(u, location.href); } catch (e) { return; }
        if (u.origin === location.origin && srcs.indexOf(u.href) === -1 && srcs.length < 4) srcs.push(u.href);
      });
      var j = 0;
      function nextFrame() {
        if (j >= srcs.length) return fromHere();
        var url = srcs[j++];
        return getPage(url, true).then(function (r) {
          var e = r && r.doc ? emailIn(r.doc) : '';
          return e ? { email: e, via: 'page fragment' } : nextFrame();
        }, nextFrame);
      }
      return nextFrame();
    }
    function fromHere() {
      var e = emailOnPage();
      return { email: e, via: e ? 'this page' : 'not found' };
    }
    return nextPage();
  }

  function probeAccount() {
    return getPage('/account', false).then(function (r) {
      if (r.out) return { signedIn: false, via: '/account ' + (r.status || 'sign-in') };
      if (r.status === 406) {
        /* Signed in; ask for the account page as HTML. */
        return getPage('/account', true).then(function (h) {
          return findEmail(h && h.doc).then(function (f) { return { signedIn: true, email: f.email, via: '/account 406, ' + f.via }; });
        }, function () {
          return findEmail(null).then(function (f) { return { signedIn: true, email: f.email, via: '/account 406, ' + f.via }; });
        });
      }
      if (!r.doc) return null; // an error page: tried once more, then treated as a blip
      return findEmail(r.doc).then(function (f) { return { signedIn: true, email: f.email, via: '/account, ' + f.via }; });
    }).catch(function () { return null; });
  }

  /* A failed probe is tried once more before anyone is called signed out. */
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

  /* While "could not read your email" is showing, watch the page: the moment
     the profile menu puts the email on it, carry on without a click. */
  var emailWatch = null;
  function watchForEmail() {
    if (emailWatch || !window.MutationObserver) return;
    var timer = null;
    emailWatch = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var e = emailOnPage();
        if (!e) return;
        stopEmailWatch();
        $('mp-gate').hidden = true;
        root.classList.add('is-booting');
        attempts = 0;
        startSession({ signedIn: true, email: e, via: 'profile menu, watched' });
      }, 250);
    });
    emailWatch.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    setTimeout(stopEmailWatch, 10 * 60 * 1000);
  }
  function stopEmailWatch() {
    if (emailWatch) emailWatch.disconnect();
    emailWatch = null;
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
    return api('POST', '/api/session', claim).then(function (r) {
      if (r.ok && r.data.ok) {
        token = r.data.token;
        email = r.data.email || '';
        openApp();
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

  function showGate(reason) {
    root.classList.remove('is-booting');
    $('mp-app').hidden = true;
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
    else if (reason === 'no_email') text = 'You are signed in, but we could not read the email on your account. Open your account menu (your picture, top right) and this page continues by itself, or press Try again.';
    else if (reason === 'expired') text = 'Your session has expired. Press Try again to continue.';
    else if (reason === 'service_down') text = 'The MasterPlan service is not reachable right now. Please try again in a few minutes.';
    else text = 'We could not open the MasterPlan just now. Please try again in a moment.';
    $('mp-gate-text').textContent = text;
    if (reason === 'no_email' && PAGE) watchForEmail();
    else stopEmailWatch();

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

  function openApp() {
    root.classList.remove('is-booting');
    $('mp-gate').hidden = true;
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

  /* ---- new: one form, then the progress view ------------------------------ */

  /* The New MasterPlan tab shows either the form (intro, resume, profiles) or,
     once a MasterPlan is being written, its progress and then its documents. */
  function showForm() {
    $('f-new').hidden = false;
    document.querySelector('#panel-new .mp-intro').hidden = false;
    $('gen-view').hidden = true;
    selectTab('new');
  }
  function showProgress() {
    $('f-new').hidden = true;
    document.querySelector('#panel-new .mp-intro').hidden = true;
    $('gen-view').hidden = false;
    selectTab('new');
    if (root.scrollIntoView) root.scrollIntoView({ block: 'start' });
  }

  function showError(id, msg) {
    var el = $(id);
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* The resume. */

  var file = null;
  var drop = $('mp-drop');
  var fileInput = $('f-resume');
  var DROP_MAIN = 'Drop your file here, or click to browse';
  var DROP_SUB = 'PDF or Word';

  function takeFile(f) {
    if (!f) return;
    if (f.size > (BOOT.maxUploadBytes || 8388608)) return showError('f-error', 'That file is larger than 8 MB.');
    if (!/\.(pdf|docx|txt)$/i.test(f.name)) return showError('f-error', 'Please use a PDF or Word (.docx) file.');
    file = f;
    showError('f-error', '');
    drop.classList.add('has-file');
    $('mp-drop-main').textContent = f.name;
    $('mp-drop-sub').textContent = Math.max(1, Math.round(f.size / 1024)) + ' KB · click to choose a different file';
  }
  fileInput.addEventListener('change', function () { takeFile(fileInput.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) { takeFile(e.dataTransfer.files[0]); });

  function readBase64(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(f);
    });
  }

  /* Profiles are optional. A bare handle or a link without https:// is turned
     into a full link where the field says which site it is. */
  var PROFILE_FIELDS = [
    ['f-link-1', 'https://www.linkedin.com/in/'],
    ['f-link-2', 'https://www.youtube.com/@'],
    ['f-link-3', 'https://www.instagram.com/'],
    ['f-link-4', ''],
  ];
  function profileLink(id, base) {
    var raw = $(id).value.trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw)) return 'https://' + raw;
    if (base && /^@?[\w.-]{2,100}$/.test(raw)) return base + raw.replace(/^@/, '');
    return null;
  }

  $('f-new').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = function (msg) { showError('f-error', msg); };
    if (!file) return err('Add your resume first. It should include your name and location.');

    var links = [];
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var id = PROFILE_FIELDS[i][0];
      var link = profileLink(id, PROFILE_FIELDS[i][1]);
      $(id).setAttribute('aria-invalid', String(link === null));
      if (link === null) return err('That profile link does not look right: ' + $(id).value.trim());
      if (link) links.push(link);
    }

    var btn = $('f-submit');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    err('');

    readBase64(file).then(function (b64) {
      return api('POST', '/api/reports', {
        links: links,
        pasted: $('f-pasted').value.trim(),
        resumeName: file.name,
        resumeBase64: b64,
        share: $('f-share').checked,
        /* Submitting under the note "Everything you share here is already
           public..." is the member's confirmation. */
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
    $('f-new').reset();
    $('f-share').checked = state.sharing;
    fileInput.value = '';
    file = null;
    drop.classList.remove('has-file');
    $('mp-drop-main').textContent = DROP_MAIN;
    $('mp-drop-sub').textContent = DROP_SUB;
    PROFILE_FIELDS.forEach(function (f) { $(f[0]).removeAttribute('aria-invalid'); });
  }

  /* The progress view: watch it being written. */

  var ORDER = ['queued', 'reading', 'researching', 'writing', 'rendering', 'podcast', 'ready'];
  var BAR = { queued: 4, reading: 10, researching: 24, writing: 46, rendering: 62, podcast: 78, ready: 100 };

  function podcastPending(r) {
    return !!(r.podcast && (r.podcast.status === 'queued' || r.podcast.status === 'running'));
  }
  var tracking = null;
  var trackTimer = null;

  function track(id) {
    tracking = id;
    $('g-title').textContent = 'Generating your MasterPlan';
    $('g-sub').hidden = false;
    $('g-pod').hidden = true;
    $('g-docs').hidden = true;
    $('g-docs').textContent = '';
    showError('g-error', '');
    $('g-stages').querySelector('[data-stage="podcast"]').hidden = false;
    paintStage('queued');
    showProgress();
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
        /* The documents open as soon as they exist; the podcast follows. */
        var docs = docButtons(r);
        $('g-docs').replaceWith(docs);
        docs.id = 'g-docs';
        $('g-stages').querySelector('[data-stage="podcast"]').hidden = !r.podcast;
        if (podcastPending(r)) {
          paintStage('podcast');
          $('g-title').textContent = 'Your documents are ready';
          $('g-sub').hidden = true;
          $('g-pod').hidden = false;
          trackTimer = setTimeout(pollTrack, 8000);
          return;
        }
        paintStage('ready');
        $('g-title').textContent = 'Your MasterPlan is ready';
        $('g-sub').hidden = true;
        $('g-pod').hidden = true;
        if (r.podcast && r.podcast.status === 'failed') {
          showError('g-error', 'Your documents are ready, but the podcast did not finish. Use "Try the podcast again" under My MasterPlans.');
        }
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
    showForm();
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
    var p = r.podcast;
    if (p) {
      var pod = el('button', 'mp-doc mp-doc-pod');
      pod.type = 'button';
      pod.appendChild(document.createTextNode(p.status === 'ready' && p.title ? 'The Debate: ' + p.title : 'The Debate'));
      var note = 'Podcast';
      if (p.status === 'ready') note += p.seconds ? ' · ' + Math.max(1, Math.round(p.seconds / 60)) + ' min' : '';
      else if (p.status === 'failed') note += ' · not finished';
      else note += ' · recording…';
      pod.appendChild(el('small', null, note));
      if (p.status === 'ready') {
        pod.addEventListener('click', function () { openPlayer(r.id, p, who); });
      } else {
        pod.disabled = true;
        if (p.status !== 'failed') pod.classList.add('is-busy');
      }
      wrap.appendChild(pod);
    }
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
      if (r.status === 'ready' && podcastPending(r)) {
        busy++;
        status.classList.add('is-busy');
        status.appendChild(document.createTextNode('Recording the podcast'));
      } else if (r.status === 'ready') {
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
      if (r.status === 'ready' && r.podcast && r.podcast.status === 'failed') {
        var again = el('button', 'mp-link', 'Try the podcast again');
        again.addEventListener('click', function () {
          again.disabled = true;
          api('POST', '/api/reports/' + r.id + '/retry').then(refreshMine);
        });
        foot.appendChild(again);
      }
      if (r.status !== 'running' && !podcastPending(r)) {
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
        var busy = state.mine.some(function (x) { return x.status === 'queued' || x.status === 'running' || podcastPending(x); });
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
        li.appendChild(docButtons({
          id: e.id,
          name: e.name,
          docs: { narrative: { pages: '' }, article: { title: e.articleTitle, pages: '' } },
          podcast: e.podcast ? { status: 'ready', title: e.podcast.title, seconds: e.podcast.seconds } : null,
        }));
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
    /* Whole pixels: a fractional width makes the browser resample the canvas,
       which softens the text. */
    var width = Math.floor(Math.min(pages.clientWidth - 24, 860) * viewer.scale);

    /* Pages are drawn as they come near the view and dropped again when they
       are far away, so a 30-page document at high resolution never holds more
       than a handful of pages in memory. */
    viewer.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) drawPage(en.target);
        else freePage(en.target);
      });
    }, { root: pages, rootMargin: '1200px 0px' });

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
      /* Draw well above screen resolution and let the browser scale down:
         on an ordinary 1x laptop screen, a page drawn at exactly 1x looks
         soft, like a picture of text. 2x there, 3x on retina screens. */
      var dpr = window.devicePixelRatio || 1;
      var ratio = Math.min(3, Math.max(2, dpr * 1.5));
      var vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      box.style.height = Math.round(vp.height / ratio) + 'px';
      box.appendChild(canvas);
      var task = page.render({ canvas: canvas, canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp });
      box._render = task;
      return task.promise.then(function () {
        box._render = null;
      });
    }).catch(function (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      if (load !== viewer.load) return;
      box.dataset.drawn = '';
      /* A browser that cannot draw the pages at all gets told, instead of a
         column of blank boxes. */
      if (++drawFailures >= 2) viewerMessage('This browser could not display the document. Please update your browser, or try Chrome, Edge, Safari or Firefox.');
    });
  }

  /* Give a far-away page's canvas memory back; it is drawn again on return. */
  function freePage(box) {
    if (!box.dataset.drawn) return;
    if (box._render) {
      box._render.cancel();
      box._render = null;
    }
    var canvas = box.querySelector('canvas');
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      box.removeChild(canvas);
    }
    box.dataset.drawn = '';
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

  /* ---- podcast player -------------------------------------------------------- */

  /* The episode plays on the site only: it is fetched with the member's token
     into memory and played from there, through our own controls. There is no
     file link, no native player menu and no save button. */
  var player = { audio: null, url: null, load: 0, opener: null, seeking: false };
  var RATES = [1, 1.25, 1.5, 0.75];

  function clock(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    var ss = ('0' + (s % 60)).slice(-2);
    return h ? h + ':' + ('0' + (m % 60)).slice(-2) + ':' + ss : m + ':' + ss;
  }

  function playerControls(on) {
    ['p-play', 'p-back', 'p-fwd', 'p-seek', 'p-rate'].forEach(function (k) { $(k).disabled = !on; });
  }

  function paintPlayer() {
    var a = player.audio;
    var playing = !!(a && !a.paused);
    $('mp-player').classList.toggle('is-playing', playing);
    $('p-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!a) return;
    var len = isFinite(a.duration) ? a.duration : 0;
    $('p-now').textContent = clock(a.currentTime);
    $('p-len').textContent = clock(len);
    if (!player.seeking && len) $('p-seek').value = Math.round((a.currentTime / len) * 1000);
    $('p-seek').style.setProperty('--at', ($('p-seek').value / 10) + '%');
  }

  function releasePlayer() {
    if (player.audio) {
      player.audio.pause();
      player.audio.removeAttribute('src');
      player.audio.load();
    }
    player.audio = null;
    if (player.url) URL.revokeObjectURL(player.url);
    player.url = null;
  }

  function openPlayer(id, p, who) {
    var load = ++player.load;
    releasePlayer();
    player.opener = document.activeElement;
    $('p-title').textContent = p.title || 'The Debate';
    $('p-who').textContent = who || '';
    $('p-now').textContent = '0:00';
    $('p-len').textContent = clock(p.seconds);
    $('p-seek').value = 0;
    $('p-seek').style.setProperty('--at', '0%');
    $('p-rate').textContent = '1×';
    $('p-msg').textContent = 'Loading the episode…';
    playerControls(false);
    $('mp-player').classList.remove('is-playing');
    $('mp-player').hidden = false;
    document.body.style.overflow = 'hidden';
    $('p-close').focus();

    fetch(BASE + '/api/reports/' + encodeURIComponent(id) + '/podcast', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) {
        if (!res.ok) throw new Error('not available');
        var total = Number(res.headers.get('content-length')) || 0;
        if (!res.body || !res.body.getReader || !total) return res.arrayBuffer().then(function (b) { return [b]; });
        /* Read it in pieces to show how far the download is. */
        var reader = res.body.getReader();
        var parts = [];
        var got = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (load !== player.load) {
              reader.cancel();
              return null;
            }
            if (r.done) return parts;
            parts.push(r.value);
            got += r.value.length;
            $('p-msg').textContent = 'Loading the episode… ' + Math.min(99, Math.round((got / total) * 100)) + '%';
            return pump();
          });
        }
        return pump();
      })
      .then(function (parts) {
        if (!parts || load !== player.load) return;
        player.url = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }));
        var a = new Audio();
        a.preload = 'auto';
        a.src = player.url;
        player.audio = a;
        ['timeupdate', 'play', 'pause', 'durationchange', 'loadedmetadata', 'ratechange'].forEach(function (ev) {
          a.addEventListener(ev, paintPlayer);
        });
        a.addEventListener('ended', function () {
          paintPlayer();
          $('p-msg').textContent = 'That is the episode. Next: the conversation with Kris AI.';
        });
        a.addEventListener('error', function () {
          if (load === player.load) $('p-msg').textContent = 'This browser could not play the episode. Please try Chrome, Edge, Safari or Firefox.';
        });
        $('p-msg').textContent = '';
        playerControls(true);
        $('p-play').focus();
      })
      .catch(function () {
        if (load === player.load) $('p-msg').textContent = 'The episode could not be loaded. Please try again.';
      });
  }

  function closePlayer() {
    player.load++;
    releasePlayer();
    $('mp-player').hidden = true;
    document.body.style.overflow = '';
    if (player.opener && player.opener.focus) player.opener.focus();
  }

  function togglePlay() {
    var a = player.audio;
    if (!a) return;
    if (a.paused) {
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { $('p-msg').textContent = 'Press play again to start the episode.'; });
    } else {
      a.pause();
    }
  }

  function skip(by) {
    var a = player.audio;
    if (!a || !isFinite(a.duration)) return;
    a.currentTime = Math.max(0, Math.min(a.duration - 0.25, a.currentTime + by));
    paintPlayer();
  }

  $('p-close').addEventListener('click', closePlayer);
  $('p-play').addEventListener('click', togglePlay);
  $('p-back').addEventListener('click', function () { skip(-15); });
  $('p-fwd').addEventListener('click', function () { skip(15); });
  $('p-rate').addEventListener('click', function () {
    var a = player.audio;
    if (!a) return;
    var next = RATES[(RATES.indexOf(a.playbackRate) + 1) % RATES.length] || 1;
    a.playbackRate = next;
    $('p-rate').textContent = next + '×';
  });
  $('p-seek').addEventListener('input', function () {
    var a = player.audio;
    player.seeking = true;
    $('p-seek').style.setProperty('--at', ($('p-seek').value / 10) + '%');
    if (a && isFinite(a.duration)) $('p-now').textContent = clock((a.duration * $('p-seek').value) / 1000);
  });
  $('p-seek').addEventListener('change', function () {
    var a = player.audio;
    player.seeking = false;
    if (a && isFinite(a.duration)) a.currentTime = (a.duration * $('p-seek').value) / 1000;
    paintPlayer();
  });
  $('mp-player').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  $('mp-player').addEventListener('click', function (e) {
    if (e.target === $('mp-player')) closePlayer();
  });
  document.addEventListener('keydown', function (e) {
    if ($('mp-player').hidden) return;
    if (e.key === 'Escape') closePlayer();
    else if ((e.ctrlKey || e.metaKey) && /^[sp]$/i.test(e.key)) e.preventDefault();
    else if (e.key === ' ' && e.target && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePlay();
    }
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
