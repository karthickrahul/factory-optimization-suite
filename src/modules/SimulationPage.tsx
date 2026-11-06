import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Callout, Card, CellNumber, FileDrop, Kpi, NumberField } from '../components/ui'
import { downloadText, fmt, isNumericHeader, parseCsv, pct, toNumber } from '../lib/io'
import { SAMPLE_STATIONS } from '../lib/samples'
import { replicate, validateCfg, type Dist, type ReplicatedResult, type SimCfg, type StationCfg } from '../lib/simulation'

const DISTS: Dist[] = ['constant', 'normal', 'lognormal', 'exponential']

const clone = (s: StationCfg[]) => s.map((x) => ({ ...x }))

function importStations(text: string): StationCfg[] {
  const { headers, rows } = parseCsv(text)
  const find = (re: RegExp) => headers.find((h) => re.test(h))
  const nameCol = find(/name|station|op/i) ?? headers[0]
  const meanCol = find(/mean|time|proc|cycle/i) ?? headers.find((h) => h !== nameCol && isNumericHeader(rows, h))
  if (!meanCol) throw new Error('Could not find a processing-time column. Use headers like: Name, Machines, MeanTime, Dist, CV, MTBF, MTTR, Buffer.')
  const machCol = find(/machine|parallel|count/i)
  const distCol = find(/dist/i)
  const cvCol = find(/^cv|variab/i)
  const mtbfCol = find(/mtbf/i)
  const mttrCol = find(/mttr/i)
  const bufCol = find(/buffer|queue|capacity/i)
  const num = (col: string | undefined, r: Record<string, string>, d: number) => {
    if (!col) return d
    const v = toNumber(r[col])
    return Number.isNaN(v) ? d : v
  }
  const out: StationCfg[] = []
  for (const r of rows) {
    const name = (r[nameCol] ?? '').trim()
    if (!name) continue
    const mean = toNumber(r[meanCol])
    if (Number.isNaN(mean)) throw new Error(`${name}: processing time "${r[meanCol]}" is not a number.`)
    const d = (distCol ? (r[distCol] ?? '').trim().toLowerCase() : 'normal') as Dist
    const bufRaw = bufCol ? (r[bufCol] ?? '').trim().toLowerCase() : ''
    out.push({
      name,
      machines: Math.max(1, Math.round(num(machCol, r, 1))),
      mean,
      dist: DISTS.includes(d) ? d : 'normal',
      cv: num(cvCol, r, 0.2),
      mtbf: num(mtbfCol, r, 0),
      mttr: num(mttrCol, r, 0),
      bufferBefore: bufRaw === '' || bufRaw === 'inf' || bufRaw === 'unlimited' ? Infinity : num(bufCol, r, Infinity),
    })
  }
  if (!out.length) throw new Error('No stations found in the file.')
  return out
}

/** Blank = unlimited buffer. */
function BufferCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? (Number.isFinite(value) ? String(value) : '')
  return (
    <input
      className="cell-input"
      style={{ width: 64 }}
      inputMode="numeric"
      placeholder="∞"
      value={shown}
      onChange={(e) => {
        setText(e.target.value)
        const t = e.target.value.trim()
        if (t === '') return onChange(Infinity)
        const n = Number(t)
        if (Number.isFinite(n) && n >= 0) onChange(Math.floor(n))
      }}
      onBlur={() => setText(null)}
    />
  )
}

interface Scenario {
  label: string
  result: ReplicatedResult
}

