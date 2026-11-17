/**
 * Dependency-free, deterministic physics regression test.
 *
 * Captured from the original Opus implementation on 2026-11-17, before field
 * renaming and step-method extraction. Uses a flat track stub deliberately:
 * no WebGPU/browser needed, and vehicle behavior is tested in isolation.
 *
 * Usage: node opus/source/tests/physics-regression.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const physicsSource = readFileSync(new URL('../js/physics.js', import.meta.url), 'utf8');
const track = {
  hw: 1, kerbL: 0, kerbR: 0, gravL: 0, gravR: 0, wallL: 999,
  wallR: 999, wet: 0, tx: [1], tz: [0],
  sampleS(distance, out) {
    out[0] = distance; out[1] = 0; out[2] = 0; out[3] = 1; out[4] = 0;
  },
  project(x, z, hint, out) {
    out[0] = x; out[1] = z; out[2] = 0;
  },
  lerpArr(value) { return value; },
  surfaceY() { return 0; },
};
const context = {
  TAU: Math.PI * 2,
  clamp: (value, low, high) => Math.max(low, Math.min(high, value)),
  lerp: (from, to, t) => from + (to - from) * t,
  TRACK: track,
  TERRAIN: { heightAt: () => 0 },
};
vm.runInNewContext(
  physicsSource + '\n globalThis.VehicleForTest = VehiclePhysics; globalThis.physicsForTest = PHYS;',
  context,
  { filename: 'physics.js' }
);

const inspected = [
  'x', 'z', 'forwardVelocity', 'lateralVelocity', 'yawRate',
  'headingRadians', 'gear', 'rpm', 'elapsedSeconds',
];
const tests = [
  {
    name: 'accelerate, turn, accelerate, brake, coast',
    frames: 720,
    input: frame => frame < 240 ? { up: true } :
      frame < 360 ? { up: true, right: true } :
      frame < 480 ? { up: true } :
      frame < 600 ? { down: true } : {},
    expected: [
      [1.26723, 0, 2.62217, 0, 0, 0, 1, 6300.88992, 1],
      [5.33346, 0, 5.54461, 0, 0, 0, 1, 5844.61494, 2],
      [11.48993, 1.47506, 6.59541, 0.89705, 0.77655, 0.44761, 1, 6717.48371, 3],
      [17.26873, 5.96345, 8.09074, 0.00026, 0.00023, 0.66777, 1, 6804.87122, 4],
      [22.13853, 9.80218, 4.06177, 0.09664, -0.01781, 0.64548, 1, 2089.87737, 5],
      [24.84799, 11.84613, 3.15507, 0, 0, 0.64165, 1, 1649.93208, 6],
    ],
  },
  {
    name: 'analog steering/throttle, braking with handbrake',
    frames: 600,
    input: frame => ({
      analog: true, stick: true,
      a: [frame < 180 ? 0.2 : 0, frame < 300 ? 0.7 : 0, frame >= 300 && frame < 480 ? 0.8 : 0],
      hand: frame >= 300 && frame < 400,
    }),
    expected: [
      [1.208261, 0.12354, 2.66092, 0.174972, 0.127655, 0.061538, 1, 1417.012077, 1],
      [5.540876, 0.860138, 5.678738, 0.000941, 0.003837, 0.167282, 1, 6225.454206, 2],
      [11.114314, 1.827325, 3.702572, 0.399076, -0.391431, 0.072438, 1, 1915.487228, 3],
      [12.132651, 2.206631, -0.87956, 0.001533, -0.000042, -0.310532, 1, 900, 4],
      [11.318692, 2.468208, -0.696521, 0, 0, -0.311009, 1, 900, 5],
    ],
  },
  {
    name: 'reverse, brake forward, and turn',
    frames: 600,
    input: frame => ({
      down: frame < 240,
      up: frame >= 240 && frame < 480,
      right: frame >= 360 && frame < 480,
    }),
    expected: [
      [-1.687682, 0, -3.913416, 0, 0, 0, 1, 2049.184209, 1],
      [-8.627307, 0, -10.06215, 0, 0, 0, 1, 5401.418383, 2],
      [-16.188026, 0, -4.617516, 0, 0, 0, 1, 2324.853788, 3],
      [-17.947351, 0.062544, 0.466437, 0.308148, 0.221508, 0.047362, 1, 3311.918913, 4],
      [-17.055312, 0.245197, 0.899529, 0.000094, -0.002006, 0.110352, 1, 900, 5],
    ],
  },
];

const tolerance = 0.0002; // Captured values are rounded to five/six decimals.
for (const test of tests) {
  const vehicle = new context.VehicleForTest();
  vehicle.placeOnTrack(0, 0);
  let checkpoint = 0;
  for (let frame = 0; frame < test.frames; frame++) {
    vehicle.step(test.input(frame), context.physicsForTest.DT);
    if ((frame + 1) % 120 !== 0) continue;
    const actual = inspected.map(property => vehicle[property]);
    const expected = test.expected[checkpoint];
    for (let i = 0; i < inspected.length; i++) {
      if (!Number.isFinite(actual[i]) || Math.abs(actual[i] - expected[i]) > tolerance) {
        throw new Error(
          test.name + ', second ' + (checkpoint + 1) + ', ' + inspected[i] +
          ': expected ' + expected[i] + ', got ' + actual[i]
        );
      }
    }
    checkpoint++;
  }
  if (checkpoint !== test.expected.length) throw new Error(test.name + ': missing checkpoints');
  console.log('PASS ' + test.name + ' (' + test.frames + ' steps)');
}
console.log('All physics regression tests passed; no WebGPU required.');
