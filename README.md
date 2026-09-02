# Kris AI Memory

Kris AI Memory - a self-hosted clone of the Delphi chat page at `strategytraining.com/delphi`, backed by
BuddyPro instead of Delphi, gated to signed-in StrategyTraining members, and deployable to
DigitalOcean App Platform.

The visual reference is the **live `/delphi` widget inside the StrategyTraining storefront**
(from member screenshots). Note that the *public* `delphi.ai/kris-safarova` profile page is
dark-themed and differently laid out - the embedded widget is light, brand-themed, and is what
this reproduces.

---

## What it is

One codebase, two routes:

| Route | Purpose |
| --- | --- |
| `/embed` | Bare widget. Goes in an iframe on the Uscreen `/delphi` page. No header or footer — Uscreen supplies those. |
| `/` | Standalone route. Same widget, reachable with a handoff token. |
| `/api/session` | Exchanges a store identity claim for a signed session cookie. |
| `/api/chat` | One question in, one answer out. |
| `/healthz` | Liveness, and reports which gate mode is active. |

Everything secret — the BuddyPro key, the Uscreen key, the signing secrets — lives only in
the server process. Nothing secret is ever written into the page.

---

## The member gate

**Requirement: only a signed-in StrategyTraining member may use this. Everyone else goes to
`strategytraining.com/join`.**

Four independent layers, so no single spoofable signal is load bearing:

1. **Frame lock.** `Content-Security-Policy: frame-ancestors` limits who may iframe the app.
   The browser enforces it, and it is set on every response.
2. **Origin check.** `/api/*` requires an `Origin`/`Referer` belonging to the store.
   Browsers set these headers and a page cannot forge them cross-origin.
3. **Identity proof.** The store page reports who is signed in; the server confirms that
   claim against the Uscreen API before trusting it. A forged value in the browser does not
   grant access.
4. **Signed session.** The result is sealed into an HMAC-SHA256 signed, HttpOnly,
   `SameSite=None; Secure` cookie carrying its own expiry, so verification runs once per
   session rather than once per message. There is no server-side session store, so the app
   scales horizontally with no shared state.

A direct hit on `/` or `/embed` without a session returns `302 → JOIN_URL`. Verified:

```
GET /embed  -> 302  Location: https://www.strategytraining.com/join
GET /       -> 302  Location: https://www.strategytraining.com/join
GET /embed  -> 200   (with Sec-Fetch-Dest: iframe from strategytraining.com)
```

### Gate modes — `MEMBER_GATE_MODE`

| Mode | Behaviour | Use when |
| --- | --- | --- |
| `strict` | Every visitor is verified against the Uscreen API. Requires `USCREEN_API_BASE` + `USCREEN_API_KEY`. | Production, once you have the Uscreen key. **Recommended.** |
| `frame` | Being inside the members-only `/delphi` iframe is treated as proof. No Uscreen key needed. | Right now — there is no Uscreen key yet. |
| `open` | No gate. Refused in production by `lib/config.js`. | Local development only. |

`strict` refuses to start without a Uscreen key, rather than silently denying every visitor.

**Current setting is `frame`,** because no Uscreen API key has been supplied yet. That means
membership is *inferred* from the iframe host rather than verified. Uscreen already hides
`/delphi` from non-subscribers, so the practical exposure is small, but a determined person
with `curl` could forge the `Referer` and reach the chat. Switch to `strict` as soon as you
have the key — it is a two-value env change, no code.

### To switch to `strict`

1. Get the publisher API key: Uscreen dashboard → Settings → Integrations → API (or ask
   Uscreen support).
2. Set `USCREEN_API_BASE` and `USCREEN_API_KEY`, then `MEMBER_GATE_MODE=strict`.
3. Restart. Watch the log for `[uscreen] using auth style #N with /path` — that line names
   the endpoint shape that worked.

`lib/uscreen.js` probes several known Uscreen API shapes (auth header style and lookup path)
because the exact shape differs per store and plan, then remembers the combination that
worked. Verified answers are cached for 10 minutes, so a member's whole session costs one
upstream call.

---

## Privacy: read this before going live

The key in use is `bapi_B2B_…`, which is the **Owner API** surface. BuddyPro's own docs say:

> The Owner API should NOT be used to create profiles for real people using test users
> — because the instance owner can access all conversation history and memories.