export default function SimulationPage() {
  const [stations, setStations] = useState<StationCfg[]>(clone(SAMPLE_STATIONS))
  const [warmup, setWarmup] = useState<number | undefined>(480)
  const [duration, setDuration] = useState<number | undefined>(4800)
  const [reps, setReps] = useState<number | undefined>(20)
  const [seed, setSeed] = useState<number | undefined>(1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReplicatedResult | null>(null)
  const [ranCfg, setRanCfg] = useState<SimCfg | null>(null)
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const cfg: SimCfg = useMemo(
    () => ({ stations, warmup: warmup ?? 0, duration: duration ?? 0, seed: seed ?? 1, sampleEvery: Math.max(1, (duration ?? 1000) / 120) }),
    [stations, warmup, duration, seed]
  )
  const nReps = Math.min(100, Math.max(1, Math.round(reps ?? 1)))

  function run(c: SimCfg = cfg, label?: string) {
    const err = validateCfg(c)
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setBusy(true)
    // Yield to the browser so the spinner can paint before the CPU-heavy run.
    setTimeout(() => {
      try {
        const r = replicate(c, nReps)
        if (label) setScenarios((s) => [...s, { label, result: r }])
        else {
          setResult(r)
          setRanCfg(c)
          setScenarios([])
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    }, 20)
  }

  // Run the sample model once on load so first-time viewers see results immediately.
  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (i: number, patch: Partial<StationCfg>) => setStations(stations.map((s, k) => (k === i ? { ...s, ...patch } : s)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= stations.length) return
    const n = [...stations]
    ;[n[i], n[j]] = [n[j], n[i]]
    setStations(n)
  }

  function whatIf(kind: 'machine' | 'faster') {
    if (!result || !ranCfg) return
    const b = result.bottleneck
    const name = ranCfg.stations[b].name
    const next = clone(ranCfg.stations)
    if (kind === 'machine') next[b].machines += 1
    else next[b].mean *= 0.9
    run({ ...ranCfg, stations: next }, kind === 'machine' ? `+1 machine at ${name}` : `10% faster at ${name}`)
  }

  const stateData =
    result?.stations.map((s) => ({
      name: s.name,
      Processing: +(Math.max(0, s.busy.mean - s.down.mean) * 100).toFixed(1),
      'Down (repair)': +(s.down.mean * 100).toFixed(1),
      Blocked: +(s.blocked.mean * 100).toFixed(1),
      Starved: +(s.starved.mean * 100).toFixed(1),
    })) ?? []

  const wipData = result?.sample.wipTrace.map((p) => ({ t: Math.round(p.t), wip: +p.wip.toFixed(1) })) ?? []

  function exportCsv() {
    if (!result) return
    const lines = ['station,busy_pct,processing_pct,down_pct,blocked_pct,starved_pct,avg_queue']
    for (const s of result.stations)
      lines.push(
        [`"${s.name.replace(/"/g, '""')}"`, (s.busy.mean * 100).toFixed(1), ((s.busy.mean - s.down.mean) * 100).toFixed(1), (s.down.mean * 100).toFixed(1), (s.blocked.mean * 100).toFixed(1), (s.starved.mean * 100).toFixed(1), s.avgQueue.mean.toFixed(2)].join(',')
      )
    lines.push('')
    lines.push(`throughput_per_hour,${result.throughputPerHour.mean.toFixed(2)},ci95,${result.throughputPerHour.ci.toFixed(2)}`)
    lines.push(`avg_cycle_time_min,${result.avgCycleTime.mean.toFixed(2)},ci95,${result.avgCycleTime.ci.toFixed(2)}`)
    lines.push(`avg_wip,${result.avgWip.mean.toFixed(2)},ci95,${result.avgWip.ci.toFixed(2)}`)
    lines.push(`replications,${result.reps}`)
    downloadText(lines.join('\n'), 'flow-simulation.csv')
  }

  const baseTp = result?.throughputPerHour.mean ?? 0

  return (
    <div className="stack">
      <div>
        <h2>Factory Flow Simulator</h2>
        <p className="muted">
          Model a production line as stations in series with parallel machines, finite buffers, random processing times and breakdowns. Run many replications for confidence intervals, find the bottleneck, then test what-if changes before spending money.
        </p>
      </div>

      <Card
        title="1. Line model"
        actions={
          <>
            <button className="btn small" onClick={() => setStations(clone(SAMPLE_STATIONS))}>
              Reset to sample
            </button>
            <button
              className="btn small"
              onClick={() => setStations([...stations, { name: `Station ${stations.length + 1}`, machines: 1, mean: 1, dist: 'normal', cv: 0.2, mtbf: 0, mttr: 0, bufferBefore: 5 }])}
            >
              + Add station
            </button>
          </>
        }
      >
        <div className="table-wrap">
          <table className="edit-table">
            <thead>
              <tr>
                <th>Station</th>
                <th>Machines</th>
                <th>Mean time (min)</th>
                <th>Distribution</th>
                <th>CV</th>
                <th>MTBF (min)</th>
                <th>MTTR (min)</th>
                <th title="Queue capacity in front of the station. Blank = unlimited. Ignored for the first station.">Buffer before</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stations.map((s, i) => (
                <tr key={i}>
                  <td>
                    <input className="cell-input" style={{ width: 120 }} value={s.name} onChange={(e) => update(i, { name: e.target.value })} aria-label={`Station ${i + 1} name`} />
                  </td>
                  <td>
                    <CellNumber width={56} value={s.machines} onChange={(v) => update(i, { machines: Math.max(1, Math.round(v)) })} />
                  </td>
                  <td>
                    <CellNumber width={70} value={s.mean} onChange={(v) => update(i, { mean: v })} />
                  </td>
                  <td>
                    <select className="cell-input" value={s.dist} onChange={(e) => update(i, { dist: e.target.value as Dist })}>
                      {DISTS.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <CellNumber width={56} value={s.cv} onChange={(v) => update(i, { cv: v })} />
                  </td>
                  <td>
                    <CellNumber width={66} value={s.mtbf} onChange={(v) => update(i, { mtbf: v })} />
                  </td>
                  <td>
                    <CellNumber width={60} value={s.mttr} onChange={(v) => update(i, { mttr: v })} />
                  </td>
                  <td>{i === 0 ? <span className="muted">–</span> : <BufferCell value={s.bufferBefore} onChange={(v) => update(i, { bufferBefore: v })} />}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small ghost" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}>
                      ↑
                    </button>
                    <button className="btn small ghost" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === stations.length - 1}>
                      ↓
                    </button>
                    <button className="btn small ghost" onClick={() => setStations(stations.filter((_, k) => k !== i))} aria-label={`Remove ${s.name}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Jobs flow left to right. A finished job waits (blocks the machine) if the next buffer is full. CV applies to normal and lognormal times; exponential has CV = 1.
        </p>
        <div style={{ marginTop: 10 }}>
          <FileDrop
            label="Or drop a CSV: Name, Machines, MeanTime, Dist, CV, MTBF, MTTR, Buffer"
            onText={(t) => {
              try {
                setStations(importStations(t))
                setImportError(null)
              } catch (e) {
                setImportError(e instanceof Error ? e.message : String(e))
              }
            }}
          />
          {importError && <Callout tone="bad">{importError}</Callout>}
        </div>
      </Card>

      <Card title="2. Run settings">
        <div className="row">
          <NumberField label="Warm-up (min)" value={warmup} onChange={setWarmup} hint="Excluded from statistics" />
          <NumberField label="Run length (min)" value={duration} onChange={setDuration} hint="4800 = 10 shifts of 8 h" />
          <NumberField label="Replications" value={reps} onChange={setReps} hint="1 to 100" />
          <NumberField label="Random seed" value={seed} onChange={setSeed} hint="Same seed, same result" />
          <button className="btn primary" onClick={() => run()} disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? 'Simulating…' : 'Run simulation'}
          </button>
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
      </Card>

      {result && (
        <>
          <div className="grid-kpi">
            <Kpi label="Throughput" value={`${fmt(result.throughputPerHour.mean, 1)} /h`} sub={`± ${fmt(result.throughputPerHour.ci, 1)} (95% CI, ${result.reps} runs)`} tone="good" />
            <Kpi label="Avg cycle time" value={`${fmt(result.avgCycleTime.mean, 1)} min`} sub={`± ${fmt(result.avgCycleTime.ci, 1)}`} />
            <Kpi label="Avg WIP" value={fmt(result.avgWip.mean, 1)} sub={`± ${fmt(result.avgWip.ci, 1)} jobs`} />
            <Kpi label="Bottleneck" value={result.stations[result.bottleneck].name} sub={`${pct(result.stations[result.bottleneck].busy.mean, 0)} busy, flagged in ${result.bottleneckVotes[result.bottleneck]}/${result.reps} runs`} tone="warn" />
          </div>

          <div className="grid-3">
            <Card title="Where each station spends its time" actions={<button className="btn small" onClick={exportCsv}>Export CSV</button>}>
              <div className="chart-box tall">
                <ResponsiveContainer>
                  <BarChart data={stateData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf1" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} allowDataOverflow tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Processing" stackId="a" fill="#0b6e6e" isAnimationActive={false} />
                    <Bar dataKey="Down (repair)" stackId="a" fill="#c0392b" isAnimationActive={false} />
                    <Bar dataKey="Blocked" stackId="a" fill="#e08a00" isAnimationActive={false} />
                    <Bar dataKey="Starved" stackId="a" fill="#b8c4d0" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>
                The bottleneck is busy nearly all the time and is rarely starved. Stations upstream of it show blocking; those downstream show starvation.
              </p>
            </Card>
            <Card title="Work in process over time (first replication)">
              <div className="chart-box tall">
                <ResponsiveContainer>
                  <LineChart data={wipData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf1" />
                    <XAxis dataKey="t" tick={{ fontSize: 12 }} label={{ value: 'minutes', position: 'insideBottom', offset: -2, fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Line type="stepAfter" dataKey="wip" stroke="#0b6e6e" dot={false} strokeWidth={2} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card title="Station detail">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th className="num">Busy</th>
                    <th className="num">Blocked</th>
                    <th className="num">Starved</th>
                    <th className="num">Avg queue</th>
                    <th className="num">Capacity /h</th>
                  </tr>
                </thead>
                <tbody>
                  {result.stations.map((s, i) => (
                    <tr key={i} style={i === result.bottleneck ? { background: 'var(--accent-soft)' } : undefined}>
                      <td>
                        {s.name} {i === result.bottleneck && <span className="badge">bottleneck</span>}
                      </td>
                      <td className="num">{pct(s.busy.mean)}</td>
                      <td className="num">{pct(s.blocked.mean)}</td>
                      <td className="num">{pct(s.starved.mean)}</td>
                      <td className="num">{fmt(s.avgQueue.mean, 1)}</td>
                      <td className="num">{fmt(result.sample.stations[i].capacityPerHour, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title="3. What-if scenarios"
            actions={
              <>
                <button className="btn small" onClick={() => whatIf('machine')} disabled={busy}>
                  +1 machine at bottleneck
                </button>
                <button className="btn small" onClick={() => whatIf('faster')} disabled={busy}>
                  10% faster at bottleneck
                </button>
              </>
            }
          >
            {scenarios.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Try a change at the bottleneck and compare against the baseline. Scenarios use the same seeds, so differences come from the change, not from luck.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th className="num">Throughput /h</th>
                      <th className="num">Change</th>
                      <th className="num">Cycle time (min)</th>
                      <th className="num">Avg WIP</th>
                      <th>New bottleneck</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Baseline</td>
                      <td className="num">{fmt(baseTp, 1)}</td>
                      <td className="num">–</td>
                      <td className="num">{fmt(result.avgCycleTime.mean, 1)}</td>
                      <td className="num">{fmt(result.avgWip.mean, 1)}</td>
                      <td>{result.stations[result.bottleneck].name}</td>
                    </tr>
                    {scenarios.map((sc, i) => {
                      const d = sc.result.throughputPerHour.mean - baseTp
                      return (
                        <tr key={i}>
                          <td>{sc.label}</td>
                          <td className="num">{fmt(sc.result.throughputPerHour.mean, 1)}</td>
                          <td className="num" style={{ color: d >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                            {d >= 0 ? '+' : ''}
                            {fmt(d, 1)} ({d >= 0 ? '+' : ''}
                            {fmt((d / baseTp) * 100, 1)}%)
                          </td>
                          <td className="num">{fmt(sc.result.avgCycleTime.mean, 1)}</td>
                          <td className="num">{fmt(sc.result.avgWip.mean, 1)}</td>
                          <td>{sc.result.stations[sc.result.bottleneck].name}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
