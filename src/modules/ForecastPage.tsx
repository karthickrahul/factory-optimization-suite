import { useEffect, useMemo, useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Callout, Card, FileDrop, Kpi } from '../components/ui'
import { downloadText, fmt, parseCsv, pct, toNumber } from '../lib/io'
import {
  BURN,
  CLASSICAL,
  METHOD_INFO,
  accuracy,
  atFill,
  classify,
  forecastSeries,
  frontier,
  orderUpTo,
  sigmaPath,
  simulatePart,
  splits,
  type Accuracy,
  type DemandClass,
  type FrontierPoint,
  type Method,
  type PartForecast,
} from '../lib/forecast'

interface Dataset {
  name: string
  source: string
  months: string[]
  parts: string[]
  demand: number[][]
  lgbm?: { firstMonth: number; forecast: number[][]; next: number[] }
}

const COLORS: Record<Method, string> = {
  LightGBM: '#0b6e6e',
  SBA: '#0d2238',
  SES: '#e08a00',
  TSB: '#7b5ea7',
  Croston: '#2f80c1',
  Naive: '#c0392b',
  Mean: '#8aa0b4',
  Zero: '#b8c4d0',
}
const BASELINE: Method = 'SBA'
const DEFAULT_SHOWN: Method[] = ['LightGBM', 'SBA', 'SES', 'TSB']

/** Wide CSV: first column = period, one column per part. Blank cells count as zero demand. */
function importWide(text: string): Dataset {
  const { headers, rows } = parseCsv(text)
  if (headers.length < 2) throw new Error('Expected a period column followed by one column per part.')
  const periodCol = headers[0]
  const partCols = headers.slice(1)
  const demand = partCols.map(() => [] as number[])
  rows.forEach((r, ri) => {
    partCols.forEach((c, ci) => {
      const raw = (r[c] ?? '').trim()
      const v = raw === '' ? 0 : toNumber(raw)
      if (Number.isNaN(v) || v < 0) throw new Error(`Row ${ri + 2}, column "${c}": "${raw}" is not a non-negative number.`)
      demand[ci].push(v)
    })
  })
  return {
    name: 'Your data',
    source: 'Uploaded CSV (processed in your browser)',
    months: rows.map((r, i) => (r[periodCol] ?? '').trim() || String(i + 1)),
    parts: partCols,
    demand,
  }
}

function lgbmSeries(d: Dataset, i: number): number[] {
  const T = d.demand[i].length
  const f = new Array<number>(T + 1).fill(NaN)
  d.lgbm!.forecast[i].forEach((v, k) => (f[d.lgbm!.firstMonth + k] = v))
  f[T] = d.lgbm!.next[i]
  return f
}

interface MethodResult {
  parts: PartForecast[]
  acc: Accuracy
  pts: FrontierPoint[]
  hit: { inv: number; z: number } | null
}

