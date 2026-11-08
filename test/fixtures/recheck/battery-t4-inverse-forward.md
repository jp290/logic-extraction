We use the fitted linear trend for discharge capacity from the grounding pack, since it gave the smallest held‑out error (validation MAE 0.032 Ah) over the measured range (cycles 1–110). The model is  

\[
C(k) = 1.89684 - 0.00370267\,k \quad [\text{Ah}]
\]

Setting \(C(k) < 1.40\ \text{Ah}\) and solving:

\[
1.40 = 1.89684 - 0.00370267\,k \implies k = \frac{1.89684 - 1.40}{0.00370267} \approx 134.14
\]

At cycle 134 \(C \approx 1.4007\ \text{Ah}\); at cycle 135 \(C \approx 1.3970\ \text{Ah}\).  
Therefore the first cycle where the linear model predicts capacity below 1.40 Ah is cycle 135.

This is an extrapolation beyond the measurement envelope (max 110 cycles), so structural uncertainty (e.g., accelerating degradation) is not captured and the validation error of ±0.032 Ah is only a lower bound; the real crossing could occur somewhat earlier or later.

FINAL ESTIMATE: 135 cycles