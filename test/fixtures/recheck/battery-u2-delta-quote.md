Let’s pull the concrete numbers first, because they make the aging signature unambiguous. The cell is discharged galvanostatically at 2.0 A every cycle, so time on discharge corresponds directly to capacity removed. The voltage after exactly 1 Ah discharged (at t = 1800 s) is a particularly clean comparator—it holds coulombic throughput constant while the cell’s total capacity shrinks.

Using the **sqrt‑linear trend models** fitted to the first 88 cycles and validated on the last 22 (the best models by held‑out error):

| Cycle | v_at_1000s (V) | v_at_1800s (V) | t_cutoff (s) | capacity (Ah) | temp_max (°C) |
|-------|----------------|----------------|--------------|---------------|---------------|
| 1     | 3.663 (meas)  | 3.529 (meas)  | 3335         | 1.856         | 38.98         |
| 110   | 3.566 (meas)  | 3.416 (meas)  | 2599         | 1.449         | 41.20         |
| **Δ** | **−0.097 V**  | **−0.113 V**  | **−736 s**   | **−0.407 Ah**| **+2.22 °C**  |

(For the statistically‑inclined: the sqrt‑linear model predicts Δv_at_1800s ≈ −0.107 V, fitting MAE ≈ 4 mV, validation MAE ≈ 6.6 mV.)

## What an engineer would see on the oscilloscope / data log

### 1. The whole discharge curve sags downward, even at fixed discharged capacity
Because the 1800 s point always corresponds to **1.0 Ah removed**, the 0.113 V drop there cannot be explained by the cell having less total capacity. It is a genuine increase in the voltage lost at the same coulombic state. Under a constant 2 A load, that translates to an **≈ 57 mΩ rise** in the effective DC resistance referenced to that operating point (ΔV / I = 0.113 V / 2 A). The same direction and similar magnitude show up at 1000 s, confirming the shift is not a fluke at one depth.

### 2. The discharge ends earlier, and the “knee” moves left
Capacity fades from 1.856 Ah to 1.449 Ah; the time to hit the 2.7 V cutoff drops by over 12 minutes at 2 A. Early in life the voltage near the cutoff was dropping steeply because the electrode was running out of lithium in the solid phase. Now that steep drop‑off happens at a smaller discharged capacity, meaning the cell reaches the voltage floor sooner. An engineer watching the live trace would see the voltage trace shift leftward **and** downward.

### 3. The thermal signature intensifies
Ambient is 24 °C; the max surface temperature rises from 39 °C to 41 °C—roughly an 11 % increase in the temperature rise above ambient. Joule heating (I² R) with a fixed current grows linearly with R, so the modest but monotonic temperature creep is consistent with higher ohmic resistance.

## Interpreting the dominant aging mechanism

The hallmark here is **internal resistance increase with relatively little change in the OCV‑SoC relationship**. If the cell had primarily lost active material (LAM), we would expect the full OCV curve to compress along the capacity axis, but the voltage at a given discharged capacity would stay roughly the same—new OCV at that capacity would be similar, just reached earlier. Instead, we see the voltage under load falling substantially at the same coulombic throughput. This points to **loss of lithium inventory (LLI)** as the lead actor, manifesting as:

- **SEI growth and film resistance increase** on the negative electrode, which directly raises the ohmic term (R o,T in the BattX equivalent circuit). The Arrhenius‑coupled resistance parameters (Θ Ro, κ₂) would have drifted upward.
- Possible **increase in electrolyte‑phase resistance** (R e in sub‑circuit B), though without electrolyte diffusivity data we cannot separate bulk resistance from film resistance. Both give the same voltage‑sag symptom.
- The voltage shift is too large and too current‑proportional to be solely a diffusion limitation (sub‑circuit A); a pure diffusion change would alter the curve shape more than the uniform offset, and would show more voltage recovery when the current is removed—data this pack does not contain.

From a BattX viewpoint, the identification Steps 2–5 would now need rerunning: Θ Ro has clearly aged, the heat generation parameters (Θ Th) have shifted because Q rises with R o,T, and Θ s may have shifted slightly if the SEI growth has changed tortuosity or effective solid‑phase diffusivity. However, the fact that the voltage sag is roughly proportional to current and not strongly time‑dependent within the discharge suggests that **ohmic resistance degradation dominates**, which is consistent with LLI driven by side reactions on the anode.

In short, beyond the 22 % capacity loss, the cell has become a significantly **higher‑resistance** device—the voltage trace an engineer would see is lower at every comparable point, the knee is earlier, and the cell runs hotter. That aging signature is classic for lithium inventory loss, with SEI growth as the primary candidate.