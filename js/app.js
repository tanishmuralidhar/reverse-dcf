// app.js — fetch fundamentals, run the reverse/forward DCF, render the tearsheet.
import {
  solveImpliedGrowth,
  fairValue,
  valueEquity,
  sensitivityGrid,
  cagr,
  capmCostOfEquity,
} from './dcf.js';

/* ------------------------------------------------------------------ helpers */
const $ = (id) => document.getElementById(id);
const CURRENCY = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CAD: 'C$', AUD: 'A$',
  TWD: 'NT$', HKD: 'HK$', CNY: '¥', KRW: '₩', BRL: 'R$', CHF: 'CHF ', SGD: 'S$',
};

function sym(cur) {
  return CURRENCY[cur] || (cur ? cur + ' ' : '$');
}
function money(v, cur = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = sym(cur);
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}${s}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${s}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}${s}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${s}${a.toFixed(0)}`;
}
function price(v, cur = 'USD') {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${sym(cur)}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(v, dp = 1, signed = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = signed && v > 0 ? '+' : '';
  return `${s}${(v * 100).toFixed(dp)}%`;
}
function mult(v, dp = 1) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  return `${v.toFixed(dp)}×`;
}
// percent with quarter-point precision but no trailing zeros: 9.75% / 9.5% / 3%
function rateLabel(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
function shares(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return v.toLocaleString('en-US');
}
// escape API-sourced strings before they touch innerHTML
function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/* -------------------------------------------------------------------- state */
let company = null;
let analyzeSeq = 0; // guards against out-of-order responses when tickers change quickly
const A = { discountRate: 0.09, terminalGrowth: 0.03, years: 10, baseKey: 'ttmFcf', forwardGrowth: 0.1 };

/* ----------------------------------------------------------------- fetching */
async function analyze(rawTicker) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker) return;
  const seq = ++analyzeSeq;
  $('ticker-input').value = ticker;
  showState('loading', ticker);
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(ticker)}`);
    const data = await res.json();
    if (seq !== analyzeSeq) return; // a newer request superseded this one
    if (!res.ok) throw new Error(data.error || 'Could not load data.');
    company = data;
    setupDefaults();
    render();
    showState('results');
    $('verdict-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('verdict-title').focus({ preventScroll: true }); // announce results to assistive tech
  } catch (err) {
    if (seq === analyzeSeq) showState('error', err.message);
  }
}

function showState(which, detail) {
  $('state-loading').hidden = which !== 'loading';
  $('state-error').hidden = which !== 'error';
  $('results').hidden = which !== 'results';
  if (which === 'loading') $('loading-ticker').textContent = detail ? ` for ${detail}` : '';
  if (which === 'error') $('error-text').textContent = detail || 'Something went wrong.';
}

/* --------------------------------------------------------- default settings */
function baseFcfChoices() {
  const d = company.derived;
  const cur = company.meta.currency;
  const opts = [];
  if (d.ttmFcf != null) opts.push({ key: 'ttmFcf', label: `Trailing 12 months — ${money(d.ttmFcf, cur)}` });
  if (d.latestFyFcf != null) opts.push({ key: 'latestFyFcf', label: `Latest fiscal year — ${money(d.latestFyFcf, cur)}` });
  if (d.normalizedFcf != null) opts.push({ key: 'normalizedFcf', label: `Normalized (3-yr avg margin) — ${money(d.normalizedFcf, cur)}` });
  return opts;
}
function baseFcf() {
  return company.derived[A.baseKey];
}

