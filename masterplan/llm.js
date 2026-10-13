'use strict';

/* ---------------------------------------------------------------------------
   The one place this module talks to Claude.

   - Streaming with finalMessage(): the essays are long, and streaming keeps a
     long generation clear of HTTP timeouts.
   - Adaptive thinking is always on for this model; depth is set with effort.
   - fallbacks:"default" lets the API re-run a request on another model if a
     safety classifier declines it (a psychological case study about a real
     person is the kind of text that can trip one), instead of failing the job.
   - The Master Guide and the worked examples go in the system prompt with a
     cache breakpoint, so every section call after the first reads them from
     cache at a tenth of the price.
   --------------------------------------------------------------------------- */

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: config.anthropic.apiKey,
      maxRetries: 3,
      timeout: 20 * 60 * 1000,
    });
  }
  return client;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const useFallbacks = process.env.MP_FALLBACKS !== 'false';

class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function addUsage(total, usage) {
  if (!usage) return;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[k] = (total[k] || 0) + (usage[k] || 0);
  }
  const searches = usage.server_tool_use && usage.server_tool_use.web_search_requests;
  if (searches) total.web_search_requests = (total.web_search_requests || 0) + searches;
}

/**
 * One generation. Returns { text, usage, model }.
 *
 * @param {object} p
 * @param {Array|string} p.system      system blocks (cache_control already set) or a string
 * @param {Array|string} p.content     user message content
 * @param {string} [p.effort]
 * @param {number} [p.maxTokens]
 * @param {Array}  [p.tools]           server tools, e.g. web search
 * @param {object} [p.format]          output_config.format (structured output)
 * @param {object} [p.usage]           accumulator, mutated
 */
async function generateAnthropic(p) {
  const usage = p.usage || {};
  const messages = [{ role: 'user', content: p.content }];

  const params = {
    model: config.anthropic.model,
    max_tokens: p.maxTokens || 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: p.effort || config.anthropic.effort },
    system: p.system,
    messages,
  };
  if (p.format) params.output_config.format = p.format;
  if (p.tools) params.tools = p.tools;
  if (useFallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }

  /* Server tools (web search) can pause a long turn; resend to resume. */
  for (let round = 0; round < 6; round++) {
    const message = await getClient().beta.messages.stream(params).finalMessage();
    addUsage(usage, message.usage);

    if (message.stop_reason === 'refusal') {
      const why = message.stop_details ? message.stop_details.category : 'unknown';
      throw new LlmError('The model declined this request (' + why + ').', 'refusal');
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LlmError('The response was cut off at the length limit.', 'max_tokens');
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage, model: message.model };
  }
  throw new LlmError('The model kept pausing and never finished.', 'pause_loop');
}

/* ---- OpenRouter --------------------------------------------------------------
   The same Claude model through OpenRouter's chat completions API. The
   pipeline speaks in Anthropic shapes; this translates them:
     system / text blocks with cache_control -> content parts with cache_control
       (OpenRouter passes the breakpoint to Anthropic, so the guide is still
        cached across a report's calls)
     a PDF document block -> a file part, read natively by Claude
     the web_search server tool -> the "web" plugin on Anthropic's native search
     effort -> reasoning.effort
   Requests are pinned to Anthropic as the provider so caching stays on one
   backend. Streamed, so a long essay never sits on an idle connection. */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function toParts(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return blocks.map((b) => {
    if (b.type === 'document' && b.source && b.source.media_type === 'application/pdf') {
      return { type: 'file', file: { filename: 'resume.pdf', file_data: 'data:application/pdf;base64,' + b.source.data } };
    }
    /* Audio and images, for products that pass them (Your Marketing Agency). */
    if (b.type === 'audio') return { type: 'input_audio', input_audio: { data: b.data, format: b.format || 'mp3' } };
    if (b.type === 'image_data') return { type: 'image_url', image_url: { url: 'data:' + (b.media || 'image/jpeg') + ';base64,' + b.data } };
    const part = { type: 'text', text: b.text };
    if (b.cache_control) part.cache_control = b.cache_control;
    return part;
  });
}

async function openRouterOnce(body) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + config.anthropic.openrouterKey,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://www.strategytraining.com',
      'X-Title': 'StrategyTraining MasterPlan Digital',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    const err = new LlmError('OpenRouter answered ' + res.status + ': ' + text, 'http_' + res.status);
    err.status = res.status;
    throw err;
  }

  let text = '';
  let finish = null;
  let usage = null;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.error) {
        const err = new LlmError('OpenRouter stream error: ' + (evt.error.message || JSON.stringify(evt.error)), 'stream_error');
        err.status = evt.error.code;
        throw err;
      }
      const choice = evt.choices && evt.choices[0];
      if (choice) {
        if (choice.delta && typeof choice.delta.content === 'string') text += choice.delta.content;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (evt.usage) usage = evt.usage;
    }
  }
  return { text, finish, usage };
}

