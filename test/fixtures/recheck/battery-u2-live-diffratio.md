Between cycle 1 and 110, the measured discharge records reveal several concrete changes *beyond* the 22 % capacity loss (1.856 → 1.449 Ah).  An engineer inspecting the raw voltage vs. time trace would see:

* **Lower terminal voltage under load at fixed elapsed times**  
  – At 1000 s into discharge, **v_at_1000s** drops from **3.663 V** (cycle 1) to **3.566 V** (cycle 110), a loss of **97 mV**.  
  – At 1800 s, **v_at_1800s** drops from **3.529 V** to **3.416 V**, a loss of **113 mV**.  
  These shifts are well beyond the held‑out validation noise floor of the best‑fit models (~0.01 V), so they are real physical effects.

* **Steeper voltage slope in the later part of the discharge**  
  The difference v(1000 s) – v(1800 s) grows from **0.134 V** (cycle 1) to **0.151 V** (cycle 110), i.e., the local voltage decay rate between those time marks increases by about **13 %**.  Because the cell’s capacity has shrunk, those same absolute times correspond to deeper states of discharge at cycle 110, where the natural OCV curve is steeper; nevertheless, part of the extra slope comes from rising internal resistance.

* **Proportionally shorter discharge duration**  
  The time to reach the 2.7 V cutoff (**t_cutoff_s**) falls from **3335 s** to **2599 s**.  Since the load is constant **2.0 A**, this directly mirrors the capacity loss: t_cutoff / capacity_ah stays essentially constant (≈ 1795 s/Ah), showing that the shape of the voltage‑time curve scales with the lost capacity without gross distortion.

* **Earlier onset of the low‑voltage “knee”**  
  At cycle 110 the **1800 s** point already lies at **~31 % SOC** (vs. 46 % at cycle 1), so the rapid voltage drop that precedes cutoff arrives earlier in the discharge — a signature of both increased impedance and a shrinking useable capacity window.

**What the voltage‑curve changes say about dominant aging mechanisms**

The combination of a perfectly linear trend in capacity fade (the linear model has a validation MAE of only **0.032 Ah** over cycles 89‑110) and the gradual, monotonic increase in overpotential (lower voltages at fixed times) points to **loss of lithium inventory (LLI)** as the primary aging driver — most likely through continuous growth of the solid‑electrolyte interphase (SEI) on the anode.  SEI thickening:

* consumes cyclable lithium, directly reducing capacity,
* adds to the cell’s ohmic and diffusion resistances, which depresses the discharge voltage under load, and
* raises the internal heat generation (the recorded peak cell temperature rises from **~39 °C** to **41 °C** over the test), which in turn accelerates further side reactions.

The absence of a sudden inflection in the capacity trend and the stable proportionality between cutoff time and capacity argue against an abrupt loss of active material or internal shorting; the aging is dominated by a steady, cycle‑by‑cycle consumption of lithium that shows up as a broadly parallel downward shift and slight steepening of the whole discharge curve.