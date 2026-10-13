'use strict';

/* ---------------------------------------------------------------------------
   Builds uscreen/agency-page.html - the block pasted into the Uscreen page
   "Your Marketing Agency" - from:

     masterplan/public/app.css   the shared look (MasterPlan's styles, .mp)
     agency/public/app.css       what this page adds (.yma)
     agency/views/app.html       the markup
     masterplan/public/member.js who is signed in and their plan (shared)
     agency/public/app.js        the behaviour

     npm run build:agency-page

   Then paste the new file into the Uscreen page again.
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_ORIGIN = process.env.MP_PUBLIC_ORIGIN || 'https://kris-ai-memory-baefm.ondigitalocean.app';
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const sharedCss = read('masterplan', 'public', 'app.css').replace(/^html, body \{[^}]*\}\r?\n/m, '');
if (/^html, body/m.test(sharedCss)) throw new Error('the html/body rule must not reach the store page');
const css = read('agency', 'public', 'app.css');
const html = read('agency', 'views', 'app.html').trim();
if (/<(main|header|nav)\b/i.test(html)) throw new Error('use divs in the tool markup, not main/header/nav');
const memberJs = read('masterplan', 'public', 'member.js');
const js = read('agency', 'public', 'app.js');
const agencyConfig = require('../agency/config');

const boot = {
  apiOrigin: API_ORIGIN,
  signInUrl: '/sign_in',
  joinUrl: '/join',
  /* A store page Uscreen opens only to members with a plan (the plan check
     without an API key; see masterplan/README.md). */
  planPage: '/delphi',
  maxAudioBytes: agencyConfig.maxAudioBytes,
  maxAudioMinutes: agencyConfig.maxAudioMinutes,
};

const out = `<!-- ==========================================================================
     StrategyTraining.com - YOUR MARKETING AGENCY page

     WHERE THIS GOES
     Uscreen admin > Marketing > Website > Landing Pages > + New page
       Page name:  Your Marketing Agency
       Page URL:   your-marketing-agency   (live at /pages/your-marketing-agency)
     Add a Custom HTML block, paste ALL of this file into it, publish.
     NOT into Settings > Snippets > Head Code.

     WHAT IT IS
     Members with a plan (same login as MasterPlan Digital) answer questions
     about their life, in writing or recorded. Their answers build a brand
     identity profile and a story bank, and become Shorts, Reels, posts and
     covers in their own voice. It talks to the server at ${API_ORIGIN}.

     GENERATED FILE - do not edit by hand. Built by "npm run build:agency-page".
     ========================================================================== -->

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600;800&display=swap">

<style>
${sharedCss.trim()}

${css.trim()}
</style>

${html}

<script>window.YMA_BOOT = ${JSON.stringify(boot)};</script>
<script>
${memberJs.trim()}
</script>
<script>
${js.trim()}
</script>
`;

const target = path.join(ROOT, 'uscreen', 'agency-page.html');
fs.writeFileSync(target, out);
console.log('wrote %s (%d KB)', path.relative(ROOT, target), Math.round(out.length / 1024));
