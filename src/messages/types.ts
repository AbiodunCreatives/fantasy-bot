export interface ArenaCreatedParams {
  code: string
  prizePool: number
  virtualStack: number
  startsInMin: number
}

export interface ArenaLiveParams {
  code: string
  players: number
  grossPool: number
  commission: number
  netPrizePool: number
  virtualBankroll: number
  durationHours: number
}

export interface RoundPromptParams {
  code: string
  roundNumber: number
  btcPrice: number
  upOdds: number
  downOdds: number
  closesAt: Date
  arenaMinutesLeft: number
  entryWindowMinutes: number
}

export interface RoundLockedParams {
  code: string
  roundNumber: number
  direction: 'YES' | 'NO'
  stake: number
  buyPrice: number
  shares: number
  balanceAfter: number
}

export interface RoundResultParams {
  code: string
  roundNumber: number
  btcResult: 'UP' | 'DOWN'
  userTrade: 'UP' | 'DOWN'
  won: boolean
  balanceAfter: number
  currentRank: number
  totalPlayers: number
}

export interface LeaderboardEntry {
  name: string
  stack: number
  changePct: number
  isYou: boolean
}

export interface LiveStatusParams {
  code: string
  rank: number
  totalPlayers: number
  stack: number
  stackChangePct: number
  arenaMinutesLeft: number
  currentRound: number
  btcPrice: number
  prizeIfEndsNow: number
  lastRoundResult: 'won' | 'lost' | null
  accuracy: { correct: number; total: number }
  leaderboard: LeaderboardEntry[]
}

export interface FinalResultParams {
  code: string
  durationHours: number
  roundsPlayed: number
  netPrizePool: number
  userPayout: number | null
  leaderboard: LeaderboardEntry[]
}
