import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { config } from "./config.ts";
import { getBalance, creditBalance } from "./db/balances.ts";
import {
  listRecentPajCashOnramps,
  type PajCashOnramp,
} from "./db/pajcash.ts";
import { upsertUserProfile } from "./db/users.ts";
import {
  completeFantasyWalletWithdrawal,
  createFantasyWalletRecord,
  failFantasyWalletWithdrawal,
  getFantasyWalletByTelegramId,
  listFantasyWalletLedger,
  listFantasyWallets,
  listPendingFantasyWalletWithdrawals,
  listRecentFantasyWalletWithdrawals,
  markFantasyWalletWithdrawalProcessing,
  recordSolanaWalletDepositDelta,
  requestSolanaWithdrawal,
  updateFantasyWalletObservedBalance,
  type FantasyWallet,
  type FantasyWalletLedgerEntry,
  type FantasyWalletWithdrawal,
} from "./db/wallets.ts";

const SOLANA_COMMITMENT = "confirmed";

export interface FantasyWalletSummary {
  wallet: FantasyWallet;
  balance: number;
  recentLedger: FantasyWalletLedgerEntry[];
  recentWithdrawals: FantasyWalletWithdrawal[];
  recentOnramps: PajCashOnramp[];
}

let cachedConnection: Connection | null = null;
let cachedTreasuryKeypair: Keypair | null = null;
let cachedUsdcMint: PublicKey | null = null;
let cachedUsdcDecimals: number | null = null;
const activeWalletSyncs = new Set<number>();
const activeWithdrawalIds = new Set<string>();

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function usdcToRaw(amount: number): bigint {
  return BigInt(Math.round(roundUsdc(amount) * 1_000_000));
}

function rawToUsdc(amountRaw: bigint): number {
  return Number(amountRaw) / 1_000_000;
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Secret key value is empty.");
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return new Uint8Array(parsed);
  }

  return decodeBase64(trimmed);
}

function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");

  if (decoded.length !== 32) {
    throw new Error(
      "SOLANA_WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes."
    );
  }

  return decoded;
}

function encryptSecretKey(secretKey: Uint8Array): string {
  const key = parseEncryptionKey(config.SOLANA_WALLET_ENCRYPTION_KEY);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(secretKey)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decryptSecretKey(payload: string): Uint8Array {
  const [version, ivRaw, authTagRaw, ciphertextRaw] = payload.split(".");

  if (
    version !== "v1" ||
    !ivRaw ||
    !authTagRaw ||
    !ciphertextRaw
  ) {
    throw new Error("Invalid encrypted Solana wallet payload.");
  }

  const key = parseEncryptionKey(config.SOLANA_WALLET_ENCRYPTION_KEY);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivRaw, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTagRaw, "base64"));

  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64")),
    decipher.final(),
  ]);

  return new Uint8Array(cleartext);
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(config.SOLANA_RPC_URL, SOLANA_COMMITMENT);
  }

  return cachedConnection;
}

function getUsdcMint(): PublicKey {
  if (!cachedUsdcMint) {
    cachedUsdcMint = new PublicKey(config.SOLANA_USDC_MINT);
  }

  return cachedUsdcMint;
}

async function getUsdcDecimals(): Promise<number> {
  if (cachedUsdcDecimals !== null) {
    return cachedUsdcDecimals;
  }

  const mint = await getMint(getConnection(), getUsdcMint(), SOLANA_COMMITMENT);
  cachedUsdcDecimals = mint.decimals;
  return cachedUsdcDecimals;
}

function getTreasuryKeypair(): Keypair {
  if (!cachedTreasuryKeypair) {
    cachedTreasuryKeypair = Keypair.fromSecretKey(
      parseSecretKey(config.SOLANA_TREASURY_SECRET_KEY)
    );
  }

  return cachedTreasuryKeypair;
}

function getAssociatedUsdcAddress(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(getUsdcMint(), owner);
}

