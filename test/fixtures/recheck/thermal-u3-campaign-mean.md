The proposal to use a single fixed cooling time equal to the campaign average is **inconsistent with the observed batch-to-batch trend** and would lead to large, systematic temperature deviations from the 45 °C target. Here is a concrete assessment based on the fitted trend models and normalized cooling shapes from the grounding pack.

## 1. Cooling‑time trend (time to reach 45 °C)

The held‑out‑best model for `t_to_45c_min(k)` is the exponential  

\[
\hat t_{45}(k) = 32.7764 - (-10410.9)\bigl(e^{8.17026\times10^{-6}\,k}-1\bigr)
                = 32.7764 + 10410.9\,\bigl(e^{8.17026\times10^{-6}\,k}-1\bigr),
\]

practically linear with slope ≈ 0.085 09 min/batch (validation MAE = 0.294 min).

- **Batch 1** predicted: 32.86 min  
- **Batch 110** predicted: 42.14 min  
- **Campaign average** (arithmetic mean of predictions for k = 1…110): **≈ 37.5 min**

## 2. Consequences of using the fixed average (37.5 min)

The cooling curve shape is captured by the normalized‑shape table (§4). For the reference curve, 45 °C is reached at a time‑span fraction x ≈ 0.6125. Assuming that fraction is stable across batches (MAE of the normalized shape = 2.16 °C, so this is an approximation), the temperature after 37.5 min of cooling for a batch with required time \(t_{45}\) is estimated by  

\[
x = \frac{37.5}{t_{45}} \times 0.6125,
\qquad
T_c \approx \text{ref\_shape}(x).
\]

| batch | \(t_{45}\) (min) | x at 37.5 min | final \(T_c\) (°C) | deviation from 45 °C |
|-------|------------------|----------------|---------------------|-----------------------|
| 1     | 32.86            | 0.699          | **~42.0**           | –3.0 °C (over‑cooled) |
| 110   | 42.14            | 0.545          | **~47.6**           | +2.6 °C (under‑cooled)|

Thus, fixing cooling time at the campaign average would:
- **Waste time** on early batches (cooling ∼4.7 min longer than needed),
- **Fail to reach the target temperature** on later batches, leaving them 2–3 °C too hot,
- Create a **5 °C spread** in final temperatures across the campaign instead of a consistent 45 °C stop.

## 3. Recommended approach

Cooling time should **increase batch‑by‑batch** according to the fouling trend. The schedule can be built directly from the exponential fit with a small safety margin:

\[
\boxed{
t_{\text{cool}}(k) = 32.7764 + 10410.9\,\bigl(e^{8.17026\times10^{-6}\,k}-1\bigr) \;+\; \text{buffer}
}.
\]

A buffer of **0.6–0.8 min** (roughly 2 × validation MAE) keeps the probability of a batch missing 45 °C low while minimising excess cooling. For example:
- Batch 1: ∼33.5 min (with buffer)
- Batch 60: ∼38.6 min
- Batch 110: ∼42.9 min

This adaptive plan eliminates the systematic under‑/over‑cooling and delivers **target‑consistent temperatures across the full campaign**, respecting the measured fouling behaviour documented in batches 1–110.