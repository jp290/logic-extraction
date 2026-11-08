Based on the linear capacity‑fade model that held out best (validation MAE 0.0322 Ah), the cell is expected to cross the 1.40 Ah end‑of‑life threshold around cycle 134.

Remaining service from today’s cycle 110: **24 more cycles**.

That centre estimate inherits a noise floor of ±0.032 Ah from the validation error. Translating that capacity uncertainty through the fade slope (3.70 mAh/cycle) gives a **rough ±9 cycles (≈ 1σ)** range around cycle 134, i.e. **~15‑to‑33 cycles remaining**. This is a lower‑bound confidence interval; extrapolation beyond the fitted envelope adds structural uncertainty that the linear model cannot capture (e.g. acceleration or deceleration of fade). A prudent plan would therefore assume the earlier end of that window and schedule a supervised replacement run well before cycle 130.

**What to monitor to revise the plan**

- **Discharge capacity (direct trigger):** Measure \(C\) every cycle. If the running 3‑point trailing average deviates below the linear trajectory (e.g. crosses the 1 MAE band ≈ 0.03 Ah below the predicted line), shorten the interval.
- **Cutoff time under load (t_cutoff_s):** This falls nearly linearly with capacity. At 1.40 Ah the linear model projects ≈ 2500 s (from \(3408.14-6.7023\cdot k\), checked at k≈134). Should the observed discharge time approach that value sooner, treat it as an early coupon for capacity.
- **Voltage depression at fixed time (v_at_1000s, v_at_1800s):** The sqrt‑linear models for these voltages have held out well. If the 1000 s voltage slips below ≈ 3.55 V (the projected value near cycle 134) before expected, expect faster aging.
- **Trend shape:** Watch for a “knee” where the linear slope steepens. If the capacity drop over a 5‑cycle window exceeds 0.025 Ah twice in a row, treat the linear model as violated and decrease the planned remaining life accordingly.

**Recommendation:** Plan the next replacement outage for **cycle 125** (15 cycles from now) with a decision gate at cycle 120 – if capacity at 120 is already below 1.43 Ah, replace immediately; otherwise proceed with close monitoring. This gives a 9‑cycle buffer before the median prediction, absorbing the documented validation scatter plus a minimal allowance for un‑modelled acceleration.