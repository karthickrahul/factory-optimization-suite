// Discrete-event simulation of a serial production line with parallel machines,
// finite buffers (blocking after service), and operation-dependent breakdowns.
// All times are in minutes.
import { makeRng, randExp, randNormal, type Rng } from './rng'
import { mean, stdev, tCrit95 } from './stats'

export type Dist = 'constant' | 'exponential' | 'normal' | 'lognormal'

export interface StationCfg {
  name: string
  machines: number
  /** Mean processing time per job (minutes). */
  mean: number
  dist: Dist
  /** Coefficient of variation for normal / lognormal processing times. */
  cv: number
  /** Mean processing time between failures per machine (minutes of operation); 0 disables breakdowns. */
  mtbf: number
  /** Mean repair time (minutes). */
  mttr: number
  /** Capacity of the queue in front of this station (ignored for the first station). Infinity = unlimited. */
  bufferBefore: number
}

export interface SimCfg {
  stations: StationCfg[]
  /** Warm-up period excluded from statistics (minutes). */
  warmup: number
  /** Measured run length after warm-up (minutes). */
  duration: number
  seed: number
  /** Interval for the WIP trace (minutes); 0 disables. */
  sampleEvery?: number
}

export interface StationResult {
  name: string
  /** Share of machine-time spent processing (excluding repairs). */
  processing: number
  /** Share of machine-time spent in repair while holding a job. */
  down: number
  /** Share of machine-time holding a finished job that cannot move downstream. */
  blocked: number
  /** Share of machine-time idle with no job to work on. */
  starved: number
  /** Processing + down: how busy the station is. */
  busy: number
  avgQueue: number
  maxQueue: number
  /** Theoretical capacity in jobs/hour given machines, mean time and availability. */
  capacityPerHour: number
}

export interface RunResult {
  jobs: number
  throughputPerHour: number
  avgCycleTime: number
  avgWip: number
  stations: StationResult[]
  bottleneck: number
  wipTrace: { t: number; wip: number }[]
}

export function validateCfg(cfg: SimCfg): string | null {
  if (cfg.stations.length < 1) return 'Add at least one station.'
  if (!(cfg.duration > 0)) return 'Run length must be positive.'
  if (cfg.warmup < 0) return 'Warm-up cannot be negative.'
  for (const [i, s] of cfg.stations.entries()) {
    const n = s.name || `Station ${i + 1}`
    if (!(s.machines >= 1) || !Number.isInteger(s.machines)) return `${n}: machines must be a whole number ≥ 1.`
    if (!(s.mean > 0)) return `${n}: mean processing time must be positive.`
    if (s.cv < 0) return `${n}: CV cannot be negative.`
    if (s.mtbf < 0 || s.mttr < 0) return `${n}: MTBF and MTTR cannot be negative.`
    if (s.mtbf > 0 && !(s.mttr > 0)) return `${n}: set an MTTR when MTBF is set.`
    if (i > 0 && !(s.bufferBefore >= 0)) return `${n}: buffer capacity cannot be negative.`
  }
  return null
}

function sampleTime(s: StationCfg, rng: Rng): number {
  switch (s.dist) {
    case 'constant':
      return s.mean
    case 'exponential':
      return randExp(rng, s.mean)
    case 'normal':
      return Math.max(0.05 * s.mean, s.mean + s.cv * s.mean * randNormal(rng))
    case 'lognormal': {
      const sigma2 = Math.log(1 + s.cv * s.cv)
      return Math.exp(Math.log(s.mean) - sigma2 / 2 + Math.sqrt(sigma2) * randNormal(rng))
    }
  }
}

/** Minimal binary min-heap keyed on (time, seq). */
class Heap<T extends { t: number; seq: number }> {
  private a: T[] = []
  get size() {
    return this.a.length
  }
  private less(i: number, j: number) {
    const x = this.a[i]
    const y = this.a[j]
    return x.t < y.t || (x.t === y.t && x.seq < y.seq)
  }
  push(v: T) {
    this.a.push(v)
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      ;[this.a[i], this.a[p]] = [this.a[p], this.a[i]]
      i = p
    }
  }
  pop(): T | undefined {
    if (!this.a.length) return undefined
    const top = this.a[0]
    const last = this.a.pop()!
    if (this.a.length) {
      this.a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.a.length && this.less(l, m)) m = l
        if (r < this.a.length && this.less(r, m)) m = r
        if (m === i) break
        ;[this.a[i], this.a[m]] = [this.a[m], this.a[i]]
        i = m
      }
    }
    return top
  }
}

type MState = 'idle' | 'busy' | 'blocked'

interface Machine {
  state: MState
  job: number
  since: number
  /** For busy machines: fraction of the service interval that is repair time. */
  repairFrac: number
  /** Remaining processing time until next failure. */
  ttf: number
}

