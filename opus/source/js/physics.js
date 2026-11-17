// CPU-only deterministic, front-wheel-drive physics (independent of WebGPU).
// World Y is up; motion lies in X/Z; positive heading turns +X toward +Z.
// Wheel order: front-left, front-right, rear-left, rear-right.
'use strict';

/**
 * Calibrated constants. SI units unless explicitly noted.
 * DT: seconds per simulation step; SUB: wheel-integration substeps.
 * Iz: yaw inertia (kg*m²); cgA/cgB: distance from center of mass to axles.
 * cgH: center-of-mass height (m); R: wheel radius (m); Iw: wheel inertia.
 * Numerical values are deliberately unchanged by this readability pass.
 */
const PHYS = {
  DT: 1 / 120, SUB: 4,
  mass: 845, Iz: 1150, g: 9.81,
  cgA: 0.944,                 // center of mass to front axle
  cgB: 1.416,                 // center of mass to rear axle
  cgH: 0.50,
  R: 0.292, Iw: 0.9,
  gears: [3.909, 2.157, 1.480, 1.121, 0.902], final: 4.071, revGear: 3.818,
  idle: 900, redline: 6300,
  brakeF: 1000, brakeR: 360, handbrake: 1700,
  maxSteer: 0.62,             // maximum wheel steering angle (radians)
  dragK: 0.40, roll: 0.013,
};

// Approximate tuned-engine torque (N·m), keyed by RPM.
function engineTorque(rpm) {
  const r = rpm / 1000;
  if (r < 1) return 70;
  if (r < 3.5) return 85 + (r - 1) * 15;
  if (r < 5.0) return 122;
  if (r < 6.3) return 122 - (r - 5) * 20;
  return 45;
}

/**
 * One vehicle's authoritative CPU-side state. The rest of the game reads it.
 * forwardVelocity, lateralVelocity: speeds in the car's own frame (m/s).
 * headingRadians, yawRate: orientation (rad) and rotation speed (rad/s).
 * trackDistance, trackLateralOffset: position relative to course centerline (m).
 */
