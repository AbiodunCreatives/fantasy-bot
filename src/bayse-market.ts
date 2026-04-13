const BAYSE_BASE_URL = "https://relay.bayse.markets/v1";

// Confirmed against the live Bayse relay on March 23, 2026.
export type BayseAsset = "BTC" | "ETH" | "SOL";

const BAYSE_15M_SERIES_SLUGS: Record<BayseAsset, string> = {
  BTC: "crypto-btc-15min",
  ETH: "crypto-eth-15min",
  SOL: "crypto-sol-15min",
};

const BAYSE_ASSET_SLUG_MATCHERS: Record<BayseAsset, string> = {
  BTC: "btc",
  ETH: "eth",
  SOL: "sol",
};

interface BayseMarketRaw {
  id: string;
  outcome1Id?: string;
  outcome2Id?: string;
  outcome1Price?: number;
  outcome2Price?: number;
  yesBuyPrice?: number;
  noBuyPrice?: number;
  marketThreshold?: number;
}

interface BayseEventRaw {
  id: string;
  slug: string;
  status?: string;
  openingDate: string;
  closingDate: string;
  eventThreshold?: number;
  seriesSlug?: string;
  markets?: BayseMarketRaw[];
}

interface BayseEventsResponse {
  events?: BayseEventRaw[];
}

interface BayseQuoteResponse {
  price?: number | string;
  currentMarketPrice?: number | string;
  quantity?: number | string;
  amount?: number | string;
  costOfShares?: number | string;
  fee?: number | string;
  priceImpactAbsolute?: number | string;
  profitPercentage?: number | string;
  currencyBaseMultiplier?: number | string;
  completeFill?: boolean;
  tradeGoesOverMaxLiability?: boolean;
}

interface ListSeriesEventsOptions {
  status?: string;
  size?: number;
}

export interface Round {
  eventId: string;
  slug: string;
  openingDate: string;
  closingDate: string;
  eventThreshold: number | null;
  pctElapsed: number;
}

export type CurrentRound = Round;

export interface RoundPricing {
  upPrice: number;
  downPrice: number;
  upOutcomeId: string | null;
  downOutcomeId: string | null;
  eventThreshold: number | null;
  eventId: string;
  marketId: string;
  url: string;
}

export interface BayseTradeQuote {
  price: number;
  currentMarketPrice: number;
  quantity: number;
  amount: number;
  costOfShares: number;
  fee: number;
  priceImpactAbsolute: number;
  profitPercentage: number | null;
  currencyBaseMultiplier: number;
  completeFill: boolean;
  tradeGoesOverMaxLiability: boolean;
}

