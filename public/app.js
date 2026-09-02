/* ===========================================================================
   Kris AI Memory - client

   Boot
     1. In embed mode, announce readiness to the parent and wait briefly for it
        to post the signed-in member's identity.
     2. Exchange that for a session cookie via POST /api/session. The server
        verifies the claim against Uscreen; the browser is never trusted.
     3. Granted -> chat. Denied -> the gate, which links out to /join.

   BuddyPro holds conversation history server side, so only the newest message
   is ever sent. Prior turns are deliberately not replayed.

   CALL
   BuddyPro has no realtime voice, no streaming, and this instance rejects audio
   entirely (see README). The call is therefore assembled in the browser:
   SpeechRecognition for speech to text, BuddyPro for the answer, and
   speechSynthesis to speak it. That makes the call genuinely usable without any
   upstream audio support. The trade-off is the voice: it is the browser's, not
   a clone of Kris's.
   =========================================================================== */

(function () {
  'use strict';

  var BOOT = JSON.parse(document.getElementById('bootstrap').textContent);

  var SUGGESTIONS = [
    'Where do I start? Books, podcasts, studies, proposals, StrategyTraining or Kris/Michael AI?',
    'I am really struggling to get promoted, working in a Fortune 1000 company.',
    'What is the one thing you have noticed with all clients you mentor?',
  ];

  var WELCOME =
    "Welcome to StrategyTraining. I'm Kris Safarova, Founder and CEO of StrategyTraining " +
    "and FIRMSconsulting. I'm here to help you develop strategy, leadership, consulting, and " +
    "critical thinking skills. Whether you're advancing your career, solving business " +
    "challenges, or preparing for consulting, I'll guide you with practical insights and " +
    'proven frameworks. How can I help you today?';

  var IDENTITY_WAIT_MS = 1200;
  var HISTORY_KEY = 'kris_ai_history_v1';
  var BUDGET_KEY = 'kris_ai_call_seconds_v1';
  var HISTORY_MAX = 100;
  var CALL_BUDGET_SECONDS = 100 * 60;

  var SPARK_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2l1.5 5.2L19 9l-5.5 1.8L12 16l-1.5-5.2L5 9l5.5-1.8z"/>' +
    '<path d="M18.4 14.2l.7 2.4 2.4.7-2.4.7-.7 2.4-.7-2.4-2.4-.7 2.4-.7z"/></svg>';

  /* ---- refs ------------------------------------------------------------- */
  var app = document.getElementById('app');
  var gate = document.getElementById('gate');
  var gateTitle = document.getElementById('gateTitle');
  var gateBody = document.getElementById('gateBody');
  var gateJoin = document.getElementById('gateJoin');
  var gateSignIn = document.getElementById('gateSignIn');

  var scroll = document.getElementById('scroll');
  var intro = document.getElementById('intro');
  var thread = document.getElementById('thread');
  var scrollDown = document.getElementById('scrollDown');

  var form = document.getElementById('form');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('sendBtn');
  var micBtn = document.getElementById('micBtn');
  var notice = document.getElementById('notice');

  var chatBtn = document.getElementById('chatBtn');
  var callBtn = document.getElementById('callBtn');
  var headerCallBtn = document.getElementById('headerCallBtn');

  var suggestList = document.getElementById('suggestList');
  var suggestDock = document.getElementById('suggestDock');
  var suggestToggle = document.getElementById('suggestToggle');
  var suggestDockList = document.getElementById('suggestDockList');

  var historyBtn = document.getElementById('historyBtn');
  var historyPanel = document.getElementById('history');
  var historyBody = document.getElementById('historyBody');
  var historyClose = document.getElementById('historyClose');
  var historyClear = document.getElementById('historyClear');

  var callView = document.getElementById('callView');
  var callStart = document.getElementById('callStart');
  var callBack = document.getElementById('callBack');
  var callMic = document.getElementById('callMic');
  var callEnd = document.getElementById('callEnd');
  var callStatus = document.getElementById('callStatus');
  var callStatusText = document.getElementById('callStatusText');
  var callBars = document.getElementById('callBars');
  var callDots = document.getElementById('callDots');
  var callClock = document.getElementById('callClock');
  var callBudget = document.getElementById('callBudget');

  var recTime = document.getElementById('recTime');
  var recWave = document.getElementById('recWave');
  var recSend = document.getElementById('recSend');
  var recCancel = document.getElementById('recCancel');

  var isEmbed = app.getAttribute('data-mode') === 'embed';
  var busy = false;
  var inThread = false;

  /* The session token lives in memory only - never in localStorage, and never
     in a cookie the embed could not rely on anyway. Safari blocks third-party
     cookies outright and Chrome is restricting them, so the cross-site iframe
     authenticates with a bearer header instead. Memory-only also means an XSS
     later cannot read it back out of storage. */
  var sessionToken = null;
  var handoffToken = null;

  gateJoin.href = BOOT.joinUrl;
  gateSignIn.href = BOOT.signInUrl;

  /* ---- helpers ---------------------------------------------------------- */

  function showNotice(text) {
    notice.textContent = text;
    notice.classList.add('is-shown');
  }
  function hideNotice() {
    notice.classList.remove('is-shown');
  }

  function api(path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;

    return fetch(path, {
      method: 'POST',
      /* Send the cookie too where the browser allows it - harmless, and it
         keeps the standalone page working on its own origin. */
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
    });
  }

  /* ---- local transcript ------------------------------------------------- */

  /* Every storage call is guarded: private windows and blocked site data make
     localStorage throw on access, not just return null. */
  function readStore(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* over quota or blocked - everything still works */
    }
  }

  /* History is a list of CONVERSATIONS, not loose turns - the reference groups
     them under date headings and marks each as a chat or a call. */
  var CONV_KEY = 'kris_ai_conversations_v1';
  var CONV_MAX = 60;
  var currentConvId = null;

  function readConversations() {
    var parsed = readStore(CONV_KEY, null);
    if (Array.isArray(parsed)) return parsed;

    /* One-time migration from the old flat per-turn store. */
    var legacy = readStore(HISTORY_KEY, []);
    if (Array.isArray(legacy) && legacy.length) {
      var first = legacy.filter(function (e) {
        return e.role === 'me';
      })[0];
      var migrated = [
        {
          id: 'legacy',
          kind: 'chat',
          title: (first && first.text) || 'Earlier conversation',
          at: legacy[0].at || Date.now(),
          turns: legacy,
        },
      ];
      writeStore(CONV_KEY, migrated);
      return migrated;
    }
    return [];
  }

  function startConversation(kind, title) {
    currentConvId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var list = readConversations();
    /* A call carries no typed question, so it is named up front - otherwise it
       would have no title and never appear in history. */
    list.push({
      id: currentConvId,
      kind: kind || 'chat',
      title: title || '',
      at: Date.now(),
      turns: [],
    });
    writeStore(CONV_KEY, list.slice(-CONV_MAX));
    return currentConvId;
  }

  function recordTurn(role, text) {
    if (!text) return;
    if (!currentConvId) startConversation('chat');

    var list = readConversations();
    var conv = null;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].id === currentConvId) {
        conv = list[i];
        break;
      }
    }
    if (!conv) {
      conv = { id: currentConvId, kind: 'chat', title: '', at: Date.now(), turns: [] };
      list.push(conv);
    }

    conv.turns.push({ role: role, text: text, at: Date.now() });
    if (conv.turns.length > HISTORY_MAX) conv.turns = conv.turns.slice(-HISTORY_MAX);

    /* The first thing the member says names the conversation. */
    if (!conv.title && role === 'me') {
      conv.title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    writeStore(CONV_KEY, list.slice(-CONV_MAX));
  }

  /* "Today" / "Yesterday" / "August 30", matching the reference. */
  function dayLabel(ms) {
    var then = new Date(ms);
    var today = new Date();
    var startOf = function (d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    var days = Math.round((startOf(today) - startOf(then)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return then.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }

  var CHAT_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4.5" width="18" height="13" rx="2.5"/><path d="M7.5 20l3-2.5"/></svg>';
  var CALL_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 ' +
    '.4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 ' +
    '3.5.1.4 0 .8-.2 1z"/></svg>';

  function renderHistory() {
    var list = readConversations().filter(function (conv) {
      return conv && conv.turns && conv.turns.length && conv.title;
    });

    historyBody.textContent = '';

    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'history__empty';
      empty.textContent =
        'No conversations yet on this device. Kris remembers you either way, so you can ' +
        'pick up where you left off.';
      historyBody.appendChild(empty);
      return;
    }

    /* Newest first, grouped by day. */
    var groups = [];
    var index = {};
    list
      .slice()
      .sort(function (a, b) {
        return b.at - a.at;
      })
      .forEach(function (conv) {
        var label = dayLabel(conv.at);
        if (!index[label]) {
          index[label] = { label: label, items: [] };
          groups.push(index[label]);
        }
        index[label].items.push(conv);
      });

    groups.forEach(function (group) {
      var wrap = document.createElement('div');
      wrap.className = 'history__group';

      var heading = document.createElement('div');
      heading.className = 'history__date';
      heading.textContent = group.label;
      wrap.appendChild(heading);

      group.items.forEach(function (conv) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'history__item';
        item.innerHTML = conv.kind === 'call' ? CALL_ICON : CHAT_ICON;

        var title = document.createElement('span');
        title.className = 'history__q';
        title.textContent = conv.title;
        item.appendChild(title);

        item.addEventListener('click', function () {
          restoreConversation(conv.id);
          closeHistory();
        });

        wrap.appendChild(item);
      });

      historyBody.appendChild(wrap);
    });
  }

  function restoreConversation(id) {
    var list = readConversations();
    var conv = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) conv = list[i];
    }
    if (!conv || !conv.turns.length) return;

    thread.textContent = '';
    enterThread({ welcome: false });
    conv.turns.forEach(function (entry) {
      addTurn(entry.role === 'me' ? 'me' : 'kris', entry.text, { silent: true });
    });
    currentConvId = conv.id;
    scrollToEnd();
  }

  function openHistory() {
    renderHistory();
    historyPanel.hidden = false;
    historyPanel.classList.add('is-open');
  }
  function closeHistory() {
    historyPanel.classList.remove('is-open');
    historyPanel.hidden = true;
  }

  historyBtn.addEventListener('click', openHistory);
  historyClose.addEventListener('click', closeHistory);
  historyPanel.addEventListener('click', function (event) {
    if (event.target === historyPanel) closeHistory();
  });
  historyClear.addEventListener('click', function () {
    try {
      window.localStorage.removeItem(CONV_KEY);
      window.localStorage.removeItem(HISTORY_KEY);
      currentConvId = null;
    } catch (e) {
      /* nothing to do */
    }
    renderHistory();
  });

  /* ---- gate ------------------------------------------------------------- */

  var GATE_COPY = {
    not_subscribed: {
      title: 'Your membership does not include Kris AI Memory yet',
      body:
        'Kris AI Memory is included with an active StrategyTraining membership. Pick a plan to ' +
        'unlock it, or sign in with the account that holds your subscription.',
    },
    customer_not_found: {
      title: 'We could not find your membership',
      body:
        'Sign in with the StrategyTraining account that holds your subscription, then reopen ' +
        'Kris AI Memory. If you have just subscribed, give it a minute and refresh.',
    },
    customer_mismatch: {
      title: 'We could not confirm your membership',
      body: 'Please sign in again on StrategyTraining, then reopen Kris AI Memory.',
    },
    no_identity_from_store: {
      title: 'Please sign in to StrategyTraining',
      body:
        'Kris AI Memory needs to know who you are before it can open your conversation. ' +
        'Sign in on StrategyTraining, then come back to this page.',
    },
    no_session: {
      title: 'Please sign in to StrategyTraining',
      body: 'Kris AI Memory is included with your membership. Sign in to start a conversation.',
    },
    verification_unavailable: {
      title: 'We cannot check memberships right now',
      body:
        'This is on our side, not yours. Please try again in a few minutes - your membership is unaffected.',
    },
    untrusted_origin: {
      title: 'Open Kris AI Memory from StrategyTraining',
      body: 'For security, Kris AI Memory only runs inside StrategyTraining.com.',
    },
  };

  function showGate(reason) {
    var copy = GATE_COPY[reason] || GATE_COPY.no_session;
    gateTitle.textContent = copy.title;
    gateBody.textContent = copy.body;
    app.classList.remove('is-booting');
    app.classList.add('is-gated');
    postToParent({ type: 'kris-ai:gated', reason: reason || 'no_session' });
  }

  function openChat() {
    app.classList.remove('is-booting', 'is-gated');
    gate.hidden = true;
    input.focus({ preventScroll: true });
  }

  /* ---- parent bridge ---------------------------------------------------- */

  function allowedParents() {
    return BOOT.allowedParentOrigins || [];
  }

  function postToParent(msg) {
    if (!isEmbed || window.parent === window) return;
    /* Explicit origins only - never '*', which would leak to whatever page
       happens to be framing us. */
    allowedParents().forEach(function (origin) {
      try {
        window.parent.postMessage(msg, origin);
      } catch (e) {
        /* origin mismatch - ignore */
      }
    });
  }

  function requestIdentity() {
    if (!isEmbed || window.parent === window) return Promise.resolve({});

    return new Promise(function (resolve) {
      var settled = false;

      function done(identity) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(identity || {});
      }

      function onMessage(event) {
        if (allowedParents().indexOf(event.origin) === -1) return;
        var data = event.data;
        if (!data || data.type !== 'st-kris:identity') return;
        done({
          email: typeof data.email === 'string' ? data.email : '',
          uscreenId: data.uscreenId != null ? String(data.uscreenId) : '',
        });
      }

      window.addEventListener('message', onMessage);
      postToParent({ type: 'kris-ai:ready' });
      setTimeout(function () {
        done({});
      }, IDENTITY_WAIT_MS);
    });
  }

  /* ---- boot ------------------------------------------------------------- */

  function boot() {
    /* QA only, never enabled in production: ?gate=<reason> renders the gate. */
    if (BOOT.devPreview) {
      var forced = new URLSearchParams(location.search).get('gate');
      if (forced) return showGate(forced);
    }

    requestIdentity()
      .then(function (identity) {
        return api('/api/session', identity);
      })
      .then(function (res) {
        if (res.ok && res.data && res.data.ok) {
          sessionToken = res.data.token || null;
          handoffToken = res.data.handoff || null;
          openChat();

          /* Offer the host page a one-shot link to the standalone view. The
             token is valid for two minutes and single purpose, so it is safe to
             hand across and useless if copied later. */
          if (handoffToken) {
            postToParent({
              type: 'kris-ai:session',
              fullPageUrl: location.origin + '/?t=' + encodeURIComponent(handoffToken),
            });
          }
          return;
        }
        showGate(res.data && res.data.reason);
      })
      .catch(function () {
        showGate('verification_unavailable');
      });
  }

  /* ---- suggestions ------------------------------------------------------ */

  function buildChip(question) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.innerHTML = SPARK_SVG + '<span></span>';
    btn.querySelector('span').textContent = question;
    btn.addEventListener('click', function () {
      suggestDock.classList.remove('is-open');
      suggestToggle.setAttribute('aria-expanded', 'false');
      send(question);
    });
    return btn;
  }

  SUGGESTIONS.forEach(function (question) {
    suggestList.appendChild(buildChip(question));
    suggestDockList.appendChild(buildChip(question));
  });

  suggestToggle.addEventListener('click', function () {
    var open = suggestDock.classList.toggle('is-open');
    suggestToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---- markdown ---------------------------------------------------------
     A small, deliberately limited renderer built with DOM nodes rather than
     innerHTML, so model output can never inject markup. Handles bold, italics,
     markdown and bare links (as source chips) and [n] citation marks.
     -------------------------------------------------------------------- */

  var INLINE =
    /(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(https?:\/\/[^\s<>"')\]]+)|(\[(\d{1,2})\])/g;

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  }

  function linkChip(url, label) {
    var a = document.createElement('a');
    a.className = 'linkchip';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';

    var mark = document.createElement('span');
    mark.className = 'linkchip__mark';
    var text = label || hostLabel(url);
    mark.textContent = text.charAt(0).toUpperCase();

    var name = document.createElement('span');
    name.textContent = text;

    var out = document.createElement('span');
    out.className = 'linkchip__out';
    out.textContent = '↗';

    a.appendChild(mark);
    a.appendChild(name);
    a.appendChild(out);
    return a;
  }

  /* Strips stray emphasis markers the model sometimes leaves behind - the
     reference UI visibly shows these leaking, so clean them here. */
  function cleanText(text) {
    return text.replace(/\*\*/g, '').replace(/(^|\s)__(\s|$)/g, '$1$2');
  }

  function renderInline(target, text) {
    var lastIndex = 0;
    var match;
    INLINE.lastIndex = 0;

    while ((match = INLINE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        target.appendChild(document.createTextNode(cleanText(text.slice(lastIndex, match.index))));
      }

      if (match[1]) {
        /* [label](url) */
        target.appendChild(linkChip(match[3], match[2]));
      } else if (match[4] || match[6]) {
        var strong = document.createElement('strong');
        strong.textContent = match[5] || match[7];
        target.appendChild(strong);
      } else if (match[8]) {
        var em = document.createElement('em');
        em.textContent = match[9];
        target.appendChild(em);
      } else if (match[10]) {
        /* bare url */
        target.appendChild(linkChip(match[10]));
      } else if (match[11]) {
        var cite = document.createElement('span');
        cite.className = 'cite';
        cite.textContent = match[12];
        target.appendChild(cite);
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      target.appendChild(document.createTextNode(cleanText(text.slice(lastIndex))));
    }
  }

  /* The reference splits a long answer across several bubbles. Blank lines are
     the natural boundary; a single very long paragraph is left intact. */
  function splitBlocks(text) {
    return String(text)
      .split(/\n{2,}/)
      .map(function (block) {
        return block.trim();
      })
      .filter(Boolean);
  }

  /* ---- thread ----------------------------------------------------------- */

  function enterThread(opts) {
    var options = opts || {};
    if (inThread) return;
    inThread = true;
    app.classList.add('in-thread');

    if (options.welcome !== false) {
      addTurn('kris', WELCOME, { silent: true, store: false });
    }
  }

  /**
   * One turn = one speaker, rendered as one or more bubbles.
   * @returns {{turn:HTMLElement, bubbles:HTMLElement[], setText:Function}}
   */
  function addTurn(role, text, opts) {
    var options = opts || {};

    var turn = document.createElement('div');
    turn.className = 'turn turn--' + role;

    function paint(value) {
      turn.textContent = '';
      if (value === null) {
        var waiting = document.createElement('div');
        waiting.className = 'bubble';
        waiting.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
        waiting.setAttribute('aria-label', 'Kris is thinking');
        turn.appendChild(waiting);
        return;
      }
      splitBlocks(value).forEach(function (block) {
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        /* Single newlines inside a block stay as line breaks. */
        block.split('\n').forEach(function (line, index) {
          if (index) bubble.appendChild(document.createElement('br'));
          renderInline(bubble, line);
        });
        turn.appendChild(bubble);
      });
    }

    paint(text);
    thread.appendChild(turn);

    if (options.store !== false && text) recordTurn(role, text);
    if (!options.silent) scrollToEnd();

    return { turn: turn, setText: paint };
  }

  function scrollToEnd() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  /* ---- voice notes ------------------------------------------------------ */

  var PLAY_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M8 5.2v13.6a1 1 0 001.5.87l11-6.8a1 1 0 000-1.74l-11-6.8A1 1 0 008 5.2z"/></svg>';
  var PAUSE_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<rect x="6" y="4.5" width="4.2" height="15" rx="1.4"/>' +
    '<rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4"/></svg>';

  function formatSeconds(total) {
    var s = Math.max(0, Math.round(total || 0));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  /**
   * A voice note bubble.
   *
   * `src` plays real audio. Without one it speaks `speakText` through the
   * device voice instead - which is what happens for Kris, because BuddyPro
   * withholds its TTS from API-created profiles (measured; see README).
   */
  /**
   * A voice note, laid out the way Telegram does it: round play button, a
   * fine-grained waveform, duration underneath. Deliberately no transcript -
   * a voice message should be a voice message.
   *
   * `src` plays real audio. Without one it speaks `speakText` through the
   * device voice, which is what happens for Kris because BuddyPro currently
   * returns no audio through the API at all (measured; see README).
   */
  function buildVoiceBubble(spec) {
    var BARS = 38;

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    var box = document.createElement('div');
    box.className = 'voicebubble';

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'voicebubble__play';
    play.innerHTML = PLAY_SVG;
    play.setAttribute('aria-label', 'Play voice message');

    var body = document.createElement('div');
    body.className = 'voicebubble__body';

    var wave = document.createElement('div');
    wave.className = 'voicebubble__wave';
    var bars = [];
    for (var i = 0; i < BARS; i++) {
      var bar = document.createElement('i');
      /* Deterministic pseudo-random heights, so a note looks like a waveform
         and never reshuffles on re-render. */
      var n = Math.sin(i * 1.9 + (spec.seed || 1) * 1.3) * Math.cos(i * 0.7 + (spec.seed || 1));
      bar.style.height = (4 + ((n + 1) / 2) * 14).toFixed(1) + 'px';
      wave.appendChild(bar);
      bars.push(bar);
    }

    var meta = document.createElement('div');
    meta.className = 'voicebubble__meta';

    function metaText(seconds) {
      var text = formatClock(Math.round(seconds || 0));
      if (spec.bytes) text += ', ' + (spec.bytes / 1024).toFixed(1) + ' KB';
      return text;
    }
    meta.textContent = metaText(spec.seconds);

    body.appendChild(wave);
    body.appendChild(meta);
    box.appendChild(play);
    box.appendChild(body);
    bubble.appendChild(box);

    function paint(ratio) {
      var upto = Math.round(ratio * BARS);
      for (var b = 0; b < BARS; b++) bars[b].classList.toggle('is-played', b < upto);
    }
    function reset() {
      box.classList.remove('is-playing');
      play.innerHTML = PLAY_SVG;
      paint(0);
      meta.textContent = metaText(spec.seconds);
    }

    /* --- real audio --- */
    if (spec.src) {
      var player = new Audio(spec.src);
      player.addEventListener('loadedmetadata', function () {
        if (isFinite(player.duration)) {
          spec.seconds = player.duration;
          meta.textContent = metaText(player.duration);
        }
      });
      player.addEventListener('timeupdate', function () {
        if (player.duration) {
          paint(player.currentTime / player.duration);
          meta.textContent = metaText(player.duration - player.currentTime);
        }
      });
      player.addEventListener('ended', reset);

      play.addEventListener('click', function () {
        if (player.paused) {
          player.play().catch(function () {});
          box.classList.add('is-playing');
          play.innerHTML = PAUSE_SVG;
        } else {
          player.pause();
          box.classList.remove('is-playing');
          play.innerHTML = PLAY_SVG;
        }
      });

      bubble.__play = function () {
        player.play().catch(function () {});
        box.classList.add('is-playing');
        play.innerHTML = PAUSE_SVG;
      };
      return bubble;
    }

    /* --- spoken by the device --- */
    var progressTimer = null;

    function stopSpeaking() {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
      try {
        if (synth) synth.cancel();
      } catch (e) {
        /* ignore */
      }
      reset();
    }

    function startSpeaking() {
      if (!synth) return;
      speak(spec.speakText || '', {
        onStart: function (estimate) {
          spec.seconds = estimate;
          meta.textContent = metaText(estimate);
          box.classList.add('is-playing');
          play.innerHTML = PAUSE_SVG;

          var began = Date.now();
          if (progressTimer) clearInterval(progressTimer);
          progressTimer = setInterval(function () {
            var elapsed = (Date.now() - began) / 1000;
            paint(Math.min(1, elapsed / Math.max(1, estimate)));
            meta.textContent = metaText(Math.max(0, estimate - elapsed));
          }, 120);
        },
        onEnd: function () {
          if (progressTimer) clearInterval(progressTimer);
          progressTimer = null;
          reset();
        },
      });
    }

    play.addEventListener('click', function () {
      if (box.classList.contains('is-playing')) stopSpeaking();
      else startSpeaking();
    });

    bubble.__play = startSpeaking;
    return bubble;
  }

  function addVoiceTurn(role, spec) {
    var turn = document.createElement('div');
    turn.className = 'turn turn--' + role;

    var bubble = buildVoiceBubble({
      src: spec.src || null,
      speakText: spec.speakText || '',
      bytes: spec.bytes || 0,
      seconds: spec.seconds || 0,
      seed: thread.children.length + 1,
    });

    turn.appendChild(bubble);
    thread.appendChild(turn);
    scrollToEnd();
    return { turn: turn, bubble: bubble, play: bubble.__play };
  }

  /* The floating jump button only earns its place when there is hidden content
     below the fold. */
  function syncScrollDown() {
    var distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    scrollDown.classList.toggle('is-shown', inThread && distance > 120);
  }
  scroll.addEventListener('scroll', syncScrollDown);
  scrollDown.addEventListener('click', scrollToEnd);

  function setBusy(state) {
    busy = state;
    sendBtn.disabled = state;
    input.disabled = state;
  }

  /* ---- send ------------------------------------------------------------- */

  /**
   * @param {string} text
   * @param {{silentUser?:boolean, onReply?:Function}} [opts]
   */
  function send(text, opts) {
    var options = opts || {};
    var message = (text || '').trim();
    if (busy) return Promise.resolve(null);
    /* A voice message can carry audio even with no usable transcript. */
    if (!message && !options.audio) return Promise.resolve(null);

    hideNotice();
    enterThread();

    if (!options.silentUser) {
      if (options.voice) {
        /* A recorded question is shown as a voice note, the way a messenger
           does it, with the transcript kept small underneath. */
        addVoiceTurn('me', {
          src: options.voice.src,
          seconds: options.voice.seconds,
          bytes: options.voice.bytes,
          text: message,
        });
        recordTurn('me', message);
      } else {
        addTurn('me', message);
      }
    }
    input.value = '';
    armSend();

    var pending = addTurn('kris', null, { store: false });
    setBusy(true);

    return api('/api/chat', {
      message: message,
      audio: options.audio || undefined,
      audioFormat: options.audio ? options.audioFormat || 'wav' : undefined,
      intent: options.intent || undefined,
      wantAudio: options.wantAudio === true,
    })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401) {
            showGate((res.data && res.data.reason) || 'no_session');
            return null;
          }
          if (options.quiet) {
            pending.turn.remove();
            return null;
          }
          pending.turn.classList.add('turn--error');
          pending.setText(
            (res.data && res.data.error) || 'That did not go through. Try again in a moment.'
          );
          return null;
        }

        var content = (res.data && res.data.content) || '';
        var replyAudio = (res.data && res.data.audio) || null;
        recordTurn('kris', content);

        /* A spoken question deserves a spoken answer. BuddyPro's own voice is
           used when it sends one; otherwise the note plays through the device
           voice, with the text kept underneath so nothing is lost. */
        if (options.spokenReply) {
          pending.turn.remove();
          var note = addVoiceTurn('kris', {
            src: replyAudio,
            speakText: content,
            text: content,
            seconds: 0,
          });
          if (note.play) note.play();
        } else {
          pending.setText(content);
        }

        return { content: content, audio: replyAudio };
      })
      .catch(function () {
        if (options.quiet) {
          pending.turn.remove();
          return null;
        }
        pending.turn.classList.add('turn--error');
        pending.setText('Connection lost. Try again in a moment.');
        return null;
      })
      .then(function (reply) {
        setBusy(false);
        scrollToEnd();
        syncScrollDown();
        if (!inCall) input.focus({ preventScroll: true });
        if (options.onReply) options.onReply(reply);
        return reply;
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    send(input.value);
  });

  /* Which language the SPEECH RECOGNISER listens in. Follows the browser, so a
     member's own locale transcribes accurately. The REPLY language is decided
     server side (RESPONSE_LANGUAGE) - BuddyPro drifts otherwise. */
  function currentLanguage() {
    return navigator.language || 'en-US';
  }

  function armSend() {
    sendBtn.classList.toggle('is-armed', input.value.trim().length > 0);
  }
  input.addEventListener('input', armSend);

  chatBtn.addEventListener('click', function () {
    enterThread();
    input.focus();
    scrollToEnd();
  });

  /* ---- speech engine ----------------------------------------------------
     Both the composer recorder and the call use the browser's speech engine.
     BuddyPro rejects audio uploads on this instance (measured), so speech is
     transcribed here and only text is sent up.
     -------------------------------------------------------------------- */

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  var speechSupported = !!SpeechRecognitionCtor;
  var synth = window.speechSynthesis || null;

  if (!speechSupported) {
    micBtn.hidden = true;
    micBtn.disabled = true;
  }

  /* How long a pause counts as "they have finished speaking", and the hard cap
     on one utterance. */
  var SILENCE_MS = 1500;
  var MAX_UTTERANCE_MS = 30000;

  /**
   * One spoken turn, with endpointing we control.
   *
   * Chrome's own endpointing is unreliable: with continuous=false it often keeps
   * the session open long after the speaker stops, and it may never mark a
   * result `isFinal`. Waiting for `onend` therefore hangs on "Listening" and
   * discards perfectly good interim text - which is exactly what happened.
   *
   * So: continuous=true (Chrome never decides), a silence timer decides, and
   * interim text counts. Pass silenceMs:0 to disable the pause detector when the
   * caller ends the turn itself. Returns a handle with stop() and abort().
   */
  function listenOnce(options) {
    var rec = new SpeechRecognitionCtor();
    rec.lang = options.lang || currentLanguage();
    rec.interimResults = true;
    rec.continuous = true;

    var finalText = '';
    var interimText = '';
    var settled = false;
    var silenceTimer = null;
    var maxTimer = null;

    function transcript() {
      return (finalText + ' ' + interimText).replace(/\s+/g, ' ').trim();
    }

    function clearTimers() {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (maxTimer) clearTimeout(maxTimer);
      silenceTimer = null;
      maxTimer = null;
    }

    function settle(handler, value) {
      if (settled) return;
      settled = true;
      clearTimers();
      try {
        rec.stop();
      } catch (e) {
        /* already stopping */
      }
      if (handler) handler(value);
    }

    function armSilence() {
      /* silenceMs: 0 means the caller ends the turn, not a pause - that is how
         the composer recorder works, so a thinking pause never cuts you off. */
      if (options.silenceMs === 0) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(function () {
        /* Only end the turn if something was actually said. Silence with no
           speech yet just means they have not started. */
        if (transcript()) settle(options.onResult, transcript());
      }, options.silenceMs || SILENCE_MS);
    }

    rec.onresult = function (event) {
      interimText = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript + ' ';
        else interimText += result[0].transcript;
      }
      if (options.onInterim) options.onInterim(transcript());
      armSilence();
    };

    rec.onerror = function (event) {
      /* 'no-speech' and 'aborted' are routine - a quiet moment, or our own
         abort() - and must not tear the turn down. */
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (settled) return;
      settled = true;
      clearTimers();
      if (options.onError) options.onError(event.error);
    };

    rec.onend = function () {
      if (settled) return;
      settled = true;
      clearTimers();
      var text = transcript();
      if (text && options.onResult) options.onResult(text);
      else if (!text && options.onEmpty) options.onEmpty();
    };

    maxTimer = setTimeout(function () {
      if (transcript()) settle(options.onResult, transcript());
      else settle(options.onEmpty, null);
    }, options.maxMs || MAX_UTTERANCE_MS);

    try {
      rec.start();
    } catch (e) {
      /* start() throws if one is already running */
    }

    return {
      /* Finish now and use whatever has been heard. */
      stop: function () {
        settle(options.onResult, transcript());
      },
      /* Throw the turn away. */
      abort: function () {
        if (settled) return;
        settled = true;
        clearTimers();
        try {
          rec.abort();
        } catch (e) {
          /* already stopped */
        }
      },
    };
  }


  /* ---- audio conversion -------------------------------------------------
     BuddyPro accepts mp3, wav, ogg, aac and flac - and returns spoken replies
     ONLY when the request carries audio input (their docs are explicit). Chrome
     can only record WebM/Opus, which BuddyPro rejects, so every recording is
     decoded and re-encoded as 16 kHz mono WAV before it is sent. Measured:
     that round trip comes back HTTP 200 with mp3 audio in Kris's own voice.
     -------------------------------------------------------------------- */

  var TARGET_RATE = 16000;

  function encodeWav(samples, sampleRate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function str(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    var dataBytes = samples.length * 2;
    str(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, dataBytes, true);
    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      var v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /** Recorded blob -> base64 16 kHz mono WAV, ready to send. */
  function toWavBase64(blob) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx || !blob) return Promise.reject(new Error('no_audio_context'));

    return blob
      .arrayBuffer()
      .then(function (raw) {
        var ctx = new Ctx();
        return new Promise(function (resolve, reject) {
          ctx.decodeAudioData(
            raw,
            function (decoded) {
              ctx.close();
              resolve(decoded);
            },
            function (err) {
              ctx.close();
              reject(err || new Error('decode_failed'));
            }
          );
        });
      })
      .then(function (decoded) {
        if (!Offline) return encodeWav(decoded.getChannelData(0), Math.round(decoded.sampleRate));
        var frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
        var offline = new Offline(1, frames, TARGET_RATE);
        var source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(0);
        return offline.startRendering().then(function (rendered) {
          return encodeWav(rendered.getChannelData(0), TARGET_RATE);
        });
      })
      .then(function (wav) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve(String(reader.result).split(',')[1]);
          };
          reader.onerror = reject;
          reader.readAsDataURL(wav);
        });
      });
  }
  /* ---- composer recorder (tap to record, then send) ---------------------
     Modelled on a messenger: tapping the microphone turns the composer into a
     recorder with a timer, a live level trace, cancel and send. The turn ends
     when the member sends it, never on a pause, so thinking mid-sentence
     cannot cut them off.

     Two things run at once: MediaRecorder captures the audio so the question
     can be shown as a real voice note, and SpeechRecognition transcribes it
     because BuddyPro rejects audio uploads on this instance (measured). The
     recording is played back locally; the transcript is what is sent.
     -------------------------------------------------------------------- */

  var recording = null;

  /* Takes the state explicitly. Reading the module-level `recording` here was a
     bug: finishRecording() nulls it before calling this, so the interval was
     never cleared and every recording leaked a ticker. Several leaked tickers
     then wrote to the same timer element from their own start times, which is
     why the clock showed the age of the page and jumped between values. */
  function stopRecordingUi(state) {
    form.classList.remove('is-recording');
    if (!state) return;
    if (state.ticker) clearInterval(state.ticker);
    if (state.raf) cancelAnimationFrame(state.raf);
    state.ticker = null;
    state.raf = null;
  }

  function beginRecording() {
    var state = {
      listener: null,
      recorder: null,
      chunks: [],
      stream: null,
      audioCtx: null,
      analyser: null,
      startedAt: Date.now(),
      ticker: null,
      raf: null,
      text: '',
    };
    recording = state;

    form.classList.add('is-recording');
    recTime.textContent = '0:00';
    /* Belt and braces: clear anything a previous turn might have left running. */
    if (window.__krisRecTickers) {
      window.__krisRecTickers.forEach(function (id) {
        clearInterval(id);
      });
    }
    window.__krisRecTickers = [];
    hideNotice();

    /* Level trace. */
    recWave.textContent = '';
    var bars = [];
    for (var i = 0; i < 30; i++) {
      var bar = document.createElement('i');
      recWave.appendChild(bar);
      bars.push(bar);
    }

    state.ticker = setInterval(function () {
      /* Only the live recording may write the clock. */
      if (recording !== state) {
        clearInterval(state.ticker);
        return;
      }
      recTime.textContent = formatSeconds((Date.now() - state.startedAt) / 1000);
    }, 250);
    window.__krisRecTickers.push(state.ticker);

    if (navigator.mediaDevices && window.MediaRecorder) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          if (!recording) {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            return;
          }
          state.stream = stream;

          try {
            state.recorder = new MediaRecorder(stream);
            state.recorder.ondataavailable = function (e) {
              if (e.data && e.data.size) state.chunks.push(e.data);
            };
            state.recorder.start();
          } catch (e) {
            state.recorder = null;
          }

          /* Drive the trace from real amplitude. */
          try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) {
              state.audioCtx = new Ctx();
              var source = state.audioCtx.createMediaStreamSource(stream);
              state.analyser = state.audioCtx.createAnalyser();
              state.analyser.fftSize = 256;
              source.connect(state.analyser);

              var buffer = new Uint8Array(state.analyser.fftSize);
              var levels = [];
              var draw = function () {
                if (!recording || !state.analyser) return;
                state.analyser.getByteTimeDomainData(buffer);
                var sum = 0;
                for (var n = 0; n < buffer.length; n++) {
                  var d = (buffer[n] - 128) / 128;
                  sum += d * d;
                }
                var rms = Math.sqrt(sum / buffer.length);
                levels.push(rms);
                while (levels.length > bars.length) levels.shift();

                for (var b = 0; b < bars.length; b++) {
                  var v = levels[levels.length - bars.length + b] || 0;
                  var h = Math.max(3, Math.min(22, v * 70));
                  bars[b].style.height = h.toFixed(1) + 'px';
                  bars[b].classList.toggle('is-hot', v > 0.04);
                }
                state.raf = requestAnimationFrame(draw);
              };
              state.raf = requestAnimationFrame(draw);
            }
          } catch (e) {
            /* trace is decoration; recording still works */
          }
        })
        .catch(function () {
          /* No microphone for MediaRecorder - recognition may still work. */
        });
    }

    function releaseStream() {
      if (state.audioCtx && state.audioCtx.state !== 'closed') {
        state.audioCtx.close().catch(function () {});
      }
      state.audioCtx = null;
      state.analyser = null;
      if (state.stream) {
        state.stream.getTracks().forEach(function (t) {
          t.stop();
        });
        state.stream = null;
      }
    }

    state.collect = function (then) {
      if (!state.recorder || state.recorder.state !== 'recording') {
        releaseStream();
        then(null);
        return;
      }
      state.recorder.onstop = function () {
        var blob = state.chunks.length
          ? new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' })
          : null;
        state.chunks = [];
        releaseStream();
        then(blob ? { src: URL.createObjectURL(blob), bytes: blob.size, blob: blob } : null);
      };
      try {
        state.recorder.stop();
      } catch (e) {
        releaseStream();
        then(null);
      }
    };

    state.listener = listenOnce({
      lang: currentLanguage(),
      silenceMs: 0, // the member decides when the message is finished
      maxMs: 120000,
      onInterim: function (text) {
        state.text = text;
      },
      onResult: function (text) {
        state.text = text || state.text;
        finishRecording(true);
      },
      onEmpty: function () {
        finishRecording(true);
      },
      onError: function (err) {
        var dead = recording;
        recording = null;
        stopRecordingUi(dead);
        releaseStream();
        showNotice(
          err === 'not-allowed' || err === 'service-not-allowed'
            ? 'Microphone permission was declined.'
            : 'Could not hear anything. Try again, or type your question.'
        );
      },
    });
  }

  /** @param {boolean} keep send it, or throw it away */
  function finishRecording(keep) {
    var state = recording;
    if (!state) return;
    recording = null;
    stopRecordingUi(state);

    var seconds = (Date.now() - state.startedAt) / 1000;
    var text = (state.text || '').trim();

    if (state.listener) {
      if (keep) state.listener.stop();
      else state.listener.abort();
    }

    if (!keep) {
      state.collect(function (clip) {
        if (clip && clip.src) URL.revokeObjectURL(clip.src);
      });
      return;
    }

    state.collect(function (clip) {
      if (!text && !clip) {
        showNotice('I did not catch that. Try again, or type your question.');
        return;
      }

      var voice = {
        src: clip ? clip.src : null,
        bytes: clip ? clip.bytes : 0,
        seconds: seconds,
      };

      /* Send the recording itself. BuddyPro only returns a spoken reply when the
         request carries audio, so this is what gets Kris's own voice back rather
         than the device voice. The transcript rides along for history, and is
         the fallback if conversion fails. */
      if (!clip || !clip.blob) {
        send(text, { voice: voice, wantAudio: true, spokenReply: true });
        return;
      }

      toWavBase64(clip.blob)
        .then(function (base64) {
          send(text, {
            voice: voice,
            audio: base64,
            audioFormat: 'wav',
            wantAudio: true,
            spokenReply: true,
          });
        })
        .catch(function () {
          send(text, { voice: voice, wantAudio: true, spokenReply: true });
        });
    });
  }

  micBtn.addEventListener('click', function () {
    if (!speechSupported) {
      showNotice('Voice messages need Chrome or Edge. Type your question instead.');
      return;
    }
    if (recording) return;
    beginRecording();
  });

  recSend.addEventListener('click', function () {
    finishRecording(true);
  });

  recCancel.addEventListener('click', function () {
    finishRecording(false);
  });


  /* ---- call ------------------------------------------------------------- */

  var inCall = false;
  var callLive = false;
  var muted = false;
  var recognition = null;
  var callTimer = null;
  var callSeconds = 0;
  var spentSeconds = 0;
  var wantListening = false;
  /* Kris's own audio for the current call turn. */
  var callAudio = null;
  /* One microphone stream for the whole call. Re-acquiring it per turn caused
     the second getUserMedia to fail and the call to report "Microphone
     blocked"; it also churns the permission chip on every turn. */
  var callStream = null;
  var callCtx = null;

  function formatClock(total) {
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function remainingSeconds() {
    var spent = readStore(BUDGET_KEY, 0);
    if (typeof spent !== 'number' || !isFinite(spent) || spent < 0) spent = 0;
    return Math.max(0, CALL_BUDGET_SECONDS - spent);
  }

  function paintBudget() {
    var left = Math.max(0, remainingSeconds() - callSeconds);
    callBudget.textContent = Math.ceil(left / 60) + ' minutes left';
  }

  function setCallStatus(label, mode) {
    callStatusText.textContent = label;
    callStatus.classList.toggle('is-speaking', mode === 'speaking');
    callStatus.classList.toggle('is-listening', mode === 'listening');
    callStatus.classList.toggle('is-thinking', mode === 'thinking');
    callBars.hidden = mode !== 'speaking';
    callDots.hidden = mode === 'speaking';
  }

  function openCallView() {
    inCall = true;
    app.classList.add('in-call');
    app.classList.remove('call-connecting', 'call-live');
    paintBudget();


    callStart.disabled = !speechSupported;
    callStart.textContent = speechSupported ? 'Start a call' : 'Calls need Chrome or Edge';
  }

  function closeCallView() {
    endCall();
    inCall = false;
    app.classList.remove('in-call');
  }

  callBtn.addEventListener('click', openCallView);
  headerCallBtn.addEventListener('click', openCallView);
  callBack.addEventListener('click', closeCallView);
  callEnd.addEventListener('click', function () {
    endCall();
    closeCallView();
  });


  callStart.addEventListener('click', function () {
    if (!speechSupported) return;
    if (remainingSeconds() <= 0) {
      setCallStatus('No call minutes left', null);
      return;
    }
    beginCall();
  });

  function beginCall() {
    app.classList.add('call-connecting');
    setCallStatus('Connecting', null);

    /* Ask for the microphone up front so the permission prompt is tied to the
       button press, then release the stream - SpeechRecognition opens its own. */
    var ask = navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          callStream = stream;
        })
      : Promise.resolve();

    ask
      .then(function () {
        app.classList.remove('call-connecting');
        app.classList.add('call-live');
        callLive = true;
        /* welcome:false - the call opens with its own greeting, and adding the
           standing welcome here printed the paragraph twice. */
        enterThread({ welcome: false });
        /* Calls are listed separately from chats, with the phone icon. */
        startConversation(
          'call',
          'Voice call - ' +
            new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        );

        /* Kris opens the call, then we listen - going straight to Listening
           left the member with nothing to answer. */
        playGreeting();

        callSeconds = 0;
        callClock.textContent = '00:00';
        callTimer = setInterval(function () {
          callSeconds++;
          callClock.textContent = formatClock(callSeconds);
          paintBudget();
          if (remainingSeconds() - callSeconds <= 0) {
            setCallStatus('Call minutes used up', null);
            endCall();
          }
        }, 1000);

        /* playGreeting() opens the call and hands over to listening. */
      })
      .catch(function (err) {
        console.error('[kris] beginCall failed:', err && (err.name + ': ' + err.message), err && err.stack);
        app.classList.remove('call-connecting');
        setCallStatus('Microphone blocked', null);
      });
  }

  /* ---- the opening ------------------------------------------------------
     A pre-recorded greeting in Kris's real voice is used when one is present at
     /static/assets/greeting.mp3. There is no way to make BuddyPro speak
     arbitrary text - measured: with the system prompt replaced it repeats the
     AUDIO's transcript, not a supplied text part - so exact wording has to be a
     file. Without it the device voice reads the same words, and the paragraph is
     added to the thread either way so it is never missing.

     To record the real one: send the paragraph to the Kris bot in Telegram, save
     the voice message it returns, and drop it in as greeting.mp3.
     -------------------------------------------------------------------- */

  function playGreeting() {
    setCallStatus('Talking', 'speaking');

    /* First choice: a recording of the exact paragraph in Kris's own voice.
       Drop one in at public/assets/greeting.mp3 and it is used verbatim - send
       the paragraph to the Kris bot in Telegram and save the voice reply.
       Second choice: ask BuddyPro to greet, which is her real voice but her own
       words. Last resort: the device voice reads the paragraph. */
    tryGreetingFile()
      .then(function (played) {
        if (played || !callLive) return;
        greetViaBuddyPro();
      })
      .catch(function () {
        if (callLive) greetViaBuddyPro();
      });
  }

  /** Resolves true when a recorded greeting existed and started playing. */
  function tryGreetingFile() {
    return new Promise(function (resolve) {
      var file = new Audio('/static/assets/greeting.mp3');
      var settled = false;

      function fail() {
        if (settled) return;
        settled = true;
        resolve(false);
      }

      file.addEventListener('error', fail);
      file.addEventListener('canplay', function () {
        if (settled) return;
        settled = true;
        addTurn('kris', WELCOME, { store: false });
        callAudio = file;
        file.addEventListener('ended', function () {
          callAudio = null;
          if (!callLive) return;
          setCallStatus('Listening', 'listening');
          startListening();
        });
        file.play().then(
          function () {
            resolve(true);
          },
          function () {
            callAudio = null;
            resolve(false);
          }
        );
      });

      /* Do not hang the call waiting for a file that is not there. */
      setTimeout(fail, 2500);
    });
  }

  function greetViaBuddyPro() {

    /* BuddyPro only speaks when a request carries audio, so the opening is a
       short sample of the line with an instruction to greet. That is the only
       way the greeting is in Kris's real voice rather than the device voice. */
    sampleAudio(1800)
      .then(function (base64) {
        if (!callLive) return null;
        if (!base64) return null;
        return send('', {
          intent: 'call-greeting',
          audio: base64,
          audioFormat: 'wav',
          wantAudio: true,
          silentUser: true,
          quiet: true,
          onReply: function (reply) {
            if (!callLive) return;
            if (reply && (reply.audio || reply.content)) playReply(reply);
          },
        });
      })
      .then(function (result) {
        /* Nothing usable came back - read the standing welcome instead, so the
           call never opens in silence. */
        if (!callLive) return;
        if (!result || (!result.audio && !result.content)) {
          addTurn('kris', WELCOME, { store: false });
          speak(WELCOME);
        }
      })
      .catch(function () {
        if (!callLive) return;
        addTurn('kris', WELCOME, { store: false });
        speak(WELCOME);
      });
  }

  /** A short clip from the live call stream, as base64 WAV. */
  function sampleAudio(ms) {
    if (!callStream || !window.MediaRecorder) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var chunks = [];
      var rec;
      try {
        rec = new MediaRecorder(callStream);
      } catch (e) {
        resolve(null);
        return;
      }
      rec.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      rec.onstop = function () {
        if (!chunks.length) {
          resolve(null);
          return;
        }
        toWavBase64(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })).then(
          resolve,
          function () {
            resolve(null);
          }
        );
      };
      rec.start();
      setTimeout(function () {
        try {
          rec.stop();
        } catch (e) {
          resolve(null);
        }
      }, ms || 1200);
    });
  }

  /* ---- the call turn ----------------------------------------------------
     A call turn is deliberately the SAME round trip as a voice note: record,
     send the audio, play the audio that comes back. That is the only way the
     voice matches Telegram, because BuddyPro's TTS only fires when the request
     carries audio.

     The browser recogniser is NOT used here. It was, and it caused the very
     problem being fixed: two microphone streams at once (MediaRecorder plus
     SpeechRecognition), and a short turn could end before the recorder's
     getUserMedia resolved - sending text instead of audio, which silently
     produced the device voice instead of Kris's. BuddyPro transcribes the audio
     itself, so the recogniser was never needed for a call.

     Endpointing is done on the waveform: speech is detected by RMS above a
     floor, and the turn ends after a pause. One stream, no race.
     -------------------------------------------------------------------- */

  var CALL_SILENCE_MS = 1400; // pause that ends a turn
  var CALL_MIN_SPEECH_MS = 350; // ignore coughs and clicks
  var CALL_MAX_TURN_MS = 60000;
  var SPEECH_FLOOR = 0.02; // RMS above this counts as speech

  var turn = null;

  function stopTurn() {
    if (!turn) return;
    var dead = turn;
    turn = null;

    if (dead.raf) cancelAnimationFrame(dead.raf);
    if (dead.maxTimer) clearTimeout(dead.maxTimer);
    try {
      if (dead.source) dead.source.disconnect();
    } catch (e) {
      /* already gone */
    }
    if (dead.audioCtx && dead.audioCtx.state !== 'closed') {
      dead.audioCtx.close().catch(function () {});
    }
    try {
      if (dead.recorder && dead.recorder.state === 'recording') dead.recorder.stop();
    } catch (e) {
      /* already stopping */
    }
    /* The stream belongs to the call, not the turn - leave it running. */
    return dead;
  }

  function startListening() {
    if (!callLive || muted) return;

    wantListening = true;

    /* A request may still be in flight. Wait for it rather than giving up,
       which used to leave the call with the microphone never opening. */
    if (busy) {
      setTimeout(function () {
        if (callLive && wantListening && !muted) startListening();
      }, 300);
      return;
    }

    if (turn) return; // already listening

    setCallStatus('Listening', 'listening');

    if (!window.MediaRecorder || !callStream) {
      setCallStatus('This browser cannot record', null);
      return;
    }

    var state = {
      recorder: null,
      chunks: [],
      stream: null,
      audioCtx: null,
      analyser: null,
      source: null,
      raf: null,
      maxTimer: null,
      spokeAt: 0,
      lastVoiceAt: 0,
      settled: false,
    };
    turn = state;

    Promise.resolve(callStream)
      .then(function (stream) {
        if (turn !== state) return;
        state.stream = stream;

        state.recorder = new MediaRecorder(stream);
        state.recorder.ondataavailable = function (e) {
          if (e.data && e.data.size) state.chunks.push(e.data);
        };
        state.recorder.onstop = function () {
          var blob = state.chunks.length
            ? new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' })
            : null;
          state.chunks = [];
          if (state.settled) submitTurn(blob);
        };
        state.recorder.start();

        /* Endpointing from the waveform. */
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return; // no VAD: the max timer still ends the turn

        if (!callCtx || callCtx.state === 'closed') callCtx = new Ctx();
        state.audioCtx = null; // owned by the call, not the turn
        state.source = callCtx.createMediaStreamSource(stream);
        state.analyser = callCtx.createAnalyser();
        state.analyser.fftSize = 512;
        state.source.connect(state.analyser);

        var buffer = new Uint8Array(state.analyser.fftSize);

        function watch() {
          if (turn !== state || state.settled) return;

          state.analyser.getByteTimeDomainData(buffer);
          var sum = 0;
          for (var i = 0; i < buffer.length; i++) {
            var d = (buffer[i] - 128) / 128;
            sum += d * d;
          }
          var rms = Math.sqrt(sum / buffer.length);
          var now = Date.now();

          if (rms > SPEECH_FLOOR) {
            if (!state.spokeAt) state.spokeAt = now;
            state.lastVoiceAt = now;
          } else if (
            state.spokeAt &&
            state.lastVoiceAt &&
            now - state.lastVoiceAt > CALL_SILENCE_MS &&
            state.lastVoiceAt - state.spokeAt > CALL_MIN_SPEECH_MS
          ) {
            /* They spoke, then stopped. End the turn. */
            endTurn();
            return;
          }

          state.raf = requestAnimationFrame(watch);
        }
        state.raf = requestAnimationFrame(watch);
      })
      .catch(function (err) {
        console.error('[kris] call turn could not start:', err && (err.name + ': ' + err.message));
        turn = null;
        setCallStatus('Microphone blocked', null);
        wantListening = false;
        endCall();
      });

    state.maxTimer = setTimeout(function () {
      if (turn === state && state.spokeAt) endTurn();
    }, CALL_MAX_TURN_MS);

    function endTurn() {
      if (!turn || turn.settled) return;
      turn.settled = true;
      setCallStatus('Thinking', 'thinking');
      /* stopTurn() triggers recorder.onstop, which calls submitTurn. */
      stopTurn();
    }
  }

  function stopListening() {
    wantListening = false;
    var dead = turn;
    if (dead) dead.settled = false; // discard, do not submit
    stopTurn();
  }

  /** Send the recording. No transcript: BuddyPro transcribes it, and sending
      audio is what makes it answer in its own voice. */
  function submitTurn(blob) {
    if (!callLive) return;

    if (!blob || blob.size < 1200) {
      setCallStatus('Listening', 'listening');
      startListening();
      return;
    }

    toWavBase64(blob)
      .then(function (base64) {
        if (!callLive) return;
        /* spokenReply is deliberately off. During a call the audio is played by
           the call itself; rendering a voice note in the thread as well left a
           second, independent player running after the member hung up - and a
           call transcript reads better as text anyway. */
        send('', {
          audio: base64,
          audioFormat: 'wav',
          wantAudio: true,
          silentUser: true,
          onReply: playReply,
        });
      })
      .catch(function () {
        if (!callLive) return;
        setCallStatus('Listening', 'listening');
        startListening();
      });
  }

  /** Stop whatever Kris is currently saying. */
  function stopReplyAudio() {
    if (!callAudio) return;
    try {
      callAudio.pause();
    } catch (e) {
      /* ignore */
    }
    callAudio = null;
  }

  /** Play Kris's own audio. The device voice is only a last resort, and says so
      in the status, so a wrong-sounding turn is never silent about why. */
  function playReply(reply) {
    if (!callLive) return;

    var content = (reply && reply.content) || '';
    var audio = reply && reply.audio;

    if (!content && !audio) {
      setCallStatus('Listening', 'listening');
      startListening();
      return;
    }

    if (!audio) {
      speak(content);
      return;
    }

    setCallStatus('Talking', 'speaking');

    if (callAudio) {
      try {
        callAudio.pause();
      } catch (e) {
        /* ignore */
      }
    }

    callAudio = new Audio(audio);

    function done() {
      callAudio = null;
      if (!callLive) return;
      setCallStatus('Listening', 'listening');
      startListening();
    }

    callAudio.addEventListener('ended', done);
    callAudio.addEventListener('error', function () {
      callAudio = null;
      if (callLive) speak(content);
    });

    callAudio.play().catch(function () {
      callAudio = null;
      if (callLive) speak(content);
    });
  }





  /**
   * @param {string} text
   * @param {{onStart?:Function,onEnd?:Function}} [opts] when given, this is a
   *   voice-note playback in the chat rather than a call turn, so the call
   *   status and the listening loop are left alone.
   */
  function speak(text, opts) {
    var standalone = !!opts;
    var onStart = (opts && opts.onStart) || null;
    var onEnd = (opts && opts.onEnd) || null;

    function finished() {
      if (onEnd) onEnd();
      if (standalone) return;
      if (!callLive) return;
      setCallStatus('Listening', 'listening');
      startListening();
    }

    if (!text || !synth) {
      finished();
      return;
    }

    if (!standalone) setCallStatus('Talking', 'speaking');

    /* Cancel anything queued, then speak. During a call recognition stays off
       while Kris talks, otherwise the synthesised voice gets transcribed
       straight back in as the next question. */
    if (!standalone) stopListening();
    try {
      synth.cancel();
    } catch (e) {
      /* ignore */
    }

    var utterance = new SpeechSynthesisUtterance(stripForSpeech(text));
    utterance.lang = currentLanguage();
    utterance.rate = 1.02;

    var voices = synth.getVoices() || [];
    var preferred = voices.filter(function (voice) {
      return voice.lang && voice.lang.toLowerCase().indexOf(utterance.lang.slice(0, 2)) === 0;
    });
    /* A female voice is the closer match for Kris where one is offered. */
    var female = preferred.filter(function (voice) {
      return /female|samantha|zira|aria|jenny|libby|sonia|emma|joanna/i.test(voice.name);
    });
    if (female.length) utterance.voice = female[0];
    else if (preferred.length) utterance.voice = preferred[0];

    utterance.onend = finished;
    utterance.onerror = finished;

    /* Rough duration estimate so a voice note can show a countdown: English
       speech runs about 15 characters a second at this rate. */
    if (onStart) onStart(Math.max(1, Math.round(utterance.text.length / 15)));

    /* If the engine refuses the utterance the call must not stall on Talking -
       hand back to listening instead. */
    try {
      synth.speak(utterance);
    } catch (e) {
      finished();
    }
  }

  /* Markdown and URLs read badly aloud. */
  function stripForSpeech(text) {
    return String(text)
      .replace(/\[(\d{1,2})\]/g, '')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_#`>]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function endCall() {
    callLive = false;
    app.classList.remove('call-live', 'call-connecting');

    stopListening();
    stopReplyAudio();

    /* The stream and context belong to the call, so they are released here and
       nowhere else. */
    if (callStream) {
      callStream.getTracks().forEach(function (t) {
        t.stop();
      });
      callStream = null;
    }
    if (callCtx && callCtx.state !== 'closed') {
      callCtx.close().catch(function () {});
    }
    callCtx = null;

    if (synth) {
      try {
        synth.cancel();
      } catch (e) {
        /* ignore */
      }
    }

    if (callTimer) {
      clearInterval(callTimer);
      callTimer = null;
    }

    /* Bank the minutes used so the budget survives a reload. */
    if (callSeconds > 0) {
      spentSeconds = readStore(BUDGET_KEY, 0);
      if (typeof spentSeconds !== 'number' || !isFinite(spentSeconds)) spentSeconds = 0;
      writeStore(BUDGET_KEY, spentSeconds + callSeconds);
      callSeconds = 0;
    }

    muted = false;
    callMic.classList.remove('is-muted');
    setCallStatus('Connecting', null);
    paintBudget();
  }

  callMic.addEventListener('click', function () {
    if (!callLive) return;
    muted = !muted;
    callMic.classList.toggle('is-muted', muted);
    callMic.title = muted ? 'Unmute' : 'Mute';

    if (muted) {
      stopListening();
      stopReplyAudio();
      setCallStatus('Muted', null);
    } else {
      setCallStatus('Listening', 'listening');
      startListening();
    }
  });

  /* Some browsers populate the voice list asynchronously. */
  if (synth && typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = function () {
      /* nothing to do; getVoices() is read at speak time */
    };
  }

  /* Escape closes whatever is on top. */
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (historyPanel.classList.contains('is-open')) return closeHistory();
    if (inCall) closeCallView();
  });

  /* ---- go -------------------------------------------------------------- */

  boot();
})();