They recommend the End-user API for consumer access. That is not usable here: it requires
each end user to hold their own `bapi_B2C_` key with their own Stripe credits, which is not
something StrategyTraining members can be asked to do.

So this app uses the Owner API with **isolated per-member profiles**: each member's BuddyPro
`user` id is `st_` + an HMAC-SHA256 of their Uscreen id, salted with `MEMBER_ID_SALT`. That
gives every member a private thread with its own memory, and BuddyPro never receives their
name or email. It does **not** hide member conversations from whoever controls the BuddyPro
instance.

Two consequences to decide on:

- The UI carries the line *"Conversations are stored to give Kris AI memory."* Consider
  whether your privacy policy needs to say that staff may see them.
- `MEMBER_ID_SALT` must be set once and never changed. Changing it orphans every member's
  conversation memory.

---

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm start                 # http://127.0.0.1:8080
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`lib/config.js` validates everything at boot and refuses to start on a misconfiguration
rather than running in a degraded state.

### Tests

```bash
npm run smoke             # gate + security headers, no BuddyPro spend
LIVE=1 npm run smoke      # also spends one real BuddyPro call
npm run shots             # screenshots at 4 viewports + overflow detection
npm run shots:extra       # chat, call and history views, with assertions
npm run test:embed        # THE important one - see below
npm run probe:audio       # re-check whether BuddyPro audio has been enabled
npm run probe:language    # what actually forces BuddyPro into one language
npm run test:speech       # the recorder and the call, with a stubbed recogniser
```

`npm run test:embed` is the end-to-end integration test. It stands up a fake Uscreen
storefront on a **different origin**, iframes `/embed` into it, runs the real identity bridge
from `uscreen/head-code.html`, and asserts the whole path: the handshake in both directions,
bearer authentication across origins, and a live answer from BuddyPro inside the frame. Run it
with `MEMBER_GATE_MODE=frame` (add `http://localhost:8099` to `ALLOWED_FRAME_ORIGINS`) to
exercise the production gate rather than the dev one.

`scripts/shots.js` drives the installed Chrome through `puppeteer-core` and asserts
`scrollWidth <= clientWidth` at 1440/820/414/360. Plain `chrome --screenshot --window-size`
crops a wider layout instead of resizing it, which hides responsive bugs — that mistake was
made and caught during this build.

---

## Deploying to DigitalOcean

Nothing has been created on DigitalOcean yet. `.do/app.yaml` is a prepared spec, not an
applied one.

App Platform builds from a Git repo, so this directory needs to live in one (GitHub or
GitLab) before `doctl apps create` will work. It builds with the **Node buildpack** - no
Docker anywhere in this project.

```bash
doctl auth init --access-token <token>
doctl apps create --spec .do/app.yaml       # first deploy
doctl apps update <APP_ID> --spec .do/app.yaml
doctl apps logs <APP_ID> --type run --follow
```

Fill the `SECRET`-typed values in the DO dashboard rather than committing them.

Cost at `basic-xxs`: about **$5/month**.

### Keep `instance_count: 1`

The rate limiter is in-process. BuddyPro allows **30 requests/minute per key**, and two
instances would each allow 25, exceeding the ceiling and causing 429s for everyone at once.
If you scale out, divide `RATE_GLOBAL_PER_MIN` by the instance count.

---

## Wiring it into Uscreen

Two files in `uscreen/`. Replace `kris-ai-REPLACE.ondigitalocean.app` with the real
deployed origin in **both**.

1. **`uscreen/delphi-page-embed.html`** → the `/delphi` page's Custom HTML block, replacing
   the Delphi embed. Uscreen's editor canvas does not render Custom HTML; use *Preview page*.
2. **`uscreen/head-code.html`** → *Settings → Snippets → Head Code*. **Add to** the existing
   block; do not replace it — the gift-card and sub-nav snippets in
   `../head-code-COMBINED.html` must stay.

The head snippet is the identity bridge. The widget cannot read the Uscreen session cookie
across domains, so the store page tells it who is signed in:

```
widget -> parent :  { type: 'kris-ai:ready' }
parent -> widget :  { type: 'st-kris:identity', email, uscreenId }
```

Both sides post to an explicit origin, never `'*'`.

Uscreen does not document a stable way to read the current member from a snippet, so the
bridge tries, in order: known JS globals, `<meta>` tags, `data-` attributes, then several
same-origin authenticated JSON endpoints. It logs which source worked:

