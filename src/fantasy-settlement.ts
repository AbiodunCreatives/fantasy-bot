import { config } from "./config.ts";
import {
  activateDueFantasyGames,
  finalizeFantasyGames,
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

  try {
    try {
      await activateDueFantasyGames();
    } catch (error) {
      console.error("[fantasy-settlement] Activation pass failed:", error);
    }

    try {
      await settleFantasyLeagueTrades();
    } catch (error) {
      console.error("[fantasy-settlement] Settlement pass failed:", error);
    }

    try {
      await finalizeFantasyGames();
    } catch (error) {
      console.error("[fantasy-settlement] Finalization pass failed:", error);
    }
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
