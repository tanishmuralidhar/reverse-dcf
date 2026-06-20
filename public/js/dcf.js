// dcf.js — pure reverse/forward DCF math. No DOM, no network.
//
// Model: two-stage discounted cash flow on free cash flow (operating cash flow
// minus capex — a levered, after-tax cash flow to equity). The explicit period
// grows base FCF at `growth` for `years`; a Gordon-growth perpetuity captures
// everything after. Discounting the levered cash flows at the cost of equity
// gives the intrinsic EQUITY value directly, so per-share value = equity / shares
// (no separate net-debt bridge — that would double-count, since FCF here is
// already after interest). This matches the convention used by the common
// reverse-DCF calculators and is internally consistent.
//
// Reverse mode solves for the growth rate that makes intrinsic value per share
// equal to today's price — i.e. the growth the market is implicitly pricing in.

/**
 * Project FCF over the explicit horizon and add a Gordon terminal value.
 * @returns {{pvExplicit:number, pvTerminal:number, terminalValue:number|null,
 *            equityValue:number, fcfN:number, projected:Array}}
 */
export function valueEquity({ baseFcf, growth, years, discountRate, terminalGrowth }) {
  const r = discountRate;
  const g = growth;
  const gt = terminalGrowth;

  let pvExplicit = 0;
  const projected = [];
  for (let t = 1; t <= years; t++) {
    const fcf = baseFcf * Math.pow(1 + g, t);
    const pv = fcf / Math.pow(1 + r, t);
    pvExplicit += pv;
    projected.push({ year: t, fcf, pv });
  }

  const fcfN = baseFcf * Math.pow(1 + g, years);
  let terminalValue = null;
  let pvTerminal = 0;
  if (r > gt) {
    // Terminal value at end of year N, then discounted N periods back.
    terminalValue = (fcfN * (1 + gt)) / (r - gt);
    pvTerminal = terminalValue / Math.pow(1 + r, years);
  }

  return {
    pvExplicit,
    pvTerminal,
    terminalValue,
    equityValue: pvExplicit + pvTerminal,
    fcfN,
    projected,
  };
}

/** Intrinsic value per share for a given growth assumption (forward DCF). */
export function intrinsicPerShare(opts) {
  if (!opts.shares) return null;
  return valueEquity(opts).equityValue / opts.shares;
}

/**
 * Reverse DCF: solve for the explicit-period FCF growth rate that makes
 * intrinsic value per share equal to `price`. Bisection — intrinsic value is
 * monotonically increasing in growth, so the root is unique within the bracket.
 *
 * @returns {{ok:boolean, impliedGrowth:number, boundary?:string, reason?:string}}
 */
export function solveImpliedGrowth({
  price,
  baseFcf,
  years,
  discountRate,
  terminalGrowth,
  shares,
  lo = -0.5,
  hi = 1.0,
  tol = 1e-5,
  maxIter = 200,
}) {
  if (!(baseFcf > 0)) return { ok: false, reason: 'fcf-nonpositive', impliedGrowth: null };
  if (!shares || !(price > 0)) return { ok: false, reason: 'missing-inputs', impliedGrowth: null };
  if (!(discountRate > terminalGrowth)) {
    return { ok: false, reason: 'rate-le-terminal', impliedGrowth: null };
  }

  const f = (g) =>
    intrinsicPerShare({ baseFcf, growth: g, years, discountRate, terminalGrowth, shares }) - price;

  const fLo = f(lo);
  const fHi = f(hi);

  // Even at the floor growth the company is worth more than its price →
  // the market is pricing in a steeper decline than our bracket allows.
  if (fLo > 0) return { ok: true, impliedGrowth: lo, boundary: 'low', reason: 'priced-below-floor' };
  // Even at the ceiling growth it's worth less than price → richly valued.
  if (fHi < 0) return { ok: true, impliedGrowth: hi, boundary: 'high', reason: 'priced-above-ceiling' };

  let a = lo;
  let b = hi;
  let mid = (a + b) / 2;
  for (let i = 0; i < maxIter; i++) {
    mid = (a + b) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < tol * price || b - a < 1e-8) break;
    if (fm < 0) a = mid;
    else b = mid;
  }
  return { ok: true, impliedGrowth: mid };
}

/** Forward DCF result: fair value + up/downside vs current price. */
export function fairValue(opts) {
  const fv = intrinsicPerShare(opts);
  if (fv == null || !(opts.price > 0)) return { fairValue: fv, upside: null };
  return { fairValue: fv, upside: fv / opts.price - 1 };
}

/**
 * Implied-growth sensitivity grid over discount rate × terminal growth.
 * @returns {{rows:number[], cols:number[], cells:Array<Array<number|null>>}}
 *          rows = discount rates, cols = terminal growths, cell = implied growth.
 */
export function sensitivityGrid({ price, baseFcf, years, shares, rates, terminals }) {
  const cells = rates.map((r) =>
    terminals.map((gt) => {
      if (!(r > gt)) return null;
      const res = solveImpliedGrowth({
        price,
        baseFcf,
        years,
        discountRate: r,
        terminalGrowth: gt,
        shares,
      });
      return res.ok ? res.impliedGrowth : null;
    }),
  );
  return { rows: rates, cols: terminals, cells };
}

/** Compound annual growth rate between two values across `years` periods. */
export function cagr(first, last, years) {
  if (first == null || last == null || years <= 0) return null;
  if (first <= 0 || last <= 0) return null; // sign flip makes CAGR meaningless
  return Math.pow(last / first, 1 / years) - 1;
}

/** CAPM cost of equity, clamped to a sane band; falls back when beta missing. */
export function capmCostOfEquity({ beta, riskFree = 0.043, equityPremium = 0.05, fallback = 0.09 }) {
  if (beta == null || !Number.isFinite(beta)) return fallback;
  const r = riskFree + beta * equityPremium;
  return Math.min(Math.max(r, 0.06), 0.16);
}
