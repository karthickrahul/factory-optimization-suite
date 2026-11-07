import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { atFill, forecastSeries, frontier, sigmaPath, splits, type ClassicalMethod } from './forecast'

// End-to-end check: the browser engine on the published data reproduces the Python headline numbers.
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const data = read('../../public/data/carparts.json') as { demand: number[][] }
const lgbm = read('../../public/data/lgbm.json') as { firstMonth: number; forecast: number[][] }
const results = read('../../analysis/results.json') as { inv_at_fill: Record<string, Record<string, Record<string, number | null>>> }

const T = data.demand[0].length
const { testStart, evalStart } = splits(T, 12)

function parts(m: ClassicalMethod | 'LightGBM') {
  return data.demand.map((y, i) => {
    let f: number[]
    if (m === 'LightGBM') {
      f = new Array(T + 1).fill(NaN)
      lgbm.forecast[i].forEach((v, k) => (f[lgbm.firstMonth + k] = v))
    } else f = forecastSeries(y, m, { alpha: 0.1, beta: 0.1 })
    return { y, f, s: sigmaPath(y, f, evalStart) }
  })
}

describe('portfolio results on 2,509 real car parts', () => {
  it('uses the same split as the Python benchmark', () => {
    expect(data.demand).toHaveLength(2509)
    expect(testStart).toBe(39)
    expect(evalStart).toBe(24)
  })

  for (const m of ['SBA', 'SES', 'LightGBM'] as const) {
    it(`${m}: stock needed for 90% fill (lead time 1) matches analysis/results.json within 1%`, () => {
      const got = atFill(frontier(parts(m), 1, testStart), 0.9)!.inv
      const ref = results.inv_at_fill['1']['0.9'][m]!
      expect(Math.abs(got - ref) / ref).toBeLessThan(0.01)
    })
  }
})
