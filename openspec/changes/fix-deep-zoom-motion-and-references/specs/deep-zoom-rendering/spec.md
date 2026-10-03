## ADDED Requirements

### Requirement: Reference jobs survive continuous input

The app SHALL NOT replace an in-flight reference job while the user is moving if the job has the same formula and at least the render budget. When settled, the app SHALL keep the job if its worst-case result can draw the current view.

#### Scenario: Wheel burst with an unusable reference

- **WHEN** a reference job is in flight and further wheel events change the view
- **THEN** no reference job is cancelled until input stops, and a new job starts only after the pending one completes and cannot draw the view

#### Scenario: Settled far from the pending view

- **WHEN** input stops and the pending job's worst-case reference lies more than 2.5 view radii from the current center
- **THEN** the app starts a job for the current view

### Requirement: Repairs finish during motion

While moving, the app SHALL NOT start deep renders when a repair for a compatible view is pending. A finished repair for an older compatible view SHALL become the held frame, and the current view SHALL still be rendered.

#### Scenario: Julia zoom with invalid pixels

- **WHEN** the user keeps zooming while a repair runs
- **THEN** the repair is not cancelled, its frame is published when it finishes, and at least one new deep frame appears before input stops

### Requirement: References cover the budget and runoff

Reference orbits SHALL request `REFERENCE_ORBIT_RUNOFF` samples beyond the quantized iteration budget. Center-seeded formulas SHALL accept a reference only if it covers the budget plus runoff; otherwise the sampling search SHALL run and the longer orbit SHALL be kept.

#### Scenario: Iteration cap

- **WHEN** the zoom is 200
- **THEN** `getReferenceIterationCount` returns at least 65570

#### Scenario: Budget equal to the old reference length

- **WHEN** a Julia view's budget equals the old reference length
- **THEN** no pixel is invalid because the reference runs out

#### Scenario: Short Newton orbit

- **WHEN** Newton's orbit escapes before the required length
- **THEN** the sampling search runs and the longer of the two orbits is used

### Requirement: Julia cycles are repeated exactly

A converged Julia periodic point SHALL be repeated to fill the reference. Pixels computed from it SHALL match direct MPFR orbits within existing tolerances.

#### Scenario: Basilica α at radius 1e-40

- **WHEN** Newton converges to the α fixed point
- **THEN** the reference covers the full target length, and sampled pixels agree with direct MPFR iteration

### Requirement: Deep fallback is cheap and honest

Without a usable deep frame, the app SHALL show an inside-colour placeholder beyond float32 resolution, and otherwise a standard render recomputed only when its inputs change. A held frame SHALL require a preview transform, and reset SHALL clear it.

#### Scenario: Reset then deep zoom

- **WHEN** the user resets and returns to deep zoom before a reference is ready
- **THEN** the old location is not drawn

### Requirement: Rendering recovers and failures are not retried every frame

The render loop SHALL schedule the next frame even if a frame throws, and SHALL report a repeated error once. A failed reference or repair SHALL NOT be retried until its target view changes. Invalid metrics SHALL include negative coverage and any non-finite component, everywhere they are checked.

#### Scenario: Readback error

- **WHEN** a frame throws
- **THEN** the next frame is still scheduled
