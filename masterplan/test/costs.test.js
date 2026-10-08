'use strict';

/* The cost model must reproduce the client's own figures for the test client
   (Master Guide, Part Four, section 6) from the same inputs. */

const test = require('node:test');
const assert = require('node:assert');
const costs = require('../costs');

const testClient = {
  currency: 'USD',
  home_price: { value: 1400000, basis: 'Dublin median single-family price', source: 'PropertyShark', url: 'https://www.propertyshark.com/', period: 'Q2 2026' },
  rent: { value: 4112, source: 'Rentometer' },
  property_tax_rate: { value: 0.0139, source: 'Ownwell' },
  home_insurance_annual: { value: 2400, source: 'MoneyGeek' },
  hazard_insurance: { label: 'Earthquake cover', annual: 4550, dwelling_value: 700000, source: 'Hippo' },
  mortgage_rate: { value: 0.065, source: 'judgment' },
  utilities_monthly: { value: 600, source: 'judgment' },
  income: { value: 400000, source: 'judgment' },
  lifestyle: {
    activities: [
      { name: 'Painting', monthly: 100 },
      { name: 'Organ', monthly: 250 },
      { name: 'Taekwondo', monthly: 150 },
      { name: 'Diving', monthly: 400 },
      { name: 'Documentary production', monthly: 1500 },
    ],
    car_lease: 750,
    car_insurance: 220,
    clothing: 400,
    groceries: 700,
    dining_out: 800,
    help_at_home: [{ name: 'Cleaner', monthly: 360 }, { name: 'Gardener', monthly: 200 }],
    trips_per_year: 4,
    vacations_annual: 24000,
    flights_monthly: 500,
  },
};

test('reproduces the test client figures from the Master Guide', () => {
  const m = costs.model(testClient, { age: 42 });
  const v = m.values;
  assert.strictEqual(Math.round(v.pi), 7079);
  assert.strictEqual(Math.round(v.ptax), 1622);
  assert.strictEqual(v.housing, 9880);
  assert.strictEqual(v.rentAlt, 4542);
  assert.strictEqual(v.actTotal, 2400);
  assert.strictEqual(v.monthly, 18210);
  assert.strictEqual(v.annual, 218520);
  assert.strictEqual(Math.round(v.gross), 364200);
  assert.strictEqual(Math.round(v.infl), 10926);
  assert.strictEqual(Math.round(v.needFee), 378126);
  assert.strictEqual(Math.round(v.assets4), 9453150);
  assert.strictEqual(Math.round(v.assets5), 7562520);
  assert.strictEqual(Math.round(v.assets6), 6302100);
  assert.strictEqual(v.emergency, 109260);
  assert.strictEqual(Math.round(v.savings1), 75625);
  assert.strictEqual(v.workYears, 13);
  assert.strictEqual(v.earning, 5200000);
  assert.strictEqual(v.horizon, 35);
  assert.strictEqual(m.f.monthly, '$18,210');
  assert.match(m.table, /\| \*\*Total\*\* \| \*\*\$18,210¤\*\* \|/);
});

test('sources list skips judgments and keeps named sources', () => {
  const m = costs.model(testClient, { age: 42 });
  const labels = m.sources.map((s) => s.source);
  assert.deepStrictEqual(labels, ['PropertyShark', 'Rentometer', 'Ownwell', 'MoneyGeek', 'Hippo']);
});

test('survives a thin research result', () => {
  const m = costs.model({ currency: 'EUR', home_price: { value: 500000 } }, { age: null });
  assert.ok(Number.isFinite(m.values.monthly));
  assert.strictEqual(m.values.retireAge, 55);
  assert.match(m.f.price, /€/);
});
