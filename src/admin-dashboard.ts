import { createHash } from "crypto";

import type { Express, Request, Response } from "express";

import { config } from "./config.ts";
import {
  clampDashboardDays,
  getDashboardSummary,
  type DashboardSeriesPoint,
  type DashboardSummary,
} from "./db/dashboard.ts";
import { createRateLimitMiddleware } from "./http-security.ts";

const ADMIN_COOKIE_NAME = "fantasy_admin";
const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const DASHBOARD_CACHE_TTL_MS = 60_000;
const adminRouteRateLimit = createRateLimitMiddleware({
  keyPrefix: "admin-route",
  limit: 30,
  windowSeconds: 60,
  message: "Too many admin requests. Please wait a minute.",
});
const adminLoginRateLimit = createRateLimitMiddleware({
  keyPrefix: "admin-login",
  limit: 10,
  windowSeconds: 300,
  message: "Too many admin login attempts. Please wait a few minutes.",
});

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const wholeNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dashboardCache = new Map<
  number,
  { expiresAt: number; summary: DashboardSummary }
>();

function getAdminToken(): string {
  return config.ADMIN_DASHBOARD_TOKEN?.trim() ?? "";
}

function isDashboardEnabled(): boolean {
  return getAdminToken().length > 0;
}

function getCookieSessionValue(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();

    if (!key) {
      return cookies;
    }

    cookies[key] = decodeURIComponent(rawValue.join("=").trim());
    return cookies;
  }, {});
}

function getPresentedToken(req: Request): string | null {
  const authorization = (req.header("authorization") ?? "").trim();
  const headerToken = (req.header("x-admin-token") ?? "").trim();

  if (headerToken) {
    return headerToken;
  }

  if (authorization) {
    return authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : authorization;
  }

  return null;
}

function hasLegacyTokenQuery(req: Request): boolean {
  return typeof req.query["token"] === "string";
}

function getDashboardDays(req: Request): number {
  const rawDays =
    typeof req.query["days"] === "string"
      ? Number.parseInt(req.query["days"], 10)
      : undefined;

  return clampDashboardDays(rawDays);
}

function getPostedDashboardDays(req: Request): number {
  const rawDays =
    req.body && typeof req.body === "object" && "days" in req.body
      ? Number.parseInt(String(req.body["days"] ?? ""), 10)
      : undefined;

  return clampDashboardDays(rawDays);
}

function getPostedAdminToken(req: Request): string {
  if (!req.body || typeof req.body !== "object" || !("token" in req.body)) {
    return "";
  }

  const token = req.body["token"];
  return typeof token === "string" ? token.trim() : "";
}

