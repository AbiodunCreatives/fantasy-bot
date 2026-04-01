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

async function listSeriesEvents(asset: BayseAsset = "BTC"): Promise<BayseEventRaw[]> {
  const url = new URL(`${BAYSE_BASE_URL}/pm/events`);
  url.searchParams.set("seriesSlug", BAYSE_15M_SERIES_SLUGS[asset]);
  url.searchParams.set("page", "1");
  url.searchParams.set("size", "100");

  const payload = await fetchJson<BayseEventsResponse>(url.toString());
  return (payload.events ?? []).filter((event) => matchesAssetSlug(event, asset));
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function getCurrentRound(
  asset: BayseAsset = "BTC"
): Promise<Round | null> {
  const now = Date.now();
  const events = await listSeriesEvents(asset);

  const current = events.find((event) => {
    if ((event.status ?? "").toLowerCase() !== "open") {
      return false;
    }

    const openingTime = Date.parse(event.openingDate);
    const closingTime = Date.parse(event.closingDate);

    return openingTime <= now && now < closingTime;
  });

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

export async function getRoundPricing(slug: string): Promise<RoundPricing | null> {
  const eventMatch = await findEventBySlug(slug);

  if (!eventMatch) {
    return null;
  }

  return getEventPricing(eventMatch.id);
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
