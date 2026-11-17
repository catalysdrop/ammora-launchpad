/**
 * Ammora SDK wiring for the launchpad web app (GIWA Sepolia testnet only).
 *
 * Everything here is read-only except the functions that return unsigned
 * transaction plans — those are sent only through the user's connected
 * WalletClient, after an on-screen preview, and only after a simulation.
 * No private key is ever read, stored, or used by this app.
 *
 * The flow follows the public Ammora examples (SDK 0.3.9):
 *   template Config #6 -> derive Config -> create Config -> createLaunch
 *   -> buy/sell on the ALC curve (dbc) -> final fill -> migrate (graduate)
 */
import {
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  classifyAmmoraV4ExactInputFill,
  getAmmoraV4ConfigAtBlock,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4LaunchCurveState,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";

export const CHAIN_ID = 91342;
export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const TEMPLATE_CONFIG_ID = 6n;
export const TOKEN_DECIMALS = 9; // template #6
export const SLIPPAGE_BPS_DEFAULT = 50; // 0.5%
export const FINALITY_CONFIRMATIONS = 13;

export const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
export const CORE = {
  configRegistry: DEPLOYMENT.contracts.launch.configRegistry,
  launchFactory: DEPLOYMENT.contracts.launch.factory,
  graduationAdapter: DEPLOYMENT.contracts.launch.graduationAdapter,
  feePolicy: DEPLOYMENT.contracts.launch.feePolicy,
} as const;
export const FACTORY = DEPLOYMENT.contracts.launch.factory;
export const REGISTRY = DEPLOYMENT.contracts.launch.configRegistry;
export const WETH: Address = DEPLOYMENT.contracts.tokens.wrappedNative;

export const GIWA_SEPOLIA = defineChain({
  id: DEPLOYMENT.chain.id,
  name: DEPLOYMENT.chain.name,
  nativeCurrency: DEPLOYMENT.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER_URL } },
});

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER_URL}/address/${address}`;
export const explorerToken = (address: string) => `${EXPLORER_URL}/token/${address}`;

/** Serialize RPC calls, 600ms apart — the public endpoint rate-limits bursts. */
let tail: Promise<unknown> = Promise.resolve();
let nextStart = 0;
const pacedTransport = (parameters: Parameters<ReturnType<typeof http>>[0]) => {
  const base = http(RPC_URL, { retryCount: 0 })(parameters);
  return custom(
    {
      request: (args) => {
        const result = tail.then(async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextStart - Date.now())));
          try {
            return await base.request(args);
          } finally {
            nextStart = Date.now() + 600;
          }
        });
        tail = result.catch(() => undefined);
        return result;
      },
    },
    { retryCount: 0 },
  )(parameters);
};

let publicClient: PublicClient | null = null;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: GIWA_SEPOLIA, transport: pacedTransport });
  }
  return publicClient;
}

export function getWalletClient(account: Address): WalletClient {
  const ethereum = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!ethereum) throw new Error("No injected wallet found (window.ethereum is missing).");
  return createWalletClient({
    account,
    chain: GIWA_SEPOLIA,
    transport: custom(ethereum as never),
  });
}

/** The reviewed confirmation window for reads (head-12 on GIWA Sepolia). */
export async function finalizedHead(client: PublicClient): Promise<bigint> {
  return resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
}

export async function verifyCore(client: PublicClient, blockNumber: bigint): Promise<void> {
  await verifyAmmoraV4CoreAtBlock(client, { ...CORE }, blockNumber);
}

/** Read the reviewed template Config #6 at a finalized block. */
export async function readTemplateConfig(
  client: PublicClient,
): Promise<{ snapshot: AmmoraV4ConfigSnapshot; blockNumber: bigint }> {
  const blockNumber = await finalizedHead(client);
  await verifyCore(client, blockNumber);
  const snapshot = await getAmmoraV4ConfigAtBlock(client, REGISTRY, TEMPLATE_CONFIG_ID, blockNumber);
  if (!snapshot.enabled) throw new Error("Template Config #6 is disabled on-chain.");
  return { snapshot, blockNumber };
}

export function curveClient(client: PublicClient, curve: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(client, curve, {
    launchFactory: FACTORY,
    feePolicy: CORE.feePolicy,
  });
}

export type CurveView = {
  state: AmmoraV4LaunchCurveState;
  progress: { ready: boolean; migrated: boolean; current: bigint; target: bigint };
  blockNumber: bigint;
};

/** Read + authenticate a curve against the reviewed factory and fee policy. */
export async function readCurve(client: PublicClient, curve: Address): Promise<CurveView> {
  const blockNumber = await finalizedHead(client);
  await verifyCore(client, blockNumber);
  const code = await client.getCode({ address: curve, blockNumber });
  if (!code || code === "0x") throw new Error(`No contract at ${curve} on GIWA Sepolia.`);
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  const factoryToken = await client.readContract({
    address: FACTORY,
    abi: ammoraLaunchFactoryV4Abi,
    functionName: "tokenForCurve",
    args: [curve],
    blockNumber,
  });
  if (
    factoryToken.toLowerCase() !== state.baseToken.toLowerCase() ||
    state.feePolicy.toLowerCase() !== CORE.feePolicy.toLowerCase()
  ) {
    throw new Error("Curve is not bound to the reviewed V4 factory and fee policy.");
  }
  const progress = await sdk.getMigrationProgressAtBlock(blockNumber);
  return { state, progress, blockNumber };
}

export type TradeQuote = {
  amountIn: bigint;
  amountOut: bigint;
  amountLeft: bigint;
  fee: bigint;
  fillKind: "full" | "graduation-boundary" | "terminal-dust" | "partial";
  minimumAmountOut: bigint;
  blockNumber: bigint;
};

/** Fresh explicit-block quote for display. Re-quote right before signing. */
export async function quoteTrade(
  client: PublicClient,
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
  slippageBps: number = SLIPPAGE_BPS_DEFAULT,
): Promise<TradeQuote> {
  const blockNumber = await finalizedHead(client);
  await verifyCore(client, blockNumber);
  const sdk = curveClient(client, curve);
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.status !== 1) throw new Error(`Curve status ${state.status} is not active; no trade can be quoted.`);
  const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, blockNumber);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  return {
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    amountLeft: quote.amountLeft,
    fee: quote.fee,
    fillKind: fill.kind,
    minimumAmountOut: (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
    blockNumber,
  };
}

export type PlannedTrade = {
  quote: TradeQuote;
  transaction: { to: Address; data: `0x${string}` };
  approval: { token: Address; spender: Address; amount: bigint } | null;
  deadline: bigint;
};

/** Plan a trade with the SDK curve planner (fresh quote at send time). */
export async function planTrade(
  client: PublicClient,
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
  recipient: Address,
  slippageBps: number = SLIPPAGE_BPS_DEFAULT,
  allowPartialFill = false,
): Promise<PlannedTrade> {
  const block = await client.getBlock({ blockNumber: await finalizedHead(client) });
  const sdk = curveClient(client, curve);
  const planned = await sdk.planSwapExactInput({
    includedAmountIn: amountIn,
    baseForQuote,
    allowPartialFill,
    slippageBps,
    recipient,
    deadline: block.timestamp + 20n * 60n,
  });
  const fill = classifyAmmoraV4ExactInputFill(planned.quote, baseForQuote);
  return {
    quote: {
      amountIn: planned.quote.amountIn,
      amountOut: planned.quote.amountOut,
      amountLeft: planned.quote.amountLeft,
      fee: planned.quote.fee,
      fillKind: fill.kind,
      minimumAmountOut: planned.quote.minimumAmountOut,
      blockNumber: planned.quote.asOfBlock,
    },
    transaction: { to: planned.transaction.to, data: planned.transaction.data },
    approval: planned.approvalRequirement
      ? {
          token: planned.approvalRequirement.token,
          spender: planned.approvalRequirement.spender,
          amount: planned.approvalRequirement.amount,
        }
      : null,
    deadline: block.timestamp + 20n * 60n,
  };
}

/** Plan the permissionless migrate() step after a curve is ReadyToMigrate. */
export async function planMigrate(
  client: PublicClient,
  curve: Address,
): Promise<{ to: Address; data: `0x${string}` }> {
  const blockNumber = await finalizedHead(client);
  const sdk = curveClient(client, curve);
  const migration = await sdk.planMigrateAtBlock(blockNumber);
  return { to: migration.transaction.to, data: migration.transaction.data };
}

/** Exact-amount ERC-20 approval only — never unlimited. */
export async function ensureApproval(
  client: PublicClient,
  wallet: WalletClient,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  onStatus: (msg: string) => void,
): Promise<Hash | null> {
  const allowance = await client.readContract({
    abi: erc20Abi,
    address: token,
    functionName: "allowance",
    args: [account, spender],
  });
  if (allowance >= amount) return null;
  onStatus(`Approving exactly ${amount.toString()} raw units for ${spender.slice(0, 10)}…`);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });
  const receipt = await sendTransaction(client, wallet, account, { to: token, data }, "ERC-20 approval");
  const after = await client.readContract({
    abi: erc20Abi,
    address: token,
    functionName: "allowance",
    args: [account, spender],
    blockNumber: receipt.blockNumber,
  });
  if (after < amount) throw new Error("Approval confirmed but allowance is still below the required amount.");
  return receipt.hash;
}

/**
 * Simulate, then send one transaction through the connected wallet and wait
 * for 13 confirmations. Fails closed: never retries a send.
 */
export async function sendTransaction(
  client: PublicClient,
  wallet: WalletClient,
  account: Address,
  tx: { to: Address; data: `0x${string}`; value?: bigint },
  label: string,
): Promise<{ hash: Hash; blockNumber: bigint }> {
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: account, blockTag: "latest" }),
    client.getTransactionCount({ address: account, blockTag: "pending" }),
  ]);
  if (latestNonce !== pendingNonce) {
    throw new Error(`A transaction is already pending at nonce ${latestNonce}; reconcile it before sending ${label}.`);
  }
  // Simulation first: a revert here costs nothing and names the problem.
  await client.call({ account, ...tx });
  const gas = await client.estimateGas({ account, ...tx });
  const hash = await wallet.sendTransaction({
    account,
    chain: GIWA_SEPOLIA,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    gas,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: FINALITY_CONFIRMATIONS,
    timeout: 180_000,
  });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${explorerTx(hash)}`);
  return { hash, blockNumber: receipt.blockNumber };
}

export { ammoraLaunchPoolV4Abi, parseAmmoraV4ConfigCreatedReceipt, parseAmmoraV4LaunchCreatedReceipt, parseAmmoraV4MigratedReceipt, parseAmmoraV4SwapReceipt };

/** WETH deposit() calldata (0xd0e30db0). Wrapping needs no ERC-20 approval. */
export const WETH_DEPOSIT_DATA = "0xd0e30db0" as const;
export const WETH_WITHDRAW_DATA = (amount: bigint) =>
  encodeFunctionData({
    abi: [{ type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }],
    functionName: "withdraw",
    args: [amount],
  });

export async function getBalances(client: PublicClient, address: Address) {
  const [eth, weth, wethDecimals, wethSymbol] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ abi: erc20Abi, address: WETH, functionName: "balanceOf", args: [address] }),
    client.readContract({ abi: erc20Abi, address: WETH, functionName: "decimals" }),
    client.readContract({ abi: erc20Abi, address: WETH, functionName: "symbol" }),
  ]);
  return { eth, weth, wethDecimals: Number(wethDecimals), wethSymbol: String(wethSymbol) };
}
