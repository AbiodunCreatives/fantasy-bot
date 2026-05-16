import 'dotenv/config'
import { Keypair, Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

const kp = Keypair.fromSecretKey(Buffer.from(process.env.SOLANA_TREASURY_SECRET_KEY!, 'base64'))
const mint = new PublicKey(process.env.SOLANA_USDC_MINT!)
const ata = getAssociatedTokenAddressSync(mint, kp.publicKey)
const conn = new Connection(process.env.SOLANA_RPC_URL!)

console.log('Treasury address:', kp.publicKey.toBase58())
conn.getTokenAccountBalance(ata).then(bal => {
  console.log('Treasury USDC:', bal.value.uiAmount)
}).catch(err => {
  console.error('Error:', err.message)
})
