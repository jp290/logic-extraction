For `v_at_1000s` the best model — chosen by lowest held‑out MAE — is the sqrt‑linear form:

**y = 3.6332 − 0.00295899·k − (−0.023512)·√k**  
  = **3.6332 − 0.00295899·k + 0.023512·√k**

At **cycle 90** (√90 ≈ 9.486833):

- 0.00295899 × 90 = 0.2663091  
- 0.023512 × 9.486833 ≈ 0.223053  
- y = 3.6332 − 0.2663091 + 0.223053 = **3.58994 V** (≈ **3.590 V**)

**Confidence:**  
The model was fitted on cycles 1–88; cycle 90 lies in the held‑out validation block (cycles 89–110). The validation MAE for this model is **0.0105 V**. That is the typical prediction error you should expect for an in‑envelope estimate — real‑world values may scatter by roughly ±0.01 V around this figure. There are no signs of a regime change inside the valid envelope, but the pack warns that local non‑monotonic events are not captured, so treat the 0.0105 V MAE as a noise floor rather than a hard bound.