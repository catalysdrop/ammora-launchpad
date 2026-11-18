import { useState } from "react";
import { buildCreateAmmoraV4Launch, getAmmoraV4ConfigAtBlock } from "@ammora-protocol/sdk";
import { parseUnits, type Address } from "viem";
import {
  CHAIN_ID,
  FACTORY,
  REGISTRY,
  TOKEN_DECIMALS,
  explorerAddress,
  explorerToken,
  explorerTx,
  getPublicClient,
  getWalletClient,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  readTemplateConfig,
  sendTransaction,
  verifyCore,
  finalizedHead,
} from "../lib/ammora";
import { planTeamConfig, type TeamConfigPlan } from "../lib/derive";
import { fmt, priceFromSqrt, shortHash } from "../lib/format";
import { saveLaunch, type SavedLaunch } from "../lib/store";
import type { WalletState } from "./WalletPanel";

type Step = "form" | "configPreview" | "configDone" | "launchPreview" | "done";

export function CreateLaunch({
  wallet,
  onLaunchCreated,
}: {
  wallet: WalletState;
  onLaunchCreated: (launch: SavedLaunch) => void;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [saleSupply, setSaleSupply] = useState("1000000");
  const [threshold, setThreshold] = useState("0.001");
  const [metadataURI, setMetadataURI] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [plan, setPlan] = useState<TeamConfigPlan | null>(null);
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null);
  const [launchValue, setLaunchValue] = useState<bigint | null>(null);
  const [configId, setConfigId] = useState<bigint | null>(null);
  const [configHash, setConfigHash] = useState("");
  const [configTx, setConfigTx] = useState("");
  const [launchTx, setLaunchTx] = useState("");
  const [token, setToken] = useState<Address | null>(null);
  const [curve, setCurve] = useState<Address | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const recipients = {
    configOwner: wallet.address,
    partnerRecipient: wallet.address,
    liquidityPartner: wallet.address,
    leftoverReceiver: wallet.address,
  };

  const previewConfig = async () => {
    setError("");
    setStatus("");
    if (!name.trim() || !symbol.trim()) return setError("Token name and symbol are required.");
    if (!/^[A-Za-z0-9 ]{1,32}$/.test(name.trim())) return setError("Name: 1–32 letters, numbers or spaces.");
    if (!/^[A-Z0-9]{1,10}$/.test(symbol.trim())) return setError("Symbol: 1–10 uppercase letters or numbers.");
    let supplyRaw: bigint;
    let thresholdRaw: bigint;
    try {
      supplyRaw = parseUnits(saleSupply, TOKEN_DECIMALS);
      thresholdRaw = parseUnits(threshold, 18);
    } catch {
      return setError("Sale supply and quote threshold must be valid decimal numbers.");
    }
    if (supplyRaw <= 0n || thresholdRaw <= 0n) return setError("Sale supply and quote threshold must be positive.");
    setBusy(true);
    try {
      setStatus("Reading live template Config #6 from GIWA Sepolia…");
      const client = getPublicClient();
      const { snapshot } = await readTemplateConfig(client);
      const p = planTeamConfig(snapshot, recipients, REGISTRY, CHAIN_ID, supplyRaw, thresholdRaw);
      const gas = await client.estimateGas({ account: wallet.address, to: p.transaction.to, data: p.transaction.data });
      setPlan(p);
      setGasEstimate(gas);
      setStep("configPreview");
      setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createConfig = async () => {
    if (!plan) return;
    setError("");
    setBusy(true);
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      setStatus("Re-reading the live template and re-checking the preview…");
      const { snapshot } = await readTemplateConfig(client);
      const supplyRaw = parseUnits(saleSupply, TOKEN_DECIMALS);
      const thresholdRaw = parseUnits(threshold, 18);
      const fresh = planTeamConfig(snapshot, recipients, REGISTRY, CHAIN_ID, supplyRaw, thresholdRaw);
      if (fresh.reviewHash.toLowerCase() !== plan.reviewHash.toLowerCase()) {
        throw new Error("The template changed since the preview. Review the fresh preview before signing.");
      }
      const blockNumber = await finalizedHead(client);
      await verifyCore(client, blockNumber);
      setStatus("Waiting for your signature in the wallet — creating Config…");
      const { hash, blockNumber: receiptBlock } = await sendTransaction(
        client,
        walletClient,
        wallet.address,
        { to: plan.transaction.to, data: plan.transaction.data },
        "Create Config",
      );
      setConfigTx(hash);
      const receipt = await client.getTransactionReceipt({ hash });
      const created = parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
      const confirmed = await getAmmoraV4ConfigAtBlock(client, REGISTRY, created.configId, receiptBlock);
      if (
        confirmed.configHash !== created.configHash ||
        confirmed.identity.owner.toLowerCase() !== created.owner.toLowerCase() ||
        confirmed.identity.feeClaimer.toLowerCase() !== created.feeClaimer.toLowerCase()
      ) {
        throw new Error("Receipt does not match the Config stored on-chain. Do not retry; reconcile the receipt first.");
      }
      setConfigId(created.configId);
      setConfigHash(created.configHash);
      setStep("configDone");
      setStatus(`Config #${created.configId} created and verified on-chain.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const previewLaunch = async () => {
    if (configId === null) return;
    setError("");
    setBusy(true);
    try {
      const client = getPublicClient();
      const blockNumber = await finalizedHead(client);
      await verifyCore(client, blockNumber);
      // The pool creation fee comes from YOUR Config on-chain, not from the
      // live template: the template may have changed since the Config was
      // created, and the factory enforces the Config's own fee.
      const configSnapshot = await getAmmoraV4ConfigAtBlock(client, REGISTRY, configId, blockNumber);
      if (configSnapshot.configHash !== configHash) {
        throw new Error("The on-chain Config does not match the Config created in the previous step. Do not sign; reconcile first.");
      }
      const tx = buildCreateAmmoraV4Launch(
        { name: name.trim(), symbol: symbol.trim().toUpperCase(), metadataURI: metadataURI.trim(), creatorMetadataURI: metadataURI.trim(), tokenDecimals: TOKEN_DECIMALS },
        configId,
        configSnapshot.config.poolCreationFee,
      );
      setLaunchValue(tx.value);
      const gas = await client.estimateGas({ account: wallet.address, to: FACTORY, data: tx.data, value: tx.value });
      setGasEstimate(gas);
      setStep("launchPreview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createLaunch = async () => {
    if (configId === null) return;
    setError("");
    setBusy(true);
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      const blockNumber = await finalizedHead(client);
      await verifyCore(client, blockNumber);
      const configSnapshot = await getAmmoraV4ConfigAtBlock(client, REGISTRY, configId, blockNumber);
      if (configSnapshot.configHash !== configHash) {
        throw new Error("The on-chain Config does not match the Config created in the previous step. Do not sign; reconcile first.");
      }
      const tx = buildCreateAmmoraV4Launch(
        { name: name.trim(), symbol: symbol.trim().toUpperCase(), metadataURI: metadataURI.trim(), creatorMetadataURI: metadataURI.trim(), tokenDecimals: TOKEN_DECIMALS },
        configId,
        configSnapshot.config.poolCreationFee,
      );
      setStatus("Waiting for your signature in the wallet — creating the token…");
      const { hash, blockNumber: receiptBlock } = await sendTransaction(
        client,
        walletClient,
        wallet.address,
        { to: FACTORY, ...tx },
        "Create launch",
      );
      setLaunchTx(hash);
      const receipt = await client.getTransactionReceipt({ hash });
      const created = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
      if (created.configId !== configId || created.configHash !== configHash) {
        throw new Error("Launch receipt does not match the Config. Do not retry; reconcile the receipt first.");
      }
      setToken(created.token);
      setCurve(created.curve);
      const launch: SavedLaunch = {
        configId: created.configId.toString(),
        configHash: created.configHash,
        token: created.token,
        curve: created.curve,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        creator: created.creator,
        createdBlock: receiptBlock.toString(),
        configTx,
        launchTx: hash,
        createdAt: new Date().toISOString(),
      };
      saveLaunch(launch);
      onLaunchCreated(launch);
      setStep("done");
      setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>2 · Create a launch</h2>
      <p className="muted">
        Two on-chain steps, each previewed before you sign: <strong>(a) create a Config</strong>{" "}
        derived from reviewed template #6, with your wallet as owner, partner (fee claimer), LP
        partner and leftover receiver; <strong>(b) create the token</strong> on that Config.
        Template #6 uses 9 token decimals, a 1% cliff fee, and concentrated graduation. The
        pool creation fee is 0.
      </p>

      {step === "form" && (
        <>
          <div className="grid">
            <label>
              Token name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Test Rocket" maxLength={32} />
            </label>
            <label>
              Symbol
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. TRKT" maxLength={10} />
            </label>
            <label>
              Sale supply (tokens)
              <input type="number" min="1" step="1" value={saleSupply} onChange={(e) => setSaleSupply(e.target.value)} />
            </label>
            <label>
              Quote threshold (WETH to graduate)
              <input type="number" min="0" step="0.001" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </label>
            <label className="wide">
              Metadata URI (optional)
              <input value={metadataURI} onChange={(e) => setMetadataURI(e.target.value)} placeholder="https://…/token.json — leave empty if none" />
            </label>
          </div>
          <button className="btn primary" onClick={previewConfig} disabled={busy}>
            {busy ? "Reading template…" : "Preview Config"}
          </button>
        </>
      )}

      {step === "configPreview" && plan && (
        <>
          <h3>Config preview — review before signing</h3>
          <dl className="facts">
            <div><dt>Template</dt><dd>#6 · enabled</dd></div>
            <div><dt>Sale allocation</dt><dd>{fmt(plan.economics.saleAllocationRaw, TOKEN_DECIMALS)} {symbol.toUpperCase()}</dd></div>
            <div><dt>Total supply</dt><dd>{fmt(plan.economics.totalSupplyRaw, TOKEN_DECIMALS)} {symbol.toUpperCase()}</dd></div>
            <div><dt>Migration base</dt><dd>{fmt(plan.economics.grossMigrationBaseRaw, TOKEN_DECIMALS)} {symbol.toUpperCase()}</dd></div>
            <div><dt>Quote threshold</dt><dd>{fmt(plan.config.migrationQuoteThreshold, 18)} WETH</dd></div>
            <div><dt>Start price</dt><dd>≈ {priceFromSqrt(plan.config.startSqrtPrice, TOKEN_DECIMALS, 18).toExponential(2)} WETH per token</dd></div>
            <div><dt>Cliff fee</dt><dd>{plan.config.cliffFeeBps} bps (1%)</dd></div>
            <div><dt>Creator share of non-protocol fees</dt><dd>{plan.config.creatorShareOfNonProtocolBps} bps</dd></div>
            <div><dt>Config owner</dt><dd className="mono">{plan.recipients.configOwner} (you)</dd></div>
            <div><dt>Partner (fee claimer)</dt><dd className="mono">{plan.recipients.partnerRecipient.selected} (you)</dd></div>
            <div><dt>LP partner</dt><dd className="mono">{plan.recipients.liquidityPartner.selected} (you)</dd></div>
            <div><dt>Leftover receiver</dt><dd className="mono">{plan.recipients.leftoverReceiver.selected} (you)</dd></div>
            <div><dt>Review hash</dt><dd className="mono">{shortHash(plan.reviewHash)}</dd></div>
            <div><dt>To (Config registry)</dt><dd className="mono">{REGISTRY}</dd></div>
            <div><dt>Calldata</dt><dd>{(plan.transaction.data.length - 2) / 2} bytes · value 0 ETH</dd></div>
            {gasEstimate !== null && <div><dt>Gas estimate</dt><dd>{gasEstimate.toString()} units</dd></div>}
          </dl>
          <div className="row">
            <button className="btn primary" onClick={createConfig} disabled={busy}>
              {busy ? "Waiting for signature…" : "Sign: create Config"}
            </button>
            <button className="btn" onClick={() => setStep("form")} disabled={busy}>Back to form</button>
          </div>
        </>
      )}

      {step === "configDone" && configId !== null && (
        <>
          <h3>Config created ✓</h3>
          <dl className="facts">
            <div><dt>Config ID</dt><dd>#{configId.toString()}</dd></div>
            <div><dt>Config hash</dt><dd className="mono">{shortHash(configHash)}</dd></div>
            <div><dt>Tx</dt><dd><a href={explorerTx(configTx)} target="_blank" rel="noreferrer">{shortHash(configTx)}</a></dd></div>
          </dl>
          <p>Next: create the token on this Config. The token creator will be your wallet.</p>
          <div className="row">
            <button className="btn primary" onClick={previewLaunch} disabled={busy}>
              {busy ? "Checking…" : "Preview token creation"}
            </button>
          </div>
        </>
      )}

      {step === "launchPreview" && configId !== null && (
        <>
          <h3>Token creation preview — review before signing</h3>
          <dl className="facts">
            <div><dt>Token</dt><dd>{name.trim()} ({symbol.trim().toUpperCase()}) · {TOKEN_DECIMALS} decimals</dd></div>
            <div><dt>Config</dt><dd>#{configId.toString()}</dd></div>
            <div><dt>To (launch factory)</dt><dd className="mono">{FACTORY}</dd></div>
            <div><dt>Pool creation fee (value)</dt><dd>{launchValue !== null ? `${fmt(launchValue, 18)} ETH` : "…"}</dd></div>
            <div><dt>Metadata URI</dt><dd>{metadataURI.trim() || "(empty)"}</dd></div>
            {gasEstimate !== null && <div><dt>Gas estimate</dt><dd>{gasEstimate.toString()} units</dd></div>}
          </dl>
          <div className="row">
            <button className="btn primary" onClick={createLaunch} disabled={busy}>
              {busy ? "Waiting for signature…" : "Sign: create token"}
            </button>
            <button className="btn" onClick={() => setStep("configDone")} disabled={busy}>Back</button>
          </div>
        </>
      )}

      {step === "done" && token && curve && (
        <>
          <h3>Launch created ✓</h3>
          <dl className="facts">
            <div><dt>Token</dt><dd><a href={explorerToken(token)} target="_blank" rel="noreferrer" className="mono">{token}</a> · {name.trim()} ({symbol.trim().toUpperCase()})</dd></div>
            <div><dt>Curve (ALC)</dt><dd><a href={explorerAddress(curve)} target="_blank" rel="noreferrer" className="mono">{curve}</a></dd></div>
            <div><dt>Config</dt><dd>#{configId?.toString()}</dd></div>
            <div><dt>Launch tx</dt><dd><a href={explorerTx(launchTx)} target="_blank" rel="noreferrer">{shortHash(launchTx)}</a></dd></div>
          </dl>
          <p>Your launch is saved in this browser. Open it below to buy the first tokens, watch the curve, and graduate it.</p>
          <button className="btn" onClick={() => { setStep("form"); setName(""); setSymbol(""); setMetadataURI(""); setPlan(null); setConfigId(null); setConfigHash(""); setConfigTx(""); setLaunchTx(""); setToken(null); setCurve(null); setGasEstimate(null); setLaunchValue(null); setStatus(""); setError(""); }}>
            Create another launch
          </button>
        </>
      )}

      {status && <p className="ok">{status}</p>}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
