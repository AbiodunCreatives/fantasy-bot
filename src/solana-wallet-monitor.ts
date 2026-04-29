import { config } from "./config.ts";
import {
  processFantasyWalletWithdrawals,
  syncFantasyWalletDeposits,
} from "./solana-wallet.ts";
import { getDelayUntilNextAlignedTick } from "./utils/aligned-interval.ts";

let solanaWalletMonitorTimer: NodeJS.Timeout | null = null;
let solanaWalletMonitorRunning = false;
let solanaWalletMonitorInFlight = false;

async function runSolanaWalletMonitorTick(): Promise<void> {
  if (solanaWalletMonitorInFlight) {
    return;
  }

  solanaWalletMonitorInFlight = true;

  try {
    try {
      await syncFantasyWalletDeposits();
    } catch (error) {
      console.error("[solana-wallet] Deposit sync failed:", error);
    }

    try {
      await processFantasyWalletWithdrawals();
    } catch (error) {
      console.error("[solana-wallet] Withdrawal processing failed:", error);
    }
  } finally {
    solanaWalletMonitorInFlight = false;
  }
}

function scheduleNextSolanaWalletTick(): void {
  if (!solanaWalletMonitorRunning) {
    return;
  }

  const delayMs = getDelayUntilNextAlignedTick(
    config.SOLANA_WALLET_MONITOR_INTERVAL_MS
  );

  solanaWalletMonitorTimer = setTimeout(async () => {
    solanaWalletMonitorTimer = null;
    await runSolanaWalletMonitorTick();
    scheduleNextSolanaWalletTick();
  }, delayMs);
}

export function startSolanaWalletMonitor(): void {
  if (solanaWalletMonitorRunning) {
    return;
  }

  solanaWalletMonitorRunning = true;
  void runSolanaWalletMonitorTick();
  scheduleNextSolanaWalletTick();
  console.log(
    `[solana-wallet] Started on aligned ${config.SOLANA_WALLET_MONITOR_INTERVAL_MS}ms interval.`
  );
}

export function stopSolanaWalletMonitor(): void {
  solanaWalletMonitorRunning = false;

  if (!solanaWalletMonitorTimer) {
    return;
  }

  clearTimeout(solanaWalletMonitorTimer);
  solanaWalletMonitorTimer = null;
  console.log("[solana-wallet] Stopped.");
}
