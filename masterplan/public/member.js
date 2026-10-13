'use strict';

/* ---------------------------------------------------------------------------
   Who is signed in on the StrategyTraining store, and do they have a plan.

   Shared by every StrategyTraining product page pasted into Uscreen
   (MasterPlan Digital, Your Marketing Agency), so a fix here is a fix for all
   of them. Runs on the store's own pages (same origin as /account).

     STMember.identify(log)       -> { signedIn, email, via, transient? }
     STMember.checkPlan(planPage) -> { plan: 'yes'|'no'|'unknown', planVia }
     STMember.emailOnPage()       -> the one member email shown on this page, or ''
   --------------------------------------------------------------------------- */

(function () {
  if (window.STMember) return;
  var LOG = '[st-member]';

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
  /* The store's own role addresses (support@strategytraining.com...) - never a whole domain:
     the team signs in with firmsconsulting.com and strategytraining.com
     addresses, while a footer's support@ address is no one's account. */
  var NOT_MEMBER = /^(support|help|helpdesk|info|contact|hello|admin|noreply|no-reply|donotreply|do-not-reply|team|billing|sales|privacy|legal|press|care|service|notifications?|mailer|marketing|feedback|enquiries|inquiries)@([a-z0-9-]+\.)*(strategytraining|firmsconsulting)\.com$|@([a-z0-9-]+\.)*uscreen\.(io|tv|com)$|@([a-z0-9-]+\.)*(sentry\.io|sentry-cdn\.com|ingest\.[a-z0-9.-]+|sentry\.[a-z.]+)$|^[0-9a-f]{32}@|\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i;
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
    var opts = { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' };
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
      try { console.log(LOG + ' signedIn=' + r.signedIn + ' email=' + (r.email ? 'yes' : 'none') + ' via ' + r.via); } catch (e) { /* no console */ }
      return r;
    });
  }

  /* Does this member have a plan? Asked of the store itself: a page Uscreen
     opens only to members with a plan (the Kris AI page, /delphi). Staying
     on it means yes; being sent elsewhere means no. Anything unclear is
     "unknown", and the server lets "unknown" in rather than lock out a paying
     member. */
  function checkPlanPage(planPage) {
    var want = String(planPage || '').replace(/\/+$/, '');
    if (!want) return Promise.resolve({ plan: 'unknown', planVia: 'no plan page' });
    return fetch(want, { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' }).then(function (res) {
      /* Where the store left us. The home page is "/" - never "", which would
         read as "no information" and let a member without a plan through. */
      var path = null;
      try { path = new URL(res.url, location.href).pathname.replace(/\/+$/, '') || '/'; } catch (e) { /* ignore */ }
      if (res.status === 401 || res.status === 403) return { plan: 'no', planVia: want + ' ' + res.status };
      if (path !== null && path !== want) return { plan: 'no', planVia: want + ' -> ' + path };
      if (path === null && res.redirected) return { plan: 'unknown', planVia: want + ' redirected' };
      if (res.ok) return { plan: 'yes', planVia: want + ' 200' };
      return { plan: 'unknown', planVia: want + ' ' + res.status };
    }, function () {
      return { plan: 'unknown', planVia: want + ' unreachable' };
    });
  }

  window.STMember = {
    identify: function (log) {
      if (log) LOG = log;
      return identityFromStore();
    },
    checkPlan: checkPlanPage,
    emailOnPage: emailOnPage,
  };
})();
