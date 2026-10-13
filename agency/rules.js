'use strict';

/* ---------------------------------------------------------------------------
   Writing rules. Kris's global writing rules (client document "Global Writing
   Rules") are everyone's default; each member can add rules and phrases of
   their own. The rules go into every writing prompt, and the parts a program
   can check reliably are checked on every draft (lint), so a broken rule is
   repaired before the member sees it.
   --------------------------------------------------------------------------- */

const DEFAULT_RULES = `Goal: never sound AI-generated, and sound more like the member over time. State the point in one plain sentence. Do not tee it up, label it, or announce that it matters.

Never write:
1. Insight framing: "This is the part most people miss", "Nobody talks about this", "what nobody tells you", "Here's the part that surprises people".
1b. Anaphora stacks: three short sentences starting the same way for rhetorical lift ("You write the proposal. You record the Loom. You hit submit." / "This is the problem. This is the opportunity."). Write it as one natural sentence.
2. Tee-ups and reveals: "Here's the part that got me", "Here's where it gets interesting", "Here's the kicker", "and that's when it clicked", "Let me zoom out", "I want you to sit with this", escalating "Not A, not B, not C... D." lists. Cut any sentence that only announces a coming point.
3. "Honestly" as an opener.
4. Fake rhetorical-question splits ("...the old phase? They ended up fighting to survive."). Use one declarative sentence.
5. Reframes: "It's not just X, it's Y", "Not a tool. Not a feature. A revolution.", "Here's the thing", triadic adjective stacks ("faster, smarter, cheaper"), "You don't have an X problem, you have a Y problem."
6. Setup openers: "Imagine if...", "Picture this...", "Have you ever...".
7. Buzzwords: game-changer, paradigm shift, revolutionary, unlock, supercharge, harness, delve into, quietly, silently, "move the needle".
8. Filler after a claim: "That just doesn't happen.", "Let that sink in.", "And that matters more than you'd think.", "That's the trap.", "That's the move."
9. No em dashes anywhere (use a period, comma, parentheses, colon, "and" or "but"). No emojis.

The test: if a sentence builds anticipation for the next sentence instead of carrying its own content, cut it and say the thing.

Standing rules:
- No "not X but Y" constructions. Prefer declarative sentences, and longer natural sentences over short punchy fragments.
- Write the way the member actually speaks: reuse their own words from their answers.
- Never invent personal stories, people or events. Use only the member's own stories, or clearly hypothetical examples.
- Do not use the words "land", "quiet", "exactly", "out loud", "roughly", "carries the weight", "lives in the"; use "says" and "sits" only for people or animals.
- Do not give an instruction followed by "because".
- Position the member as an expert who observes what is happening in the world and shares insights.`;

/* What a program can check without judgment. Each: [pattern, what to fix]. */
const LINT = [
  [/—|–/, 'an em or en dash'],
  [/(^|[.!?]\s+|\n)(and\s+)?honestly[,?]/i, '"honestly" as an opener'],
  [/\b(this is the part (most people|nobody) (miss|realize)|nobody talks about this|what nobody tells you|here'?s the part that surprises)/i, 'insight framing'],
  [/\bhere'?s (the kicker|the thing|where it gets|the part that (got|stuck))/i, 'a tee-up'],
  [/\b(and )?that'?s when it clicked\b|\blet me zoom out\b|\bsit with this\b/i, 'a tee-up'],
  [/\bit'?s not just\b[^.]{1,60}\bit'?s\b/i, '"it\'s not just X, it\'s Y"'],
  [/\bnot (just |only |simply )?[a-z]+(?: [a-z]+){0,3},? but\b/i, '"not X but Y"'],
  [/(^|\n|[.!?]\s+)(imagine if|picture this|have you ever)\b/i, 'a setup opener'],
  [/\b(game[- ]changer|paradigm shift|revolutionary|supercharge|delve into|quietly|silently|move the needle)\b/i, 'a banned buzzword'],
  [/\bunlock(s|ed|ing)?\b|\bharness(es|ed|ing)?\b/i, 'a banned buzzword'],
  [/\blet that sink in\b|\bthat'?s the (trap|move|whole move)\b|\bthat just doesn'?t happen\b/i, 'filler after a claim'],
  [/\b(out loud|carries the weight|lives in the)\b/i, 'a phrase on the banned list'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji'],
];

/** Problems in a draft, as short descriptions. memberPhrases: extra banned phrases. */
function lint(text, memberPhrases = []) {
  const found = new Set();
  for (const [re, what] of LINT) if (re.test(text)) found.add(what);
  for (const p of memberPhrases) {
    const phrase = String(p || '').trim();
    if (phrase.length >= 3 && text.toLowerCase().includes(phrase.toLowerCase())) found.add('your banned phrase "' + phrase + '"');
  }
  return [...found];
}

/** The rules as the writer sees them: the defaults, then the member's own. */
function forPrompt(memberRules) {
  const own = memberRules && memberRules.text ? memberRules.text.trim() : '';
  const phrases = (memberRules && memberRules.phrases) || [];
  return (
    DEFAULT_RULES +
    (own ? '\n\nThe member\'s own rules (they win over the defaults):\n' + own : '') +
    (phrases.length ? '\n\nThe member never wants these words or phrases: ' + phrases.map((p) => '"' + p + '"').join(', ') + '.' : '')
  );
}

module.exports = { DEFAULT_RULES, lint, forPrompt };
