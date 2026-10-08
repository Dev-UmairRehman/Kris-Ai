'use strict';

/* ---------------------------------------------------------------------------
   MasterPlan Digital - the storefront side, in one hosted file.

   Pasted into the "MasterPlan Digital" landing page as two lines (see
   uscreen/masterplan-page.html). Like the Kris AI Memory loader, it is hosted
   so fixes ship with a deploy instead of a re-paste.

     1. builds the iframe at #masterplan-digital
     2. sizes it to the room left in the window
     3. tells the page who is signed in (GET /account, same-origin)
     4. passes ?report=<id> from the email link through to the page
   --------------------------------------------------------------------------- */

(function () {
  var VERSION = 2;
  var self = document.currentScript;
  var ORIGIN = (function () {
    try {
      return new URL(self.src).origin;
    } catch (e) {
      return 'https://kris-ai-memory-baefm.ondigitalocean.app';
    }
  })();
  console.log('[st-mp] embed v' + VERSION + ' from ' + ORIGIN);

  var MIN_HEIGHT = 520;
  var STYLE =
    '.mp-embed{position:relative;width:100%;height:80vh;min-height:' + MIN_HEIGHT + 'px;margin:0 auto;background:#fff}' +
    '.mp-embed iframe{display:block;width:100%;height:100%;border:0}' +
    '.mp-embed--inpage{height:calc(100vh - 32px);min-height:640px;max-height:1100px}';

  function injectStyle() {
    if (document.getElementById('mp-embed-style')) return;
    var tag = document.createElement('style');
    tag.id = 'mp-embed-style';
    tag.textContent = STYLE;
    (document.head || document.documentElement).appendChild(tag);
  }

  var box = null;
  var bare = false;
  function build() {
    if (box && box.parentNode) return box;
    var mount = document.getElementById('masterplan-digital');
    box = document.createElement('div');
    box.className = 'mp-embed';

    var report = '';
    try {
      report = new URLSearchParams(location.search).get('report') || '';
    } catch (e) {}

    /* data-bare: the page around the app already has the title, so the app
       drops its own. The app then sits inside a long page, so it is one
       screen tall and scrolls inside, instead of filling the space below. */
    bare = !!(mount && mount.getAttribute('data-bare'));
    if (bare) box.classList.add('mp-embed--inpage');
    var q = [];
    if (/^[\w-]{8,40}$/.test(report)) q.push('report=' + report);
    if (bare) q.push('bare=1');

    var frame = document.createElement('iframe');
    frame.src = ORIGIN + '/masterplan/embed' + (q.length ? '?' + q.join('&') : '');
    frame.title = 'The MasterPlan Digital';
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    box.appendChild(frame);

    if (mount) {
      mount.textContent = '';
      mount.appendChild(box);
    } else if (self && self.parentNode) {
      self.parentNode.insertBefore(box, self);
    }
    return box;
  }

  /* Fill the window below the widget without making the page scroll. */
  function fit() {
    if (!box || !box.parentNode || bare) return;
    var top = box.getBoundingClientRect().top + (window.pageYOffset || 0);
    var h = window.innerHeight - top;
    for (var pass = 0; pass < 4; pass++) {
      var applied = Math.max(MIN_HEIGHT, Math.round(h));
      box.style.height = applied + 'px';
      var over = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (over <= 1 || applied <= MIN_HEIGHT) break;
      h = applied - over;
    }
  }

  /* ---- who is signed in? (same probe as Kris AI Memory) ------------------
     GET /account with no Accept header: 401 signed out, 200 signed in (the
     account page, which carries the email), 406 also means signed in. */

  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var cached = null;
  var pending = null;

  function emailFrom(text) {
    var field = text.match(/<input[^>]*(?:name|id)="[^"]*email[^"]*"[^>]*>/i);
    if (field) {
      var value = field[0].match(/value="([^"]*)"/i);
      if (value && EMAIL_RE.test(value[1])) return value[1];
    }
    var loose = text.match(EMAIL_RE);
    return loose ? loose[0] : '';
  }

  function probe() {
    return fetch('/account', { credentials: 'same-origin' })
      .then(function (res) {
        var path = '';
        try { path = new URL(res.url, location.href).pathname; } catch (e) {}
        if (/\/(sign_in|login|join)\b/.test(path)) return { signedIn: false };
        if (res.status === 401 || res.status === 403) return { signedIn: false };
        if (res.status === 406) return { signedIn: true, email: '' };
        if (!res.ok) return null;
        return res.text().then(function (t) { return { signedIn: true, email: emailFrom(t) }; });
      })
      .catch(function () { return null; });
  }

  function resolveMember() {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;
    pending = probe().then(function (r) {
      pending = null;
      if (!r) return { signedIn: false, transient: true };
      if (r.signedIn && !r.email) {
        var m = (document.body ? document.body.innerText || '' : '').match(EMAIL_RE);
        if (m) r.email = m[0];
      }
      cached = r;
      return r;
    });
    return pending;
  }

  function answer(frame, member) {
    try {
      frame.postMessage(
        { type: 'st-mp:identity', signedIn: member.signedIn === true, email: (member.signedIn && member.email) || '' },
        ORIGIN
      );
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN || !event.data || event.data.type !== 'mp:ready') return;
    var frame = event.source;
    resolveMember().then(function (m) {
      answer(frame, m);
      if (m.transient) {
        setTimeout(function () {
          resolveMember().then(function (again) { if (again.signedIn) answer(frame, again); });
        }, 1500);
      }
    });
  });

  function boot() {
    injectStyle();
    build();
    fit();
  }
  boot();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', fit);
  window.addEventListener('resize', fit);
  document.addEventListener('turbo:load', boot);
  resolveMember();
})();