async function generateOpenRouter(p) {
  const usage = p.usage || {};
  const messages = [];
  if (p.system) {
    messages.push({ role: 'system', content: typeof p.system === 'string' ? p.system : toParts(p.system) });
  }
  messages.push({ role: 'user', content: toParts(p.content) });

  /* p.model picks another model for this call (cheaper ones for small jobs);
     MasterPlan's own calls leave it unset. p.effort 'none' sends no reasoning. */
  const model = p.model || config.anthropic.model;
  const body = {
    model,
    messages,
    max_tokens: p.maxTokens || 32000,
    stream: true,
    usage: { include: true },
  };
  if (p.effort !== 'none') body.reasoning = { effort: p.effort || config.anthropic.effort };
  if (model.startsWith('anthropic/')) body.provider = { order: ['anthropic'], allow_fallbacks: true };
  const search = (p.tools || []).find((t) => t.name === 'web_search');
  if (search) body.plugins = [{ id: 'web', engine: 'native', max_results: search.max_uses || 5 }];
  if (Array.isArray(p.content) && p.content.some((b) => b.type === 'document')) {
    body.plugins = (body.plugins || []).concat({ id: 'file-parser', pdf: { engine: 'native' } });
  }

  /* Retry what is worth retrying: rate limits, upstream overloads, dropped
     connections. A bad request is not retried. */
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 * attempt * attempt));
    try {
      const out = await openRouterOnce(body);
      if (out.usage) {
        const u = out.usage;
        usage.input_tokens = (usage.input_tokens || 0) + (u.prompt_tokens || 0);
        usage.output_tokens = (usage.output_tokens || 0) + (u.completion_tokens || 0);
        const cached = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens;
        if (cached) usage.cache_read_input_tokens = (usage.cache_read_input_tokens || 0) + cached;
        if (typeof u.cost === 'number') usage.cost_usd = (usage.cost_usd || 0) + u.cost;
      }
      if (out.finish === 'length') throw new LlmError('The response was cut off at the length limit.', 'max_tokens');
      if (out.finish === 'content_filter') throw new LlmError('The model declined this request.', 'refusal');
      if (!out.text.trim()) throw new LlmError('The model returned an empty answer.', 'empty');
      return { text: out.text, usage, model };
    } catch (err) {
      last = err;
      const status = err.status;
      const retryable =
        !(err instanceof LlmError) ||
        err.code === 'stream_error' ||
        err.code === 'empty' ||
        status === 408 || status === 429 || (status >= 500 && status < 600);
      if (!retryable) throw err;
      console.warn('[masterplan] OpenRouter attempt %d failed: %s', attempt + 1, err.message);
    }
  }
  throw last;
}

/* Models writing long prose inside JSON sometimes put real line breaks, tabs
   or a bare quote mark inside a string. Escape those: a quote ends a string
   only when what follows can come after a string (, } ] :). */
function repairJson(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (s[i + 1] || '');
      i++;
    } else if (ch === '"') {
      const rest = s.slice(i + 1).match(/^\s*(.)/);
      if (!rest || /[,}\]:]/.test(rest[1])) {
        inStr = false;
        out += ch;
      } else out += '\\"';
    } else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

/** Pull the last JSON object out of a reply (fenced or bare). */
function parseJson(text) {
  /* A fence is only taken from a line start, so a ``` inside a string does not cut it. */
  const fenced = [...text.matchAll(/(?:^|\n)```(?:json)?[ \t]*\n([\s\S]*?)\n```/g)];
  const candidates = fenced.length ? fenced.map((m) => m[1]).reverse() : [];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let firstError = null;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (err) {
      firstError = firstError || err;
    }
  }
  for (const c of candidates) {
    try {
      return JSON.parse(repairJson(c));
    } catch {
      /* try the next one */
    }
  }
  const at = Number((String(firstError && firstError.message).match(/position (\d+)/) || [])[1]);
  console.warn('[llm] unreadable JSON (%s chars): %s%s', text.length, firstError ? firstError.message : 'no JSON object', Number.isFinite(at) && candidates[0] ? ' near ' + JSON.stringify(candidates[0].slice(Math.max(0, at - 80), at + 40)) : '');
  throw new LlmError('The model did not return readable JSON.', 'bad_json');
}

/* Rough dollar figure for the log, from the published per-token prices of the
   default model ($4 in, $20 out, cache write 1.25x, cache read $0.20, $10 per
   thousand searches). Indicative only. */
function estimateCost(u) {
  /* OpenRouter reports the exact charge; prefer it. */
  if (typeof u.cost_usd === 'number') return u.cost_usd;
  const m = 1e6;
  return (
    ((u.input_tokens || 0) * 4) / m +
    ((u.cache_creation_input_tokens || 0) * 5) / m +
    ((u.cache_read_input_tokens || 0) * 0.2) / m +
    ((u.output_tokens || 0) * 20) / m +
    ((u.web_search_requests || 0) * 10) / 1000
  );
}

/** One generation through whichever provider is configured. */
function generate(p) {
  return config.anthropic.provider === 'openrouter' ? generateOpenRouter(p) : generateAnthropic(p);
}

module.exports = { generate, parseJson, estimateCost, LlmError, Anthropic };
