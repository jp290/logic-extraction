Based on the linear model for discharge capacity degradation — `capacity_ah(k) = 1.89684 − 0.00370267·k` [Ah], which was the best‑performing fit on held‑out validation (MAE 0.032 Ah) — the capacity is predicted to fall below 1.40 Ah when  

1.89684 − 0.00370267·k < 1.40  
⇒ k > (1.89684 − 1.40) / 0.00370267 ≈ 134.17  

Thus the first integer cycle is **135**.  

This is an **extrapolation** beyond the valid envelope (cycles 1–110) and therefore carries at least the validation MAE plus unmodelled structural uncertainty; the true cycle number could differ.  

FINAL ESTIMATE: 135 cycles