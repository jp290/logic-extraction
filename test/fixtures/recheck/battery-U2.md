Between cycle 1 and cycle 110, the discharge behaviour changed in three clear ways that an engineer would read directly from the voltage‑time trace, not just from the total capacity.

### What an engineer would see in the voltage curves

| Feature | Cycle 1 (measured) | Cycle 110 (measured) | Change |
|---------|-------------------|---------------------|--------|
| **Capacity (Ah)** | 1.856 5 | 1.449 0 | −22 % |
| **Discharge duration (s)** | 3 335 | 2 599 | −22 % |
| **Voltage at 1 000 s (V)** | 3.663 4 | 3.566 3 | −0.097 1 V |
| **Voltage at 1 800 s (V)** | 3.529 4 | 3.415 7 | −0.113 7 V |
| **ΔV/(Δtime) between 1 000 s and 1 800 s (mV s⁻¹)** | 0.167 5 | 0.188 3 | steeper slope |

At the same 2 A discharge, the whole voltage curve is shifted **downward**, and the end‑of‑discharge is reached **earlier** in proportionate step with the capacity loss.  
Because the capacity delivered in the first 1 000 s is nearly identical (≈0.556 Ah → about 70 % of the initial SoC at both cycle 1 and cycle 110), the lower voltage at that time point is **not** due to a different state of charge – it’s a direct indicator of **higher internal overpotential**.  
The slightly steeper slope during the voltage plateau (≈ 0.188 mV s⁻¹ instead of 0.167 5 mV s⁻¹) further suggests that the cell’s effective impedance has grown, making the voltage fall away more quickly under load.

### What these changes tell about the dominant aging mechanisms

1. **Loss of cyclable lithium – linear fade**  
   The capacity and discharge time both track a strong linear trend over 110 cycles (the linear model held out best for `capacity_ah` and `t_cutoff_s`, with validation MAE ~0.032 Ah and ~56 s). This steady, proportional loss is the hallmark of **continuous SEI (solid‑electrolyte interphase) growth** on the anode, which irreversibly consumes lithium and steadily reduces the inventory of charge‑carriers.

2. **Impedance rise – square‑root‑of‑time kinetics**  
   For the voltages under load (`v_at_1000s`, `v_at_1800s`), the lowest held‑out error came from a `sqrt_linear` model (e.g. `v_at_1000s` = 3.6332 – 0.002959·k + 0.02351·√k, validation MAE ~0.010 V). The positive √k term means the voltage decays quickly at first and then decelerates – a classic signature of **diffusion‑limited SEI thickening**. As the SEI film grows, its resistance increases with √(time), which matches the observed pattern of fast initial drop in loaded voltage that gradually levels off.

3. **No sign of sudden failure modes**  
   There are no abrupt capacity collapses, no “knee” points in the fade curve, and the discharge time never deviates sharply from the linear‑minus‑capacity trend. Small temporary recoveries (e.g. +0.045 Ah at cycle 20, +0.087 Ah at cycle 90) likely come from partial SEI dissolution/re‑organization, not from a different dominant mechanism. This absence of jumps rules out significant lithium plating (which would cause sudden voltage anomalies) or catastrophic cathode particle cracking under this gentle cycling regime.

**In short:** the dominant aging mechanism is **anode‑side SEI growth**, which simultaneously reduces the cyclable lithium supply (causing linear capacity loss) and increases the cell’s internal resistance (causing the loaded voltage to sag with diffusion‑limited kinetics). The engineer would see a discharge curve that is both shorter and lower, with the voltage plateau at a fixed time point dropping ~0.1 V after 110 cycles and the slope of that plateau steepening slightly – all consistent with a thickening, impedance‑raising film that consumes lithium at a steady rate.