interface Ev {
  t: number
  seq: number
  station: number
  machine: number
}

/**
 * Bottleneck = the busiest station. Stations within 1 percentage point of the busiest are treated as
 * tied (e.g. the first station is always busy when it has unlimited supply), and the one with the
 * lowest effective capacity wins, since that is the real constraint.
 */
export function pickBottleneck(busy: number[], capacityPerHour: number[]): number {
  const top = Math.max(...busy)
  let best = -1
  for (let i = 0; i < busy.length; i++) {
    if (busy[i] >= top - 0.01 && (best < 0 || capacityPerHour[i] < capacityPerHour[best])) best = i
  }
  return best
}

export function runOnce(cfg: SimCfg): RunResult {
  const err = validateCfg(cfg)
  if (err) throw new Error(err)
  const rng = makeRng(cfg.seed)
  const N = cfg.stations.length
  const tStart = cfg.warmup
  const tEnd = cfg.warmup + cfg.duration

  const machines: Machine[][] = cfg.stations.map((s) =>
    Array.from({ length: s.machines }, () => ({
      state: 'idle' as MState,
      job: -1,
      since: 0,
      repairFrac: 0,
      ttf: s.mtbf > 0 ? randExp(rng, s.mtbf) : Infinity,
    }))
  )
  const queues: number[][] = cfg.stations.map(() => [])
  const heap = new Heap<Ev>()
  let seq = 0

  // statistics
  const acc = cfg.stations.map(() => ({ proc: 0, down: 0, blocked: 0, idle: 0, qArea: 0, qMax: 0 }))
  const entry: number[] = []
  let completed = 0
  let cycleSum = 0
  let wipArea = 0
  let wip = 0
  let wipLast = tStart
  const wipTrace: { t: number; wip: number }[] = []
  let nextSample = cfg.sampleEvery && cfg.sampleEvery > 0 ? 0 : Infinity

  const clip = (a: number, b: number) => Math.max(0, Math.min(b, tEnd) - Math.max(a, tStart))

  const closeInterval = (si: number, m: Machine, now: number) => {
    const len = clip(m.since, now)
    if (len > 0) {
      const a = acc[si]
      if (m.state === 'busy') {
        a.down += len * m.repairFrac
        a.proc += len * (1 - m.repairFrac)
      } else if (m.state === 'blocked') a.blocked += len
      else a.idle += len
    }
    m.since = now
  }

  const qTime = cfg.stations.map(() => tStart)
  const updateQueueArea = (si: number, now: number) => {
    const from = Math.max(qTime[si], tStart)
    const to = Math.min(now, tEnd)
    if (to > from) acc[si].qArea += queues[si].length * (to - from)
    qTime[si] = Math.max(now, qTime[si])
  }
  const updateWipArea = (now: number) => {
    const from = Math.max(wipLast, tStart)
    const to = Math.min(now, tEnd)
    if (to > from) wipArea += wip * (to - from)
    wipLast = Math.max(now, wipLast)
  }
  const recordTrace = (now: number) => {
    while (nextSample <= now && nextSample <= tEnd) {
      wipTrace.push({ t: nextSample, wip })
      nextSample += cfg.sampleEvery!
    }
  }

  const setState = (si: number, mi: number, state: MState, now: number) => {
    const m = machines[si][mi]
    closeInterval(si, m, now)
    m.state = state
  }

  const startService = (si: number, mi: number, job: number, now: number) => {
    const s = cfg.stations[si]
    const m = machines[si][mi]
    setState(si, mi, 'busy', now)
    m.job = job
    // Operation-dependent failures: the failure clock only runs while processing.
    let remaining = sampleTime(s, rng)
    const processing = remaining
    let repair = 0
    while (remaining >= m.ttf) {
      remaining -= m.ttf
      repair += randExp(rng, s.mttr)
      m.ttf = randExp(rng, s.mtbf)
    }
    m.ttf -= remaining
    const total = processing + repair
    m.repairFrac = total > 0 ? repair / total : 0
    heap.push({ t: now + total, seq: seq++, station: si, machine: mi })
  }

  const findIdle = (si: number): number => machines[si].findIndex((m) => m.state === 'idle')

  /** Move blocked jobs downstream and start work wherever possible until nothing changes. */
  const settle = (now: number) => {
    let changed = true
    while (changed) {
      changed = false
      for (let si = N - 1; si >= 0; si--) {
        for (let mi = 0; mi < machines[si].length; mi++) {
          const m = machines[si][mi]
          if (m.state !== 'blocked') continue
          if (si === N - 1) {
            // exit system
            updateWipArea(now)
            wip--
            if (now >= tStart && now <= tEnd) {
              completed++
              cycleSum += now - entry[m.job]
            }
            setState(si, mi, 'idle', now)
            m.job = -1
            changed = true
          } else {
            const down = si + 1
            const idleIdx = findIdle(down)
            if (idleIdx >= 0 && queues[down].length === 0) {
              const job = m.job
              setState(si, mi, 'idle', now)
              m.job = -1
              startService(down, idleIdx, job, now)
              changed = true
            } else if (queues[down].length < cfg.stations[down].bufferBefore) {
              updateQueueArea(down, now)
              queues[down].push(m.job)
              acc[down].qMax = Math.max(acc[down].qMax, queues[down].length)
              setState(si, mi, 'idle', now)
              m.job = -1
              changed = true
            }
          }
        }
      }
      for (let si = 0; si < N; si++) {
        for (let mi = 0; mi < machines[si].length; mi++) {
          const m = machines[si][mi]
          if (m.state !== 'idle') continue
          if (si === 0) {
            const job = entry.length
            entry.push(now)
            updateWipArea(now)
            wip++
            startService(0, mi, job, now)
            changed = true
          } else if (queues[si].length > 0) {
            updateQueueArea(si, now)
            const job = queues[si].shift()!
            startService(si, mi, job, now)
            changed = true
          }
        }
      }
    }
  }

  settle(0)
  for (;;) {
    const ev = heap.pop()
    if (!ev || ev.t > tEnd) break
    recordTrace(ev.t)
    setState(ev.station, ev.machine, 'blocked', ev.t)
    settle(ev.t)
  }
  // Close all open intervals at the end of the run.
  for (let si = 0; si < N; si++) {
    updateQueueArea(si, tEnd)
    for (const m of machines[si]) closeInterval(si, m, tEnd)
  }
  updateWipArea(tEnd)
  recordTrace(tEnd)

  const stations: StationResult[] = cfg.stations.map((s, si) => {
    const a = acc[si]
    const total = s.machines * cfg.duration
    const avail = s.mtbf > 0 ? s.mtbf / (s.mtbf + s.mttr) : 1
    return {
      name: s.name,
      processing: a.proc / total,
      down: a.down / total,
      blocked: a.blocked / total,
      starved: a.idle / total,
      busy: (a.proc + a.down) / total,
      avgQueue: a.qArea / cfg.duration,
      maxQueue: a.qMax,
      capacityPerHour: (s.machines * avail * 60) / s.mean,
    }
  })
  const bottleneck = pickBottleneck(
    stations.map((s) => s.busy),
    stations.map((s) => s.capacityPerHour)
  )
  return {
    jobs: completed,
    throughputPerHour: (completed / cfg.duration) * 60,
    avgCycleTime: completed ? cycleSum / completed : NaN,
    avgWip: wipArea / cfg.duration,
    stations,
    bottleneck,
    wipTrace,
  }
}

