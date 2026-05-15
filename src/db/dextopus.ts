import { supabase } from "./client.ts";

export interface DextopusDeposit {
  id: string;
  telegram_id: number;
  deposit_request_id: string;
  deposit_address: string;
  origin_chain_id: string;
  origin_asset: string;
  origin_symbol: string;
  destination_usdc_amount: number; // expected USDC out
  status: "pending" | "completed" | "failed" | "expired";
  execution_status: string | null;
  origin_tx_hash: string | null;
  destination_tx_hash: string | null;
  credited: boolean;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface DextopusDepositRow
  extends Omit<DextopusDeposit, "destination_usdc_amount"> {
  destination_usdc_amount: number | string | null;
}

function parseAmount(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function rowToDeposit(row: DextopusDepositRow): DextopusDeposit {
  return {
    ...row,
    destination_usdc_amount: parseAmount(row.destination_usdc_amount),
  };
}

export async function createDextopusDepositRecord(params: {
  telegramId: number;
  depositRequestId: string;
  depositAddress: string;
  originChainId: string;
  originAsset: string;
  originSymbol: string;
  destinationUsdcAmount: number;
  expiresInSeconds: number;
}): Promise<DextopusDeposit> {
  const expiresAt = new Date(
    Date.now() + params.expiresInSeconds * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("fantasy_dextopus_deposits")
    .insert({
      telegram_id: params.telegramId,
      deposit_request_id: params.depositRequestId,
      deposit_address: params.depositAddress,
      origin_chain_id: params.originChainId,
      origin_asset: params.originAsset,
      origin_symbol: params.originSymbol,
      destination_usdc_amount: params.destinationUsdcAmount,
      status: "pending",
      execution_status: null,
      origin_tx_hash: null,
      destination_tx_hash: null,
      credited: false,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw new Error(`createDextopusDepositRecord: ${error.message}`);
  return rowToDeposit(data as DextopusDepositRow);
}

export async function listPendingDextopusDeposits(): Promise<
  DextopusDeposit[]
> {
  const { data, error } = await supabase
    .from("fantasy_dextopus_deposits")
    .select("*")
    .eq("status", "pending")
    .eq("credited", false)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`listPendingDextopusDeposits: ${error.message}`);
  return (data as DextopusDepositRow[]).map(rowToDeposit);
}

export async function updateDextopusDepositStatus(
  depositRequestId: string,
  update: {
    status?: DextopusDeposit["status"];
    executionStatus?: string;
    originTxHash?: string;
    destinationTxHash?: string;
    credited?: boolean;
  }
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (update.status !== undefined) patch["status"] = update.status;
  if (update.executionStatus !== undefined)
    patch["execution_status"] = update.executionStatus;
  if (update.originTxHash !== undefined)
    patch["origin_tx_hash"] = update.originTxHash;
  if (update.destinationTxHash !== undefined)
    patch["destination_tx_hash"] = update.destinationTxHash;
  if (update.credited !== undefined) patch["credited"] = update.credited;

  const { error } = await supabase
    .from("fantasy_dextopus_deposits")
    .update(patch)
    .eq("deposit_request_id", depositRequestId);

  if (error)
    throw new Error(`updateDextopusDepositStatus: ${error.message}`);
}

export async function getDextopusDepositByRequestId(
  depositRequestId: string
): Promise<DextopusDeposit | null> {
  const { data, error } = await supabase
    .from("fantasy_dextopus_deposits")
    .select("*")
    .eq("deposit_request_id", depositRequestId)
    .maybeSingle();

  if (error)
    throw new Error(`getDextopusDepositByRequestId: ${error.message}`);
  if (!data) return null;
  return rowToDeposit(data as DextopusDepositRow);
}

export async function listRecentDextopusDeposits(
  telegramId: number,
  limit = 5
): Promise<DextopusDeposit[]> {
  const { data, error } = await supabase
    .from("fantasy_dextopus_deposits")
    .select("*")
    .eq("telegram_id", telegramId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error)
    throw new Error(`listRecentDextopusDeposits: ${error.message}`);
  return (data as DextopusDepositRow[]).map(rowToDeposit);
}
