import type { Express } from "express";

import { config } from "./config.ts";

function getPublicBaseUrl(): string | null {
  const baseUrl = config.WEBHOOK_URL?.trim() ?? "";

  if (!baseUrl) {
    return null;
  }

  return baseUrl.replace(/\/+$/, "");
}

export function getBtcChartMenuUrl(): string | null {
  const baseUrl = getPublicBaseUrl();

  if (!baseUrl) {
    return null;
  }

  return `${baseUrl}/menu/btc-chart`;
}

function renderBtcChartMenuPage(): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    "<title>BTC 15m Chart</title>",
    "<style>",
    `
      :root {
        color-scheme: dark;
        --bg: #0b1220;
        --panel: rgba(12, 19, 34, 0.88);
        --text: #f5f7fb;
        --muted: #9aa8c7;
        --line: rgba(154, 168, 199, 0.18);
        --accent: #2ed3a7;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", Arial, sans-serif;
        background:
          radial-gradient(circle at top, rgba(46, 211, 167, 0.18), transparent 32%),
          linear-gradient(180deg, #09111d 0%, #050913 100%);
        color: var(--text);
      }

      main {
        width: min(1100px, 100%);
        margin: 0 auto;
        padding: 18px 14px 22px;
      }

      .hero {
        padding: 18px 18px 14px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        backdrop-filter: blur(18px);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
      }

      h1 {
        margin: 0 0 8px;
        font-size: clamp(1.7rem, 4vw, 2.6rem);
        line-height: 1;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        margin-bottom: 12px;
        border-radius: 999px;
        background: rgba(46, 211, 167, 0.12);
        color: var(--accent);
        font-size: 0.9rem;
        font-weight: 600;
      }

      .chart-shell {
        margin-top: 16px;
        border-radius: 24px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: rgba(5, 9, 19, 0.9);
      }

      .chart-frame {
        width: 100%;
        min-height: 72vh;
      }

      .footer {
        margin-top: 12px;
        font-size: 0.92rem;
        color: var(--muted);
      }

      a {
        color: var(--text);
      }
    `,
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    '<section class="hero">',
    '<div class="badge">Live BTC 15m market view</div>',
    "<h1>BTC / USD 15m Chart</h1>",
    "<p>Use this quick chart view from the Telegram menu while trading or watching HeadlineOdds Arena rounds.</p>",
    '<div class="chart-shell">',
    '<div class="tradingview-widget-container chart-frame">',
    '<div id="tradingview_btc_chart" class="chart-frame"></div>',
    '<div class="tradingview-widget-copyright footer"><a href="https://www.tradingview.com/symbols/BTCUSD/" rel="noopener noreferrer" target="_blank">View more BTC charts on TradingView</a></div>',
    "</div>",
    "</div>",
    "</section>",
    "</main>",
    '<script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>',
    "<script>",
    `
      if (typeof TradingView !== "undefined") {
        new TradingView.widget({
          autosize: true,
          symbol: "COINBASE:BTCUSD",
          interval: "15",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "en",
          enable_publishing: false,
          allow_symbol_change: false,
          hide_top_toolbar: false,
          withdateranges: true,
          save_image: false,
          container_id: "tradingview_btc_chart"
        });
      }
    `,
    "</script>",
    "</body>",
    "</html>",
  ].join("");
}

export function registerBtcChartMenuPage(app: Express): void {
  app.get("/menu/btc-chart", (_req, res) => {
    res
      .status(200)
      .type("html")
      .setHeader("Cache-Control", "public, max-age=300")
      .send(renderBtcChartMenuPage());
  });
}
