import { supabase } from "./client.js";

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

export async function recordRevenueOnce(input: {
  type: string;
  amount: number;
  telegramId?: number | null;
}): Promise<boolean> {
  const amount = roundMoney(input.amount);

  if (amount <= 0) {
    return false;
  }

  const { error } = await supabase.from("fantasy_revenue").insert({
    telegram_id: input.telegramId ?? null,
    type: input.type,
    amount,
  });

  if (error) {
    if (isUniqueViolation(error)) {
      return false;
    }

    throw error;
  }

  return true;
}
