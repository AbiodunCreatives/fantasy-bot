import { supabase } from "./client.js";

export async function upsertUserProfile(
  telegramId: number,
  username?: string | null
): Promise<void> {
  const { error } = await supabase.rpc("upsert_user", {
    p_telegram_id: telegramId,
    p_username: username ?? null,
  });

  if (error) {
    throw error;
  }
}
