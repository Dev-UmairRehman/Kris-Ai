'use strict';

/* ---------------------------------------------------------------------------
   Your Marketing Agency - the page, pasted into a Uscreen landing page.

   Login: the same as MasterPlan Digital. member.js (window.STMember) reads who
   is signed in on the store and whether they have a plan; the session comes
   from MasterPlan's /masterplan/api/session and is sent here as a Bearer
   token. The token lives only in this script's memory.

   Recording: the microphone is encoded to MP3 while the member speaks (one
   channel, 16 kHz, 32 kbps: about 11 MB for 45 minutes), so even a long
   answer never sits in memory as raw audio.

   Covers: the picture comes from the server without text; the title is drawn
   here on a canvas, so it is always spelled right and can be changed freely.
   --------------------------------------------------------------------------- */

(function () {
  var BOOT = window.YMA_BOOT || {};
  var ORIGIN = BOOT.apiOrigin || '';
  var API = ORIGIN + '/agency/api';
  var PREVIEW = !/(^|\.)strategytraining\.com$/i.test(location.hostname) && !BOOT.localApi;
  var MAX_REC_SECONDS = (BOOT.maxAudioMinutes || 45) * 60;

  var $ = function (id) { return document.getElementById(id); };
  var root = $('yma');
  root.classList.add('is-page');
  var token = null;
  var state = null;
  var current = null; // the question in the card
  var pollTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function show(id, on) { $(id).hidden = !on; }
  function msg(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  }

  /* ---- api ------------------------------------------------------------------ */

  function request(url, opts) {
    if (PREVIEW) return Promise.resolve({ ok: false, status: 0, data: { error: 'This is a preview. Publish this page on StrategyTraining.com to use it.' } });
    opts = opts || {};
    var headers = opts.headers || {};
    if (token) headers.Authorization = 'Bearer ' + token;
    var body = opts.body;
    if (body && !(body instanceof Blob)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    return fetch(url, { method: opts.method || 'GET', headers: headers, body: body, redirect: 'manual' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (opts.blob && res.ok) return res.blob().then(function (b) { return { ok: true, status: res.status, blob: b }; });
      return (/json/i.test(type) ? res.json() : Promise.reject(new Error('not json'))).catch(function () {
        return { error: 'Your Marketing Agency is not reachable right now. Please try again in a few minutes.', reason: 'service_down' };
      }).then(function (data) {
        if (res.status === 401 && data.reason === 'no_session') showGate('expired');
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function () {
      return { ok: false, status: 0, data: { error: 'Your Marketing Agency is not reachable right now. Please try again in a few minutes.', reason: 'service_down' } };
    });
  }
  var api = {
    get: function (p) { return request(API + p); },
    post: function (p, body, headers) { return request(API + p, { method: 'POST', body: body || {}, headers: headers }); },
    blob: function (p) { return request(API + p, { blob: true }); },
  };

  /* ---- sign in: the same login as MasterPlan ----------------------------------- */

  var lastIdentity = {};
  function startSession(identity) {
    lastIdentity = identity || {};
    var claim = {};
    for (var k in identity) claim[k] = identity[k];
    var planned = claim.signedIn && BOOT.planPage && window.STMember ? window.STMember.checkPlan(BOOT.planPage) : Promise.resolve({});
    return planned.then(function (p) {
      if (p.plan) {
        claim.plan = p.plan;
        claim.planVia = p.planVia;
      }
      return request(ORIGIN + '/masterplan/api/session', { method: 'POST', body: claim });
    }).then(function (r) {
      if (r.ok && r.data.ok) {
        token = r.data.token;
        openApp();
      } else {
        showGate((r.data && r.data.reason) || 'service_down');
      }
    });
  }

  function showGate(reason) {
    root.classList.remove('is-booting');
    show('y-app', false);
    show('y-gate', true);
    $('y-signin').href = BOOT.signInUrl || '#';
    $('y-join').href = BOOT.joinUrl || '#';
    var signedOut = reason === 'signed_out' || (reason === 'no_identity_from_store' && !lastIdentity.signedIn);
    var noPlan = reason === 'not_subscribed' || reason === 'customer_not_found';
    var text;
    if (signedOut) text = 'Sign in to your StrategyTraining account to use Your Marketing Agency.';
    else if (noPlan) text = 'Your Marketing Agency is included with a StrategyTraining plan. Choose a plan, then come back to this page.';
    else if (reason === 'no_email') text = 'You are signed in, but we could not read the email on your account. Open your account menu (your picture, top right), then press Try again.';
    else if (reason === 'expired') text = 'Your session has expired. Press Try again to continue.';
    else if (reason === 'service_down') text = 'Your Marketing Agency is not reachable right now. Please try again in a few minutes.';
    else text = 'We could not open Your Marketing Agency just now. Please try again in a moment.';
    $('y-gate-text').textContent = text;
    $('y-signin').hidden = !signedOut;
    $('y-join').hidden = !(signedOut || noPlan);
    $('y-join').textContent = noPlan ? 'Choose a plan' : 'Join';
    $('y-retry').hidden = signedOut || noPlan;
  }
  $('y-retry').addEventListener('click', function () {
    show('y-gate', false);
    root.classList.add('is-booting');
    token = null;
    window.STMember.identify('[st-yma]').then(startSession);
  });

  /* ---- tabs ------------------------------------------------------------------ */

  var tabs = Array.prototype.slice.call(root.querySelectorAll('.mp-tabs [data-tab]'));
  function selectTab(name) {
    tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-panel]'), function (p) { p.hidden = p.dataset.panel !== name; });
    if (name === 'brand') loadBrand();
    if (name === 'content') loadIdeas();
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { selectTab(t.dataset.tab); }); });
  root.addEventListener('click', function (e) {
    var go = e.target.closest && e.target.closest('[data-goto]');
    if (go) selectTab(go.dataset.goto);
  });

  function openApp() {
    root.classList.remove('is-booting');
    show('y-gate', false);
    show('y-app', true);
    loadState(true);
  }

  /* ---- questions ------------------------------------------------------------- */

  function loadState(fillCard) {
    return api.get('/state').then(function (r) {
      if (!r.ok) return;
      state = r.data;
      renderStarters();
      if (state.readFailed && state.readFailed.length) {
        msg('y-read-failed', 'We could not read your answer to "' + state.readFailed[0].text.slice(0, 80) + '…" into your profile. Open it from All questions and save it again.');
      } else msg('y-read-failed', '');
      if (fillCard || !current) {
        if (state.next) loadQuestion(state.next.id);
        else showWait();
      }
      schedulePoll();
    });
  }

  function renderStarters() {
    var list = $('y-starters');
    list.textContent = '';
    show('y-intro', !state.startersDone);
    state.starters.forEach(function (s) {
      var li = el('li', s.done ? 'is-done' : '');
      if (current && current.id === s.id) li.classList.add('is-current');
      var b = el('button');
      b.type = 'button';
      b.appendChild(el('small', null, 'Level ' + s.level));
      b.appendChild(document.createTextNode(s.title));
      b.addEventListener('click', function () { loadQuestion(s.id); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function showWait() {
    current = null;
    show('y-card', false);
    show('y-wait', true);
    var when = state && state.nextAt ? new Date(state.nextAt) : null;
    $('y-wait-text').textContent = when
      ? 'Your next question arrives on ' + when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + '. Meanwhile, look at My Brand, or turn your stories into content.'
      : 'Your next question arrives soon. Meanwhile, look at My Brand, or turn your stories into content.';
  }

  function loadQuestion(qid) {
    return api.get('/answers/' + encodeURIComponent(qid)).then(function (r) {
      if (!r.ok) return;
      current = r.data.question;
      show('y-wait', false);
      show('y-card', true);
      $('y-q-level').textContent = 'Level ' + current.level + ' · ' + current.levelTitle;
      $('y-q-text').textContent = current.text;
      var hint = current.kind === 'list' && current.items ? 'Write ' + current.items + ', one per line.' : '';
      msg('y-q-hint', hint);
      msg('y-q-follow', r.data.followUp ? 'To make this answer stronger: ' + r.data.followUp : '');
      $('y-answer').value = r.data.answer ? r.data.answer.text : '';
      $('y-save').textContent = r.data.answer ? 'Save new answer' : 'Save answer';
      msg('y-saved', '');
      msg('y-ans-error', '');
      if (state) renderStarters();
    });
  }

  $('y-save').addEventListener('click', function () {
    if (!current) return;
    var text = $('y-answer').value.trim();
    if (text.length < 2) return msg('y-ans-error', 'Write or record your answer first.');
    var btn = $('y-save');
    btn.disabled = true;
    msg('y-ans-error', '');
    api.post('/answers', { qid: current.id, text: text, source: lastSource }).then(function (r) {
      btn.disabled = false;
      if (!r.ok) return msg('y-ans-error', r.data.error || 'That did not save. Please try again.');
      lastSource = 'typed';
      msg('y-saved', 'Saved. We are reading it into your brand profile now.');
      setTimeout(function () { loadState(true); }, 900);
    });
  });
  var lastSource = 'typed';
  $('y-answer').addEventListener('input', function () { if (!$('y-answer').value) lastSource = 'typed'; });

  /* All questions, by level, loaded when opened. */
  $('y-all').addEventListener('toggle', function () { if ($('y-all').open) loadLevels(); });
  function loadLevels() {
    api.get('/questions').then(function (r) {
      if (!r.ok) return;
      var box = $('y-levels');
      box.textContent = '';
      r.data.levels.forEach(function (l) {
        var sec = el('div', 'y-level');
        sec.appendChild(el('h3', null, 'Level ' + l.n + ' · ' + l.title));
        var ul = el('ul');
        l.questions.forEach(function (q) {
          var li = el('li', q.answeredAt ? 'is-answered' : q.open ? '' : 'is-locked');
          li.appendChild(el('span', 'y-tag', q.answeredAt ? 'Answered' : q.open ? 'Open' : 'Later'));
          if (q.open) {
            var b = el('button', null, q.text);
            b.type = 'button';
            b.addEventListener('click', function () {
              loadQuestion(q.id).then(function () { $('y-card').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
            });
            li.appendChild(b);
          } else li.appendChild(el('span', null, q.text));
          ul.appendChild(li);
        });
        sec.appendChild(ul);
        box.appendChild(sec);
      });
    });
  }

  /* ---- recording: straight to MP3 ------------------------------------------------ */

  var rec = null;
  function loadEncoder() {
    if (window.lamejs) return Promise.resolve();
    return new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = ORIGIN + '/agency/static/lame.js';
      s.onload = ok;
      s.onerror = function () { fail(new Error('encoder')); };
      document.head.appendChild(s);
    });
  }
  function clock(s) { return Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2); }

  $('y-rec').addEventListener('click', function () {
    if (rec) return stopRecording();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return msg('y-rec-status', 'This browser cannot record. Upload a recording instead, or type your answer.');
    msg('y-rec-status', 'Starting the microphone…');
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    Promise.all([loadEncoder(), navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })]).then(function (got) {
      var stream = got[1];
      var source = ctx.createMediaStreamSource(stream);
      var node = ctx.createScriptProcessor(4096, 1, 1);
      var encoder = new window.lamejs.Mp3Encoder(1, 16000, 32);
      var ratio = ctx.sampleRate / 16000;
      var carry = 0;
      var chunks = [];
      var samples = 0;
      node.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var outLen = Math.floor((input.length - carry) / ratio);
        var pcm = new Int16Array(outLen);
        for (var i = 0; i < outLen; i++) {
          var v = input[Math.floor(carry + i * ratio)];
          pcm[i] = v < 0 ? Math.max(-1, v) * 0x8000 : Math.min(1, v) * 0x7fff;
        }
        carry = (carry + outLen * ratio) - input.length;
        var mp3 = encoder.encodeBuffer(pcm);
        if (mp3.length) chunks.push(new Uint8Array(mp3));
        samples += outLen;
        var secs = samples / 16000;
        $('y-rec-time').textContent = clock(secs);
        if (secs >= MAX_REC_SECONDS) stopRecording();
      };
      source.connect(node);
      node.connect(ctx.destination);
      rec = { ctx: ctx, stream: stream, node: node, source: source, encoder: encoder, chunks: chunks, samples: function () { return samples; } };
      $('y-rec').classList.add('is-on');
      $('y-rec-label').textContent = 'Stop recording';
      show('y-rec-time', true);
      msg('y-rec-status', 'Recording. Speak as if you were telling a friend. Press Stop when you are done.');
    }).catch(function () {
      ctx.close();
      msg('y-rec-status', 'The microphone could not be used. Check that this site may use it, or upload a recording instead.');
    });
  });

  function stopRecording() {
    var r = rec;
    rec = null;
    r.node.disconnect();
    r.source.disconnect();
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    r.ctx.close();
    var tail = r.encoder.flush();
    if (tail.length) r.chunks.push(new Uint8Array(tail));
    $('y-rec').classList.remove('is-on');
    $('y-rec-label').textContent = 'Record your answer';
    var secs = Math.round(r.samples() / 16000);
    if (secs < 2) {
      show('y-rec-time', false);
      return msg('y-rec-status', 'That recording was too short.');
    }
    transcribe(new Blob(r.chunks, { type: 'audio/mpeg' }), secs);
  }

  var AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
  $('y-audio-file').addEventListener('change', function () {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    var ext = (f.name.split('.').pop() || '').toLowerCase();
    var type = AUDIO_TYPES[ext] || f.type;
    if (!type || !/^audio\//.test(type)) return msg('y-rec-status', 'Please use an MP3, M4A, WAV, OGG, FLAC or AAC recording.');
    if (f.size > (BOOT.maxAudioBytes || 40 * 1024 * 1024)) return msg('y-rec-status', 'That file is too large. Please split it into shorter parts.');
    /* The length, for the daily allowance. */
    var a = new Audio();
    var url = URL.createObjectURL(f);
    var done = function (secs) {
      URL.revokeObjectURL(url);
      transcribe(new Blob([f], { type: type }), secs);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = function () { done(isFinite(a.duration) ? Math.round(a.duration) : 0); };
    a.onerror = function () { done(0); };
    a.src = url;
  });

  function transcribe(blob, secs) {
    show('y-rec-time', false);
    msg('y-rec-status', 'Turning your recording into text… (about ' + Math.max(1, Math.round(secs / 60) || 1) + ' minute' + (secs > 90 ? 's' : '') + ' of audio)');
    $('y-rec').disabled = true;
    request(API + '/transcribe?seconds=' + (secs || 0), { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } }).then(function (r) {
      $('y-rec').disabled = false;
      if (!r.ok) return msg('y-rec-status', r.data.error || 'The recording could not be read. Please try again.');
      var box = $('y-answer');
      box.value = box.value.trim() ? box.value.trim() + '\n\n' + r.data.text : r.data.text;
      lastSource = 'audio';
      msg('y-rec-status', 'Here is what you said. Check it, correct anything, then press Save answer. The recording itself is not kept.');
      box.focus();
    });
  }

  /* ---- my brand ---------------------------------------------------------------- */

  var LABELS = {
    mission: 'Mission', expertise: 'Expertise', audience: 'Who you help', method: 'How you help', coreBelief: 'Core belief',
    values: 'Values', thinkingStyle: 'How you think', centralTension: 'Central tension', recurringImages: 'Recurring images',
    turningPoints: 'Turning points', proofPoints: 'Results and proof', voice: 'Your voice', businessDirection: 'Business direction',
    wantsToTalkAbout: 'What you want to talk about',
  };

  function loadBrand() {
    api.get('/profile').then(function (r) {
      if (!r.ok) return;
      var d = r.data;
      show('y-reading', d.reading > 0);
      var has = d.updatedAt || (d.stories && d.stories.length);
      show('y-brand', !!has);
      show('y-brand-empty', !has && d.reading === 0);
      if (has) {
        renderProfile(d);
        renderConfirm(d.confirm || []);
        renderStories(d.stories || []);
      }
      if (d.reading > 0) schedulePoll(true);
    });
    loadRules();
    loadPhoto();
  }

  function renderProfile(d) {
    var dl = $('y-profile');
    dl.textContent = '';
    Object.keys(d.fields).forEach(function (k) {
      var isList = d.listFields.indexOf(k) !== -1;
      var v = d.profile[k];
      var shown = isList ? (v || []).join('\n') : v || '';
      var wrap = el('div', 'y-field');
      var dt = el('dt');
      var name = el('span', null, LABELS[k] || k);
      if (d.locked.indexOf(k) !== -1) name.appendChild(el('span', 'y-mine', ' · your words'));
      dt.appendChild(name);
      var edit = el('button', 'mp-link', 'Edit');
      edit.type = 'button';
      dt.appendChild(edit);
      var dd = el('dd', shown ? '' : 'is-empty', shown || 'Not yet in your answers.');
      edit.addEventListener('click', function () {
        if (wrap.querySelector('textarea')) return;
        var ta = el('textarea');
        ta.rows = isList ? 4 : 3;
        ta.value = shown;
        if (isList) ta.placeholder = 'One per line';
        var save = el('button', 'mp-btn mp-btn-ghost', 'Save');
        save.type = 'button';
        var row = el('div', 'mp-actions');
        row.appendChild(save);
        dd.replaceWith(ta);
        wrap.appendChild(row);
        ta.focus();
        save.addEventListener('click', function () {
          save.disabled = true;
          api.post('/profile', { field: k, value: isList ? ta.value.split('\n') : ta.value }).then(loadBrand);
        });
      });
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });
  }

  function renderConfirm(items) {
    show('y-confirm-sec', items.length > 0);
    var ul = $('y-confirm');
    ul.textContent = '';
    items.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('span', null, c));
      var b = el('button', 'mp-link', 'Done');
      b.type = 'button';
      b.addEventListener('click', function () { api.post('/confirm/clear', { item: c }).then(loadBrand); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  var TIERS = [['P', 'Publishable'], ['A', 'Ask first'], ['X', 'Private']];
  function renderStories(stories) {
    var ul = $('y-stories');
    ul.textContent = '';
    if (!stories.length) ul.appendChild(el('li', 'mp-empty-line', 'Your stories appear here as you answer.'));
    stories.slice().reverse().forEach(function (s) {
      var li = el('li', 'y-story');
      li.appendChild(el('h3', null, s.title));
      if (s.theme) li.appendChild(el('p', 'y-theme', s.theme));
      li.appendChild(el('p', null, s.summary));
      var group = el('div', 'y-tiers');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Who may see this story');
      TIERS.forEach(function (t) {
        var b = el('button', null, t[1]);
        b.type = 'button';
        b.dataset.tier = t[0];
        b.setAttribute('aria-pressed', String(s.tier === t[0]));
        b.addEventListener('click', function () {
          api.post('/stories/' + encodeURIComponent(s.id), { tier: t[0] }).then(loadBrand);
        });
        group.appendChild(b);
      });
      li.appendChild(group);
      ul.appendChild(li);
    });
  }

  var rulesLoaded = false;
  function loadRules() {
    if (rulesLoaded) return;
    api.get('/rules').then(function (r) {
      if (!r.ok) return;
      rulesLoaded = true;
      $('y-rules-default').textContent = r.data.defaults;
      $('y-rules-text').value = r.data.own.text || '';
      $('y-rules-phrases').value = (r.data.own.phrases || []).join('\n');
    });
  }
  $('y-rules-save').addEventListener('click', function () {
    api.post('/rules', { text: $('y-rules-text').value, phrases: $('y-rules-phrases').value.split('\n') }).then(function (r) {
      msg('y-rules-saved', r.ok ? 'Saved. Your next content follows them.' : r.data.error);
    });
  });

  var photoUrl = null;
  function loadPhoto() {
    if (!state || !state.photo) return showPhoto(null);
    api.blob('/photo').then(function (r) { showPhoto(r.ok ? r.blob : null); });
  }
  function showPhoto(blob) {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = blob ? URL.createObjectURL(blob) : null;
    var img = $('y-photo-img');
    img.hidden = !photoUrl;
    if (photoUrl) img.src = photoUrl;
    show('y-photo-del', !!photoUrl);
  }
  /* Made smaller here first (1024 px, JPEG): a phone photo of 5 MB becomes
     about 150 KB, which is faster to send and cheaper for the image model. */
  $('y-photo-file').addEventListener('change', function () {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    var img = new Image();
    var url = URL.createObjectURL(f);
    img.onload = function () {
      var scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function (b) {
        request(API + '/photo', { method: 'POST', body: b, headers: { 'Content-Type': 'image/jpeg' } }).then(function (r) {
          if (!r.ok) return window.alert(r.data.error || 'The photo could not be saved.');
          state.photo = true;
          showPhoto(b);
        });
      }, 'image/jpeg', 0.86);
    };
    img.onerror = function () { window.alert('That photo could not be opened.'); };
    img.src = url;
  });
  $('y-photo-del').addEventListener('click', function () {
    api.post('/photo/delete').then(function () {
      state.photo = false;
      showPhoto(null);
    });
  });

  $('y-delete-all').addEventListener('click', function () {
    var typed = window.prompt('This deletes all your answers, your profile, your stories and your content. It cannot be undone. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;
    api.post('/delete-all', { confirm: 'DELETE' }).then(function (r) {
      if (!r.ok) return window.alert(r.data.error || 'That did not work. Please try again.');
      current = null;
      selectTab('questions');
      loadState(true);
    });
  });

  /* ---- content ---------------------------------------------------------------------- */

  var GOALS = { trust: 'Trust', expertise: 'Expertise', growth: 'Growth', sales: 'Sales' };
  var openIdea = null;

  function loadIdeas() {
    return api.get('/ideas').then(function (r) {
      if (!r.ok) return;
      var job = r.data.job;
      var running = job && job.status === 'running';
      $('y-ideas-go').disabled = running;
      msg('y-ideas-status', running ? 'Thinking up ideas from your stories…' : job && job.status === 'failed' ? job.error : '');
      show('y-ideas-empty', !r.data.ideas.length && !running);
      renderIdeas(r.data.ideas);
      if (running || r.data.ideas.some(function (i) { return busy(i.pack) || busy(i.cover); })) schedulePoll(true);
    });
  }
  function busy(j) { return !!(j && j.status === 'running'); }

  $('y-ideas-go').addEventListener('click', function () {
    $('y-ideas-go').disabled = true;
    api.post('/ideas').then(function (r) {
      if (!r.ok) {
        $('y-ideas-go').disabled = false;
        return msg('y-ideas-status', r.data.error);
      }
      loadIdeas();
    });
  });

  function renderIdeas(ideas) {
    var ul = $('y-ideas');
    ul.textContent = '';
    ideas.forEach(function (i) {
      var li = el('li', 'mp-item y-idea');
      li.dataset.id = i.id;
      var h = el('h3', null, i.topic);
      h.appendChild(el('span', 'y-goal', GOALS[i.goal] || i.goal));
      li.appendChild(h);
      li.appendChild(el('p', 'mp-sub', i.angle + (i.story ? ' (from your story "' + i.story + '")' : '')));
      var foot = el('div', 'mp-item-foot');
      var open = el('button', 'mp-link', openIdea === i.id ? 'Close' : i.pack && i.pack.status === 'ready' ? 'Open the content' : 'Write the content');
      open.type = 'button';
      open.addEventListener('click', function () {
        if (openIdea === i.id) {
          openIdea = null;
          return loadIdeas();
        }
        openIdea = i.id;
        if (!i.pack) api.post('/ideas/' + i.id + '/pack').then(function (r) {
          if (!r.ok) window.alert(r.data.error);
          loadIdeas();
        });
        else loadIdeas();
      });
      foot.appendChild(open);
      var del = el('button', 'mp-link', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this idea and its content?')) return;
        api.post('/ideas/' + i.id + '/delete').then(function (r) {
          if (!r.ok) window.alert(r.data.error);
          loadIdeas();
        });
      });
      foot.appendChild(del);
      li.appendChild(foot);
      if (openIdea === i.id) li.appendChild(packView(i));
      ul.appendChild(li);
    });
  }

  function packView(i) {
    var box = el('div', 'y-pack');
    if (busy(i.pack)) {
      box.appendChild(el('p', 'mp-hint', 'Writing your script, post and titles… (about half a minute)'));
      return box;
    }
    if (i.pack && i.pack.status === 'failed') {
      box.appendChild(el('p', 'mp-error', i.pack.error));
      var again = el('button', 'mp-btn mp-btn-ghost', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () { api.post('/ideas/' + i.id + '/pack').then(loadIdeas); });
      box.appendChild(again);
      return box;
    }
    box.appendChild(el('p', 'mp-hint', 'Loading…'));
    api.get('/ideas/' + i.id).then(function (r) {
      if (!r.ok || !r.data.content) return;
      box.textContent = '';
      fillPack(box, r.data.idea, r.data.content);
    });
    return box;
  }

  function copyButton(text) {
    var b = el('button', 'mp-link y-copy', 'Copy');
    b.type = 'button';
    b.addEventListener('click', function () {
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this:', text); });
      else window.prompt('Copy this:', text);
    });
    return b;
  }
  function heading(text, copyText) {
    var h = el('h4', null, text);
    if (copyText) h.appendChild(copyButton(copyText));
    return h;
  }

  function fillPack(box, idea, c) {
    box.appendChild(heading('Title options'));
    var ol = el('ol', 'y-titles');
    c.titles.forEach(function (t) { ol.appendChild(el('li', null, t)); });
    box.appendChild(ol);

    var spoken = c.script.map(function (l) { return l.say; }).join('\n');
    box.appendChild(heading('Short video script · about ' + c.seconds + ' seconds', spoken));
    box.appendChild(el('p', 'y-hook', c.hook));
    var table = el('table', 'y-script');
    c.script.forEach(function (l) {
      var tr = el('tr');
      tr.appendChild(el('td', null, l.say));
      tr.appendChild(el('td', null, l.show));
      table.appendChild(tr);
    });
    box.appendChild(table);

    box.appendChild(heading('How to film it'));
    var ul = el('ul', 'y-filming');
    [['Framing', c.filming.framing], ['Light', c.filming.light], ['Sound', c.filming.sound], ['Where', c.filming.location]].forEach(function (f) {
      if (f[1]) ul.appendChild(el('li', null, f[0] + ': ' + f[1]));
    });
    (c.filming.tips || []).forEach(function (t) { ul.appendChild(el('li', null, t)); });
    box.appendChild(ul);

    var caption = c.caption + (c.hashtags.length ? '\n\n' + c.hashtags.join(' ') : '');
    box.appendChild(heading('Caption for Shorts and Reels', caption));
    box.appendChild(el('p', 'y-text', caption));
    box.appendChild(heading('Post', c.post));
    box.appendChild(el('p', 'y-text', c.post));
    if (c.postingTips && c.postingTips.length) {
      box.appendChild(heading('When and how to post'));
      var tips = el('ul', 'y-filming');
      c.postingTips.forEach(function (t) { tips.appendChild(el('li', null, t)); });
      box.appendChild(tips);
    }
    if (c.ruleIssues && c.ruleIssues.length) box.appendChild(el('p', 'mp-hint', 'Check before posting: ' + c.ruleIssues.join(', ') + '.'));

    box.appendChild(heading('Cover'));
    box.appendChild(coverView(idea, c));
  }

  /* ---- covers -------------------------------------------------------------------------- */

  var FORMATS = { reel: [1080, 1920], post: [1080, 1350] };

  function coverView(idea, c) {
    var wrap = el('div', 'y-cover');
    var tall = el('canvas');
    tall.width = FORMATS.reel[0];
    tall.height = FORMATS.reel[1];
    var square = el('canvas', 'is-post');
    square.width = FORMATS.post[0];
    square.height = FORMATS.post[1];
    var tools = el('div', 'y-cover-tools');
    var label = el('label', 'mp-label', 'Cover text');
    var input = el('input');
    input.type = 'text';
    input.maxLength = 60;
    input.value = c.cover.text || c.titles[0] || '';
    label.appendChild(input);
    tools.appendChild(label);
    var status = el('p', 'mp-hint');
    var actions = el('div', 'mp-actions');
    tools.appendChild(actions);
    tools.appendChild(status);

    var image = null;
    var draw = function () {
      paint(tall, image, input.value);
      paint(square, image, input.value);
    };
    input.addEventListener('input', draw);

    if (busy(idea.cover)) {
      status.textContent = 'Drawing your cover… (about 15 seconds)';
    } else if (idea.cover && idea.cover.status === 'ready') {
      api.blob('/ideas/' + idea.id + '/cover').then(function (r) {
        if (!r.ok) return;
        var img = new Image();
        img.onload = function () {
          image = img;
          draw();
        };
        img.src = URL.createObjectURL(r.blob);
      });
      actions.appendChild(downloadButton('Download for Shorts / Reels', tall, idea.topic + ' - reel'));
      actions.appendChild(downloadButton('Download for posts', square, idea.topic + ' - post'));
      var redo = el('button', 'mp-link', 'Draw a different cover');
      redo.type = 'button';
      redo.addEventListener('click', function () { requestCover(idea); });
      tools.appendChild(redo);
    } else {
      if (idea.cover && idea.cover.status === 'failed') status.textContent = idea.cover.error;
      var go = el('button', 'mp-btn', 'Draw the cover');
      go.type = 'button';
      go.addEventListener('click', function () { requestCover(idea); });
      actions.appendChild(go);
      if (!state || !state.photo) tools.appendChild(el('p', 'mp-hint', 'Tip: add your photo under My Brand first, so the cover shows you.'));
    }
    wrap.appendChild(tall);
    wrap.appendChild(square);
    wrap.appendChild(tools);
    setTimeout(draw, 0);
    return wrap;
  }

  function requestCover(idea) {
    api.post('/ideas/' + idea.id + '/cover').then(function (r) {
      if (!r.ok) window.alert(r.data.error);
      loadIdeas();
    });
  }

  /* The picture, cropped to fill, with the title in the calm top area. */
  function paint(canvas, img, text) {
    var g = canvas.getContext('2d');
    var W = canvas.width;
    var H = canvas.height;
    g.fillStyle = '#e9eaee';
    g.fillRect(0, 0, W, H);
    if (img) {
      var s = Math.max(W / img.width, H / img.height);
      var w = img.width * s;
      var h = img.height * s;
      g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    }
    var grad = g.createLinearGradient(0, 0, 0, H * 0.45);
    grad.addColorStop(0, 'rgba(10,12,20,0.72)');
    grad.addColorStop(1, 'rgba(10,12,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H * 0.45);
    text = String(text || '').trim().toUpperCase();
    if (!text) return;
    var size = Math.round(W * 0.105);
    var lines;
    for (;;) {
      g.font = '800 ' + size + 'px Inter, "Helvetica Neue", Arial, sans-serif';
      lines = wrapText(g, text, W * 0.86);
      if (lines.length <= 3 || size < W * 0.06) break;
      size -= 6;
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = '#fff';
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = size * 0.25;
    var y = H * 0.07;
    lines.forEach(function (l) {
      g.fillText(l, W / 2, y);
      y += size * 1.08;
    });
    g.shadowBlur = 0;
  }
  function wrapText(g, text, max) {
    var words = text.split(/\s+/);
    var lines = [];
    var line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > max && line) {
        lines.push(line);
        line = w;
      } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }
  function downloadButton(label, canvas, name) {
    var b = el('button', 'mp-btn mp-btn-ghost', label);
    b.type = 'button';
    b.addEventListener('click', function () {
      canvas.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name.replace(/[^\w -]+/g, '').slice(0, 60) + '.png';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
      }, 'image/png');
    });
    return b;
  }

  /* ---- polling while work is running ---------------------------------------------------- */

  function schedulePoll(force) {
    clearTimeout(pollTimer);
    var reading = state && state.reading > 0;
    if (!force && !reading) return;
    pollTimer = setTimeout(function () {
      var tab = (root.querySelector('.mp-tabs [aria-selected="true"]') || {}).dataset;
      tab = tab ? tab.tab : 'questions';
      if (tab === 'content') loadIdeas();
      else if (tab === 'brand') {
        loadState(false);
        loadBrand();
      } else loadState(false);
    }, 4000);
  }

  /* ---- boot ------------------------------------------------------------------------------ */

  if (PREVIEW) {
    var note = el('p', 'mp-preview', 'Preview. This page only works once it is published on StrategyTraining.com and you are signed in.');
    $('y-app').insertBefore(note, $('y-app').firstChild);
    root.classList.remove('is-booting');
    show('y-app', true);
  } else if (!window.STMember) {
    showGate('service_down');
  } else {
    window.STMember.identify('[st-yma]').then(function (who) {
      if (who.signedIn === false && !who.transient) {
        lastIdentity = who;
        return showGate('signed_out');
      }
      return startSession(who);
    });
  }
})();