function normalizeRoundPricing(
  event: BayseEventRaw,
  market: BayseMarketRaw
): RoundPricing {
  return {
    upPrice: market.outcome1Price ?? market.yesBuyPrice ?? 0,
    downPrice: market.outcome2Price ?? market.noBuyPrice ?? 0,
    upOutcomeId: market.outcome1Id ?? null,
    downOutcomeId: market.outcome2Id ?? null,
    eventThreshold: event.eventThreshold ?? market.marketThreshold ?? null,
    eventId: event.id,
    marketId: market.id,
    url: `https://bayse.markets/event/${event.id}`,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bayse API ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function matchesAssetSlug(event: BayseEventRaw, asset: BayseAsset): boolean {
  if (event.seriesSlug === BAYSE_15M_SERIES_SLUGS[asset]) {
    return true;
  }

  return event.slug.toLowerCase().includes(BAYSE_ASSET_SLUG_MATCHERS[asset]);
}

function assetLookupOrder(slug: string): BayseAsset[] {
  const lowerSlug = slug.toLowerCase();
  const inferredAsset =
    (Object.entries(BAYSE_ASSET_SLUG_MATCHERS).find(([, matcher]) =>
      lowerSlug.includes(matcher)
    )?.[0] as BayseAsset | undefined) ?? "BTC";

  return [
    inferredAsset,
    ...Object.keys(BAYSE_15M_SERIES_SLUGS).filter(
      (asset) => asset !== inferredAsset
    ),
  ] as BayseAsset[];
}

async function listSeriesEvents(
  asset: BayseAsset = "BTC",
  options?: ListSeriesEventsOptions
): Promise<BayseEventRaw[]> {
  const url = new URL(`${BAYSE_BASE_URL}/pm/events`);
  const size = options?.size ?? 100;
  url.searchParams.set("seriesSlug", BAYSE_15M_SERIES_SLUGS[asset]);
  url.searchParams.set("page", "1");
  url.searchParams.set("size", String(size));
  url.searchParams.set("limit", String(size));

  if (options?.status) {
    url.searchParams.set("status", options.status);
  }

  const payload = await fetchJson<BayseEventsResponse>(url.toString());
  return (payload.events ?? [])
    .filter((event) => matchesAssetSlug(event, asset))
    .sort((left, right) => Date.parse(left.openingDate) - Date.parse(right.openingDate));
}

function findCurrentLikeOpenEvent(
  events: BayseEventRaw[],
  now: number
): BayseEventRaw | null {
  const candidates = events
    .filter((event) => {
      const closingTime = Date.parse(event.closingDate);

      if (!Number.isFinite(closingTime) || closingTime <= now) {
        return false;
      }

      const openingTime = Date.parse(event.openingDate);

      if (!Number.isFinite(openingTime)) {
        return true;
      }

      return openingTime <= now;
    })
    .sort((left, right) => Date.parse(left.closingDate) - Date.parse(right.closingDate));

  return candidates[0] ?? null;
}

async function findEventBySlug(slug: string): Promise<BayseEventRaw | null> {
  for (const asset of assetLookupOrder(slug)) {
    const events = await listSeriesEvents(asset);
    const eventMatch = events.find((event) => event.slug === slug);

    if (eventMatch) {
      return eventMatch;
    }
  }

  return null;
}

async function getEventBySlug(slug: string): Promise<BayseEventRaw | null> {
  const url = `${BAYSE_BASE_URL}/pm/events/slug/${encodeURIComponent(slug)}?currency=USD`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bayse API ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as BayseEventRaw;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function getCurrentRound(
  asset: BayseAsset = "BTC"
): Promise<Round | null> {
  const now = Date.now();
  const current =
    findCurrentLikeOpenEvent(
      await listSeriesEvents(asset, { status: "open", size: 20 }),
      now
    ) ?? findCurrentLikeOpenEvent(await listSeriesEvents(asset), now);

  if (!current) {
    return null;
  }

  const openingTime = Date.parse(current.openingDate);
  const closingTime = Date.parse(current.closingDate);
  const windowMs = closingTime - openingTime;
  const elapsedMs = now - openingTime;
  const pctElapsed = windowMs > 0 ? clamp(elapsedMs / windowMs, 0, 1) : 1;

  return {
    eventId: current.id,
    slug: current.slug,
    openingDate: current.openingDate,
    closingDate: current.closingDate,
    eventThreshold: current.eventThreshold ?? null,
    pctElapsed,
  };
}

function parseNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export async function getNextRoundStart(
  asset: BayseAsset = "BTC"
): Promise<string | null> {
  const now = Date.now();
  const openEvents = await listSeriesEvents(asset, { status: "open", size: 20 });
  const current = findCurrentLikeOpenEvent(openEvents, now);

  if (current) {
    return current.closingDate;
  }

  const byOpeningDate = await listSeriesEvents(asset);
  const next = byOpeningDate.find((event) => Date.parse(event.openingDate) > now);
  return next?.openingDate ?? null;
}

export async function getRoundPricing(slug: string): Promise<RoundPricing | null> {
  const eventMatch = await getEventBySlug(slug);

  if (!eventMatch) {
    const fallback = await findEventBySlug(slug);

    if (!fallback) {
      return null;
    }

    return getEventPricing(fallback.id);
  }

  const market = eventMatch.markets?.[0];

  if (!market) {
    return null;
  }

  return normalizeRoundPricing(eventMatch, market);
}

export async function getEventPricing(
  eventId: string,
  marketId?: string
): Promise<RoundPricing | null> {
  const cleanMarketId =
    marketId && marketId.startsWith("bayse_") ? marketId.slice(6) : marketId;

  const url = `${BAYSE_BASE_URL}/pm/events/${eventId}?currency=USD`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bayse API ${response.status}: ${text || response.statusText}`);
  }

  const event = (await response.json()) as BayseEventRaw;
  const market =
    (cleanMarketId
      ? event.markets?.find((candidate) => candidate.id === cleanMarketId)
      : null) ?? event.markets?.[0];

  if (!market) {
    return null;
  }

  return normalizeRoundPricing(event, market);
}

export async function getEvent(eventId: string): Promise<unknown> {
  const url = `${BAYSE_BASE_URL}/pm/events/${eventId}?currency=USD`;
  return fetchJson<unknown>(url);
}

export async function getTradeQuote(input: {
  eventId: string;
  marketId: string;
  outcomeId: string;
  amount: number;
  currency?: "USD" | "NGN";
}): Promise<BayseTradeQuote | null> {
  const url =
    `${BAYSE_BASE_URL}/pm/events/${input.eventId}` +
    `/markets/${input.marketId}/quote`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      side: "BUY",
      outcomeId: input.outcomeId,
      amount: input.amount,
      currency: input.currency ?? "USD",
    }),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bayse API ${response.status}: ${text || response.statusText}`);
  }

  const quote = (await response.json()) as BayseQuoteResponse;

  return {
    price: parseNumber(quote.price),
    currentMarketPrice: parseNumber(quote.currentMarketPrice),
    quantity: parseNumber(quote.quantity),
    amount: parseNumber(quote.amount),
    costOfShares: parseNumber(quote.costOfShares),
    fee: parseNumber(quote.fee),
    priceImpactAbsolute: parseNumber(quote.priceImpactAbsolute),
    profitPercentage:
      quote.profitPercentage === undefined || quote.profitPercentage === null
        ? null
        : parseNumber(quote.profitPercentage),
    currencyBaseMultiplier: parseNumber(quote.currencyBaseMultiplier) || 1,
    completeFill: quote.completeFill ?? true,
    tradeGoesOverMaxLiability: quote.tradeGoesOverMaxLiability ?? false,
  };
}