function setAdminCookie(res: Response, token: string): void {
  const cookieParts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(getCookieSessionValue(token))}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`,
  ];

  if (config.NODE_ENV === "production") {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function clearAdminCookie(res: Response): void {
  const cookieParts = [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];

  if (config.NODE_ENV === "production") {
    cookieParts.push("Secure");
  }

  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function isAuthorized(req: Request): {
  allowed: boolean;
  shouldSetCookie: boolean;
} {
  const token = getAdminToken();

  if (!token) {
    return { allowed: false, shouldSetCookie: false };
  }

  const cookies = parseCookies(req.header("cookie"));
  const sessionCookie = cookies[ADMIN_COOKIE_NAME];

  if (sessionCookie && sessionCookie === getCookieSessionValue(token)) {
    return { allowed: true, shouldSetCookie: false };
  }

  const presentedToken = getPresentedToken(req);

  if (presentedToken && presentedToken === token) {
    return { allowed: true, shouldSetCookie: true };
  }

  return { allowed: false, shouldSetCookie: false };
}

function setNoStoreHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
}

async function loadDashboardSummary(days: number): Promise<DashboardSummary> {
  const cached = dashboardCache.get(days);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  const summary = await getDashboardSummary(days);
  dashboardCache.set(days, {
    summary,
    expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS,
  });

  return summary;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

function formatWholeNumber(value: number): string {
  return wholeNumberFormatter.format(value);
}

function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

function formatShortDate(value: string): string {
  return shortDateFormatter.format(new Date(value));
}

function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values, 0);
  const step = values.length > 1 ? width / (values.length - 1) : width;

  return values
    .map((value, index) => {
      const x = Number((index * step).toFixed(2));
      const y =
        max <= 0
          ? height / 2
          : Number((height - (value / max) * height).toFixed(2));

      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

function renderSparkline(values: number[], accentClass: string): string {
  if (values.length === 0) {
    return '<div class="sparkline-empty">No activity yet</div>';
  }

  const width = 240;
  const height = 72;
  const linePath = buildSparklinePath(values, width, height);
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;
  const lastValue = values[values.length - 1] ?? 0;
  const max = Math.max(...values, 0);
  const lastX = values.length > 1 ? width : 0;
  const lastY =
    max <= 0 ? height / 2 : Number((height - (lastValue / max) * height).toFixed(2));

  return [
    `<svg viewBox="0 0 ${width} ${height}" class="sparkline ${accentClass}" aria-hidden="true">`,
    `<path class="sparkline-area" d="${areaPath}" />`,
    `<path class="sparkline-line" d="${linePath}" />`,
    `<circle class="sparkline-dot" cx="${lastX}" cy="${lastY}" r="3.5" />`,
    "</svg>",
  ].join("");
}

function renderMetricCard(input: {
  label: string;
  value: string;
  detail: string;
  note: string;
  values: number[];
  accentClass: string;
}): string {
  return [
    `<article class="metric-card ${input.accentClass}">`,
    `<div class="metric-copy">`,
    `<p class="eyebrow">${escapeHtml(input.label)}</p>`,
    `<p class="metric-value">${escapeHtml(input.value)}</p>`,
    `<p class="metric-detail">${escapeHtml(input.detail)}</p>`,
    `<p class="metric-note">${escapeHtml(input.note)}</p>`,
    "</div>",
    renderSparkline(input.values, input.accentClass),
    "</article>",
  ].join("");
}

function renderRecentGames(summary: DashboardSummary): string {
  if (summary.recentGames.length === 0) {
    return [
      '<div class="empty-state">',
      "<h3>No arenas yet</h3>",
      "<p>The dashboard will start filling in once users create or join fantasy arenas.</p>",
      "</div>",
    ].join("");
  }

  return [
    '<div class="table-shell">',
    "<table>",
    "<thead><tr><th>Arena</th><th>Status</th><th>Entry</th><th>Prize Pool</th><th>Window</th><th>Created</th></tr></thead>",
    "<tbody>",
    ...summary.recentGames.map((game) => {
      const statusClass = `status-chip status-${game.status}`;
      return [
        "<tr>",
        `<td class="arena-code">${escapeHtml(game.code)}</td>`,
        `<td><span class="${statusClass}">${escapeHtml(game.status)}</span></td>`,
        `<td>${escapeHtml(formatCurrency(game.entryFee))}</td>`,
        `<td>${escapeHtml(formatCurrency(game.prizePool))}</td>`,
        `<td>${escapeHtml(formatShortDate(game.startAt))} - ${escapeHtml(formatShortDate(game.endAt))}</td>`,
        `<td>${escapeHtml(formatTimestamp(game.createdAt))}</td>`,
        "</tr>",
      ].join("");
    }),
    "</tbody>",
    "</table>",
    "</div>",
  ].join("");
}

function renderDashboardPage(summary: DashboardSummary): string {
  const days = summary.days;
  const primaryMetrics = [
    {
      label: "Users",
      value: formatWholeNumber(summary.totals.totalUsers),
      detail: `+${formatWholeNumber(summary.range.newUsers)} new in the last ${days} days`,
      note: `${formatWholeNumber(summary.totals.activeUsers30d)} active in 30 days`,
      values: summary.series.map((point) => point.newUsers),
      accentClass: "accent-plum",
    },
    {
      label: "Confirmed Deposits",
      value: formatCurrency(summary.totals.totalDeposits),
      detail: `${formatCurrency(summary.range.deposits)} credited in the last ${days} days`,
      note: "On-chain USDC deposits only",
      values: summary.series.map((point) => point.deposits),
      accentClass: "accent-teal",
    },
    {
      label: "Total Value Processed",
      value: formatCurrency(summary.totals.totalValueProcessed),
      detail: `${formatCurrency(summary.range.valueProcessed)} in entry volume over ${days} days`,
      note: "Defined here as paid arena entry volume",
      values: summary.series.map((point) => point.entryVolume),
      accentClass: "accent-amber",
    },
    {
      label: "Platform Revenue",
      value: formatCurrency(summary.totals.totalPlatformRevenue),
      detail: `${formatCurrency(summary.range.platformRevenue)} realized over ${days} days`,
      note: "Commission recorded when arenas settle",
      values: summary.series.map((point) => point.platformRevenue),
      accentClass: "accent-green",
    },
  ];

  const rangeLinks = [7, 30, 90, 180].map((value) => {
    const className = value === days ? "range-link is-active" : "range-link";
    return `<a class="${className}" href="/admin/dashboard?days=${value}">${value}d</a>`;
  });

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Fantasy Bot Dashboard</title>",
    "<style>",
    `
      :root {
        color-scheme: light dark;
        --paper: #f5efe3;
        --paper-alt: #fffaf1;
        --card: rgba(255, 250, 241, 0.82);
        --card-strong: rgba(255, 250, 241, 0.96);
        --ink: #211d18;
        --muted: #6f6658;
        --line: rgba(33, 29, 24, 0.12);
        --shadow: 0 18px 50px rgba(36, 28, 16, 0.08);
        --teal: #176b63;
        --amber: #a35a17;
        --green: #2e6e41;
        --plum: #6d3d62;
        --status-open: #8d5e17;
        --status-active: #176b63;
        --status-completed: #2e6e41;
        --status-cancelled: #9c3d3d;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --paper: #171411;
          --paper-alt: #1d1914;
          --card: rgba(32, 27, 22, 0.88);
          --card-strong: rgba(32, 27, 22, 0.98);
          --ink: #f3ecdf;
          --muted: #b4a898;
          --line: rgba(243, 236, 223, 0.12);
          --shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
        }
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "Segoe UI", "Avenir Next", Arial, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(23, 107, 99, 0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(163, 90, 23, 0.14), transparent 30%),
          linear-gradient(180deg, var(--paper-alt), var(--paper));
        color: var(--ink);
      }

      a, button {
        color: inherit;
      }

      .shell {
        max-width: 1280px;
        margin: 0 auto;
        padding: 32px 16px 56px;
      }

      .hero,
      .metric-card,
      .panel,
      .table-panel {
        border: 1px solid var(--line);
        background: var(--card);
        backdrop-filter: blur(18px);
        box-shadow: var(--shadow);
      }

      .hero {
        border-radius: 28px;
        padding: 28px;
        display: grid;
        gap: 24px;
      }

      .hero-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }

      .hero h1,
      .metric-value,
      .summary-value {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        letter-spacing: -0.03em;
      }

      .hero h1 {
        font-size: clamp(2.4rem, 5vw, 4.5rem);
        line-height: 0.95;
      }

      .hero p {
        margin: 0;
        max-width: 65ch;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.55;
      }

      .hero-meta {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }

      .badge,
      .range-link,
      .logout-button {
        min-height: 40px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.08);
        padding: 0 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        font-size: 0.95rem;
      }

      .range-link:focus-visible,
      .logout-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(23, 107, 99, 0.28);
      }

      .range-link.is-active {
        border-color: rgba(23, 107, 99, 0.45);
        background: rgba(23, 107, 99, 0.12);
      }

      .logout-button {
        cursor: pointer;
      }

      .hero-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      .metric-grid {
        margin-top: 22px;
        display: grid;
        gap: 16px;
      }

      .metric-grid-primary {
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }

      .metric-grid-secondary {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }

      .metric-card,
      .panel,
      .table-panel {
        border-radius: 24px;
      }

      .metric-card {
        padding: 22px;
        display: grid;
        gap: 18px;
      }

      .eyebrow {
        margin: 0 0 8px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 0.76rem;
        color: var(--muted);
      }

      .metric-value {
        font-size: clamp(2rem, 5vw, 3.2rem);
        line-height: 0.92;
      }

      .metric-detail,
      .metric-note,
      .summary-label,
      .summary-note,
      .definition-copy,
      .sparkline-empty,
      td,
      th {
        color: var(--muted);
      }

      .metric-detail,
      .metric-note {
        margin: 8px 0 0;
        line-height: 1.45;
      }

      .metric-note {
        font-size: 0.92rem;
      }

      .sparkline {
        width: 100%;
        height: 84px;
        display: block;
      }

      .sparkline-area {
        fill: currentColor;
        opacity: 0.12;
      }

      .sparkline-line {
        fill: none;
        stroke: currentColor;
        stroke-width: 2.2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .sparkline-dot {
        fill: currentColor;
      }

      .accent-teal { color: var(--teal); }
      .accent-amber { color: var(--amber); }
      .accent-green { color: var(--green); }
      .accent-plum { color: var(--plum); }

      .summary-section {
        margin-top: 22px;
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.9fr);
      }

      .panel,
      .table-panel {
        padding: 24px;
      }

      .panel h2,
      .table-panel h2 {
        margin: 0 0 6px;
        font-size: 1.2rem;
      }

      .panel p,
      .table-panel p {
        margin: 0;
        line-height: 1.5;
      }

      .summary-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        margin-top: 20px;
      }

      .summary-tile {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: var(--card-strong);
      }

      .summary-value {
        font-size: 2rem;
        line-height: 0.98;
        margin-bottom: 6px;
      }

      .summary-label,
      .summary-note {
        margin: 0;
        line-height: 1.4;
      }

      .summary-note {
        font-size: 0.88rem;
      }

      .definitions {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }

      .definition {
        padding: 14px 0;
        border-top: 1px solid var(--line);
      }

      .definition:first-child {
        border-top: 0;
        padding-top: 0;
      }

      .definition h3 {
        margin: 0 0 4px;
        font-size: 0.98rem;
      }

      .definition-copy {
        margin: 0;
        line-height: 1.5;
      }

      .table-panel {
        margin-top: 22px;
      }

      .table-shell {
        overflow-x: auto;
        margin-top: 18px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 720px;
      }

      th,
      td {
        padding: 14px 10px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        font-size: 0.96rem;
      }

      th {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.72rem;
      }

      .arena-code {
        color: var(--ink);
        font-weight: 700;
      }

      .status-chip {
        min-height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 10px;
        border-radius: 999px;
        font-size: 0.8rem;
        text-transform: capitalize;
        border: 1px solid currentColor;
      }

      .status-open { color: var(--status-open); }
      .status-active { color: var(--status-active); }
      .status-completed { color: var(--status-completed); }
      .status-cancelled { color: var(--status-cancelled); }

      .empty-state {
        margin-top: 18px;
        padding: 22px;
        border: 1px dashed var(--line);
        border-radius: 18px;
        background: var(--card-strong);
      }

      .empty-state h3 {
        margin: 0 0 6px;
      }

      .empty-state p {
        margin: 0;
      }

      @media (max-width: 960px) {
        .summary-section {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 768px) {
        .shell {
          padding: 20px 12px 36px;
        }

        .hero,
        .panel,
        .table-panel,
        .metric-card {
          border-radius: 20px;
        }

        .hero {
          padding: 22px;
        }
      }
    `,
    "</style>",
    "</head>",
    "<body>",
    '<main class="shell">',
    '<section class="hero">',
    '<div class="hero-top">',
    "<div>",
    "<p class=\"eyebrow\">Bayse Fantasy Operator View</p>",
    "<h1>Users, value flow, and revenue in one place.</h1>",
    `<p>Generated ${escapeHtml(formatTimestamp(summary.generatedAt))}. This view separates cash in, gameplay volume, and realized platform revenue so the numbers stay honest as the bot scales.</p>`,
    "</div>",
    '<div class="hero-actions">',
    ...rangeLinks,
    `<span class="badge">${escapeHtml(formatWholeNumber(summary.totals.activeUsers7d))} active in 7d</span>`,
    '<form action="/admin/logout" method="post"><button class="logout-button" type="submit">Log out</button></form>',
    "</div>",
    "</div>",
    "</section>",
    '<section class="metric-grid metric-grid-primary">',
    ...primaryMetrics.map(renderMetricCard),
    "</section>",
    '<section class="summary-section">',
    '<article class="panel">',
    "<h2>Operating Snapshot</h2>",
    "<p>These are the balances and queue counts you will likely check day to day while running the bot.</p>",
    '<div class="summary-grid">',
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatCurrency(summary.totals.liveUserBalances))}</p><p class="summary-label">Live user balances</p><p class="summary-note">Current internal USDC liability</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatCurrency(summary.totals.totalPrizePayouts))}</p><p class="summary-label">Prize payouts</p><p class="summary-note">All-time credits awarded to winners</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatCurrency(summary.totals.totalCompletedWithdrawals))}</p><p class="summary-label">Completed withdrawals</p><p class="summary-note">${escapeHtml(formatCurrency(summary.range.completedWithdrawals))} sent in ${days}d</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatWholeNumber(summary.operations.withdrawalsInFlight))}</p><p class="summary-label">Withdrawals in flight</p><p class="summary-note">Pending or processing payouts</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatWholeNumber(summary.operations.openGames))}</p><p class="summary-label">Open arenas</p><p class="summary-note">Waiting for start time</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatWholeNumber(summary.operations.activeGames))}</p><p class="summary-label">Active arenas</p><p class="summary-note">Still trading live</p></div>`,
    `<div class="summary-tile"><p class="summary-value">${escapeHtml(formatWholeNumber(summary.operations.completedGames))}</p><p class="summary-label">Completed arenas</p><p class="summary-note">Settled and closed</p></div>`,
    "</div>",
    "</article>",
    '<aside class="panel">',
    "<h2>Metric Definitions</h2>",
    "<p>Three financial numbers matter here, and they are intentionally different.</p>",
    '<div class="definitions">',
    '<div class="definition"><h3>Confirmed Deposits</h3><p class="definition-copy">External USDC that hit user deposit wallets and was credited internally. This is your cleanest cash-in view.</p></div>',
    '<div class="definition"><h3>Total Value Processed</h3><p class="definition-copy">Current dashboard definition: total paid arena entry volume. It shows how much value players actually put through gameplay, not just into custody.</p></div>',
    '<div class="definition"><h3>Platform Revenue</h3><p class="definition-copy">Realized commission rows from <code>fantasy_revenue</code>. Because the bot records commission at settlement, this is earned revenue, not an estimate.</p></div>',
    "</div>",
    "</aside>",
    "</section>",
    '<section class="table-panel">',
    "<h2>Recent Arenas</h2>",
    "<p>The latest arena windows with their entry economics and settlement status.</p>",
    renderRecentGames(summary),
    "</section>",
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function renderUnauthorizedPage(input: {
  days: number;
  invalidCredentials?: boolean;
}): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Dashboard Locked</title>",
    "<style>",
    `
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", Arial, sans-serif;
        background: linear-gradient(180deg, #f6efe3, #efe6d5);
        color: #211d18;
      }

      .card {
        max-width: 620px;
        padding: 28px;
        border-radius: 24px;
        background: rgba(255, 251, 245, 0.92);
        border: 1px solid rgba(33, 29, 24, 0.12);
        box-shadow: 0 18px 50px rgba(36, 28, 16, 0.08);
      }

      h1 {
        margin: 0 0 10px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: clamp(2rem, 5vw, 3.2rem);
        line-height: 0.95;
      }

      p {
        margin: 0 0 12px;
        line-height: 1.55;
      }

      code {
        background: rgba(33, 29, 24, 0.06);
        padding: 2px 6px;
        border-radius: 999px;
      }

      form {
        display: grid;
        gap: 12px;
        margin-top: 18px;
      }

      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(33, 29, 24, 0.18);
        background: rgba(255, 255, 255, 0.8);
        font: inherit;
        box-sizing: border-box;
      }

      button {
        width: fit-content;
        padding: 12px 16px;
        border: 0;
        border-radius: 999px;
        background: #211d18;
        color: #fff;
        font: inherit;
        cursor: pointer;
      }

      .error {
        color: #8f2d1f;
        font-weight: 600;
      }
    `,
    "</style>",
    "</head>",
    "<body>",
    '<section class="card">',
    "<h1>Admin dashboard is locked.</h1>",
    input.invalidCredentials
      ? '<p class="error">That admin token was rejected. Please try again.</p>'
      : "<p>Sign in with your admin token to start a short-lived browser session.</p>",
    "<p>For scripts and API clients, send <code>x-admin-token</code> or <code>Authorization: Bearer ...</code>.</p>",
    '<form method="post" action="/admin/login">',
    `<input type="hidden" name="days" value="${input.days}" />`,
    '<label for="token">Admin token</label>',
    '<input id="token" name="token" type="password" autocomplete="current-password" required />',
    '<button type="submit">Open dashboard</button>',
    "</form>",
    "</section>",
    "</body>",
    "</html>",
  ].join("");
}

