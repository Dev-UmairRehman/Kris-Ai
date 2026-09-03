'use strict';

/* ---------------------------------------------------------------------------
   Kris AI Memory - the whole storefront side, in one hosted file.

   WHY THIS IS HOSTED RATHER THAN PASTED
   Everything here used to live in the page's Custom HTML block. Measured on the
   live store, the block that saved was 13,072 bytes while the file being pasted
   had grown to 19,126 - and the page kept running the older, smaller version no
   matter how many times it was re-pasted. Whether the editor truncates or
   refuses the save, the result is the same: fixes never arrived.

   So the paste-in is now two lines, and this file - which ships with the app and
   updates on deploy - does the work. Nothing to re-paste when something changes.

   It is loaded by a plain <script src>, so it runs in the storefront's own
   context: fetch('/account') is same-origin to strategytraining.com and carries
   the member's session cookie, exactly as before. The store's CSP restricts
   frame-ancestors only, not script-src (checked), and the page already loads
   third-party scripts.

   WHAT IT DOES
     1. builds the widget: styles, container, iframe
     2. sizes it to the room actually left, so the page itself never scrolls
     3. tells the widget whether a member is signed in - without this nobody can
        use it, and it fails closed
     4. removes itself if it has been dropped somewhere it does not belong
   --------------------------------------------------------------------------- */