async function ensureAssociatedTokenAccount(
  owner: PublicKey,
  payer: Keypair
): Promise<PublicKey> {
  const connection = getConnection();
  const ata = getAssociatedUsdcAddress(owner);
  const existing = await connection.getAccountInfo(ata, SOLANA_COMMITMENT);

  if (existing) {
    return ata;
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      owner,
      getUsdcMint()
    )
  );

  await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: SOLANA_COMMITMENT,
  });

  return ata;
}

async function ensureTreasuryUsdcAta(): Promise<PublicKey> {
  const treasury = getTreasuryKeypair();
  return ensureAssociatedTokenAccount(treasury.publicKey, treasury);
}

function toUserKeypair(wallet: FantasyWallet): Keypair {
  return Keypair.fromSecretKey(decryptSecretKey(wallet.encrypted_secret_key));
}

async function getTokenAccountRawBalance(address: PublicKey): Promise<bigint> {
  try {
    const balance = await getConnection().getTokenAccountBalance(
      address,
      SOLANA_COMMITMENT
    );
    return BigInt(balance.value.amount);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";

    if (
      message.includes("could not find account") ||
      message.includes("invalid param")
    ) {
      return 0n;
    }

    throw error;
  }
}

async function sweepWalletToTreasury(
  wallet: FantasyWallet,
  amountRaw: bigint
): Promise<string | null> {
  if (amountRaw <= 0n) {
    return null;
  }

  const userSigner = toUserKeypair(wallet);
  const treasury = getTreasuryKeypair();
  const treasuryAta = await ensureTreasuryUsdcAta();
  const userAta = new PublicKey(wallet.usdc_ata);
  const decimals = await getUsdcDecimals();

  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      userAta,
      getUsdcMint(),
      treasuryAta,
      userSigner.publicKey,
      amountRaw,
      decimals
    )
  );
  tx.feePayer = treasury.publicKey;

  return sendAndConfirmTransaction(getConnection(), tx, [treasury, userSigner], {
    commitment: SOLANA_COMMITMENT,
  });
}

async function transferUserUsdc(input: {
  fromWallet: FantasyWallet;
  destinationAddress: string;
  amount: number;
}): Promise<{ signature: string; destinationUsdcAta: string }> {
  const userSigner = toUserKeypair(input.fromWallet);
  const treasury = getTreasuryKeypair();
  const userAta = new PublicKey(input.fromWallet.usdc_ata);
  const destinationOwner = new PublicKey(input.destinationAddress);
  const destinationAta = await ensureAssociatedTokenAccount(
    destinationOwner,
    treasury
  );
  const decimals = await getUsdcDecimals();

  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      userAta,
      getUsdcMint(),
      destinationAta,
      userSigner.publicKey,
      usdcToRaw(input.amount),
      decimals
    )
  );
  tx.feePayer = treasury.publicKey;

  const signature = await sendAndConfirmTransaction(
    getConnection(),
    tx,
    [treasury, userSigner],
    {
      commitment: SOLANA_COMMITMENT,
    }
  );

  return {
    signature,
    destinationUsdcAta: destinationAta.toBase58(),
  };
}

async function transferUserUsdcToTreasury(input: {
  wallet: FantasyWallet;
  amount: number;
}): Promise<string> {
  const userSigner = toUserKeypair(input.wallet);
  const treasury = getTreasuryKeypair();
  const treasuryAta = await ensureTreasuryUsdcAta();
  const userAta = new PublicKey(input.wallet.usdc_ata);
  const decimals = await getUsdcDecimals();

  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      userAta,
      getUsdcMint(),
      treasuryAta,
      userSigner.publicKey,
      usdcToRaw(input.amount),
      decimals
    )
  );
  tx.feePayer = treasury.publicKey;

  return sendAndConfirmTransaction(getConnection(), tx, [treasury, userSigner], {
    commitment: SOLANA_COMMITMENT,
  });
}