function setupDefaults() {
  const m = company.market;
  // discount rate = CAPM cost of equity, rounded to a slider step
  const capm = capmCostOfEquity({ beta: m.beta });
  A.discountRate = Math.round(capm / 0.0025) * 0.0025;
  A.terminalGrowth = 0.03;
  A.years = 10;

  // pick a sensible base FCF (first positive choice)
  const choices = baseFcfChoices();
  const positive = choices.find((c) => company.derived[c.key] > 0);
  A.baseKey = (positive || choices[0] || { key: 'ttmFcf' }).key;

  // forward growth default → recent FCF (or revenue) CAGR, clamped to the slider
  const hist = company.history;
  let anchor = histCagr('fcf');
  if (anchor == null || anchor <= 0) anchor = histCagr('revenue');
  if (anchor == null) anchor = 0.1;
  A.forwardGrowth = Math.min(Math.max(anchor, -0.1), 0.4);

  // sync the controls — read the values back after assignment so any slider
  // step-snapping is reflected in both the state and the on-screen labels.
  const baseSel = $('in-base');
  baseSel.innerHTML = choices.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
  baseSel.value = A.baseKey;

  const dEl = $('in-discount');
  dEl.value = (A.discountRate * 100).toFixed(2);
  A.discountRate = parseFloat(dEl.value) / 100;
  $('val-discount').textContent = rateLabel(A.discountRate);

  const tEl = $('in-terminal');
  tEl.value = (A.terminalGrowth * 100).toFixed(2);
  A.terminalGrowth = parseFloat(tEl.value) / 100;
  $('val-terminal').textContent = rateLabel(A.terminalGrowth);

  $('in-years').value = A.years;
  $('val-years').textContent = `${A.years} yrs`;

  const gEl = $('in-growth');
  gEl.value = (A.forwardGrowth * 100).toFixed(1);
  A.forwardGrowth = parseFloat(gEl.value) / 100;
  $('val-growth').textContent = rateLabel(A.forwardGrowth);

  // discount-rate hint
  $('hint-discount').textContent =
    m.beta != null ? `Cost of equity · CAPM (β ${m.beta.toFixed(2)})` : 'Required rate of return';
}

/* ------------------------------------------------------- derived references */
function histCagr(key) {
  // annualize over the actual span between the first and last data points so a
  // gap year in the middle doesn't overstate the rate
  const pts = company.history.filter((h) => h[key] != null);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const years = last.year - first.year;
  if (years <= 0) return null;
  return cagr(first[key], last[key], years);
}

/* -------------------------------------------------------------- main render */
function render() {
  renderPlate();
  renderBanner();
  renderKpis();
  renderHistory();
  recompute();
}

function recompute() {
  const m = company.market;
  const cur = company.meta.currency;
  const base = baseFcf();
  const common = {
    baseFcf: base,
    years: A.years,
    discountRate: A.discountRate,
    terminalGrowth: A.terminalGrowth,
    shares: m.sharesOutstanding,
  };

  // A cross-currency ADR can't have its FCF reconciled with its price.
  const blocked = company.flags.currencyMismatch;

  // ---- reverse: implied growth ----
  const reverse = blocked ? { ok: false, reason: 'currency' } : solveImpliedGrowth({ price: m.price, ...common });
  renderVerdict(reverse, base);

  // ---- forward: fair value at user growth ----
  const up = $('fv-upside');
  if (blocked || !(base > 0) || !m.sharesOutstanding) {
    // a forward DCF off a non-positive base produces meaningless numbers
    $('fv-pershare').textContent = '—';
    up.textContent = '—';
    up.classList.remove('is-gain', 'is-loss');
    $('br-explicit').textContent = '—';
    $('br-terminal').textContent = '—';
    $('br-equity').textContent = '—';
  } else {
    const fwd = fairValue({ price: m.price, growth: A.forwardGrowth, ...common });
    const parts = valueEquity({ growth: A.forwardGrowth, ...common });
    $('fv-pershare').textContent = price(fwd.fairValue, cur);
    up.textContent = fwd.upside == null ? '—' : pct(fwd.upside, 0, true);
    up.classList.toggle('is-gain', fwd.upside != null && fwd.upside >= 0);
    up.classList.toggle('is-loss', fwd.upside != null && fwd.upside < 0);
    $('br-explicit').textContent = money(parts.pvExplicit, cur);
    $('br-terminal').textContent = money(parts.pvTerminal, cur);
    $('br-equity').textContent = money(parts.equityValue, cur);
  }

  // ---- sensitivity ----
  if (blocked) {
    sensMessage(`Hidden — statements are reported in ${company.meta.financialCurrency}, which can't be reconciled with the ${cur} share price.`);
  } else {
    renderSensitivity(base);
  }
}

