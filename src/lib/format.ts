import { formatUnits } from "viem";

export const shortAddr = (addr: string) =>
  addr.length > 13 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

export const shortHash = (hash: string) =>
  hash.length > 13 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;

export const fmt = (raw: bigint, decimals: number, maxDp = 6) => {
  const s = formatUnits(raw, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxDp).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
};

/** Human price of 1 base token in quote, from the curve's sqrt price (X64). */
export function priceFromSqrt(
  sqrtPriceX64: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  // price (quote-raw per base-raw) = sqrt^2 / 2^128, then adjust decimals.
  const sqrt = Number(sqrtPriceX64);
  const raw = (sqrt * sqrt) / 2 ** 128;
  return raw * 10 ** (baseDecimals - quoteDecimals);
}

export const pct = (num: bigint, den: bigint) =>
  den === 0n ? 0 : Math.min(100, Number((num * 10_000n) / den) / 100);
