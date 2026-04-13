import { getCurrentRoundSnapshot } from "./bayse-market.ts";
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
    const snapshot = await getCurrentRoundSnapshot(FANTASY_ASSET);

    if (!snapshot) {
      return;
    }

    if (!snapshot.pricing) {
      console.warn(
        `[fantasy-monitor] Missing round pricing for ${snapshot.round.slug} (${snapshot.round.eventId}).`
      );
      return;
    }

    await processFantasyLeagueRound(snapshot.round, snapshot.pricing);
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
