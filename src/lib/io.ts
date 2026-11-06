import Papa from 'papaparse'

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

/** Parse CSV text (comma, semicolon or tab separated; header row required). */
export function parseCsv(text: string): ParsedCsv {
  const res = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })
  const headers = (res.meta.fields ?? []).filter((h) => h !== '')
  if (headers.length === 0) throw new Error('Could not find a header row in the data.')
  return { headers, rows: res.data }
}

/** Parse "12.5" or EU-style "12,5"; returns NaN if not numeric. */
export function toNumber(raw: string | undefined): number {
  if (raw === undefined) return NaN
  let s = String(raw).trim().replace(/\s/g, '')
  if (s === '') return NaN
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

/** Extract a numeric column; reports how many non-numeric cells were skipped. */
export function numericColumn(rows: Record<string, string>[], col: string): { values: number[]; skipped: number } {
  const values: number[] = []
  let skipped = 0
  for (const r of rows) {
    const raw = r[col]
    if (raw === undefined || String(raw).trim() === '') continue
    const n = toNumber(raw)
    if (Number.isNaN(n)) skipped++
    else values.push(n)
  }
  return { values, skipped }
}

export function isNumericHeader(rows: Record<string, string>[], col: string): boolean {
  const sample = rows.slice(0, 20).map((r) => r[col]).filter((v) => v !== undefined && String(v).trim() !== '')
  return sample.length > 0 && sample.filter((v) => !Number.isNaN(toNumber(v))).length / sample.length >= 0.8
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(text: string, filename: string, mime = 'text/csv;charset=utf-8') {
  downloadBlob(new Blob(['﻿' + text], { type: mime }), filename)
}

/** Rasterise an SVG element (e.g. a Recharts chart) to a PNG data URL on a white background. */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<{ dataUrl: string; width: number; height: number }> {
  const rect = svg.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  const xml = new XMLSerializer().serializeToString(clone)
  const img = new Image()
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not render chart image'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { dataUrl: canvas.toDataURL('image/png'), width, height }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function fmt(x: number | undefined, digits = 2): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return '–'
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function pct(x: number | undefined, digits = 1): string {
  if (x === undefined || !Number.isFinite(x)) return '–'
  return (x * 100).toFixed(digits) + '%'
}