export default function ForecastPage() {
  const [data, setData] = useState<Dataset | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [lead, setLead] = useState(1)
  const [target, setTarget] = useState(0.9)
  const [alpha, setAlpha] = useState(0.1)
  const [beta, setBeta] = useState(0.1)
  const [testMonths, setTestMonths] = useState(12)
  const [shown, setShown] = useState<Method[]>(DEFAULT_SHOWN)
  const [partIdx, setPartIdx] = useState(0)
  const [partQuery, setPartQuery] = useState('')
  const [planMethod, setPlanMethod] = useState<Method | null>(null)

  async function loadSample() {
    try {
      setLoadError(null)
      const base = import.meta.env.BASE_URL
      const [d, l] = await Promise.all([
        fetch(`${base}data/carparts.json`).then((r) => r.json()),
        fetch(`${base}data/lgbm.json`).then((r) => r.json()),
      ])
      setData({ name: 'Car parts (real data)', source: d.source, months: d.months, parts: d.parts, demand: d.demand, lgbm: l })
      setTestMonths(12)
      setPartIdx(busiest(d.demand))
    } catch (e) {
      setLoadError('Could not load the sample data: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  useEffect(() => {
    loadSample()
  }, [])

  const T = data?.demand[0]?.length ?? 0
  const { testStart, evalStart } = splits(T, testMonths)
  const validation =
    !data ? null : T - testMonths < BURN + 3 ? `Need at least ${BURN + 3} months before the test period (you have ${T - testMonths}). Shorten the test period or add history.` : testMonths < 3 ? 'Use a test period of at least 3 months.' : null

  const methods: Method[] = useMemo(() => (data?.lgbm ? ['LightGBM', ...CLASSICAL] : [...CLASSICAL]), [data])

  // Forecasts and sigma per method (independent of lead time and fill target).
  const forecasts = useMemo(() => {
    if (!data || validation) return null
    const out = {} as Record<Method, PartForecast[]>
    for (const m of methods) {
      out[m] = data.demand.map((y, i) => {
        const f = m === 'LightGBM' ? lgbmSeries(data, i) : forecastSeries(y, m, { alpha, beta })
        return { y, f, s: sigmaPath(y, f, evalStart) }
      })
    }
    return out
  }, [data, methods, alpha, beta, evalStart, validation])

  const results = useMemo(() => {
    if (!forecasts) return null
    const out = {} as Record<Method, MethodResult>
    for (const m of methods) {
      const pts = frontier(forecasts[m], lead, testStart)
      out[m] = { parts: forecasts[m], acc: accuracy(forecasts[m], testStart, T), pts, hit: atFill(pts, target) }
    }
    return out
  }, [forecasts, methods, lead, testStart, T, target])

  const classes = useMemo(() => {
    if (!data || validation) return null
    const c = {} as Record<DemandClass, number>
    const per = data.demand.map((y) => classify(y, testStart))
    per.forEach((x) => (c[x.cls] = (c[x.cls] ?? 0) + 1))
    return { counts: c, per }
  }, [data, testStart, validation])

  const ranked = results ? methods.filter((m) => results[m].hit).sort((a, b) => results[a].hit!.inv - results[b].hit!.inv) : []
  const best = ranked[0]
  const base = results?.[BASELINE].hit
  const bestHit = best ? results![best].hit! : null
  const saving = bestHit && base ? 1 - bestHit.inv / base.inv : NaN
  const lowestMae = results ? [...methods].sort((a, b) => results[a].acc.mae - results[b].acc.mae)[0] : undefined
  const chosenPlan: Method | undefined = planMethod && results?.[planMethod]?.hit ? planMethod : best

  function exportPlan() {
    if (!data || !results || !chosenPlan) return
    const r = results[chosenPlan]
    const z = r.hit!.z
    const lines = [['part', 'demand_class', 'next_month_forecast', 'sigma', 'safety_factor_z', 'lead_time_months', 'order_up_to_level', 'safety_stock'].join(',')]
    data.parts.forEach((p, i) => {
      const { f, s } = r.parts[i]
      const S = orderUpTo(f[T], s[T], z, lead)
      lines.push([p, classes?.per[i].cls ?? '', f[T].toFixed(3), s[T].toFixed(3), z.toFixed(2), lead, S, (S - (lead + 1) * f[T]).toFixed(2)].join(','))
    })
    downloadText(lines.join('\n'), `reorder-plan-${chosenPlan}-fill${Math.round(target * 100)}-L${lead}.csv`)
  }

  // ---- chart data
  const part = data && forecasts ? partIdx : -1
  const partChart = useMemo(() => {
    if (!data || !forecasts || part < 0) return []
    return data.months.map((m, t) => {
      const row: Record<string, number | string | null> = { month: m, Actual: data.demand[part][t] }
      for (const k of shown) if (forecasts[k]) row[k] = Number.isFinite(forecasts[k][part].f[t]) ? +forecasts[k][part].f[t].toFixed(3) : null
      return row
    })
  }, [data, forecasts, part, shown])

  const matches = useMemo(() => {
    if (!data || !partQuery.trim()) return []
    const q = partQuery.trim().toLowerCase()
    return data.parts.map((p, i) => ({ p, i })).filter((x) => x.p.toLowerCase().includes(q)).slice(0, 8)
  }, [data, partQuery])

  const partRow = (m: Method) => {
    if (!results || part < 0 || !results[m].hit) return null
    const pf = results[m].parts[part]
    const z = results[m].hit!.z
    const sim = simulatePart(pf.y, pf.f, pf.s, z, lead, testStart)
    return { S: orderUpTo(pf.f[T], pf.s[T], z, lead), fill: sim.demand > 0 ? sim.served / sim.demand : NaN, avg: sim.avgOnhand, next: pf.f[T] }
  }

  return (
    <div className="stack">
      <div>
        <h2>Spare-Parts Demand &amp; Inventory Optimizer</h2>
        <p className="muted">
          Forecast intermittent demand with classical methods and a machine-learning model, then turn each forecast into an order-up-to policy and see how much stock it needs to hit a target fill rate. Methods are judged on inventory outcomes, not only on forecast error.
        </p>
      </div>

      <Card
        title="1. Data"
        actions={
          <button className="btn small" onClick={loadSample}>
            Load car-parts data
          </button>
        }
      >
        {loadError && <Callout tone="bad">{loadError}</Callout>}
        {data ? (
          <p style={{ marginTop: 0 }}>
            <strong>{data.name}:</strong> {fmt(data.parts.length, 0)} parts × {T} months ({data.months[0]} to {data.months[T - 1]}).{' '}
            <span className="muted">{data.source}.</span>
            {data.lgbm && <span className="muted"> Parts with missing months were dropped.</span>}
          </p>
        ) : (
          !loadError && <p className="muted">Loading…</p>
        )}
        <FileDrop
          label="Or drop your own CSV: first column = month, then one column of demand per part (blank = 0)"
          onText={(t) => {
            try {
              const d = importWide(t)
              setData(d)
              setPartIdx(busiest(d.demand))
              setTestMonths(Math.min(12, Math.max(3, d.months.length - BURN - 6)))
              setImportError(null)
            } catch (e) {
              setImportError(e instanceof Error ? e.message : String(e))
            }
          }}
        />
        {importError && <Callout tone="bad">{importError}</Callout>}
        {data && !data.lgbm && (
          <Callout tone="warn">The LightGBM model is trained offline in Python, so uploaded data is compared on the classical methods only.</Callout>
        )}
      </Card>

      <Card title="2. Policy settings">
        <div className="row">
          <label className="field">
            Target fill rate: <strong>{pct(target, 0)}</strong>
            <input type="range" min={0.8} max={0.98} step={0.01} value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Target fill rate" />
            <span className="hint">Share of demand served straight from stock</span>
          </label>
          <label className="field">
            Lead time (months)
            <select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 6].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <span className="hint">Monthly review, orders arrive after this delay</span>
          </label>
          <label className="field">
            Smoothing α
            <select value={alpha} onChange={(e) => setAlpha(Number(e.target.value))}>
              {[0.05, 0.1, 0.15, 0.2, 0.3].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <span className="hint">SES, Croston, SBA, TSB size</span>
          </label>
          <label className="field">
            TSB β
            <select value={beta} onChange={(e) => setBeta(Number(e.target.value))}>
              {[0.05, 0.1, 0.15, 0.2, 0.3].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <span className="hint">Demand-probability smoothing</span>
          </label>
          {data && !data.lgbm && (
            <label className="field">
              Test period (months)
              <select value={testMonths} onChange={(e) => setTestMonths(Number(e.target.value))}>
                {[3, 6, 9, 12, 18, 24].filter((v) => v <= T - BURN - 3).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <span className="hint">Last months held out</span>
            </label>
          )}
        </div>
        {data?.lgbm && alpha !== 0.1 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Changing α affects the classical methods only; LightGBM was trained with α = 0.1 smoothing features.
          </p>
        )}
        {validation && <Callout tone="bad">{validation}</Callout>}
      </Card>

      {results && classes && data && (
        <>
          <div className="grid-kpi">
            <Kpi label="Parts analysed" value={fmt(data.parts.length, 0)} sub={`${fmt(((classes.counts.intermittent ?? 0) + (classes.counts.lumpy ?? 0)) / data.parts.length * 100, 0)}% intermittent or lumpy`} />
            <Kpi label={`Stock for ${pct(target, 0)} fill, ${BASELINE}`} value={base ? fmt(base.inv, 0) : 'not reached'} sub="average units on hand, all parts" />
            <Kpi label={`Best method: ${best ?? '–'}`} value={bestHit ? fmt(bestHit.inv, 0) : '–'} sub={`safety factor z = ${fmt(bestHit?.z, 2)}`} tone="good" />
            <Kpi
              label={`Stock reduction vs ${BASELINE}`}
              value={Number.isFinite(saving) ? pct(saving, 1) : '–'}
              sub={`same ${pct(target, 0)} fill rate, ${testMonths}-month test`}
              tone={saving > 0 ? 'good' : undefined}
            />
          </div>

          <div className="split-3-2">
            <Card title="Stock vs service trade-off (test period)">
              <div className="chart-box tall">
                <ResponsiveContainer>
                  <LineChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf1" />
                    <XAxis type="number" dataKey="inv" tick={{ fontSize: 12 }} domain={['auto', 'auto']} tickFormatter={(v: number) => fmt(v, 0)} label={{ value: 'average stock on hand (units)', position: 'insideBottom', offset: -10, fontSize: 12 }} />
                    <YAxis type="number" dataKey="fill" domain={[0.6, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v, n) => [n === 'fill' ? pct(Number(v)) : fmt(Number(v), 0), n === 'fill' ? 'Fill rate' : 'Stock']} labelFormatter={(v) => `Stock ${fmt(Number(v), 0)}`} />
                    <ReferenceLine y={target} stroke="#c0392b" strokeDasharray="4 4" label={{ value: `target ${pct(target, 0)}`, position: 'insideTopLeft', fontSize: 11, fill: '#c0392b' }} />
                    {shown.filter((m) => results[m]).map((m) => (
                      <Line key={m} data={results[m].pts.filter((p) => p.fill >= 0.6)} dataKey="fill" name={m} stroke={COLORS[m]} strokeWidth={m === best ? 3 : 2} dot={{ r: 2 }} isAnimationActive={false} />
                    ))}
                    <Legend verticalAlign="top" height={28} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>
                Each point is one safety factor z from 0 to 4. A curve further left reaches the same fill rate with less stock. Simulation: monthly review, order-up-to level = (L + 1) × forecast + z × σ × √(L + 1), backorders.
              </p>
            </Card>
            <Card title="Show on charts">
              <div className="stack" style={{ gap: 6 }}>
                {methods.map((m) => (
                  <label key={m} className="check">
                    <input type="checkbox" checked={shown.includes(m)} onChange={(e) => setShown(e.target.checked ? [...shown, m] : shown.filter((x) => x !== m))} />
                    <span>
                      <strong style={{ color: COLORS[m] }}>{m}</strong> <span className="muted">{METHOD_INFO[m]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Method comparison" actions={<span className="muted small">test months {data.months[testStart]} to {data.months[T - 1]}</span>}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th className="num">MAE</th>
                    <th className="num">RMSE</th>
                    <th className="num" title="Forecast minus actual; positive = over-forecasting">Bias</th>
                    <th className="num">Stock for {pct(target, 0)} fill</th>
                    <th className="num">vs {BASELINE}</th>
                    <th className="num">z needed</th>
                  </tr>
                </thead>
                <tbody>
                  {methods.map((m) => {
                    const r = results[m]
                    const d = r.hit && base ? r.hit.inv / base.inv - 1 : NaN
                    return (
                      <tr key={m} style={m === best ? { background: 'var(--primary-soft)' } : undefined}>
                        <td>
                          <strong style={{ color: COLORS[m] }}>{m}</strong> {m === best && <span className="badge good">least stock</span>} {m === lowestMae && <span className="badge">lowest MAE</span>} {m === BASELINE && <span className="badge">baseline</span>}
                        </td>
                        <td className="num">{fmt(r.acc.mae, 3)}</td>
                        <td className="num">{fmt(r.acc.rmse, 3)}</td>
                        <td className="num">{(r.acc.bias >= 0 ? '+' : '') + fmt(r.acc.bias, 3)}</td>
                        <td className="num">{r.hit ? fmt(r.hit.inv, 0) : <span className="muted">not reached</span>}</td>
                        <td className="num" style={{ color: d < 0 ? 'var(--ok)' : d > 0 ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                          {Number.isFinite(d) ? (d > 0 ? '+' : '') + pct(d, 1) : '–'}
                        </td>
                        <td className="num">{r.hit ? fmt(r.hit.z, 2) : '–'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {lowestMae && lowestMae !== best && (
              <Callout title="Lowest error is not the same as least stock. ">
                {lowestMae} has the lowest MAE, but {best} reaches the fill-rate target with the least inventory. On sparse demand, MAE rewards forecasts that sit near zero, which then need large safety stocks. Judge spare-parts forecasts by the inventory and service they produce.
              </Callout>
            )}
          </Card>

          <Card
            title="3. Reorder plan for next month"
            actions={
              <>
                <select className="cell-input" value={chosenPlan} onChange={(e) => setPlanMethod(e.target.value as Method)} aria-label="Method for the reorder plan">
                  {ranked.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <button className="btn small primary" onClick={exportPlan} disabled={!chosenPlan}>
                  Download CSV
                </button>
              </>
            }
          >
            <p className="muted" style={{ margin: 0 }}>
              Order-up-to level and safety stock for every part for the month after the data ends, using {chosenPlan ?? '–'} with the safety factor (z = {fmt(chosenPlan ? results[chosenPlan].hit?.z : undefined, 2)}) that met {pct(target, 0)} fill in the test period. Each month, order the order-up-to level minus your inventory position (on hand + on order − backorders).
            </p>
          </Card>

          <Card title="4. Part explorer">
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ position: 'relative' }}>
                Find a part
                <input value={partQuery} placeholder={data.parts[part]} onChange={(e) => setPartQuery(e.target.value)} />
                {matches.length > 0 && (
                  <div className="card" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 5, padding: 4, minWidth: 180 }}>
                    {matches.map((x) => (
                      <button key={x.i} className="btn small ghost" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => { setPartIdx(x.i); setPartQuery('') }}>
                        {x.p}
                      </button>
                    ))}
                  </div>
                )}
              </label>
              <button className="btn small" onClick={() => setPartIdx(busiest(data.demand))}>
                Busiest part
              </button>
              <button className="btn small" onClick={() => setPartIdx(Math.floor(Math.random() * data.parts.length))}>
                Random part
              </button>
              <span className="muted small">
                Part <strong>{data.parts[part]}</strong>: {classes.per[part].cls}, ADI {fmt(classes.per[part].adi, 2)}, CV² {fmt(classes.per[part].cv2, 2)}
              </span>
            </div>
            <div className="chart-box" style={{ marginTop: 10 }}>
              <ResponsiveContainer>
                <ComposedChart data={partChart} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6ebf1" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <ReferenceLine x={data.months[testStart]} stroke="#5b6b7f" strokeDasharray="4 4" label={{ value: 'test →', position: 'insideTopRight', fontSize: 11 }} />
                  <Bar dataKey="Actual" fill="#cfd8e2" isAnimationActive={false} />
                  {shown.filter((m) => forecasts![m]).map((m) => (
                    <Line key={m} type="stepAfter" dataKey={m} stroke={COLORS[m]} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th className="num">Next-month forecast</th>
                    <th className="num">Order-up-to level</th>
                    <th className="num">Test fill rate</th>
                    <th className="num">Avg stock (test)</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.filter((m) => results[m]).map((m) => {
                    const r = partRow(m)
                    return (
                      <tr key={m}>
                        <td>
                          <strong style={{ color: COLORS[m] }}>{m}</strong>
                        </td>
                        <td className="num">{fmt(r?.next, 2)}</td>
                        <td className="num">{r ? r.S : '–'}</td>
                        <td className="num">{pct(r?.fill, 0)}</td>
                        <td className="num">{fmt(r?.avg, 1)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              One part over {testMonths} months is a small sample; the portfolio results above are what to judge methods on. Each method uses its portfolio safety factor for the {pct(target, 0)} target.
            </p>
          </Card>

          <Card title="How this was tested">
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Rolling one-step-ahead forecasts: every forecast uses only months before it. The last {testMonths} months are never used to fit or tune anything.</li>
              <li>σ is the RMSE of each method's own past one-step errors (expanding window from {data.months[evalStart]}), so a less accurate method automatically carries more safety stock.</li>
              {data.lgbm && <li>LightGBM is a global model across all parts (lags, rolling means, demand-interval and Croston/TSB features), retrained every month walk-forward. Its settings were chosen on {data.months[evalStart]} to {data.months[testStart - 1]} only. Code: analysis/benchmark.py.</li>}
              <li>Stock is in units; the dataset has no prices, so the stock reduction is in units, not money. Fill rate assumes a normal approximation of lead-time demand, which is rough for very sparse parts.</li>
              <li>Results come from one {testMonths}-month test window on one dataset. Check on your own data before changing policy.</li>
            </ul>
          </Card>
        </>
      )}
    </div>
  )
}

function busiest(demand: number[][]): number {
  let bi = 0
  let bv = -1
  demand.forEach((y, i) => {
    const v = y.reduce((s, x) => s + x, 0)
    if (v > bv) {
      bv = v
      bi = i
    }
  })
  return bi
}
