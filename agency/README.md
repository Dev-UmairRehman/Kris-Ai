# Your Marketing Agency

A StrategyTraining.com product for members with a plan, on the same login as
MasterPlan Digital. A member answers questions about their life, in writing or
recorded; the answers build a **brand identity profile** and a **story bank**,
and become **Shorts / Reels scripts, posts, titles and covers** in their own
voice.

It lives on the Kris AI Memory server next to MasterPlan (`/agency`) and uses
MasterPlan's member login and plan check, Supabase storage and OpenRouter
access. Nothing about it is shared between members.

## The member's journey

1. **Ten starter questions**, one from each level of the client's question bank
   (Authority Based Business, 172 questions in 10 levels, `questions.json`).
   Chosen to bring out stories, painful ones later.
2. Each answer is **typed, recorded in the browser, or uploaded** as audio. A
   recording is turned into text that the member checks before saving; the
   audio is not kept.
3. Each saved answer is **read into the profile and story bank** in the
   background. A thin answer gets one follow-up "why?".
4. After the starters, **one new question every 2 days** (`YMA_NEXT_EVERY_DAYS`),
   levels in turn. Level 10's summary questions open once 60% is answered.
   Any open question can be re-answered.
5. **My Brand**: the profile (editable; an edited field is never overwritten),
   things to confirm, the story bank, writing rules, the cover photo, and
   "delete all my data".
6. **Content**: topic ideas → per idea a 30-60 s vertical script (what to say,
   what to show), filming notes, caption + hashtags, a written post, 3 titles,
   posting tips, and a cover picture with the title drawn on it, downloadable
   for Shorts/Reels (9:16) and posts (4:5).

## Privacy

Answers are personal (the client's own example includes abuse). Every story is
tiered **P** publishable, **A** ask first, **X** private. Only P stories ever
reach the ideas and writing models; the member can change any tier. Members
see only their own data; `test/agency.test.js` checks that another member
gets nothing.

## Models (cheapest that does the job well)

| Job | Default | About |
|---|---|---|
| Audio → text | `google/gemini-3.5-flash-lite` | 7¢ an hour of speech |
| Answer → profile, stories | `anthropic/claude-sonnet-5.5` | 3¢ an answer |
| Ideas | `anthropic/claude-sonnet-5.5` | 1¢ for six |
| Script, post, titles | `anthropic/claude-opus-5.5` | 6¢ a pack |
| Cover picture | `google/gemini-3.1-flash-image` | 7¢ a cover |

All are `YMA_MODEL_*` settings. Measured on a real run: one answer → profile →
6 ideas → 1 pack → 1 cover cost $0.17. Everything is generated only when the
member asks. Daily limits per member (`YMA_*_PER_DAY`) and a site-wide daily
dollar ceiling (`YMA_GLOBAL_DOLLARS_PER_DAY`) stop runaway costs.

The writing rules are Kris's global writing rules for everyone (`rules.js`),
plus each member's own. What a program can check (banned phrases, em dashes,
"not X but Y", emojis...) is checked on every pack and sent back once for repair.

## Files

```
agency/
  config.js        YMA_* settings, models, limits
  questions.json   the question bank (from the client's spreadsheet)
  questions.js     starters, the order of new questions, what is open
  rules.js         writing rules + lint
  engine.js        the model jobs: transcribe, absorb, ideas, pack, cover
  index.js         routes under /agency, storage, limits, background jobs
  views/app.html   the page markup
  public/app.css   the page's own styles (on top of masterplan/public/app.css)
  public/app.js    the page
masterplan/public/member.js   who is signed in + plan check (shared)
scripts/build-agency-page.js  -> uscreen/agency-page.html
```

Storage keys (Supabase via `masterplan/store.js`): `yma/members/<id>.json`,
`yma/answers/<id>/<qid>.json`, `yma/packs/<id>/<idea>.json`, files
`yma/photos/<id>.img`, `yma/covers/<id>/<idea>.img`, `yma/usage.json`.

## Switching it on

Set `YMA_ENABLED=true` on the app (it needs MasterPlan running on OpenRouter),
deploy, then paste `uscreen/agency-page.html` into a Uscreen landing page
(URL `your-marketing-agency`). `GET /agency/healthz` shows its state.

```
npm run test:agency          # no API credit spent; models are stubbed
npm run build:agency-page
```

## Later

Linking YouTube / Instagram / TikTok to measure views, and analysing existing
channels, need Google and Meta app approval; planned as the next phase.
