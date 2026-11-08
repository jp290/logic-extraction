The cooling profile for the campaign is captured by a normalized shape table that gives temperature as a function of fraction of batch‑span. From that table, the fraction for 45 °C is x₄₅ ≈ 0.6125 and for 60 °C is x₆₀ ≈ 0.3002, both obtained by linear interpolation between the nearest tabulated values. The ratio x₆₀/x₄₅ = 0.490.

For batch 104, the time‑to‑45 °C is estimated using the pack’s best trend model (exponential), which gives  
t_to_45 = 32.7764 + 10410.9 × (exp (8.17026e‑06 × 104) – 1) ≈ 41.62 min.

Time to reach 60 °C is then (x₆₀/x₄₅) × t_to_45 ≈ 0.490 × 41.62 ≈ 20.40 min. This estimate inherits the exponential model’s held‑out validation MAE (~0.3 min) and the shape table’s overall MAE (2.2 °C); the result is consistent with a local check using the T_at_20min linear model, which predicts ~60.66 °C at 20 min and a slightly later crossing at ~20.7 min, within the same uncertainty band.

FINAL ESTIMATE: 20.4 min