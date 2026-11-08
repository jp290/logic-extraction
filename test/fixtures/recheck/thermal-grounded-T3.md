The batch cooling process is being slowed by accumulation on the cooling surfaces—a classic fouling progression that can be tracked by batch number as a proxy for the extent of fouling. Because the question asks for the time to reach a specific temperature at a particular batch number, the approach is to first characterize the shape of the cooling curve and then scale it to the current degree of fouling.

From the measured data, the cooling trajectory across all batches follows a smooth, decelerating path. This shape is captured in the normalized reference table (§4 of the pack): the fraction of the cooling span \(x\) maps to a temperature \(T_c\). The shape is consistent enough that the median reference curve has a held‑out validation MAE of 2.16 °C, which is acceptable for estimation.

For batch 73 we need the actual time to the target of 50 °C. Two independent estimates can be made using the fitted trend models and the normalized shape, giving a consistency check.

**Method 1 – time‑to‑45 °C scaling**

The time to cool to 45 °C is provided as a fitted function of batch number. The best validated model is the exponential:
\[
t_{45}(k) = a - b\,(e^{c\,k}-1)
\]
with \(a = 32.7764\), \(b = -10\,410.9\), \(c = 8.17026\times10^{-6}\). For \(k = 73\):
\[
c\,k = 5.9643\times10^{-4},\quad e^{c\,k}-1 \approx 5.9643\times10^{-4},\quad t_{45}(73) \approx 32.7764 + 10\,410.9\times5.9643\times10^{-4}
\approx 38.99\ \text{min}.
\]

From the shape table, 45 °C lies between \(x = 0.600\) (45.45 °C) and \(x = 0.625\) (44.55 °C). Linear interpolation gives \(x_{45} \approx 0.6125\). Similarly, 50 °C lies between \(x = 0.475\) (50.70 °C) and \(x = 0.500\) (49.52 °C), yielding \(x_{50} \approx 0.4899\).  
Since \(t_{45} = \text{span} \cdot x_{45}\) and \(t_{50} = \text{span} \cdot x_{50}\), the ratio removes the span:
\[
t_{50} = t_{45}\,\frac{x_{50}}{x_{45}} \approx 38.99 \times \frac{0.4899}{0.6125} \approx 31.18\ \text{min}.
\]

**Method 2 – temperature‑at‑20 min scaling**

The temperature at 20 minutes also has a fitted trend (best linear model):
\[
T_{20}(k) = a - b\,k \quad\text{with } a = 55.8401,\ b = -0.04630
\]
\[
T_{20}(73) = 55.8401 + 0.04630\times73 \approx 59.22\ \text{°C}.
\]

The shape table places 59.22 °C between \(x = 0.300\) (60.02 °C) and \(x = 0.325\) (58.48 °C), giving \(x_{20} \approx 0.3129\). Hence the total span of the cooling run is \(\text{span} = 20 / 0.3129 \approx 63.92\ \text{min}\). The time to 50 °C is then:
\[
t_{50} = 63.92 \times 0.4899 \approx 31.31\ \text{min}.
\]

Both methods point to roughly **31.2 minutes**, well within the combined model and shape‑table uncertainties. The estimate aligns with the visible progression: batch 10 took 33.4 min to 45 °C, batch 60 took 38.0 min, and batch 105 took 41.9 min; a time of 31.2 min to 50 °C for batch 73 fits the gradual slowdown.

FINAL ESTIMATE: 31.2 min