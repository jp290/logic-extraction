Based on the measured capacity at cycle 110 (1.449 Ah) and the linear aging trend fitted from cycle 1–88 (validation MAE 0.032 Ah), the cell is estimated to cross the 1.40 Ah threshold in **13 cycles** from its current state, i.e. around cycle 123.

That estimate rests on the linear slope of –0.00370 Ah/cycle (the best model on held‑out validation). The actual capacity at cycle 110 was 0.041 Ah below the linear model’s prediction, so I’d treat the slope as the more trustworthy piece; anchoring on the latest measurement, the remaining 0.049 Ah ÷ 0.00370 Ah/cycle gives 13.2 cycles.

**Confidence bounds**

- The validation MAE (0.032 Ah) translates to a rough practical scatter of ±0.04–0.08 Ah on a single‑point capacity forecast.  
- That scatter alone makes the time‑to‑1.40 Ah uncertain by **±20 cycles** at a 95 % level.  
- Moreover, the trend fits were only validated to cycle 110; beyond that the framing document warns of “growing structural uncertainty.” So I’d give a **planning range of 5–25 cycles**, not a tight schedule.

**Monitoring to revise the plan**

1. **Direct capacity** – Measure discharge capacity every cycle (or every 2 – 3 cycles) by integrating current during the standard 2.0 A discharge. The moment capacity falls below 1.42 Ah, trigger an accelerated observation phase.  
2. **Voltage at 1000 s and 1800 s** – These are already recorded. The fitted sqrt‑linear trends show a steady decay. If either voltage deviates from its predicted trajectory by > 0.02 V (roughly twice the validation MAE), it signals a possible regime change in internal resistance that the simple linear aging model doesn’t capture.  
3. **Maximum temperature** – The data show a slow rise from ~39 °C to ~41 °C. An abrupt increase of >1 °C above the recent level (e.g., >42 °C) would indicate accelerating degradation and should shorten the planned remaining life.

**Rationale in the BattX spirit**

The framework values extrapolation as the strongest evidence. Here the linear model, though not a mechanistic degradation law, was the only model that stayed honest on held‑out validation; the sqrt‑linear and exponential models failed later. Because the extrapolation distance (13 cycles) is small relative to the fitted range, the linear trend is the safest default. But I’m explicitly not treating the plan as a fixed number – the model’s acknowledged fragility at low‑SoC/high‑resistance conditions (the “radical changes … hard to thoroughly capture”) is precisely what might appear near end of life, and that’s why the monitoring triggers are set to catch a departure from linearity early.