// Basic statistics helpers.

export const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)
export const mean = (a: number[]) => (a.length ? sum(a) / a.length : NaN)

/** Sample standard deviation (n-1). */
export function stdev(a: number[]): number {
  if (a.length < 2) return NaN
  const m = mean(a)
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1))
}

/** Complementary error function, relative error < 1.2e-7 everywhere (Numerical Recipes erfcc). */
export function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    )
  return x >= 0 ? r : 2 - r
}

/** Standard normal CDF. */
export const normalCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2)

/** Two-sided 95% Student t critical value for the given degrees of freedom. */
export function tCrit95(df: number): number {
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086,
    25: 2.06, 30: 2.042, 40: 2.021, 60: 2.0, 120: 1.98,
  }
  if (df < 1) return NaN
  if (table[df]) return table[df]
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b)
  for (let i = 0; i < keys.length - 1; i++) {
    if (df > keys[i] && df < keys[i + 1]) {
      const f = (df - keys[i]) / (keys[i + 1] - keys[i])
      return table[keys[i]] + f * (table[keys[i + 1]] - table[keys[i]])
    }
  }
  return 1.96
}

/**
 * Anderson-Darling normality test (with estimated mean and sd).
 * Returns the adjusted statistic A*^2 and an approximate p-value (D'Agostino & Stephens, 1986).
 */
export function andersonDarling(values: number[]): { a2: number; p: number } {
  const n = values.length
  if (n < 8) return { a2: NaN, p: NaN }
  const m = mean(values)
  const s = stdev(values)
  if (!(s > 0)) return { a2: NaN, p: NaN }
  const z = [...values].sort((a, b) => a - b).map((x) => (x - m) / s)
  const eps = 1e-15
  const cdf = z.map((v) => Math.min(1 - eps, Math.max(eps, normalCdf(v))))
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc += (2 * (i + 1) - 1) * (Math.log(cdf[i]) + Math.log(1 - cdf[n - 1 - i]))
  }
  const a2 = -n - acc / n
  const as = a2 * (1 + 0.75 / n + 2.25 / (n * n))
  let p: number
  if (as >= 0.6) p = Math.exp(1.2937 - 5.709 * as + 0.0186 * as * as)
  else if (as > 0.34) p = Math.exp(0.9177 - 4.279 * as - 1.38 * as * as)
  else if (as > 0.2) p = 1 - Math.exp(-8.318 + 42.796 * as - 59.938 * as * as)
  else p = 1 - Math.exp(-13.436 + 101.14 * as - 223.73 * as * as)
  return { a2: as, p: Math.min(1, Math.max(0, p)) }
}
