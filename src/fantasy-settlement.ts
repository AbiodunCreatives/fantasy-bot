import { config } from "./config.ts";
import {
  activateDueFantasyGames,
  finalizeFantasyGames,
  processPendingRefunds,
  sendFantasyRoundReengagements,
  settleFantasyLeagueTrades,
} from "./fantasy-league.ts";
import { getDelayUntilNextAlignedTick } from "./utils/aligned-interval.ts";

let fantasySettlementTimer: NodeJS.Timeout | null = null;
let fantasySettlementRunning = false;
let settlementInFlight = false;

async function runFantasySettlementTick(): Promise<void> {
  if (settlementInFlight) {
    return;
  }

  settlementInFlight = true;

  // Watchdog: timeout after 60 seconds (settlement can be more complex)
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Fantasy settlement tick timed out after 60 seconds')), 60000);
  });

  try {
    await Promise.race([
      (async () => {
        try {
          await activateDueFantasyGames();
        } catch (error) {
          console.error("[fantasy-settlement] Activation pass failed:", error);
        }

        try {
          const settledRounds = await settleFantasyLeagueTrades();
          await sendFantasyRoundReengagements(settledRounds);
        } catch (error) {
          console.error("[fantasy-settlement] Settlement pass failed:", error);
        }

        try {
          await finalizeFantasyGames();
        } catch (error) {
          console.error("[fantasy-settlement] Finalization pass failed:", error);
        }

        try {
          await processPendingRefunds();
        } catch (error) {
          console.error("[fantasy-settlement] Pending refunds pass failed:", error);
        }
      })(),
      timeoutPromise
    ]);
  } finally {
    settlementInFlight = false;
  }
}

function scheduleNextFantasySettlementTick(): void {
  if (!fantasySettlementRunning) {
    return;
  }

  const delayMs = getDelayUntilNextAlignedTick(
    config.FANTASY_SETTLEMENT_INTERVAL_MS
  );

  fantasySettlementTimer = setTimeout(async () => {
    fantasySettlementTimer = null;
    await runFantasySettlementTick();
    scheduleNextFantasySettlementTick();
  }, delayMs);
}

export function startFantasySettlementMonitor(): void {
  if (fantasySettlementRunning) {
    return;
  }

  fantasySettlementRunning = true;
  void runFantasySettlementTick();
  scheduleNextFantasySettlementTick();
  console.log(
    `[fantasy-settlement] Started on aligned ${config.FANTASY_SETTLEMENT_INTERVAL_MS}ms interval.`
  );
}

export function stopFantasySettlementMonitor(): void {
  fantasySettlementRunning = false;

  if (!fantasySettlementTimer) {
    return;
  }

  clearTimeout(fantasySettlementTimer);
  fantasySettlementTimer = null;
  console.log("[fantasy-settlement] Stopped.");
}
