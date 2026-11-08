For insertion sort on uniform random permutations, the comparison count scales quadratically with n. The grounding pack's fitted quadratic model for cmp_insertion is:

y = -3074.31 + 0.253393 · n²

This model achieved the best held‑out validation among the candidates, with a validation MAE of about 132,930 comparisons over the range 64–8192. The point at n = 4096 lies within the held‑out set, so the estimate from this model is the prescribed one. Plugging in:

n² = 4096² = 16,777,216  
0.253393 × 16,777,216 ≈ 4,251,229.1  
y ≈ 4,251,229.1 – 3,074.31 ≈ 4,248,154.8  

Rounding yields the prediction. Note that the validation MAE is non‑trivial; the true measured count for this particular seeded run is expected to be within roughly ±133k of the figure below.

FINAL ESTIMATE: 4248155 comparisons