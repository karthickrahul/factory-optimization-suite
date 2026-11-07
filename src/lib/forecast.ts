// Intermittent-demand forecasting and inventory-policy simulation.
// Mirrors analysis/benchmark.py exactly; src/lib/forecast.test.ts checks parity against its output.

export const BURN = 12 // months used to initialise the smoothing methods

export type ClassicalMethod = 'Zero' | 'Naive' | 'Mean' | 'SES' | 'Croston' | 'SBA' | 'TSB'
export type Method = ClassicalMethod | 'LightGBM'

export const CLASSICAL: ClassicalMethod[] = ['Zero', 'Naive', 'Mean', 'SES', 'Croston', 'SBA', 'TSB']

export const METHOD_INFO: Record<Method, string> = {
  Zero: 'Always forecast zero. A sanity check: it often wins on MAE for sparse parts, yet it is useless for planning.',
  Naive: 'Next month = last month.',
  Mean: 'Average of all history.',
  SES: 'Simple exponential smoothing of the demand level.',
  Croston: 'Smooths demand size and the interval between demands separately (Croston, 1972).',
  SBA: 'Croston with the Syntetos-Boylan bias correction. The usual industry default for spare parts.',
  TSB: 'Smooths the probability of demand and its size, so forecasts decay for parts that stop selling (Teunter et al., 2011).',
  LightGBM: 'Gradient-boosted trees trained across all parts at once (global model), retrained every month. Trained offline in Python.',
}

export interface SmoothingParams {
  alpha: number
  beta: number
}

/**
 * One-step-ahead forecasts. Result has length y.length + 1:
 * f[t] is the forecast for month t made with months < t (NaN for t < BURN),
 * and f[y.length] is the forecast for the next, not yet observed month.
 */
export function forecastSeries(y: number[], method: ClassicalMethod, { alpha: a, beta: b }: SmoothingParams): number[] {
  const T = y.length
  const f = new Array<number>(T + 1).fill(NaN)
  if (T < BURN) return f
  const w = y.slice(0, BURN)
  const nzIdx = w.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0)
  const nzMean = nzIdx.length ? nzIdx.reduce((s, i) => s + w[i], 0) / nzIdx.length : 0

  switch (method) {
    case 'Zero':
      for (let t = BURN; t <= T; t++) f[t] = 0
      return f
    case 'Naive':
      for (let t = BURN; t <= T; t++) f[t] = y[t - 1]
      return f
    case 'Mean': {
      let cs = 0
      for (let t = 0; t < BURN; t++) cs += y[t]
      for (let t = BURN; t <= T; t++) {
        f[t] = cs / t
        if (t < T) cs += y[t]
      }
      return f
    }
    case 'SES': {
      let lvl = w.reduce((s, v) => s + v, 0) / BURN
      for (let t = BURN; t <= T; t++) {
        f[t] = lvl
        if (t < T) lvl = lvl + a * (y[t] - lvl)
      }
      return f
    }
    case 'Croston':
    case 'SBA': {
      const k = method === 'SBA' ? 1 - a / 2 : 1
      let ready = nzIdx.length > 0
      let z = ready ? nzMean : 0
      let p = ready ? BURN / nzIdx.length : 1
      let q = ready ? BURN - nzIdx[nzIdx.length - 1] : BURN + 1
      for (let t = BURN; t <= T; t++) {
        f[t] = ready ? (k * z) / p : 0
        if (t === T) break
        const v = y[t]
        if (v > 0) {
          if (!ready) {
            z = v
            p = q
          } else {
            z = z + a * (v - z)
            p = p + a * (q - p)
          }
          ready = true
          q = 1
        } else q = q + 1
      }
      return f
    }
    case 'TSB': {
      let d = nzIdx.length / BURN
      let z = nzMean
      let ready = nzIdx.length > 0
      for (let t = BURN; t <= T; t++) {
        f[t] = d * z
        if (t === T) break
        const v = y[t]
        const hit = v > 0
        if (hit) z = ready ? z + a * (v - z) : v
        ready = ready || hit
        d = d + b * ((hit ? 1 : 0) - d)
      }
      return f
    }
  }
}

/** s[t] = RMSE of one-step errors on months evalStart..t-1 (expanding window). Same length as f. */
export function sigmaPath(y: number[], f: number[], evalStart: number): number[] {
  const s = new Array<number>(f.length).fill(NaN)
  let acc = 0
  let n = 0
  for (let t = evalStart; t < f.length; t++) {
    if (t > evalStart && n > 0) s[t] = Math.sqrt(acc / n)
    if (t < y.length && Number.isFinite(f[t])) {
      acc += (y[t] - f[t]) ** 2
      n++
    }
  }
  return s
}

