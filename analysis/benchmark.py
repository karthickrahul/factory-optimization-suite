"""
Spare-parts demand forecasting benchmark: classical intermittent-demand methods vs a
LightGBM global model, judged on forecast accuracy AND on the inventory each method needs.

Data: monthly sales of 2,674 car parts, Jan 1998 - Mar 2002 (51 months), from a US car
company. Published by Hyndman et al. (2008) in the R package `expsmooth` (dataset `carparts`).
Series with missing months are dropped (2,509 remain).

Protocol (no information from the future is used anywhere):
  * months 0..38  (Jan 1998 - Mar 2001): history / tuning
  * months 39..50 (Apr 2001 - Mar 2002): 12-month test period
  * every method makes one-step-ahead forecasts on a rolling origin
  * LightGBM is retrained every month on data available at that origin (walk-forward)
  * hyper-parameters are chosen on months 24..38 only, never on the test period

Outputs (consumed by the web app):
  public/data/carparts.json     demand matrix
  public/data/lgbm.json         LightGBM one-step forecasts for months 24..50
  analysis/results.json         headline numbers quoted in the README
  src/lib/__fixtures__/parity.json  reference values for the TypeScript parity test

Run:  python analysis/benchmark.py   (needs: numpy, pandas, lightgbm, pyreadr)
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA_URL = "https://raw.githubusercontent.com/cran/expsmooth/master/data/carparts.rda"
BURN = 12          # months used to initialise smoothing methods
EVAL_START = 24    # first month with an error recorded (for sigma and validation)
TEST_START = 39    # first test month (Apr 2001)
ALPHA = 0.1        # smoothing constant for SES / Croston / SBA / TSB size
BETA = 0.1         # TSB probability smoothing constant
Z_GRID = [round(0.25 * i, 2) for i in range(0, 17)]  # 0 .. 4


# --------------------------------------------------------------------------- data
def load_demand() -> tuple[list[str], np.ndarray]:
    import pyreadr

    cache = ROOT / "analysis" / ".cache" / "carparts.rda"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        urllib.request.urlretrieve(DATA_URL, cache)
    df = pyreadr.read_r(str(cache))["carparts"]
    df = df.dropna(axis=1)
    return [str(c) for c in df.columns], df.to_numpy(dtype=float).T  # (parts, months)


# --------------------------------------------------------------------------- classical methods
# Each returns F with F[:, t] = forecast of month t made with months < t (NaN for t < BURN).
def f_naive(Y):
    F = np.full(Y.shape, np.nan)
    F[:, BURN:] = Y[:, BURN - 1 : -1]
    return F


def f_mean(Y):
    F = np.full(Y.shape, np.nan)
    cs = np.cumsum(Y, axis=1)
    for t in range(BURN, Y.shape[1]):
        F[:, t] = cs[:, t - 1] / t
    return F


def f_zero(Y):
    F = np.full(Y.shape, np.nan)
    F[:, BURN:] = 0.0
    return F


def f_ses(Y, a=ALPHA):
    F = np.full(Y.shape, np.nan)
    lvl = Y[:, :BURN].mean(axis=1)
    for t in range(BURN, Y.shape[1]):
        F[:, t] = lvl
        lvl = lvl + a * (Y[:, t] - lvl)
    return F


def _croston_state(Y):
    """Initial Croston state from the burn-in window."""
    n = Y.shape[0]
    z = np.zeros(n)
    p = np.ones(n)
    q = np.ones(n)
    ready = np.zeros(n, dtype=bool)
    for i in range(n):
        w = Y[i, :BURN]
        nz = np.flatnonzero(w > 0)
        if len(nz):
            z[i] = w[nz].mean()
            p[i] = BURN / len(nz)
            q[i] = BURN - nz[-1]  # periods since last demand, counting the next month
            ready[i] = True
        else:
            q[i] = BURN + 1
    return z, p, q, ready


def f_croston(Y, a=ALPHA, sba=False):
    F = np.full(Y.shape, np.nan)
    z, p, q, ready = _croston_state(Y)
    k = (1 - a / 2) if sba else 1.0
    for t in range(BURN, Y.shape[1]):
        F[:, t] = np.where(ready, k * z / p, 0.0)
        y = Y[:, t]
        hit = y > 0
        first = hit & ~ready
        upd = hit & ready
        z = np.where(first, y, np.where(upd, z + a * (y - z), z))
        p = np.where(first, q, np.where(upd, p + a * (q - p), p))
        ready = ready | hit
        q = np.where(hit, 1, q + 1)
    return F


def f_tsb(Y, a=ALPHA, b=BETA):
    F = np.full(Y.shape, np.nan)
    w = Y[:, :BURN]
    d = (w > 0).mean(axis=1)
    cnt = (w > 0).sum(axis=1)
    z = np.where(cnt > 0, np.where(w > 0, w, 0).sum(axis=1) / np.maximum(cnt, 1), 0.0)
    ready = cnt > 0
    for t in range(BURN, Y.shape[1]):
        F[:, t] = d * z
        y = Y[:, t]
        hit = y > 0
        z = np.where(hit & ~ready, y, np.where(hit, z + a * (y - z), z))
        ready = ready | hit
        d = d + b * (hit.astype(float) - d)
    return F


# --------------------------------------------------------------------------- LightGBM
FEATURES = [
    *[f"lag{k}" for k in range(1, 13)],
    "mean3", "mean6", "mean12", "mean_all", "nz12", "since_last", "mean_nz_size",
    "ses", "sba", "tsb", "month",
]


def features_at(Y, t, ses, sba, tsb):
    """Feature matrix for target month t using only months < t."""
    H = Y[:, :t]
    cols = [H[:, t - k] for k in range(1, 13)]
    cols += [H[:, -3:].mean(1), H[:, -6:].mean(1), H[:, -12:].mean(1), H.mean(1)]
    cols.append((H[:, -12:] > 0).sum(1).astype(float))
    pos = H > 0
    last = np.where(pos.any(1), t - 1 - np.argmax(pos[:, ::-1], axis=1), -1)
    cols.append(np.where(last >= 0, t - last, t + 1).astype(float))
    nzc = pos.sum(1)
    cols.append(np.where(nzc > 0, np.where(pos, H, 0).sum(1) / np.maximum(nzc, 1), 0.0))
    cols += [ses[:, t], sba[:, t], tsb[:, t]]
    cols.append(np.full(Y.shape[0], float(t % 12)))
    return np.column_stack(cols)


def lgbm_walk_forward(Y, ses, sba, tsb, params, first_target, seed=7):
    import lightgbm as lgb

    T = Y.shape[1]
    X_by_t = {t: features_at(Y, t, ses, sba, tsb) for t in range(BURN, T)}
    F = np.full(Y.shape, np.nan)
    for t in range(first_target, T):
        Xtr = np.vstack([X_by_t[s] for s in range(BURN, t)])
        ytr = np.concatenate([Y[:, s] for s in range(BURN, t)])
        model = lgb.LGBMRegressor(random_state=seed, verbose=-1, n_jobs=4, **params)
        model.fit(Xtr, ytr)
        F[:, t] = np.clip(model.predict(X_by_t[t]), 0, None)
    return F


LGBM_GRID = [
    dict(objective="tweedie", tweedie_variance_power=1.2, learning_rate=0.05, n_estimators=200,
         num_leaves=15, min_child_samples=100, subsample=0.8, subsample_freq=1, colsample_bytree=0.8),
    dict(objective="tweedie", tweedie_variance_power=1.5, learning_rate=0.05, n_estimators=200,
         num_leaves=15, min_child_samples=100, subsample=0.8, subsample_freq=1, colsample_bytree=0.8),
    dict(objective="poisson", learning_rate=0.05, n_estimators=200,
         num_leaves=15, min_child_samples=100, subsample=0.8, subsample_freq=1, colsample_bytree=0.8),
    dict(objective="l2", learning_rate=0.05, n_estimators=200,
         num_leaves=15, min_child_samples=100, subsample=0.8, subsample_freq=1, colsample_bytree=0.8),
]


# --------------------------------------------------------------------------- evaluation
def sigma_path(Y, F):
    """S[:, t] = RMSE of one-step errors on months EVAL_START..t-1 (expanding window)."""
    E2 = (Y - F) ** 2
    S = np.full(Y.shape, np.nan)
    for t in range(EVAL_START + 1, Y.shape[1]):
        S[:, t] = np.sqrt(np.nanmean(E2[:, EVAL_START:t], axis=1))
    return S


def accuracy(Y, F, months):
    e = Y[:, months] - F[:, months]
    a = Y[:, months]
    return dict(
        mae=float(np.mean(np.abs(e))),
        rmse=float(np.sqrt(np.mean(e**2))),
        bias=float(np.mean(-e)),  # forecast minus actual: >0 means over-forecasting
        wape=float(np.abs(e).sum() / a.sum()),
    )


def simulate(Y, F, S, z, lead):
    """Periodic review (R=1), order-up-to, backorders, integer orders. Returns per-part arrays."""
    n, T = Y.shape
    months = list(range(TEST_START, T))
    def target(t):
        sig = np.nan_to_num(S[:, t])
        return np.ceil((lead + 1) * F[:, t] + z * sig * math.sqrt(lead + 1))
    net = target(TEST_START)
    pipeline = [np.zeros(n) for _ in range(lead)]
    served = np.zeros(n)
    dem = np.zeros(n)
    onhand = np.zeros(n)
    for t in months:
        if lead > 0:
            net = net + pipeline.pop(0)
        ip = net + sum(pipeline) if lead > 0 else net
        q = np.maximum(0, target(t) - ip)
        if lead == 0:
            net = net + q
        else:
            pipeline.append(q)
        y = Y[:, t]
        served += np.minimum(np.maximum(net, 0), y)
        dem += y
        net = net - y
        onhand += np.maximum(net, 0)
    return dict(served=served, demand=dem, avg_onhand=onhand / len(months))


def frontier(Y, F, S, lead):
    pts = []
    for z in Z_GRID:
        r = simulate(Y, F, S, z, lead)
        pts.append(dict(z=z, fill=float(r["served"].sum() / r["demand"].sum()), inv=float(r["avg_onhand"].sum())))
    return pts


def inv_at_fill(pts, target):
    """Linear interpolation of total average stock needed to reach a portfolio fill rate."""
    for a, b in zip(pts, pts[1:]):
        if a["fill"] <= target <= b["fill"] and b["fill"] > a["fill"]:
            w = (target - a["fill"]) / (b["fill"] - a["fill"])
            return a["inv"] + w * (b["inv"] - a["inv"])
    return None


def classify(Y):
    """Syntetos-Boylan-Croston classification on the history window."""
    out = []
    for y in Y[:, :TEST_START]:
        nz = y[y > 0]
        if len(nz) < 2:
            out.append("lumpy" if len(nz) else "no demand")
            continue
        adi = len(y) / len(nz)
        cv2 = (nz.std(ddof=1) / nz.mean()) ** 2
        if adi < 1.32:
            out.append("smooth" if cv2 < 0.49 else "erratic")
        else:
            out.append("intermittent" if cv2 < 0.49 else "lumpy")
    return out


# --------------------------------------------------------------------------- main
def main():
    parts, Y = load_demand()
    n, T = Y.shape
    print(f"{n} parts x {T} months; test months {TEST_START}..{T - 1}")

    ses, sba, tsb = f_ses(Y), f_croston(Y, sba=True), f_tsb(Y)
    methods = {
        "Zero": f_zero(Y), "Naive": f_naive(Y), "Mean": f_mean(Y), "SES": ses,
        "Croston": f_croston(Y), "SBA": sba, "TSB": tsb,
    }

    # Hyper-parameter choice on months 24..38 only.
    val = list(range(EVAL_START, TEST_START))
    best, best_mae = None, math.inf
    for i, p in enumerate(LGBM_GRID):
        Fv = lgbm_walk_forward(Y[:, :TEST_START], ses, sba, tsb, p, EVAL_START)
        m = accuracy(Y, np.pad(Fv, ((0, 0), (0, T - TEST_START)), constant_values=np.nan), val)["mae"]
        print(f"  grid {i} ({p['objective']}{p.get('tweedie_variance_power', '')}): validation MAE {m:.4f}")
        if m < best_mae:
            best, best_mae = p, m
    print("chosen:", best)
    # Pad one empty month so the same walk-forward loop also yields next month's forecast
    # (month T), trained on all 51 real months. Months < T are unaffected by the padding.
    Yp = np.hstack([Y, np.zeros((n, 1))])
    lgbm_p = lgbm_walk_forward(Yp, f_ses(Yp), f_croston(Yp, sba=True), f_tsb(Yp), best, EVAL_START)
    lgbm, lgbm_next = lgbm_p[:, :T], lgbm_p[:, T]
    methods["LightGBM"] = lgbm

    test = list(range(TEST_START, T))
    res = {"parts": n, "months": T, "test_months": len(test), "lgbm_params": best, "alpha": ALPHA, "beta": BETA,
           "classes": {}, "accuracy": {}, "frontier": {}, "inv_at_fill": {}}
    for c in classify(Y):
        res["classes"][c] = res["classes"].get(c, 0) + 1
    sig = {k: sigma_path(Y, F) for k, F in methods.items()}
    for k, F in methods.items():
        res["accuracy"][k] = accuracy(Y, F, test)
        for lead in (0, 1, 2):
            pts = frontier(Y, F, sig[k], lead)
            res["frontier"].setdefault(str(lead), {})[k] = pts
            for tgt in (0.85, 0.90, 0.95):
                res["inv_at_fill"].setdefault(str(lead), {}).setdefault(str(tgt), {})[k] = inv_at_fill(pts, tgt)

    for k, a in res["accuracy"].items():
        print(f"{k:9s} MAE {a['mae']:.4f} RMSE {a['rmse']:.4f} bias {a['bias']:+.4f}")
    for tgt in ("0.85", "0.9", "0.95"):
        row = res["inv_at_fill"]["1"][tgt]
        print(f"L=1 stock for {tgt} fill:", {k: (round(v, 1) if v else None) for k, v in row.items()})

    if "--seeds" in sys.argv:  # optional robustness check: LightGBM with other random seeds
        res["seed_check"] = []
        for seed in (1, 2, 3):
            Fs = lgbm_walk_forward(Y, ses, sba, tsb, best, EVAL_START, seed=seed)
            pts = frontier(Y, Fs, sigma_path(Y, Fs), 1)
            res["seed_check"].append(dict(seed=seed, mae=accuracy(Y, Fs, test)["mae"],
                                          inv90_L1=inv_at_fill(pts, 0.90), inv95_L1=inv_at_fill(pts, 0.95)))
            print("seed", res["seed_check"][-1])

    # ---- outputs for the web app
    pub = ROOT / "public" / "data"
    pub.mkdir(parents=True, exist_ok=True)
    month_labels = [f"{1998 + m // 12}-{m % 12 + 1:02d}" for m in range(T)]
    (pub / "carparts.json").write_text(json.dumps({
        "source": "Hyndman et al. (2008), R package expsmooth, dataset carparts: monthly sales of car parts, US car company",
        "months": month_labels, "parts": parts, "demand": [[int(v) for v in row] for row in Y],
    }, separators=(",", ":")))
    (pub / "lgbm.json").write_text(json.dumps({
        "firstMonth": EVAL_START, "params": best,
        "note": "One-step-ahead forecasts; model retrained each month on data available at that origin.",
        "forecast": [[round(float(v), 4) for v in row[EVAL_START:]] for row in lgbm],
        "next": [round(float(v), 4) for v in lgbm_next],
    }, separators=(",", ":")))
    (ROOT / "analysis" / "results.json").write_text(json.dumps(res, indent=1))

    # ---- parity fixture: a few parts, every classical method, plus one simulation result
    pick = [0, 5, 17, 123, 999]
    fx = {"alpha": ALPHA, "beta": BETA, "series": []}
    for i in pick:
        fx["series"].append({
            "demand": [int(v) for v in Y[i]],
            "forecast": {k: [None if np.isnan(v) else round(float(v), 10) for v in methods[k][i]]
                         for k in ("Naive", "Mean", "SES", "Croston", "SBA", "TSB")},
            "sigmaSBA": [None if np.isnan(v) else round(float(v), 10) for v in sig["SBA"][i]],
        })
    sub = np.array(pick)
    sim = simulate(Y[sub], methods["SBA"][sub], sig["SBA"][sub], 1.5, 1)
    fx["simSBA_z1.5_L1"] = {k: [float(x) for x in v] for k, v in sim.items()}
    fix = ROOT / "src" / "lib" / "__fixtures__"
    fix.mkdir(parents=True, exist_ok=True)
    (fix / "parity.json").write_text(json.dumps(fx))
    print("wrote outputs")


if __name__ == "__main__":
    sys.exit(main())
