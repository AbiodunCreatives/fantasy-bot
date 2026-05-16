import { supabase } from "./client.ts";
import { upsertUserProfile } from "./users.ts";

export interface PajCashOnramp {
  id: string;
  order_id: string;
  telegram_id: number | null;
  recipient_address: string | null;
  sender: string | null;
  mint: string | null;
  chain: string;
  currency: string;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  fiat_amount: number;
  expected_usdc_amount: number;
  actual_usdc_amount: number;
  rate: number;
  fee: number;
  status: string;
  transaction_type: string | null;
  paj_signature: string | null;
  raw_payload: Record<string, unknown>;
  paid_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PajCashOnrampRow
  extends Omit<
    PajCashOnramp,
    | "fiat_amount"
    | "expected_usdc_amount"
    | "actual_usdc_amount"
    | "rate"
    | "fee"
    | "raw_payload"
  > {
  fiat_amount: number | string | null;
  expected_usdc_amount: number | string | null;
  actual_usdc_amount: number | string | null;
  rate: number | string | null;
  fee: number | string | null;
  raw_payload: Record<string, unknown> | null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseMoney(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundMoney(value) : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
  }

  return 0;
}

function parseUsdc(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundUsdc(value) : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundUsdc(parsed) : 0;
  }

  return 0;
}

function normalizePajCashOnramp(row: PajCashOnrampRow): PajCashOnramp {
  return {
    ...row,
    fiat_amount: parseMoney(row.fiat_amount),
    expected_usdc_amount: parseUsdc(row.expected_usdc_amount),
    actual_usdc_amount: parseUsdc(row.actual_usdc_amount),
    rate: parseUsdc(row.rate),
    fee: parseUsdc(row.fee),
    raw_payload: row.raw_payload ?? {},
  };
}

