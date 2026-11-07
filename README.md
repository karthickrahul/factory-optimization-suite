# Factory Optimization Suite

Free, browser-based industrial engineering tools. Open the page, click a sample dataset or load your own CSV, and get results immediately. All calculations run locally in the browser; no data is uploaded anywhere.

**Live app:** https://karthickrahul.github.io/factory-optimization-suite/

## Modules

| Module | What it does |
| --- | --- |
| **SPC & Process Capability** | I-MR, X̄-R and p control charts, Western Electric rules, Cp / Cpk / Pp / Ppk, Anderson-Darling normality test, ppm estimates, PDF quality report |
| **Assembly Line Balancing** | Tasks + precedence → stations for a given takt or cycle time. Compares four heuristics (RPW, LCR, MFT, SPT), reports efficiency, balance delay, smoothness index, bottleneck. Excel / CSV export |
| **Factory Flow Simulator** | Discrete-event simulation of a serial line: parallel machines, finite buffers with blocking, random processing times, breakdowns. Seeded replications with 95% confidence intervals, bottleneck detection, what-if scenarios |
| **Spare-Parts Demand & Inventory** | Intermittent-demand forecasting (Croston, SBA, TSB, SES and baselines) vs a LightGBM machine-learning model on **real data for 2,509 car parts**. Each forecast drives an order-up-to policy; methods are compared on the stock needed to reach a target fill rate. Reorder-plan CSV export, upload your own data |

## Demand & Inventory: result on real data

Data: monthly sales of 2,509 car parts, Jan 1998 to Mar 2002, from a US car company (Hyndman et al., 2008, R package `expsmooth`, dataset `carparts`; 165 parts with missing months dropped). 99% of parts are intermittent or lumpy. Test period: the last 12 months, never used for fitting or tuning.

Stock needed for a **90% fill rate**, lead time 1 month (average units on hand, all parts):

| Method | MAE | Stock for 90% fill | vs SBA |
| --- | --- | --- | --- |
| LightGBM (global model, walk-forward) | 0.577 | 7,823 | **−13.7%** |
| SES | 0.583 | 8,196 | −9.6% |
| TSB | 0.602 | 8,309 | −8.3% |
| SBA (industry default) | 0.638 | 9,066 | baseline |
| Zero forecast | **0.417** | 8,856 | −2.3% |

- LightGBM needed the least stock at every fill target tested (85%, 90%, 95%) and lead times of 0, 1 and 2 months. At 95% fill and lead time 1 it needed 11,495 units vs 13,289 for SBA (−13.5%) and 12,545 for SES (−8.4%).
- Re-running LightGBM with random seeds 1–3 changed the 90%-fill stock by less than 0.5%.
- The zero forecast has the lowest MAE but is not the best plan: on sparse demand, error metrics alone pick the wrong method.
- Limits: one 12-month test window on one dataset; stock is in units (no prices in the data); safety stock uses a normal approximation, which is rough for very sparse parts.

Reproduce: `pip install numpy pandas lightgbm pyreadr && python analysis/benchmark.py --seeds` (about 5 minutes). It rewrites `public/data/*.json`, `analysis/results.json` and the test fixture. The browser engine is tested against these outputs.

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
- Demand & inventory: Croston/SBA/TSB/SES forecasts, σ and the inventory simulation match the Python benchmark to 8 decimals on real series; the browser reproduces the Python portfolio results within 1%; hand-calculated cases for each method

GitHub Actions runs the tests and deploys to GitHub Pages on every push to `main`.

## Limitations

- Simulation models serial lines only (no routing, rework loops or assembly merges).
- Line balancing covers simple (single-model, deterministic-time) assembly lines.
- Capability figures assume a stable process and a measurement system that has been validated.
- Sample data is synthetic, except the car-parts demand data (real, public).
- Demand & inventory: monthly review only; LightGBM forecasts are precomputed in Python and available for the car-parts data only.

## Stack

React, TypeScript, Vite, Recharts, PapaParse, jsPDF, SheetJS, Vitest. Analysis: Python, NumPy, LightGBM.

## Author

Karthickk Rahul Srinivasan, M.Sc. Industrial Engineering, VŠB – Technical University of Ostrava.
[LinkedIn](https://linkedin.com/in/karthickk-srinivasan)
