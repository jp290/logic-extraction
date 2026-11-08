At \(n = 3072\), the measured record gives:

- `cmp_mergesort` = 31 775 comparisons  
- `cmp_quicksort` = 43 011 comparisons  

\[
\frac{31\,775}{43\,011} \approx 0.7388 \times 100 \approx 73.9\%
\]

So on this uniform random permutation, `cmp_mergesort` used about **74%** as many comparisons as `cmp_quicksort`.