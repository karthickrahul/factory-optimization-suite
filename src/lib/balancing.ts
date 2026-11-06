// Assembly line balancing (SALBP-1): minimise stations for a given cycle time.

export interface Task {
  id: string
  name: string
  time: number
  predecessors: string[]
}

export type Heuristic = 'RPW' | 'LCR' | 'MFT' | 'SPT'

export const HEURISTICS: Record<Heuristic, { label: string; description: string }> = {
  RPW: {
    label: 'Ranked positional weight',
    description: 'Prioritise tasks by own time plus the time of all tasks that must follow (Helgeson-Birnie).',
  },
  LCR: { label: 'Largest candidate rule', description: 'Among assignable tasks, take the one with the longest time.' },
  MFT: { label: 'Most following tasks', description: 'Prioritise tasks that have the most successors, ties by longest time.' },
  SPT: { label: 'Shortest task first', description: 'Take the shortest assignable task. Usually worse; useful as a baseline.' },
}

export interface Station {
  index: number
  tasks: Task[]
  load: number
  idle: number
}

export interface BalanceResult {
  heuristic: Heuristic
  cycleTime: number
  stations: Station[]
  totalTime: number
  minStations: number
  efficiency: number
  balanceDelay: number
  smoothnessIndex: number
  bottleneckStation: number
  /** Largest station load: the cycle time the line can really achieve. */
  actualCycleTime: number
}

export class BalancingError extends Error {}

/** Validate the task network; returns a topological order. */
export function validateTasks(tasks: Task[], cycleTime: number): string[] {
  if (tasks.length === 0) throw new BalancingError('Add at least one task.')
  if (!(cycleTime > 0)) throw new BalancingError('Cycle time must be greater than zero.')
  const ids = new Set<string>()
  for (const t of tasks) {
    if (!t.id.trim()) throw new BalancingError('Every task needs an ID.')
    if (ids.has(t.id)) throw new BalancingError(`Duplicate task ID "${t.id}".`)
    ids.add(t.id)
    if (!(t.time > 0)) throw new BalancingError(`Task ${t.id}: time must be greater than zero.`)
    if (t.time > cycleTime)
      throw new BalancingError(
        `Task ${t.id} takes ${t.time}, longer than the cycle time ${cycleTime}. It cannot fit in any station; raise the cycle time, split the task or duplicate the station.`
      )
  }
  for (const t of tasks) {
    for (const p of t.predecessors) {
      if (!ids.has(p)) throw new BalancingError(`Task ${t.id} lists unknown predecessor "${p}".`)
      if (p === t.id) throw new BalancingError(`Task ${t.id} cannot be its own predecessor.`)
    }
  }
  // Kahn's algorithm
  const indeg = new Map(tasks.map((t) => [t.id, new Set(t.predecessors).size]))
  const succ = new Map<string, string[]>(tasks.map((t) => [t.id, []]))
  for (const t of tasks) for (const p of new Set(t.predecessors)) succ.get(p)!.push(t.id)
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const s of succ.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) queue.push(s)
    }
  }
  if (order.length !== tasks.length) throw new BalancingError('The precedence network contains a cycle. Remove the circular dependency.')
  return order
}

/** Set of all (transitive) successors per task. */
function successorSets(tasks: Task[], order: string[]): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>(tasks.map((t) => [t.id, new Set()]))
  for (const t of tasks) for (const p of t.predecessors) direct.get(p)!.add(t.id)
  const all = new Map<string, Set<string>>()
  for (const id of [...order].reverse()) {
    const s = new Set<string>()
    for (const d of direct.get(id)!) {
      s.add(d)
      for (const x of all.get(d)!) s.add(x)
    }
    all.set(id, s)
  }
  return all
}

export function balance(tasks: Task[], cycleTime: number, heuristic: Heuristic): BalanceResult {
  const order = validateTasks(tasks, cycleTime)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const succ = successorSets(tasks, order)
  const weight = new Map<string, number>()
  for (const t of tasks) {
    let w = t.time
    for (const s of succ.get(t.id)!) w += byId.get(s)!.time
    weight.set(t.id, w)
  }
  const orderIdx = new Map(order.map((id, i) => [id, i]))
  // Priority: higher score first; ties broken by longer time then topological order.
  const score = (t: Task): number => {
    switch (heuristic) {
      case 'RPW':
        return weight.get(t.id)!
      case 'LCR':
        return t.time
      case 'MFT':
        return succ.get(t.id)!.size
      case 'SPT':
        return -t.time
    }
  }
  const compare = (a: Task, b: Task) =>
    score(b) - score(a) || b.time - a.time || orderIdx.get(a.id)! - orderIdx.get(b.id)!

  const assigned = new Set<string>()
  const stations: Station[] = []
  const eps = 1e-9
  while (assigned.size < tasks.length) {
    const st: Station = { index: stations.length + 1, tasks: [], load: 0, idle: 0 }
    for (;;) {
      const candidates = tasks.filter(
        (t) => !assigned.has(t.id) && t.predecessors.every((p) => assigned.has(p)) && st.load + t.time <= cycleTime + eps
      )
      if (candidates.length === 0) break
      candidates.sort(compare)
      const pick = candidates[0]
      st.tasks.push(pick)
      st.load += pick.time
      assigned.add(pick.id)
    }
    if (st.tasks.length === 0) throw new BalancingError('Internal error: could not assign remaining tasks.')
    st.idle = cycleTime - st.load
    stations.push(st)
  }
  return summarize(heuristic, cycleTime, stations, tasks)
}

function summarize(heuristic: Heuristic, cycleTime: number, stations: Station[], tasks: Task[]): BalanceResult {
  const totalTime = tasks.reduce((s, t) => s + t.time, 0)
  const maxLoad = Math.max(...stations.map((s) => s.load))
  const efficiency = totalTime / (stations.length * cycleTime)
  const bottleneck = stations.reduce((b, s) => (s.load > b.load ? s : b), stations[0])
  return {
    heuristic,
    cycleTime,
    stations,
    totalTime,
    minStations: Math.ceil(totalTime / cycleTime - 1e-9),
    efficiency,
    balanceDelay: 1 - efficiency,
    smoothnessIndex: Math.sqrt(stations.reduce((s, st) => s + (maxLoad - st.load) ** 2, 0)),
    bottleneckStation: bottleneck.index,
    actualCycleTime: maxLoad,
  }
}

export function compareHeuristics(tasks: Task[], cycleTime: number): BalanceResult[] {
  const results = (Object.keys(HEURISTICS) as Heuristic[]).map((h) => balance(tasks, cycleTime, h))
  return results.sort((a, b) => a.stations.length - b.stations.length || b.efficiency - a.efficiency || a.smoothnessIndex - b.smoothnessIndex)
}

/** Takt time in the same unit as availableTime / demand. */
export function taktTime(availableTime: number, demand: number): number {
  if (!(availableTime > 0) || !(demand > 0)) throw new BalancingError('Available time and demand must be positive.')
  return availableTime / demand
}

/** Parse a predecessor string such as "A, B" or "A;B" or "-" into an ID list. */
export function parsePredecessors(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '-' && s !== '—')
}
