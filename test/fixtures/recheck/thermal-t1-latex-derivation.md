The cooling for each batch follows a consistent normalized shape (fraction of total span vs. temperature) that is stable enough across the campaign to estimate intermediate points once the batch's total cooling span is known.

For batch 47, the two key summaries predicted from the grounding pack's trend models are:

- **T_at_20min**: using the best validated model (linear, increasing due to fouling)  
  \(T_{20} = 55.8401 + 0.0463002 \times 47 = 58.02\;°C\) (validation MAE ≈ 0.20 °C).

- **t_to_45c**: using the best validated model (exponential)  
  \(t_{45} = 32.7764 + 10410.9\,(e^{8.17026\times10^{-6} \times 47} - 1) = 36.78\; \text{min}\) (validation MAE ≈ 0.29 min).

From the normalized shape table, the temperature reaches 45 °C at a fraction \(x_{45} \approx 0.6125\) of the total span. The total cooling span for batch 47 is therefore  
\(S = 36.78 / 0.6125 \approx 60.05\; \text{min}\).

At \(t = 13.4\; \text{min}\), the span fraction is  
\(x = 13.4 / 60.05 \approx 0.22315\).

Interpolating the reference cooling curve (median shape table) between \(x = 0.200\) (66.965 °C) and \(x = 0.225\) (65.1075 °C) gives:

\[
T = 66.965 - 0.926 \times (66.965 - 65.1075) \approx 65.25\;°C.
\]

The shape table’s local standard deviation is about 0.9 °C, and the overall validation MAE is ~2.2 °C; the point estimate is the best available from the fitted pack.

FINAL ESTIMATE: 65.2 °C