class VehiclePhysics {
  constructor() {
    // Vehicle state: movement, powertrain, contact patches, and visual suspension.
    this.x = 0;
    this.z = 0;
    this.y = 0;
    this.headingRadians = 0;
    this.forwardVelocity = 0;
    this.lateralVelocity = 0;
    this.yawRate = 0;       // car-local forward/right speed and yaw rate
    this.wheelAngularVelocities = new Float64Array(4);             // wheel angular speed (front-left, front-right, rear-left, rear-right)
    this.wheelSpinAngles = new Float64Array(4);
    this.steeringAngle = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.steeringInput = 0;
    this.gear = 1;
    this.rpm = 900;
    this.reverse = false;
    this.gearShiftCooldown = 0;
    this.forwardAcceleration = 0;
    this.lateralAcceleration = 0;
    this.roll = 0;
    this.rollVelocity = 0;
    this.pitch = 0;
    this.pitchVelocity = 0;
    this.heave = 0;
    this.heaveVelocity = 0;
    this.roadPitch = 0;
    this.roadRoll = 0;
    this.trackSegmentHint = -1;
    this.trackDistance = 0;
    this.trackLateralOffset = 0;
    this.slip = new Float64Array(4);          // slip speed (m/s)
    this.normalizedTireSlip = new Float64Array(4);            // dimensionless tire slip (1 ≈ peak grip); audio reads this
    this.wheelNormalLoads = new Float64Array(4);
    this.wheelSurfaceTypes = new Uint8Array(4);            // 0 asphalt, 1 curb, 2 grass, 3 gravel
    this.wheelWetness = new Float64Array(4);
    this.wheelWorldX = new Float64Array(4);
    this.wheelWorldZ = new Float64Array(4);
    this.wheelWorldY = new Float64Array(4);
    this.onAsphalt = true;
    this.offTrackWheelCount = 0;
    this.wallImpactSpeed = 0;
    this.elapsedSeconds = 0;
    this._trackProjection = new Float64Array(3);
    this._trackSample = new Float64Array(6);
    this.wheelForwardForces = new Float64Array(4);
    this.wheelLateralForces = new Float64Array(4);
  }
  speed() { return Math.hypot(this.forwardVelocity, this.lateralVelocity); }
  /** Reset the car at longitudinal track distance s and signed lateral offset uOff (meters). */
  placeOnTrack(s, uOff) {
    const T = TRACK, o = this._trackProjection;
    const ts = this._trackSample;
    T.sampleS(s, ts);
    this.headingRadians = Math.atan2(ts[4], ts[3]);
    const rx = -ts[4], rz = ts[3];
    this.x = ts[0] + rx * uOff;
    this.z = ts[2] + rz * uOff;
    this.forwardVelocity = this.lateralVelocity = this.yawRate = 0;
    this.wheelAngularVelocities.fill(0);
    this.wheelSpinAngles.fill(0);
    this.slip.fill(0);
    this.normalizedTireSlip.fill(0);
    this.steeringAngle = 0;
    this.steeringInput = 0;
    this.throttle = this.brake = this.handbrake = 0;
    this.gear = 1;
    this.reverse = false;
    this.rpm = PHYS.idle;
    this.gearShiftCooldown = 0;
    this.forwardAcceleration = 0;
    this.lateralAcceleration = 0;
    this.roll = this.rollVelocity = this.pitch = this.pitchVelocity = this.heave = this.heaveVelocity = 0;
    this.wheelForwardForces.fill(0);
    this.wheelLateralForces.fill(0);
    this.wallImpactSpeed = 0;
    this.elapsedSeconds = 0;
    this.trackSegmentHint = -1;
    this.updateGround();
  }
  // Return ground height and record surface type/wetness for wheel k.
  groundAt(x, z, k) {
    const T = TRACK, o = this._trackProjection;
    T.project(x, z, this.trackSegmentHint, o);
    const s = o[0], u = o[1];
    const hw = T.lerpArr(T.hw, s);
    const au = Math.abs(u);
    const kw = u > 0 ? T.lerpArr(T.kerbR, s) : T.lerpArr(T.kerbL, s);
    let y, surf = 0;
    if (au <= hw + 0.3) { y = T.surfaceY(s, u); surf = 0; }
    else if (kw > 0 && au < hw + 0.3 + kw) { y = T.surfaceY(s, u); surf = 1; }
    else {
      y = TERRAIN.heightAt(x, z);
      const gw = u > 0 ? T.lerpArr(T.gravR, s) : T.lerpArr(T.gravL, s);
      const g0 = hw + kw + 1.6;
      surf = (gw > 1.5 && au > g0 && au < g0 + gw) ? 3 : 2;
    }
    if (k >= 0) { this.wheelSurfaceTypes[k] = surf;
    this.wheelWetness[k] = surf === 0 ? T.lerpArr(T.wet, s) : 0; }
    return y;
  }
  /** Locate the car and all wheels on the track/terrain; update ground alignment. */
  updateGround() {
    const c = Math.cos(this.headingRadians), sn = Math.sin(this.headingRadians);
    const T = TRACK, o = this._trackProjection;
    T.project(this.x, this.z, this.trackSegmentHint, o);
    this.trackSegmentHint = o[2];
    this.trackDistance = o[0];
    this.trackLateralOffset = o[1];
    let off = 0;
    for (let k = 0; k < 4; k++) {
      const a = k < 2 ? 1.18 : -1.18, b = (k & 1 ? 1 : -1) * (k < 2 ? 0.67 : 0.655);
      const x = this.x + c * a - sn * b, z = this.z + sn * a + c * b;
      this.wheelWorldX[k] = x;
      this.wheelWorldZ[k] = z;
      this.wheelWorldY[k] = this.groundAt(x, z, k);
      T.project(x, z, this.trackSegmentHint, o);
      if (Math.abs(o[1]) > T.lerpArr(T.hw, o[0]) + 0.3) off++;
    }
    this.offTrackWheelCount = off;
    this.onAsphalt = off === 0;
    // Fit ground pitch/roll from the four tire contact heights.
    const yf = (this.wheelWorldY[0] + this.wheelWorldY[1]) * 0.5, yr = (this.wheelWorldY[2] + this.wheelWorldY[3]) * 0.5;
    const yl = (this.wheelWorldY[0] + this.wheelWorldY[2]) * 0.5, yrr = (this.wheelWorldY[1] + this.wheelWorldY[3]) * 0.5;
    this.roadPitch = Math.atan2(yf - yr, 2.36);
    this.roadRoll = Math.atan2(yl - yrr, 1.33);
    this.y = (yf + yr) * 0.5;
  }
  // Controls can be digital booleans or analog steering/accelerator/brake.
  // With analog=true, controls.a = [steer -1..1, throttle 0..1, brake/reverse 0..1].
  // controls.stick selects the faster gamepad steering response.
  /**
   * Advance one deterministic physics step:
   * user input -> drivetrain -> wheel loads -> tire forces -> body motion.
   * The renderer has no influence on these calculations.
   * @param {object} controls Current keyboard/gamepad command state.
   * @param {number} deltaTimeSeconds Usually PHYS.DT (1/120 s).
   */
  step(controls, deltaTimeSeconds) {
    this.updateDriverControls(controls, deltaTimeSeconds);
    const driveTorqueNm = this.updatePowertrain(deltaTimeSeconds);
    this.updateWheelLoads();
    this.integrateVehicleDynamics(deltaTimeSeconds, driveTorqueNm);
  }

