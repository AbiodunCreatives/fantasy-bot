import Link from 'next/link';
import Head from 'next/head';
import type { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

export default function Layout({
  children,
  title = 'HeadlineOdds Arena — Fantasy Prediction Markets on Telegram',
  description = 'Pick headlines. Beat the crowd. Win USDC. Play HeadlineOdds Arena directly in Telegram.',
}: LayoutProps) {
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" href="/arena/favicon.ico" />
      </Head>

      <nav className="nav">
        <div className="container nav-inner">
          <Link href="/arena" className="nav-logo">
            Headline<span>Odds</span> Arena
          </Link>
          <div className="nav-links">
            <Link href="/arena#how-it-works">How it works</Link>
            <Link href="/arena#features">Features</Link>
            <Link href="/arena/play" className="btn btn-primary" style={{ padding: '8px 20px', fontSize: '0.875rem' }}>
              Play Now
            </Link>
          </div>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="footer">
        <div className="container footer-inner">
          <div className="footer-logo">Headline<span>Odds</span> Arena</div>
          <div className="footer-links">
            <Link href="/arena#how-it-works">How it works</Link>
            <Link href="/arena/play">Play</Link>
          </div>
          <p className="footer-copy">© {new Date().getFullYear()} HeadlineOdds. All rights reserved.</p>
        </div>
      </footer>
    </>
  );
}
