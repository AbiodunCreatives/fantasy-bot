import Link from 'next/link';
import Layout from '../components/Layout';

const BOT_URL = 'https://t.me/HeadlineOddsBot'; // update to real bot username

const COMMANDS = [
  { name: '/league', desc: 'Browse open rounds and join a prediction' },
  { name: '/wallet', desc: 'Check balance, deposit, or withdraw USDC' },
  { name: '/wallet fund-ngn 5000', desc: 'Fund via Nigerian Naira bank transfer' },
];

const WALLET_STEPS = [
  'Open the bot and send /wallet',
  'Copy your personal Solana deposit address',
  'Send USDC (SPL) to that address from any wallet or exchange',
  'Balance appears automatically — usually within 30 seconds',
  'Use /league to enter a round and start predicting',
];

export default function Play() {
  return (
    <Layout
      title="Play HeadlineOdds Arena"
      description="Start playing HeadlineOdds Arena on Telegram. Fund your wallet with USDC on Solana and make your first prediction."
    >
      <section className="play-hero">
        <div className="container">
          <div className="hero-badge">🎮 Get Started</div>
          <h1>Enter the Arena</h1>
          <p>
            Everything happens inside Telegram. Open the bot, fund your wallet,
            and make your first prediction in under two minutes.
          </p>
          <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className="btn btn-gold" style={{ margin: '0 auto' }}>
            🚀 Open @HeadlineOddsBot
          </a>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <div className="play-grid">
            {/* Wallet card */}
            <div className="play-card">
              <h2>💳 Fund Your Wallet</h2>
              <p>
                Each player gets a personal Solana wallet inside the bot.
                Deposit USDC and your balance is ready to play instantly.
              </p>
              <ul className="wallet-steps">
                {WALLET_STEPS.map((step, i) => (
                  <li key={i}>
                    <span className="step-n">{i + 1}</span>
                    {step}
                  </li>
                ))}
              </ul>
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                Open Bot
              </a>
            </div>

            {/* Commands card */}
            <div className="play-card">
              <h2>⌨️ Key Commands</h2>
              <p>
                The Arena runs entirely through Telegram commands.
                Here are the ones you'll use most.
              </p>
              <div className="commands">
                {COMMANDS.map((c) => (
                  <div key={c.name} className="cmd">
                    <span className="cmd-name">{c.name}</span>
                    <span className="cmd-desc">{c.desc}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 32 }}>
                <h2 style={{ marginBottom: 12 }}>🇳🇬 NGN On-Ramp</h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                  No crypto exchange? No problem. Fund your wallet directly with
                  Nigerian Naira via bank transfer using the{' '}
                  <code style={{ color: 'var(--accent-light)', background: 'rgba(124,58,237,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                    /wallet fund-ngn
                  </code>{' '}
                  command. Powered by PajCash.
                </p>
              </div>

              <div style={{ marginTop: 32 }}>
                <h2 style={{ marginBottom: 12 }}>💸 Withdrawals</h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                  Winnings land in your in-bot balance automatically.
                  Withdraw to any Solana wallet address at any time — no minimums, no delays.
                </p>
              </div>
            </div>
          </div>

          {/* Back link */}
          <div style={{ marginTop: 48, textAlign: 'center' }}>
            <Link href="/" className="btn btn-outline">
              ← Back to Arena
            </Link>
          </div>
        </div>
      </section>
    </Layout>
  );
}