function sensMessage(text) {
  $('sens-head').innerHTML = '';
  $('sens-body').innerHTML = `<tr><td style="text-align:center;padding:24px;color:var(--ink-soft)">${text}</td></tr>`;
}

/* ------------------------------------------------------------------- plate */
function renderPlate() {
  const { meta, market } = company;
  $('co-name').textContent = meta.name;
  $('co-ticker').textContent = meta.symbol;
  $('co-exchange').textContent = meta.exchange || '';
  $('co-sector').textContent = meta.sector || meta.industry || '';
  $('co-price').textContent = price(market.price, meta.currency);
  $('co-mktcap').textContent = money(market.marketCap, meta.currency);
}

function renderBanner() {
  const b = $('co-banner');
  const f = company.flags;
  const name = esc(company.meta.name);
  const cur = esc(company.meta.currency);
  const fin = esc(company.meta.financialCurrency);
  const sector = esc(company.meta.sector);
  let msg = '';
  if (f.currencyMismatch) {
    msg = `<strong>Cross-listed security:</strong> ${name} trades in ${cur} but reports financials in ${fin}. The reverse DCF is hidden because the two currencies can't be reconciled; the statistics and history below are in ${fin}.`;
  } else if (f.isFinancial) {
    msg = `<strong>Heads up:</strong> ${name} is a ${sector} company. Free cash flow is a poor valuation base for banks and insurers, so the reverse-DCF figure below should be treated as illustrative only.`;
  } else if (f.fcfNegative) {
    msg = `<strong>Note:</strong> trailing free cash flow is negative, so a growth rate can't be backed out from it. Try the “Normalized” base below, or read this as a pre-profitability name.`;
  } else if (f.missingHistory) {
    msg = `<strong>Note:</strong> limited financial history was available for this ticker, so historical comparisons are thin.`;
  }
  b.hidden = !msg;
  b.innerHTML = msg;
}

