The estimated time for batch 73 to reach 50.0 °C is obtained in two steps:

1. **Time to 45 °C** – the best held‑out validation model for `t_to_45c_min(k)` is exponential:  
   \( t_{45} = a - b\,(e^{c\cdot k} - 1) \) with  
   \( a = 32.7764 \), \( b = -10410.9 \), \( c = 8.17026\times10^{-6} \).  
   For \( k = 73 \):  
   \( e^{c\cdot73} \approx 1.00059661 \), giving  
   \( t_{45}(73) = 32.7764 + 10410.9\times0.00059661 \approx 38.99 \) min.

2. **From 45 °C to 50 °C** – the normalised shape table provides the fraction‑of‑span for each temperature. Linear interpolation yields:  
   - \( x_{45} = 0.6125 \) (between 0.600 ↔ 45.45 °C and 0.625 ↔ 44.55 °C)  
   - \( x_{50} = 0.4899 \) (between 0.475 ↔ 50.70 °C and 0.500 ↔ 49.52 °C)  
   The ratio \( x_{50}/x_{45} = 0.7997 \).  
   Therefore  
   \( t_{50} = t_{45} \times (x_{50}/x_{45}) \approx 38.99 \times 0.7997 \approx 31.2 \) min.

(Validation MAE for `t_to_45c` is 0.29 min; shape‑table MAE ≈ 2.16 °C translates to roughly ± 3 min on this estimate, so the figure is a central point estimate.)

FINAL ESTIMATE: 31.2 min