import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Callout, Card, CellNumber, FileDrop, Kpi, NumberField } from '../components/ui'
import {
  BalancingError,
  balance,
  compareHeuristics,
  HEURISTICS,
  parsePredecessors,
  taktTime,
  type BalanceResult,
  type Heuristic,
  type Task,
} from '../lib/balancing'
import { downloadBlob, downloadText, fmt, isNumericHeader, parseCsv, pct, toNumber } from '../lib/io'
import { SAMPLE_TASKS } from '../lib/samples'

interface Row {
  id: string
  name: string
  time: number
  preds: string
}

const toRows = (tasks: Task[]): Row[] => tasks.map((t) => ({ id: t.id, name: t.name, time: t.time, preds: t.predecessors.join(', ') }))

function nextId(rows: Row[]): string {
  const used = new Set(rows.map((r) => r.id))
  for (let i = 0; i < 702; i++) {
    const id = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26))
    if (!used.has(id)) return id
  }
  return `T${rows.length + 1}`
}

function importTasks(text: string): Row[] {
  const { headers, rows } = parseCsv(text)
  const find = (re: RegExp) => headers.find((h) => re.test(h))
  const idCol = find(/^(id|task|task.?id|code|op|operation)$/i) ?? headers[0]
  const nameCol = find(/name|desc|operation|title/i)
  const timeCol = find(/time|duration|sec|min|cycle/i) ?? headers.find((h) => h !== idCol && isNumericHeader(rows, h))
  const predCol = find(/pred|precede|before|depend/i)
  if (!timeCol) throw new Error('Could not find a time column. Use headers like: Task, Name, Time, Predecessors.')
  const out: Row[] = []
  for (const r of rows) {
    const id = (r[idCol] ?? '').trim()
    if (!id) continue
    const time = toNumber(r[timeCol])
    if (Number.isNaN(time)) throw new Error(`Task ${id}: time "${r[timeCol]}" is not a number.`)
    out.push({ id, name: nameCol && nameCol !== idCol ? (r[nameCol] ?? '').trim() : id, time, preds: predCol ? (r[predCol] ?? '').trim() : '' })
  }
  if (!out.length) throw new Error('No tasks found in the file.')
  return out
}

const COLORS = ['#0b6e6e', '#2a8f8a', '#4aa6a1', '#6bb8b4', '#8cc9c5']