/* ----------------------------------------------------------------- verdict */
function renderVerdict(reverse, base) {
  const ig = $('implied-growth');
  const sentence = $('verdict-sentence');
  const pill = $('verdict-pill');
  $('implied-years').textContent = A.years;
  $('implied-terminal').textContent = rateLabel(A.terminalGrowth);

  // benchmarks
  const fcfC = histCagr('fcf');
  const revC = histCagr('revenue');
  $('bm-fcf').textContent = pct(fcfC, 1, true);
  $('bm-rev').textContent = pct(revC, 1, true);
  $('bm-analyst').textContent = pct(company.trailing.earningsGrowth, 1, true);

  if (!reverse.ok || reverse.impliedGrowth == null) {
    ig.textContent = '—';
    $('bm-implied').textContent = '—';
    pill.hidden = true;
    if (reverse.reason === 'currency') {
      sentence.textContent = `${company.meta.name} reports financials in ${company.meta.financialCurrency} but trades in ${company.meta.currency}. A reverse DCF needs cash flow and price in one currency, so the implied-growth figure is hidden for this cross-listed security. The history below is shown in ${company.meta.financialCurrency}.`;
    } else if (base == null || base <= 0) {
      sentence.textContent = 'Free cash flow is negative or unavailable, so no growth rate can be implied. The statistics and history below still apply.';
    } else {
      sentence.textContent = 'The model could not resolve an implied growth rate for these inputs.';
    }
    return;
  }

  const g = reverse.impliedGrowth;
  ig.textContent = pct(g, 1);
  $('bm-implied').textContent = pct(g, 1);

  // tone vs an "achievable" reference (recent FCF, else revenue, growth)
  const ref = fcfC != null && fcfC > 0 ? fcfC : revC;
  let tone = 'neutral';
  let label = 'For reference';
  if (reverse.boundary === 'high') { tone = 'demanding'; label = 'Extremely demanding'; }
  else if (reverse.boundary === 'low') { tone = 'conservative'; label = 'Pricing in decline'; }
  else if (ref != null) {
    if (g > ref + 0.03 && g > ref * 1.25) { tone = 'demanding'; label = 'Demanding'; }
    else if (g < ref - 0.02) { tone = 'conservative'; label = 'Conservative'; }
    else { tone = 'reasonable'; label = 'In line with history'; }
  }
  pill.hidden = false;
  pill.textContent = label;
  pill.dataset.tone = tone;

  const co = company.meta.name;
  const refTxt = ref != null ? `its recent ${pct(ref, 0)} pace` : 'its recent history';
  let read;
  if (reverse.boundary === 'high') {
    read = `To justify today’s price, ${co} would need to compound free cash flow faster than this model’s ceiling — an exceptionally rich valuation.`;
  } else if (reverse.boundary === 'low') {
    read = `Today’s price implies the market expects ${co}’s free cash flow to shrink — it is priced for decline.`;
  } else if (tone === 'demanding') {
    read = `To justify today’s price, the market expects ${co} to grow free cash flow about ${pct(g, 0)} a year for ${A.years} years — well above ${refTxt}. That’s a high bar to clear.`;
  } else if (tone === 'conservative') {
    read = `Today’s price only requires ${co} to grow free cash flow about ${pct(g, 0)} a year for ${A.years} years — below ${refTxt}. Expectations look modest.`;
  } else {
    read = `Today’s price implies ${co} grows free cash flow about ${pct(g, 0)} a year for ${A.years} years — roughly in line with ${refTxt}.`;
  }
  sentence.textContent = read;
}

/* ------------------------------------------------------------------- KPIs */
function renderKpis() {
  const { market: m, trailing: t, derived: d, meta } = company;
  const cur = meta.currency; // trading currency (price, market cap)
  const mismatch = company.flags.currencyMismatch;
  const fcur = mismatch ? meta.financialCurrency || cur : cur; // statement currency
  // P/FCF mixes market cap (trading ccy) with FCF (statement ccy); only valid
  // when both are the same currency.
  const pfcf = !mismatch && m.marketCap != null && d.ttmFcf > 0 ? m.marketCap / d.ttmFcf : null;
  const evEbitda = m.enterpriseValue != null && t.ebitda ? m.enterpriseValue / t.ebitda : null;
  const fcfMargin = d.ttmFcf != null && t.revenue ? d.ttmFcf / t.revenue : null;
  const netDebtLabel = m.netDebt != null && m.netDebt < 0 ? 'Net cash' : 'Net debt';

  const items = [
    ['Enterprise value', money(m.enterpriseValue, fcur)],
    ['Revenue (TTM)', money(t.revenue, fcur)],
    ['Free cash flow (TTM)', money(d.ttmFcf, fcur)],
    ['P / E', mult(t.trailingPE)],
    ['Forward P / E', mult(t.forwardPE)],
    ['P / FCF', mult(pfcf)],
    ['EV / EBITDA', mult(evEbitda)],
    ['FCF margin', pct(fcfMargin, 1)],
    ['Operating margin', pct(t.operatingMargins, 1)],
    ['Return on equity', pct(t.returnOnEquity, 1)],
    [netDebtLabel, money(m.netDebt == null ? null : Math.abs(m.netDebt), fcur)],
    ['Beta', m.beta != null ? m.beta.toFixed(2) : '—'],
  ];
  $('kpi-grid').innerHTML = items
    .map(
      ([label, val]) =>
        `<div class="kpi"><dt class="kpi__label">${label}</dt><dd class="kpi__num num">${val}</dd></div>`,
    )
    .join('');
}

