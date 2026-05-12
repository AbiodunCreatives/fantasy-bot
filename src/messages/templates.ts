import { InlineKeyboard } from 'grammy'
import { escapeMarkdown } from '../utils/escape'
import type {
  ArenaCreatedParams,
  ArenaLiveParams,
  FinalResultParams,
  LeaderboardEntry,
  LiveStatusParams,
  RoundLockedParams,
  RoundPromptParams,
  RoundResultParams,
} from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

type ReplyMarkup = { inline_keyboard: InlineKeyboard['inline_keyboard'] }

interface BotMessage {
  text: string
  reply_markup?: ReplyMarkup
  parse_mode: 'MarkdownV2'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEP = '━━━━━━━━━━━━━━━━━━━━'

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

/** Pad string to fixed length with trailing spaces (ASCII-safe for monospace blocks). */
function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length)
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function msg(text: string, reply_markup?: ReplyMarkup): BotMessage {
  return { text, reply_markup, parse_mode: 'MarkdownV2' }
}

// ─── Templates ───────────────────────────────────────────────────────────────

export function arenaCreatedMessage(p: ArenaCreatedParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const text = [
    `🎯 *ARENA CREATED*`,
    `\`${code}\`  ·  Starts in ~${p.startsInMin} min  ·  1h duration`,
    SEP,
    `💰 Prize pool     \`${escapeMarkdown(usd(p.prizePool))}\``,
    `🏦 Your stack     \`${escapeMarkdown(usd(p.virtualStack))}\``,
    `👥 Players        \`1\``,
    SEP,
    `Prize pool grows as others join\\.`,
    `I'll ping you when round 1 opens\\.`,
  ].join('\n')

  const kb = new InlineKeyboard()
    .text('Share invite ↗', `arena_share:${p.code}`)
    .text('Back to lobby', 'lobby')

  return msg(text, { inline_keyboard: kb.inline_keyboard })
}

export function arenaLiveMessage(p: ArenaLiveParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const commPct = Math.round((p.commission / p.grossPool) * 100)
  const text = [
    `⚡ *ARENA ${code} · LIVE*`,
    SEP,
    `🏆 Net prize pool  \`${escapeMarkdown(usd(p.netPrizePool))}\``,
    `🏦 Your bankroll   \`${escapeMarkdown(usd(p.virtualBankroll))}\``,
    `👥 Players         \`${p.players}\``,
    SEP,
    `Gross \`${escapeMarkdown(usd(p.grossPool))}\` · Commission \\(${commPct}%\\) \`${escapeMarkdown(usd(p.commission))}\``,
    `15\\-min BTC rounds until arena ends\\.`,
  ].join('\n')

  return msg(text)
}

export function roundPromptMessage(p: RoundPromptParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const closeTime = escapeMarkdown(formatTime(p.closesAt))
  const btcPrice = escapeMarkdown(p.btcPrice.toLocaleString('en-US'))
  const upOdds = escapeMarkdown(p.upOdds.toFixed(2))
  const downOdds = escapeMarkdown(p.downOdds.toFixed(2))

  const text = [
    `⚡ *Round ${p.roundNumber} · ${code}*`,
    `🕐 Closes ${closeTime}  ·  ${escapeMarkdown(String(p.arenaMinutesLeft))}:00 left`,
    SEP,
    `₿  BTC/USD    \`$${btcPrice}\``,
    `⬆️ UP    \`${upOdds}\`     ⬇️ DOWN   \`${downOdds}\``,
    SEP,
    `⏳ Bot entry window closes in ${p.entryWindowMinutes}m`,
    `🏟 Arena time left: ${escapeMarkdown(String(p.arenaMinutesLeft))}m`,
  ].join('\n')

  const kb = new InlineKeyboard()
    .text('View market ↗', `market:${p.code}:${p.roundNumber}`)
    .text('Leaderboard', `lb:${p.code}`)
    .row()
    .text('How to catch #1', `catch1:${p.code}`)
    .row()
    .text('Refresh live', `refresh:${p.code}`)
    .text('Back to lobby', 'lobby')

  return msg(text, { inline_keyboard: kb.inline_keyboard })
}

export function roundLockedMessage(p: RoundLockedParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const buyPriceCents = Math.round(p.buyPrice * 100)
  const text = [
    `✅ *Round ${p.roundNumber} locked in · ${code}*`,
    `Direction   \`${p.direction}\``,
    `Stake       \`${escapeMarkdown(usd(p.stake))}\``,
    SEP,
    `Buy price   \`${buyPriceCents}¢\``,
    `Shares      \`${escapeMarkdown(p.shares.toFixed(2))}\``,
    `Balance     \`${escapeMarkdown(usd(p.balanceAfter))}\``,
    SEP,
    `Result sent when the round closes\\.`,
  ].join('\n')

  return msg(text)
}

