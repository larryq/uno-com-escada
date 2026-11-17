# Opus version — architecture and reading guide

This is the English guide to the **Opus** implementation of Uno com escada. The Fable version is a separate game and is untouched by this refactor. Start here before opening the renderer.

## What exists

The game generates its course, landscape, vegetation, Fiat Uno model, sounds and textures **procedurally**. There are no downloaded models, textures or audio files. Rendering is a custom **raw WebGPU + WGSL** implementation. Physics is ordinary JavaScript and knows nothing about WebGPU.

The checked-in `opus/index.html` is a **generated, self-contained release**, not the editable source. Edit files under `opus/source/` and rebuild the release when you want to play your changes.

## Recommended reading order

1. `js/physics.js` — `VehiclePhysics`: the driving simulation, independent of the GPU. See [PHYSICS.md](PHYSICS.md).
2. `js/track.js` — `TRACK`: closed spline, sampled points, centerline distance and lateral offsets.
3. `js/game.js` — `GAME`: owns the car, inputs, simulation timing, replay, camera, lap logic and main loop.
4. `js/ai.js` and `js/lap.js` — scripted driver and recorded lap.
5. `js/world.js`, `js/terrain.js` and `js/vegetation.js` — geometry and procedural scenery.
6. `js/mesh.js`, `js/car_model.js` and `js/cargfx.js` — procedural meshes and car draw data.
7. `js/renderer.js` and `shaders/*.wgsl` — the custom GPU pipeline (the largest future migration).
8. `js/fx.js`, `js/som.js` and `js/painel.js` — particles/skid marks, procedural sound and dashboard.

`js/util.js` is shared math. `source/data/lap.txt` stores the scripted lap. `source/build.mjs` assembles everything into an offline HTML file.

## Ownership and data flow

```text
Keyboard / gamepad / scripted lap
                |
                v
     GAME (js/game.js) ---------------> AI (js/ai.js)
                |
                | calls car.step() on a fixed 1/120 s clock
                v
   VehiclePhysics (js/physics.js) <---- TRACK + TERRAIN
                |
                | car-local velocity, track position,
                | yaw, wheel speeds, slip, steering, etc.
                |
       +--------+----------+---------+
       |                   |         |
       v                   v         v
 GAME visual pose       SND / FX     HUD
       |
       v
    CARGFX + RENDER
       |
       v
  WebGPU + WGSL shaders
```

The physics simulation is the **authoritative** car state. The game produces an interpolated **visual pose** separately, so drawing at 60 Hz (or an uneven refresh rate) does not alter the 120 Hz simulation. Camera movement also uses that pose, not the tire-force calculations.

### Main loop

- `GAME.main()` initializes WebGPU, generates static meshes, initializes particles and car graphics, then starts `requestAnimationFrame`.
- `GAME.loop()` receives wall-clock timing and calls `tick()`.
- `advance()` consumes elapsed time with fixed `PHYS.DT` steps, calling `simStep()` and `car.step(...)`.
- `updatePose()` interpolates the car between fixed steps, `updateCamera()` selects the camera, and `RENDER.renderFrame(frameState)` submits the GPU passes.
- Audio and particles consume simulation results. Replay supplies a recorded input stream rather than a separate physics engine.

Typed arrays (`simulationClock`, `lapTiming` and `hudMetrics`) have **named slot constants** in `game.js`. This preserves existing no-allocation behavior without exposing readers to unexplained `F[7]` or `LT[3]` indices.

## Renderer: what runs per frame?

The Opus renderer is a custom deferred renderer and post-processing graph:

1. Update camera and temporal jitter.
2. Render scheduled cascaded directional shadow maps (four cascades, staggered for performance).
3. Refresh selected faces of the dynamic environment-reflection cubemap.
4. Render opaque meshes into the G-buffer.
5. Compute ambient occlusion and volumetric effects.
6. Apply deferred lighting.
7. Draw transparent items through a forward-rendered pass.
8. Apply temporal anti-aliasing, motion blur and bloom.
9. Tone-map to the canvas and submit GPU commands.

`renderer.js` owns GPU devices, targets, pipelines, bind groups, draw order and timing. `shaders/*.wgsl` contains materials, vegetation, lighting and post effects. This is why replacing the renderer is **not** a simple change of imports.

## Three.js / TSL migration strategy (future work)

Keep the current driving game behavior while replacing renderer pieces progressively, on a **separate branch**:

1. Keep `VehiclePhysics`, `TRACK`, replay, audio and game controls as plain JavaScript.
2. Introduce a Three.js `WebGPURenderer` adapter and map procedural mesh buffers to `BufferGeometry`.
3. Use ordinary Three.js scene objects for the track, props, cameras and car hierarchy.
4. Recreate material and vegetation effects in TSL, validating side by side against the original.
5. Evaluate native Three.js shadows, environment, TAA and post-processing before retaining special custom WebGPU passes. Some WGSL compute effects may remain raw WebGPU.
6. Remove custom GPU plumbing only **after** matching visual behavior and acceptable frame rate.

**Do not migrate the physics to a 3D engine simply to migrate the renderer.** It currently has a clear CPU boundary.

## Why not ES modules yet?

The original author deliberately distributes **one HTML file that works offline from disk**. `build.mjs` concatenates the ordered JavaScript sources into a single script. The files are separate for editing, but they are **not** browser ES modules; globals such as `PHYS`, `TRACK` and `RENDER` link them.

Native browser `import` statements from a local `file://` page can fail because of cross-origin restrictions. A later modular build can use ES modules plus a bundler while still producing a standalone HTML release. For this first phase, preserving the no-dependency build is safer than changing bundling and graphics simultaneously.

## Develop and verify

From the repository root:

```bash
npm test
node opus/source/build.mjs --check
node opus/source/build.mjs
```

`npm test` runs the GPU-independent vehicle regression tests and validates the source bundle syntax. Neither step needs WebGPU or an internet connection. The final command rebuilds the playable `opus/index.html`; open it in a WebGPU-enabled desktop browser.

The regression test uses a flat synthetic course, not a real browser or the complete game. Browser rendering, controls, assets and performance still need interactive testing. This is intentional: physics and rendering should be testable separately.

## Scope of this refactor

- Renamed public vehicle state throughout physics, AI, audio, effects, HUD and game code.
- Split one large physics update into input, powertrain, wheel-load and dynamics stages.
- Replaced anonymous game-loop timing arrays with named slot constants.
- Retained original physics formulas, rendering technology, gameplay and distribution format.
- Did **not** port Three.js/TSL, change the Fable version, or claim browser visual parity has been tested.

License: PolyForm Noncommercial 1.0.0 — see repository `LICENSE.md`.
