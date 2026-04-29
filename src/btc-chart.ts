import { createCanvas } from "@napi-rs/canvas";

const BINANCE_BTC_KLINES_URL =
  "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=48";
const BTC_CHART_CACHE_TTL_MS = 60_000;
const BTC_CHART_WIDTH = 800;
const BTC_CHART_HEIGHT = 400;
const BTC_CHART_BACKGROUND = "#1a1a2e";
const BTC_CHART_UP_COLOR = "#00ff88";
const BTC_CHART_DOWN_COLOR = "#ff4444";
const BTC_CHART_TEXT_COLOR = "#ffffff";
const BTC_CHART_MUTED_TEXT_COLOR = "#aab2d5";
const BTC_CHART_GRID_COLOR = "rgba(255, 255, 255, 0.08)";

interface BinanceKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CachedBtcChart {
  buffer: Buffer;
  currentPrice: number;
  updatedAt: number;
}

export interface BtcChartImage {
  buffer: Buffer;
  currentPrice: number;
  updatedAt: number;
}

interface ChartFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  priceHeight: number;
  volumeTop: number;
  volumeHeight: number;
}

let cachedBtcChart: CachedBtcChart | null = null;

function parseBinanceNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Binance returned an invalid ${fieldName}.`);
}

function formatChartTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

function formatUsdPrice(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function getCandleColor(candle: Pick<BinanceKline, "open" | "close">): string {
  return candle.close >= candle.open ? BTC_CHART_UP_COLOR : BTC_CHART_DOWN_COLOR;
}

function getVolumeColor(candle: Pick<BinanceKline, "open" | "close">): string {
  return candle.close >= candle.open
    ? "rgba(0, 255, 136, 0.28)"
    : "rgba(255, 68, 68, 0.28)";
}

function getChartFrame(): ChartFrame {
  return {
    left: 64,
    right: BTC_CHART_WIDTH - 736,
    top: 58,
    bottom: BTC_CHART_HEIGHT - 362,
    width: 800 - 64 - (800 - 736),
    priceHeight: 232,
    volumeTop: 302,
    volumeHeight: 52,
  };
}

function mapPriceToY(
  price: number,
  minPrice: number,
  maxPrice: number,
  frame: ChartFrame
): number {
  const range = Math.max(maxPrice - minPrice, 1);
  const pct = (maxPrice - price) / range;
  return frame.top + pct * frame.priceHeight;
}

function drawBackground(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>
): void {
  ctx.fillStyle = BTC_CHART_BACKGROUND;
  ctx.fillRect(0, 0, BTC_CHART_WIDTH, BTC_CHART_HEIGHT);
}

function drawTitle(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>
): void {
  ctx.fillStyle = BTC_CHART_TEXT_COLOR;
  ctx.font = "bold 22px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BTC/USDT 15m", BTC_CHART_WIDTH / 2, 28);
}

function drawPriceGrid(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  minPrice: number,
  maxPrice: number,
  frame: ChartFrame
): void {
  const tickCount = 5;
  const range = maxPrice - minPrice;

  ctx.save();
  ctx.strokeStyle = BTC_CHART_GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.font = "12px Arial";
  ctx.fillStyle = BTC_CHART_MUTED_TEXT_COLOR;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let index = 0; index < tickCount; index += 1) {
    const ratio = index / (tickCount - 1);
    const price = maxPrice - range * ratio;
    const y = frame.top + frame.priceHeight * ratio;

    ctx.beginPath();
    ctx.moveTo(frame.left, y);
    ctx.lineTo(frame.left + frame.width, y);
    ctx.stroke();
    ctx.fillText(
      `$${Math.round(price).toLocaleString("en-US")}`,
      frame.left + frame.width + 52,
      y
    );
  }

  ctx.restore();
}

function drawVolumeDivider(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  frame: ChartFrame
): void {
  ctx.save();
  ctx.strokeStyle = BTC_CHART_GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(frame.left, frame.volumeTop - 10);
  ctx.lineTo(frame.left + frame.width, frame.volumeTop - 10);
  ctx.stroke();
  ctx.restore();
}

function drawCandles(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  candles: BinanceKline[],
  minPrice: number,
  maxPrice: number,
  frame: ChartFrame
): void {
  const step = frame.width / candles.length;
  const candleWidth = Math.max(4, step * 0.58);

  ctx.save();
  ctx.lineWidth = 1.5;

  candles.forEach((candle, index) => {
    const centerX = frame.left + index * step + step / 2;
    const openY = mapPriceToY(candle.open, minPrice, maxPrice, frame);
    const closeY = mapPriceToY(candle.close, minPrice, maxPrice, frame);
    const highY = mapPriceToY(candle.high, minPrice, maxPrice, frame);
    const lowY = mapPriceToY(candle.low, minPrice, maxPrice, frame);
    const color = getCandleColor(candle);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(closeY - openY), 2);

    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(centerX, highY);
    ctx.lineTo(centerX, lowY);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fillRect(centerX - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
  });

  ctx.restore();
}

function drawVolumeBars(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  candles: BinanceKline[],
  frame: ChartFrame
): void {
  const step = frame.width / candles.length;
  const barWidth = Math.max(4, step * 0.58);
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);

  ctx.save();

  candles.forEach((candle, index) => {
    const centerX = frame.left + index * step + step / 2;
    const barHeight = (candle.volume / maxVolume) * frame.volumeHeight;

    ctx.fillStyle = getVolumeColor(candle);
    ctx.fillRect(
      centerX - barWidth / 2,
      frame.volumeTop + frame.volumeHeight - barHeight,
      barWidth,
      barHeight
    );
  });

  ctx.restore();
}

function drawXAxisLabels(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  candles: BinanceKline[],
  frame: ChartFrame
): void {
  const step = frame.width / candles.length;
  const labelEvery = Math.max(1, Math.floor(candles.length / 8));

  ctx.save();
  ctx.font = "12px Arial";
  ctx.fillStyle = BTC_CHART_MUTED_TEXT_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  candles.forEach((candle, index) => {
    if (index % labelEvery !== 0 && index !== candles.length - 1) {
      return;
    }

    const centerX = frame.left + index * step + step / 2;
    ctx.fillText(
      formatChartTimeLabel(candle.openTime),
      centerX,
      frame.volumeTop + frame.volumeHeight + 10
    );
  });

  ctx.restore();
}

function drawVolumeLabel(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  frame: ChartFrame
): void {
  ctx.save();
  ctx.font = "12px Arial";
  ctx.fillStyle = BTC_CHART_MUTED_TEXT_COLOR;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("Volume", frame.left, frame.volumeTop - 20);
  ctx.restore();
}

async function fetchBtcChartKlines(): Promise<BinanceKline[]> {
  const response = await fetch(BINANCE_BTC_KLINES_URL, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Binance klines API ${response.status}: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as unknown;

  if (!Array.isArray(payload)) {
    throw new Error("Binance klines response was not an array.");
  }

  return payload.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 7) {
      throw new Error(`Binance returned an invalid kline row at index ${index}.`);
    }

    return {
      openTime: parseBinanceNumber(entry[0], "open time"),
      open: parseBinanceNumber(entry[1], "open"),
      high: parseBinanceNumber(entry[2], "high"),
      low: parseBinanceNumber(entry[3], "low"),
      close: parseBinanceNumber(entry[4], "close"),
      volume: parseBinanceNumber(entry[5], "volume"),
      closeTime: parseBinanceNumber(entry[6], "close time"),
    };
  });
}

function renderChartBuffer(candles: BinanceKline[]): Buffer {
  const canvas = createCanvas(BTC_CHART_WIDTH, BTC_CHART_HEIGHT);
  const ctx = canvas.getContext("2d");
  const frame = getChartFrame();
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const pricePadding = Math.max((maxHigh - minLow) * 0.08, maxHigh * 0.005);
  const minPrice = minLow - pricePadding;
  const maxPrice = maxHigh + pricePadding;

  drawBackground(ctx);
  drawTitle(ctx);
  drawPriceGrid(ctx, minPrice, maxPrice, frame);
  drawVolumeDivider(ctx, frame);
  drawCandles(ctx, candles, minPrice, maxPrice, frame);
  drawVolumeBars(ctx, candles, frame);
  drawVolumeLabel(ctx, frame);
  drawXAxisLabels(ctx, candles, frame);

  return canvas.toBuffer("image/png");
}

export function formatBtcChartCaption(input: {
  currentPrice: number;
  updatedAt: number;
}): string {
  return [
    "BTC/USDT 15m — Last 12 hours",
    `Current: ${formatUsdPrice(input.currentPrice)}`,
    `Updated: ${new Date(input.updatedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "UTC",
    })} UTC`,
  ].join("\n");
}

export async function getBtcChartImage(options?: {
  forceRefresh?: boolean;
}): Promise<BtcChartImage> {
  const now = Date.now();

  if (
    !options?.forceRefresh &&
    cachedBtcChart &&
    now - cachedBtcChart.updatedAt < BTC_CHART_CACHE_TTL_MS
  ) {
    return cachedBtcChart;
  }

  try {
    const candles = await fetchBtcChartKlines();
    const currentPrice = candles[candles.length - 1]?.close;

    if (!Number.isFinite(currentPrice)) {
      throw new Error("Binance chart data did not include a usable current price.");
    }

    const chart: CachedBtcChart = {
      buffer: renderChartBuffer(candles),
      currentPrice,
      updatedAt: now,
    };

    cachedBtcChart = chart;
    return chart;
  } catch (error) {
    if (cachedBtcChart) {
      console.warn("[chart] Falling back to cached BTC chart image:", error);
      return cachedBtcChart;
    }

    throw error;
  }
}
