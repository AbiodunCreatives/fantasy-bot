import { supabase } from "./client.ts";

export interface FantasyWallet {
  telegram_id: number;
  chain: "solana";
  owner_address: string;
  usdc_ata: string;
  encrypted_secret_key: string;
  last_seen_usdc_balance_raw: bigint;
  created_at: string;
  updated_at: string;
}

export interface FantasyWalletLedgerEntry {
  id: string;
  telegram_id: number;
  entry_type: string;
  direction: "credit" | "debit";
  amount: number;
  asset: "USDC";
  status: "pending" | "confirmed" | "failed" | "cancelled";
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface FantasyWalletWithdrawal {
  id: string;
  telegram_id: number;
  destination_address: string;
  destination_usdc_ata: string | null;
  amount: number;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  tx_signature: string | null;
  failure_reason: string | null;
  requested_at: string;
  processed_at: string | null;
  completed_at: string | null;
}

interface FantasyWalletRow
  extends Omit<FantasyWallet, "last_seen_usdc_balance_raw"> {
  last_seen_usdc_balance_raw: number | string | null;
}

interface FantasyWalletLedgerRow
  extends Omit<FantasyWalletLedgerEntry, "amount" | "metadata"> {
  amount: number | string | null;
  metadata: Record<string, unknown> | null;
}

interface FantasyWalletWithdrawalRow
  extends Omit<FantasyWalletWithdrawal, "amount"> {
  amount: number | string | null;
}

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function parseAmount(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return roundUsdc(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? roundUsdc(parsed) : 0;
  }

  return 0;
}

function parseBigIntValue(value: number | string | null | undefined): bigint {
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string" && value.trim()) {
    return BigInt(value.trim());
  }

  return 0n;
}

function normalizeFantasyWallet(row: FantasyWalletRow): FantasyWallet {
  return {
    ...row,
    chain: "solana",
    last_seen_usdc_balance_raw: parseBigIntValue(row.last_seen_usdc_balance_raw),
  };
}

function normalizeFantasyWalletLedgerRow(
  row: FantasyWalletLedgerRow
): FantasyWalletLedgerEntry {
  return {
    ...row,
    direction: row.direction as FantasyWalletLedgerEntry["direction"],
    asset: "USDC",
    status: row.status as FantasyWalletLedgerEntry["status"],
    amount: parseAmount(row.amount),
    metadata: row.metadata ?? {},
  };
}

function normalizeFantasyWalletWithdrawalRow(
  row: FantasyWalletWithdrawalRow
): FantasyWalletWithdrawal {
  return {
    ...row,
    status: row.status as FantasyWalletWithdrawal["status"],
    amount: parseAmount(row.amount),
  };
}

function extractRpcSingleRow<T>(data: T | T[] | null | undefined): T | null {
  if (!data) {
    return null;
  }

  return Array.isArray(data) ? data[0] ?? null : data;
}

export async function getFantasyWalletByTelegramId(
  telegramId: number
): Promise<FantasyWallet | null> {
  const { data, error } = await supabase
    .from("fantasy_wallets")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeFantasyWallet(data as FantasyWalletRow) : null;
}

export async function listFantasyWallets(): Promise<FantasyWallet[]> {
  const { data, error } = await supabase
    .from("fantasy_wallets")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => normalizeFantasyWallet(row as FantasyWalletRow));
}

