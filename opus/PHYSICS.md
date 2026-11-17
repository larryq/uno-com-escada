# Understanding the Fiat Uno physics

Source: [`source/js/physics.js`](source/js/physics.js). This explanation describes the **Opus** version, not Fable.

## What kind of simulation is it?

This is a custom **planar four-wheel vehicle model** running at a fixed **120 steps per second** (`PHYS.DT = 1/120`). The car moves and rotates across the horizontal X/Z plane. It calculates wheel slip, tire force, weight transfer, engine torque, braking, and wall contacts. Height, road slope and the car's visible body rocking are handled separately.

It is **not** a general 3D rigid-body engine, and there is no suspension solver with spring forces acting on a 3D chassis. The separate visual suspension is an approximation that looks convincing while avoiding the complexity of full 3D vehicle dynamics.

## Coordinate system and variable names

World X/Z are horizontal; Y is up. The Fiat's forward axis points in the direction `headingRadians`. Its **local** axes are forward and right.

| State | Meaning |
| --- | --- |
| `x`, `y`, `z` | Car's world-space position in meters |
| `headingRadians` | Heading in the ground plane; 0 points along +X |
| `forwardVelocity` | Speed along the car's forward axis (m/s) |
| `lateralVelocity` | Speed to the car's right (m/s); this matters in a slide |
| `yawRate` | Rate of turning around the up axis (radians/s) |
| `steeringAngle` | Front-wheel steering angle in radians |
| `wheelAngularVelocities[4]` | Angular speeds of the four tires (rad/s) |
| `wheelNormalLoads[4]` | Vertical load on each tire (newtons) |
| `normalizedTireSlip[4]` | Combined normalized slip; ~1 near the grip peak |
| `trackDistance` | Distance along the track's centerline (m) |
| `trackLateralOffset` | Signed sideways distance from that centerline (m) |
| `roadPitch`, `roadRoll` | Local track/terrain tilt inferred from wheel contact heights |

Wheel order is front-left, front-right, rear-left, rear-right (indices 0..3).

### Local versus world velocity

The car has an orientation, so local `forwardVelocity` and `lateralVelocity` are **not** directly added to its X and Z coordinates. With heading ψ:

```text
worldXVelocity = cos(ψ) * forwardVelocity - sin(ψ) * lateralVelocity
worldZVelocity = sin(ψ) * forwardVelocity + cos(ψ) * lateralVelocity
```

This matters when the car is sideways: a sideways skid can move it across the track even when its front points in a different direction.

## What happens in each step?

```js
step(controls, deltaTimeSeconds) {
  this.updateDriverControls(controls, deltaTimeSeconds);
  const driveTorqueNm = this.updatePowertrain(deltaTimeSeconds);
  this.updateWheelLoads();
  this.integrateVehicleDynamics(deltaTimeSeconds, driveTorqueNm);
}
```

### 1. Driver inputs

Keyboard or gamepad input is converted into steering, throttle, brake and handbrake values. Steering and pedals have response filters instead of changing instantaneously. The steering limit decreases with road speed, making the keyboard easier to drive. Pressing backward while moving forward brakes first; reverse engages once slow enough.

### 2. Engine and automatic gearbox

`engineTorque(rpm)` is a piecewise approximation of a tuned Fiat engine torque curve. The code derives engine RPM from the driven wheels and car speed, selects forward gears or reverse, briefly cuts torque during a shift, then applies the current gear ratio and final-drive ratio.

The car is **front-wheel drive**: drive torque is split between the two front wheels, not the rears.

### 3. Normal load and weight transfer

The engine doesn't just push a point mass; each tire gets its own ground load. Front and rear axle load change with longitudinal acceleration and center-of-mass height; left/right load changes with lateral acceleration.

For intuition: braking transfers load toward the front, while cornering loads one side more. The implementation uses acceleration from the previous step, a simple stable approximation.

### 4. Tire grip and slipping

For each wheel, the simulation calculates the velocity at that wheel's contact patch from the body velocity plus `yawRate`.

The wheel's rotational surface speed is `wheelAngularVelocity * wheelRadius`. The **longitudinal slip ratio** compares that to ground-forward speed:

```text
longitudinalSlip =
  (wheelSurfaceSpeed - tireForwardSpeed) /
  max(abs(tireForwardSpeed), 1.0)
```

The lateral slip angle comes from the sideways and forward velocities. Longitudinal and lateral slip are normalized and combined. A Magic-Formula-like nonlinear curve converts this combined slip into a **finite available grip force**. That force is divided into driving/braking and cornering components, and scaled by tire load, surface type and wetness.

A tire can therefore lose cornering grip when using too much of its grip for braking or acceleration. Grass, gravel and wet asphalt change grip, and grass/gravel increase rolling resistance.

The code integrates wheel angular speed in **four substeps per physics step** (`PHYS.SUB = 4`). Braking torque opposes rotation without immediately reversing the wheel.

### 5. Body motion and collisions

Add the tire forces and wheel lever-arm yaw moments:

```text
forwardAcceleration = netForwardForce / mass
sideAcceleration    = netLateralForce / mass
yawAcceleration     = netYawTorque / yawInertia
```

The code integrates body-local velocity, yaw rate, heading, and world position. After moving, `updateGround()` projects the car and all four wheels onto the track/terrain.

`collide()` checks the four vehicle corners against trackside barrier offsets. An impact pushes the body out of penetration and applies a bounce/friction impulse to velocity and yaw rate.

### 6. Body animation

Finally, spring-damper-style filters update `roll`, `pitch` and `heave` to make the visible car lean, dive and bounce. These are visual degrees of freedom. They do **not** feed a full suspension-force solver.

## Geometry is separate from physics

`TRACK.sampleS(distance, out)` returns the track position/tangent at a given centerline distance. `TRACK.project(x, z, hint, out)` finds the track coordinate closest to a world point; `TRACK.surfaceY` and `TERRAIN.heightAt` provide ground height. This allows the car to drive over a procedurally generated course without a triangle-mesh collision engine.

## Tests and limitations

The dependency-free test `source/tests/physics-regression.mjs` runs pre-recorded input sequences on a synthetic flat track and checks that key physics values still match the initial implementation. Run it with:

```bash
node opus/source/tests/physics-regression.mjs
```

This is a regression guard, **not** a claim of real-world handling fidelity. The code uses empirical tire parameters, simplified weight transfer and a 2D collision approximation. Testing the full course, rendering and frame rate still requires a browser.
