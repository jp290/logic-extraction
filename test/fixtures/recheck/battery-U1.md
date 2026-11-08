Based on the linear capacity fade model (best validated model, §3a), the cell’s capacity is predicted as  
`C(k) = 1.89684 – 0.00370267·k` Ah.  
Solving `C(k) = 1.40` Ah gives `k = (1.89684 – 1.40) / 0.00370267 ≈ 134.2` cycles.  

**Additional cycles from cycle 110:** `134 – 110 = 24` cycles.

### Confidence bounds
- The held‑out validation MAE of the linear model is **±0.0322 Ah** (conservatively treated as a lower bound for extrapolation beyond cycle 110).  
- Translating this capacity error into cycles: `Δk = 0.0322 / 0.0037027 ≈ 8.7` cycles.  
Thus a tentative 1‑σ prediction interval for reaching 1.40 Ah is about **24 ± 9 cycles** (i.e., between cycle 125 and 143).  
- **Important caveat:** the model was fitted only up to cycle 88 and validated on cycles 89–110; extrapolation past 110 adds structural uncertainty not captured by the fit. The ±9 cycles should be considered optimistic; actual spread may be larger if the fade rate accelerates (a common late‑life behavior).

### Recommended replacement schedule
- **Plan for 20 more cycles** (replacement at cycle 130) to maintain a safe margin, then reassess.  
- At each cycle, **measure discharge capacity**. If capacity falls to 1.40 Ah before cycle 130, replace immediately.  
- If after 130 cycles the capacity is still above 1.40 Ah, continue monitoring but shorten the replacement interval (e.g., every 5 cycles) until the threshold is reached.

### Monitoring to revise the plan
- **Primary indicator:** discharge capacity each cycle. Plot the recent trend (e.g., last 10–20 cycles); if the slope steepens or the capacity loss per cycle exceeds the linear‑model’s `0.0037 Ah/cycle`, replace sooner.
- **Secondary indicators:**  
  - `t_cutoff_s` (time to 2.7 V): expected ~2590 s at cycle 130 based on its linear model; a sudden drop >50 s may signal faster aging.  
  - `v_at_1000s` and `v_at_1800s`: voltage sag should follow their sqrt‑linear trends; deviations >0.02‑0.03 V can indicate increased resistance.  
  - `temp_max_c`: a rising trend or spikes above 42 °C may indicate internal shorts or excessive heat generation, warranting early replacement.

All predictions rely on the linear model’s validation error as a floor; real‑world uncertainty grows with extrapolation, so treat the schedule as a live plan informed by ongoing measurements.