(function () {
  var VERSION = 8;

  /* The origin this script came from is the origin the widget is served from,
     so there is no second copy of the URL to keep in step. */
  var self = document.currentScript;
  var ORIGIN = (function () {
    try {
      return new URL(self.src).origin;
    } catch (e) {
      return 'https://kris-ai-memory-baefm.ondigitalocean.app';
    }
  })();

  console.log('[st-kris] embed v' + VERSION + ' from ' + ORIGIN);

  /* Low enough to still fit a 1366x768 window once the store's nav, the admin
     bar and the footer have taken their share. The widget scrolls its own
     messages, so a short one is usable; a taller floor would force the page to
     scroll, which is the thing being avoided. */
  var MIN_HEIGHT = 320;

  /* ---- build it -------------------------------------------------------- */

  var STYLE =
    '.kris-ai-embed{position:relative;width:100%;height:70vh;min-height:' +
    MIN_HEIGHT +
    'px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden}' +
    '.kris-ai-embed iframe{display:block;width:100%;height:100%;border:0}' +
    '@media(max-width:640px){.kris-ai-embed{border-radius:0}}';

  function injectStyle() {
    if (document.getElementById('kris-ai-style')) return;
    var tag = document.createElement('style');
    tag.id = 'kris-ai-style';
    tag.textContent = STYLE;
    (document.head || document.documentElement).appendChild(tag);
  }

  var box = null;

  function build() {
    if (box && box.parentNode) return box;

    /* Prefer an explicit mount point; otherwise sit where the script tag is. */
    var mount = document.getElementById('kris-ai-memory');

    box = document.createElement('div');
    box.className = 'kris-ai-embed';

    var frame = document.createElement('iframe');
    frame.src = ORIGIN + '/embed';
    frame.title = 'Kris AI Memory';
    frame.loading = 'eager';
    frame.setAttribute('allow', 'microphone ' + ORIGIN);
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    box.appendChild(frame);

    if (mount) {
      mount.textContent = '';
      mount.appendChild(box);
    } else if (self && self.parentNode) {
      self.parentNode.insertBefore(box, self);
    } else {
      (document.body || document.documentElement).appendChild(box);
    }
    return box;
  }

  /* ---- is this even the right page? ------------------------------------

     Dropped into the site-wide Head Code instead of the page, this would run on
     every page of the store and put the widget above the header. Checked rather
     than trusted, because visitors should never see that.

     The test is the store's own header: on the intended page the widget sits
     after it; hoisted out of <head> it sits before it. Slug-independent, so
     renaming the page cannot trip it. Fails OPEN - with no header to compare
     against the widget stays, since hiding it where it belongs would be worse
     than the thing being guarded against.
     -------------------------------------------------------------------- */

  var misplaced = false;

  function checkPlacement() {
    var header = document.querySelector('header');
    if (!box || !header) return false;
    if (!(box.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;

    misplaced = true;
    if (box.parentNode) box.parentNode.removeChild(box);
    console.error(
      '[st-kris] This is loading above the site header, which means the two ' +
        'lines were pasted into Settings > Snippets > Head Code. They belong in ' +
        'the Kris AI Memory page > Custom HTML block. The widget has been ' +
        'removed so visitors do not see it on every page.'
    );
    return true;
  }

  /* ---- height ----------------------------------------------------------

     The widget scrolls its own messages and that internal scroll is the one to
     keep. The OUTER one is the problem: a fixed height makes the page taller
     than the window once the store's header, section padding and footer are
     added, so the page scrolls as well.

     Measured on the live page, the footer is what overflows - 53px past the
     window at 1366x768. So: take the room below the widget, then subtract
     whatever the page still overflows by, and repeat. That absorbs the footer,
     the section padding and the admin bar without needing to know any of their
     heights. calc() cannot do this.
     -------------------------------------------------------------------- */

  var fitting = false;

  function fit() {
    if (fitting || misplaced || !box || !box.parentNode) return;

    fitting = true;
    try {
      box.style.visibility = '';

      var top = box.getBoundingClientRect().top + (window.pageYOffset || 0);
      var height = window.innerHeight - top;

      for (var pass = 0; pass < 4; pass++) {
        var applied = Math.max(MIN_HEIGHT, Math.round(height));
        box.style.height = applied + 'px';

        var root = document.documentElement;
        var over = root.scrollHeight - root.clientHeight;
        if (over <= 1) break;

        /* Already as small as it is allowed to be. On a very short window
           something has to give, and better the page than an unusable widget. */
        if (applied <= MIN_HEIGHT) break;

        height = applied - over;
      }
    } finally {
      fitting = false;
    }
  }

  /* Uscreen swaps pages with Turbo, without a reload. A cross-origin iframe can
     keep painting for a frame or two after its container has gone, which looks
     like the widget floating over the top of the next page. */
  function hideWhileLeaving() {
    if (box) box.style.visibility = 'hidden';
  }

  /* ---- who is signed in? -----------------------------------------------

     The widget runs on its own origin inside the iframe, so it cannot read the
     Uscreen session cookie. This asks Uscreen and tells it.

     GET /account, same-origin, NO Accept header. Measured on this store:

       signed out, no Accept header   ->  401   (auth answers before format)
       signed out, Accept: text/html  ->  302   to the sign-in page
       signed in,  no Accept header   ->  200   the account page
       signed in,  Accept: json       ->  406   that route only renders HTML

     Asking for JSON was an earlier mistake: right when signed out, 406 when
     signed in, which read as "cannot tell" and showed members the sign-in
     screen. 406 now counts as signed in, since reaching it means auth passed.

     It deliberately does NOT read the DOM for a sign-in link: this store keeps
     an <a href="/sign_in"> in a menu even when signed in, and the visible
     control is a <ds-button>, not an <a>.

     The page is public, so this claim is what carries the gate. No answer, no
     session - it fails closed. Not cryptographic; MEMBER_GATE_MODE=strict with
     the Uscreen Publisher API key is what makes it so.
     -------------------------------------------------------------------- */

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

  function probeAccount() {
    return fetch('/account', { credentials: 'same-origin' })
      .then(function (res) {
        var path = '';
        try {
          path = new URL(res.url, location.href).pathname;
        } catch (e) {}

        if (/\/(sign_in|login|join)\b/.test(path)) {
          return { signedIn: false, via: '/account -> ' + path };
        }
        if (res.status === 401 || res.status === 403) {
          return { signedIn: false, via: '/account ' + res.status };
        }
        if (res.status === 406) {
          return { signedIn: true, email: '', via: '/account 406' };
        }
        if (!res.ok) return null;

        return res.text().then(function (text) {
          return { signedIn: true, email: emailFrom(text), via: '/account 200' };
        });
      })
      .catch(function () {
        return null;
      });
  }

  function emailFromDom() {
    var text = document.body ? document.body.innerText || '' : '';
    var m = text.match(EMAIL_RE);
    return m ? m[0] : '';
  }

  function resolveMember() {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;

    pending = probeAccount().then(function (result) {
      pending = null;

      if (!result) {
        /* Not cached - a network blip must not lock a member out for the visit. */
        console.warn('[st-kris] could not reach /account; treating as signed out');
        return { signedIn: false, via: 'probe failed', transient: true };
      }

      if (result.signedIn && !result.email) {
        var domEmail = emailFromDom();
        if (domEmail) {
          result.email = domEmail;
          result.via += ' + email from the profile menu';
        }
      }

      cached = result;
      console.log(
        '[st-kris] signedIn=' + result.signedIn +
          ' email=' + (result.email || '(none)') +
          ' via ' + result.via
      );
      return result;
    });

    return pending;
  }

  function answer(frame, member) {
    try {
      frame.postMessage(
        {
          type: 'st-kris:identity',
          signedIn: member.signedIn === true,
          email: (member.signedIn && member.email) || '',
          uscreenId: '',
        },
        ORIGIN
      );
    } catch (e) {
      /* frame went away */
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== ORIGIN) return;

    var data = event.data;
    if (!data) return;

    if (data.type === 'kris-ai:gated') {
      console.log('[st-kris] widget gated this visitor: ' + data.reason);
      return;
    }
    if (data.type !== 'kris-ai:ready') return;

    var frame = event.source;
    resolveMember().then(function (member) {
      answer(frame, member);

      /* If Uscreen simply did not answer in time, try once more. The widget
         listens for a late identity and retries, so a member is not left
         looking at the sign-in screen. */
      if (member.transient) {
        setTimeout(function () {
          resolveMember().then(function (second) {
            if (second.signedIn) answer(frame, second);
          });
        }, 1500);
      }
    });
  });

  /* ---- wire it up ------------------------------------------------------- */

  function boot() {
    injectStyle();
    build();
    if (checkPlacement()) return;
    fit();
  }

  injectStyle();
  build();
  fit();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.addEventListener('load', fit);
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  document.addEventListener('turbo:load', boot);

  /* Earliest signal that we are leaving, and it does not wait on Turbo. */
  document.addEventListener(
    'click',
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link) return;
      try {
        var to = new URL(link.getAttribute('href'), location.href);
        if (to.pathname !== location.pathname || to.origin !== location.origin) {
          hideWhileLeaving();
        }
      } catch (e) {
        /* not a URL we can read */
      }
    },
    true
  );
  document.addEventListener('turbo:before-visit', hideWhileLeaving);
  document.addEventListener('turbo:visit', hideWhileLeaving);
  document.addEventListener('turbo:before-render', hideWhileLeaving);
  window.addEventListener('pagehide', hideWhileLeaving);

  /* Fonts and images landing late change the header's height. */
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(fit).observe(document.body);
    } catch (e) {
      /* the resize listener still covers the common case */
    }
  }

  /* Warm the lookup so the answer is ready the moment the widget asks. */
  resolveMember();
})();
