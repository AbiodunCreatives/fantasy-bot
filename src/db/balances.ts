import { supabase } from "./client.ts";
import { upsertUserProfile } from "./users.ts";

interface FantasyUserBalanceRow {
  telegram_id: number;
  wallet_balance: number | string | null;
}

export interface BalanceChangeOptions {
  reason?: string;
  entryType?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseBalance(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return roundMoney(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
  }

  return 0;
}

function getEntryType(options?: BalanceChangeOptions): string {
  const value = options?.entryType ?? options?.reason ?? "adjustment";
  return value.trim() || "adjustment";
}

function extractRpcBalance(data: unknown): number {
  if (typeof data === "number" || typeof data === "string") {
    return parseBalance(data);
  }

  if (Array.isArray(data)) {
    return extractRpcBalance(data[0]);
  }

  if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    return extractRpcBalance(row["wallet_balance"] ?? row["balance_after"]);
  }

  return 0;
}

async function getFantasyUserRow(
  telegramId: string
): Promise<FantasyUserBalanceRow | null> {
  const { data, error } = await supabase
    .from("fantasy_users")
    .select("telegram_id, wallet_balance")
    .eq("telegram_id", Number.parseInt(telegramId, 10))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as FantasyUserBalanceRow | null) ?? null;
}

async function applyBalanceDelta(input: {
  telegramId: number;
  delta: number;
  allowNegative: boolean;
  options?: BalanceChangeOptions;
}): Promise<{
  success: boolean;
  balanceAfter: number;
}> {
  const normalizedDelta = roundMoney(input.delta);

  if (!Number.isFinite(normalizedDelta)) {
    throw new Error("Balance delta must be a finite number.");
  }

  await upsertUserProfile(input.telegramId);

  const { data, error } = await supabase.rpc("apply_wallet_balance_change", {
    p_telegram_id: input.telegramId,
    p_delta: normalizedDelta,
    p_allow_negative: input.allowNegative,
    p_entry_type: getEntryType(input.options),
    p_reference_type: input.options?.referenceType ?? null,
    p_reference_id: input.options?.referenceId ?? null,
    p_idempotency_key: input.options?.idempotencyKey ?? null,
    p_metadata: input.options?.metadata ?? {},
  });

  if (error) {
    const message = error.message.toLowerCase();

    if (message.includes("insufficient wallet balance")) {
      return {
        success: false,
        balanceAfter: await getBalance(input.telegramId),
      };
    }

    throw error;
  }

  return {
    success: true,
    balanceAfter: extractRpcBalance(data),
  };
}

export async function getBalance(telegramId: number): Promise<number> {
  await upsertUserProfile(telegramId);
  const row = await getFantasyUserRow(String(telegramId));
  return parseBalance(row?.wallet_balance);
}

export async function creditBalance(
  telegramId: number,
  amount: number,
  options?: BalanceChangeOptions
): Promise<void> {
  const normalizedAmount = roundMoney(amount);

  if (normalizedAmount <= 0) {
    return;
  }

  const result = await applyBalanceDelta({
    telegramId,
    delta: normalizedAmount,
    allowNegative: true,
    options,
  });

  if (!result.success) {
    throw new Error("Credit operation was rejected.");
  }
}

export async function debitBalance(
  telegramId: number,
  amount: number,
  options?: BalanceChangeOptions
): Promise<boolean> {
  const normalizedAmount = roundMoney(amount);

  if (normalizedAmount <= 0) {
    return true;
  }

  const result = await applyBalanceDelta({
    telegramId,
    delta: -normalizedAmount,
    allowNegative: false,
    options,
  });

  return result.success;
}
