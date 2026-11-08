Based on the grounding pack, the best-fitting model for discharge capacity versus cycle number (within the observed envelope of cycles 1–110) is linear: **capacity_ah(k) = 1.89684 − 0.00370267·k [Ah]**, with a held‑out validation MAE of 0.0322 Ah. This model is chosen because it gave the smallest error on the last 22 cycles (validation set).

Applying at k = 140:

1.89684 − 0.00370267 × 140 = 1.89684 − 0.5183738 = 1.3784662 Ah.

**Important caveats:** The valid envelope ends at cycle 110. Any prediction for cycle 140 is an extrapolation; the validation MAE (0.032 Ah) serves only as a *lower bound* for uncertainty, and structural uncertainty grows because the linear trend may not persist unmodified beyond the observed range.

FINAL ESTIMATE: 1.3785 Ah