```
[st-kris] identity via fetch /api/v1/users/me
```

**Open the console on `/delphi` and send me that line.** Once we know which source your store
exposes, the lookup gets pinned to it and the guessing goes away. If none work you will see a
`[st-kris] could not determine the signed-in member` warning, and the gate falls back to
whatever `MEMBER_GATE_MODE` allows.

---

## BuddyPro notes

`POST https://api.buddypro.ai/v1/chat/completions`, OpenAI-shaped, `Bearer bapi_…`.
Constraints that shaped the code:

- **Send exactly one user message.** BuddyPro keeps the full history and long-term memory
  server-side, so replaying prior turns is wrong, not just wasteful.
- **No streaming.** One request, one complete answer. Measured latency is **5–9 seconds**,
  which is why the UI has a real thinking state rather than a spinner.
- **An error can arrive with HTTP 200** and an `error` object in the body. `lib/buddypro.js`
  always inspects the body.
- **30 requests/minute per key.** See the instance-count warning above.
- `model` is accepted and ignored.
- The prompt-override fields (`x_buddy_systemPrompt` and friends) are Owner-API only; the
  End-user API rejects them with `400 unsupported_parameter`.

Upstream failures are logged in full server-side and mapped to a neutral member-facing
message — billing and key problems are never surfaced to a member.

### One thing worth tuning

The BuddyPro profile currently opens with a "rules of engagement" preamble before answering:

> Before we dive in, let me go through a very quick introduction to keep us on track. Our
> general rules of engagement: number one is…

That is the bot's own configuration, not this app. It reads oddly as the first thing a member
sees in a web chat. Adjust it in BuddyPro (Telegram) if you want a cleaner first reply.

---

## Layout

```
server.js                     routes, gate enforcement, error mapping
lib/config.js                 env loading + fail-fast validation
lib/auth.js                   session tokens, cookies, origin checks, CSP
lib/uscreen.js                membership verification (endpoint probing + cache)
lib/buddypro.js               BuddyPro client and error mapping
lib/ratelimit.js              global + per-session sliding windows
views/app.html                one template, both modes
public/styles.css             the design tokens and layout
public/app.js                 boot, identity bridge, chat, voice
uscreen/                      the two snippets to paste into Uscreen
scripts/smoke.js              gate + chat assertions
scripts/shots.js              screenshots + overflow detection
.do/app.yaml                  DigitalOcean spec (not yet applied)
```

## What it reproduces

The visual target is the **live `/delphi` widget as it appears inside the StrategyTraining
storefront** — light ground, ST cyan (`--primary`, `#2bc0e3`), Poppins, a centred column with
a circular avatar and online dot, name + verified tick + credential chip, `Ask Kris…`,
Chat/Call pills, a left-aligned "Suggested Questions" list, and a pill composer.

Worth knowing: the **public** `delphi.ai/kris-safarova` profile page is dark-themed. The
**embedded** widget on StrategyTraining is light and brand-themed. This reproduces the
embedded one. (An earlier pass in this build followed the public page and was rebuilt.)

`--font-sans` in `public/styles.css` is Poppins, matching the storefront.

### What BuddyPro actually supports here

Measured with `npm run probe:audio` and repeated runs, not assumed:

| | Result |
| --- | --- |
| Text | Works |
| **Spoken replies, owner's default profile** | **Works** - 3/3, 20-23 KB mp3 returned |
| **Spoken replies, isolated `user` profile** | **Does not work** - 0/3, no `audio` object |
| Audio input (any format, rate, shape) | `500 Error processing the message` |
| Image input (`data:` URL) | 200, but "Can't see the image" |
| Image input (`https` URL) | `400 invalid_media_data` |

Two consequences worth understanding.

**Voice.** BuddyPro's TTS is real - it is the voice the Telegram bot uses - but it only comes
back on the **owner's default profile**. Every member shares that profile, so using it would
put every member into one conversation with one shared memory. That is not a trade worth
making, so the app keeps per-member isolation, asks for the spoken reply anyway, and falls
back to the device voice when none arrives. **Ask BuddyPro to enable TTS for API-created
(`user`) profiles** - the moment they do, Kris's real voice appears with no code change.

**Speech input.** Transcribed in the browser and sent as text, because the upload direction is
rejected outright.

### Language and the opening preamble - fixed

