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
  var callLang = document.getElementById('callLang');

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

  function readHistory() {
    var parsed = readStore(HISTORY_KEY, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  function recordTurn(role, text) {
    if (!text) return;
    var entries = readHistory();
    entries.push({ role: role, text: text, at: Date.now() });
    writeStore(HISTORY_KEY, entries.slice(-HISTORY_MAX));
  }

  function relativeTime(ms) {
    var seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(ms).toLocaleDateString();
  }

  function renderHistory() {
    var questions = readHistory().filter(function (e) {
      return e.role === 'me';
    });

    historyBody.textContent = '';

    if (!questions.length) {
      var empty = document.createElement('p');
      empty.className = 'history__empty';
      empty.textContent =
        'No questions yet on this device. Kris remembers your conversation either way, ' +
        'so you can pick up where you left off.';
      historyBody.appendChild(empty);
      return;
    }

    questions
      .slice()
      .reverse()
      .forEach(function (entry) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'history__item';

        var q = document.createElement('div');
        q.className = 'history__q';
        q.textContent = entry.text;

        var when = document.createElement('div');
        when.className = 'history__when';
        when.textContent = relativeTime(entry.at);

        item.appendChild(q);
        item.appendChild(when);
        item.addEventListener('click', function () {
          restoreTranscript();
          closeHistory();
        });

        historyBody.appendChild(item);
      });
  }

  function restoreTranscript() {
    var entries = readHistory();
    if (!entries.length) return;

    thread.textContent = '';
    enterThread({ welcome: false });
    entries.forEach(function (entry) {
      addTurn(entry.role === 'me' ? 'me' : 'kris', entry.text, { silent: true });
    });
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
      window.localStorage.removeItem(HISTORY_KEY);
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
    if (!message || busy) return Promise.resolve(null);

    hideNotice();
    enterThread();

    if (!options.silentUser) addTurn('me', message);
    input.value = '';
    armSend();

    var pending = addTurn('kris', null, { store: false });
    setBusy(true);

    return api('/api/chat', {
      message: message,
      language: currentLanguage(),
      wantAudio: options.wantAudio === true,
    })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401) {
            showGate((res.data && res.data.reason) || 'no_session');
            return null;
          }
          pending.turn.classList.add('turn--error');
          pending.setText(
            (res.data && res.data.error) || 'That did not go through. Try again in a moment.'
          );
          return null;
        }

        var content = (res.data && res.data.content) || '';
        pending.setText(content);
        recordTurn('kris', content);
        return { content: content, audio: (res.data && res.data.audio) || null };
      })
      .catch(function () {
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

  /* One language setting drives all three: BuddyPro's reply language, the
     speech recogniser, and the speech synthesiser. */
  function currentLanguage() {
    return (callLang && callLang.value) || 'en-US';
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

  /* ---- dictation (composer microphone) ---------------------------------
     Uses the same browser speech engine as the call. BuddyPro's own audio
     endpoint is rejected by this instance, so recording and uploading is not
     an option; transcribing locally and sending text is.
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
   * interim text counts. Returns a handle with stop() and abort().
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
         abort() - and must not tear the call down. */
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

  var dictation = null;

  micBtn.addEventListener('click', function () {
    if (!speechSupported) {
      showNotice('Voice input needs Chrome or Edge. Type your question instead.');
      return;
    }

    /* Second tap = "I am done", rather than waiting for the pause. */
    if (dictation) {
      dictation.stop();
      return;
    }

    micBtn.classList.add('is-armed');
    showNotice('Listening… pause when you have finished, or tap the microphone again.');

    function done() {
      dictation = null;
      micBtn.classList.remove('is-armed');
    }

    dictation = listenOnce({
      lang: currentLanguage(),
      onInterim: function (text) {
        input.value = text;
        armSend();
      },
      onResult: function (text) {
        done();
        hideNotice();
        input.value = text;
        armSend();
        if (text) send(text);
      },
      onEmpty: function () {
        done();
        showNotice('I did not catch that. Try again, or type your question.');
      },
      onError: function (err) {
        done();
        showNotice(
          err === 'not-allowed' || err === 'service-not-allowed'
            ? 'Microphone permission was declined.'
            : 'Could not hear anything. Try again, or type your question.'
        );
      },
    });
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

  callLang.addEventListener('change', function () {
    /* The language is fixed when a recogniser starts, so restart the turn to
       pick up the new one. */
    if (callLive && recognition && !muted) {
      stopListening();
      wantListening = true;
      startListening();
    }
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
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        })
      : Promise.resolve();

    ask
      .then(function () {
        app.classList.remove('call-connecting');
        app.classList.add('call-live');
        callLive = true;
        enterThread();

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

        startListening();
      })
      .catch(function () {
        app.classList.remove('call-connecting');
        setCallStatus('Microphone blocked', null);
      });
  }

  function startListening() {
    if (!callLive || muted) return;

    wantListening = true;

    /* A request may still be in flight - from the composer, or the turn before.
       Wait for it rather than giving up, which used to leave the call stuck on
       its opening status with the microphone never opening. */
    if (busy) {
      setTimeout(function () {
        if (callLive && wantListening && !muted) startListening();
      }, 300);
      return;
    }

    setCallStatus('Listening', 'listening');

    function relisten(delay) {
      recognition = null;
      if (callLive && wantListening && !muted) setTimeout(startListening, delay || 250);
    }

    recognition = listenOnce({
      lang: currentLanguage(),

      /* The moment speech is detected, say so - otherwise a slow answer looks
         like the call has frozen on "Listening". */
      onInterim: function (text) {
        if (text) setCallStatus('Listening', 'listening');
      },

      onResult: function (question) {
        recognition = null;
        if (!callLive) return;
        askOnCall(question);
      },

      /* A quiet stretch is normal in a call - go round again rather than
         dropping it. */
      onEmpty: function () {
        relisten(250);
      },

      onError: function (err) {
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          recognition = null;
          setCallStatus('Microphone blocked', null);
          wantListening = false;
          endCall();
          return;
        }
        relisten(400);
      },
    });
  }

  function stopListening() {
    wantListening = false;
    if (recognition) {
      try {
        recognition.abort();
      } catch (e) {
        /* already stopped */
      }
      recognition = null;
    }
  }

  function askOnCall(question) {
    setCallStatus('Thinking', null);

    send(question, {
      wantAudio: true,
      onReply: function (reply) {
        if (!callLive) return;
        if (!reply || !reply.content) {
          setCallStatus('Listening', 'listening');
          startListening();
          return;
        }
        /* BuddyPro returns its own voice - the same one the Telegram bot uses.
           speechSynthesis is only a fallback if that audio is missing. */
        if (reply.audio) playReply(reply.audio, reply.content);
        else speak(reply.content);
      },
    });
  }

  var replyAudio = null;

  function stopReplyAudio() {
    if (!replyAudio) return;
    try {
      replyAudio.pause();
      replyAudio.src = '';
    } catch (e) {
      /* already torn down */
    }
    replyAudio = null;
  }

  function playReply(dataUrl, fallbackText) {
    stopReplyAudio();
    stopListening();
    setCallStatus('Talking', 'speaking');

    replyAudio = new Audio(dataUrl);

    function resume() {
      replyAudio = null;
      if (!callLive) return;
      setCallStatus('Listening', 'listening');
      startListening();
    }

    replyAudio.onended = resume;
    replyAudio.onerror = resume;

    var started = replyAudio.play();
    if (started && typeof started.catch === 'function') {
      started.catch(function () {
        /* Autoplay was refused. The call began with a click so this is rare -
           fall back to the device voice rather than stalling silently. */
        stopReplyAudio();
        speak(fallbackText || '');
      });
    }
  }

  function speak(text) {
    if (!text) {
      if (callLive) {
        setCallStatus('Listening', 'listening');
        startListening();
      }
      return;
    }
    if (!synth) {
      setCallStatus('Listening', 'listening');
      startListening();
      return;
    }

    setCallStatus('Talking', 'speaking');

    /* Cancel anything queued, then speak. Recognition stays off while Kris
       talks, otherwise the synthesised voice gets transcribed straight back. */
    stopListening();
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

    utterance.onend = function () {
      if (!callLive) return;
      setCallStatus('Listening', 'listening');
      startListening();
    };
    utterance.onerror = function () {
      if (!callLive) return;
      setCallStatus('Listening', 'listening');
      startListening();
    };

    synth.speak(utterance);
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
