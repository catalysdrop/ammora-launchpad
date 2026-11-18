import { useState } from "react";
import { parseUnits } from "viem";
import {
  CHAIN_ID,
  RPC_URL,
  WETH,
  WETH_DEPOSIT_DATA,
  WETH_WITHDRAW_DATA,
  explorerAddress,
  getBalances,
  getPublicClient,
  getWalletClient,
  sendTransaction,
} from "../lib/ammora";
import { fmt, shortAddr } from "../lib/format";
import type { Address } from "viem";

export type WalletState = {
  address: Address;
  chainId: number;
  eth: bigint;
  weth: bigint;
  wethDecimals: number;
  wethSymbol: string;
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

async function ensureGiwaChain(): Promise<void> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet found. Open this page in a browser with MetaMask or OKX Wallet.");
  const chainIdHex = await eth.request({ method: "eth_chainId" });
  if (chainIdHex === `0x${CHAIN_ID.toString(16)}`) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${CHAIN_ID.toString(16)}`,
          chainName: "GIWA Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: ["https://sepolia-explorer.giwa.io"],
        },
      ],
    });
  }
}

export async function connectWallet(): Promise<WalletState> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet found. Open this page in a browser with MetaMask or OKX Wallet.");
  await eth.request({ method: "eth_requestAccounts" });
  await ensureGiwaChain();
  const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
  if (!accounts[0]) throw new Error("No account returned by the wallet.");
  const address = accounts[0] as Address;
  // Verify the WALLET's own chain, not just the RPC's: a wallet that did not
  // actually switch (or was switched back) must not be treated as connected.
  const walletChainIdHex = (await eth.request({ method: "eth_chainId" })) as string;
  if (walletChainIdHex.toLowerCase() !== `0x${CHAIN_ID.toString(16)}`) {
    throw new Error(`Wallet is on chain ${walletChainIdHex}; switch to GIWA Sepolia (${CHAIN_ID}) before connecting.`);
  }
  const client = getPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`Wallet is on chain ${chainId}; this app only works on GIWA Sepolia (${CHAIN_ID}).`);
  const balances = await getBalances(client, address);
  return { address, chainId, ...balances };
}

export function WalletPanel({
  wallet,
  onConnect,
  onDisconnect,
  onRefresh,
  busy,
}: {
  wallet: WalletState | null;
  onConnect: (w: WalletState) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const [error, setError] = useState("");
  const [wrapAmount, setWrapAmount] = useState("0.01");
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapMsg, setWrapMsg] = useState("");

  const connect = async () => {
    setError("");
    try {
      onConnect(await connectWallet());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const wrap = async (direction: "wrap" | "unwrap") => {
    if (!wallet) return;
    setWrapMsg("");
    setError("");
    setWrapBusy(true);
    try {
      const client = getPublicClient();
      const walletClient = getWalletClient(wallet.address);
      const amount = parseUnits(wrapAmount || "0", direction === "wrap" ? 18 : wallet.wethDecimals);
      if (amount <= 0n) throw new Error("Amount must be greater than zero.");
      if (direction === "wrap") {
        // Keep a gas reserve: wrapping everything leaves 0 ETH for the gas
        // of the next transaction (and the wrap itself would fail simulation).
        const GAS_RESERVE = parseUnits("0.001", 18);
        if (amount > wallet.eth - GAS_RESERVE) {
          throw new Error("Keep at least 0.001 test ETH aside for gas — reduce the wrap amount.");
        }
        // Wrapping needs no ERC-20 approval.
        const receipt = await sendTransaction(
          client,
          walletClient,
          wallet.address,
          { to: WETH, data: WETH_DEPOSIT_DATA, value: amount },
          `Wrap ${wrapAmount} ETH → WETH`,
        );
        setWrapMsg(`Wrapped. Tx ${receipt.hash.slice(0, 18)}… (block ${receipt.blockNumber})`);
      } else {
        if (amount > wallet.weth) throw new Error("Amount exceeds your WETH balance.");
        const receipt = await sendTransaction(
          client,
          walletClient,
          wallet.address,
          { to: WETH, data: WETH_WITHDRAW_DATA(amount) },
          `Unwrap ${wrapAmount} WETH → ETH`,
        );
        setWrapMsg(`Unwrapped. Tx ${receipt.hash.slice(0, 18)}… (block ${receipt.blockNumber})`);
      }
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWrapBusy(false);
    }
  };

  if (!wallet) {
    return (
      <section className="card">
        <h2>1 · Connect wallet</h2>
        <p>
          Connect your wallet on <strong>GIWA Sepolia (chain 91342)</strong>. All signing happens
          in your wallet — this page never sees a private key.
        </p>
        <button className="btn primary" onClick={connect} disabled={busy}>
          Connect wallet
        </button>
        {error && <p className="err">{error}</p>}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>1 · Wallet</h2>
      <p>
        Connected:{" "}
        <a href={explorerAddress(wallet.address)} target="_blank" rel="noreferrer">
          {shortAddr(wallet.address)}
        </a>{" "}
        · GIWA Sepolia (91342){" "}
        <button className="btn small" onClick={onDisconnect}>
          Disconnect
        </button>{" "}
        <button className="btn small" onClick={onRefresh}>
          Refresh balances
        </button>
      </p>
      <div className="balances">
        <div>
          <span>Native test ETH</span>
          <strong>{fmt(wallet.eth, 18)} ETH</strong>
        </div>
        <div>
          <span>WETH (quote token)</span>
          <strong>
            {fmt(wallet.weth, wallet.wethDecimals)} {wallet.wethSymbol}
          </strong>
        </div>
      </div>
      <p className="muted">
        Ammora launches quote in WETH, not native ETH. Wrap only what you need for buys — keep
        ETH aside for gas.
      </p>
      <div className="row">
        <input
          type="number"
          min="0"
          step="0.001"
          value={wrapAmount}
          onChange={(e) => setWrapAmount(e.target.value)}
          aria-label="Amount to wrap or unwrap"
        />
        <button className="btn" onClick={() => wrap("wrap")} disabled={wrapBusy || busy}>
          Wrap ETH → WETH
        </button>
        <button className="btn" onClick={() => wrap("unwrap")} disabled={wrapBusy || busy}>
          Unwrap WETH → ETH
        </button>
      </div>
      {wrapMsg && <p className="ok">{wrapMsg}</p>}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
