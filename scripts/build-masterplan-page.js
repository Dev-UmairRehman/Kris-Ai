'use strict';

/* ---------------------------------------------------------------------------
   Builds uscreen/masterplan-page.html - the block pasted into the Uscreen
   "MasterPlan Digital" page - from the app's own files:

     masterplan/views/app.html    the markup (the <main id="mp"> element)
     masterplan/public/app.css    the styles (all scoped under .mp)
     masterplan/public/app.js     the behaviour

   So the page in Uscreen and the app never drift apart. Run after changing
   any of those three:

     npm run build:masterplan-page

   Then paste the new file into the Uscreen page again.
   --------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_ORIGIN = process.env.MP_PUBLIC_ORIGIN || 'https://kris-ai-memory-baefm.ondigitalocean.app';

const html = fs.readFileSync(path.join(ROOT, 'masterplan', 'views', 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'masterplan', 'public', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'masterplan', 'public', 'app.js'), 'utf8');

/* The tool's markup: from <div id="mp"> to just before the boot script. Plain
   divs (no main/header/nav) so store-wide tag styles cannot reach it. */
const start = html.indexOf('<div id="mp"');
const end = html.indexOf('<script>window.MP_BOOT');
if (start < 0 || end < start) throw new Error('No <div id="mp"> ... boot script in views/app.html');
const main = [html.slice(start, end).trim()];
if (/<(main|header|nav)\b/i.test(main[0])) throw new Error('use divs in the tool markup, not main/header/nav');

/* The store page has its own body; only the .mp rules travel. */
const pageCss = css.replace(/^html, body \{[^}]*\}\r?\n/m, '');
if (/^html, body/m.test(pageCss)) throw new Error('the html/body rule must not reach the store page');

const boot = {
  mode: 'page',
  apiOrigin: API_ORIGIN,
  ready: true,
  signInUrl: '/sign_in',
  joinUrl: '/join',
  maxUploadBytes: 8 * 1024 * 1024,
  pdfjsVersion: require('pdfjs-dist/package.json').version,
};

const out = `<!-- ==========================================================================
     StrategyTraining.com - THE MASTERPLAN DIGITAL page

     WHERE THIS GOES
     Uscreen admin > Marketing > Website > Landing Pages > + New page
       Page name:  MasterPlan Digital
       Page URL:   masterplan-digital     (live at /pages/masterplan-digital;
                                           the "your MasterPlan is ready"
                                           email links there)
     Add a Custom HTML block, paste ALL of this file into it, publish.
     Then add the page to the site menu next to Kris AI.
     NOT into Settings > Snippets > Head Code.

     WHAT IT IS
     The whole MasterPlan tool, on the page itself:
       1. Upload your resume
       2. Add your social profiles and where you live
       3. It generates the MasterPlan and the leadership case study, shows
          the progress, and opens both documents when they are ready
     plus My MasterPlans and the shared Library.
     It reads who is signed in from the store, and talks to the MasterPlan
     server at ${API_ORIGIN}.

     Opened outside StrategyTraining.com (as a file, in an editor preview) it
     shows the page with a "Preview" note; creating a MasterPlan only works on
     the published page.

     GENERATED FILE - do not edit by hand. Built from masterplan/views/app.html,
     masterplan/public/app.css and masterplan/public/app.js by
     "npm run build:masterplan-page".
     ========================================================================== -->

<style>
${pageCss.trim()}
</style>

${main[0]}

<script>window.MP_BOOT = ${JSON.stringify(boot)};</script>
<script>
${js.trim()}
</script>
`;

const target = path.join(ROOT, 'uscreen', 'masterplan-page.html');
fs.writeFileSync(target, out);
console.log('wrote %s (%d KB)', path.relative(ROOT, target), Math.round(out.length / 1024));
