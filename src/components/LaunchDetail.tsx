import { useCallback, useEffect, useState } from "react";
import { erc20Abi, parseUnits, type Address } from "viem";
import {
  CHAIN_ID,
  TOKEN_DECIMALS,
  WETH,
  curveClient,
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

  const [claims, setClaims] = useState<{
    partnerFee: { claimable: bigint; to: Address; data: `0x${string}` } | null;
    partnerFeeNote: string;
    surplus: { to: Address; data: `0x${string}` } | null;
    surplusNote: string;
    leftover: { to: Address; data: `0x${string}` } | null;
    leftoverNote: string;
  } | null>(null);
  const [claimsBusy, setClaimsBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");

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
      if (dir === "buy" && wallet && amountIn > wallet.weth) {
        throw new Error(
          `Amount exceeds your WETH balance (${fmt(wallet.weth, 18)} WETH). Wrap more ETH or reduce the amount.`,
        );
      }
      if (dir === "sell" && userTokenBalance !== null && amountIn > userTokenBalance) {
        throw new Error(
          `Amount exceeds your ${launch.symbol} balance (${fmt(userTokenBalance, tokenInfo?.decimals ?? TOKEN_DECIMALS)}). Reduce the amount.`,
        );
      }
      if (dir === "sell" && view && view.state.quoteReserve === 0n) {
        throw new Error("This curve holds no WETH yet, so a sell cannot pay out. Buy first, then sell.");
      }
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
      // Fresh quote at send time: the displayed quote may be stale, and the
      // SDK planner needs allowPartialFill=true exactly when the fresh fill
      // is a graduation-boundary fill (a buy larger than the remaining
      // threshold). A buy of exactly the remaining amount is a "full" fill,
      // not a boundary fill — both kinds are executable here.
      const fresh = await quoteTrade(client, launch.curve as Address, quote.q.amountIn, baseForQuote);
      if (fresh.fillKind !== "full" && fresh.fillKind !== "graduation-boundary") {
        throw new Error(`Fresh quote is ${fresh.fillKind}. Reduce the amount or use the graduation flow.`);
      }
      const planned = await planTrade(
        client,
        launch.curve as Address,
        quote.q.amountIn,
        baseForQuote,
        wallet.address,
        50,
        fresh.fillKind === "graduation-boundary",
      );
      if (planned.quote.fillKind !== "full" && planned.quote.fillKind !== "graduation-boundary") {
        throw new Error(`Fresh plan is ${planned.quote.fillKind}, not a full or graduation-boundary fill. Re-quote before buying.`);
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
          // The only spender this app ever approves is the curve itself, and
          // only for WETH (buys) or the launch token (sells), exact amount.
          { spender: launch.curve as Address, tokens: [WETH, launch.token as Address] },
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

  const checkClaims = async () => {
    if (!wallet || !view) return;
    setClaimsBusy(true);
    setClaimMsg("");
    setError("");
    try {
      const client = getPublicClient();
      const sdk = curveClient(client, launch.curve as Address);
      // Each claim is planned read-only first. The SDK throws a clear error
      // when a claim is not available (wrong caller, nothing funded, or the
      // curve has not reached the required stage) — that becomes an info
      // note, not a failure.
      let partnerFee: { claimable: bigint; to: Address; data: `0x${string}` } | null = null;
      let partnerFeeNote = "";
      try {
        const p = await sdk.planClaimPartnerPoolCreationFee({ caller: wallet.address });
        partnerFee = p.claimable > 0n ? { claimable: p.claimable, to: p.transaction.to, data: p.transaction.data } : null;
        partnerFeeNote = p.claimable > 0n ? "" : "No partner pool-creation fee is claimable for this launch.";
      } catch (e) {
        partnerFeeNote = e instanceof Error ? e.message : String(e);
      }
      let surplus: { to: Address; data: `0x${string}` } | null = null;
      let surplusNote = "";
      try {
        const s = await sdk.planClaimSurplus(wallet.address);
        surplus = { to: s.transaction.to, data: s.transaction.data };
      } catch (e) {
        surplusNote = e instanceof Error ? e.message : String(e);
      }
      let leftover: { to: Address; data: `0x${string}` } | null = null;
      let leftoverNote = "";
      try {
        const l = await sdk.planWithdrawLeftover(wallet.address);
        leftover = { to: l.transaction.to, data: l.transaction.data };
      } catch (e) {
        leftoverNote = e instanceof Error ? e.message : String(e);
      }
      setClaims({ partnerFee, partnerFeeNote, surplus, surplusNote, leftover, leftoverNote });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaimsBusy(false);
    }
  };

  const executeClaim = async (kind: "partnerFee" | "surplus" | "leftover") => {
    if (!wallet || !claims) return;
    const label =
      kind === "partnerFee"
        ? "Claim partner pool-creation fee"
        : kind === "surplus"
          ? "Claim surplus"
          : "Withdraw leftover";
    const entry = kind === "partnerFee" ? claims.partnerFee : kind === "surplus" ? claims.surplus : claims.leftover;
    if (!entry) return;
    setTradeBusy(true);
    setError("");
    setClaimMsg("");
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      const { hash } = await sendTransaction(
        client,
        walletClient,
        wallet.address,
        { to: entry.to, data: entry.data },
        label,
      );
      setClaimMsg(`${label} confirmed. Tx ${shortHash(hash)}`);
      setClaims(null);
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
      {error && !view && !loading && (
        <div className="row">
          <button className="btn" onClick={refresh}>Retry loading curve state</button>
        </div>
      )}
      {!view && !loading && !error && (
        <p className="muted">Curve state could not be loaded. <button className="btn small" onClick={refresh}>Retry</button></p>
      )}

      {view && (
        <>
          <details>
            <summary>Full addresses (verify before signing)</summary>
            <dl className="facts">
              <div><dt>Token</dt><dd className="mono">{launch.token}</dd></div>
              <div><dt>Curve</dt><dd className="mono">{launch.curve}</dd></div>
              <div><dt>Config</dt><dd>#{launch.configId}</dd></div>
            </dl>
          </details>
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

          {(view.state.status === 2 || view.state.status === 3) && (
            <>
              <h3>Fee claims</h3>
              <p className="muted">
                As Config owner / partner / leftover receiver you can claim the partner share of the
                pool-creation fee, any surplus quote, and leftover tokens. Each claim is planned
                read-only first and previewed before you sign; unavailable claims explain why.
              </p>
              <div className="row">
                <button className="btn" onClick={checkClaims} disabled={claimsBusy || tradeBusy || !wallet}>
                  {claimsBusy ? "Checking…" : "Check what I can claim"}
                </button>
                {!wallet && <span className="muted">Connect your wallet to check claims.</span>}
              </div>
              {claims && (
                <dl className="facts">
                  <div>
                    <dt>Partner pool-creation fee</dt>
                    <dd>
                      {claims.partnerFee ? (
                        <>{fmt(claims.partnerFee.claimable, 18)} ETH{" "}
                          <button className="btn small" onClick={() => executeClaim("partnerFee")} disabled={tradeBusy}>Claim</button></>
                      ) : (
                        <span className="muted">{claims.partnerFeeNote || "Nothing claimable."}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Surplus quote</dt>
                    <dd>
                      {claims.surplus ? (
                        <button className="btn small" onClick={() => executeClaim("surplus")} disabled={tradeBusy}>Claim surplus</button>
                      ) : (
                        <span className="muted">{claims.surplusNote || "Nothing claimable."}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Leftover tokens</dt>
                    <dd>
                      {claims.leftover ? (
                        <button className="btn small" onClick={() => executeClaim("leftover")} disabled={tradeBusy}>Withdraw leftover</button>
                      ) : (
                        <span className="muted">{claims.leftoverNote || "Nothing claimable."}</span>
                      )}
                    </dd>
                  </div>
                </dl>
              )}
              {claimMsg && <p className="ok">{claimMsg}</p>}
            </>
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
                <button className="btn" onClick={() => getQuote("buy")} disabled={tradeBusy || !tokenInfo}>Quote buy</button>
                <button className="btn" onClick={() => getQuote("sell")} disabled={tradeBusy || !tokenInfo}>Quote sell</button>
                <button className="btn" onClick={refresh} disabled={tradeBusy}>Refresh</button>
              </div>
              {!tokenInfo && <p className="muted">Loading token info… quotes unlock once the token symbol and decimals are read.</p>}

              {quote && (
                <div className="quote">
                  <p>
                    {quote.dir === "buy" ? "Buy" : "Sell"} {fmt(quote.q.amountIn, quote.dir === "buy" ? 18 : (tokenInfo?.decimals ?? TOKEN_DECIMALS))}{" "}
                    → expected {fmt(quote.q.amountOut, quote.dir === "buy" ? (tokenInfo?.decimals ?? TOKEN_DECIMALS) : 18)}{" "}
                    {quote.dir === "buy" ? launch.symbol : "WETH"} · fee{" "}
                    {fmt(quote.q.fee, quote.dir === "buy" ? 18 : (tokenInfo?.decimals ?? TOKEN_DECIMALS))} · min out{" "}
                    {fmt(quote.q.minimumAmountOut, quote.dir === "buy" ? (tokenInfo?.decimals ?? TOKEN_DECIMALS) : 18)} · fill: {quote.q.fillKind}
                  </p>
                  <p className="small">
                    Quoted at finalized block {quote.q.blockNumber.toString()} · approval (exact amount only, never
                    unlimited) goes to the curve <span className="mono">{launch.curve}</span> for{" "}
                    {quote.dir === "buy" ? "WETH" : launch.symbol} · the quote is re-checked at send time and the
                    swap must confirm within 20 minutes of signing (on-chain deadline).
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
                      // Buying exactly the remaining amount is a "full" fill;
                      // buying more is a "graduation-boundary" fill. Either
                      // one completes the threshold.
                      if (q.fillKind !== "graduation-boundary" && q.fillKind !== "full") throw new Error(`Expected a full or graduation-boundary quote, got ${q.fillKind}.`);
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