  /** Smooth steering and pedals and determine forward/reverse selection. */
  updateDriverControls(controls, deltaTimeSeconds) {
    const parameters = PHYS;
    const forwardSpeed = this.forwardVelocity;
    const usesAnalogInput = controls.analog === true;
    const analogControls = controls.a;
    const steeringTarget = usesAnalogInput ? analogControls[0] : (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
    const steeringResponseRate = usesAnalogInput && controls.stick ? 9.0 : steeringTarget === 0 ? 4.0 : (Math.sign(steeringTarget) !== Math.sign(this.steeringInput) && this.steeringInput !== 0 ? 6.0 : 2.6);
    this.steeringInput += clamp(steeringTarget - this.steeringInput, -steeringResponseRate * deltaTimeSeconds, steeringResponseRate * deltaTimeSeconds);
    // Reduce steering lock as speed increases, especially useful for keyboard input.
    const maxSteeringAtSpeed = parameters.maxSteer / (1 + Math.abs(forwardSpeed) * 0.045);
    this.steeringAngle = this.steeringInput * maxSteeringAtSpeed;
    let requestedThrottle = 0, requestedBrake = 0;
    const acceleratorControl = usesAnalogInput ? analogControls[1] : (controls.up ? 1 : 0), brakeControl = usesAnalogInput ? analogControls[2] : (controls.down ? 1 : 0);
    if (acceleratorControl > 0) { if (this.reverse && forwardSpeed < -0.5) requestedBrake = acceleratorControl; else { requestedThrottle = acceleratorControl; if (Math.abs(forwardSpeed) < 0.6) this.reverse = false; } }
    if (brakeControl > 0) {
      if (!this.reverse && forwardSpeed > 0.6) requestedBrake = brakeControl;
      else { this.reverse = true; requestedThrottle = brakeControl; }
    }
    if (!(acceleratorControl > 0) && !(brakeControl > 0) && this.reverse && forwardSpeed > 0.2) this.reverse = false;
    this.throttle += clamp(requestedThrottle - this.throttle, -8 * deltaTimeSeconds, 6 * deltaTimeSeconds);
    this.brake += clamp(requestedBrake - this.brake, -10 * deltaTimeSeconds, 7 * deltaTimeSeconds);
    this.handbrake += clamp((controls.hand ? 1 : 0) - this.handbrake, -10 * deltaTimeSeconds, 12 * deltaTimeSeconds);
  }

  /** Automatic shifting and engine power, returning drive-axle torque in N·m. */
  updatePowertrain(deltaTimeSeconds) {
    const parameters = PHYS;
    // Use driven-wheel RPM for engine speed, but car speed for gear changes (avoids wheel-lock downshifts).
    const drivenWheelRpm = Math.abs((this.wheelAngularVelocities[0] + this.wheelAngularVelocities[1]) * 0.5) * 60 / TAU;
    const vehicleWheelRpm = Math.abs(this.forwardVelocity) / parameters.R * 60 / TAU;
    this.gearShiftCooldown = Math.max(0, this.gearShiftCooldown - deltaTimeSeconds);
    if (!this.reverse && this.gearShiftCooldown === 0) {
      const predictedEngineRpm = vehicleWheelRpm * parameters.gears[this.gear - 1] * parameters.final;
      if (predictedEngineRpm > 6000 && this.gear < 5) { this.gear++;
      this.gearShiftCooldown = 0.22; }
      else if (this.gear > 1 && vehicleWheelRpm * parameters.gears[this.gear - 2] * parameters.final < 4300 && predictedEngineRpm < 2700) { this.gear--;
      this.gearShiftCooldown = 0.18; }
    }
    const transmissionRatio = this.reverse ? parameters.revGear : parameters.gears[this.gear - 1];
    this.rpm = Math.max(parameters.idle, Math.max(drivenWheelRpm, vehicleWheelRpm * 0.98) * transmissionRatio * parameters.final);
    if (this.reverse) this.gear = 1;
    const duringGearShift = this.gearShiftCooldown > 0.12;
    let engineTorqueNm = engineTorque(Math.min(this.rpm, parameters.redline)) * this.throttle * (duringGearShift ? 0.1 : 1);
    if (this.rpm >= parameters.redline) engineTorqueNm *= 0.2;
    const driveTorqueNm = engineTorqueNm * transmissionRatio * parameters.final * 0.9 * (this.reverse ? -1 : 1);
    return driveTorqueNm;
  }

  /** Normal force on each wheel after longitudinal and lateral load transfer. */
  updateWheelLoads() {
    const parameters = PHYS;
    const wheelbase = parameters.cgA + parameters.cgB, massKg = parameters.mass, gravity = parameters.g;
    const frontAxleLoad = massKg * gravity * parameters.cgB / wheelbase - massKg * this.forwardAcceleration * parameters.cgH / wheelbase;
    const rearAxleLoad = massKg * gravity * parameters.cgA / wheelbase + massKg * this.forwardAcceleration * parameters.cgH / wheelbase;
    const frontLoadTransfer = massKg * this.lateralAcceleration * parameters.cgH / 1.34 * 0.6, rearLoadTransfer = massKg * this.lateralAcceleration * parameters.cgH / 1.31 * 0.4;
    this.wheelNormalLoads[0] = Math.max(50, frontAxleLoad * 0.5 + frontLoadTransfer);
    this.wheelNormalLoads[1] = Math.max(50, frontAxleLoad * 0.5 - frontLoadTransfer);
    this.wheelNormalLoads[2] = Math.max(50, rearAxleLoad * 0.5 + rearLoadTransfer);
    this.wheelNormalLoads[3] = Math.max(50, rearAxleLoad * 0.5 - rearLoadTransfer);
  }

  /**
   * Calculate combined-slip tire forces and integrate the body and wheel motion.
   * Scratch typed arrays are reused to avoid allocations per frame.
   */
  integrateVehicleDynamics(deltaTimeSeconds, driveTorqueNm) {
    const parameters = PHYS;
    const massKg = parameters.mass;
    const gravity = parameters.g;
    const tireSubstepDuration = deltaTimeSeconds / parameters.SUB;
    let netForwardForce = 0, netLateralForce = 0, netYawTorque = 0;
    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) { this.wheelForwardForces[wheelIndex] = 0;
    this.wheelLateralForces[wheelIndex] = 0; }
    for (let substepIndex = 0; substepIndex < parameters.SUB; substepIndex++) {
      for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) {
        const isFrontWheel = wheelIndex < 2;
        const axleDistance = isFrontWheel ? parameters.cgA : -parameters.cgB;
        const wheelSideOffset = (wheelIndex & 1 ? 1 : -1) * (isFrontWheel ? 0.67 : 0.655);
        const wheelForwardSpeed = this.forwardVelocity - this.yawRate * wheelSideOffset, wheelSideSpeed = this.lateralVelocity + this.yawRate * axleDistance;
        const wheelSteeringAngle = isFrontWheel ? this.steeringAngle * (1 + (wheelIndex & 1 ? -1 : 1) * this.steeringAngle * 0.12) : 0;
        const steeringCosine = Math.cos(wheelSteeringAngle), steeringSine = Math.sin(wheelSteeringAngle);
        const tireForwardSpeed = wheelForwardSpeed * steeringCosine + wheelSideSpeed * steeringSine, tireSideSpeed = -wheelForwardSpeed * steeringSine + wheelSideSpeed * steeringCosine;
        // Grip depends on road surface and wetness.
        const surfaceType = this.wheelSurfaceTypes[wheelIndex];
        let surfaceGrip = surfaceType === 0 ? 1.0 - this.wheelWetness[wheelIndex] * 0.22 : surfaceType === 1 ? 0.9 : surfaceType === 2 ? 0.6 : 0.52;
        const wheelLoad = this.wheelNormalLoads[wheelIndex];
        const wheelContactSpeed = this.wheelAngularVelocities[wheelIndex] * parameters.R;
        const slipDenominator = Math.max(Math.abs(tireForwardSpeed), 1.0);
        const longitudinalSlip = (wheelContactSpeed - tireForwardSpeed) / slipDenominator;
        const lateralSlipAngle = Math.atan2(tireSideSpeed, Math.max(Math.abs(tireForwardSpeed), 0.8));
        const longitudinalSlipScaled = longitudinalSlip / 0.11, lateralSlipScaled = Math.tan(lateralSlipAngle) / 0.13;
        const combinedSlip = Math.hypot(longitudinalSlipScaled, lateralSlipScaled);
        let tireGripForce = 0;
        if (combinedSlip > 1e-6) {
          // Normalized Magic Formula-like grip curve: peak near slip=1, declining after sliding.
          const magicB = 1.35, magicC = 1.65, magicE = 0.2;
          const magicInput = magicB * combinedSlip;
          const peakGrip = Math.sin(magicC * Math.atan(magicB - magicE * (magicB - Math.atan(magicB))));
          tireGripForce = surfaceGrip * wheelLoad * Math.sin(magicC * Math.atan(magicInput - magicE * (magicInput - Math.atan(magicInput)))) / peakGrip;
        }
        let tireForwardForce = combinedSlip > 1e-6 ? tireGripForce * longitudinalSlipScaled / combinedSlip : 0;
        let tireSideForce = combinedSlip > 1e-6 ? -tireGripForce * lateralSlipScaled / combinedSlip : 0;
        // Dampen low-speed lateral tire oscillation.
        const nearStopBlend = clamp(1 - Math.abs(tireForwardSpeed) / 1.5, 0, 1);
        tireSideForce = lerp(tireSideForce, -tireSideSpeed * wheelLoad * 0.35, nearStopBlend * 0.7);
        // Rolling resistance increases on grass and gravel.
        const rollingResistanceForce = (surfaceType >= 2 ? (surfaceType === 3 ? 0.11 : 0.045) : parameters.roll) * wheelLoad * Math.sign(tireForwardSpeed) * Math.min(Math.abs(tireForwardSpeed), 1);
        // Integrate the wheel's angular speed.
        let wheelDriveTorque = 0;
        if (isFrontWheel) wheelDriveTorque += driveTorqueNm * 0.5;
        const wheelBrakeTorque = (isFrontWheel ? parameters.brakeF : parameters.brakeR) * this.brake + (isFrontWheel ? 0 : parameters.handbrake * this.handbrake);
        const unbrakedWheelSpeed = this.wheelAngularVelocities[wheelIndex] + (wheelDriveTorque - tireForwardForce * parameters.R) / parameters.Iw * tireSubstepDuration;
        // Braking opposes rotation but never reverses the wheel in one substep.
        const brakeAngularDelta = wheelBrakeTorque / parameters.Iw * tireSubstepDuration;
        if (Math.abs(unbrakedWheelSpeed) <= brakeAngularDelta) this.wheelAngularVelocities[wheelIndex] = 0; else this.wheelAngularVelocities[wheelIndex] = unbrakedWheelSpeed - Math.sign(unbrakedWheelSpeed) * brakeAngularDelta;
        // Rotate tire forces into the car's local forward/right coordinates.
        const forwardTireForce = (tireForwardForce - rollingResistanceForce) * steeringCosine - tireSideForce * steeringSine, sideTireForce = (tireForwardForce - rollingResistanceForce) * steeringSine + tireSideForce * steeringCosine;
        this.wheelForwardForces[wheelIndex] += forwardTireForce / parameters.SUB;
        this.wheelLateralForces[wheelIndex] += sideTireForce / parameters.SUB;
        this.slip[wheelIndex] = Math.hypot(wheelContactSpeed - tireForwardSpeed, tireSideSpeed);
        this.normalizedTireSlip[wheelIndex] = combinedSlip;
      }
    }
    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) {
      const isFrontWheel = wheelIndex < 2;
      const axleDistance = isFrontWheel ? parameters.cgA : -parameters.cgB, wheelSideOffset = (wheelIndex & 1 ? 1 : -1) * (isFrontWheel ? 0.67 : 0.655);
      netForwardForce += this.wheelForwardForces[wheelIndex]; netLateralForce += this.wheelLateralForces[wheelIndex];
      netYawTorque += axleDistance * this.wheelLateralForces[wheelIndex] - wheelSideOffset * this.wheelForwardForces[wheelIndex];
    }
    // Aerodynamic drag and downhill/uphill gravity component.
    const totalSpeed = Math.hypot(this.forwardVelocity, this.lateralVelocity);
    netForwardForce -= parameters.dragK * this.forwardVelocity * totalSpeed; netLateralForce -= parameters.dragK * this.lateralVelocity * totalSpeed * 1.5;
    netForwardForce -= massKg * gravity * Math.sin(this.roadPitch);
    netLateralForce += massKg * gravity * Math.sin(this.roadRoll) * 0.0;
    // Integrate in the rotating car-local coordinate frame.
    const forwardAcceleration = netForwardForce / massKg, sideAcceleration = netLateralForce / massKg;
    this.forwardVelocity += (forwardAcceleration + this.yawRate * this.lateralVelocity) * deltaTimeSeconds;
    this.lateralVelocity += (sideAcceleration - this.yawRate * this.forwardVelocity) * deltaTimeSeconds;
    this.yawRate += netYawTorque / parameters.Iz * deltaTimeSeconds;
    this.forwardAcceleration = lerp(this.forwardAcceleration, forwardAcceleration, 0.25);
    this.lateralAcceleration = lerp(this.lateralAcceleration, sideAcceleration + this.yawRate * this.forwardVelocity * 0, 0.25);
    this.lateralAcceleration = lerp(this.lateralAcceleration, sideAcceleration, 0.0);
    const headingCosine = Math.cos(this.headingRadians), headingSine = Math.sin(this.headingRadians);
    this.x += (headingCosine * this.forwardVelocity - headingSine * this.lateralVelocity) * deltaTimeSeconds;
    this.z += (headingSine * this.forwardVelocity + headingCosine * this.lateralVelocity) * deltaTimeSeconds;
    this.headingRadians += this.yawRate * deltaTimeSeconds;
    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) this.wheelSpinAngles[wheelIndex] = (this.wheelSpinAngles[wheelIndex] + this.wheelAngularVelocities[wheelIndex] * deltaTimeSeconds) % TAU;
    this.updateGround();
    this.collide();
    // Spring-damper approximation for visual roll, pitch, and heave.
    const sideAccelerationForBody = sideAcceleration, forwardAccelerationForBody = forwardAcceleration;
    const targetBodyRoll = -sideAccelerationForBody * 0.0125, targetBodyPitch = forwardAccelerationForBody * 0.0058;
    this.rollVelocity += ((targetBodyRoll - this.roll) * 90 - this.rollVelocity * 11) * deltaTimeSeconds;
    this.roll += this.rollVelocity * deltaTimeSeconds;
    this.pitchVelocity += ((targetBodyPitch - this.pitch) * 110 - this.pitchVelocity * 13) * deltaTimeSeconds;
    this.pitch += this.pitchVelocity * deltaTimeSeconds;
    this.heaveVelocity += ((0 - this.heave) * 160 - this.heaveVelocity * 16) * deltaTimeSeconds;
    this.heave += this.heaveVelocity * deltaTimeSeconds;
    this.elapsedSeconds += deltaTimeSeconds;
  }
  // Collision: check each car corner against trackside barriers.
  /** Resolve barrier penetration, bounce and frictional impact impulses. */
  collide() {
    const T = TRACK, o = this._trackProjection;
    const c = Math.cos(this.headingRadians), sn = Math.sin(this.headingRadians);
    this.wallImpactSpeed = 0;
    for (let k = 0; k < 4; k++) {
      const a = k < 2 ? 1.85 : -1.83, b = (k & 1 ? 1 : -1) * 0.78;
      const x = this.x + c * a - sn * b, z = this.z + sn * a + c * b;
      T.project(x, z, this.trackSegmentHint, o);
      const s = o[0], u = o[1];
      const wall = (u > 0 ? T.lerpArr(T.wallR, s) : T.lerpArr(T.wallL, s)) - 0.35;
      const pen = Math.abs(u) - wall;
      if (pen > 0) {
        // Inward-facing wall contact normal.
        const i = o[2] | 0;
        const rx = -T.tz[i], rz = T.tx[i];
        const nx = -Math.sign(u) * rx, nz = -Math.sign(u) * rz;
        this.x += nx * pen;
        this.z += nz * pen;
        // Velocity of the contact point in world coordinates.
        const vxw = c * this.forwardVelocity - sn * this.lateralVelocity, vzw = sn * this.forwardVelocity + c * this.lateralVelocity;
        const rxp = x - this.x, rzp = z - this.z;
        // Add angular velocity cross contact-offset in the X/Z plane.
        const pvx = vxw - this.yawRate * rzp, pvz = vzw + this.yawRate * rxp;
        const vn = pvx * nx + pvz * nz;
        if (vn < 0) {
          const rn = rxp * nz - rzp * nx;
          const j = -(1.25) * vn / (1 / PHYS.mass + rn * rn / PHYS.Iz);
          let ix = j * nx, iz = j * nz;
          // Tangential wall friction impulse.
          const tx = -nz, tz = nx, vt = pvx * tx + pvz * tz;
          const jt = clamp(-vt / (1 / PHYS.mass + 1 / PHYS.Iz), -0.4 * j, 0.4 * j);
          ix += jt * tx; iz += jt * tz;
          const dvx = ix / PHYS.mass, dvz = iz / PHYS.mass;
          // Convert collision impulse back to car-local velocity.
          this.forwardVelocity += c * dvx + sn * dvz;
          this.lateralVelocity += -sn * dvx + c * dvz;
          this.yawRate += (rxp * iz - rzp * ix) / PHYS.Iz;
          this.wallImpactSpeed = Math.max(this.wallImpactSpeed, -vn);
        }
      }
    }
  }
}
