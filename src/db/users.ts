import { supabase } from "./client.ts";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export async function upsertUserProfile(
  telegramId: number,
  username?: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const { error: insertError } = await supabase.from("fantasy_users").insert({
    telegram_id: telegramId,
    username: username ?? null,
    wallet_balance: roundMoney(0),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });

  if (insertError && !isUniqueViolation(insertError)) {
    throw insertError;
  }

  const updates: Record<string, string | null> = {
    updated_at: now,
    last_seen_at: now,
  };

  if (username !== undefined) {
    updates.username = username ?? null;
  }

  const { error } = await supabase
    .from("fantasy_users")
    .update(updates)
    .eq("telegram_id", telegramId);

  if (error) {
    throw error;
  }
}
