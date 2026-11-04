// Demo QC data: a month of daily runs on three analysers common in Nigerian labs, with two control levels each.
// Random noise comes from a seeded generator so the demo is the same every time, and a few problems are planted
// so that every Westgard rule fires at least once:
//   - Glucose (Mindray BS-240): a calibration shift from day 22, caught by 4-1s across levels on day 23 and later by 10x
//   - Creatinine (Mindray BS-240): one random error on day 18, caught by 1-3s
//   - Cholesterol (Roche cobas c 311): levels split apart on day 25, caught by R-4s
//   - ALT (Roche cobas c 311): two high runs in a row on days 12 and 13, caught by 2-2s
//   - Haemoglobin (Sysmex XN-550): in control apart from one 1-2s warning
//   - WBC (Sysmex XN-550): in control all month

export const ANALYTES = [
  {
    key: 'bs240-glucose', analyser: 'Mindray BS-240', analyte: 'Glucose', unit: 'mg/dL',
    levels: { L1: { mean: 90, sd: 3 }, L2: { mean: 280, sd: 8 } },
    plant: (day) => (day >= 22 ? { L1: 1.4, L2: 1.3 } : null),
  },
  {
    key: 'bs240-creatinine', analyser: 'Mindray BS-240', analyte: 'Creatinine', unit: 'mg/dL',
    levels: { L1: { mean: 1.0, sd: 0.05 }, L2: { mean: 5.0, sd: 0.18 } },
    plant: (day) => (day === 18 ? { L2: 3.4 } : null),
  },
  {
    key: 'c311-cholesterol', analyser: 'Roche cobas c 311', analyte: 'Cholesterol', unit: 'mg/dL',
    levels: { L1: { mean: 150, sd: 5 }, L2: { mean: 250, sd: 8 } },
    plant: (day) => (day === 25 ? { L1: 2.4, L2: -2.3 } : null),
  },
  {
    key: 'c311-alt', analyser: 'Roche cobas c 311', analyte: 'ALT', unit: 'U/L',
    levels: { L1: { mean: 30, sd: 2 }, L2: { mean: 140, sd: 6 } },
    plant: (day) => (day === 12 ? { L1: 2.3 } : day === 13 ? { L1: 2.2 } : null),
  },
  {
    key: 'xn550-haemoglobin', analyser: 'Sysmex XN-550', analyte: 'Haemoglobin', unit: 'g/dL',
    levels: { L1: { mean: 8.0, sd: 0.15 }, L2: { mean: 15.0, sd: 0.25 } },
    plant: (day) => (day === 9 ? { L2: 2.3 } : null),
  },
  {
    key: 'xn550-wbc', analyser: 'Sysmex XN-550', analyte: 'WBC', unit: 'x10^9/L',
    levels: { L1: { mean: 3.0, sd: 0.12 }, L2: { mean: 15.0, sd: 0.45 } },
    // No planted problem: this analyte shows what a clean month looks like.
    plant: () => null,
  },
];

/** Small deterministic PRNG (mulberry32) so the demo month is identical on every seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal noise in SD units, kept inside +/-1.8 SD so only the planted problems trip a rule. */
function noise(rand) {
  for (;;) {
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()) * 0.7;
    if (Math.abs(z) < 1.8) return z;
  }
}

const round = (v, sd) => {
  // Report to the precision a lab would: 2 decimals for small SDs, 1 decimal otherwise.
  const dp = sd < 0.5 ? 2 : 1;
  return Number(v.toFixed(dp));
};

/**
 * Build the demo QC history for one analyte: one run per day for `days` days ending today (08:00 UTC each day).
 * Returns QcResult objects in the shape the Westgard engine expects.
 */
export function demoResults(spec, days = 30, now = new Date()) {
  const rand = rng(spec.key.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1), 8);
  const results = [];
  for (let day = 1; day <= days; day++) {
    const time = new Date(start + (day - 1) * 86_400_000).toISOString();
    const runId = `${spec.key}-d${String(day).padStart(2, '0')}`;
    const planted = spec.plant(day) || {};
    for (const [level, { mean, sd }] of Object.entries(spec.levels)) {
      // A planted shift adds to the noise; a planted single value replaces it.
      const z = level in planted ? planted[level] + (day >= 22 && spec.key === 'bs240-glucose' ? noise(rand) * 0.15 : 0) : noise(rand);
      results.push({ id: `${runId}-${level}`, runId, time, level, mean, sd, value: round(mean + z * sd, sd) });
    }
  }
  return results;
}
