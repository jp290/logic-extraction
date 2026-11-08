The best validated model for `cmp_mergesort` over the envelope 64 ≤ n ≤ 8192 is the nlogn form:

`cmp_mergesort(n) = a − b·n·log₂(n)` with a = −112.558, b = −0.892855, which simplifies to  
`cmp_mergesort(n) = −112.558 + 0.892855 · n · log₂(n)`.

At n = 8192, log₂(8192) = 13, so n·log₂(n) = 106 496.  
Plugging in: 0.892855 × 106 496 = 95 085.48608, then subtract 112.558 → 94 972.92808.  
Rounding to the nearest integer gives **94 973 comparisons**, inheriting a held‑out validation MAE of ~700 comparisons (i.e., the true instrumented value for seed 11 at this n is expected to be within that band).

FINAL ESTIMATE: 94973 comparisons