export default function BalancingPage() {
  const [rows, setRows] = useState<Row[]>(toRows(SAMPLE_TASKS))
  const [unit, setUnit] = useState('sec')
  const [mode, setMode] = useState<'cycle' | 'takt'>('takt')
  const [cycle, setCycle] = useState<number | undefined>(100)
  const [avail, setAvail] = useState<number | undefined>(27000)
  const [demand, setDemand] = useState<number | undefined>(270)
  const [heur, setHeur] = useState<Heuristic>('RPW')
  const [importError, setImportError] = useState<string | null>(null)

  const takt = useMemo(() => {
    try {
      return avail && demand ? taktTime(avail, demand) : undefined
    } catch {
      return undefined
    }
  }, [avail, demand])
  const cycleTime = mode === 'takt' ? takt : cycle

  const tasks: Task[] = useMemo(() => rows.map((r) => ({ id: r.id.trim(), name: r.name || r.id, time: r.time, predecessors: parsePredecessors(r.preds) })), [rows])

  const out = useMemo<{ best?: BalanceResult; all?: BalanceResult[]; chosen?: BalanceResult; error?: string }>(() => {
    try {
      if (cycleTime === undefined) throw new BalancingError(mode === 'takt' ? 'Enter available time and demand to get the takt time.' : 'Enter a cycle time.')
      const all = compareHeuristics(tasks, cycleTime)
      return { all, best: all[0], chosen: balance(tasks, cycleTime, heur) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [tasks, cycleTime, heur, mode])

  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const res = out.chosen

  function exportCsv() {
    if (!res) return
    const lines = ['station,task,name,time,station_load,idle']
    for (const s of res.stations) for (const t of s.tasks) lines.push(`${s.index},${t.id},"${t.name.replace(/"/g, '""')}",${t.time},${s.load},${s.idle}`)
    downloadText(lines.join('\n'), 'line-balance.csv')
  }

  async function exportXlsx() {
    if (!res) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const assign = res.stations.flatMap((s) => s.tasks.map((t) => ({ Station: s.index, Task: t.id, Name: t.name, [`Time (${unit})`]: t.time, Predecessors: t.predecessors.join(', ') })))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(assign), 'Assignment')
    const loads = res.stations.map((s) => ({
      Station: s.index,
      Tasks: s.tasks.map((t) => t.id).join(', '),
      [`Load (${unit})`]: s.load,
      [`Idle (${unit})`]: s.idle,
      'Utilisation %': +((s.load / res.cycleTime) * 100).toFixed(1),
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(loads), 'Stations')
    const summary = [
      { Metric: 'Heuristic', Value: HEURISTICS[res.heuristic].label },
      { Metric: `Cycle time (${unit})`, Value: res.cycleTime },
      { Metric: 'Stations', Value: res.stations.length },
      { Metric: 'Theoretical minimum stations', Value: res.minStations },
      { Metric: `Total task time (${unit})`, Value: res.totalTime },
      { Metric: 'Line efficiency %', Value: +(res.efficiency * 100).toFixed(2) },
      { Metric: 'Balance delay %', Value: +(res.balanceDelay * 100).toFixed(2) },
      { Metric: 'Smoothness index', Value: +res.smoothnessIndex.toFixed(3) },
      { Metric: `Achievable cycle time (${unit})`, Value: res.actualCycleTime },
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary')
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'line-balance.xlsx')
  }

  const chartData = res?.stations.map((s) => ({ name: `S${s.index}`, load: s.load, idle: s.idle, tasks: s.tasks.map((t) => t.id).join(' ') })) ?? []

  return (
    <div className="stack">
      <div>
        <h2>Assembly Line Balancing Studio</h2>
        <p className="muted">
          Enter tasks, times and precedence. The studio compares four classic heuristics, assigns tasks to stations for your takt or cycle time, and shows efficiency, balance delay and the bottleneck. Export to Excel or CSV.
        </p>
      </div>
      <div className="two-col">
        <div className="stack">
          <Card title="1. Target">
            <div className="stack">
              <label className="field">
                Time unit
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="sec">seconds</option>
                  <option value="min">minutes</option>
                </select>
              </label>
              <label className="field">
                Set the target by
                <select value={mode} onChange={(e) => setMode(e.target.value as 'cycle' | 'takt')}>
                  <option value="takt">Demand (takt time)</option>
                  <option value="cycle">Cycle time directly</option>
                </select>
              </label>
              {mode === 'takt' ? (
                <>
                  <NumberField label={`Available time per period (${unit})`} value={avail} onChange={setAvail} hint="e.g. 27 000 s = 7.5 h shift" />
                  <NumberField label="Required output per period (units)" value={demand} onChange={setDemand} />
                  <div className="callout">
                    Takt time: <strong style={{ display: 'inline' }}>{takt === undefined ? '–' : `${fmt(takt)} ${unit}`}</strong>
                  </div>
                </>
              ) : (
                <NumberField label={`Cycle time (${unit})`} value={cycle} onChange={setCycle} />
              )}
              <label className="field">
                Heuristic for the detailed view
                <select value={heur} onChange={(e) => setHeur(e.target.value as Heuristic)}>
                  {(Object.keys(HEURISTICS) as Heuristic[]).map((h) => (
                    <option key={h} value={h}>
                      {HEURISTICS[h].label}
                    </option>
                  ))}
                </select>
                <span className="hint">{HEURISTICS[heur].description}</span>
              </label>
            </div>
          </Card>
          <Card title="Import tasks">
            <div className="stack">
              <FileDrop
                label="Drop a CSV: Task, Name, Time, Predecessors"
                onText={(t) => {
                  try {
                    setRows(importTasks(t))
                    setImportError(null)
                  } catch (e) {
                    setImportError(e instanceof Error ? e.message : String(e))
                  }
                }}
              />
              {importError && <Callout tone="bad">{importError}</Callout>}
              <div className="row">
                <button className="btn small" onClick={() => setRows(toRows(SAMPLE_TASKS))}>
                  Reset to sample (pump assembly)
                </button>
                <button className="btn small" onClick={() => setRows([])}>
                  Clear all
                </button>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                Predecessors: list task IDs separated by commas, e.g. <span className="mono">B, C</span>. Leave empty for the first tasks.
              </p>
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card
            title={`2. Tasks (${rows.length})`}
            actions={
              <button className="btn small primary" onClick={() => setRows([...rows, { id: nextId(rows), name: '', time: 10, preds: '' }])}>
                + Add task
              </button>
            }
          >
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
              <table className="edit-table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>ID</th>
                    <th>Name</th>
                    <th style={{ width: 90 }}>Time ({unit})</th>
                    <th style={{ width: 160 }}>Predecessors</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <input className="cell-input" value={r.id} aria-label={`Task ${i + 1} ID`} onChange={(e) => update(i, { id: e.target.value })} />
                      </td>
                      <td>
                        <input className="cell-input" value={r.name} aria-label={`Task ${i + 1} name`} onChange={(e) => update(i, { name: e.target.value })} />
                      </td>
                      <td>
                        <CellNumber value={r.time} onChange={(v) => update(i, { time: v })} />
                      </td>
                      <td>
                        <input className="cell-input" value={r.preds} aria-label={`Task ${i + 1} predecessors`} onChange={(e) => update(i, { preds: e.target.value })} />
                      </td>
                      <td>
                        <button className="btn small ghost" aria-label={`Delete task ${r.id}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {out.error && (
            <Callout tone="bad" title="Cannot balance yet">
              {out.error}
            </Callout>
          )}

          {res && out.all && out.best && (
            <>
              <div className="grid-kpi">
                <Kpi label="Stations" value={res.stations.length} sub={`theoretical minimum ${res.minStations}`} tone={res.stations.length === res.minStations ? 'good' : 'warn'} />
                <Kpi label="Line efficiency" value={pct(res.efficiency)} tone={res.efficiency >= 0.85 ? 'good' : res.efficiency >= 0.7 ? 'warn' : 'bad'} sub={`balance delay ${pct(res.balanceDelay)}`} />
                <Kpi label="Cycle time target" value={`${fmt(res.cycleTime)} ${unit}`} sub={`achievable ${fmt(res.actualCycleTime)} ${unit}`} />
                <Kpi label="Bottleneck" value={`Station ${res.bottleneckStation}`} sub={`load ${fmt(res.actualCycleTime)} ${unit}`} />
                <Kpi label="Smoothness index" value={fmt(res.smoothnessIndex, 1)} sub="lower is better" />
              </div>

              {res.stations.length > res.minStations && (
                <Callout tone="warn" title="Room to improve">
                  The line needs {res.stations.length} stations but the theoretical minimum is {res.minStations}. {out.best.stations.length < res.stations.length ? `The ${HEURISTICS[out.best.heuristic].label} heuristic reaches ${out.best.stations.length}; switch heuristic above.` : 'Precedence constraints or task sizes may prevent reaching the minimum; consider splitting a large task or re-sequencing.'}
                </Callout>
              )}

              <Card
                title="Station loads"
                actions={
                  <>
                    <button className="btn small" onClick={exportCsv}>
                      CSV
                    </button>
                    <button className="btn small primary" onClick={exportXlsx}>
                      Excel report
                    </button>
                  </>
                }
              >
                <div className="chart-box">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke="#e6ebf0" strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 11 }} unit={` ${unit}`} width={64} />
                      <Tooltip formatter={(v, n) => [`${fmt(Number(v))} ${unit}`, n === 'load' ? 'Load' : 'Idle']} labelFormatter={(l, p) => `${l}: ${p?.[0]?.payload?.tasks ?? ''}`} />
                      <ReferenceLine y={res.cycleTime} stroke="#c0392b" strokeDasharray="6 4" label={{ value: 'cycle time', position: 'insideTopRight', fill: '#c0392b', fontSize: 11 }} />
                      <Bar dataKey="load" stackId="a" isAnimationActive={false}>
                        {chartData.map((_, i) => (
                          <Cell key={i} fill={i + 1 === res.bottleneckStation ? '#e08a00' : COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                      <Bar dataKey="idle" stackId="a" fill="#e3e9ef" isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="legend">
                  <span>
                    <i style={{ background: '#0b6e6e' }} />
                    Work
                  </span>
                  <span>
                    <i style={{ background: '#e08a00' }} />
                    Bottleneck station
                  </span>
                  <span>
                    <i style={{ background: '#e3e9ef' }} />
                    Idle time
                  </span>
                </div>
              </Card>

              <Card title="Station assignment">
                <div className="station-grid">
                  {res.stations.map((s) => (
                    <div key={s.index} className={`station-card ${s.index === res.bottleneckStation ? 'bottleneck' : ''}`}>
                      <h4>
                        <span>Station {s.index}</span>
                        <span className="muted small">{pct(s.load / res.cycleTime, 0)}</span>
                      </h4>
                      <div className="load-bar">
                        <span style={{ width: `${Math.min(100, (s.load / res.cycleTime) * 100)}%` }} />
                      </div>
                      <div>
                        {s.tasks.map((t) => (
                          <span key={t.id} className="chip" title={`${t.name}: ${t.time} ${unit}`}>
                            {t.id} · {t.name} ({t.time})
                          </span>
                        ))}
                      </div>
                      <div className="small muted">
                        load {fmt(s.load, 1)} / idle {fmt(s.idle, 1)} {unit}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Heuristic comparison">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Heuristic</th>
                        <th className="num">Stations</th>
                        <th className="num">Efficiency</th>
                        <th className="num">Balance delay</th>
                        <th className="num">Smoothness</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {out.all.map((r, i) => (
                        <tr key={r.heuristic}>
                          <td>{HEURISTICS[r.heuristic].label}</td>
                          <td className="num">{r.stations.length}</td>
                          <td className="num">{pct(r.efficiency)}</td>
                          <td className="num">{pct(r.balanceDelay)}</td>
                          <td className="num">{fmt(r.smoothnessIndex, 1)}</td>
                          <td>{i === 0 && <span className="badge good">best</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
