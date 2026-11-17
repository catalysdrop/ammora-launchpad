/**
 * Read-only deployment verification for the Ammora launchpad app.
 *
 * Node's fetch ignores the sandbox egress proxy, so the public RPC is reached
 * through `curl` (the transport this workspace uses for on-chain reads).
 * No private key, no signing, no broadcast — reads only.
 *
 * Usage (from ~/workspace/ammora-launchpad):
 *   node scripts/verify-deployment-curl.mjs [--config <id>]
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, defineChain } from "viem";
import {
  checkContractVerification,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaLegacyNativeCompatibility,
  resolveAmmoraFinalizedHead,
  verifyAmmoraDeploymentRuntime,
} from "@ammora-protocol/sdk";

const RPC_URL = "https://sepolia-rpc.giwa.io";
const execFileAsync = (file, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(file, args, opts, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    ),
  );

/** One JSON-RPC call over curl. */
const rpcCall = async (method, params = []) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const out = await execFileAsync(
    "curl",
    ["-s", "-m", "30", "-X", "POST", RPC_URL, "-H", "Content-Type: application/json", "-d", body],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
};

/** Serialize calls, 600ms apart, like the examples' pacedHttp. */
let tail = Promise.resolve();
let nextStart = 0;
const curlTransport = custom({
  async request({ method, params }) {
    const result = tail.then(async () => {
      await new Promise((r) => setTimeout(r, Math.max(0, nextStart - Date.now())));
      try {
        return await rpcCall(method, params ?? []);
      } finally {
        nextStart = Date.now() + 600;
      }
    });
    tail = result.catch(() => undefined);
    return result;
  },
});

const deployment = giwaSepoliaAutoRouteDeployment;
const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Explorer", url: deployment.chain.blockExplorerUrl },
  },
});
const client = createPublicClient({ chain, transport: curlTransport });

const readRuntimePins = (snapshot, target, generation) => {
  const object = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected a reviewed runtime-pin object");
    return v;
  };
  const root = object(snapshot);
  const profile = object(object(root.deployments)[generation]);
  if (
    root.schemaVersion !== 1 ||
    root.chainId !== String(target.chain.id) ||
    profile.slot !== target.slot ||
    profile.sourceCommit !== target.sourceCommit
  ) {
    throw new Error("Runtime-pin snapshot does not match the selected chain and SDK deployment");
  }
  const pins = {};
  for (const [address, hash] of Object.entries(object(profile.runtimeCodeHashes))) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error("Malformed reviewed runtime pin");
    }
    pins[address.toLowerCase()] = hash;
  }
  const addresses = (v) =>
    typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
      ? [v.toLowerCase()]
      : v && typeof v === "object"
        ? Object.values(v).flatMap(addresses)
        : [];
  for (const address of addresses(target.contracts)) {
    if (!pins[address]) throw new Error(`Missing reviewed runtime pin for ${address}`);
  }
  return pins;
};

const configArg = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : "6";

const main = async () => {
  const actualChainId = await client.getChainId();
  if (actualChainId !== 91342) throw new Error(`RPC chain ${actualChainId} != 91342`);

  const pins = readRuntimePins(
    JSON.parse(readFileSync(new URL("./runtime-pins.giwa.json", import.meta.url), "utf8")),
    deployment,
    "auto-route",
  );
  const runtimePins = { ...pins };
  const compat = giwaSepoliaLegacyNativeCompatibility;
  for (const [address, expected] of [
    [compat.executionRegistry, compat.executionRegistryRuntimeCodeHash],
    [compat.nativeRouter, compat.nativeRouterRuntimeCodeHash],
  ]) {
    runtimePins[address.toLowerCase()] = expected;
  }

  const blockNumber = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
  const runtime = await verifyAmmoraDeploymentRuntime(client, deployment, blockNumber, runtimePins);

  const factory = deployment.contracts.launch.factory;
  const tokenImplementation = await client.readContract({
    address: factory,
    abi: [{ type: "function", name: "tokenImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "tokenImplementation",
    blockNumber,
  });
  const curveImplementation = await client.readContract({
    address: factory,
    abi: [{ type: "function", name: "curveImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "curveImplementation",
    blockNumber,
  });
  const explorer = await Promise.all(
    [
      ["factory", factory],
      ["registry", deployment.contracts.launch.configRegistry],
      ["tokenImplementation", tokenImplementation],
      ["curveImplementation", curveImplementation],
    ].map(async ([name, address]) => {
      const status = await checkContractVerification(address);
      return { name, address, ...status };
    }),
  );

  const nextConfigId = await getAmmoraV4NextConfigId(
    client,
    deployment.contracts.launch.configRegistry,
    blockNumber,
  );
  const config = await getAmmoraV4ConfigAtBlock(
    client,
    deployment.contracts.launch.configRegistry,
    BigInt(configArg),
    blockNumber,
  );

  const stringify = (v) => (typeof v === "bigint" ? v.toString() : v);
  console.log(
    JSON.stringify(
      {
        chainId: 91342,
        slot: deployment.slot,
        sourceCommit: deployment.sourceCommit,
        blockNumber: blockNumber.toString(),
        runtimeContractsVerified: runtime.contracts.length,
        explorer,
        nextConfigId: nextConfigId.toString(),
        templateConfig: JSON.parse(JSON.stringify(config, (k, v) => stringify(v))),
      },
      null,
      2,
    ),
  );
};

main().catch((err) => {
  console.error(`VERIFY FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
