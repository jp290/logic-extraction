Based on the recorded cooling profiles and fitted trends across batches 1–110, the **latter part of the campaign – roughly from batch 75 onward – is at clear risk of failing the “T ≤ 55 °C by 25 min” requirement**, and the risk grows steadily with each subsequent batch as fouling worsens.

## Which part of the campaign was at risk

### 1. Direct inspection of the extremes
- **Batch 1** (clean): T at 20 min = 55.47 °C; by 25 min the temperature had dropped to about **51.1 °C** (well below 55 °C).  
- **Batch 110** (heavily fouled): T at 20 min = 60.67 °C; by 25 min ≈ **56.5 °C**, which violates the limit.  

Thus a monotonic drift caused the failure somewhere in the middle of the campaign.

### 2. Using the validated linear trend for T @ 20 min
The best held‑out model for T at 20 min (linear, validation MAE = 0.20 °C) is:

\[
T_{20}(k) = 55.84 \;+\; 0.04630 \times k \qquad (k = \text{batch number}).
\]

The temperature drop between minute 20 and minute 25 is fairly stable; from the two extreme batches, the drop is ≈ 4.4 °C (batch 1) and ≈ 4.2 °C (batch 110). Using a constant drop of **4.3 °C** as a conservative estimate, the requirement “T(25) ≤ 55 °C” translates to a threshold on the 20‑minute temperature:

\[
T_{20,\text{max}} \ \approx\ 55 \, + \, 4.3 \;=\; 59.3\ \text{°C}.
\]

Setting \(T_{20}(k) = 59.3\) in the linear model gives

\[
55.84 + 0.04630 \, k = 59.3 \;\Longrightarrow\; k \approx 74.7 .
\]

So **from around batch 75 onward, the central estimate crosses the safe limit**. Even accounting for the ±0.20 °C validation noise, the risk becomes high in the 70s and is virtually certain for batches above ~80.

### 3. Cross‑check with the time‑to‑45 °C trend
The exponential model for \(t_{45}\) (the best validated model, MAE = 0.29 min) is:

\[
t_{45}(k) = 32.7764 + 10410.9\,(e^{8.170\times10^{-6}\,k} - 1).
\]

From the median cooling‑curve shape (§4 of the pack), the ratio \(t_{55}/t_{45}\) is approximately \(0.388/0.604 \approx 0.642\), independent of the batch’s total cooling span. Hence, the condition \(t_{55} < 25\) min is equivalent to \(t_{45} < 25 / 0.642 = 38.9\) min. Solving \(t_{45}(k) = 38.9\) gives \(k \approx 72\). This independent indicator also places the onset of risk in the same batch range.

## Proposed operating rule, grounded in the data

Since the 20‑minute temperature measurement is available early in the cooling phase and directly predicts the final outcome, the plant should adopt the following rule:

> **Real‑time threshold:** At minute 20 of cooling, if the measured product temperature exceeds **59.0 °C**, the batch is likely to violate the 25‑minute requirement and immediate corrective action (e.g., increased cooling flow, shortened batch, or a cooling step extension) must be taken.  
> **Campaign monitoring:** Track the per‑batch \(T_{20}\) trend. The linear model \(T_{20} = 55.84 + 0.0463\,k\) together with the critical 59 °C threshold predicts that the system will reach the risk zone near batch 75. Therefore, **schedule a cleaning or cooling‑surface maintenance before batch 70** (allowing a safety margin of a few batches) to reset the cooling performance and keep \(T_{20}\) well below 59 °C.

Both the threshold (59 °C) and the maintenance trigger (batch ≈ 70) are direct consequences of the observed data and the validated models; they carry the stated validation error (\(\pm 0.20\) °C for \(T_{20}\), \(\pm 0.29\) min for \(t_{45}\)) and are valid within the envelope of batches 1–110.