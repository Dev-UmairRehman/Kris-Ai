'use strict';

/* ---------------------------------------------------------------------------
   Exercise Two: what the member's chosen life costs, and what it takes to
   fund it.

   1. research()  Claude looks up local prices with web search: home price,
                  rent, property tax, insurance, a likely salary for the role.
                  Every figure comes back with its source, or is labelled
                  "judgment", as the Master Guide requires.
   2. model()     the arithmetic, in code, so every number printed in the
                  document comes from one place. This is a port of the cost
                  model in the client's build_story.py, and with the test client's inputs
                  it reproduces her $18,210 a month (see test/costs.test.js).
   --------------------------------------------------------------------------- */

const llm = require('./llm');
const config = require('./config');

const RESEARCH_SYSTEM = `You research local living costs for a financial-planning exercise. You use web search to find current figures for one place, and you report each figure with the name of the source, its URL and the period it describes. When you cannot find a figure, you give a careful estimate and set its source to "judgment". You never invent a source.

These fields are printed in a client document, so keep them short and impersonal: "source" is the publisher name only (for example "Redfin" or "Zillow"), at most four words; "basis" is at most twelve words, written as a label ("Median single-family sale price, 78704"), never in the first person and never explaining your reasoning; "period" is a short date ("August 2026"). Activity and help names are two to four words with no notes in brackets.

Reply with one JSON object in a \`\`\`json fence and nothing after it. Use plain numbers (no currency symbols or commas). Rates are decimals (1.39% is 0.0139).`;

function researchPrompt(p) {
  return `Place: ${p.place}
Country: ${p.country || 'unknown'}
Today: ${p.today}
The person: ${p.role || 'role unknown'}${p.employer ? ' at ' + p.employer : ''}${p.seniority ? ' (' + p.seniority + ')' : ''}. Estimated age ${p.age || 'unknown'}. Household: ${p.household || 'one adult (assumed)'}.
Interests and hobbies from their resume and feed: ${p.hobbies && p.hobbies.length ? p.hobbies.join(', ') : 'none listed'}.

Find, for this place, the most recent figures you can:
1. home_price: the median single-family home sale price.
2. rent: the average monthly rent for a three-bedroom home.
3. property_tax_rate: the effective annual property tax rate.
4. home_insurance_annual: the typical annual homeowners insurance premium for a home at that price in this state or region.
5. hazard_insurance: if the place has a common extra cover (earthquake in California, flood or windstorm on hurricane coasts), its typical annual cost for a dwelling worth about half the home price. Otherwise null.
6. mortgage_rate: the current typical 30-year fixed rate in this country.
7. income: the typical total yearly compensation (salary, bonus and stock) for this role at this employer and level in this area. If the role is unclear, estimate from the resume level.
8. lifestyle: monthly estimates for one adult in this place living the life this person's interests suggest - each hobby, a car lease and insurance, clothing, groceries, dining out, help at home, vacations (trips per year and yearly cost), flights. These are judgments; say so.
9. luxury_area: one or two well-known high-end neighborhoods within about an hour's drive (for an open-house visit).

JSON shape:
{
  "currency": "USD",
  "place": "City, ST 00000",
  "home_price": {"value": 0, "basis": "", "source": "", "url": "", "period": ""},
  "rent": {"value": 0, "basis": "", "source": "", "url": "", "period": ""},
  "property_tax_rate": {"value": 0, "basis": "", "source": "", "url": ""},
  "home_insurance_annual": {"value": 0, "basis": "", "source": "", "url": ""},
  "hazard_insurance": {"label": "Earthquake insurance", "annual": 0, "dwelling_value": 0, "basis": "", "source": "", "url": ""},
  "mortgage_rate": {"value": 0, "basis": "", "source": "", "url": ""},
  "utilities_monthly": {"value": 0, "basis": "", "source": "judgment"},
  "income": {"value": 0, "basis": "", "source": "", "url": ""},
  "lifestyle": {
    "activities": [{"name": "", "monthly": 0}],
    "car_lease": 0, "car_insurance": 0, "clothing": 0, "groceries": 0, "dining_out": 0,
    "help_at_home": [{"name": "", "monthly": 0}],
    "trips_per_year": 0, "vacations_annual": 0, "flights_monthly": 0
  },
  "luxury_area": ""
}`;
}

