import { config } from "./config.ts";
import {
  createPajCashOnrampRecord,
  createPajCashOfframpRecord,
  getPajCashOnrampByOrderId,
  upsertPajCashOnrampStatus,
  type PajCashOnramp,
} from "./db/pajcash.ts";
import { getBalance, debitBalance } from "./db/balances.ts";
import { getFantasyWalletByOwnerAddress, type FantasyWallet } from "./db/wallets.ts";
import {
  ensureFantasyWallet,
  syncFantasyWalletDeposits,
} from "./solana-wallet.ts";

interface PajCashVerifyResponse {
  recipient: string;
  isActive: string;
  expiresAt: string;
  token: string;
}

interface PajCashOnrampOrderResponse {
  id: string;
  accountNumber: string;
  accountName: string;
  amount: number;
  fiatAmount: number;
  bank: string;
  rate: number;
  recipient: string;
  currency: string;
  mint: string;
  fee?: number;
}

interface PajCashOfframpOrderResponse {
  id: string;
  address: string;
  mint: string;
  currency: string;
  amount: number;
  fiatAmount: number;
  rate: number;
  fee: number;
}

export interface PajCashBank {
  id: string;
  code: string;
  name: string;
  logo?: string;
  country: string;
}

export interface PajCashBankAccountConfirmation {
  accountName: string;
  accountNumber: string;
  bank: {
    id: string;
    name: string;
    code: string;
    country: string;
  };
}

interface PajCashTransactionResponse {
  id: string;
  address?: string;
  signature?: string;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
  status: string;
  transactionType?: string;
  createdAt?: string | Date;
  fee?: number;
}

export interface PajCashWebhookPayload {
  id: string;
  address?: string;
  signature?: string;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
  status: string;
  transactionType?: string;
}

const PAJCASH_REQUEST_TIMEOUT_MS = 20_000;

function roundFiat(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function getPajCashBaseUrl(): string {
  if (config.PAJCASH_ENV === "staging") {
    return "https://api-staging.paj.cash";
  }

  if (config.PAJCASH_ENV === "local") {
    return "http://localhost:3000";
  }

  return "https://api.paj.cash";
}

function getRequiredPajCashApiKey(): string {
  const value = config.PAJCASH_API_KEY?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_API_KEY is missing.");
  }

  return value;
}

function getRequiredPajCashSessionRecipient(): string {
  const value = config.PAJCASH_SESSION_RECIPIENT?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_SESSION_RECIPIENT is missing.");
  }

  return value;
}

function getRequiredPajCashSessionToken(): string {
  const token = config.PAJCASH_SESSION_TOKEN?.trim() ?? "";

  if (!token) {
    throw new Error(
      "PAJCASH_SESSION_TOKEN is missing. Run `pnpm pajcash:session` to request and verify a PajCash OTP session."
    );
  }

  const expiresAt = config.PAJCASH_SESSION_EXPIRES_AT?.trim() ?? "";

  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);

    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + 60_000) {
      throw new Error(
        "PAJCASH session token is expired or about to expire. Run `pnpm pajcash:session` again."
      );
    }
  }

  return token;
}

function getRequiredPajCashWebhookPathSecret(): string {
  const value = config.PAJCASH_WEBHOOK_PATH_SECRET?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_WEBHOOK_PATH_SECRET is missing.");
  }

  return value;
}

function getPajCashWebhookBaseUrl(): string {
  const explicit = config.PAJCASH_WEBHOOK_BASE_URL?.trim() ?? "";

  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const fallback = config.WEBHOOK_URL?.trim() ?? "";

  if (fallback) {
    return fallback.replace(/\/+$/, "");
  }

  throw new Error(
    "PAJCASH_WEBHOOK_BASE_URL is missing. Set it to the public base URL that PajCash should call."
  );
}

