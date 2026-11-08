The best model for `t_cutoff_s` by held-out validation MAE is the **linear** model:

\[
t_{\text{cutoff}}(k) = 3408.14 - 6.70232 \cdot k
\]

Evaluating at \(k = 120\):

\[
t_{\text{cutoff}}(120) = 3408.14 - 6.70232 \times 120 = 3408.14 - 804.2784 = 2603.8616 \ \text{s}
\]

Rounding to about one decimal place (consistent with the input precision), the predicted cutoff time is **≈ 2603.9 s**.

**Validation MAE relied on:** 55.6434 s.  
*Note: This is a trend extrapolation beyond the observed window (cycle 110); the validation MAE serves as a lower‑bound error estimate, with additional structural uncertainty from possible unmodeled regime changes.*