# HeadlineOdds Arena — Website

Marketing site for [HeadlineOdds Arena](https://headlineodds.fun/arena).

Built with Next.js (pages router), TypeScript, and plain CSS. No UI library dependencies — fully self-contained and portable.

## Structure

```
arena/
├── components/Layout.tsx   # Nav + footer wrapper
├── pages/
│   ├── _app.tsx
│   ├── _document.tsx
│   ├── index.tsx           # Landing page
│   └── play.tsx            # Get started / play page
└── styles/globals.css      # Design system (dark purple/gold)
```

## Dev

```bash
npm install
npm run dev        # http://localhost:3000/arena
```

## Build & Deploy

```bash
npm run build      # Outputs static files to out/
```

The `out/` folder is a fully static export. Copy it to any host under the `/arena` path, or deploy to Vercel/Netlify.

### Deploying under headlineodds.fun/arena

The `basePath` in `next.config.js` is already set to `/arena`. When deploying:

- **Vercel / Netlify**: deploy this folder as a separate project, set the base path in the platform settings.
- **Static host (nginx/Caddy)**: serve the `out/` folder at `/arena`.
- **Same repo as headlineodds.fun**: this folder is self-contained — copy or symlink `arena/` into the root website repo.

## Customisation

- Update the bot URL in `pages/play.tsx` (`BOT_URL` constant).
- Swap stats in `pages/index.tsx` once you have real numbers.
- Add `public/favicon.ico` and `public/og-image.png` for full SEO.
