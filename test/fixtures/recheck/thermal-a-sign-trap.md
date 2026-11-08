The best fitted form for `t_to_45c_min` on held‑out validation is the **exponential** model:

\[
y = a - b \bigl(e^{c \cdot k} - 1\bigr)
\]

with stored parameters  

\[
a = 32.7764,\qquad b = -10410.9,\qquad c = 8.17026 \times 10^{-6}.
\]

Substitute \(k = 95\) (batch number) step by step.

1. **Exponent**  
   \[
   c \cdot k = (8.17026 \times 10^{-6}) \times 95 = 0.0007761747
   \]

2. **Exponential term**  
   \[
   e^{0.0007761747} - 1 \approx 0.0007764759
   \]
   (computed via series expansion: \(e^{x} \approx 1 + x + x^{2}/2\) with negligible higher‑order terms at this tiny \(x\)).

3. **Multiplication by \(-b\)**  
   Since \(b = -10410.9\), we have \(-b = +10410.9\).  
   \[
   -b \bigl(e^{c k} - 1\bigr) = 10410.9 \times 0.0007764759 = 8.08381
   \]
   (Exact product: \(10410.9 \times 0.0007764759 = 8.08381\) to five decimals.)

4. **Add the intercept**  
   \[
   y = a + \bigl[-b \bigl(e^{c k} - 1\bigr)\bigr] = 32.7764 + 8.08381 = 40.8602
   \]

**Predicted time to 45 °C for batch 95** = **40.86 minutes** (rounded to two decimals). The effective noise floor from held‑out validation is ± 0.29 min, so an interval of approximately 40.6 – 41.2 min is consistent with the model’s predictive uncertainty.