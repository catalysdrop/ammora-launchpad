# Ammora Launchpad — GIWA Sepolia testnet

A static launchpad web app built with the Ammora SDK (`@ammora-protocol/sdk@0.3.9`)
for the **Ammora Builder Mission** ("Ship an exchange or launchpad with the Ammora SDK").

**Testnet only.** GIWA Sepolia (chain ID 91342). Test ETH and test tokens have no
monetary value. No mainnet, no real funds.

## What it does

1. **Connect wallet** — injected provider (MetaMask / OKX wallet), forced to GIWA
   Sepolia 91342. Shows address, native test ETH + WETH balances, and a
   **Wrap ETH → WETH / Unwrap** helper (the quote asset is WETH, not native ETH).
2. **Create a launch** — form (token name, symbol, sale supply, quote threshold) →
   preview of the exact Config (derived from reviewed template #6) → **sign create
   Config** → verify receipt → preview of the launch call → **sign createLaunch**
   (optional first buy) → the new token address + curve status.
   All recipients default to the connected wallet (owner / creator / partner /
   LP owner / leftover receiver). No example or validation wallet is ever used.
3. **Token / launch page** — live quote + **buy/sell on the ALC bonding curve**,
   curve progress toward graduation, final-fill + **migrate** to the ARL pool once
   the quote threshold is reached, fee claims after graduation.
4. **My launches** — launches created through this app (localStorage) plus
   import-by-curve-address (authenticated against the reviewed factory first).

Every transaction is previewed in the UI (exact calls, amounts, gas estimate)
and simulated before the user signs. Approvals are for the **exact amount** of
that trade only — never unlimited. Nothing is ever signed or broadcast by this
app without the user clicking and confirming in their own wallet.

## Deployment identity (verified from the SDK catalog)

- Slot: `v4-auto-route-20260917`, source commit `258e87b608b8f998e550142531d108e21c7282f6`
- Launch factory `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`
- Config registry `0x6d043014972b87406C4757a5f2d655A24e0b0aF9`
- Fee policy `0x17B44C14F640fD429740FA3220f47a567c62725C`
- Graduation adapter `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263`
- First-buy executor `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451`
- Math module `0xbF5f52525E7415896bCa7f7cBADcEB294dF173ef`
- Concentrated factory `0x9eBD78f3839996014238728b4c9C2f2A4e6759Cb`
- Concentrated position manager `0x089163706d9956d7baeCeDF4eAb4aD6CcE7Ca2D6`
- WETH (wrapped native) `0x4200000000000000000000000000000000000006`

The app re-verifies this deployment in the browser on load (chain id, code at
factory + registry) and re-checks the template + `verifyAmmoraV4CoreAtBlock`
before every send flow. Live on-chain verification from the build VM could not
be completed (the public RPC is unreachable from the VM egress — see
`scripts/verify-deployment-curl.mjs`); the same checks run in the user's browser,
where the RPC is reachable.

## Setup

```bash
npm install
npm run dev        # local dev server
npm run build      # production build -> dist/
npm run preview    # serve the production build locally
```

Node 22/24. No env vars are required — the app uses the public GIWA Sepolia RPC
(`https://sepolia-rpc.giwa.io`) directly from the browser. No private key, seed
phrase, or API key is ever used or stored.

## How the user launches a token (step by step)

1. Open the deployed site in a browser with a wallet (OKX / MetaMask).
2. Get GIWA Sepolia test ETH from the GIWA faucet; connect the wallet.
   The app prompts to add/switch to GIWA Sepolia (chain 91342) if needed.
3. Wrap some test ETH → WETH (buying on the curve uses WETH).
4. Fill in the launch form (name, symbol, sale supply, quote threshold) and
   read the Config preview.
5. **Signature 1 — create Config.** One transaction to the Config registry
   (`createConfig`). Gas only, 0 pool creation fee. This stores the launch
   parameters on-chain; the Config id is shown afterwards.
6. Read the launch preview, then **Signature 2 — createLaunch.** One
   transaction to the launch factory, value 0 (or the first-buy amount if you
   added one). This deploys the token + bonding curve. The token address and
   curve address are shown with explorer links.
7. Trade on the launch page: enter a WETH amount → quote → **signature:
   approve exact amount** (only if allowance is short) → **signature: buy**.
   Selling works the same way (approve the token, then sell). Each step shows
   the quote, the minimum received at 0.5% slippage, and the gas estimate
   before you sign.
8. When the quote threshold is reached: **final-fill buy** (only if the curve
   still needs quote to reach the threshold) → **signature: migrate** → the
   market graduates to the ARL pool. The pool address is shown; **fee claims**
   appear after graduation (partner = your wallet).

## Deploy

### GitHub Pages (current deployment)

```bash
VITE_BASE=/ammora-launchpad/ npm run build
# push dist/ to the gh-pages branch of catalysdrop/ammora-launchpad
# GitHub → repo Settings → Pages → source: gh-pages branch
```

### Netlify (alternative)

```bash
# Drag-and-drop: dist/ into https://app.netlify.com/drop
# or, with the Netlify CLI logged in:
netlify deploy --prod --dir dist
```

`netlify.toml` is included (build command + SPA fallback). The app works from
any static host — no server, no env vars.

## Verification done / not done

Verified (offline, pure SDK functions, no network):

- `scripts/offline-test.mjs` — derivation from template #6: 1 curve segment,
  liquidity > 0; concentrated deposit quote destination base `10204081632818`;
  `assertAmmoraV4Config` OK, totalSupply `1010204081632818`;
  `buildCreateAmmoraV4Config` 2212 bytes calldata; `buildCreateAmmoraV4Launch`
  (empty metadata URI) value 0, 388 bytes.
- `npm run build` — `tsc -b && vite build` passes; `dist/` 780 KB.
- Local render check — production build served by `vite preview`, screenshotted
  in headless Chromium: all sections render (header, deployment badge, testnet
  notice, connect wallet, create launch, my launches, how it works).
  Screenshot: `scripts/shots/01-home.png`.

NOT yet verified (needs the user's wallet in a real browser):

- Connect wallet / chain switch to 91342
- Wrap ETH → WETH
- create Config + createLaunch (2 signatures)
- Buy / sell quotes and executions
- Graduation (final-fill + migrate) and fee claims
- Live deployment verification from the user's browser (the in-app badge)

## Reference

- Docs: https://ammora-docs.vercel.app/guides/partner-quickstart and
  https://ammora-docs.vercel.app/guides/launchpad
- Examples (reference only, not modified): `~/workspace/ammora-examples`
- SDK: `@ammora-protocol/sdk@0.3.9`, `viem@2.58.0`
