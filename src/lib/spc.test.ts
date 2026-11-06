import { describe, expect, it } from 'vitest'
import { analyzeIndividuals, analyzePChart, analyzeXbarR, capability, westernElectric } from './spc'
import { makeRng, randExp, randNormal } from './rng'
import { andersonDarling, normalCdf } from './stats'

describe('stats', () => {
  it('normal CDF matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4)
    expect(normalCdf(-3)).toBeCloseTo(0.00134990, 6)
    // tail accuracy relevant for ppm estimates
    expect(1 - normalCdf(4)).toBeCloseTo(3.1671e-5, 8)
  })

  it('Anderson-Darling accepts normal data and rejects exponential data', () => {
    const r = makeRng(42)
    const normal = Array.from({ length: 400 }, () => 10 + 2 * randNormal(r))
    const expo = Array.from({ length: 400 }, () => randExp(r, 1))
    expect(andersonDarling(normal).p).toBeGreaterThan(0.05)
    expect(andersonDarling(expo).p).toBeLessThan(0.001)
  })
})

describe('I-MR chart', () => {
  it('computes limits from the average moving range', () => {
    const a = analyzeIndividuals([1, 2, 3, 2, 1], {})
    expect(a.primary.cl).toBeCloseTo(1.8, 10)
    const sigma = 1 / 1.128
    expect(a.primary.ucl[0]).toBeCloseTo(1.8 + 3 * sigma, 8)
    expect(a.primary.lcl[0]).toBeCloseTo(1.8 - 3 * sigma, 8)
    expect(a.secondary.cl).toBeCloseTo(1, 10)
    expect(a.secondary.ucl[0]).toBeCloseTo(3.267, 8)
    expect(a.secondary.lcl[0]).toBe(0)
  })

  it('flags a point beyond 3 sigma (rule 1)', () => {
    const base = Array.from({ length: 30 }, (_, i) => 10 + (i % 2 === 0 ? 0.1 : -0.1))
    base[20] = 12
    const a = analyzeIndividuals(base, {})
    expect(a.primary.violations.some((v) => v.index === 20 && v.rule === 1)).toBe(true)
  })

  it('rejects tiny data sets', () => {
    expect(() => analyzeIndividuals([1, 2], {})).toThrow()
  })
})

describe('Xbar-R chart', () => {
  it('uses the published A2 and D4 constants for n = 5', () => {
    const a = analyzeXbarR([1, 2, 3, 4, 5, 2, 3, 4, 5, 6], 5, {})
    expect(a.primary.cl).toBeCloseTo(3.5, 10)
    expect(a.primary.ucl[0]).toBeCloseTo(3.5 + 0.577 * 4, 8)
    expect(a.primary.lcl[0]).toBeCloseTo(3.5 - 0.577 * 4, 8)
    expect(a.secondary.cl).toBeCloseTo(4, 10)
    expect(a.secondary.ucl[0]).toBeCloseTo(2.114 * 4, 8)
    expect(a.secondary.lcl[0]).toBe(0)
  })

  it('drops an incomplete trailing subgroup and reports it', () => {
    const a = analyzeXbarR([1, 2, 3, 4, 5, 2, 3, 4, 5, 6, 9, 9], 5, {})
    expect(a.droppedValues).toBe(2)
    expect(a.values.length).toBe(10)
  })

  it('validates subgroup size', () => {
    expect(() => analyzeXbarR([1, 2, 3, 4], 1, {})).toThrow()
    expect(() => analyzeXbarR([1, 2, 3, 4], 11, {})).toThrow()
    expect(() => analyzeXbarR([1, 2, 3], 3, {})).toThrow()
  })
})

describe('Western Electric rules', () => {
  const sigma = (n: number) => new Array(n).fill(1)
  it('rule 4: eight in a row on one side', () => {
    const v = westernElectric([0.5, 0.4, 0.6, 0.3, 0.2, 0.5, 0.7, 0.1, -0.2], 0, sigma(9))
    expect(v.filter((x) => x.rule === 4).map((x) => x.index)).toEqual([7])
  })
  it('rule 2: two of three beyond 2 sigma', () => {
    const v = westernElectric([0, 2.5, 0.1, 2.4], 0, sigma(4))
    expect(v.some((x) => x.rule === 2 && x.index === 3)).toBe(true)
  })
  it('rule 3: four of five beyond 1 sigma', () => {
    const v = westernElectric([1.2, 1.5, 0.2, 1.3, 1.1], 0, sigma(5))
    expect(v.some((x) => x.rule === 3 && x.index === 4)).toBe(true)
  })
  it('does not flag in-control noise heavily', () => {
    const r = makeRng(7)
    const data = Array.from({ length: 100 }, () => randNormal(r))
    const v = westernElectric(data, 0, sigma(100), { 1: true, 2: false, 3: false, 4: false })
    expect(v.length).toBeLessThanOrEqual(3)
  })
  it('respects disabled rules', () => {
    const v = westernElectric([5], 0, sigma(1), { 1: false, 2: true, 3: true, 4: true })
    expect(v.length).toBe(0)
  })
})

describe('capability', () => {
  it('computes Cp, Cpk, Pp, Ppk', () => {
    const c = capability([9, 10, 11], 1, { lsl: 7, usl: 13 })
    expect(c.cp).toBeCloseTo(1, 10)
    expect(c.cpk).toBeCloseTo(1, 10)
    expect(c.pp).toBeCloseTo(1, 10)
    const off = capability([9, 10, 11], 1, { lsl: 8, usl: 14 })
    expect(off.cpu).toBeCloseTo(4 / 3, 10)
    expect(off.cpl).toBeCloseTo(2 / 3, 10)
    expect(off.cpk).toBeCloseTo(2 / 3, 10)
    expect(off.verdict).toMatch(/Not capable/)
  })

  it('supports one-sided specs', () => {
    const c = capability([9, 10, 11], 1, { usl: 13 })
    expect(c.cp).toBeUndefined()
    expect(c.cpk).toBeCloseTo(1, 10)
  })

  it('expected ppm is about 2700 for Cpk = 1 centred', () => {
    const c = capability([9, 10, 11], 1, { lsl: 7, usl: 13 })
    expect(c.expectedWithinPpm!).toBeGreaterThan(2600)
    expect(c.expectedWithinPpm!).toBeLessThan(2800)
  })

  it('counts observed out-of-spec parts', () => {
    const c = capability([1, 2, 3, 4], 1, { usl: 3.5 })
    expect(c.observedPpm).toBeCloseTo(250000, 6)
  })
})

describe('p chart', () => {
  it('computes variable limits', () => {
    const r = analyzePChart([2, 3, 4, 5], [100, 100, 200, 200])
    expect(r.pBar).toBeCloseTo(14 / 600, 10)
    const s100 = Math.sqrt((r.pBar * (1 - r.pBar)) / 100)
    expect(r.chart.ucl[0]).toBeCloseTo(r.pBar + 3 * s100, 10)
    expect(r.chart.ucl[2]).toBeLessThan(r.chart.ucl[0])
    expect(r.chart.lcl[0]).toBeGreaterThanOrEqual(0)
  })
  it('rejects invalid rows', () => {
    expect(() => analyzePChart([5, 1, 1], [3, 10, 10])).toThrow(/Row 1/)
    expect(() => analyzePChart([1, 1, 1], [10, 0, 10])).toThrow(/Row 2/)
  })
})
