# Factory Optimization Suite

Free, browser-based industrial engineering tools. Open the page, click a sample dataset or load your own CSV, and get results immediately. All calculations run locally in the browser; no data is uploaded anywhere.

**Live app:** https://karthickrahul.github.io/factory-optimization-suite/

## Modules

| Module | What it does |
| --- | --- |
| **SPC & Process Capability** | I-MR, X̄-R and p control charts, Western Electric rules, Cp / Cpk / Pp / Ppk, Anderson-Darling normality test, ppm estimates, PDF quality report |
| **Assembly Line Balancing** | Tasks + precedence → stations for a given takt or cycle time. Compares four heuristics (RPW, LCR, MFT, SPT), reports efficiency, balance delay, smoothness index, bottleneck. Excel / CSV export |
| **Factory Flow Simulator** | Discrete-event simulation of a serial line: parallel machines, finite buffers with blocking, random processing times, breakdowns. Seeded replications with 95% confidence intervals, bottleneck detection, what-if scenarios |

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for the calculation engines
npm run build      # static site in dist/
```

## How it is verified

The engines in `src/lib` are plain TypeScript with no UI dependencies and are covered by automated tests:

- SPC: published control-chart constants (A2, D4 for n = 5), capability indices against hand-calculated values, each Western Electric rule, one-sided specs
- Line balancing: precedence feasibility, cycle-time limits, theoretical minimum stations
- Simulation: deterministic seeding, and an analytic check (two exponential stations with no buffer give two thirds of the service rate)

GitHub Actions runs the tests and deploys to GitHub Pages on every push to `main`.

## Limitations

- Simulation models serial lines only (no routing, rework loops or assembly merges).
- Line balancing covers simple (single-model, deterministic-time) assembly lines.
- Capability figures assume a stable process and a measurement system that has been validated.
- Sample data is synthetic.

## Stack

React, TypeScript, Vite, Recharts, PapaParse, jsPDF, SheetJS, Vitest.

## Author

Karthickk Rahul Srinivasan, M.Sc. Industrial Engineering, VŠB – Technical University of Ostrava.
[LinkedIn](https://linkedin.com/in/karthickk-srinivasan)
