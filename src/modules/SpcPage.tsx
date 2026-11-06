import { useMemo, useRef, useState } from 'react'
import { Callout, Card, FileDrop, Kpi, NumberField } from '../components/ui'
import { downloadText, fmt, isNumericHeader, numericColumn, parseCsv, svgToPng, toNumber, type ParsedCsv } from '../lib/io'
import { SAMPLE_SPC_SPEC, samplePCsv, sampleSpcCsv } from '../lib/samples'
import {
  analyzeIndividuals,
  analyzePChart,
  analyzeXbarR,
  MAX_SUBGROUP,
  RULE_TEXT,
  type Capability,
  type PChartResult,
  type SpcAnalysis,
} from '../lib/spc'
import { ControlChart, Histogram } from './SpcCharts'

type Mode = 'individuals' | 'xbar' | 'xbar-rows' | 'p'
type Rules = Record<1 | 2 | 3 | 4, boolean>

const MODE_LABEL: Record<Mode, string> = {
  individuals: 'Individual measurements (I-MR)',
  xbar: 'Subgroups in one column (X̄-R)',
  'xbar-rows': 'One subgroup per row (X̄-R)',
  p: 'Proportion defective (p chart)',
}

function parse(text: string): { data: ParsedCsv | null; error: string | null } {
  if (!text.trim()) return { data: null, error: null }
  try {
    const data = parseCsv(text)
    if (data.rows.length < 3) return { data: null, error: 'Need at least 3 data rows.' }
    return { data, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

function insights(cap: Capability, a: SpcAnalysis, lsl?: number, usl?: number): { tone: 'good' | 'warn' | 'bad' | undefined; text: string }[] {
  const out: { tone: 'good' | 'warn' | 'bad' | undefined; text: string }[] = []
  const nViol = a.primary.violations.length + a.secondary.violations.length
  if (nViol === 0) out.push({ tone: 'good', text: 'No control-chart signals: the process looks statistically stable, so the capability figures are meaningful.' })
  else {
    const first = [...a.primary.violations, ...a.secondary.violations].sort((x, y) => x.index - y.index)[0]
    out.push({
      tone: 'bad',
      text: `${nViol} control-chart signal${nViol > 1 ? 's' : ''} found (first at point ${first.index + 1}). The process is not stable, so look for special causes (tool wear, material change, set-up, operator) before trusting Cpk.`,
    })
  }
  if (cap.cp !== undefined && cap.cpk !== undefined && cap.cp - cap.cpk > 0.25 && lsl !== undefined && usl !== undefined) {
    const mid = (lsl + usl) / 2
    out.push({
      tone: 'warn',
      text: `The process is off-centre: the mean is ${fmt(Math.abs(cap.mean - mid), 4)} ${cap.mean > mid ? 'above' : 'below'} the middle of the tolerance. Re-centring could lift Cpk from ${fmt(cap.cpk)} towards Cp = ${fmt(cap.cp)} without reducing variation.`,
    })
  }
  if (cap.cp !== undefined && cap.pp !== undefined && cap.cp / cap.pp > 1.2) {
    out.push({
      tone: 'warn',
      text: `Overall variation (Pp = ${fmt(cap.pp)}) is much worse than short-term variation (Cp = ${fmt(cap.cp)}), which points to shifts or drift between subgroups rather than random noise.`,
    })
  }
  if (Number.isFinite(cap.normalityP) && cap.normalityP < 0.05)
    out.push({
      tone: 'warn',
      text: `The data fail the Anderson-Darling normality test (p = ${cap.normalityP < 0.001 ? '<0.001' : fmt(cap.normalityP, 3)}). The ppm estimates assume a normal distribution and may be unreliable; consider a transformation or a non-normal capability method.`,
    })
  if (cap.expectedOverallPpm !== undefined && cap.observedPpm !== undefined && cap.observedPpm > 0)
    out.push({
      tone: 'bad',
      text: `${fmt(cap.observedPpm, 0)} ppm of the measured parts are already outside the specification.`,
    })
  return out
}

export default function SpcPage() {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<Mode>('individuals')
  const [valueCol, setValueCol] = useState('')
  const [rowCols, setRowCols] = useState<string[]>([])
  const [defCol, setDefCol] = useState('')
  const [sizeCol, setSizeCol] = useState('')
  const [n, setN] = useState<number | undefined>(5)
  const [lsl, setLsl] = useState<number | undefined>(undefined)
  const [usl, setUsl] = useState<number | undefined>(undefined)
  const [rules, setRules] = useState<Rules>({ 1: true, 2: true, 3: true, 4: true })
  const [busy, setBusy] = useState(false)
  const chart1 = useRef<HTMLDivElement>(null)
  const chart2 = useRef<HTMLDivElement>(null)
  const histRef = useRef<HTMLDivElement>(null)

  const { data, error: parseError } = useMemo(() => parse(csv), [csv])
  const numericCols = useMemo(() => (data ? data.headers.filter((h) => isNumericHeader(data.rows, h)) : []), [data])

  function load(text: string, name: string, preset?: Partial<{ mode: Mode; lsl: number; usl: number; n: number }>) {
    setCsv(text)
    setFileName(name)
    const p = parse(text)
    if (p.data) {
      const nums = p.data.headers.filter((h) => isNumericHeader(p.data!.rows, h))
      const defaultCol = nums[nums.length - 1] ?? ''
      setValueCol(defaultCol)
      setRowCols(nums.length >= 2 ? nums.slice(-Math.min(5, nums.length)) : nums)
      const dc = nums.find((h) => /defect|nonconform|reject|scrap|fail/i.test(h))
      const sc = nums.find((h) => /inspect|sample.?size|^n$|lot|checked|total/i.test(h))
      setDefCol(dc ?? nums[nums.length - 1] ?? '')
      setSizeCol(sc ?? nums[0] ?? '')
      if (!preset?.mode) setMode(dc && sc ? 'p' : 'individuals')
    }
    if (preset?.mode) setMode(preset.mode)
    setLsl(preset?.lsl)
    setUsl(preset?.usl)
    if (preset?.n) setN(preset.n)
  }

  const result = useMemo<{ spc?: SpcAnalysis; p?: PChartResult; error?: string; notes: string[] }>(() => {
    if (!data) return { notes: [] }
    const notes: string[] = []
    try {
      const spec = { lsl, usl }
      if (lsl !== undefined && usl !== undefined && lsl >= usl) throw new Error('LSL must be smaller than USL.')
      if (mode === 'p') {
        if (!defCol || !sizeCol) throw new Error('Select the defective-count and sample-size columns.')
        if (defCol === sizeCol) throw new Error('Defective count and sample size must be different columns.')
        const d: number[] = []
        const s: number[] = []
        let skipped = 0
        for (const r of data.rows) {
          const a = toNumber(r[defCol])
          const b = toNumber(r[sizeCol])
          if (Number.isNaN(a) || Number.isNaN(b)) skipped++
          else {
            d.push(a)
            s.push(b)
          }
        }
        if (skipped) notes.push(`${skipped} row(s) skipped because they were not numeric.`)
        return { p: analyzePChart(d, s, rules), notes }
      }
      if (mode === 'individuals' || mode === 'xbar') {
        if (!valueCol) throw new Error('Select the measurement column.')
        const { values, skipped } = numericColumn(data.rows, valueCol)
        if (skipped) notes.push(`${skipped} non-numeric cell(s) in "${valueCol}" were ignored.`)
        if (mode === 'individuals') return { spc: analyzeIndividuals(values, spec, rules), notes }
        const a = analyzeXbarR(values, n ?? 0, spec, rules)
        if (a.droppedValues) notes.push(`${a.droppedValues} trailing value(s) dropped (incomplete subgroup).`)
        return { spc: a, notes }
      }
      // one subgroup per row
      if (rowCols.length < 2) throw new Error('Select at least 2 measurement columns (one per reading in the subgroup).')
      if (rowCols.length > MAX_SUBGROUP) throw new Error(`Select at most ${MAX_SUBGROUP} columns.`)
      const flat: number[] = []
      let skipped = 0
      for (const r of data.rows) {
        const vals = rowCols.map((c) => toNumber(r[c]))
        if (vals.some(Number.isNaN)) skipped++
        else flat.push(...vals)
      }
      if (skipped) notes.push(`${skipped} incomplete row(s) skipped.`)
      return { spc: analyzeXbarR(flat, rowCols.length, spec, rules), notes }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), notes }
    }
  }, [data, mode, valueCol, rowCols, defCol, sizeCol, n, lsl, usl, rules])

  const spc = result.spc
  const cap = spc?.capability
  const msgs = spc && cap ? insights(cap, spc, lsl, usl) : []
  const hasSpec = lsl !== undefined || usl !== undefined

  async function exportPdf() {
    if (!result.spc && !result.p) return
    setBusy(true)
    try {
      const { jsPDF } = await import('jspdf')
      const doc = new jsPDF({ unit: 'mm', format: 'a4' })
      const W = 210
      let y = 16
      doc.setFontSize(18)
      doc.text('SPC & Process Capability Report', 14, y)
      y += 7
      doc.setFontSize(10)
      doc.setTextColor(90)
      doc.text(`Generated ${new Date().toLocaleString('en-GB')}  |  Source: ${fileName || 'pasted data'}  |  ${MODE_LABEL[mode]}`, 14, y)
      doc.setTextColor(0)
      y += 8
      const addImg = async (el: HTMLElement | null, maxH: number) => {
        const svg = el?.querySelector('svg')
        if (!svg) return
        const img = await svgToPng(svg as unknown as SVGSVGElement)
        const w = W - 28
        const h = Math.min(maxH, (img.height / img.width) * w)
        if (y + h > 285) {
          doc.addPage()
          y = 16
        }
        doc.addImage(img.dataUrl, 'PNG', 14, y, w, h)
        y += h + 4
      }
      const line = (text: string, size = 10, bold = false) => {
        doc.setFontSize(size)
        doc.setFont('helvetica', bold ? 'bold' : 'normal')
        for (const l of doc.splitTextToSize(text, W - 28) as string[]) {
          if (y > 285) {
            doc.addPage()
            y = 16
          }
          doc.text(l, 14, y)
          y += size * 0.5
        }
        y += 1.5
      }
      if (result.spc && cap) {
        line('Process capability', 12, true)
        const rows: [string, string][] = [
          ['Observations', String(cap.n)],
          ['Mean', fmt(cap.mean, 4)],
          ['Sigma within / overall', `${fmt(cap.sigmaWithin, 5)} / ${fmt(cap.sigmaOverall, 5)}`],
          ['LSL / USL', `${lsl ?? '-'} / ${usl ?? '-'}`],
          ['Cp / Cpk', `${fmt(cap.cp)} / ${fmt(cap.cpk)}`],
          ['Pp / Ppk', `${fmt(cap.pp)} / ${fmt(cap.ppk)}`],
          ['Observed ppm', fmt(cap.observedPpm, 0)],
          ['Expected ppm (overall)', fmt(cap.expectedOverallPpm, 0)],
          ['Normality (A-D p)', Number.isFinite(cap.normalityP) ? fmt(cap.normalityP, 3) : '-'],
        ]
        for (const [k, v] of rows) line(`${k}: ${v}`, 10)
        line(cap.verdict, 10, true)
        y += 2
        for (const m of msgs) line(`- ${m.text}`, 9)
        y += 2
        await addImg(chart1.current, 70)
        await addImg(chart2.current, 70)
        await addImg(histRef.current, 70)
      } else if (result.p) {
        line('p chart', 12, true)
        line(`Average proportion defective: ${(result.p.pBar * 100).toFixed(3)}%  (${result.p.totalDefective} defective of ${result.p.totalInspected} inspected)`)
        line(`Control-chart signals: ${result.p.chart.violations.length}`)
        await addImg(chart1.current, 90)
      }
      line('Rules applied: ' + ([1, 2, 3, 4] as const).filter((r) => rules[r]).map((r) => `${r}) ${RULE_TEXT[r]}`).join('; '), 8)
      line('Capability indices assume a stable, approximately normal process. Generated by the Factory Optimization Suite (calculations run in the browser).', 8)
      doc.save('spc-report.pdf')
    } finally {
      setBusy(false)
    }
  }

  function exportSignals() {
    const a = result.spc?.primary ?? result.p?.chart
    if (!a) return
    const lines = ['point,value,rule,description']
    for (const v of a.violations) lines.push(`${v.index + 1},${a.values[v.index]},${v.rule},"${RULE_TEXT[v.rule]}"`)
    downloadText(lines.join('\n'), 'spc-signals.csv')
  }

  const allViolations = result.spc
    ? [...result.spc.primary.violations.map((v) => ({ ...v, chart: 'Primary' })), ...result.spc.secondary.violations.map((v) => ({ ...v, chart: 'Range' }))]
    : (result.p?.chart.violations ?? []).map((v) => ({ ...v, chart: 'p' }))

  return (
    <div className="stack">
      <div>
        <h2>SPC &amp; Process Capability Analyzer</h2>
        <p className="muted">
          Upload measurement data, get control charts, Western Electric rule checks, Cp/Cpk/Pp/Ppk, ppm estimates and a downloadable PDF report. Everything runs in your browser; your data never leaves it.
        </p>
      </div>

      <div className="two-col">
        <div className="stack">
          <Card title="1. Data">
            <div className="stack">
              <FileDrop onText={(t, name) => load(t, name)} />
              <div className="row">
                <button className="btn small" onClick={() => load(sampleSpcCsv(), 'sample-shaft-diameter.csv', { mode: 'individuals', ...SAMPLE_SPC_SPEC })}>
                  Load sample: shaft diameter
                </button>
                <button className="btn small" onClick={() => load(samplePCsv(), 'sample-defects.csv', { mode: 'p' })}>
                  Load sample: defects
                </button>
              </div>
              <label className="field">
                …or paste CSV (header row required)
                <textarea rows={5} value={csv} onChange={(e) => load(e.target.value, 'pasted data')} placeholder={'Sample,Diameter\n1,25.012\n2,24.998'} />
              </label>
              {parseError && <Callout tone="bad">{parseError}</Callout>}
              {data && (
                <p className="small muted" style={{ margin: 0 }}>
                  {data.rows.length} rows, {data.headers.length} columns{fileName ? ` from ${fileName}` : ''}. Decimal commas are accepted.
                </p>
              )}
            </div>
          </Card>

          {data && (
            <Card title="2. Chart setup">
              <div className="stack">
                <label className="field">
                  Data layout
                  <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                    {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
                {(mode === 'individuals' || mode === 'xbar') && (
                  <label className="field">
                    Measurement column
                    <select value={valueCol} onChange={(e) => setValueCol(e.target.value)}>
                      {numericCols.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </label>
                )}
                {mode === 'xbar' && <NumberField label="Subgroup size" value={n} onChange={setN} hint={`2 to ${MAX_SUBGROUP}; consecutive values form a subgroup`} />}
                {mode === 'xbar-rows' && (
                  <div className="field">
                    Reading columns (subgroup size = {rowCols.length})
                    {numericCols.map((h) => (
                      <label key={h} className="check">
                        <input
                          type="checkbox"
                          checked={rowCols.includes(h)}
                          onChange={(e) => setRowCols(e.target.checked ? [...rowCols, h] : rowCols.filter((c) => c !== h))}
                        />
                        {h}
                      </label>
                    ))}
                  </div>
                )}
                {mode === 'p' && (
                  <>
                    <label className="field">
                      Defective count column
                      <select value={defCol} onChange={(e) => setDefCol(e.target.value)}>
                        {numericCols.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      Sample size column
                      <select value={sizeCol} onChange={(e) => setSizeCol(e.target.value)}>
                        {numericCols.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {mode !== 'p' && (
                  <div className="row">
                    <div style={{ flex: 1, minWidth: 110 }}>
                      <NumberField label="LSL" value={lsl} onChange={setLsl} placeholder="optional" />
                    </div>
                    <div style={{ flex: 1, minWidth: 110 }}>
                      <NumberField label="USL" value={usl} onChange={setUsl} placeholder="optional" />
                    </div>
                  </div>
                )}
                <div className="field">
                  Run rules
                  {([1, 2, 3, 4] as const).map((r) => (
                    <label key={r} className="check">
                      <input type="checkbox" checked={rules[r]} onChange={(e) => setRules({ ...rules, [r]: e.target.checked })} />
                      <span>{RULE_TEXT[r]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </Card>
          )}
        </div>

        <div className="stack">
          {!data && (
            <Callout title="Start here">
              Load one of the sample data sets on the left (one click), upload your own CSV, or paste data. The tool picks sensible defaults and you can change the chart type, subgroup size and specification limits afterwards.
            </Callout>
          )}
          {result.error && <Callout tone="bad" title="Cannot analyse this selection">{result.error}</Callout>}
          {result.notes.map((t) => (
            <Callout key={t} tone="warn">
              {t}
            </Callout>
          ))}

          {spc && cap && (
            <>
              <div className="grid-kpi">
                <Kpi label="Cpk (within)" value={fmt(cap.cpk)} tone={cap.cpk === undefined ? undefined : cap.cpk >= 1.33 ? 'good' : cap.cpk >= 1 ? 'warn' : 'bad'} sub={hasSpec ? 'short-term capability' : 'add spec limits'} />
                <Kpi label="Ppk (overall)" value={fmt(cap.ppk)} tone={cap.ppk === undefined ? undefined : cap.ppk >= 1.33 ? 'good' : cap.ppk >= 1 ? 'warn' : 'bad'} sub="long-term performance" />
                <Kpi label="Cp / Pp" value={`${fmt(cap.cp)} / ${fmt(cap.pp)}`} sub="potential, if centred" />
                <Kpi label="Expected ppm" value={cap.expectedOverallPpm === undefined ? '–' : fmt(cap.expectedOverallPpm, 0)} sub={cap.observedPpm === undefined ? 'overall, normal model' : `observed ${fmt(cap.observedPpm, 0)}`} />
                <Kpi label="Signals" value={allViolations.length} tone={allViolations.length ? 'bad' : 'good'} sub={allViolations.length ? 'process unstable' : 'process stable'} />
              </div>

              <Callout tone={cap.cpk === undefined ? undefined : cap.cpk >= 1.33 ? 'good' : cap.cpk >= 1 ? 'warn' : 'bad'} title="Verdict">
                {cap.verdict}
              </Callout>

              <Card
                title={`Control charts: ${spc.kind}`}
                actions={
                  <>
                    <button className="btn small" onClick={exportSignals} disabled={!allViolations.length}>
                      Signals CSV
                    </button>
                    <button className="btn small primary" onClick={exportPdf} disabled={busy}>
                      {busy ? <span className="spinner" /> : null}Download PDF report
                    </button>
                  </>
                }
              >
                <ControlChart ref={chart1} chart={spc.primary} />
                <ControlChart ref={chart2} chart={spc.secondary} />
              </Card>

              <Card title="Capability analysis">
                <div className="grid-3">
                  <div>
                    <Histogram ref={histRef} values={spc.values} cap={cap} lsl={lsl} usl={usl} />
                  </div>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        <tr><th>Observations</th><td className="num">{cap.n}</td></tr>
                        <tr><th>Mean</th><td className="num">{fmt(cap.mean, 4)}</td></tr>
                        <tr><th>σ within</th><td className="num">{fmt(cap.sigmaWithin, 5)}</td></tr>
                        <tr><th>σ overall</th><td className="num">{fmt(cap.sigmaOverall, 5)}</td></tr>
                        <tr><th>Cp</th><td className="num">{fmt(cap.cp)}</td></tr>
                        <tr><th>Cpu / Cpl</th><td className="num">{fmt(cap.cpu)} / {fmt(cap.cpl)}</td></tr>
                        <tr><th>Cpk</th><td className="num">{fmt(cap.cpk)}</td></tr>
                        <tr><th>Pp / Ppk</th><td className="num">{fmt(cap.pp)} / {fmt(cap.ppk)}</td></tr>
                        <tr><th>Expected ppm (within)</th><td className="num">{cap.expectedWithinPpm === undefined ? '–' : fmt(cap.expectedWithinPpm, 0)}</td></tr>
                        <tr><th>Normality (A-D p)</th><td className="num">{Number.isFinite(cap.normalityP) ? (cap.normalityP < 0.001 ? '<0.001' : fmt(cap.normalityP, 3)) : '–'}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </Card>

              <Card title="Automatic findings">
                <div className="stack">
                  {msgs.map((m, i) => (
                    <Callout key={i} tone={m.tone}>
                      {m.text}
                    </Callout>
                  ))}
                </div>
              </Card>
            </>
          )}

          {result.p && (
            <>
              <div className="grid-kpi">
                <Kpi label="Average defective" value={(result.p.pBar * 100).toFixed(2) + '%'} sub={`${result.p.totalDefective} of ${result.p.totalInspected}`} />
                <Kpi label="Signals" value={result.p.chart.violations.length} tone={result.p.chart.violations.length ? 'bad' : 'good'} sub={result.p.chart.violations.length ? 'investigate these samples' : 'stable'} />
              </div>
              <Card
                title="p chart"
                actions={
                  <>
                    <button className="btn small" onClick={exportSignals} disabled={!allViolations.length}>
                      Signals CSV
                    </button>
                    <button className="btn small primary" onClick={exportPdf} disabled={busy}>
                      {busy ? <span className="spinner" /> : null}Download PDF report
                    </button>
                  </>
                }
              >
                <ControlChart ref={chart1} chart={result.p.chart} percent />
              </Card>
            </>
          )}

          {allViolations.length > 0 && (
            <Card title="Signal log">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Chart</th>
                      <th className="num">Point</th>
                      <th>Rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allViolations.slice(0, 60).map((v, i) => (
                      <tr key={i}>
                        <td>{v.chart}</td>
                        <td className="num">{v.index + 1}</td>
                        <td>
                          <span className="badge bad">Rule {v.rule}</span> {RULE_TEXT[v.rule]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {allViolations.length > 60 && <p className="small muted">Showing the first 60 of {allViolations.length} signals; download the CSV for all.</p>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
