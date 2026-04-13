import { getCurrentRoundSnapshot } from "./bayse-market.ts";
import { config } from "./config.ts";
import { FANTASY_ASSET, processFantasyLeagueRound } from "./fantasy-league.ts";
import { getDelayUntilNextAlignedTick } from "./utils/aligned-interval.ts";

let fantasyMonitorTimer: NodeJS.Timeout | null = null;
let fantasyMonitorRunning = false;
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

function scheduleNextFantasyMonitorTick(): void {
  if (!fantasyMonitorRunning) {
    return;
  }

  const delayMs = getDelayUntilNextAlignedTick(config.FANTASY_MONITOR_INTERVAL_MS);

  fantasyMonitorTimer = setTimeout(async () => {
    fantasyMonitorTimer = null;
    await runFantasyMonitorTick();
    scheduleNextFantasyMonitorTick();
  }, delayMs);
}

export function startFantasyMonitor(): void {
  if (fantasyMonitorRunning) {
    return;
  }

  fantasyMonitorRunning = true;
  void runFantasyMonitorTick();
  scheduleNextFantasyMonitorTick();
  console.log(
    `[fantasy-monitor] Started on aligned ${config.FANTASY_MONITOR_INTERVAL_MS}ms interval.`
  );
}

export function stopFantasyMonitor(): void {
  fantasyMonitorRunning = false;

  if (!fantasyMonitorTimer) {
    return;
  }

  clearTimeout(fantasyMonitorTimer);
  fantasyMonitorTimer = null;
  console.log("[fantasy-monitor] Stopped.");
}
