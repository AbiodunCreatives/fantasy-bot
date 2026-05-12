export const DEV_MIN_ENTRY_FEE = 0.20
export const DEV_VIRTUAL_BANKROLL = 1000.00

export function isDevUser(telegramId: number | string): boolean {
  const ids = (process.env.DEV_OVERRIDE_TG_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.includes(String(telegramId))
}