async function research(p, usage) {
  const { text } = await llm.generate({
    system: RESEARCH_SYSTEM,
    content: researchPrompt(p),
    effort: config.anthropic.researchEffort,
    maxTokens: 16000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: config.anthropic.maxSearches }],
    usage,
  });
  return llm.parseJson(text);
}

/* ---- the model ---------------------------------------------------------- */

const num = (v, d = 0) => (Number.isFinite(+v) && +v >= 0 ? +v : d);

/* The currency comes from the research step; anything that is not an ISO
   code (a model may answer with a symbol instead) falls back to USD rather than failing the
   report after the research has been paid for. */
function isoCurrency(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return 'USD';
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: c });
    return c;
  } catch {
    return 'USD';
  }
}

function money(currency) {
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: isoCurrency(currency),
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  return (x) => fmt.format(Math.round(x));
}

/**
 * @param {object} r     research result
 * @param {object} who   { age, firstName }
 */
function model(r, who) {
  const m = money(r.currency);
  const L = r.lifestyle || {};

  const price = num(r.home_price && r.home_price.value);
  const rate = num(r.mortgage_rate && r.mortgage_rate.value, 0.065) || 0.065;
  const loan = price * 0.8;
  const mr = rate / 12;
  const pi = mr > 0 ? (loan * mr) / (1 - Math.pow(1 + mr, -360)) : loan / 360;
  const taxRate = num(r.property_tax_rate && r.property_tax_rate.value);
  const ptax = (price * taxRate) / 12;
  const ins = num(r.home_insurance_annual && r.home_insurance_annual.value) / 12;
  const hazard = r.hazard_insurance && num(r.hazard_insurance.annual) > 0 ? r.hazard_insurance : null;
  const haz = hazard ? num(hazard.annual) / 12 : 0;
  const util = num(r.utilities_monthly && r.utilities_monthly.value, 600) || 600;
  const housing = Math.round(pi) + Math.round(ptax) + Math.round(ins) + Math.round(haz) + Math.round(util);
  const rentAlt = num(r.rent && r.rent.value) + Math.round((util * 2) / 3) + 30;

  const activities = (L.activities || []).filter((a) => a && a.name).map((a) => ({ name: clip(a.name, 32), monthly: Math.round(num(a.monthly)) }));
  const actTotal = activities.reduce((s, a) => s + a.monthly, 0);
  const car = Math.round(num(L.car_lease) + num(L.car_insurance));
  const cloth = Math.round(num(L.clothing));
  const food = Math.round(num(L.groceries) + num(L.dining_out));
  const help = (L.help_at_home || []).filter((h) => h && h.name).map((h) => ({ name: clip(h.name, 32), monthly: Math.round(num(h.monthly)) }));
  const helpTotal = help.reduce((s, h) => s + h.monthly, 0);
  const vac = Math.round(num(L.vacations_annual) / 12);
  const fly = Math.round(num(L.flights_monthly));

  const monthly = housing + actTotal + car + cloth + food + helpTotal + vac + fly;
  const annual = monthly * 12;
  const gross = (annual / 60) * 100; // the book's example 40% tax
  const infl = annual * 0.05;
  const need = gross + infl;
  const needFee = need + 3000;
  const assets = (rr) => needFee / rr;
  const emergency = monthly * 6;
  const savings1 = assets(0.05) * 0.01;

  const age = num(who && who.age, 0) || null;
  const retireAge = age && age >= 50 ? Math.ceil(age + 10) : 55;
  const income = num(r.income && r.income.value);
  const workYears = age ? Math.max(0, Math.round(retireAge - age)) : null;
  const earning = workYears != null && income ? income * workYears : null;
  const openHouse = price * 5.45;

  const values = {
    price, loan, rate, pi, ptax, ins, haz, util, housing, rentAlt,
    activities, actTotal, car, cloth, food, help, helpTotal, vac, fly,
    monthly, annual, gross, infl, need, needFee,
    assets4: assets(0.04), assets5: assets(0.05), assets6: assets(0.06),
    emergency, savings1, age, retireAge, horizon: 90 - retireAge, income, workYears, earning, openHouse,
    gap: earning != null ? assets(0.05) - earning : null,
  };

  /* The figures the writer may quote, already formatted. */
  const f = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'number' && !['rate', 'age', 'retireAge', 'horizon', 'workYears'].includes(k)) f[k] = m(v);
  }
  f.rate = (rate * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  f.taxRate = (taxRate * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  f.age = age ? String(Math.round(age)) : 'unknown';
  f.retireAge = String(retireAge);
  f.horizon = String(90 - retireAge);
  f.workYears = workYears != null ? String(workYears) : 'unknown';

  return { values, f, table: costTable(r, values, f, m), sources: sourceList(r), currency: isoCurrency(r.currency) };
}

/* Short printable label for a researched figure: its basis and source,
   trimmed, so a long note from the research step can never spill into the
   table. */
function clip(s, n) {
  /* Drop bracketed notes and anything after the first sentence or colon. */
  s = String(s || '')
    .replace(/\s*\([^)]*\)/g, '')
    .split(/[:.](\s|$)/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '').replace(/[,;:.]$/, '') + '…';
}
function label(item, fallback) {
  const basis = clip(item && item.basis, 70) || fallback;
  const src = item && item.source && !/judg/i.test(item.source) ? clip(item.source.split(',')[0], 40) : '';
  return basis + (src ? ' (' + src + ')' : '');
}

