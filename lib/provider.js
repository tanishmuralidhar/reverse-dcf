// Data provider — pulls fundamentals from Yahoo Finance (no API key) and
// normalizes them into a single shape the frontend consumes.
//
// Two sources are combined because Yahoo deprecated the quoteSummary statement
// history modules in Nov 2024 (they return nulls). The current snapshot still
// comes from quoteSummary; multi-year history comes from fundamentalsTimeSeries.
import YahooFinance from 'yahoo-finance2';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// Yahoo sector labels for which unlevered FCF is not a meaningful valuation base.
const FINANCIAL_SECTORS = new Set(['Financial Services', 'Financial', 'Real Estate']);

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function safeDiv(a, b) {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

// ---- snapshot (trailing / current) -----------------------------------------
async function fetchSnapshot(symbol) {
  const q = await yf.quoteSummary(
    symbol,
    {
      modules: [
        'price',
        'summaryDetail',
        'defaultKeyStatistics',
        'financialData',
        'assetProfile',
      ],
    },
    { validateResult: false },
  );

  const price = q.price || {};
  const sd = q.summaryDetail || {};
  const ks = q.defaultKeyStatistics || {};
  const fd = q.financialData || {};
  const ap = q.assetProfile || {};

  const marketCap = n(price.marketCap) ?? n(sd.marketCap);
  const px = n(price.regularMarketPrice);
  const shares =
    n(ks.sharesOutstanding) ??
    n(price.sharesOutstanding) ??
    (marketCap != null && px ? marketCap / px : null);
  const totalCash = n(fd.totalCash);
  const totalDebt = n(fd.totalDebt);

  return {
    meta: {
      symbol: price.symbol || symbol.toUpperCase(),
      name: price.longName || price.shortName || symbol.toUpperCase(),
      exchange: price.exchangeName || price.fullExchangeName || null,
      currency: price.currency || fd.financialCurrency || 'USD', // trading currency (matches price)
      financialCurrency: fd.financialCurrency || null, // reporting currency of the statements
      sector: ap.sector || null,
      industry: ap.industry || null,
      website: ap.website || null,
      asOf: new Date().toISOString(),
    },
    market: {
      price: px,
      marketCap,
      sharesOutstanding: shares,
      enterpriseValue: n(ks.enterpriseValue),
      totalCash,
      totalDebt,
      netDebt: totalCash != null && totalDebt != null ? totalDebt - totalCash : null,
      beta: n(sd.beta) ?? n(ks.beta),
    },
    trailing: {
      revenue: n(fd.totalRevenue),
      ebitda: n(fd.ebitda),
      operatingCashflow: n(fd.operatingCashflow),
      freeCashflow: n(fd.freeCashflow),
      grossMargins: n(fd.grossMargins),
      operatingMargins: n(fd.operatingMargins),
      profitMargins: n(fd.profitMargins),
      returnOnEquity: n(fd.returnOnEquity),
      returnOnAssets: n(fd.returnOnAssets),
      trailingPE: n(sd.trailingPE),
      forwardPE: n(sd.forwardPE),
      trailingEps: n(ks.trailingEps),
      priceToBook: n(ks.priceToBook),
      revenueGrowth: n(fd.revenueGrowth),
      earningsGrowth: n(fd.earningsGrowth),
    },
  };
}

// ---- multi-year history ----------------------------------------------------
async function fetchHistory(symbol) {
  const today = new Date();
  const start = new Date(today.getFullYear() - 6, 0, 1).toISOString().slice(0, 10);
  let rows = [];
  try {
    rows = await yf.fundamentalsTimeSeries(symbol, {
      period1: start,
      period2: today.toISOString().slice(0, 10),
      type: 'annual',
      module: 'all',
    });
  } catch {
    return [];
  }

  const out = [];
  for (const r of rows) {
    const revenue = n(r.totalRevenue);
    if (revenue == null) continue; // skip the partial edge row Yahoo prepends

    const capex = n(r.capitalExpenditure); // negative in Yahoo's convention
    const ocf = n(r.operatingCashFlow);
    const fcf =
      n(r.freeCashFlow) ??
      (ocf != null && capex != null ? ocf + capex : null);
    const ebit = n(r.operatingIncome) ?? n(r.EBIT) ?? n(r.totalOperatingIncomeAsReported);
    const pretax = n(r.pretaxIncome);
    const tax = n(r.taxProvision);

    out.push({
      date: r.date instanceof Date ? r.date.toISOString() : r.date,
      year: new Date(r.date).getFullYear(),
      revenue,
      operatingIncome: ebit,
      ebitda: n(r.EBITDA) ?? n(r.normalizedEBITDA),
      netIncome: n(r.netIncome),
      pretaxIncome: pretax,
      taxProvision: tax,
      effectiveTaxRate: (() => {
        // Only derive a rate from a positive pre-tax base — otherwise a loss
        // year with a tax benefit (negative ÷ negative) yields a spurious
        // positive rate. Yahoo's normalized taxRateForCalcs is preferred.
        const ratio = pretax != null && pretax > 0 ? safeDiv(tax, pretax) : null;
        const t = n(r.taxRateForCalcs) ?? ratio;
        if (t == null) return null;
        return Math.min(Math.max(t, 0), 0.5); // clamp to a sane band
      })(),
      ocf,
      capex,
      fcf,
      da: n(r.depreciationAndAmortization) ?? n(r.depreciationAmortizationDepletion),
      shares: n(r.dilutedAverageShares) ?? n(r.basicAverageShares) ?? n(r.ordinarySharesNumber),
      totalDebt: n(r.totalDebt),
      cash: n(r.cashAndCashEquivalents),
      equity: n(r.stockholdersEquity) ?? n(r.commonStockEquity),
      // convenience margins
      operatingMargin: safeDiv(ebit, revenue),
      fcfMargin: safeDiv(fcf, revenue),
      netMargin: safeDiv(n(r.netIncome), revenue),
    });
  }
  // chronological ascending
  out.sort((a, b) => new Date(a.date) - new Date(b.date));
  return out;
}

// ---- public: combined, normalized company object ---------------------------
export async function getCompany(rawSymbol) {
  const symbol = String(rawSymbol || '').trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    const err = new Error('Invalid ticker symbol.');
    err.status = 400;
    throw err;
  }

  let snapshot;
  try {
    snapshot = await fetchSnapshot(symbol);
  } catch (e) {
    // Distinguish a genuinely unknown ticker (404) from a transient upstream
    // failure (rate-limit / network / Yahoo 5xx) so clients can retry sensibly.
    const m = String((e && e.message) || '').toLowerCase();
    const transient = /timeout|network|fetch failed|econn|enotfound|socket|429|too many|rate|503|502|500|unavailable|gateway/.test(m);
    const err = new Error(
      transient
        ? `Couldn't reach the data provider for "${symbol}" right now. Please try again in a moment.`
        : `Couldn't find data for "${symbol}". Check the ticker and try a US-listed symbol.`,
    );
    err.status = transient ? 503 : 404;
    throw err;
  }
  if (snapshot.market.price == null) {
    const err = new Error(`No price data for "${symbol}".`);
    err.status = 404;
    throw err;
  }

  const history = await fetchHistory(symbol);

  // ---- derived base values for the DCF ----
  const hist = history.filter((h) => h.fcf != null);
  const last3 = hist.slice(-3);
  const avg = (arr, key) => {
    const vals = arr.map((x) => x[key]).filter((x) => x != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  const latestFyFcf = hist.length ? hist[hist.length - 1].fcf : null;
  const ttmFcf = snapshot.trailing.freeCashflow ?? latestFyFcf;
  const avg3yrFcfMargin = avg(last3, 'fcfMargin');
  const normalizedFcf =
    avg3yrFcfMargin != null && snapshot.trailing.revenue != null
      ? avg3yrFcfMargin * snapshot.trailing.revenue
      : null;

  const isFinancial = FINANCIAL_SECTORS.has(snapshot.meta.sector || '');
  const baseFcfCandidate = ttmFcf ?? latestFyFcf;

  const derived = {
    ttmFcf,
    latestFyFcf,
    avg3yrFcf: avg(last3, 'fcf'),
    avg3yrFcfMargin,
    normalizedFcf,
    latestRevenue: snapshot.trailing.revenue ?? (hist.length ? hist[hist.length - 1].revenue : null),
    suggestedBaseFcf: baseFcfCandidate,
  };

  // Cross-currency ADRs (e.g. TSM reports in TWD but trades in USD) — Yahoo's
  // aggregates mix currencies, so the reverse DCF can't reconcile FCF with price.
  const priceCur = snapshot.meta.currency;
  const finCur = snapshot.meta.financialCurrency;
  const currencyMismatch = !!(finCur && priceCur && finCur !== priceCur);

  const flags = {
    isFinancial,
    fcfNegative: baseFcfCandidate != null && baseFcfCandidate <= 0,
    missingHistory: history.length === 0,
    sparseHistory: history.length > 0 && history.length < 3,
    currencyMismatch,
  };

  return { ...snapshot, history, derived, flags };
}
