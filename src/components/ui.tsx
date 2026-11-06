import { useRef, useState, type ReactNode } from 'react'

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="row" style={{ alignItems: 'center' }}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

export function Callout({ tone, title, children }: { tone?: 'warn' | 'bad' | 'good'; title?: string; children: ReactNode }) {
  return (
    <div className={`callout ${tone ?? ''}`} role={tone === 'bad' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  )
}

/** Numeric input that keeps the raw text while typing and reports a number (or undefined if empty/invalid). */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  step,
  min,
  placeholder,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  hint?: string
  step?: number | string
  min?: number
  placeholder?: string
}) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? (value === undefined || !Number.isFinite(value) ? '' : String(value))
  return (
    <label className="field">
      {label}
      <input
        inputMode="decimal"
        type="text"
        value={shown}
        placeholder={placeholder}
        step={step}
        min={min}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          const s = raw.trim().replace(',', '.')
          if (s === '') return onChange(undefined)
          const n = Number(s)
          onChange(Number.isFinite(n) ? n : undefined)
        }}
        onBlur={() => setText(null)}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

/** Compact numeric input for table cells. */
export function CellNumber({
  value,
  onChange,
  placeholder,
  width,
}: {
  value: number
  onChange: (v: number) => void
  placeholder?: string
  width?: number
}) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? (Number.isFinite(value) ? String(value) : '')
  return (
    <input
      className="cell-input"
      style={{ width }}
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value.trim().replace(',', '.'))
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setText(null)}
    />
  )
}

export function FileDrop({ onText, label = 'Drop a CSV file here or click to browse' }: { onText: (text: string, name: string) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const read = (f: File | undefined) => {
    if (!f) return
    const r = new FileReader()
    r.onload = () => onText(String(r.result ?? ''), f.name)
    r.readAsText(f)
  }
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        read(e.dataTransfer.files[0])
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && ref.current?.click()}
    >
      {label}
      <input ref={ref} type="file" accept=".csv,.txt,.tsv,text/csv" hidden onChange={(e) => read(e.target.files?.[0])} />
    </div>
  )
}
