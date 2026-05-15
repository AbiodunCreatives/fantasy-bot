// Dextopus cross-chain deposit API client
// Base URL: https://swap-api.dextopus.com — no auth required
// Amounts are always in smallest unit (1 USDC = 1_000_000)

const BASE_URL = "https://swap-api.dextopus.com";

export interface DextopusToken {
  chainId: number | string;
  address: string;
  symbol: string;
  decimals: number;
  supportsStaticAddress?: boolean;
}

export interface DextopusQuoteRequest {
  originChainId: number | string;
  destinationChainId: number | string;
  originAsset: string;
  destinationAsset: string;
  amount: string; // smallest unit
  recipient: string;
  refundTo: string;
  partnerFees?: Array<{ recipient: string; fee: number }>;
  dry?: boolean;
}

export interface DextopusQuoteResponse {
  depositRequestId: string;
  depositAddress: string;
  amountOut: string;
  expiresInSeconds: number;
  isStaticAddress: boolean;
}

export interface DextopusStatusResponse {
  depositRequestId: string;
  depositAddress: string;
  status: string;
  executionStatus: string;
  originTransactionHashes: string[];
  destinationTransactionHashes: string[];
  isStaticAddress: boolean;
}

export interface DextopusValidateRequest {
  chainType: "evm" | "solana" | "tron" | "bitcoin";
  address: string;
}

export interface DextopusValidateResponse {
  valid: boolean;
  reason?: string;
}

async function dextopusFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dextopus ${path} failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Fetch all supported deposit origin chains and tokens. Cache the result. */
export async function getDextopusTokens(
  supportsStaticAddress?: boolean
): Promise<DextopusToken[]> {
  const qs =
    supportsStaticAddress !== undefined
      ? `?supportsStaticAddress=${supportsStaticAddress}`
      : "";
  return dextopusFetch<DextopusToken[]>(`/api/deposit/tokens${qs}`);
}

/** Get destination options for a given origin asset. */
export async function getDextopusDestinations(params: {
  originAddress?: string;
  originChainId?: number | string;
}): Promise<DextopusToken[]> {
  const qs = new URLSearchParams();
  if (params.originAddress) qs.set("originAddress", params.originAddress);
  if (params.originChainId !== undefined)
    qs.set("originChainId", String(params.originChainId));
  return dextopusFetch<DextopusToken[]>(
    `/api/deposit/destinations?${qs.toString()}`
  );
}

/** Validate a recipient address format before creating a deposit request. */
export async function validateDextopusAddress(
  req: DextopusValidateRequest
): Promise<DextopusValidateResponse> {
  return dextopusFetch<DextopusValidateResponse>(
    "/api/deposit/validate-address",
    { method: "POST", body: JSON.stringify(req) }
  );
}

/** Create a deposit request. Returns the depositAddress to show the user. */
export async function createDextopusDeposit(
  req: DextopusQuoteRequest
): Promise<DextopusQuoteResponse> {
  return dextopusFetch<DextopusQuoteResponse>("/api/deposit/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Poll deposit status by depositRequestId. */
export async function getDextopusDepositStatus(
  depositRequestId: string
): Promise<DextopusStatusResponse> {
  return dextopusFetch<DextopusStatusResponse>(
    `/api/deposit/status?depositRequestId=${encodeURIComponent(depositRequestId)}`
  );
}

/** Submit a tx hash for chains that need manual notification. */
export async function submitDextopusTxHash(params: {
  depositRequestId: string;
  depositAddress: string;
  txHash: string;
}): Promise<void> {
  await dextopusFetch("/api/deposit/submit", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
