Cycle 120 lies outside the valid envelope of the fitted models (cycles 1–110). The best model for v_at_1800s inside that window is sqrt_linear (validation MAE ≈ 0.0066 V). Extrapolating it to cycle 120 implicitly treats the train‑set trend as continuing; actual error will be at least the validation MAE and likely larger because the cell may enter regimes the form does not capture.

Applying the sqrt_linear formula  
y = a − b·k − c·√k  
with a = 3.49796, b = 0.00303266, c = −0.0235811 for k = 120:  
b·k = 0.3639192  
√120 ≈ 10.95445, −c·√k = 0.0235811 × 10.95445 ≈ 0.25832  
y = 3.49796 − 0.3639192 + 0.25832 ≈ 3.39236 V

FINAL ESTIMATE: 3.392 V