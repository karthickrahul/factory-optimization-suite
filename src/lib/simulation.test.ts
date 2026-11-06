import { describe, expect, it } from 'vitest'
import { replicate, runOnce, validateCfg, type SimCfg, type StationCfg } from './simulation'

const st = (over: Partial<StationCfg> = {}): StationCfg => ({
  name: 'S',
  machines: 1,
  mean: 1,
  dist: 'constant',
  cv: 0,
  mtbf: 0,
  mttr: 0,
  bufferBefore: Infinity,
  ...over,
})

const cfg = (stations: StationCfg[], over: Partial<SimCfg> = {}): SimCfg => ({
  stations,
  warmup: 100,
  duration: 20000,
  seed: 1,
  ...over,
})

describe('simulation engine', () => {
  it('deterministic line runs at the bottleneck rate', () => {
    const r = runOnce(cfg([st({ name: 'A', mean: 1 }), st({ name: 'B', mean: 2 }), st({ name: 'C', mean: 1 })]))
    expect(r.throughputPerHour).toBeGreaterThan(29.8)
    expect(r.throughputPerHour).toBeLessThan(30.2)
    expect(r.bottleneck).toBe(1)
    expect(r.stations[1].busy).toBeGreaterThan(0.99)
    expect(r.stations[2].busy).toBeCloseTo(0.5, 1)
  })

  it('two exponential stations with no buffer give 2/3 of the service rate (analytic result)', () => {
    const r = runOnce(
      cfg([st({ dist: 'exponential' }), st({ dist: 'exponential', bufferBefore: 0 })], { duration: 400000, seed: 5 })
    )
    const perMin = r.throughputPerHour / 60
    expect(perMin).toBeGreaterThan(0.66)
    expect(perMin).toBeLessThan(0.673)
    // the first station is blocked about one third of the time
    expect(r.stations[0].blocked).toBeGreaterThan(0.32)
    expect(r.stations[0].blocked).toBeLessThan(0.35)
  })

  it('bigger buffers increase throughput of a noisy line', () => {
    const run = (b: number) =>
      replicate(
        cfg(
          [st({ dist: 'exponential' }), st({ dist: 'exponential', bufferBefore: b }), st({ dist: 'exponential', bufferBefore: b })],
          { duration: 30000 }
        ),
        5
      ).throughputPerHour.mean
    const b0 = run(0)
    const b3 = run(3)
    const b20 = run(20)
    expect(b3).toBeGreaterThan(b0)
    expect(b20).toBeGreaterThan(b3)
  })

  it('breakdowns reduce capacity by the availability factor', () => {
    const r = runOnce(cfg([st({ mtbf: 100, mttr: 25 })], { duration: 400000, seed: 11 }))
    // availability = 100 / 125 = 0.8 -> 48 jobs per hour
    expect(r.throughputPerHour).toBeGreaterThan(46.8)
    expect(r.throughputPerHour).toBeLessThan(49.2)
    expect(r.stations[0].down).toBeCloseTo(0.2, 1)
    expect(r.stations[0].capacityPerHour).toBeCloseTo(48, 6)
  })

  it('parallel machines multiply capacity', () => {
    const r = runOnce(cfg([st({ machines: 2, mean: 2 })]))
    expect(r.throughputPerHour).toBeGreaterThan(59)
    expect(r.throughputPerHour).toBeLessThan(61)
  })

  it('satisfies Little\'s law (WIP = throughput x cycle time)', () => {
    const r = runOnce(
      cfg(
        [st({ dist: 'lognormal', cv: 0.5 }), st({ dist: 'normal', cv: 0.3, mean: 1.1, bufferBefore: 5 }), st({ dist: 'exponential', mean: 0.9, bufferBefore: 5 })],
        { duration: 100000, seed: 3 }
      )
    )
    const little = (r.throughputPerHour / 60) * r.avgCycleTime
    expect(Math.abs(little - r.avgWip) / r.avgWip).toBeLessThan(0.02)
  })

  it('machine-time shares sum to one', () => {
    const r = runOnce(
      cfg([st({ dist: 'exponential', mtbf: 50, mttr: 5 }), st({ dist: 'exponential', mean: 1.2, bufferBefore: 2, machines: 2 })], { seed: 9 })
    )
    for (const s of r.stations) expect(s.processing + s.down + s.blocked + s.starved).toBeCloseTo(1, 6)
  })

  it('is reproducible for the same seed and differs across seeds', () => {
    const c = cfg([st({ dist: 'exponential' }), st({ dist: 'exponential', bufferBefore: 1 })])
    expect(runOnce(c).jobs).toBe(runOnce(c).jobs)
    expect(runOnce({ ...c, seed: 2 }).jobs).not.toBe(runOnce(c).jobs)
  })

  it('replications report a confidence interval', () => {
    const r = replicate(cfg([st({ dist: 'exponential' }), st({ dist: 'exponential', bufferBefore: 2 })], { duration: 5000 }), 8)
    expect(r.throughputPerHour.ci).toBeGreaterThan(0)
    expect(r.bottleneckVotes.reduce((a, b) => a + b, 0)).toBe(8)
  })

  it('collects a WIP trace when asked', () => {
    const r = runOnce(cfg([st(), st({ mean: 2, bufferBefore: 4 })], { sampleEvery: 100, duration: 2000 }))
    expect(r.wipTrace.length).toBeGreaterThan(15)
  })

  it('validates configuration', () => {
    expect(validateCfg(cfg([]))).toMatch(/at least one/)
    expect(validateCfg(cfg([st({ machines: 0 })]))).toMatch(/machines/)
    expect(validateCfg(cfg([st({ mean: 0 })]))).toMatch(/mean/)
    expect(validateCfg(cfg([st({ mtbf: 10, mttr: 0 })]))).toMatch(/MTTR/)
    expect(validateCfg(cfg([st()]))).toBeNull()
    expect(() => runOnce(cfg([]))).toThrow()
  })
})
