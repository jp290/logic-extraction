For batch 100, the best held-out model for `T_at_20min_c` is the **linear** fit:

\( T_{\text{at }20\text{ min}}(\text{batch }k) = a - b \cdot k \)

with \( a = 55.8401 \) and \( b = 0.0463002 \).  
Plugging in \( k = 100 \):

\( T = 55.8401 - 0.0463002 \times 100 = 55.8401 - 4.63002 = 51.21008\text{ °C} \)

**Prediction:** **51.21 °C** (rounded to two decimals; unrounded value 51.21008 °C).  
**Validation MAE:** **0.2005 °C** (0.200537 from the pack).  

Batch 100 lies inside the valid envelope (batches 1–110), so this is an interpolation and the held‑out error applies directly.