/** Order-up-to level for periodic review R = 1 and lead time L (months). */
export function orderUpTo(f: number, sigma: number, z: number, lead: number): number {
  const sig = Number.isFinite(sigma) ? sigma : 0
  return Math.ceil((lead + 1) * f + z * sig * Math.sqrt(lead + 1))
}

export interface SimResult {
  served: number
  demand: number
  avgOnhand: number
}

/**
 * Simulate the test months testStart..y.length-1: monthly review, order-up-to level from the
 * forecast and its sigma, integer orders arriving after `lead` months, unmet demand backordered.
 * Fill rate = demand served from stock on hand / total demand.
 */
export function simulatePart(y: number[], f: number[], s: number[], z: number, lead: number, testStart: number): SimResult {
  let net = orderUpTo(f[testStart], s[testStart], z, lead)
  const pipeline: number[] = new Array(lead).fill(0)
  let served = 0
  let demand = 0
  let onhand = 0
  for (let t = testStart; t < y.length; t++) {
    if (lead > 0) net += pipeline.shift()!
    const ip = lead > 0 ? pipeline.reduce((acc, v) => acc + v, net) : net
    const q = Math.max(0, orderUpTo(f[t], s[t], z, lead) - ip)
    if (lead === 0) net += q
    else pipeline.push(q)
    const d = y[t]
    served += Math.min(Math.max(net, 0), d)
    demand += d
    net -= d
    onhand += Math.max(net, 0)
  }
  return { served, demand, avgOnhand: onhand / (y.length - testStart) }
}

export interface FrontierPoint {
  z: number
  fill: number
  inv: number
}

export const Z_GRID = Array.from({ length: 17 }, (_, i) => i * 0.25) // 0 .. 4

export interface PartForecast {
  y: number[]
  f: number[]
  s: number[]
}

/** Portfolio fill rate and total average stock for each safety factor. */
export function frontier(parts: PartForecast[], lead: number, testStart: number, zs = Z_GRID): FrontierPoint[] {
  return zs.map((z) => {
    let served = 0
    let demand = 0
    let inv = 0
    for (const p of parts) {
      const r = simulatePart(p.y, p.f, p.s, z, lead, testStart)
      served += r.served
      demand += r.demand
      inv += r.avgOnhand
    }
    return { z, fill: demand > 0 ? served / demand : NaN, inv }
  })
}

/** Linear interpolation along the frontier: stock and safety factor needed to reach a fill rate. */
export function atFill(pts: FrontierPoint[], target: number): { inv: number; z: number } | null {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a.fill <= target && target <= b.fill && b.fill > a.fill) {
      const w = (target - a.fill) / (b.fill - a.fill)
      return { inv: a.inv + w * (b.inv - a.inv), z: a.z + w * (b.z - a.z) }
    }
  }
  return null
}

export interface Accuracy {
  mae: number
  rmse: number
  bias: number
  wape: number
}

/** Accuracy over months [from, to) pooled across parts. Bias = forecast − actual (positive = over-forecasting). */
export function accuracy(parts: { y: number[]; f: number[] }[], from: number, to: number): Accuracy {
  let ae = 0
  let se = 0
  let e = 0
  let act = 0
  let n = 0
  for (const p of parts) {
    for (let t = from; t < to; t++) {
      const err = p.f[t] - p.y[t]
      ae += Math.abs(err)
      se += err * err
      e += err
      act += p.y[t]
      n++
    }
  }
  return { mae: ae / n, rmse: Math.sqrt(se / n), bias: e / n, wape: act > 0 ? ae / act : NaN }
}

export type DemandClass = 'smooth' | 'erratic' | 'intermittent' | 'lumpy' | 'no demand'

/** Syntetos-Boylan-Croston classification (ADI cut-off 1.32, CV² cut-off 0.49) on months < upto. */
export function classify(y: number[], upto: number): { cls: DemandClass; adi: number; cv2: number } {
  const h = y.slice(0, upto)
  const nz = h.filter((v) => v > 0)
  if (nz.length < 2) return { cls: nz.length ? 'lumpy' : 'no demand', adi: nz.length ? h.length : Infinity, cv2: NaN }
  const m = nz.reduce((s, v) => s + v, 0) / nz.length
  const sd = Math.sqrt(nz.reduce((s, v) => s + (v - m) ** 2, 0) / (nz.length - 1))
  const adi = h.length / nz.length
  const cv2 = (sd / m) ** 2
  const cls: DemandClass = adi < 1.32 ? (cv2 < 0.49 ? 'smooth' : 'erratic') : cv2 < 0.49 ? 'intermittent' : 'lumpy'
  return { cls, adi, cv2 }
}

/** Default split used by the app: last `testMonths` months are the test period; errors for sigma start 15 months earlier. */
export function splits(T: number, testMonths: number) {
  const testStart = T - testMonths
  const evalStart = Math.max(BURN, testStart - 15)
  return { testStart, evalStart }
}