export function roundResultMessage(p: RoundResultParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const tradeCheck = p.won ? '✓' : '✗'
  const header = p.won
    ? `✅ *Round ${p.roundNumber} closed · You won\\!*`
    : `❌ *Round ${p.roundNumber} closed · You lost*`

  const text = [
    header,
    `BTC finished ${p.btcResult} · Your trade: ${p.userTrade} ${tradeCheck}`,
    `Balance   \`${escapeMarkdown(usd(p.balanceAfter))}\` USDC`,
    `Rank      \\#${p.currentRank} of ${p.totalPlayers}`,
  ].join('\n')

  if (p.won) return msg(text)

  const kb = new InlineKeyboard().text('View leaderboard', `lb:${p.code}`)
  return msg(text, { inline_keyboard: kb.inline_keyboard })
}

export function liveStatusMessage(p: LiveStatusParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const stackSign = p.stackChangePct >= 0 ? '+' : '−'
  const absPct = Math.abs(p.stackChangePct).toFixed(0)
  const btcPrice = escapeMarkdown(p.btcPrice.toLocaleString('en-US'))

  const lbRows = p.leaderboard.map((e, i) => buildLbRow(i + 1, e))
  const lbBlock = '```\n' + lbRows.join('\n') + '\n```'

  const lastRound = p.lastRoundResult
    ? p.lastRoundResult.charAt(0).toUpperCase() + p.lastRoundResult.slice(1)
    : 'None'
  const accPct = p.accuracy.total > 0
    ? Math.round((p.accuracy.correct / p.accuracy.total) * 100)
    : 0

  const text = [
    `⚡ *Arena ${code} · Live*`,
    `\\#${p.rank} of ${p.totalPlayers}  ·  Stack: \`${escapeMarkdown(usd(p.stack))}\` \\(${stackSign}${escapeMarkdown(absPct)}%\\)  ·  ${escapeMarkdown(String(p.arenaMinutesLeft))}m left`,
    SEP,
    `Round ${p.currentRound}  ·  BTC \`$${btcPrice}\``,
    lbBlock,
    SEP,
    `Prize if ended now:  \`${escapeMarkdown(usd(p.prizeIfEndsNow))}\``,
    `Last round:          ${lastRound}`,
    `Accuracy:            ${p.accuracy.correct}/${p.accuracy.total} \\(${accPct}%\\)`,
  ].join('\n')

  const kb = new InlineKeyboard()
    .text('How to catch #1', `catch1:${p.code}`)
    .text('Live market', `market:${p.code}`)
    .row()
    .text('Refresh', `refresh:${p.code}`)
    .text('Back to lobby', 'lobby')

  return msg(text, { inline_keyboard: kb.inline_keyboard })
}

export function finalResultMessage(p: FinalResultParams): BotMessage {
  const code = escapeMarkdown(p.code)
  const medals = ['🥇', '🥈', '🥉']

  const lbRows = p.leaderboard.map((e, i) => {
    const medal = medals[i] ?? `${i + 1} `
    const name = e.isYou ? 'you' : e.name
    const bold = i === 0 ? `*${escapeMarkdown(name)}*` : escapeMarkdown(name)
    return `${medal}  ${bold}   \`${escapeMarkdown(usd(e.stack))}\`   \`${escapeMarkdown(pct(e.changePct))}\``
  })

  const payoutLine = p.userPayout != null
    ? `Your payout:     \`${escapeMarkdown(usd(p.userPayout))}\` USDC  🎉`
    : `Your payout:     — No payout this time`

  const text = [
    `🏁 *Arena ${code} — Final*`,
    `${p.durationHours}h · ${p.roundsPlayed} rounds played`,
    SEP,
    ...lbRows,
    SEP,
    `Net prize pool:  \`${escapeMarkdown(usd(p.netPrizePool))}\``,
    payoutLine,
  ].join('\n')

  const kb = new InlineKeyboard()
    .text('Play again', 'lobby')
    .text('Share result ↗', `share_result:${p.code}`)

  return msg(text, { inline_keyboard: kb.inline_keyboard })
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildLbRow(rank: number, e: LeaderboardEntry): string {
  const prefix = e.isYou ? '→' : ' '
  const name = e.isYou ? 'you' : e.name
  return `${prefix} ${padEnd(String(rank), 2)} ${padEnd(name, 10)} ${padEnd(usd(e.stack), 8)} ${pct(e.changePct)}`
}
