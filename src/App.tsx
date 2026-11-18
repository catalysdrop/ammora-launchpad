import { useCallback, useEffect, useState } from "react";
import { erc20Abi, isAddress, type Address } from "viem";
import {
  CHAIN_ID,
  DEPLOYMENT,
  EXPLORER_URL,
  FACTORY,
  REGISTRY,
  explorerAddress,
  getBalances,
  getPublicClient,
} from "./lib/ammora";
import { loadLaunches, removeLaunch, saveLaunch, type SavedLaunch } from "./lib/store";
import { shortAddr } from "./lib/format";
import { WalletPanel, connectWallet, type WalletState } from "./components/WalletPanel";
import { CreateLaunch } from "./components/CreateLaunch";
import { LaunchDetail } from "./components/LaunchDetail";

type DeployStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; contracts: number; block: string }
  | { kind: "error"; message: string };

export default function App() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [launches, setLaunches] = useState<SavedLaunch[]>(() => loadLaunches());
  const [openCurve, setOpenCurve] = useState<SavedLaunch | null>(null);
  const [importCurve, setImportCurve] = useState("");
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ kind: "idle" });
  const [appError, setAppError] = useState("");

  const refreshWallet = useCallback(async () => {
    if (!wallet) return;
    try {
      const balances = await getBalances(getPublicClient(), wallet.address);
      setWallet({ ...wallet, ...balances });
    } catch (e) {
      setAppError(e instanceof Error ? e.message : String(e));
    }
  }, [wallet]);

  const checkDeployment = useCallback(async () => {
    setDeployStatus({ kind: "checking" });
    try {
      const client = getPublicClient();
      const chainId = await client.getChainId();
      if (chainId !== CHAIN_ID) throw new Error(`RPC reports chain ${chainId}, expected ${CHAIN_ID}.`);
      const [factoryCode, registryCode] = await Promise.all([
        client.getCode({ address: FACTORY }),
        client.getCode({ address: REGISTRY }),
      ]);
      if (!factoryCode || factoryCode === "0x") throw new Error("Launch factory has no code on this chain.");
      if (!registryCode || registryCode === "0x") throw new Error("Config registry has no code on this chain.");
      const block = await client.getBlockNumber();
      setDeployStatus({ kind: "ok", contracts: 2, block: block.toString() });
    } catch (e) {
      setDeployStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    checkDeployment();
  }, [checkDeployment]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onAccounts = (accounts: unknown) => {
      const list = accounts as string[];
      if (!list[0]) setWallet(null);
      else if (wallet && list[0].toLowerCase() !== wallet.address.toLowerCase()) {
        connectWallet().then(setWallet).catch((e) => setAppError(e instanceof Error ? e.message : String(e)));
      }
    };
    const onChain = (chainIdHex: unknown) => {
      // The wallet moved chains after connecting. If it left GIWA Sepolia,
      // drop the session instead of showing GIWA balances for another chain;
      // every send re-checks the wallet chain as well.
      if (String(chainIdHex).toLowerCase() !== `0x${CHAIN_ID.toString(16)}`) {
        setWallet(null);
        setAppError(
          `Wallet moved to chain ${String(chainIdHex)}. This app only works on GIWA Sepolia (${CHAIN_ID}) — switch back in your wallet and reconnect.`,
        );
      } else {
        setAppError("");
        refreshWallet();
      }
    };
    eth.on("accountsChanged", onAccounts as (...args: unknown[]) => void);
    eth.on("chainChanged", onChain as (...args: unknown[]) => void);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts as (...args: unknown[]) => void);
      eth.removeListener?.("chainChanged", onChain as (...args: unknown[]) => void);
    };
  }, [wallet, refreshWallet]);

  const onLaunchCreated = () => {
    setLaunches(loadLaunches());
  };

  const openLaunch = (launch: SavedLaunch) => setOpenCurve(launch);

  const importByCurve = async () => {
    setAppError("");
    const curve = importCurve.trim();
    if (!isAddress(curve)) return setAppError("Enter a valid curve contract address.");
    try {
      const client = getPublicClient();
      const { readCurve } = await import("./lib/ammora");
      const view = await readCurve(client, curve as Address);
      // Read the token's own name/symbol instead of showing a truncated
      // address; a token without ERC-20 metadata falls back to the address.
      const [tokenName, tokenSymbol] = await Promise.all([
        client.readContract({ abi: erc20Abi, address: view.state.baseToken, functionName: "name" }).catch(() => ""),
        client.readContract({ abi: erc20Abi, address: view.state.baseToken, functionName: "symbol" }).catch(() => ""),
      ]);
      const launch: SavedLaunch = {
        configId: view.state.configId.toString(),
        configHash: "",
        token: view.state.baseToken,
        curve: curve as Address,
        name: String(tokenName) || view.state.baseToken.slice(0, 10),
        symbol: String(tokenSymbol) || "?",
        creator: view.state.creator,
        createdBlock: view.blockNumber.toString(),
        configTx: "",
        launchTx: "",
        createdAt: new Date().toISOString(),
      };
      saveLaunch(launch);
      setLaunches(loadLaunches());
      setOpenCurve(launch);
      setImportCurve("");
    } catch (e) {
      setAppError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <header>
        <div>
          <h1>Ammora Launchpad</h1>
          <p className="tagline">
            Ship a token on Ammora (GIWA Sepolia testnet) — Config → launch → trade the curve →
            graduate. All testnet, no real funds.
          </p>
        </div>
        <div className="deploy-badge">
          {deployStatus.kind === "idle" && <span>Deployment: not checked yet</span>}
          {deployStatus.kind === "checking" && <span>Deployment: checking…</span>}
          {deployStatus.kind === "ok" && (
            <span>
              ✓ Deployment reachable · factory + registry have code · block {deployStatus.block}
            </span>
          )}
          {deployStatus.kind === "error" && (
            <span className="err">
              Deployment check failed: neither GIWA Sepolia RPC endpoint (official nor the Pocket
              fallback) responded in time from this network. The app re-checks before every
              transaction — tap Re-check to try again.
              <details>
                <summary>Technical details</summary>
                {deployStatus.message}
              </details>
            </span>
          )}
          <button className="btn small" onClick={checkDeployment}>Re-check</button>
        </div>
      </header>

      <div className="notice">
        <strong>Testnet only.</strong> GIWA Sepolia (chain 91342). Test ETH and test tokens have no
        monetary value. Every transaction is previewed here first and signed only in your own
        wallet. Deployment: <code>{DEPLOYMENT.slot}</code> · source{" "}
        <code>{DEPLOYMENT.sourceCommit.slice(0, 12)}</code> · factory{" "}
        <a href={explorerAddress(FACTORY)} target="_blank" rel="noreferrer">{shortAddr(FACTORY)}</a>
        {" · "}registry{" "}
        <a href={explorerAddress(REGISTRY)} target="_blank" rel="noreferrer">{shortAddr(REGISTRY)}</a>
        {" · "}explorer <a href={EXPLORER_URL} target="_blank" rel="noreferrer">sepolia-explorer.giwa.io</a>
      </div>

      {appError && <p className="err">{appError}</p>}

      {openCurve ? (
        <LaunchDetail
          wallet={wallet}
          launch={openCurve}
          onBack={() => {
            setOpenCurve(null);
            setLaunches(loadLaunches());
          }}
        />
      ) : (
        <>
          <WalletPanel
            wallet={wallet}
            onConnect={setWallet}
            onDisconnect={() => setWallet(null)}
            onRefresh={refreshWallet}
            busy={false}
          />

          {wallet ? (
            <CreateLaunch
              wallet={wallet}
              onLaunchCreated={(launch) => {
                onLaunchCreated();
                setOpenCurve(launch);
              }}
            />
          ) : (
            <section className="card">
              <h2>2 · Create a launch</h2>
              <p className="muted">Connect your wallet above to create a launch.</p>
            </section>
          )}

          <section className="card">
            <h2>3 · My launches</h2>
            {launches.length === 0 ? (
              <p className="muted">No launches yet in this browser. Create one above, or import a curve by address.</p>
            ) : (
              <ul className="launches">
                {launches.map((l) => (
                  <li key={l.curve}>
                    <button className="launch-row" onClick={() => openLaunch(l)}>
                      <strong>{l.name} ({l.symbol})</strong>
                      <span>Config #{l.configId} · curve {shortAddr(l.curve)}</span>
                    </button>
                    <button className="btn small" onClick={() => setLaunches(removeLaunch(l.curve))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              <input
                value={importCurve}
                onChange={(e) => setImportCurve(e.target.value)}
                placeholder="Import by curve address 0x…"
                aria-label="Curve address to import"
              />
              <button className="btn" onClick={importByCurve}>Import curve</button>
            </div>
            <p className="muted small">
              Imported curves are authenticated against the reviewed factory before any quote is
              shown. Launches are stored only in this browser (localStorage).
            </p>
          </section>

          <section className="card">
            <h2>How it works</h2>
            <ol>
              <li><strong>Connect</strong> your wallet on GIWA Sepolia. Get test ETH from the GIWA faucet; wrap some to WETH for buys.</li>
              <li><strong>Create a Config</strong> — derived from reviewed template #6, with your wallet as owner, partner (fee claimer), LP partner and leftover receiver. One signature.</li>
              <li><strong>Create the token</strong> on that Config. One signature, 0 pool creation fee. The token and its bonding curve (ALC) are created on-chain.</li>
              <li><strong>Trade</strong> on the curve: buy with WETH, sell back. Each trade is quoted, simulated and approved for the exact amount only.</li>
              <li><strong>Graduate</strong>: once the quote threshold is reached, a final-fill buy (if needed) plus a migrate transaction moves the market to the ARL pool.</li>
            </ol>
            <p className="muted small">
              Built with @ammora-protocol/sdk 0.3.9 on GIWA Sepolia · auto-route V4 · concentrated
              graduation. No token here is an investment; testnet launches exist to demonstrate the
              Ammora SDK flow for the Builder Mission.
            </p>
          </section>
        </>
      )}

      <footer>
        <p className="muted small">
          Ammora Launchpad — testnet demo for the Ammora Builder Mission. Not affiliated with
          Ammora Labs. Ammora SDK 0.3.9 · GIWA Sepolia 91342.
        </p>
      </footer>
    </div>
  );
}