export async function transferTreasuryUsdc(input: {
  destinationAddress: string;
  amount: number;
}): Promise<{ signature: string; destinationUsdcAta: string }> {
  const treasury = getTreasuryKeypair();
  const treasuryAta = await ensureTreasuryUsdcAta();
  const destinationOwner = new PublicKey(input.destinationAddress);
  const destinationAta = await ensureAssociatedTokenAccount(
    destinationOwner,
    treasury
  );
  const decimals = await getUsdcDecimals();

  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      treasuryAta,
      getUsdcMint(),
      destinationAta,
      treasury.publicKey,
      usdcToRaw(input.amount),
      decimals
    )
  );
  tx.feePayer = treasury.publicKey;

  const signature = await sendAndConfirmTransaction(
    getConnection(),
    tx,
    [treasury],
    {
      commitment: SOLANA_COMMITMENT,
    }
  );

  return {
    signature,
    destinationUsdcAta: destinationAta.toBase58(),
  };
}

async function ensureUserUsdcAta(wallet: FantasyWallet): Promise<void> {
  const treasury = getTreasuryKeypair();
  await ensureAssociatedTokenAccount(new PublicKey(wallet.owner_address), treasury);
}

export async function ensureFantasyWallet(
  telegramId: number
): Promise<FantasyWallet> {
  await upsertUserProfile(telegramId);

  const existing = await getFantasyWalletByTelegramId(telegramId);

  if (existing) {
    return existing;
  }

  const wallet = Keypair.generate();
  const ownerAddress = wallet.publicKey.toBase58();
  const usdcAta = getAssociatedUsdcAddress(wallet.publicKey).toBase58();
  const encryptedSecretKey = encryptSecretKey(wallet.secretKey);

  try {
    const created = await createFantasyWalletRecord({
      telegramId,
      ownerAddress,
      usdcAta,
      encryptedSecretKey,
    });

    await ensureTreasuryUsdcAta();
    return created;
  } catch (error) {
    if (isUniqueViolation(error as { code?: string } | null)) {
      const conflicted = await getFantasyWalletByTelegramId(telegramId);

      if (conflicted) {
        return conflicted;
      }
    }

    throw error;
  }
}

export async function getFantasyWalletSummary(
  telegramId: number
): Promise<FantasyWalletSummary> {
  const wallet = await ensureFantasyWallet(telegramId);
  const [balance, recentLedger, recentWithdrawals, recentOnramps] = await Promise.all([
    getBalance(telegramId),
    listFantasyWalletLedger(telegramId, 6),
    listRecentFantasyWalletWithdrawals(telegramId, 4),
    listRecentPajCashOnramps(telegramId, 3),
  ]);

  return {
    wallet,
    balance,
    recentLedger,
    recentWithdrawals,
    recentOnramps,
  };
}

export async function requestFantasyWalletWithdrawal(input: {
  telegramId: number;
  destinationAddress: string;
  amount: number;
}): Promise<FantasyWalletWithdrawal> {
  if (roundUsdc(input.amount) < roundUsdc(config.SOLANA_WITHDRAW_MIN_AMOUNT)) {
    throw new Error(
      `Minimum withdrawal is ${roundUsdc(config.SOLANA_WITHDRAW_MIN_AMOUNT)} USDC.`
    );
  }

  await ensureFantasyWallet(input.telegramId);

  return requestSolanaWithdrawal({
    telegramId: input.telegramId,
    destinationAddress: input.destinationAddress,
    amount: roundUsdc(input.amount),
  });
}

