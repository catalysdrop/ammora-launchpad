/**
 * Config derivation, ported from the public Ammora examples
 * (ammora-examples/src/launch/config-from-template.ts and
 * src/launch/team/policy.ts, MIT). The examples' own guidance: derive the
 * full Config from a reviewed template instead of hand-writing ~50 coupled
 * fields — a hand-written Config can graduate into a state that never
 * reconciles.
 *
 * Recipients are ALWAYS set explicitly from the connected wallet here:
 * configOwner, partnerRecipient (fee claimer), liquidityDistribution.partner
 * (LP partner) and leftoverReceiver. Nothing is copied from the template's
 * example wallet.
 */
import {
  AmmoraV4MigrationMode,
  assertAmmoraV4Config,
  buildCreateAmmoraV4Config,
  buildSingleSegmentCurve,
  concentratedDepositQuote,
  type AmmoraV4Config,
  type AmmoraV4ConfigSnapshot,
  type AmmoraV4Segment,
} from "@ammora-protocol/sdk";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type DerivedConfig = {
  config: AmmoraV4Config;
  curve: readonly AmmoraV4Segment[];
  economics: {
    saleAllocationRaw: bigint;
    grossMigrationBaseRaw: bigint;
    grossMigrationQuoteRaw: bigint;
    migrationQuoteFeeRaw: bigint;
    quoteSurplusToProtocolRaw: bigint;
    lockedBaseRaw: bigint;
    totalSupplyRaw: bigint;
  };
};

export function deriveConfigFromTemplate(
  template: Pick<AmmoraV4ConfigSnapshot, "config">,
  saleSupply: bigint,
  migrationQuoteThreshold: bigint,
): DerivedConfig {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) {
    throw new RangeError("sale supply and quote threshold must be positive");
  }
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError(
      "this helper supports concentrated graduation only; use a reviewed compounding authoring policy instead",
    );
  }
  const curve = buildSingleSegmentCurve(
    template.config.startSqrtPrice,
    saleSupply,
    migrationQuoteThreshold,
  );
  const segment = curve[0];
  if (!segment) throw new Error("single-segment curve construction returned no segment");
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee = (migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps)) / 10_000n;
  const quoteAfterFee = migrationQuoteThreshold - quoteFee;
  const destination = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase =
    vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config: AmmoraV4Config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return {
    config,
    curve,
    economics: {
      saleAllocationRaw: saleSupply,
      grossMigrationBaseRaw: destination.baseAmount,
      grossMigrationQuoteRaw: destination.quoteAmount,
      migrationQuoteFeeRaw: quoteFee,
      quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
      lockedBaseRaw: lockedBase,
      totalSupplyRaw: config.totalSupply,
    },
  };
}

export type TeamRecipients = {
  configOwner: Address;
  partnerRecipient: Address;
  liquidityPartner: Address;
  leftoverReceiver: Address;
};

export type TeamConfigPlan = DerivedConfig & {
  config: AmmoraV4Config;
  transaction: { to: Address; data: Hex };
  reviewHash: Hex;
  recipients: {
    configOwner: Address;
    partnerRecipient: { inherited: Address; selected: Address };
    liquidityPartner: { inherited: Address; selected: Address };
    leftoverReceiver: { inherited: Address; selected: Address };
    creator: string;
  };
};

/** Derive a Config from template #6 with the user's wallet in all four roles. */
export function planTeamConfig(
  template: AmmoraV4ConfigSnapshot,
  recipients: TeamRecipients,
  registry: Address,
  chainId: number,
  saleSupply: bigint,
  quoteThreshold: bigint,
): TeamConfigPlan {
  if (!template.enabled) throw new Error("Template Config is disabled.");
  const derived = deriveConfigFromTemplate(template, saleSupply, quoteThreshold);
  const config: AmmoraV4Config = {
    ...derived.config,
    partnerRecipient: recipients.partnerRecipient,
    leftoverReceiver: recipients.leftoverReceiver,
    liquidityDistribution: {
      ...derived.config.liquidityDistribution,
      partner: recipients.liquidityPartner,
    },
  };
  assertAmmoraV4Config(config, derived.curve);
  const built = buildCreateAmmoraV4Config(config, derived.curve, recipients.configOwner);
  const transaction = { to: registry, data: built.data };
  // Bind the review to chain, target, value and exact calldata: any change to
  // a recipient, supply, threshold, template or owner needs a fresh preview.
  const reviewHash = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [BigInt(chainId), transaction.to, 0n, transaction.data],
    ),
  );
  return {
    ...derived,
    config,
    transaction,
    reviewHash,
    recipients: {
      configOwner: recipients.configOwner,
      partnerRecipient: {
        inherited: template.config.partnerRecipient,
        selected: config.partnerRecipient,
      },
      liquidityPartner: {
        inherited: template.config.liquidityDistribution.partner,
        selected: config.liquidityDistribution.partner,
      },
      leftoverReceiver: {
        inherited: template.config.leftoverReceiver,
        selected: config.leftoverReceiver,
      },
      creator: "Chosen by the separate token-creation step; the Config owner does not automatically become the token creator.",
    },
  };
}
