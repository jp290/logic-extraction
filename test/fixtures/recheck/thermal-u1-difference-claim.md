The cooling time for the product to reach 45 °C has lengthened by **6.8 minutes** between batch 15 and batch 95 — from about **34.1 min** to **40.9 min** — and the trend is consistent across the full 110‑batch campaign (batch 1 ≈ 32.9 min, batch 110 ≈ 42.1 min). This is a steady, predictable rise, not a one‑off event.

**How the numbers are derived**  
The fitted exponential trend for batch index \(k\) (1…110) gives:
\[
t_{\text{to45}}(k) \;=\; 32.7764 + 10410.9\!\left(e^{8.1703 \times 10^{-6} \, k} - 1\right) \quad \text{min}
\]
with a validation mean absolute error of **±0.29 min** on held‑out batches. Plugging in \(k=15\) and \(k=95\) yields the 6.8 min difference; the linear model gives almost identical numbers but the exponential form is the best on validation.

The companion model for temperature at 20 min shows the same direction: \(T_{\text{@20}}\) rises from ≈ 55.8 °C at batch 1 to ≈ 60.7 °C at batch 110 (linear trend), meaning the reactor is warmer later in the cooling phase as fouling insulates.

**Most likely cause: progressive fouling of the cooling surfaces**  
The cooling surfaces (jacket or internal coils) are accumulating a foulant layer that adds thermal resistance. The measured behaviour matches the fouling framework’s pattern:
- The heat transfer coefficient \(U\) is falling batch‑over‑batch because the deposit thickens.
- The curve is *linear‑to‑slightly‑upward‑curving* — characteristic of deposition‑dominated fouling (crystallization or particulate) where removal is weak, or the early part of an asymptotic curve before auto‑retardation becomes strong.
- The deposit probably consists of product solids that precipitate as the temperature drops, polymerised residues (chemical reaction fouling), or salts if water is present (crystallization fouling). In all cases, the thermal conductivity of the fresh organic / salt layer is low (~0.2 W m⁻¹ K⁻¹), so even a thin layer sharply slows cooling.

**What to monitor to confirm**  
1. **Overall heat transfer coefficient (U)** – Track \(U\) for each batch using the reactor temperature profile and the coolant flow/temperature data. A monotonically declining \(U\) directly reveals deposit buildup.  
2. **Fouling resistance (\(R_f\))** – Calculate from \(1/U_{\text{current}} - 1/U_{\text{clean}}\); the trend will match the increase in cooling time.  
3. **Coolant‑side pressure drop** – If the coolant flows through a jacket, an increase in pressure drop indicates flow‑area restriction from scale on the water side.  
4. **Coolant outlet temperature** – As fouling worsens, the coolant extracts less heat, so its exit temperature will fall (for a fixed flow rate); this is a sensitive early indicator.

If any of these metrics plateau later in the campaign, then the auto‑retardation removal mechanism is starting to balance deposition; if they continue rising linearly, the deposit is hard and will eventually require mechanical cleaning or chemical descaling. The plant manager can use the exponential trend to forecast when the cooling time will exceed a process limit, and schedule cleaning before that point.