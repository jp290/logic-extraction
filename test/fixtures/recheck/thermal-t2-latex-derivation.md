To estimate the product temperature for batch 92 at 33.7 minutes, we use the grounding pack’s trend models to get the batch’s time‑to‑45 °C, then scale the median cooling shape to map clock time to temperature.

- **Time to 45 °C for batch 92:**  
  The best fit for `t_to_45c_min(k)` is the exponential model  
  `y = 32.7764 + 10 410.9 × (e^(8.17026×10⁻⁶ · k) – 1)`.  
  For k = 92, the exponent is 8.17026×10⁻⁶ × 92 ≈ 0.00075166,  
  `e^0.00075166 – 1 ≈ 0.00075195`,  
  so `t_to_45c(92) ≈ 32.7764 + 10 410.9 × 0.00075195 ≈ 40.60 min`.

- **Median cooling shape:**  
  The normalised shape table (fraction of run `x` vs. `T_c_ref`) shows  
  `x = 0.600 → 45.45 °C`, `x = 0.625 → 44.55 °C`.  
  Linear interpolation gives `x(45 °C) ≈ 0.6125`.

- **Time scaling for batch 92:**  
  Total span `t_span = t_to_45c / x(45 °C) ≈ 40.60 min / 0.6125 ≈ 66.29 min`.  
  At 33.7 min, `x = 33.7 / 66.29 ≈ 0.5083`.

- **Temperature from shape table:**  
  From the table: `x = 0.500 → 49.52 °C`, `x = 0.525 → 48.36 °C`.  
  Interpolating to `x = 0.5083` gives  
  `T ≈ 49.52 + (0.0083/0.025) × (48.36 – 49.52) ≈ 49.13 °C`.

The estimate carries the validated MAE of about 2.2 °C from the shape table, so the value is reported to one decimal.

FINAL ESTIMATE: 49.1 °C