export interface Summary {
  mean: number
  ci: number
  sd: number
}

export interface ReplicatedResult {
  reps: number
  throughputPerHour: Summary
  avgCycleTime: Summary
  avgWip: Summary
  stations: { name: string; busy: Summary; blocked: Summary; starved: Summary; down: Summary; avgQueue: Summary }[]
  bottleneck: number
  bottleneckVotes: number[]
  /** First replication, for display (WIP trace). */
  sample: RunResult
}

function summarize(xs: number[]): Summary {
  const m = mean(xs)
  if (xs.length < 2) return { mean: m, ci: 0, sd: 0 }
  const sd = stdev(xs)
  return { mean: m, sd, ci: (tCrit95(xs.length - 1) * sd) / Math.sqrt(xs.length) }
}

export function replicate(cfg: SimCfg, reps: number): ReplicatedResult {
  const runs: RunResult[] = []
  for (let r = 0; r < reps; r++) runs.push(runOnce({ ...cfg, seed: cfg.seed + r * 7919, sampleEvery: r === 0 ? cfg.sampleEvery : 0 }))
  const N = cfg.stations.length
  const votes = new Array(N).fill(0)
  for (const r of runs) votes[r.bottleneck]++
  const stations = cfg.stations.map((s, i) => ({
    name: s.name,
    busy: summarize(runs.map((r) => r.stations[i].busy)),
    blocked: summarize(runs.map((r) => r.stations[i].blocked)),
    starved: summarize(runs.map((r) => r.stations[i].starved)),
    down: summarize(runs.map((r) => r.stations[i].down)),
    avgQueue: summarize(runs.map((r) => r.stations[i].avgQueue)),
  }))
  const bn = pickBottleneck(
    stations.map((s) => s.busy.mean),
    runs[0].stations.map((s) => s.capacityPerHour)
  )
  return {
    reps,
    throughputPerHour: summarize(runs.map((r) => r.throughputPerHour)),
    avgCycleTime: summarize(runs.map((r) => r.avgCycleTime)),
    avgWip: summarize(runs.map((r) => r.avgWip)),
    stations,
    bottleneck: bn,
    bottleneckVotes: votes,
    sample: runs[0],
  }
}
