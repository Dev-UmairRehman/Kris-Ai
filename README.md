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
