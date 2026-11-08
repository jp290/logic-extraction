The best available estimate for batch 61 uses the **exponential trend model** for time to 45 °C (§3a) and the **normalized shape table** (§4).  
- Predicted \( t\_to\_45c\_min \) for batch 61 (k=61) from the exponential formula:  
  \( 32.7764 + 10410.9 \cdot (e^{8.17026\times10^{-6} \cdot 61} - 1) \approx 37.97\ \text{min} \)  
- The reference shape gives the fraction of total cooling time when 45 °C is reached as \( x = 0.6125 \) (interpolated between T=45.45 °C at x=0.600 and T=44.55 °C at x=0.625).  
- Total cooling span for the batch: \( 37.97 / 0.6125 \approx 62.0\ \text{min} \).  
- At 46.3 min the fraction \( x = 46.3 / 62.0 \approx 0.7470 \).  
- From the shape table, linear interpolation between x=0.725 (41.37 °C) and x=0.750 (40.64 °C) yields **~40.72 °C**.  

This point estimate carries the held‑out validation MAE of the shape table, **±2.16 °C**.

FINAL ESTIMATE: 40.7 °C