The bare profile drifts between languages (it answered a English question in romanised
Hindi/Urdu during testing) and opens every conversation with a "rules of engagement"
introduction. Both are fixed server-side with an Owner-API prompt override, sent on every
request:

```
baseline            "I'm going to go through a very quick introduction, and then we
                     will start. Our general rules of engagement..."
with the override   "That's the right question, and the answer is simpler than it
                     feels right now. Start with your objective..."
```

`BUDDYPRO_SYSTEM_PROMPT` holds the text (`x_buddy_systemPrompt` + `systemPromptMode: add`).
It is Owner-API only, so it is skipped automatically for an end-user key. Set it to an empty
value to send no override.

### Call — working

Delphi's call is realtime voice with a minutes budget. BuddyPro has no realtime channel, so
the call is assembled here:

1. **`SpeechRecognition`** transcribes what the member says.
2. The **text** goes to BuddyPro, which works fine.
3. The answer is spoken back with **BuddyPro's own voice** when it is returned, and with
   `speechSynthesis` otherwise (see the profile caveat above).
4. Recognition is suspended while Kris talks, otherwise the synthesised voice is transcribed
   straight back into the next question.

The full flow matches the reference: **Start a call → Connecting ••• → live** with a call
timer, minutes remaining, breathing cyan haloes, a **Talking** level meter, mic mute, end
call, and a language selector (six languages, wired to both recognition and synthesis).

Two honest limitations, surfaced in the UI itself rather than buried here:

- **The voice is currently the device's**, only because BuddyPro withholds TTS on isolated
  profiles. The wiring for the real voice is already in place and takes over automatically.
- **Calls need Chrome or Edge.** `SpeechRecognition` is unavailable in Firefox, and the
  button says so instead of failing. Note also that Chrome's implementation sends audio to
  Google for transcription — worth a line in the privacy policy.

The minutes budget (100, counting down, banked across reloads in `localStorage`) is cosmetic
parity with the reference. Real quota enforcement belongs server-side; not built.

### The call

Kris opens the call, then the states cycle - each with its own colour, so a member can tell at
a glance what is happening:

```
Connecting -> Talking (greeting) -> Listening -> Thinking -> Talking -> Listening
```

- **Listening** (neutral) they are speaking; we record and transcribe
- **Thinking** (amber) sent, waiting on the answer
- **Talking** (cyan, with a level meter) Kris is speaking

A call turn is now **the same round trip as a voice note** - the recording is sent, so the
answer comes back as BuddyPro's own TTS in the cloned voice. Previously the call spoke every
answer through `speechSynthesis`, which could never sound like Kris no matter what.

#### The greeting

There is no way to make BuddyPro speak arbitrary text. Measured: with `x_buddy_systemPrompt`
set to `replace` and a text-to-speech instruction, it repeats **the audio's transcript**
verbatim - not a supplied text part. So an exact-wording greeting has to be a recording.

The call plays `public/assets/greeting.mp3` when present, and reads the same words with the
device voice when it is not. Either way the paragraph is added to the thread as text, so the
words are never missing.

**To get the greeting in Kris's real voice:** send the introduction paragraph to the Kris bot
in Telegram, save the voice message it replies with, and drop it in as
`public/assets/greeting.mp3`. One-time, and no code change.

### Voice: what BuddyPro actually does, measured

BuddyPro's docs are explicit on the rule that governs everything here:

> When `modalities` includes `"audio"`, TTS is enabled … **TTS only applies when audio input is
> present in the request.** `audio.voice` is accepted but ignored — voice is set by the bot owner.

So a spoken reply, in the owner's own cloned voice, requires **sending the recording**. Text-only
requests get text back. That is why the app sends the audio rather than only its transcript.

**Formats.** Measured with `npm run probe:audio`:

| sent | result |
| --- | --- |
| real Ogg Vorbis file | HTTP 200, and mp3 audio comes back |
| WAV re-encoded from a real browser recording (16 kHz mono) | HTTP 200, and mp3 audio comes back |
| raw WebM/Opus - what Chrome actually records | HTTP 500, under every declared format |
| synthetic tone as WAV | HTTP 500 |
| audio by URL instead of base64 | HTTP 400 `invalid_media_data` |

Chrome can only record `audio/webm;codecs=opus` or `audio/mp4` - never ogg - so every recording
is decoded through `AudioContext` and re-encoded as **16 kHz mono WAV** before sending. That is
the combination that works.

