import { config } from "./config.js";
import {
  activateDueFantasyGames,
  finalizeFantasyGames,
  settleFantasyLeagueTrades,
} from "./fantasy-league.js";

let fantasySettlementTimer: NodeJS.Timeout | null = null;
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

export function startFantasySettlementMonitor(): void {
  if (fantasySettlementTimer) {
    return;
  }

  fantasySettlementTimer = setInterval(() => {
    void runFantasySettlementTick();
  }, config.FANTASY_SETTLEMENT_INTERVAL_MS);

  void runFantasySettlementTick();
  console.log(
    `[fantasy-settlement] Started on ${config.FANTASY_SETTLEMENT_INTERVAL_MS}ms interval.`
  );
}

export function stopFantasySettlementMonitor(): void {
  if (!fantasySettlementTimer) {
    return;
  }

  clearInterval(fantasySettlementTimer);
  fantasySettlementTimer = null;
  console.log("[fantasy-settlement] Stopped.");
}
