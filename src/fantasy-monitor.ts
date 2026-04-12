import { getCurrentRound, getRoundPricing } from "./bayse-market.ts";
import { config } from "./config.ts";
import { FANTASY_ASSET, processFantasyLeagueRound } from "./fantasy-league.ts";

let fantasyMonitorTimer: NodeJS.Timeout | null = null;
let monitorInFlight = false;

async function runFantasyMonitorTick(): Promise<void> {
  if (monitorInFlight) {
    return;
  }

  monitorInFlight = true;

  try {
    const round = await getCurrentRound(FANTASY_ASSET);

    if (!round) {
      return;
    }

    const pricing = await getRoundPricing(round.slug);

    if (!pricing) {
      return;
    }

    await processFantasyLeagueRound(round, pricing);
  } catch (error) {
    console.error("[fantasy-monitor] Tick failed:", error);
  } finally {
    monitorInFlight = false;
  }
}

export function startFantasyMonitor(): void {
  if (fantasyMonitorTimer) {
    return;
  }

  fantasyMonitorTimer = setInterval(() => {
    void runFantasyMonitorTick();
  }, config.FANTASY_MONITOR_INTERVAL_MS);

  void runFantasyMonitorTick();
  console.log(
    `[fantasy-monitor] Started on ${config.FANTASY_MONITOR_INTERVAL_MS}ms interval.`
  );
}

export function stopFantasyMonitor(): void {
  if (!fantasyMonitorTimer) {
    return;
  }

  clearInterval(fantasyMonitorTimer);
  fantasyMonitorTimer = null;
  console.log("[fantasy-monitor] Stopped.");
}
