import dotenv from "dotenv";

import {
  initiatePajCashSession,
  verifyPajCashSessionOtp,
} from "./pajcash.ts";

dotenv.config();

async function main(): Promise<void> {
  const otp = (process.env["PAJCASH_OTP"] ?? "").trim();

  if (!otp) {
    const initiated = await initiatePajCashSession();
    const recipient = initiated.email ?? initiated.phone ?? "your PajCash recipient";

    console.log(`OTP requested successfully for ${recipient}.`);
    console.log("Set PAJCASH_OTP in .env, then rerun `pnpm pajcash:session`.");
    return;
  }

  const verified = await verifyPajCashSessionOtp(otp);

  console.log("PajCash session verified.");
  console.log("");
  console.log("Add these lines to your .env:");
  console.log(`PAJCASH_SESSION_TOKEN=${verified.token}`);
  console.log(`PAJCASH_SESSION_EXPIRES_AT=${verified.expiresAt}`);
  console.log("");
  console.log("Remove PAJCASH_OTP from .env after saving the token.");
}

main().catch((error) => {
  console.error("[pajcash:session] Failed:", error);
  process.exit(1);
});
