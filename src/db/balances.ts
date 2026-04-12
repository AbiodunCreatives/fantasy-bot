import { supabase } from "./client.js";
import { upsertUserProfile } from "./users.js";

interface FantasyUserBalanceRow {
  telegram_id: number;
  wallet_balance: number | string | null;
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
  balanceBefore: number;
  balanceAfter: number;
}> {
  const normalizedDelta = roundMoney(input.delta);

  if (!Number.isFinite(normalizedDelta)) {
    throw new Error("Balance delta must be a finite number.");
  }

  await upsertUserProfile(input.telegramId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await getFantasyUserRow(String(input.telegramId));
    const balanceBefore = parseBalance(row?.wallet_balance);
    const balanceAfter = roundMoney(balanceBefore + normalizedDelta);

    if (!input.allowNegative && balanceAfter < 0) {
      return {
        success: false,
        balanceBefore,
        balanceAfter: balanceBefore,
      };
    }

    const { data, error } = await supabase
      .from("fantasy_users")
      .update({
        wallet_balance: balanceAfter,
        updated_at: new Date().toISOString(),
      })
      .eq("telegram_id", input.telegramId)
      .eq("wallet_balance", balanceBefore)
      .select("telegram_id");

    if (error) {
      throw error;
    }

    if ((data?.length ?? 0) > 0) {
      return {
        success: true,
        balanceBefore,
        balanceAfter,
      };
    }
  }

  throw new Error("Wallet balance update failed after multiple retries.");
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
