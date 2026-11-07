import { describe, expect, it } from 'vitest'
import fx from './__fixtures__/parity.json'
import { BURN, accuracy, atFill, classify, forecastSeries, orderUpTo, sigmaPath, simulatePart, type ClassicalMethod } from './forecast'

const P = { alpha: fx.alpha, beta: fx.beta }

describe('parity with analysis/benchmark.py', () => {
  const methods: ClassicalMethod[] = ['Naive', 'Mean', 'SES', 'Croston', 'SBA', 'TSB']
  for (const m of methods) {
    it(`${m} forecasts match Python on 5 real car-parts series`, () => {
      for (const s of fx.series) {
        const f = forecastSeries(s.demand, m, P)
        const ref = (s.forecast as Record<string, (number | null)[]>)[m]
        ref.forEach((v, t) => {
          if (v === null) expect(Number.isNaN(f[t])).toBe(true)
          else expect(f[t]).toBeCloseTo(v, 8)
        })
      }
    })
  }

  it('sigma path matches Python', () => {
    for (const s of fx.series) {
      const f = forecastSeries(s.demand, 'SBA', P)
      const sig = sigmaPath(s.demand, f, 24)
      s.sigmaSBA.forEach((v, t) => {
        if (v === null) expect(Number.isNaN(sig[t])).toBe(true)
        else expect(sig[t]).toBeCloseTo(v, 8)
      })
    }
  })

  it('inventory simulation matches Python (SBA, z = 1.5, lead time 1)', () => {
    const ref = fx['simSBA_z1.5_L1']
    fx.series.forEach((s, i) => {
      const f = forecastSeries(s.demand, 'SBA', P)
      const r = simulatePart(s.demand, f, sigmaPath(s.demand, f, 24), 1.5, 1, 39)
      expect(r.served).toBeCloseTo(ref.served[i], 8)
      expect(r.demand).toBeCloseTo(ref.demand[i], 8)
      expect(r.avgOnhand).toBeCloseTo(ref.avg_onhand[i], 8)
    })
  })
})

describe('forecasting methods (hand-calculated)', () => {
  // 12 burn-in months: demand of 4 in month 3 and 2 in month 9, then 0, 6.
  const y = [0, 0, 0, 4, 0, 0, 0, 0, 0, 2, 0, 0, 0, 6]
  const p = { alpha: 0.2, beta: 0.1 }

  it('Croston initialises from the burn-in and updates only on demand', () => {
    const f = forecastSeries(y, 'Croston', p)
    // z = 3, p = 12/2 = 6 -> 0.5; month 12 is zero so state is unchanged
    expect(f[BURN]).toBeCloseTo(0.5)
    expect(f[BURN + 1]).toBeCloseTo(0.5)
    // month 13: demand 6 after an interval of 4 months: z = 3 + .2*3 = 3.6, p = 6 + .2*(4-6) = 5.6
    expect(f[BURN + 2]).toBeCloseTo(3.6 / 5.6)
  })

  it('SBA applies the (1 - alpha/2) correction', () => {
    const c = forecastSeries(y, 'Croston', p)
    const s = forecastSeries(y, 'SBA', p)
    expect(s[BURN]).toBeCloseTo(c[BURN] * 0.9)
  })

  it('TSB decays when no demand occurs', () => {
    const f = forecastSeries(y, 'TSB', p)
    // d = 2/12, z = 3 -> 0.5, then d *= 0.9 after a zero month
    expect(f[BURN]).toBeCloseTo(0.5)
    expect(f[BURN + 1]).toBeCloseTo((2 / 12) * 0.9 * 3)
  })

  it('returns a next-month forecast at index y.length', () => {
    const f = forecastSeries(y, 'Naive', p)
    expect(f).toHaveLength(y.length + 1)
    expect(f[y.length]).toBe(6)
  })
})

describe('inventory policy', () => {
  it('order-up-to level covers lead time plus review period', () => {
    expect(orderUpTo(2, 1, 1.645, 1)).toBe(Math.ceil(4 + 1.645 * Math.SQRT2))
    expect(orderUpTo(2, NaN, 2, 0)).toBe(2)
  })

  it('a perfect forecast with no lead time gives 100% fill and no leftover stock', () => {
    const y = [3, 3, 3, 3]
    const f = [3, 3, 3, 3]
    const s = [0, 0, 0, 0]
    const r = simulatePart(y, f, s, 0, 0, 0)
    expect(r.served).toBe(12)
    expect(r.avgOnhand).toBe(0)
  })

  it('stock-outs are backordered and reduce the fill rate', () => {
    const y = [0, 10, 0]
    const f = [1, 1, 1]
    const s = [0, 0, 0]
    const r = simulatePart(y, f, s, 0, 0, 0)
    expect(r.served).toBe(1) // only one unit on hand when the 10 arrive
    expect(r.demand).toBe(10)
  })

  it('interpolates stock needed for a target fill rate', () => {
    const pts = [
      { z: 0, fill: 0.8, inv: 100 },
      { z: 1, fill: 0.9, inv: 200 },
    ]
    const r = atFill(pts, 0.85)!
    expect(r.inv).toBeCloseTo(150)
    expect(r.z).toBeCloseTo(0.5)
    expect(atFill(pts, 0.95)).toBeNull()
  })
})

describe('classification and accuracy', () => {
  it('classifies by ADI and CV²', () => {
    expect(classify([5, 5, 6, 5, 5, 6], 6).cls).toBe('smooth')
    expect(classify([0, 0, 0, 5, 0, 0, 0, 5], 8).cls).toBe('intermittent')
    expect(classify([0, 0, 0, 1, 0, 0, 0, 20], 8).cls).toBe('lumpy')
    expect(classify([0, 0, 0], 3).cls).toBe('no demand')
  })

  it('pools errors across parts', () => {
    const a = accuracy([{ y: [0, 2], f: [1, 1] }], 0, 2)
    expect(a.mae).toBe(1)
    expect(a.bias).toBe(0)
    expect(a.wape).toBe(1)
  })
})