/* --------------------------------------------------------------- history */
function renderHistory() {
  const hist = company.history;
  const cur = company.flags.currencyMismatch
    ? company.meta.financialCurrency || company.meta.currency
    : company.meta.currency;
  if (!hist.length) {
    $('history-section').hidden = true;
    return;
  }
  $('history-section').hidden = false;

  const fy = (h) => `FY${String(h.year).slice(2)}`;
  $('hist-head').innerHTML =
    `<tr><th>Metric</th>${hist.map((h) => `<th>${fy(h)}</th>`).join('')}</tr>`;

  const rows = [
    ['Revenue', (h) => money(h.revenue, cur)],
    ['Operating income', (h) => money(h.operatingIncome, cur)],
    ['Net income', (h) => money(h.netIncome, cur)],
    ['Free cash flow', (h) => money(h.fcf, cur)],
    ['FCF margin', (h) => pct(h.fcfMargin, 1)],
    ['Effective tax rate', (h) => pct(h.effectiveTaxRate, 1)],
  ];
  $('hist-body').innerHTML = rows
    .map(([label, fn]) => {
      const cells = hist
        .map((h) => {
          const txt = fn(h);
          const negative = txt.includes('−') || txt.startsWith('-');
          return `<td class="${negative ? 'neg' : ''}">${txt}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${label}</th>${cells}</tr>`;
    })
    .join('');

  buildChart(hist, cur);
}

/* SVG grouped bar chart: revenue (ink) vs free cash flow (oxblood) */
function buildChart(hist, cur) {
  const W = 720, H = 260, padL = 8, padR = 8, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = hist.flatMap((h) => [h.revenue || 0, h.fcf || 0]);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const y0 = padT + (max / range) * plotH; // pixel y for value 0
  const yOf = (v) => padT + ((max - v) / range) * plotH;

  const n = hist.length;
  const slot = plotW / n;
  const bw = Math.min(slot * 0.28, 46);
  const gap = 6;

  let bars = '';
  let labels = '';
  hist.forEach((h, i) => {
    const cx = padL + slot * i + slot / 2;
    const rev = h.revenue || 0;
    const fcf = h.fcf || 0;
    const revX = cx - bw - gap / 2;
    const fcfX = cx + gap / 2;
    // revenue bar
    bars += `<rect x="${revX.toFixed(1)}" y="${yOf(rev).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, (y0 - yOf(rev))).toFixed(1)}" fill="#122742" rx="1"/>`;
    // fcf bar (handle negative)
    const fy = fcf >= 0 ? yOf(fcf) : y0;
    const fh = Math.abs(y0 - yOf(fcf));
    bars += `<rect x="${fcfX.toFixed(1)}" y="${fy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, fh).toFixed(1)}" fill="#7C2128" rx="1"/>`;
    labels += `<text x="${cx.toFixed(1)}" y="${(H - 12).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#4E5A6E" font-family="Inter,sans-serif">FY${String(h.year).slice(2)}</text>`;
  });

  const baseline = `<line x1="${padL}" y1="${y0.toFixed(1)}" x2="${W - padR}" y2="${y0.toFixed(1)}" stroke="#DDD3BD" stroke-width="1"/>`;

  $('chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue and free cash flow by fiscal year">
      ${baseline}${bars}${labels}
    </svg>
    <div class="chart__legend">
      <span class="chart__key"><span class="chart__swatch" style="background:#122742"></span>Revenue</span>
      <span class="chart__key"><span class="chart__swatch" style="background:#7C2128"></span>Free cash flow</span>
    </div>`;
}

/* ------------------------------------------------------------ sensitivity */
function renderSensitivity(base) {
  const m = company.market;
  const d = A.discountRate;
  const tg = A.terminalGrowth;
  // 5 discount rows centered on the chosen rate, 5 terminal-growth columns.
  // Round to 1e-4 so the centre row/col land exactly on d / tg (keeps the
  // base-cell highlight and the row labels aligned with the chosen inputs).
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const rates = [-0.01, -0.005, 0, 0.005, 0.01].map((x) => r4(d + x)).filter((r) => r > 0);
  const terminals = [-0.01, -0.005, 0, 0.005, 0.01].map((x) => r4(tg + x)).filter((t) => t >= 0);

  if (base == null || base <= 0 || !m.sharesOutstanding) {
    sensMessage('Sensitivity needs a positive base free cash flow.');
    return;
  }

  const grid = sensitivityGrid({ price: m.price, baseFcf: base, years: A.years, shares: m.sharesOutstanding, rates, terminals });

  // value range for the heat scale
  const flat = grid.cells.flat().filter((v) => v != null);
  const lo = Math.min(...flat), hi = Math.max(...flat);

  $('sens-head').innerHTML =
    `<tr><th class="sens-corner">rate ＼ term</th>${terminals.map((t) => `<th>${pct(t, 1)}</th>`).join('')}</tr>`;

  $('sens-body').innerHTML = grid.rows
    .map((r, i) => {
      const cells = grid.cols
        .map((c, j) => {
          const v = grid.cells[i][j];
          if (v == null) return `<td class="sens-cell">—</td>`;
          const isBase = Math.abs(r - d) < 1e-9 && Math.abs(c - tg) < 1e-9;
          const bg = heat(v, lo, hi);
          return `<td class="sens-cell ${isBase ? 'sens-cell--base' : ''}" style="background:${bg}">${pct(v, 1)}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${pct(r, 2)}</th>${cells}</tr>`;
    })
    .join('');
}

// interpolate pale-green (low / less demanding) → pale-oxblood (high / more demanding)
function heat(v, lo, hi) {
  const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  const a = [207, 227, 212]; // #CFE3D4
  const b = [234, 208, 203]; // #EAD0CB
  const c = a.map((x, k) => Math.round(x + (b[k] - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ------------------------------------------------------------------ wiring */
function bindControls() {
  const onRange = (id, key, scale, valId, fmt) => {
    $(id).addEventListener('input', (e) => {
      A[key] = parseFloat(e.target.value) * scale;
      $(valId).textContent = fmt(A[key]);
      recompute();
    });
  };
  onRange('in-discount', 'discountRate', 0.01, 'val-discount', rateLabel);
  onRange('in-terminal', 'terminalGrowth', 0.01, 'val-terminal', rateLabel);
  onRange('in-growth', 'forwardGrowth', 0.01, 'val-growth', rateLabel);
  $('in-years').addEventListener('input', (e) => {
    A.years = parseInt(e.target.value, 10);
    $('val-years').textContent = `${A.years} yrs`;
    recompute();
  });
  $('in-base').addEventListener('change', (e) => {
    A.baseKey = e.target.value;
    recompute();
  });
}

function bindSearch() {
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    analyze($('ticker-input').value);
  });
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => analyze(c.dataset.ticker)),
  );
  $('error-retry').addEventListener('click', () => {
    showState('results');
    $('results').hidden = true;
    $('ticker-input').focus();
  });
  // uppercase as you type
  $('ticker-input').addEventListener('input', (e) => {
    const p = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(p, p);
  });
}

/* masthead hairline + scroll reveal (ported from the portfolio) */
function bindChrome() {
  const mast = $('masthead');
  const onScroll = () => mast.classList.toggle('is-scrolled', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-visible'));
  } else {
    const obs = new IntersectionObserver(
      (entries, o) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('is-visible'); o.unobserve(en.target); } }),
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    els.forEach((el) => obs.observe(el));
  }
}

bindControls();
bindSearch();
bindChrome();
$('ticker-input').focus();

// deep-link: ?t=AAPL or #AAPL
const qp = new URLSearchParams(location.search).get('t') || location.hash.replace('#', '');
if (qp && /^[A-Za-z0-9.\-]{1,12}$/.test(qp)) analyze(qp);
