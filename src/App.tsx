import { lazy, Suspense, useEffect, useState } from 'react'
import { Card } from './components/ui'
import SpcPage from './modules/SpcPage'
import BalancingPage from './modules/BalancingPage'

const SimulationPage = lazy(() => import('./modules/SimulationPage'))

type Tab = 'home' | 'spc' | 'balancing' | 'simulation'

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'spc', label: 'SPC & Capability' },
  { id: 'balancing', label: 'Line Balancing' },
  { id: 'simulation', label: 'Flow Simulator' },
]

const fromHash = (): Tab => {
  const h = window.location.hash.replace('#', '') as Tab
  return TABS.some((t) => t.id === h) ? h : 'home'
}

const MODULES: { id: Tab; icon: string; title: string; text: string; points: string[] }[] = [
  {
    id: 'spc',
    icon: '📈',
    title: 'SPC & Process Capability',
    text: 'Upload measurements and get control charts, rule violations and capability indices in seconds.',
    points: ['I-MR, X̄-R and p charts', 'Western Electric rules', 'Cp, Cpk, Pp, Ppk, normality test', 'PDF quality report'],
  },
  {
    id: 'balancing',
    icon: '⚖️',
    title: 'Assembly Line Balancing',
    text: 'Turn tasks and precedence into balanced stations for your takt time.',
    points: ['Four heuristics compared side by side', 'Efficiency, balance delay, smoothness', 'Takt time from demand', 'Excel and CSV export'],
  },
  {
    id: 'simulation',
    icon: '🏭',
    title: 'Factory Flow Simulator',
    text: 'Simulate a line with buffers, breakdowns and variability, then test changes before buying anything.',
    points: ['Discrete-event engine, seeded and repeatable', '95% confidence intervals', 'Bottleneck detection', 'What-if scenarios'],
  },
]

export default function App() {
  const [tab, setTab] = useState<Tab>(fromHash)

  useEffect(() => {
    const on = () => setTab(fromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const go = (t: Tab) => {
    window.location.hash = t === 'home' ? '' : t
    setTab(t)
    window.scrollTo({ top: 0 })
  }

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <button className="brand" onClick={() => go('home')} aria-label="Factory Optimization Suite home">
            <span className="brand-mark">⚙</span>
            Factory Optimization Suite
          </button>
          <nav className="nav" aria-label="Modules">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main>
        {tab === 'home' && (
          <div className="stack">
            <div className="hero">
              <h1>Industrial engineering tools you can use right now</h1>
              <p>
                Three working tools for quality, assembly and production flow. Every module opens with sample data, so you can try it in one click, or load your own CSV. Everything runs in your browser: your data never leaves your computer.
              </p>
              <button className="btn primary" onClick={() => go('spc')}>
                Try the SPC analyzer
              </button>
              <button className="btn" onClick={() => go('simulation')}>
                Open the simulator
              </button>
            </div>
            <div className="grid-3">
              {MODULES.map((m) => (
                <Card key={m.id}>
                  <div className="module-card">
                    <div className="icon" aria-hidden="true">{m.icon}</div>
                    <h3 style={{ margin: 0 }}>{m.title}</h3>
                    <p className="muted" style={{ margin: 0 }}>{m.text}</p>
                    <ul>
                      {m.points.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                    <div>
                      <button className="btn primary" onClick={() => go(m.id)}>
                        Open
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            <Card title="How the numbers are checked">
              <p className="muted" style={{ margin: 0 }}>
                SPC constants (A2, D3, D4, d2), capability formulas and Western Electric rules follow standard references. The line-balancing and simulation engines are covered by automated tests against hand-calculated and analytically known results (for example, two exponential stations with no buffer must give two thirds of the service rate). Results are decision support: confirm with your own measurement system analysis before acting on a capability figure.
              </p>
            </Card>
          </div>
        )}
        {tab === 'spc' && <SpcPage />}
        {tab === 'balancing' && <BalancingPage />}
        {tab === 'simulation' && (
          <Suspense fallback={<p className="muted">Loading simulator…</p>}>
            <SimulationPage />
          </Suspense>
        )}
      </main>
      <footer className="footer">
        Built by Karthickk Rahul Srinivasan, M.Sc. Industrial Engineering, VŠB – Technical University of Ostrava. All calculations run locally in your browser. Sample data is synthetic.
      </footer>
    </>
  )
}
