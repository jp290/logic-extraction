The scheduling engineer’s proposal to use a single fixed cooling time — the campaign‑average time‑to‑45 °C — for every batch ignores the systematic drift in cooling performance caused by progressive fouling of the cooling surfaces. The plant data and fitted trend models show that the time‑to‑45 °C grows by ≈ 0.085 min per batch across the 110‑batch sequence. A fixed average would severely under‑cool the later, heavily fouled batches and waste cycle time on the early, clean ones.

### Quantitative assessment

**Trend of time‑to‑45 °C with batch number** (from the linear model, held‑out MAE = 0.29 min; the near‑identical exponential model gives the same picture):

\[
t_{\text{to }45}(k) = 32.78 + 0.0851\,k \quad\text{[minutes]},\qquad k = 1\ldots110
\]

- Batch 1 (clean): ≈ 32.9 min  
- Batch 110 (fouled): ≈ 42.1 min  
- Campaign arithmetic mean (at the mid‑point, \(k=55.5\)): ≈ 37.5 min  

If a fixed 37.5 min cooling period were imposed:

| Batch | Required time to 45 °C | Allotted fixed time | Consequence |
|-------|-------------------------|---------------------|-------------|
| 1 | 32.9 min | 37.5 min | 4.6 min over‑cooling (14 % wasted cooling‑cycle time) |
| 110 | 42.1 min | 37.5 min | 4.6 min under‑cooling; product temperature ≈ 48 °C instead of 45 °C (based on the normalised cooling‑curve shape table) |

For batch 110 the under‑cooling is not trivial: using the shape table, halting at 37.5 min corresponds to about 54 % of that batch’s total cooling span, when the temperature is still ≈ 48 °C — well above the 45 °C target. This would push the batch into the next process step too hot, likely violating product quality or downstream specifications.

### Recommended allotment

Instead of a uniform time, **schedule cooling time as a function of batch number using the fitted trend**. The simplest, fully adequate form is the linear trend (MAE ≈ 0.3 min):

\[
t_{\text{scheduled}}(k) = 32.78 + 0.0851\,k + \text{margin}
\]

A margin of +0.6 min (2 × MAE) gives a high probability of reaching ≤ 45 °C for all batches while keeping early‑batch over‑cooling modest. If greater precision is desired, the exponential form (validation MAE = 0.294 min) can be used, but the linear offers equal practicality.

**Implementation:**  
- Before each batch, look up the scheduled cooling time from the batch‑number‑based formula.  
- Update the trend periodically (e.g., every 20 batches) with the latest measured times‑to‑45 °C to capture any change in fouling rate.  
- If real‑time temperature is available, end the cooling step when the product reaches 45 °C rather than on a timer; the batch‑specific schedule can serve as a backup or a planner’s estimate.

This approach respects the auto‑retardation‑like degradation captured in the trend (fouling slows cooling) and avoids both the inefficiency of over‑cooling clean batches and the risk of under‑cooling heavily fouled ones.