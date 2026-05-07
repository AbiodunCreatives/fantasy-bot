import { Keypair } from "@solana/web3.js";
import { config } from "../src/config.ts";

function parseSecretKey(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

void (async () => {
  const secretKey = parseSecretKey(config.SOLANA_TREASURY_SECRET_KEY);
  const keypair = Keypair.fromSecretKey(secretKey);
  const address = keypair.publicKey.toBase58();

  console.log("Treasury Solana Address:");
  console.log(address);
  console.log("");
  console.log("Send at least 1.0 SOL to this address to fund:");
  console.log("- ATA creation fees for users");
  console.log("- Transfer transaction fees");
})();
