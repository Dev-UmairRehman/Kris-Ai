# MasterPlan Digital

A StrategyTraining.com product. A member uploads a resume, adds public social
profile links and their city / ZIP. Claude reads them against the MasterPlan
Master Guide and makes three outputs:

1. **The MasterPlan** - the nine questions, the four exercises, chapters eleven
   to twenty and the synthesis (about 25 pages).
2. **The leadership case article** - a case study in leadership psychology
   (about 9 pages).
3. **The podcast** - "The Debate", two hosts arguing the member's career like
   NFL analysts on a promising prospect, ending on the coming conversation with
   Kris AI (about 18 minutes). It replaces the client's NotebookLM Audio
   Overview (Debate, default length, English, both documents as sources, their
   focus text), which has no public API.

The member is emailed once all three are ready and reads and listens on the
site. Nothing is downloadable: the PDFs are drawn on canvas (no text layer), the
episode plays from memory through the page's own player (no file URL, no
native audio menu), and both are fetched with the member's token.

This module rides on the Kris AI Memory server to avoid a second
DigitalOcean app. It shares only the member gate (`lib/auth.js`,
`lib/uscreen.js`). It has its own settings (`MP_*`), its own storage, its own
session tokens and its own routes under `/masterplan`. It is **not** part of
Michael AI and uses none of Michael AI's services. If it fails to load, Kris AI
keeps running.

## How a report is made

| Stage | What happens | Where |
|---|---|---|
| reading | resume text (PDF goes to Claude as a document, .docx is unzipped here), public profile pages (title + description only, private addresses refused), pasted bio | `intake.js` |
| profile | Claude extracts a structured profile, with the Master Guide in a cached system prompt | `writer.js` |
| researching | Claude with web search finds home price, rent, property tax, insurance, salary - each with a named source or "judgment" | `costs.js` |
| cost model | the arithmetic, in code - a port of the client's `build_story.py`; reproduces the test client's $18,210 a month exactly | `costs.js`, `test/costs.test.js` |
| writing | eight narrative parts plus the article, five calls at a time, all reading one cached system prompt (guide + method + both worked examples) | `writer.js` |
| checks | em dashes removed, names other than the member's flagged (book case-study people, theorists, the test client), "not X but Y" flagged; one targeted repair call if needed | `writer.js` |
| rendering | markdown -> PDF with pdfmake (pure JS, no browser): Gelasio (Georgia metrics), the guide's margins, callouts, ruled tables, shaded sidebars, brand footer | `render.js` |
| ready | stored and readable at once, added to the Library if the member shares | `jobs.js` |
| podcast | Claude writes the two-host script from both documents; each line is voiced by `openai/gpt-audio` through OpenRouter (two voices, word for word, four lines at a time); joined with short pauses and encoded to MP3 in a worker thread (lamejs, no ffmpeg). Its failure never touches the documents: it shows as not finished with "Try the podcast again" | `podcast.js`, `mp3-worker.js` |
| email | once, after the podcast (or its failure), listing what is ready | `mailer.js` |

About eleven model calls a report. Rough cost on Claude Opus 5.5 at high
effort: a few dollars, plus roughly $1.50 for the podcast's voices and a little
for its script (logged per report as `costEstimateUsd`, the podcast's share in
`podcast.costEstimateUsd`). `MP_PODCAST=false` turns the podcast off;
`MP_PODCAST_MODEL=openai/gpt-audio-mini` cuts the voice cost to cents at
some loss of liveliness.

## Sharing

A member who shares sees every other sharing member's MasterPlans in the
Library, and theirs are visible there. A member who does not share sees only
their own. Turning sharing off removes theirs from the Library and closes it to
them. Enforced on the server (`jobs.canView`), not in the page.

## Storage (Supabase)

Project `zsgprbkuocjmbnkemcvw` (eu-west-3, next to the app in Frankfurt).
Records are rows in `public.mp_records` (key, jsonb value); files are in the
private Storage bucket `masterplan`:

```
members/<id>.json              record   email, sharing choice, devices, report ids
reports/<id>/meta.json         record   status, stage, page counts, cost
reports/<id>/work.json         record   profile, research, both drafts (re-render without re-writing)
shared.json, active.json, usage.json    the Library, the queue, the daily counts
reports/<id>/inputs.json       file     what the member submitted (deleted once the documents are ready)
reports/<id>/narrative.pdf     file
reports/<id>/article.pdf       file
reports/<id>/podcast.mp3       file
```

Only the server touches it, over Supabase's HTTPS APIs with the secret key
(`MP_SUPABASE_SECRET_KEY`): no database driver and no open connection. Row
level security is on with no policies and the bucket is private, so the
publishable key reads nothing. The database password is not used at runtime;
it was needed once to apply `sql/001_storage.sql`.

Lean by design: records are cached in memory and written through (the page's
polling costs no database call), PDFs and podcasts are cached on the server's
disk up to `MP_FILE_CACHE_MB` (a re-open is not a re-download), and the
uploaded resume is deleted as soon as the drafts are saved. Rough size per
report: ~0.3 MB of records and ~11 MB of files, nearly all of it the podcast.

Live test of the driver (writes a throwaway key and removes it):
`MP_TEST_SUPABASE=1 node --env-file=.env --test masterplan/test/supabase.test.js`

## Uscreen page

1. Marketing > Website > Landing Pages > new page, slug `masterplan` (live at /pages/masterplan; the email links there).
2. Paste `uscreen/masterplan-page.html` into its Custom HTML block.
3. Add it to the menu next to Kris AI.

The loader (`public/embed.js`) is hosted, like Kris AI's, so changes ship with a
deploy. It reads the signed-in member from `/account` and passes `?report=<id>`
from the email link through to the page.

## Settings

See the `MP_*` block in `.env.example` and `.do/app.yaml`. Needed to switch on:
`MP_ENABLED=true`, `MP_OPENROUTER_API_KEY` (or `MP_LLM_PROVIDER=anthropic` with `MP_ANTHROPIC_API_KEY`), and the Supabase settings.

The model is Claude Opus 5.5 either way. Through OpenRouter (`llm.js`) the request is pinned to
Anthropic as the provider, the cached system prompt, the PDF resume and Anthropic's native web
search all pass through, and the exact charge per report comes back in `costEstimateUsd`.
`GET /masterplan/healthz` lists anything missing.

Email goes through Resend (`MP_EMAIL_DRIVER=resend`, `MP_RESEND_API_KEY`). The
domain of `MP_EMAIL_FROM` must be verified in that Resend account. A message
Resend refuses is written to the app log instead, so it is never lost.
`MP_EMAIL_DRIVER=log` (development) only logs.

## Local development

```
MEMBER_GATE_MODE=open NODE_ENV=development MP_ENABLED=true MP_STORAGE=disk \
MP_OPENROUTER_API_KEY=sk-or-... node server.js
# open http://localhost:8080/masterplan/preview   (the Uscreen page, locally)
# open http://localhost:8080/masterplan/embed
```

Tests (no API credit spent; the model is stubbed):

```
npm run test:masterplan
```

## Known limits

- View-only stops casual saving. It cannot stop a screenshot.
- Instagram and LinkedIn often show a server only a login wall; the form has a
  paste box for that, and the document says how thin the feed evidence was.
- The queue runs in the web process (one instance). A deploy mid-report
  restarts that report from the beginning.
- Gate mode `frame` trusts the store page's signed-in claim (as Kris AI does).
  `strict` verifies the subscription with the Uscreen API key.
