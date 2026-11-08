Using the **exponential** model for `t_to_45c_min` — selected as best on held‑out validation — the formula and fitted parameters are:

\[
y = a - b\,(e^{\,c\,k} - 1)
\]
\[
a = 32.7764,\qquad
b = -10410.9,\qquad
c = 8.17026\times 10^{-6}
\]

For batch \(k = 95\):

\[
c\,k = 8.17026\times 10^{-6} \times 95 = 0.0007761747
\]

\[
e^{c k} = e^{0.0007761747}
        = 1 + 0.0007761747 + \frac{(0.0007761747)^2}{2} + \frac{(0.0007761747)^3}{6} + \cdots
        \approx 1.0007764760
\]

\[
e^{c k} - 1 \approx 0.0007764760
\]

\[
- b\,(e^{c k} - 1) = 10410.9 \times 0.0007764760 = 8.083814
\]

\[
y = 32.7764 + 8.083814 = 40.8602
\]

**Predicted time to 45 °C for batch 95 = 40.86 min**  
(rounded to two decimals; the model’s validation MAE is ± 0.29 min.)