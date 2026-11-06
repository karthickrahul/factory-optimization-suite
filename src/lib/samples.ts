// Built-in demo data so every module works in one click. All values are synthetic.
import type { Task } from './balancing'
import { makeRng, randNormal } from './rng'
import type { StationCfg } from './simulation'

/** Shaft diameter (mm): in control, then a mean shift and one outlier. Spec 24.950 to 25.050. */
export function sampleSpcCsv(): string {
  const r = makeRng(20261105)
  const lines = ['Sample,Diameter_mm']
  for (let i = 1; i <= 125; i++) {
    let v = 25.0 + 0.012 * randNormal(r)
    if (i > 80) v += 0.018
    if (i === 57) v += 0.05
    lines.push(`${i},${v.toFixed(3)}`)
  }
  return lines.join('\n')
}
export const SAMPLE_SPC_SPEC = { lsl: 24.95, usl: 25.05 }

/** Daily inspection results with varying sample sizes and one bad day. */
export function samplePCsv(): string {
  const r = makeRng(77)
  const lines = ['Day,Inspected,Defective']
  for (let d = 1; d <= 25; d++) {
    const n = 180 + Math.floor(r() * 90)
    let p = 0.03
    if (d === 17 || d === 18) p = 0.075
    let defects = 0
    for (let i = 0; i < n; i++) if (r() < p) defects++
    lines.push(`${d},${n},${defects}`)
  }
  return lines.join('\n')
}

/** Final assembly of a generic centrifugal pump; times in seconds. */
export const SAMPLE_TASKS: Task[] = [
  { id: 'A', name: 'Mount base plate', time: 32, predecessors: [] },
  { id: 'B', name: 'Press bearing housing', time: 45, predecessors: ['A'] },
  { id: 'C', name: 'Install shaft', time: 28, predecessors: ['B'] },
  { id: 'D', name: 'Fit impeller', time: 40, predecessors: ['C'] },
  { id: 'E', name: 'Torque impeller nut', time: 22, predecessors: ['D'] },
  { id: 'F', name: 'Mount seal assembly', time: 36, predecessors: ['C'] },
  { id: 'G', name: 'Fit casing gasket', time: 18, predecessors: ['A'] },
  { id: 'H', name: 'Mount pump casing', time: 50, predecessors: ['E', 'F', 'G'] },
  { id: 'I', name: 'Tighten casing bolts', time: 38, predecessors: ['H'] },
  { id: 'J', name: 'Attach motor adapter', time: 34, predecessors: ['B'] },
  { id: 'K', name: 'Mount motor', time: 42, predecessors: ['J'] },
  { id: 'L', name: 'Couple shaft to motor', time: 30, predecessors: ['I', 'K'] },
  { id: 'M', name: 'Leak test', time: 55, predecessors: ['L'] },
  { id: 'N', name: 'Label and pack', time: 26, predecessors: ['M'] },
]

export const SAMPLE_STATIONS: StationCfg[] = [
  { name: 'Cutting', machines: 1, mean: 0.9, dist: 'normal', cv: 0.15, mtbf: 0, mttr: 0, bufferBefore: Infinity },
  { name: 'Machining', machines: 2, mean: 2.2, dist: 'lognormal', cv: 0.3, mtbf: 240, mttr: 20, bufferBefore: 6 },
  { name: 'Washing', machines: 1, mean: 0.8, dist: 'normal', cv: 0.1, mtbf: 0, mttr: 0, bufferBefore: 5 },
  { name: 'Assembly', machines: 1, mean: 1.1, dist: 'normal', cv: 0.2, mtbf: 0, mttr: 0, bufferBefore: 4 },
  { name: 'Testing', machines: 1, mean: 1.0, dist: 'exponential', cv: 1, mtbf: 180, mttr: 10, bufferBefore: 3 },
]
