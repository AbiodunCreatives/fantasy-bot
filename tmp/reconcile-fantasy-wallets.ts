import { supabase } from "../src/db/client.ts";

interface Args {
  telegramId?: number;
  reset: boolean;
  resetAll: boolean;
  yes: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const telegramIdArg = args.find((arg) => arg.startsWith("--telegram-id="));
  const reset = args.includes("--reset");
  const resetAll = args.includes("--reset-all");
  const yes = args.includes("--yes");

  return {
    telegramId: telegramIdArg ? Number.parseInt(telegramIdArg.split("=")[1], 10) : undefined,
    reset,
    resetAll,
    yes,
  };
}

function parseNumeric(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function parseBigInt(value: number | string | null | undefined): bigint {
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return BigInt(value.trim());
  }

  return 0n;
}

function formatAmount(value: number): string {
  return value.toFixed(6);
}

async function getUsers(): Promise<Array<{ telegram_id: number; wallet_balance: number }>> {
  const { data, error } = await supabase
    .from("fantasy_users")
    .select("telegram_id, wallet_balance")
    .order("wallet_balance", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    telegram_id: Number(row.telegram_id),
    wallet_balance: parseNumeric(row.wallet_balance),
  }));
}

async function getWalletDetails(telegramId: number) {
  const [{ data: wallet, error: walletError }, { data: ledger, error: ledgerError }] =
    await Promise.all([
      supabase
        .from("fantasy_wallets")
        .select("last_seen_usdc_balance_raw")
        .eq("telegram_id", telegramId)
        .maybeSingle(),
      supabase
        .from("fantasy_wallet_ledger")
        .select("direction, amount")
        .eq("telegram_id", telegramId),
    ]);

  if (walletError) {
    throw walletError;
  }

  if (ledgerError) {
    throw ledgerError;
  }

  const rawBalance = wallet ? parseBigInt((wallet as { last_seen_usdc_balance_raw: number | string | null }).last_seen_usdc_balance_raw) : 0n;
  const onChainBalance = Number(rawBalance) / 1_000_000;
  const ledgerEntries = ledger ?? [];
  const ledgerBalance = ledgerEntries.reduce((sum, entry) => {
    const amount = parseNumeric(entry.amount);
    return sum + (entry.direction === "credit" ? amount : -amount);
  }, 0);

  const { data: deposits, error: depositError } = await supabase
    .from("fantasy_wallet_deposits")
    .select("id")
    .eq("telegram_id", telegramId);

  if (depositError) {
    throw depositError;
  }

  return {
    onChainBalance,
    ledgerBalance,
    depositCount: (deposits ?? []).length,
  };
}

async function resetUserWallet(telegramId: number): Promise<void> {
  console.log(`Resetting wallet state for telegram_id=${telegramId} ...`);

  const deleteWallet = await supabase
    .from("fantasy_wallets")
    .delete()
    .eq("telegram_id", telegramId);
  if (deleteWallet.error) {
    throw deleteWallet.error;
  }

  const deleteDeposits = await supabase
    .from("fantasy_wallet_deposits")
    .delete()
    .eq("telegram_id", telegramId);
  if (deleteDeposits.error) {
    throw deleteDeposits.error;
  }

  const deleteLedger = await supabase
    .from("fantasy_wallet_ledger")
    .delete()
    .eq("telegram_id", telegramId);
  if (deleteLedger.error) {
    throw deleteLedger.error;
  }

  const resetBalance = await supabase
    .from("fantasy_users")
    .update({ wallet_balance: 0 })
    .eq("telegram_id", telegramId);
  if (resetBalance.error) {
    throw resetBalance.error;
  }

  console.log(`Wallet state reset for telegram_id=${telegramId}. A fresh wallet will be created when the user next interacts.`);
}

async function resetAllWalletState(): Promise<void> {
  console.log("Resetting all wallet state to zero...");

  const deleteDeposits = await supabase
    .from("fantasy_wallet_deposits")
    .delete()
    .neq("telegram_id", 0);
  if (deleteDeposits.error) {
    throw deleteDeposits.error;
  }

  const deleteLedger = await supabase
    .from("fantasy_wallet_ledger")
    .delete()
    .neq("telegram_id", 0);
  if (deleteLedger.error) {
    throw deleteLedger.error;
  }

  const resetWallets = await supabase
    .from("fantasy_wallets")
    .update({ last_seen_usdc_balance_raw: "0", updated_at: new Date().toISOString() })
    .neq("telegram_id", 0);
  if (resetWallets.error) {
    throw resetWallets.error;
  }

  const resetBalances = await supabase
    .from("fantasy_users")
    .update({ wallet_balance: 0, updated_at: new Date().toISOString() })
    .neq("telegram_id", 0);
  if (resetBalances.error) {
    throw resetBalances.error;
  }

  console.log("All wallet balances and deposit sync state have been reset.");
  console.log("Next time deposit sync runs, user balances will reflect true on-chain USDC deposits.");
}

async function main() {
  const args = parseArgs();

  if ((args.reset || args.resetAll) && !args.yes) {
    console.error("Error: --reset or --reset-all requires --yes to confirm destructive action.");
    process.exit(1);
  }

  if (args.resetAll) {
    await resetAllWalletState();
    return;
  }

  if (args.telegramId) {
    const users = await getUsers();
    const user = users.find((u) => u.telegram_id === args.telegramId);

    if (!user) {
      console.error(`User not found: telegram_id=${args.telegramId}`);
      process.exit(1);
    }

    const wallet = await getWalletDetails(args.telegramId);
    const diffDbLedger = user.wallet_balance - wallet.ledgerBalance;
    const diffDbOnChain = user.wallet_balance - wallet.onChainBalance;

    console.log(`telegram_id=${user.telegram_id}`);
    console.log(`  wallet_balance: ${formatAmount(user.wallet_balance)}`);
    console.log(`  ledger_balance: ${formatAmount(wallet.ledgerBalance)}`);
    console.log(`  on_chain_usdc: ${formatAmount(wallet.onChainBalance)}`);
    console.log(`  deposits_count: ${wallet.depositCount}`);
    console.log(`  diff(wallet_balance - ledger): ${formatAmount(diffDbLedger)}`);
    console.log(`  diff(wallet_balance - on_chain): ${formatAmount(diffDbOnChain)}`);

    if (args.reset) {
      await resetUserWallet(args.telegramId);
    }

    return;
  }

  const users = await getUsers();
  const results = await Promise.all(
    users.map(async (user) => {
      const wallet = await getWalletDetails(user.telegram_id);
      const diffDbLedger = user.wallet_balance - wallet.ledgerBalance;
      return {
        telegram_id: user.telegram_id,
        wallet_balance: user.wallet_balance,
        ledger_balance: wallet.ledgerBalance,
        on_chain_usdc: wallet.onChainBalance,
        deposit_count: wallet.depositCount,
        diff_db_ledger: diffDbLedger,
      };
    })
  );

  console.log("Mismatched users:");
  for (const row of results) {
    if (Math.abs(row.diff_db_ledger) >= 0.01) {
      console.log(
        `- ${row.telegram_id}: wallet_balance=${formatAmount(row.wallet_balance)}, ledger_balance=${formatAmount(row.ledger_balance)}, on_chain=${formatAmount(row.on_chain_usdc)}, diff_db_ledger=${formatAmount(row.diff_db_ledger)}, deposits=${row.deposit_count}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
