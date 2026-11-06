import { forwardRef } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Capability, ChartData } from '../lib/spc'
import { normalCdf } from '../lib/stats'

// Literal colours (not CSS variables) so charts can be exported to PNG/PDF.
export const COLORS = { line: '#0b6e6e', cl: '#1e8e5a', limit: '#c0392b', bad: '#c0392b', grid: '#e6ebf0', text: '#5b6b7f' }

interface Row {
  label: string
  value: number
  cl: number
  ucl: number
  lcl: number
  rules: number[]
}

function nice(x: number): string {
  const a = Math.abs(x)
  if (a === 0) return '0'
  if (a >= 1000) return x.toFixed(0)
  if (a >= 100) return x.toFixed(1)
  if (a >= 1) return x.toFixed(3)
  return x.toPrecision(3)
}

interface DotProps {
  cx?: number
  cy?: number
  index?: number
  payload?: Row
}

export const ControlChart = forwardRef<HTMLDivElement, { chart: ChartData; percent?: boolean }>(function ControlChart(
  { chart, percent },
  ref
) {
  const ruleMap = new Map<number, number[]>()
  for (const v of chart.violations) ruleMap.set(v.index, [...(ruleMap.get(v.index) ?? []), v.rule])
  const rows: Row[] = chart.values.map((v, i) => ({
    label: chart.labels[i],
    value: v,
    cl: chart.cl,
    ucl: chart.ucl[i],
    lcl: chart.lcl[i],
    rules: ruleMap.get(i) ?? [],
  }))
  const all = [...chart.values, ...chart.ucl, ...chart.lcl]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = (hi - lo) * 0.08 || 1
  const fmtTick = (x: number) => (percent ? (x * 100).toFixed(1) + '%' : nice(x))

  const renderDot = (p: DotProps) => {
    const { cx, cy, index, payload } = p
    if (cx === undefined || cy === undefined) return <g key={`e${index}`} />
    const bad = (payload?.rules.length ?? 0) > 0
    return (
      <circle
        key={`d${index}`}
        cx={cx}
        cy={cy}
        r={bad ? 5 : 3}
        fill={bad ? COLORS.bad : COLORS.line}
        stroke={bad ? '#fff' : 'none'}
        strokeWidth={1.5}
      />
    )
  }

  return (
    <div ref={ref}>
      <div style={{ fontWeight: 600, margin: '4px 0' }}>{chart.title}</div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 56, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: COLORS.text }} interval="preserveStartEnd" minTickGap={14} />
            <YAxis
              domain={[lo - pad, hi + pad]}
              tickFormatter={fmtTick}
              tick={{ fontSize: 11, fill: COLORS.text }}
              width={62}
              allowDataOverflow
            />
            <Tooltip
              formatter={(v, name) => [percent ? (Number(v) * 100).toFixed(2) + '%' : nice(Number(v)), String(name)]}
              labelFormatter={(l) => `Point ${l}`}
            />
            <Line name="UCL" dataKey="ucl" stroke={COLORS.limit} strokeDasharray="6 4" dot={false} isAnimationActive={false} type="stepAfter" strokeWidth={1.5} />
            <Line name="LCL" dataKey="lcl" stroke={COLORS.limit} strokeDasharray="6 4" dot={false} isAnimationActive={false} type="stepAfter" strokeWidth={1.5} />
            <Line name="Centre" dataKey="cl" stroke={COLORS.cl} dot={false} isAnimationActive={false} strokeWidth={1.5} />
            <Line name="Value" dataKey="value" stroke={COLORS.line} strokeWidth={1.6} dot={renderDot as never} activeDot={{ r: 5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="legend" style={{ marginTop: 4 }}>
        <span>
          <i style={{ background: COLORS.cl }} />
          Centre {fmtTick(chart.cl)}
        </span>
        <span>
          <i style={{ background: COLORS.limit }} />
          UCL {chart.ucl.every((u) => u === chart.ucl[0]) ? fmtTick(chart.ucl[0]) : '(varies by sample size)'}
        </span>
        <span>
          <i style={{ background: COLORS.limit }} />
          LCL {chart.lcl.every((u) => u === chart.lcl[0]) ? fmtTick(chart.lcl[0]) : '(varies by sample size)'}
        </span>
        <span>
          <i style={{ background: COLORS.bad, borderRadius: 99 }} />
          Rule violation
        </span>
      </div>
    </div>
  )
})

