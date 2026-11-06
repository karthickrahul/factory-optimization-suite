// Statistical Process Control: control charts, Western Electric rules, process capability.
import { andersonDarling, mean, normalCdf, stdev, sum } from './stats'

/** Control chart constants for subgroup sizes 2..10 (index = n). */
const D2 = [NaN, NaN, 1.128, 1.693, 2.059, 2.326, 2.534, 2.704, 2.847, 2.97, 3.078]
const A2 = [NaN, NaN, 1.88, 1.023, 0.729, 0.577, 0.483, 0.419, 0.373, 0.337, 0.308]
const D3 = [NaN, NaN, 0, 0, 0, 0, 0, 0.076, 0.136, 0.184, 0.223]
const D4 = [NaN, NaN, 3.267, 2.574, 2.282, 2.114, 2.004, 1.924, 1.864, 1.816, 1.777]

export const MAX_SUBGROUP = 10

export interface Violation {
  index: number
  rule: 1 | 2 | 3 | 4
}

export interface ChartData {
  title: string
  yLabel: string
  values: number[]
  labels: string[]
  cl: number
  ucl: number[]
  lcl: number[]
  /** Standard deviation of the plotted statistic, per point (used for zones). */
  sigma: number[]
  violations: Violation[]
}

export const RULE_TEXT: Record<1 | 2 | 3 | 4, string> = {
  1: 'One point beyond 3σ from the centre line',
  2: 'Two of three consecutive points beyond 2σ on the same side',
  3: 'Four of five consecutive points beyond 1σ on the same side',
  4: 'Eight consecutive points on the same side of the centre line',
}

/** Western Electric (Nelson-style) run rules, evaluated on z-scores of the plotted statistic. */
export function westernElectric(
  values: number[],
  cl: number,
  sigma: number[],
  enabled: Record<1 | 2 | 3 | 4, boolean> = { 1: true, 2: true, 3: true, 4: true }
): Violation[] {
  const z = values.map((v, i) => (sigma[i] > 0 ? (v - cl) / sigma[i] : 0))
  const out: Violation[] = []
  for (let i = 0; i < z.length; i++) {
    if (enabled[1] && Math.abs(z[i]) > 3) out.push({ index: i, rule: 1 })
    if (enabled[2] && i >= 2) {
      const w = z.slice(i - 2, i + 1)
      if ((w.filter((v) => v > 2).length >= 2 && z[i] > 2) || (w.filter((v) => v < -2).length >= 2 && z[i] < -2))
        out.push({ index: i, rule: 2 })
    }
    if (enabled[3] && i >= 4) {
      const w = z.slice(i - 4, i + 1)
      if ((w.filter((v) => v > 1).length >= 4 && z[i] > 1) || (w.filter((v) => v < -1).length >= 4 && z[i] < -1))
        out.push({ index: i, rule: 3 })
    }
    if (enabled[4] && i >= 7) {
      const w = z.slice(i - 7, i + 1)
      if (w.every((v) => v > 0) || w.every((v) => v < 0)) out.push({ index: i, rule: 4 })
    }
  }
  return out
}

export interface SpecLimits {
  lsl?: number
  usl?: number
}

export interface Capability {
  n: number
  mean: number
  sigmaWithin: number
  sigmaOverall: number
  cp?: number
  cpk?: number
  pp?: number
  ppk?: number
  cpu?: number
  cpl?: number
  observedPpm?: number
  expectedWithinPpm?: number
  expectedOverallPpm?: number
  normalityP: number
  verdict: string
}

export function verdictFor(cpk: number | undefined): string {
  if (cpk === undefined || !isFinite(cpk)) return 'Enter at least one specification limit to assess capability.'
  if (cpk < 1) return 'Not capable (Cpk < 1.00): the process will produce out-of-spec parts.'
  if (cpk < 1.33) return 'Marginal (1.00 ≤ Cpk < 1.33): capable but with little margin; tighten control.'
  if (cpk < 1.67) return 'Capable (1.33 ≤ Cpk < 1.67): meets the common automotive minimum.'
  return 'Highly capable (Cpk ≥ 1.67).'
}

