import 'dotenv/config'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, getMint } from '@solana/spl-token'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { createClient } from '@supabase/supabase-js'

const conn = new Connection(process.env.SOLANA_RPC_URL!)
const mint = new PublicKey(process.env.SOLANA_USDC_MINT!)
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) return new Uint8Array(JSON.parse(trimmed))
  return Buffer.from(trimmed, 'base64')
}

function getEncryptionKey(): Buffer {
  const val = process.env.SOLANA_WALLET_ENCRYPTION_KEY!.trim()
  if (/^[a-f0-9]{64}$/i.test(val)) return Buffer.from(val, 'hex')
  return Buffer.from(val, 'base64')
}

function decryptSecretKey(encrypted: string): Uint8Array {
  const key = getEncryptionKey()
  const buf = Buffer.from(encrypted, 'base64')
  const iv = buf.subarray(0, 16)
  const tag = buf.subarray(16, 32)
  const ciphertext = buf.subarray(32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

const treasury = Keypair.fromSecretKey(parseSecretKey(process.env.SOLANA_TREASURY_SECRET_KEY!))
const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey)

const { data: wallets } = await supabase
  .from('fantasy_wallets')
  .select('owner_address, usdc_ata, encrypted_secret_key, telegram_id')

const mintInfo = await getMint(conn, mint)
const decimals = mintInfo.decimals

console.log(`Treasury: ${treasury.publicKey.toBase58()}`)
console.log(`Checking ${wallets?.length ?? 0} wallets...\n`)

let totalSwept = 0

for (const w of wallets ?? []) {
  const ata = new PublicKey(w.usdc_ata)
  let balance
  try {
    balance = await conn.getTokenAccountBalance(ata)
  } catch {
    continue // ATA doesn't exist yet
  }

  const amount = balance.value.uiAmount ?? 0
  if (amount < 0.01) continue

  console.log(`${w.telegram_id} (${w.owner_address}): ${amount} USDC — sweeping...`)

  try {
    const userKp = Keypair.fromSecretKey(decryptSecretKey(w.encrypted_secret_key))
    const rawAmount = BigInt(balance.value.amount)

    const tx = new Transaction().add(
      createTransferCheckedInstruction(ata, mint, treasuryAta, userKp.publicKey, rawAmount, decimals)
    )
    tx.feePayer = treasury.publicKey

    const { sendAndConfirmTransaction } = await import('@solana/web3.js')
    const sig = await sendAndConfirmTransaction(conn, tx, [treasury, userKp], { commitment: 'confirmed' })
    console.log(`  ✅ Swept ${amount} USDC — sig: ${sig}`)
    totalSwept += amount
  } catch (err) {
    console.error(`  ❌ Failed: ${err instanceof Error ? err.message : err}`)
  }
}

console.log(`\nTotal swept: ${totalSwept.toFixed(6)} USDC`)