async function parsePajCashResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  let parsed: unknown = {};

  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as T;
    } catch {
      if (!response.ok) {
        throw new Error(rawText || `PajCash request failed with ${response.status}`);
      }

      throw new Error(
        `PajCash returned an invalid JSON response with status ${response.status}.`
      );
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in (parsed as object)
        ? String((parsed as Record<string, unknown>).message)
        : rawText || `PajCash request failed with ${response.status}`;

    throw new Error(message);
  }

  return parsed as T;
}

async function pajCashRequest<T>(
  path: string,
  input: {
    method?: "GET" | "POST";
    token?: string;
    apiKey?: string;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }

  if (input.apiKey) {
    headers["x-api-key"] = input.apiKey;
  }

  const response = await fetch(`${getPajCashBaseUrl()}${path}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(PAJCASH_REQUEST_TIMEOUT_MS),
  });

  return parsePajCashResponse<T>(response);
}

function normalizePajCashStatus(status: string): string {
  const normalized = status.trim().toUpperCase();

  if (!normalized) {
    throw new Error("PajCash webhook payload is missing status.");
  }

  return normalized;
}

function isPajCashCompletedStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toUpperCase() === "COMPLETED";
}

export function getPajCashWebhookUrl(): string {
  return `${getPajCashWebhookBaseUrl()}/webhook/pajcash/${getRequiredPajCashWebhookPathSecret()}`;
}

export async function initiatePajCashSession(): Promise<{ email?: string; phone?: string }> {
  const recipient = getRequiredPajCashSessionRecipient();
  const apiKey = getRequiredPajCashApiKey();
  const body = recipient.includes("@")
    ? { email: recipient }
    : { phone: recipient };

  return pajCashRequest("/pub/initiate", {
    method: "POST",
    apiKey,
    body,
  });
}

export async function verifyPajCashSessionOtp(
  otp: string
): Promise<PajCashVerifyResponse> {
  const trimmedOtp = otp.trim();

  if (!trimmedOtp) {
    throw new Error("OTP is required.");
  }

  const recipient = getRequiredPajCashSessionRecipient();
  const apiKey = getRequiredPajCashApiKey();
  const body = recipient.includes("@")
    ? {
        email: recipient,
        otp: trimmedOtp,
        device: {
          uuid: `fantasybot-${Date.now()}`,
          device: "Fantasy Bot Server",
          os: process.platform,
          browser: "Node.js",
        },
      }
    : {
        phone: recipient,
        otp: trimmedOtp,
        device: {
          uuid: `fantasybot-${Date.now()}`,
          device: "Fantasy Bot Server",
          os: process.platform,
          browser: "Node.js",
        },
      };

  return pajCashRequest<PajCashVerifyResponse>("/pub/verify", {
    method: "POST",
    apiKey,
    body,
  });
}

export async function createFantasyPajCashOnramp(input: {
  telegramId: number;
  fiatAmount: number;
}): Promise<PajCashOnramp> {
  const sessionToken = getRequiredPajCashSessionToken();
  const wallet = await ensureFantasyWallet(input.telegramId);
  const fiatAmount = roundFiat(input.fiatAmount);

  if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    throw new Error("Fiat amount must be greater than zero.");
  }

  const requestBody: Record<string, unknown> = {
    fiatAmount,
    currency: "NGN",
    recipient: wallet.owner_address,
    mint: config.SOLANA_USDC_MINT,
    chain: "SOLANA",
    webhookURL: getPajCashWebhookUrl(),
  };

  if (config.PAJCASH_BUSINESS_USDC_FEE !== undefined) {
    requestBody.businessUSDCFee = config.PAJCASH_BUSINESS_USDC_FEE;
  }

  const order = await pajCashRequest<PajCashOnrampOrderResponse>("/pub/onramp", {
    method: "POST",
    token: sessionToken,
    body: requestBody,
  });

  return createPajCashOnrampRecord({
    orderId: order.id,
    telegramId: input.telegramId,
    recipientAddress: wallet.owner_address,
    mint: order.mint,
    chain: "SOLANA",
    currency: order.currency,
    bankName: order.bank,
    accountName: order.accountName,
    accountNumber: order.accountNumber,
    fiatAmount: order.fiatAmount,
    expectedUsdcAmount: order.amount,
    rate: order.rate,
    fee: order.fee ?? config.PAJCASH_BUSINESS_USDC_FEE ?? 0,
    rawPayload: order as unknown as Record<string, unknown>,
  });
}

export async function getPajCashTransaction(
  orderId: string
): Promise<PajCashTransactionResponse> {
  return pajCashRequest<PajCashTransactionResponse>(`/pub/transactions/${orderId}`, {
    token: getRequiredPajCashSessionToken(),
  });
}

export async function getBanks(): Promise<PajCashBank[]> {
  return pajCashRequest<PajCashBank[]>("/pub/bank", {
    token: getRequiredPajCashSessionToken(),
  });
}

export async function confirmBankAccount(input: {
  bankId: string;
  accountNumber: string;
}): Promise<PajCashBankAccountConfirmation> {
  return pajCashRequest<PajCashBankAccountConfirmation>(
    `/pub/bank-account/confirm?bankId=${encodeURIComponent(input.bankId)}&accountNumber=${encodeURIComponent(input.accountNumber)}`,
    { token: getRequiredPajCashSessionToken() }
  );
}

export const PAJCASH_OFFRAMP_MIN_USDC = 0.5;

export async function createFantasyPajCashOfframp(input: {
  telegramId: number;
  bankId: string;
  accountNumber: string;
  usdcAmount: number;
}): Promise<PajCashOnramp> {
  const usdcAmount = roundUsdc(input.usdcAmount);

  if (!Number.isFinite(usdcAmount) || usdcAmount < PAJCASH_OFFRAMP_MIN_USDC) {
    throw new Error(`Minimum offramp amount is ${PAJCASH_OFFRAMP_MIN_USDC} USDC.`);
  }

  const balance = await getBalance(input.telegramId);

  if (balance < usdcAmount) {
    throw new Error(`Insufficient wallet balance. Available: ${balance} USDC.`);
  }

  const sessionToken = getRequiredPajCashSessionToken();
  const wallet = await ensureFantasyWallet(input.telegramId);

  const requestBody: Record<string, unknown> = {
    bank: input.bankId,
    accountNumber: input.accountNumber,
    currency: "NGN",
    amount: usdcAmount,
    mint: config.SOLANA_USDC_MINT,
    chain: "SOLANA",
    webhookURL: getPajCashWebhookUrl(),
  };

  if (config.PAJCASH_BUSINESS_USDC_FEE !== undefined) {
    requestBody.businessUSDCFee = config.PAJCASH_BUSINESS_USDC_FEE;
  }

  const order = await pajCashRequest<PajCashOfframpOrderResponse>("/pub/offramp", {
    method: "POST",
    token: sessionToken,
    body: requestBody,
  });

  // Debit the user's balance before returning the deposit address
  const debited = await debitBalance(input.telegramId, usdcAmount, {
    reason: "offramp_request",
    referenceType: "pajcash_offramp",
    metadata: { orderId: order.id },
  });

  if (!debited) {
    throw new Error(`Insufficient wallet balance to offramp ${usdcAmount} USDC.`);
  }

  return createPajCashOfframpRecord({
    orderId: order.id,
    telegramId: input.telegramId,
    senderAddress: wallet.owner_address,
    depositAddress: order.address,
    mint: order.mint,
    chain: "SOLANA",
    currency: order.currency,
    bankId: input.bankId,
    accountNumber: input.accountNumber,
    usdcAmount: order.amount,
    fiatAmount: order.fiatAmount,
    rate: order.rate,
    fee: order.fee ?? config.PAJCASH_BUSINESS_USDC_FEE ?? 0,
    rawPayload: order as unknown as Record<string, unknown>,
  });
}

function getPayloadUsdcAmount(
  payload: PajCashWebhookPayload | PajCashTransactionResponse
): number | null {
  if (typeof payload.usdcAmount === "number" && Number.isFinite(payload.usdcAmount)) {
    return roundUsdc(payload.usdcAmount);
  }

  if (typeof payload.amount === "number" && Number.isFinite(payload.amount)) {
    return roundUsdc(payload.amount);
  }

  return null;
}

async function resolveOnrampWallet(
  payload: PajCashWebhookPayload
): Promise<FantasyWallet | null> {
  const recipient = payload.recipient?.trim() ?? "";

  if (!recipient) {
    return null;
  }

  return getFantasyWalletByOwnerAddress(recipient);
}

export async function reconcilePajCashWebhook(
  payload: PajCashWebhookPayload
): Promise<PajCashOnramp | null> {
  if (!payload.id) {
    throw new Error("PajCash webhook payload is missing id.");
  }

  const payloadStatus = normalizePajCashStatus(payload.status);
  const transactionType = payload.transactionType?.toUpperCase() ?? "";

  if (transactionType && transactionType !== "ON_RAMP" && transactionType !== "OFF_RAMP") {
    return null;
  }

  const existing = await getPajCashOnrampByOrderId(payload.id);
  let wallet =
    existing?.recipient_address
      ? await getFantasyWalletByOwnerAddress(existing.recipient_address)
      : await resolveOnrampWallet(payload);

  let record = await upsertPajCashOnrampStatus({
    orderId: payload.id,
    telegramId: existing?.telegram_id ?? wallet?.telegram_id ?? null,
    recipientAddress: payload.recipient ?? existing?.recipient_address ?? null,
    sender: payload.sender ?? existing?.sender ?? null,
    mint: payload.mint ?? existing?.mint ?? null,
    chain: "SOLANA",
    currency: payload.currency ?? existing?.currency ?? "NGN",
    actualUsdcAmount: getPayloadUsdcAmount(payload),
    expectedUsdcAmount: getPayloadUsdcAmount(payload),
    fiatAmount:
      typeof payload.fiatAmount === "number" ? roundFiat(payload.fiatAmount) : null,
    rate: typeof payload.rate === "number" ? roundUsdc(payload.rate) : null,
    status: payloadStatus,
    transactionType: transactionType || existing?.transaction_type || "ON_RAMP",
    pajSignature: payload.signature ?? existing?.paj_signature ?? null,
    rawPayload: payload as unknown as Record<string, unknown>,
  });

  if (!wallet && record.recipient_address) {
    wallet = await getFantasyWalletByOwnerAddress(record.recipient_address);
  }

  try {
    const verified = await getPajCashTransaction(payload.id);

    record = await upsertPajCashOnrampStatus({
      orderId: payload.id,
      telegramId: record.telegram_id,
      recipientAddress: verified.recipient ?? record.recipient_address,
      sender: verified.sender ?? record.sender,
      mint: verified.mint ?? record.mint,
      chain: "SOLANA",
      currency: verified.currency ?? record.currency,
      actualUsdcAmount: getPayloadUsdcAmount(verified),
      expectedUsdcAmount:
        record.expected_usdc_amount > 0
          ? record.expected_usdc_amount
          : getPayloadUsdcAmount(verified),
      fiatAmount:
        typeof verified.fiatAmount === "number"
          ? roundFiat(verified.fiatAmount)
          : record.fiat_amount,
      rate: typeof verified.rate === "number" ? roundUsdc(verified.rate) : record.rate,
      fee: typeof verified.fee === "number" ? roundUsdc(verified.fee) : record.fee,
      status: normalizePajCashStatus(verified.status),
      transactionType: verified.transactionType ?? record.transaction_type,
      pajSignature: verified.signature ?? record.paj_signature,
      rawPayload: verified as unknown as Record<string, unknown>,
    });

    if (!wallet && record.recipient_address) {
      wallet = await getFantasyWalletByOwnerAddress(record.recipient_address);
    }
  } catch (error) {
    console.warn("[pajcash] Transaction verification failed:", error);
  }

  if (wallet && isPajCashCompletedStatus(record.status) && (record.transaction_type ?? "ON_RAMP") === "ON_RAMP") {
    await syncFantasyWalletDeposits(wallet).catch((error) => {
      console.warn("[pajcash] Deposit sync after webhook failed:", error);
    });
  }

  return record;
}