export function capability(values: number[], sigmaWithin: number, spec: SpecLimits): Capability {
  const n = values.length
  const m = mean(values)
  const sigmaOverall = stdev(values)
  const { lsl, usl } = spec
  const hasL = lsl !== undefined && isFinite(lsl)
  const hasU = usl !== undefined && isFinite(usl)
  const out: Capability = {
    n,
    mean: m,
    sigmaWithin,
    sigmaOverall,
    normalityP: andersonDarling(values).p,
    verdict: '',
  }
  if (hasL && hasU) {
    out.cp = (usl! - lsl!) / (6 * sigmaWithin)
    out.pp = (usl! - lsl!) / (6 * sigmaOverall)
  }
  if (hasU) {
    out.cpu = (usl! - m) / (3 * sigmaWithin)
  }
  if (hasL) {
    out.cpl = (m - lsl!) / (3 * sigmaWithin)
  }
  if (hasU || hasL) {
    out.cpk = Math.min(out.cpu ?? Infinity, out.cpl ?? Infinity)
    out.ppk = Math.min(
      hasU ? (usl! - m) / (3 * sigmaOverall) : Infinity,
      hasL ? (m - lsl!) / (3 * sigmaOverall) : Infinity
    )
    const outside = values.filter((v) => (hasU && v > usl!) || (hasL && v < lsl!)).length
    out.observedPpm = (outside / n) * 1e6
    const tail = (s: number) =>
      ((hasL ? normalCdf((lsl! - m) / s) : 0) + (hasU ? 1 - normalCdf((usl! - m) / s) : 0)) * 1e6
    out.expectedWithinPpm = tail(sigmaWithin)
    out.expectedOverallPpm = tail(sigmaOverall)
  }
  out.verdict = verdictFor(out.cpk)
  return out
}

export interface SpcAnalysis {
  kind: 'I-MR' | 'Xbar-R'
  primary: ChartData
  secondary: ChartData
  capability: Capability
  values: number[]
  droppedValues: number
  subgroupSize: number
}

type RuleSet = Record<1 | 2 | 3 | 4, boolean>

/** Individuals and moving-range charts (subgroup size 1). */
export function analyzeIndividuals(values: number[], spec: SpecLimits, rules?: RuleSet): SpcAnalysis {
  if (values.length < 3) throw new Error('Need at least 3 measurements for an I-MR chart.')
  const mr = values.slice(1).map((v, i) => Math.abs(v - values[i]))
  const mrBar = mean(mr)
  const cl = mean(values)
  const sigmaW = mrBar / D2[2]
  const sig = values.map(() => sigmaW)
  const primary: ChartData = {
    title: 'Individuals (I) chart',
    yLabel: 'Measurement',
    values,
    labels: values.map((_, i) => String(i + 1)),
    cl,
    ucl: values.map(() => cl + 3 * sigmaW),
    lcl: values.map(() => cl - 3 * sigmaW),
    sigma: sig,
    violations: westernElectric(values, cl, sig, rules),
  }
  const uclMr = D4[2] * mrBar
  const mrSigma = (uclMr - mrBar) / 3
  const secondary: ChartData = {
    title: 'Moving range (MR) chart',
    yLabel: 'Moving range',
    values: mr,
    labels: mr.map((_, i) => String(i + 2)),
    cl: mrBar,
    ucl: mr.map(() => uclMr),
    lcl: mr.map(() => 0),
    sigma: mr.map(() => mrSigma),
    violations: mr
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v > uclMr)
      .map(({ i }) => ({ index: i, rule: 1 as const })),
  }
  return {
    kind: 'I-MR',
    primary,
    secondary,
    capability: capability(values, sigmaW, spec),
    values,
    droppedValues: 0,
    subgroupSize: 1,
  }
}