**It is intermittent, though.** The same WAV that returned HTTP 200 with mp3 audio one minute
returned 500 the next, and text-only TTS on the owner's default profile went from 3/3 working to
0/4 within an hour. This is upstream, not payload shape - it was reproduced across fresh
profiles, warm profiles, with and without `x_buddy_systemPrompt`.

Because of that, `/api/chat` **retries as text** when an audio request fails with a 5xx and a
transcript is available:

```
[buddypro] 500 upstream_error: Error processing the message
[chat] audio upload failed (upstream_error); retrying as text
```

The member always gets an answer; only the voice is lost, falling back to the device voice.
When BuddyPro's audio is healthy the reply plays in Kris's real cloned voice with no code change.

**Worth raising with BuddyPro:** the intermittent 500s on `input_audio`, and that WebM/Opus - the
only thing browsers can record - is not accepted.

### Call — working

Delphi's call is realtime voice with a minutes budget. BuddyPro has no realtime channel, so
the call is assembled here:

1. **`SpeechRecognition`** transcribes what the member says.
2. The **text** goes to BuddyPro, which works fine.
3. The answer is spoken back with **BuddyPro's own voice** when it is returned, and with
   `speechSynthesis` otherwise (see the profile caveat above).
4. Recognition is suspended while Kris talks, otherwise the synthesised voice is transcribed
   straight back into the next question.

The full flow matches the reference: **Start a call → Connecting ••• → live** with a call
timer, minutes remaining, breathing cyan haloes, a **Talking** level meter, mic mute, end
call, and a language selector (six languages, wired to both recognition and synthesis).

Two honest limitations, surfaced in the UI itself rather than buried here:

- **The voice is currently the device's**, only because BuddyPro withholds TTS on isolated
  profiles. The wiring for the real voice is already in place and takes over automatically.
- **Calls need Chrome or Edge.** `SpeechRecognition` is unavailable in Firefox, and the
  button says so instead of failing. Note also that Chrome's implementation sends audio to
  Google for transcription — worth a line in the privacy policy.

The minutes budget (100, counting down, banked across reloads in `localStorage`) is cosmetic
parity with the reference. Real quota enforcement belongs server-side; not built.

### Voice messages, and why the voice is not Kris's

Tapping the microphone turns the composer into a recorder, the way a messenger does it: a
running timer, a live level trace from real microphone amplitude, cancel, and send. **A pause
never sends it** - the member decides. The question then appears as a voice note with a play
control and the transcript kept small underneath, and the answer comes back as a voice note
too.

Two things run at once while recording: `MediaRecorder` captures the audio so the question can
be played back, and `SpeechRecognition` transcribes it. Only the transcript is sent, because
BuddyPro rejects audio uploads on this instance.

**The spoken reply uses the device voice, not Kris's.** BuddyPro's TTS is real - it is the
Telegram voice - but it is withheld from API-created profiles. Measured, repeatedly
(`npm run probe:audio`):

First measurement:

```
isolated user (fresh / warm / saveToHistory either way)   AUDIO NO   0/3
default profile (no `user` field)                        AUDIO YES  3/3, 29-48KB mp3
```

Re-measured after `/useVoiceCloneForEverybody:true` was enabled in Telegram:

```
default profile           AUDIO NO   0/4     <- was 3/3
isolated user, fresh      AUDIO NO
isolated user, warm       AUDIO NO
member-shaped profile id  AUDIO NO
```

So API audio output, which worked on the default profile earlier the same day, **stopped
returning anything at all** - while the Telegram bot kept speaking in the cloned voice. That is
an upstream regression to raise with BuddyPro, and it is the reason the app speaks with a
different voice from Telegram.

The app requests `modalities:['text','audio']` on every voice turn regardless and falls back to
the device voice when none arrives, so **Kris's real voice appears with no code change** the
moment BuddyPro returns audio again. Re-check any time with `npm run probe:audio`.

### Chat history

Conversations, not loose questions - grouped under **Today / Yesterday / August 30** headings,
each row a single truncated title with an icon showing whether it was a chat or a call.
Clicking one replays it. Stored per browser in `localStorage` (BuddyPro exposes no endpoint to
read its own history back), migrating automatically from the older per-turn format.

### Speech endpointing: why it listened forever