export async function syncFantasyWalletDeposits(
  wallet?: FantasyWallet
): Promise<void> {
  const wallets = wallet ? [wallet] : await listFantasyWallets();

  for (const item of wallets) {
    if (activeWalletSyncs.has(item.telegram_id)) {
      continue;
    }

    activeWalletSyncs.add(item.telegram_id);

    try {
      const currentRawBalance = await getTokenAccountRawBalance(
        new PublicKey(item.usdc_ata)
      );

      if (currentRawBalance < item.last_seen_usdc_balance_raw) {
        await updateFantasyWalletObservedBalance({
          telegramId: item.telegram_id,
          rawBalance: currentRawBalance,
        });
        continue;
      }

      if (currentRawBalance > item.last_seen_usdc_balance_raw) {
        const deltaRaw = currentRawBalance - item.last_seen_usdc_balance_raw;
        await recordSolanaWalletDepositDelta({
          telegramId: item.telegram_id,
          walletAddress: item.owner_address,
          usdcAta: item.usdc_ata,
          previousRawBalance: item.last_seen_usdc_balance_raw,
          newRawBalance: currentRawBalance,
          amount: rawToUsdc(deltaRaw),
          amountRaw: deltaRaw,
        });
        await updateFantasyWalletObservedBalance({
          telegramId: item.telegram_id,
          rawBalance: currentRawBalance,
        });
      }
    } finally {
      activeWalletSyncs.delete(item.telegram_id);
    }
  }
}

export async function processFantasyWalletWithdrawals(): Promise<void> {
  const withdrawals = await listPendingFantasyWalletWithdrawals();

  for (const pendingWithdrawal of withdrawals) {
    if (activeWithdrawalIds.has(pendingWithdrawal.id)) {
      continue;
    }

    activeWithdrawalIds.add(pendingWithdrawal.id);

    try {
      const claimed = await markFantasyWalletWithdrawalProcessing(
        pendingWithdrawal.id
      );

      if (!claimed) {
        continue;
      }

      try {
        const wallet = await getFantasyWalletByTelegramId(claimed.telegram_id);
        if (!wallet) {
          throw new Error("User wallet not found.");
        }

        const transfer = await transferUserUsdc({
          fromWallet: wallet,
          destinationAddress: claimed.destination_address,
          amount: claimed.amount,
        });

        await completeFantasyWalletWithdrawal({
          withdrawalId: claimed.id,
          txSignature: transfer.signature,
          destinationUsdcAta: transfer.destinationUsdcAta,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown Solana withdrawal error.";

        await failFantasyWalletWithdrawal({
          withdrawalId: claimed.id,
          failureReason: message,
        });

        await creditBalance(claimed.telegram_id, claimed.amount, {
          entryType: "withdrawal_refund",
          referenceType: "solana_wallet_withdrawal",
          referenceId: claimed.id,
          idempotencyKey: `withdrawal_refund:${claimed.id}`,
          metadata: {
            failureReason: message,
          },
        });
      }
    } finally {
      activeWithdrawalIds.delete(pendingWithdrawal.id);
    }
  }
}

export async function transferUsdcForArenaEntry(input: {
  telegramId: number;
  amount: number;
}): Promise<string> {
  const wallet = await ensureFantasyWallet(input.telegramId);
  await ensureUserUsdcAta(wallet);
  return transferUserUsdcToTreasury({
    wallet,
    amount: input.amount,
  });
}

export async function transferUsdcForPrizeWinning(input: {
  telegramId: number;
  amount: number;
}): Promise<string> {
  const wallet = await ensureFantasyWallet(input.telegramId);
  await ensureUserUsdcAta(wallet);
  return (
    await transferTreasuryUsdc({
      destinationAddress: wallet.owner_address,
      amount: input.amount,
    })
  ).signature;
}

export async function transferUsdcFromTreasury(input: {
  telegramId: number;
  amount: number;
}): Promise<string> {
  const wallet = await ensureFantasyWallet(input.telegramId);
  await ensureUserUsdcAta(wallet);
  return (
    await transferTreasuryUsdc({
      destinationAddress: wallet.owner_address,
      amount: input.amount,
    })
  ).signature;
}
