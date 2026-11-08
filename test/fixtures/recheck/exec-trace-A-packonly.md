**Linear model**  
Formula: `y = a − b·n`  
Given `a = -1152.87`, `b = -14.0654`  
Plugging in `n = 6144`:

```
y = (-1152.87) – (-14.0654) × 6144
```

Handling the signs: subtracting a negative is adding the positive  
→ `y = -1152.87 + 14.0654 × 6144`

Compute the product:  
`14.0654 × 6000 = 84 392.4`  
`14.0654 × 144   =  2 025.4176`  
`14.0654 × 6144  = 84 392.4 + 2 025.4176 = 86 417.8176`

Add the intercept:  
`y = -1152.87 + 86 417.8176 = 85 264.9476`  
Rounded to one decimal: **85 265.0 comparisons**  

**Best‑validated (nlogn) model for reference**  
Formula: `y = a − b·n·log₂(n)` with `a = 44.2511`, `b = -1.21003`  
After sign handling: `y = 44.2511 + 1.21003 × n·log₂(n)`  
`n = 6144`, `log₂(6144) = log₂(4096 × 1.5) = 12 + log₂(1.5) ≈ 12 + 0.5849625 = 12.5849625`  
`n·log₂(n) ≈ 6144 × 12.5849625 = 77 322.0096`  
`1.21003 × 77 322.0096 ≈ 93 561.95`  
`y = 44.2511 + 93 561.95 ≈ 93 606.2 comparisons`

**Closing sentence**  
The linear model’s prediction at n = 6144 (≈85 265 comparisons) is lower than the best‑validated nlogn model’s prediction (≈93 606 comparisons).