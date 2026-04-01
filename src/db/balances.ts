import { supabase } from "./client.js";

interface UserAccessBalanceRow {
  telegram_id: string;
  balance: number | string | null;
}

interface ApplyBalanceDeltaRow {
  success?: boolean | null;
  balance_before?: number | string | null;
  balance_after?: number | string | null;
}

export interface BalanceChangeOptions {
  reason?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

async function getUserAccessRow(
  telegramId: string
): Promise<UserAccessBalanceRow | null> {
  const { data, error } = await supabase
    .from("user_access")
    .select("telegram_id, balance")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as UserAccessBalanceRow | null) ?? null;
}

async function applyBalanceDelta(input: {
  telegramId: number;
  delta: number;
  allowNegative: boolean;
  options?: BalanceChangeOptions;
}): Promise<{
  success: boolean;
  balanceBefore: number;
  balanceAfter: number;
}> {
  const normalizedDelta = roundMoney(input.delta);

  if (!Number.isFinite(normalizedDelta)) {
    throw new Error("Balance delta must be a finite number.");
  }

  const { data, error } = await supabase.rpc("apply_balance_delta", {
    p_telegram_id: input.telegramId,
    p_delta: normalizedDelta,
    p_allow_negative: input.allowNegative,
    p_reason: input.options?.reason ?? "adjustment",
    p_reference_type: input.options?.referenceType ?? null,
    p_reference_id: input.options?.referenceId ?? null,
    p_metadata: input.options?.metadata ?? {},
  });

  if (error) {
    throw error;
  }

  const row = (
    Array.isArray(data) ? data[0] : data
  ) as ApplyBalanceDeltaRow | null;

  return {
    success: row?.success === true,
    balanceBefore: parseBalance(row?.balance_before),
    balanceAfter: parseBalance(row?.balance_after),
  };
}

export async function getBalance(telegramId: number): Promise<number> {
  const row = await getUserAccessRow(String(telegramId));
  return parseBalance(row?.balance);
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
