// Small seeded random number utilities so simulations are reproducible.

export type Rng = () => number

/** mulberry32: fast, decent-quality 32-bit seeded PRNG returning [0,1). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randNormal(rng: Rng): number {
  // Box-Muller
  let u = 0
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function randExp(rng: Rng, mean: number): number {
  let u = 0
  while (u === 0) u = rng()
  return -mean * Math.log(u)
}