function costTable(r, v, f, m) {
  const S = '¤';
  const rows = [];
  const hz = r.hazard_insurance && v.haz ? ` ${r.hazard_insurance.label || 'Hazard insurance'}, ${m(v.haz)}.` : '';
  rows.push([
    'Where they live',
    f.housing + S,
    `${label(r.home_price, 'Median home price')}: ${f.price}. 20% down, a ${f.rate} loan,${S} 30 years: ${f.pi} a month. Property tax at ${f.taxRate}: ${f.ptax}. Homeowners insurance, ${f.ins}.${hz} Utilities, ${f.util}. Renting a three-bedroom instead runs about ${f.rentAlt} with utilities.`,
  ]);
  rows.push([
    'What they are doing',
    f.actTotal + S,
    v.activities.length ? v.activities.map((a) => `${a.name} ${m(a.monthly)}`).join(', ') + '.' : 'No activities in the record. Judgment.',
  ]);
  rows.push(['Car', f.car + S, `A lease and insurance. Judgment.`]);
  rows.push(['Second home', m(0), `None in the base case.`]);
  rows.push(['Clothing', f.cloth + S, 'Judgment.']);
  rows.push(['Food', f.food + S, 'Groceries and dining out for one adult. Judgment.']);
  rows.push([
    'Help at home',
    f.helpTotal + S,
    v.help.length ? v.help.map((h) => `${h.name} ${m(h.monthly)}`).join(', ') + '. Judgment.' : 'None in the base case.',
  ]);
  rows.push(['Vacations', f.vac + S, `${num(r.lifestyle && r.lifestyle.trips_per_year) || 'Several'} trips a year. Judgment.`]);
  rows.push(['Flights', f.fly + S, 'Commercial, including family visits. Judgment.']);
  rows.push(['**Total**', `**${f.monthly}${S}**`, 'An indication of the chosen life, not a complete budget.']);

  const cell = (s) => String(s).replace(/\|/g, ' and ').replace(/\n/g, ' ');
  return (
    '| Line | Monthly | Basis |\n|---|---|---|\n' +
    rows.map((row) => '| ' + row.map(cell).join(' | ') + ' |').join('\n') +
    '\n'
  );
}

function sourceList(r) {
  const out = [];
  const add = (label, item) => {
    if (!item || !item.source || /judg/i.test(item.source)) return;
    out.push({ label, source: item.source, url: item.url || '', period: item.period || '' });
  };
  add('Home prices', r.home_price);
  add('Rent', r.rent);
  add('Property tax', r.property_tax_rate);
  add('Homeowners insurance', r.home_insurance_annual);
  if (r.hazard_insurance) add(r.hazard_insurance.label || 'Hazard insurance', r.hazard_insurance);
  add('Mortgage rate', r.mortgage_rate);
  add('Compensation', r.income);
  return out;
}

module.exports = { research, model, money };