/** X-bar and R charts for subgroup sizes 2..10. Incomplete trailing subgroup is dropped. */
export function analyzeXbarR(values: number[], n: number, spec: SpecLimits, rules?: RuleSet): SpcAnalysis {
  if (!Number.isInteger(n) || n < 2 || n > MAX_SUBGROUP) throw new Error(`Subgroup size must be 2 to ${MAX_SUBGROUP}.`)
  const k = Math.floor(values.length / n)
  if (k < 2) throw new Error(`Need at least 2 complete subgroups of size ${n}.`)
  const used = values.slice(0, k * n)
  const groups: number[][] = []
  for (let g = 0; g < k; g++) groups.push(used.slice(g * n, (g + 1) * n))
  const xbar = groups.map(mean)
  const ranges = groups.map((g) => Math.max(...g) - Math.min(...g))
  const grand = mean(xbar)
  const rBar = mean(ranges)
  const sigmaW = rBar / D2[n]
  const uclX = grand + A2[n] * rBar
  const lclX = grand - A2[n] * rBar
  const sigX = xbar.map(() => (uclX - grand) / 3)
  const primary: ChartData = {
    title: `X-bar chart (n = ${n})`,
    yLabel: 'Subgroup mean',
    values: xbar,
    labels: xbar.map((_, i) => String(i + 1)),
    cl: grand,
    ucl: xbar.map(() => uclX),
    lcl: xbar.map(() => lclX),
    sigma: sigX,
    violations: westernElectric(xbar, grand, sigX, rules),
  }
  const uclR = D4[n] * rBar
  const lclR = D3[n] * rBar
  const secondary: ChartData = {
    title: `R chart (n = ${n})`,
    yLabel: 'Subgroup range',
    values: ranges,
    labels: ranges.map((_, i) => String(i + 1)),
    cl: rBar,
    ucl: ranges.map(() => uclR),
    lcl: ranges.map(() => lclR),
    sigma: ranges.map(() => (uclR - rBar) / 3),
    violations: ranges
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v > uclR || v < lclR)
      .map(({ i }) => ({ index: i, rule: 1 as const })),
  }
  return {
    kind: 'Xbar-R',
    primary,
    secondary,
    capability: capability(used, sigmaW, spec),
    values: used,
    droppedValues: values.length - used.length,
    subgroupSize: n,
  }
}

export interface PChartResult {
  chart: ChartData
  pBar: number
  totalInspected: number
  totalDefective: number
}

/** p chart for proportion defective with variable sample size. */
export function analyzePChart(defectives: number[], sizes: number[], rules?: RuleSet): PChartResult {
  if (defectives.length !== sizes.length || defectives.length < 3) throw new Error('Need at least 3 rows of defective counts and sample sizes.')
  for (let i = 0; i < sizes.length; i++) {
    if (!(sizes[i] > 0)) throw new Error(`Row ${i + 1}: sample size must be positive.`)
    if (defectives[i] < 0 || defectives[i] > sizes[i]) throw new Error(`Row ${i + 1}: defectives must be between 0 and the sample size.`)
  }
  const pBar = sum(defectives) / sum(sizes)
  const p = defectives.map((d, i) => d / sizes[i])
  const sig = sizes.map((s) => Math.sqrt((pBar * (1 - pBar)) / s))
  const chart: ChartData = {
    title: 'p chart (proportion defective)',
    yLabel: 'Proportion defective',
    values: p,
    labels: p.map((_, i) => String(i + 1)),
    cl: pBar,
    ucl: sig.map((s) => Math.min(1, pBar + 3 * s)),
    lcl: sig.map((s) => Math.max(0, pBar - 3 * s)),
    sigma: sig,
    violations: westernElectric(p, pBar, sig, rules),
  }
  return { chart, pBar, totalInspected: sum(sizes), totalDefective: sum(defectives) }
}
