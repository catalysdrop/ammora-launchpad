import { useCallback, useEffect, useState } from "react";
import { erc20Abi, parseUnits, type Address } from "viem";
import {
  CHAIN_ID,
  TOKEN_DECIMALS,
  ensureApproval,
  explorerAddress,
  explorerToken,
  getPublicClient,
  getWalletClient,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  planMigrate,
  planTrade,
  quoteTrade,
  readCurve,
  sendTransaction,
  type CurveView,
  type TradeQuote,
} from "../lib/ammora";
import { fmt, pct, priceFromSqrt, shortAddr, shortHash } from "../lib/format";
import type { SavedLaunch } from "../lib/store";
import type { WalletState } from "./WalletPanel";

const STATUS_LABEL: Record<number, string> = {
  1: "Active — trading on the curve",
  2: "Ready to migrate — threshold reached",
  3: "Graduated — trading on the ARL pool",
};

export function LaunchDetail({
  wallet,
  launch,
  onBack,
}: {
  wallet: WalletState | null;
  launch: SavedLaunch;
  onBack: () => void;
}) {
  const [view, setView] = useState<CurveView | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ symbol: string; decimals: number } | null>(null);
  const [userTokenBalance, setUserTokenBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [buyAmount, setBuyAmount] = useState("0.001");
  const [sellAmount, setSellAmount] = useState("");
  const [quote, setQuote] = useState<{ q: TradeQuote; dir: "buy" | "sell" } | null>(null);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeMsg, setTradeMsg] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const client = getPublicClient();
      const v = await readCurve(client, launch.curve as Address);
      setView(v);
      const [symbol, decimals] = await Promise.all([
        client.readContract({ abi: erc20Abi, address: launch.token as Address, functionName: "symbol" }),
        client.readContract({ abi: erc20Abi, address: launch.token as Address, functionName: "decimals" }),
      ]);
      setTokenInfo({ symbol: String(symbol), decimals: Number(decimals) });
      if (wallet) {
        const bal = await client.readContract({
          abi: erc20Abi,
          address: launch.token as Address,
          functionName: "balanceOf",
          args: [wallet.address],
        });
        setUserTokenBalance(bal);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [launch.curve, launch.token, wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const getQuote = async (dir: "buy" | "sell") => {
    setError("");
    setTradeMsg("");
    setQuote(null);
    try {
      const client = getPublicClient();
      const amountIn =
        dir === "buy"
          ? parseUnits(buyAmount || "0", 18)
          : parseUnits(sellAmount || "0", tokenInfo?.decimals ?? TOKEN_DECIMALS);
      if (amountIn <= 0n) throw new Error("Amount must be greater than zero.");
      const q = await quoteTrade(client, launch.curve as Address, amountIn, dir === "sell");
      if (q.fillKind !== "full" && q.fillKind !== "graduation-boundary") {
        throw new Error(`This trade would only partially fill (${q.fillKind}). Reduce the amount or use the graduation flow.`);
      }
      setQuote({ q, dir });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const executeTrade = async (isFinalFill = false) => {
    if (!wallet || !quote) return;
    setTradeBusy(true);
    setError("");
    setTradeMsg("");
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      const baseForQuote = quote.dir === "sell";
      const planned = await planTrade(
        client,
        launch.curve as Address,
        quote.q.amountIn,
        baseForQuote,
        wallet.address,
        50,
        isFinalFill,
      );
      if (!isFinalFill && planned.quote.fillKind !== "full") {
        throw new Error(`Fresh quote is ${planned.quote.fillKind}, not a full fill. Re-quote before buying.`);
      }
      if (isFinalFill && planned.quote.fillKind !== "graduation-boundary") {
        throw new Error(`Fresh quote is ${planned.quote.fillKind}, not the graduation boundary.`);
      }
      if (planned.approval) {
        await ensureApproval(
          client,
          walletClient,
          wallet.address,
          planned.approval.token,
          planned.approval.spender,
          planned.approval.amount,
          (m) => setTradeMsg(m),
        );
      }
      setTradeMsg("Waiting for your signature — swapping…");
      const { hash } = await sendTransaction(
        client,
        walletClient,
        wallet.address,
        { to: planned.transaction.to, data: planned.transaction.data },
        isFinalFill ? "Final fill (graduation buy)" : "Curve swap",
      );
      const receipt = await client.getTransactionReceipt({ hash });
      const parsed = parseAmmoraV4SwapReceipt(receipt, launch.curve as Address, {
        trader: wallet.address,
        recipient: wallet.address,
        baseForQuote,
        requestedAmountIn: quote.q.amountIn,
        minimumAmountOut: planned.quote.minimumAmountOut,
      });
      setTradeMsg(
        `Swap confirmed: received ${fmt(parsed.amountOut, baseForQuote ? 18 : (tokenInfo?.decimals ?? TOKEN_DECIMALS))} ` +
          `${baseForQuote ? "WETH" : launch.symbol} (consumed ${fmt(parsed.consumedAmountIn, baseForQuote ? (tokenInfo?.decimals ?? TOKEN_DECIMALS) : 18)}). Tx ${shortHash(hash)}`,
      );
      setQuote(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTradeBusy(false);
    }
  };

  const migrate = async () => {
    if (!wallet || !view) return;
    setTradeBusy(true);
    setError("");
    setTradeMsg("");
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      const plan = await planMigrate(client, launch.curve as Address);
      setTradeMsg("Waiting for your signature — migrating to the ARL pool…");
      const { hash } = await sendTransaction(
        client,
        walletClient,
        wallet.address,
        { to: plan.to, data: plan.data },
        "Graduate (migrate)",
      );
      const receipt = await client.getTransactionReceipt({ hash });
      const migrated = parseAmmoraV4MigratedReceipt(receipt, launch.curve as Address);
      setTradeMsg(`Graduated! ARL pool: ${migrated.canonicalPool}. Tx ${shortHash(hash)}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTradeBusy(false);
    }
  };

  const remaining =
    view && view.state.status === 1
      ? view.progress.target - view.progress.current
      : 0n;

  return (
    <section className="card">
      <button className="btn small" onClick={onBack}>← My launches</button>
      <h2>
        {launch.name} ({launch.symbol})
      </h2>
      <p className="muted">
        Token{" "}
        <a href={explorerToken(launch.token)} target="_blank" rel="noreferrer">{shortAddr(launch.token)}</a>
        {" · "}Curve{" "}
        <a href={explorerAddress(launch.curve)} target="_blank" rel="noreferrer">{shortAddr(launch.curve)}</a>
        {" · "}Config #{launch.configId} · created block {launch.createdBlock}
      </p>

      {loading && <p>Loading curve state from GIWA Sepolia…</p>}
      {error && <p className="err">{error}</p>}

      {view && (
        <>
          <dl className="facts">
            <div><dt>Status</dt><dd>{STATUS_LABEL[view.state.status] ?? `Unknown (${view.state.status})`}</dd></div>
            <div><dt>Current price</dt><dd>≈ {priceFromSqrt(view.state.sqrtPrice, TOKEN_DECIMALS, 18).toExponential(3)} WETH per {launch.symbol}</dd></div>
            <div><dt>Quote raised</dt><dd>{fmt(view.state.quoteReserve, 18)} / {fmt(view.state.migrationQuoteThreshold, 18)} WETH ({pct(view.progress.current, view.progress.target)}%)</dd></div>
            <div><dt>Base sold</dt><dd>{fmt(view.state.baseReserve, TOKEN_DECIMALS)} {launch.symbol} / {fmt(view.state.migrationBaseThreshold, TOKEN_DECIMALS)} to graduate</dd></div>
            <div><dt>Curve fee</dt><dd>{view.state.currentFeeBps} bps (+{view.state.currentDynamicFeeBps} dynamic)</dd></div>
            <div><dt>Creator</dt><dd>{shortAddr(view.state.creator)}</dd></div>
            <div><dt>Partner (fees)</dt><dd>{shortAddr(view.state.partnerRecipient)}</dd></div>
            {view.state.status === 3 && (
              <div><dt>ARL pool</dt><dd><a href={explorerAddress(view.state.canonicalPool)} target="_blank" rel="noreferrer">{shortAddr(view.state.canonicalPool)}</a></dd></div>
            )}
            <div><dt>As of block</dt><dd>{view.blockNumber.toString()} (finalized head)</dd></div>
          </dl>

          <div className="progress">
            <div style={{ width: `${pct(view.progress.current, view.progress.target)}%` }} />
          </div>

          {view.state.status === 3 && (
            <p className="ok">
              Graduated. The curve migrated to the ARL pool above — post-graduation trading happens
              there, not on this curve.
            </p>
          )}

          {view.state.status === 2 && (
            <div className="row">
              <button className="btn primary" onClick={migrate} disabled={tradeBusy || !wallet}>
                Graduate now (migrate to ARL pool)
              </button>
              {!wallet && <span className="muted">Connect your wallet to migrate.</span>}
            </div>
          )}

          {view.state.status === 1 && wallet && (
            <>
              <h3>Trade on the curve</h3>
              <p className="muted">
                Your balances: {wallet ? `${fmt(wallet.weth, 18)} WETH · ${userTokenBalance !== null ? fmt(userTokenBalance, tokenInfo?.decimals ?? TOKEN_DECIMALS) : "…"} ${launch.symbol}` : "—"}.
                Slippage 0.5%. Quotes are re-checked at send time; the swap enforces a minimum output.
              </p>
              <div className="grid">
                <label>
                  Buy with WETH
                  <input type="number" min="0" step="0.0001" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} />
                </label>
                <label>
                  Sell {launch.symbol}
                  <input type="number" min="0" step="1" value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} placeholder="amount of tokens" />
                </label>
              </div>
              <div className="row">
                <button className="btn" onClick={() => getQuote("buy")} disabled={tradeBusy}>Quote buy</button>
                <button className="btn" onClick={() => getQuote("sell")} disabled={tradeBusy}>Quote sell</button>
                <button className="btn" onClick={refresh} disabled={tradeBusy}>Refresh</button>
              </div>

              {quote && (
                <div className="quote">
                  <p>
                    {quote.dir === "buy" ? "Buy" : "Sell"} {fmt(quote.q.amountIn, quote.dir === "buy" ? 18 : (tokenInfo?.decimals ?? TOKEN_DECIMALS))}{" "}
                    → expected {fmt(quote.q.amountOut, quote.dir === "buy" ? (tokenInfo?.decimals ?? TOKEN_DECIMALS) : 18)}{" "}
                    {quote.dir === "buy" ? launch.symbol : "WETH"} · fee{" "}
                    {fmt(quote.q.fee, quote.dir === "buy" ? 18 : (tokenInfo?.decimals ?? TOKEN_DECIMALS))} · min out{" "}
                    {fmt(quote.q.minimumAmountOut, quote.dir === "buy" ? (tokenInfo?.decimals ?? TOKEN_DECIMALS) : 18)} · fill: {quote.q.fillKind}
                  </p>
                  <button className="btn primary" onClick={() => executeTrade(false)} disabled={tradeBusy}>
                    {tradeBusy ? "Waiting for signature…" : `Confirm ${quote.dir}`}
                  </button>
                </div>
              )}

              <h3>Graduate</h3>
              <p className="muted">
                {fmt(remaining, 18)} WETH of buys remain before the threshold. The final fill buys
                up to that remaining amount (the curve consumes only what fits and leaves the rest
                in your wallet), then a second signature migrates the curve to the ARL pool.
              </p>
              <div className="row">
                <button
                  className="btn"
                  onClick={async () => {
                    setBuyAmount(fmt(remaining, 18));
                    setError("");
                    setTradeMsg("");
                    try {
                      const client = getPublicClient();
                      const q = await quoteTrade(client, launch.curve as Address, remaining, false);
                      if (q.fillKind !== "graduation-boundary") throw new Error(`Expected a graduation-boundary quote, got ${q.fillKind}.`);
                      setQuote({ q, dir: "buy" });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                  disabled={tradeBusy || remaining <= 0n}
                >
                  Quote final fill ({fmt(remaining, 18)} WETH max)
                </button>
                {quote && quote.q.fillKind === "graduation-boundary" && (
                  <button className="btn primary" onClick={() => executeTrade(true)} disabled={tradeBusy}>
                    Confirm final fill
                  </button>
                )}
              </div>
            </>
          )}

          {view.state.status === 1 && !wallet && (
            <p className="muted">Connect your wallet above to trade or graduate this launch.</p>
          )}

          {tradeMsg && <p className="ok">{tradeMsg}</p>}
          {error && <p className="err">{error}</p>}
        </>
      )}
      <p className="muted small">
        Chain {CHAIN_ID} · GIWA Sepolia testnet · All amounts are testnet tokens with no monetary value.
      </p>
    </section>
  );
}
