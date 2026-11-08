Using the grounding pack's fitted exponential trend for `t_to_45c_min` and the normalized shape table, we estimate the time for batch 104 to cool to 60.0 °C as follows:

1. **Time to 45 °C for batch 104**:  
   exponential model: `t_to_45c(104) = 32.7764 − (−10410.9)·(e^(8.17026e-06·104) − 1) = 41.625 min`.

2. **Span (total normalized time) for batch 104**:  
   from the shape table, the fraction `x` corresponding to 45 °C is found by linear interpolation between `x = 0.600` (45.450 °C) and `x = 0.625` (44.5525 °C):  
   `x_45 = 0.61253`.  
   Span = `t_to_45c / x_45 = 41.625 / 0.61253 ≈ 67.96 min`.

3. **Fraction `x` for 60.0 °C**:  
   interpolate between `x = 0.300` (60.015 °C) and `x = 0.325` (58.4762 °C):  
   `x_60 = 0.30024`.

4. **Time to 60.0 °C**:  
   `t = x_60 · span = 0.30024 · 67.96 ≈ 20.40 min`.

FINAL ESTIMATE: 20.4 min