function renderDashboardErrorPage(days: number): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>Dashboard Error</title>",
    "</head>",
    "<body>",
    "<main style=\"font-family: Arial, sans-serif; padding: 24px;\">",
    "<h1>Dashboard data is unavailable right now.</h1>",
    `<p><a href="/admin/dashboard?days=${days}">Retry the dashboard</a></p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

export function registerAdminDashboard(app: Express): void {
  app.get("/admin/dashboard", adminRouteRateLimit, async (req, res) => {
    if (!isDashboardEnabled()) {
      res.sendStatus(404);
      return;
    }

    const days = getDashboardDays(req);
    setNoStoreHeaders(res);

    if (hasLegacyTokenQuery(req)) {
      res.redirect(`/admin/dashboard?days=${days}`);
      return;
    }

    const access = isAuthorized(req);

    if (!access.allowed) {
      res.status(401).type("html").send(
        renderUnauthorizedPage({
          days,
        })
      );
      return;
    }

    if (access.shouldSetCookie) {
      setAdminCookie(res, getAdminToken());
    }

    try {
      const summary = await loadDashboardSummary(days);
      res.status(200).type("html").send(renderDashboardPage(summary));
    } catch (error) {
      console.error("[dashboard] Failed to render dashboard:", error);
      res.status(500).type("html").send(renderDashboardErrorPage(days));
    }
  });

  app.post("/admin/login", adminLoginRateLimit, (req, res) => {
    if (!isDashboardEnabled()) {
      res.sendStatus(404);
      return;
    }

    const days = getPostedDashboardDays(req);
    const token = getPostedAdminToken(req);
    setNoStoreHeaders(res);

    if (!token || token !== getAdminToken()) {
      clearAdminCookie(res);
      res.status(401).type("html").send(
        renderUnauthorizedPage({
          days,
          invalidCredentials: true,
        })
      );
      return;
    }

    setAdminCookie(res, token);
    res.status(303).setHeader("Location", `/admin/dashboard?days=${days}`).end();
  });

  app.get("/admin/api/dashboard", adminRouteRateLimit, async (req, res) => {
    if (!isDashboardEnabled()) {
      res.sendStatus(404);
      return;
    }

    const access = isAuthorized(req);
    setNoStoreHeaders(res);

    if (!access.allowed) {
      res.status(401).json({
        error: "Admin authentication required.",
      });
      return;
    }

    if (access.shouldSetCookie) {
      setAdminCookie(res, getAdminToken());
    }

    try {
      const summary = await loadDashboardSummary(getDashboardDays(req));
      res.json(summary);
    } catch (error) {
      console.error("[dashboard] Failed to load API summary:", error);
      res.status(500).json({
        error: "Dashboard metrics unavailable right now.",
      });
    }
  });

  app.post("/admin/logout", adminRouteRateLimit, (_req, res) => {
    setNoStoreHeaders(res);
    clearAdminCookie(res);
    res.status(303).setHeader("Location", "/admin/dashboard").end();
  });
}
