/**
 * Offline pure-function test for the launchpad's core logic.
 * Uses the reviewed example Config document (template #6 shape) from the
 * public Ammora examples — no RPC, no key, no network. Run:
 *   node scripts/offline-test.mjs
 * Exit 0 = derivation + Config calldata + launch calldata all build and
 * validate. This is NOT a substitute for the live on-chain template read
 * the app performs before every real Config creation.
 */
import * as s from "@ammora-protocol/sdk";
import { readFileSync } from "node:fs";

const toBig = (v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v);
const deep = (v) =>
  Array.isArray(v)
    ? v.map(deep)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
      : toBig(v);

const doc = deep(
  JSON.parse(
    readFileSync(
      new URL("../../ammora-examples/src/launch/config-document.example.json", import.meta.url),
      "utf8",
    ),
  ),
);
const template = {
  configId: 6n,
  config: doc.config,
  segments: doc.segments,
  configHash: `0x${"0".repeat(64)}`,
  identity: { owner: doc.configOwner, feeClaimer: doc.config.partnerRecipient, createdAtBlock: 1n },
  enabled: true,
  feePolicy: "0x17B44C14F640fD429740FA3220f47a567c62725C",
  feePolicyVersion: "0x01",
  asOfBlock: 1n,
};

const user = "0x24913082844a33dDE9920CC3a5e152baa991528a"; // test wallet address (user's OKX, used only as a recipient value)
const saleSupply = 1000000000000000n; // 1,000,000 tokens @ 9 decimals
const threshold = 1000000000000000n; // 0.001 WETH

const curve = s.buildSingleSegmentCurve(template.config.startSqrtPrice, saleSupply, threshold);
if (curve.length !== 1 || curve[0].liquidity <= 0n) throw new Error("curve construction failed");
const destination = s.concentratedDepositQuote(
  {
    sqrtPriceX64: curve[0].upperSqrtPrice,
    sqrtMinPriceX64: curve[0].lowerSqrtPrice,
    sqrtMaxPriceX64: curve[0].upperSqrtPrice * 2n,
  },
  { quoteAmount: threshold },
);
const config = {
  ...template.config,
  totalSupply: saleSupply + destination.baseAmount,
  migrationQuoteThreshold: threshold,
  migrationBaseThreshold: destination.baseAmount,
  postMigrationSqrtMinPrice: curve[0].lowerSqrtPrice,
  postMigrationSqrtMaxPrice: curve[0].upperSqrtPrice * 2n,
  postMigrationLiquidity: destination.liquidity,
  partnerRecipient: user,
  leftoverReceiver: user,
  liquidityDistribution: { ...template.config.liquidityDistribution, partner: user },
};
s.assertAmmoraV4Config(config, curve);
const built = s.buildCreateAmmoraV4Config(config, curve, user);
const launch = s.buildCreateAmmoraV4Launch(
  { name: "Test", symbol: "TEST", metadataURI: "", creatorMetadataURI: "", tokenDecimals: 9 },
  7n,
  0n,
);
console.log(
  JSON.stringify(
    {
      curveSegments: curve.length,
      destinationBaseRaw: destination.baseAmount.toString(),
      totalSupplyRaw: config.totalSupply.toString(),
      assertConfig: "OK",
      createConfigCalldataBytes: (built.data.length - 2) / 2,
      createLaunchValueWei: launch.value.toString(),
      createLaunchCalldataBytes: (launch.data.length - 2) / 2,
    },
    null,
    2,
  ),
);