Chrome's `SpeechRecognition` does not reliably tell you when someone has stopped talking.
With `continuous = false` it often keeps the session open long after the speaker finishes, and
it may never mark a result `isFinal`. The first implementation waited for a final result and
for `onend`, so it sat on **Listening** indefinitely and threw away perfectly good interim
text. The composer microphone looked dead for the same reason.

The fix inverts who decides:

- `continuous = true`, so Chrome never ends the turn on its own
- a **silence timer** (1.5s since the last result) ends it instead
- **interim text counts** - if Chrome never finalises, what it heard is still used
- a 30s hard cap, so a stuck recogniser cannot run forever
- tapping the microphone again ends the turn immediately

A second bug surfaced while testing this: `startListening()` returned early when a request was
in flight and never retried, so starting a call while the composer was still waiting left it
stuck with the microphone closed. It now waits for the turn to finish instead of giving up.

`npm run test:speech` proves both. It stubs `SpeechRecognition` to behave exactly like the
failing case - interim results only, never final, `onend` never fired - and asserts the turn
still completes:

```
the turn ends on silence instead of hanging   PASS
the interim text is what got sent             PASS   "what should I focus on"
the spoken turn was submitted, not hanging    PASS
the call did not spin restarting the recogniser  PASS
```

### Language: why replies came back in mixed languages

BuddyPro detects language **per message** and adapts to whatever the profile last used. Its
docs say the first interaction follows *"the language the user has set in their Telegram
app"* - and an API caller has no Telegram app, so it guesses. Worse, the adaptation is
sticky: once a conversation slips into another language, it keeps replying in that language.
A profile **drifts**.

Measured on the shared dev profile (`npm run probe:language`):

```
plain question                        ROMANISED HINDI/URDU (33 markers)
  "Yeh ek acha sawaal hai - aur pehli baar aapne kuch aisa poocha..."

+ "Please speak English with me"      ENGLISH
  "Glad you said that, let's do this in English..."
```

Two things that do **not** fix it, both tested:

- `x_buddy_systemPrompt` - accepted with HTTP 200 and **ignored**. The profile still opened
  with its "rules of engagement" preamble even when the prompt explicitly forbade one.
- A directive appended *after* the question - no better than none.

What does work is the remedy their own docs name: an explicit request, read before the
question. So `lib/buddypro.js` prefixes every message with

> Please speak {language} with me. Reply only in {language}, and never mix languages.

The member never sees it; only their own text is rendered. `RESPONSE_LANGUAGE` sets the
default (English), and the call view's language selector overrides it per conversation -
the same selector also drives the speech recogniser and the speech synthesiser, so all three
stay in step.

The language field from the browser is checked against an **allowlist** of six locales and
never interpolated as free text, so it cannot be used to smuggle instructions into the
prompt.

Note this drift is per profile. Each member has their own, so one member's conversation
cannot pull another member's into the wrong language. During local development everyone
shares the `dev-local` profile, which is why testing drifts it quickly.

### Chat view

Rebuilt to match the live widget rather than the public Delphi page:

- centred header — avatar with online dot, name, phone icon to start a call
- Kris in **grey left bubbles with no per-message avatar**; the member in **cyan right bubbles**
- long answers **split across several bubbles** on blank lines, as the reference does
- an **auto welcome message** opens the conversation
- a small markdown renderer for **bold**, italics, links as source chips and `[n]` citation
  marks — built with DOM nodes, never `innerHTML`, so model output cannot inject markup. It
  also strips stray `**` markers, which the reference UI visibly leaks
- collapsible **Suggested Questions** docked above the composer
- a floating jump-to-latest button that appears only when content is hidden below the fold

### No header or footer, on purpose

The widget renders **no site chrome at all** - no nav, no footer, no legal small print.
Uscreen already draws the StrategyTraining header and footer around the iframe, and shipping
our own duplicated them. Both routes are chrome-free, and `npm run shots:extra` asserts it
(`no duplicated storefront nav` / `footer`).

The composer is **pinned** to the bottom of a fixed shell rather than flowing inline after
the suggestion cards as it does on the Uscreen page. Inside a fixed-height iframe that keeps
it reachable without scrolling the host page; visually the two are near-identical when the
content is short.

The small dark chip beside the verified tick reads `DIGITAL TWIN`. The text in the live badge
is too small to read in a screenshot — tell me what it should say and it is a one-line change
in `views/app.html`.