/** Hand-drawn SVG histogram with normal curve and specification limits. */
export const Histogram = forwardRef<HTMLDivElement, { values: number[]; cap: Capability; lsl?: number; usl?: number }>(function Histogram(
  { values, cap, lsl, usl },
  ref
) {
  const W = 720
  const H = 270
  const m = { l: 44, r: 20, t: 16, b: 34 }
  const n = values.length
  const bins = Math.max(6, Math.min(24, Math.round(Math.sqrt(n))))
  const extra = [lsl, usl].filter((x): x is number => x !== undefined && Number.isFinite(x))
  let lo = Math.min(...values, ...extra)
  let hi = Math.max(...values, ...extra)
  if (hi === lo) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.05
  lo -= pad
  hi += pad
  const bw = (hi - lo) / bins
  const counts = new Array(bins).fill(0)
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / bw))]++
  const maxC = Math.max(...counts)
  const sx = (x: number) => m.l + ((x - lo) / (hi - lo)) * (W - m.l - m.r)
  const sy = (c: number) => H - m.b - (c / (maxC * 1.15)) * (H - m.t - m.b)
  // normal curve scaled to counts, using overall sigma
  const pts: string[] = []
  if (cap.sigmaOverall > 0) {
    for (let i = 0; i <= 80; i++) {
      const x = lo + ((hi - lo) * i) / 80
      const dens = normalCdf((x + bw / 2 - cap.mean) / cap.sigmaOverall) - normalCdf((x - bw / 2 - cap.mean) / cap.sigmaOverall)
      pts.push(`${sx(x).toFixed(1)},${sy(dens * n).toFixed(1)}`)
    }
  }
  const ticks = Array.from({ length: 6 }, (_, i) => lo + ((hi - lo) * i) / 5)
  return (
    <div ref={ref}>
      <div style={{ fontWeight: 600, margin: '4px 0' }}>Histogram with specification limits</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: 300 }} role="img" aria-label="Histogram of measurements">
        <rect x="0" y="0" width={W} height={H} fill="#fff" />
        <line x1={m.l} y1={H - m.b} x2={W - m.r} y2={H - m.b} stroke="#9aa7b5" />
        {counts.map((c, i) => (
          <rect key={i} x={sx(lo + i * bw) + 1} y={sy(c)} width={Math.max(1, sx(lo + (i + 1) * bw) - sx(lo + i * bw) - 2)} height={H - m.b - sy(c)} fill="#7fc4bf" />
        ))}
        {pts.length > 0 && <polyline points={pts.join(' ')} fill="none" stroke="#0d2238" strokeWidth="1.6" />}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={sx(t)} x2={sx(t)} y1={H - m.b} y2={H - m.b + 4} stroke="#9aa7b5" />
            <text x={sx(t)} y={H - m.b + 17} textAnchor="middle" fontSize="11" fill="#5b6b7f">
              {nice(t)}
            </text>
          </g>
        ))}
        {[0, Math.round(maxC / 2), maxC].map((c, i) => (
          <text key={i} x={m.l - 6} y={sy(c) + 4} textAnchor="end" fontSize="11" fill="#5b6b7f">
            {c}
          </text>
        ))}
        {lsl !== undefined && Number.isFinite(lsl) && (
          <g>
            <line x1={sx(lsl)} x2={sx(lsl)} y1={m.t} y2={H - m.b} stroke={COLORS.limit} strokeWidth="2" strokeDasharray="6 4" />
            <text x={sx(lsl) + 4} y={m.t + 10} fontSize="11" fill={COLORS.limit} fontWeight="600">
              LSL {nice(lsl)}
            </text>
          </g>
        )}
        {usl !== undefined && Number.isFinite(usl) && (
          <g>
            <line x1={sx(usl)} x2={sx(usl)} y1={m.t} y2={H - m.b} stroke={COLORS.limit} strokeWidth="2" strokeDasharray="6 4" />
            <text x={sx(usl) - 4} y={m.t + 10} textAnchor="end" fontSize="11" fill={COLORS.limit} fontWeight="600">
              USL {nice(usl)}
            </text>
          </g>
        )}
        <line x1={sx(cap.mean)} x2={sx(cap.mean)} y1={m.t + 14} y2={H - m.b} stroke={COLORS.cl} strokeWidth="1.5" />
        <text x={sx(cap.mean) + 4} y={m.t + 24} fontSize="11" fill={COLORS.cl} fontWeight="600">
          mean {nice(cap.mean)}
        </text>
      </svg>
    </div>
  )
})