export async function createFantasyWalletRecord(input: {
  telegramId: number;
  ownerAddress: string;
  usdcAta: string;
  encryptedSecretKey: string;
}): Promise<FantasyWallet> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fantasy_wallets")
    .insert({
      telegram_id: input.telegramId,
      chain: "solana",
      owner_address: input.ownerAddress,
      usdc_ata: input.usdcAta,
      encrypted_secret_key: input.encryptedSecretKey,
      last_seen_usdc_balance_raw: "0",
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return normalizeFantasyWallet(data as FantasyWalletRow);
}

export async function updateFantasyWalletObservedBalance(input: {
  telegramId: number;
  rawBalance: bigint;
}): Promise<void> {
  const { error } = await supabase
    .from("fantasy_wallets")
    .update({
      last_seen_usdc_balance_raw: input.rawBalance.toString(),
      updated_at: new Date().toISOString(),
    })
    .eq("telegram_id", input.telegramId);

  if (error) {
    throw error;
  }
}

export async function recordSolanaWalletDepositDelta(input: {
  telegramId: number;
  walletAddress: string;
  usdcAta: string;
  previousRawBalance: bigint;
  newRawBalance: bigint;
  amount: number;
  amountRaw: bigint;
}): Promise<number> {
  const { data, error } = await supabase.rpc("record_solana_wallet_deposit_delta", {
    p_telegram_id: input.telegramId,
    p_wallet_address: input.walletAddress,
    p_usdc_ata: input.usdcAta,
    p_previous_raw_balance: input.previousRawBalance.toString(),
    p_new_raw_balance: input.newRawBalance.toString(),
    p_amount: roundUsdc(input.amount),
    p_amount_raw: input.amountRaw.toString(),
  });

  if (error) {
    throw error;
  }

  return parseAmount(data as number | string | null | undefined);
}

export async function requestSolanaWithdrawal(input: {
  telegramId: number;
  destinationAddress: string;
  amount: number;
}): Promise<FantasyWalletWithdrawal> {
  const { data, error } = await supabase.rpc("request_solana_withdrawal", {
    p_telegram_id: input.telegramId,
    p_destination_address: input.destinationAddress,
    p_amount: roundUsdc(input.amount),
  });

  if (error) {
    throw error;
  }

  const row = extractRpcSingleRow(
    data as FantasyWalletWithdrawalRow | FantasyWalletWithdrawalRow[] | null | undefined
  );

  if (!row) {
    throw new Error("Withdrawal request was not created.");
  }

  return normalizeFantasyWalletWithdrawalRow(row);
}

export async function listPendingFantasyWalletWithdrawals(
  limit = 25
): Promise<FantasyWalletWithdrawal[]> {
  const { data, error } = await supabase
    .from("fantasy_wallet_withdrawals")
    .select("*")
    .eq("status", "pending")
    .order("requested_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizeFantasyWalletWithdrawalRow(row as FantasyWalletWithdrawalRow)
  );
}

export async function listRecentFantasyWalletWithdrawals(
  telegramId: number,
  limit = 5
): Promise<FantasyWalletWithdrawal[]> {
  const { data, error } = await supabase
    .from("fantasy_wallet_withdrawals")
    .select("*")
    .eq("telegram_id", telegramId)
    .order("requested_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizeFantasyWalletWithdrawalRow(row as FantasyWalletWithdrawalRow)
  );
}

export async function listFantasyWalletLedger(
  telegramId: number,
  limit = 10
): Promise<FantasyWalletLedgerEntry[]> {
  const { data, error } = await supabase
    .from("fantasy_wallet_ledger")
    .select("*")
    .eq("telegram_id", telegramId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizeFantasyWalletLedgerRow(row as FantasyWalletLedgerRow)
  );
}

export async function markFantasyWalletWithdrawalProcessing(
  withdrawalId: string
): Promise<FantasyWalletWithdrawal | null> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("fantasy_wallet_withdrawals")
    .update({
      status: "processing",
      processed_at: now,
    })
    .eq("id", withdrawalId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const { error: ledgerError } = await supabase
    .from("fantasy_wallet_ledger")
    .update({ status: "pending" })
    .eq("reference_type", "solana_wallet_withdrawal")
    .eq("reference_id", withdrawalId);

  if (ledgerError) {
    throw ledgerError;
  }

  return normalizeFantasyWalletWithdrawalRow(data as FantasyWalletWithdrawalRow);
}

export async function completeFantasyWalletWithdrawal(input: {
  withdrawalId: string;
  txSignature: string;
  destinationUsdcAta: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("fantasy_wallet_withdrawals")
    .update({
      status: "completed",
      tx_signature: input.txSignature,
      destination_usdc_ata: input.destinationUsdcAta,
      completed_at: now,
    })
    .eq("id", input.withdrawalId);

  if (error) {
    throw error;
  }

  const { error: ledgerError } = await supabase
    .from("fantasy_wallet_ledger")
    .update({ status: "confirmed" })
    .eq("reference_type", "solana_wallet_withdrawal")
    .eq("reference_id", input.withdrawalId);

  if (ledgerError) {
    throw ledgerError;
  }
}

export async function failFantasyWalletWithdrawal(input: {
  withdrawalId: string;
  failureReason: string;
}): Promise<void> {
  const { error } = await supabase
    .from("fantasy_wallet_withdrawals")
    .update({
      status: "failed",
      failure_reason: input.failureReason,
    })
    .eq("id", input.withdrawalId);

  if (error) {
    throw error;
  }

  const { error: ledgerError } = await supabase
    .from("fantasy_wallet_ledger")
    .update({ status: "failed" })
    .eq("reference_type", "solana_wallet_withdrawal")
    .eq("reference_id", input.withdrawalId);

  if (ledgerError) {
    throw ledgerError;
  }
}
