'use strict';

/* ---------------------------------------------------------------------------
   The "your MasterPlan is ready" email.

   The delivery method is still to be supplied, so this file has one job:
   build the message and hand it to a driver.
     log      (default) prints the message. Nothing is lost while the real
              method is being decided.
     webhook  POSTs { to, from, subject, html, text } as JSON to
              MP_EMAIL_WEBHOOK_URL, with MP_EMAIL_WEBHOOK_SECRET as a Bearer
              token. Fits most senders (an n8n flow, a Zapier hook, a small
              relay in front of any email API).
   To add a provider, add a driver below; nothing else needs to change.

   The email carries links to the page only. The PDFs are never attached:
   they are meant to be read on StrategyTraining.com and not downloaded.
   --------------------------------------------------------------------------- */

const config = require('./config');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readyMessage({ to, name, articleTitle, podcastTitle, reportId }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const link = config.pageUrl + (config.pageUrl.includes('?') ? '&' : '?') + 'report=' + encodeURIComponent(reportId);
  const subject = 'Your MasterPlan is ready';
  const podcastLine = podcastTitle
    ? `The Debate: ${podcastTitle} - a podcast in which two hosts debate your career and where it goes next.`
    : '';
  const text = [
    `Hi ${first},`,
    '',
    'Your pre-populated MasterPlan is ready on StrategyTraining.com:',
    '',
    '  1. The MasterPlan - your answers to the nine questions, the four exercises and chapters eleven to twenty, drafted from your resume and profiles.',
    `  2. ${articleTitle || 'Your leadership case study'} - a case study in leadership psychology.`,
    ...(podcastLine ? ['  3. ' + podcastLine] : []),
    '',
    'All of them are on the MasterPlan page, under My MasterPlans.',
    '',
    'Read them here (sign in first):',
    link,
    '',
    'Everything marked with an asterisk is an inference for you to confirm, correct or reject. The draft exists to start a conversation; where it is wrong, the correction is the point.',
    '',
    'FIRMSconsulting · StrategyTraining.com',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#fff;color:#111;font-family:Georgia,'Times New Roman',serif">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
<p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#555;margin:0 0 24px">The MasterPlan Digital</p>
<p style="font-size:17px;line-height:1.55">Hi ${escapeHtml(first)},</p>
<p style="font-size:17px;line-height:1.55">Your pre-populated MasterPlan is ready on StrategyTraining.com.</p>
<ol style="font-size:16px;line-height:1.55;padding-left:20px">
<li><strong>The MasterPlan</strong> - the nine questions, the four exercises and chapters eleven to twenty, drafted from your resume and profiles.</li>
<li><strong>${escapeHtml(articleTitle || 'Your leadership case study')}</strong> - a case study in leadership psychology.</li>
${podcastTitle ? `<li><strong>The Debate: ${escapeHtml(podcastTitle)}</strong> - a podcast in which two hosts debate your career and where it goes next.</li>\n` : ''}</ol>
<p style="font-size:16px;line-height:1.55">All of them are on the MasterPlan page, under My MasterPlans.</p>
<p style="margin:28px 0"><a href="${escapeHtml(link)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;font-family:Arial,sans-serif;font-size:15px">Read your MasterPlan</a></p>
<p style="font-size:15px;line-height:1.55;color:#444">Everything marked with an asterisk is an inference for you to confirm, correct or reject. The draft exists to start a conversation; where it is wrong, the correction is the point.</p>
<p style="font-size:13px;color:#777;margin-top:32px">FIRMSconsulting · StrategyTraining.com</p>
</div></body></html>`;

  return { to, from: config.email.from, subject, text, html };
}

const drivers = {
  async log(msg) {
    console.log('[masterplan:email] (log driver) to=%s subject=%s\n%s', msg.to, msg.subject, msg.text);
  },
  async webhook(msg) {
    if (!config.email.webhookUrl) throw new Error('MP_EMAIL_WEBHOOK_URL is not set');
    const res = await fetch(config.email.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.email.webhookSecret ? { authorization: 'Bearer ' + config.email.webhookSecret } : {}),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('email webhook answered ' + res.status);
  },
};

async function sendReady(details) {
  const driver = drivers[config.email.driver] || drivers.log;
  await driver(readyMessage(details));
}

module.exports = { sendReady, readyMessage };