export async function createPajCashOnrampRecord(input: {
  orderId: string;
  telegramId: number;
  recipientAddress: string;
  mint: string;
  chain: string;
  currency: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  fiatAmount: number;
  expectedUsdcAmount: number;
  rate: number;
  fee: number;
  rawPayload: Record<string, unknown>;
}): Promise<PajCashOnramp> {
  await upsertUserProfile(input.telegramId);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fantasy_pajcash_onramps")
    .insert({
      order_id: input.orderId,
      telegram_id: input.telegramId,
      recipient_address: input.recipientAddress,
      mint: input.mint,
      chain: input.chain,
      currency: input.currency,
      bank_name: input.bankName,
      account_name: input.accountName,
      account_number: input.accountNumber,
      fiat_amount: roundMoney(input.fiatAmount),
      expected_usdc_amount: roundUsdc(input.expectedUsdcAmount),
      rate: roundUsdc(input.rate),
      fee: roundUsdc(input.fee),
      status: "INIT",
      transaction_type: "ON_RAMP",
      raw_payload: input.rawPayload,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizePajCashOnramp(data as PajCashOnrampRow);
}

export async function getPajCashOnrampByOrderId(
  orderId: string
): Promise<PajCashOnramp | null> {
  const { data, error } = await supabase
    .from("fantasy_pajcash_onramps")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizePajCashOnramp(data as PajCashOnrampRow) : null;
}

export async function listRecentPajCashOnramps(
  telegramId: number,
  limit = 4
): Promise<PajCashOnramp[]> {
  const { data, error } = await supabase
    .from("fantasy_pajcash_onramps")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("transaction_type", "ON_RAMP")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizePajCashOnramp(row as PajCashOnrampRow)
  );
}

export async function createPajCashOfframpRecord(input: {
  orderId: string;
  telegramId: number;
  senderAddress: string;
  depositAddress: string;
  mint: string;
  chain: string;
  currency: string;
  bankId: string;
  accountNumber: string;
  usdcAmount: number;
  fiatAmount: number;
  rate: number;
  fee: number;
  rawPayload: Record<string, unknown>;
}): Promise<PajCashOnramp> {
  await upsertUserProfile(input.telegramId);

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fantasy_pajcash_onramps")
    .insert({
      order_id: input.orderId,
      telegram_id: input.telegramId,
      recipient_address: input.depositAddress,
      sender: input.senderAddress,
      mint: input.mint,
      chain: input.chain,
      currency: input.currency,
      bank_name: input.bankId,
      account_number: input.accountNumber,
      fiat_amount: roundMoney(input.fiatAmount),
      expected_usdc_amount: roundUsdc(input.usdcAmount),
      rate: roundUsdc(input.rate),
      fee: roundUsdc(input.fee),
      status: "INIT",
      transaction_type: "OFF_RAMP",
      raw_payload: input.rawPayload,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizePajCashOnramp(data as PajCashOnrampRow);
}

export async function listRecentPajCashOfframps(
  telegramId: number,
  limit = 4
): Promise<PajCashOnramp[]> {
  const { data, error } = await supabase
    .from("fantasy_pajcash_onramps")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("transaction_type", "OFF_RAMP")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizePajCashOnramp(row as PajCashOnrampRow)
  );
}

export async function upsertPajCashOnrampStatus(input: {
  orderId: string;
  telegramId?: number | null;
  recipientAddress?: string | null;
  sender?: string | null;
  mint?: string | null;
  chain?: string | null;
  currency?: string | null;
  bankName?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
  fiatAmount?: number | null;
  expectedUsdcAmount?: number | null;
  actualUsdcAmount?: number | null;
  rate?: number | null;
  fee?: number | null;
  status: string;
  transactionType?: string | null;
  pajSignature?: string | null;
  rawPayload?: Record<string, unknown> | null;
}): Promise<PajCashOnramp> {
  const existing = await getPajCashOnrampByOrderId(input.orderId);
  const now = new Date().toISOString();
  const normalizedStatus = input.status.trim() || "INIT";
  const payload: Record<string, unknown> = {
    order_id: input.orderId,
    status: normalizedStatus,
    updated_at: now,
  };

  if (input.telegramId !== undefined && input.telegramId !== null) {
    payload.telegram_id = input.telegramId;
  } else if (!existing) {
    payload.telegram_id = null;
  }

  if (input.recipientAddress !== undefined) {
    payload.recipient_address = input.recipientAddress;
  }

  if (input.sender !== undefined) {
    payload.sender = input.sender;
  }

  if (input.mint !== undefined) {
    payload.mint = input.mint;
  }

  if (input.chain !== undefined && input.chain !== null) {
    payload.chain = input.chain;
  } else if (!existing) {
    payload.chain = "SOLANA";
  }

  if (input.currency !== undefined && input.currency !== null) {
    payload.currency = input.currency;
  } else if (!existing) {
    payload.currency = "NGN";
  }

  if (input.bankName !== undefined) {
    payload.bank_name = input.bankName;
  }

  if (input.accountName !== undefined) {
    payload.account_name = input.accountName;
  }

  if (input.accountNumber !== undefined) {
    payload.account_number = input.accountNumber;
  }

  if (input.fiatAmount !== undefined && input.fiatAmount !== null) {
    payload.fiat_amount = roundMoney(input.fiatAmount);
  }

  if (input.expectedUsdcAmount !== undefined && input.expectedUsdcAmount !== null) {
    payload.expected_usdc_amount = roundUsdc(input.expectedUsdcAmount);
  }

  if (input.actualUsdcAmount !== undefined && input.actualUsdcAmount !== null) {
    payload.actual_usdc_amount = roundUsdc(input.actualUsdcAmount);
  }

  if (input.rate !== undefined && input.rate !== null) {
    payload.rate = roundUsdc(input.rate);
  }

  if (input.fee !== undefined && input.fee !== null) {
    payload.fee = roundUsdc(input.fee);
  }

  if (input.transactionType !== undefined) {
    payload.transaction_type = input.transactionType;
  }

  if (input.pajSignature !== undefined) {
    payload.paj_signature = input.pajSignature;
  }

  if (input.rawPayload !== undefined && input.rawPayload !== null) {
    payload.raw_payload = input.rawPayload;
  } else if (!existing) {
    payload.raw_payload = {};
  }

  if (normalizedStatus.toUpperCase() === "PAID" && !existing?.paid_at) {
    payload.paid_at = now;
  }

  if (normalizedStatus.toUpperCase() === "COMPLETED" && !existing?.completed_at) {
    payload.completed_at = now;
  }

  const query = existing
    ? supabase
        .from("fantasy_pajcash_onramps")
        .update(payload)
        .eq("order_id", input.orderId)
    : supabase.from("fantasy_pajcash_onramps").insert({
        ...payload,
        created_at: now,
      });

  const { data, error } = await query.select("*").single();

  if (error) {
    throw error;
  }

  return normalizePajCashOnramp(data as PajCashOnrampRow);
}
