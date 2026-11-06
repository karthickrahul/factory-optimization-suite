import { describe, expect, it } from 'vitest'
import { balance, BalancingError, compareHeuristics, parsePredecessors, taktTime, type Heuristic, type Task } from './balancing'
import { makeRng } from './rng'

const t = (id: string, time: number, ...p: string[]): Task => ({ id, name: id, time, predecessors: p })

describe('line balancing', () => {
  const tasks = [t('A', 4), t('B', 3, 'A'), t('C', 3, 'A'), t('D', 2, 'B', 'C')]

  it('balances a small network with RPW', () => {
    const r = balance(tasks, 7, 'RPW')
    expect(r.stations.length).toBe(2)
    expect(r.stations[0].tasks.map((x) => x.id)).toEqual(['A', 'B'])
    expect(r.stations[1].tasks.map((x) => x.id)).toEqual(['C', 'D'])
    expect(r.totalTime).toBe(12)
    expect(r.minStations).toBe(2)
    expect(r.efficiency).toBeCloseTo(12 / 14, 10)
    expect(r.balanceDelay).toBeCloseTo(2 / 14, 10)
    expect(r.actualCycleTime).toBe(7)
  })

  it('handles a large cycle time: everything in one station', () => {
    const r = balance(tasks, 100, 'LCR')
    expect(r.stations.length).toBe(1)
    expect(r.efficiency).toBeCloseTo(0.12, 10)
  })

  it('reports validation errors clearly', () => {
    expect(() => balance([t('A', 10)], 5, 'RPW')).toThrow(/longer than the cycle time/)
    expect(() => balance([t('A', 1, 'Z')], 5, 'RPW')).toThrow(/unknown predecessor/)
    expect(() => balance([t('A', 1, 'B'), t('B', 1, 'A')], 5, 'RPW')).toThrow(/cycle/)
    expect(() => balance([t('A', 1), t('A', 2)], 5, 'RPW')).toThrow(/Duplicate/)
    expect(() => balance([], 5, 'RPW')).toThrow(BalancingError)
    expect(() => balance([t('A', 1)], 0, 'RPW')).toThrow(/Cycle time/)
    expect(() => balance([t('A', 0)], 5, 'RPW')).toThrow(/greater than zero/)
  })

  it('respects precedence, capacity and the lower bound on random networks (all heuristics)', () => {
    const rng = makeRng(2024)
    for (let trial = 0; trial < 60; trial++) {
      const n = 5 + Math.floor(rng() * 25)
      const tasks: Task[] = []
      for (let i = 0; i < n; i++) {
        const preds: string[] = []
        for (let j = 0; j < i; j++) if (rng() < 0.15) preds.push(`T${j}`)
        tasks.push(t(`T${i}`, 1 + Math.floor(rng() * 9), ...preds))
      }
      const cycle = 10 + Math.floor(rng() * 10)
      for (const h of ['RPW', 'LCR', 'MFT', 'SPT'] as Heuristic[]) {
        const r = balance(tasks, cycle, h)
        const pos = new Map<string, [number, number]>()
        r.stations.forEach((s, si) => s.tasks.forEach((x, k) => pos.set(x.id, [si, k])))
        expect(pos.size).toBe(n)
        for (const s of r.stations) expect(s.load).toBeLessThanOrEqual(cycle + 1e-9)
        for (const x of tasks)
          for (const p of x.predecessors) {
            const [ps, pk] = pos.get(p)!
            const [xs, xk] = pos.get(x.id)!
            expect(ps < xs || (ps === xs && pk < xk)).toBe(true)
          }
        expect(r.stations.length).toBeGreaterThanOrEqual(r.minStations)
        expect(r.efficiency).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('compareHeuristics sorts best first', () => {
    const res = compareHeuristics(tasks, 7)
    expect(res.length).toBe(4)
    for (let i = 1; i < res.length; i++) expect(res[i].stations.length).toBeGreaterThanOrEqual(res[i - 1].stations.length)
  })

  it('computes takt time', () => {
    expect(taktTime(27000, 450)).toBe(60)
    expect(() => taktTime(0, 10)).toThrow()
  })

  it('parses predecessor strings', () => {
    expect(parsePredecessors('A, B;C  D')).toEqual(['A', 'B', 'C', 'D'])
    expect(parsePredecessors('-')).toEqual([])
    expect(parsePredecessors('')).toEqual([])
  })
})
