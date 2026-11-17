// ---------------------------------------------------------------------------
// game.js — carga, laço principal, entrada, câmeras, modos, ganchos de teste
// ---------------------------------------------------------------------------
'use strict';

const GAME = (() => {
  const gameController = {};
  const params = new URLSearchParams(location.search);
  const msgEl = document.getElementById('msg');
  const msg = (t) => { msgEl.textContent = t; msgEl.style.display = t ? 'flex' : 'none'; };
  gameController.params = params;
  gameController.ready = false;
  // interface (tela de início, menu, painel, som): só no jogo aberto por uma pessoa.
  // Captura, teste e medição (?manual, ?replay, ?perf) ficam como eram; ?ui força a interface (testes).
  const interfaceEnabled = params.has('ui') || !(params.has('manual') || params.has('replay') || params.has('perf'));
  const $ = (id) => document.getElementById(id);
  const renderFrameState = { cam: { x: 0, y: 5, z: 10, tx: 0, ty: 0, tz: 0, fovy: 0.75 }, time: 0, dt: 1 / 60, taa: true, hud: !params.has('nohud') && !interfaceEnabled, cubeCenter: null,
    speedKmh: 0, lapTime: 0, camIndex: 0, motionBlur: 1, allShadows: false, allCubeFaces: false, cut: true };
  gameController.frameState = renderFrameState;

  // ------------------------------------------------ estado do jogo
  // The vehicle owns physics state; graphics, sound, HUD and AI only consume it.
  const car = new VehiclePhysics();
  gameController.car = car;
  const input = { up: false, down: false, left: false, right: false, hand: false, analog: false, stick: false, a: new Float64Array(3) };
  const keysDown = { up: false, down: false, left: false, right: false, hand: false };
  gameController.input = keysDown;
  gameController.mode = params.has('replay') || params.has('perf') ? 'replay' : 'play';
  gameController.camMode = 0;             // 0 perseguição, 1 capô, 2 TV
  gameController.debugCam = false;
  // Typed arrays preserve the original low-allocation timing/performance behavior.
  // Named offsets explain each slot without changing the buffer format.
  const CLOCK_SLOT = Object.freeze({ SIMULATION_SECONDS: 0, FIXED_STEP_ACCUMULATOR: 1, LAP_START_SECONDS: 2, PREVIOUS_TRACK_DISTANCE: 3, TOTAL_TRACK_DISTANCE: 4, PREVIOUS_RAF_MS: 5, PREVIOUS_PERF_MS: 6, DELTA_SECONDS: 7 });
  const simulationClock = new Float64Array(8);
  let simFrame = 0, lapRunning = true;
  const CAM_NAMES = ['perseguição', 'capô', 'TV'];
  const userInterface = { on: interfaceEnabled, screen: interfaceEnabled ? 'inicio' : 'jogo', stats: false, pose: 0, bench: false, watch: false, result: null };
  gameController.ui = userInterface;
  let paused = interfaceEnabled, frozen = false, hudOn = false;
  const LAP_SLOT = Object.freeze({ CURRENT_SECONDS: 0, LAST_SECONDS: 1, BEST_SECONDS: 2, START_SECONDS: 3, DISTANCE_SINCE_LINE: 4, STARTED: 5, PLAYER_LAP: 6, COMPLETED_LAPS: 7 });
  // The HUD expects this eight-number layout; labels are kept here for readers.
  const lapTiming = new Float64Array(8);
  const lapReset = () => { lapTiming[LAP_SLOT.CURRENT_SECONDS] = 0; lapTiming[LAP_SLOT.START_SECONDS] = 0; lapTiming[LAP_SLOT.DISTANCE_SINCE_LINE] = 0; lapTiming[LAP_SLOT.STARTED] = 0; lapTiming[LAP_SLOT.PLAYER_LAP] = 0; };
  lapTiming[LAP_SLOT.LAST_SECONDS] = -1; lapTiming[LAP_SLOT.BEST_SECONDS] = -1;
  const HUD_SLOT = Object.freeze({ FPS: 0, FRAME_MS: 1, GPU_MS: 2, SAMPLE_SECONDS: 3, SAMPLE_FRAMES: 4, NOTICE_HIDE_SECONDS: 5, UNUSED_6: 6, UNUSED_7: 7 });
  const hudMetrics = new Float64Array(8);
  const SCHED = [[0, 0], [13.2, 2], [24.5, 0], [37.5, 1], [47.5, 0]];   // câmeras da volta roteirizada (as do vídeo)

  // ------------------------------------------------ entrada: teclado
  const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'hand' };
  let lookKey = false, padLook = false, padHand = false, stickLast = false, padN = 0;
  // comando de direção com a volta roteirizada rodando: o jogador assume; numa pose, sai dela
  function drive() {
    if (gameController.mode === 'replay' && (gameController.takeOverOnKey || userInterface.watch)) takeOver();
    if (userInterface.pose) leavePose();
  }
  function takeOver() {
    gameController.mode = 'play';
    if (userInterface.watch) { userInterface.watch = false; gameController.camSchedule = null; gameController.camMode = 0; camInit = false; renderFrameState.cut = true; say('Você no controle'); }
  }
  function camKey() {
    if (userInterface.bench) return;
    if (userInterface.pose) { leavePose(); return; }
    if (userInterface.watch) gameController.camSchedule = null;
    gameController.cycleCamera();
    if (userInterface.on) say('Câmera: ' + CAM_NAMES[gameController.camMode]);
  }
  function resetKey() {
    if (userInterface.bench) return;
    if (userInterface.pose) leavePose();
    if (userInterface.watch) takeOver();
    gameController.resetCar();
  }
  function onKey(e, down) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const c = e.code;
    if (userInterface.on && paused) {       // menus: só Esc, M, H e B; Enter/Espaço ficam com o botão em foco
      if (down && !e.repeat && uiKey(c)) e.preventDefault();
      return;
    }
    const k = KEYMAP[c];
    if (k) { keysDown[k] = down; e.preventDefault(); if (down) drive(); }
    if (c === 'KeyV') lookKey = down;
    if (down && !e.repeat) {
      if (c === 'KeyC') camKey();
      else if (c === 'KeyR') resetKey();
      else if (userInterface.on && uiKey(c)) e.preventDefault();
    }
  }
  function uiKey(c) {
    if (c === 'Escape') { if (userInterface.screen === 'jogo') gameController.pause(); else gameController.resume(); }
    else if (c === 'KeyM') { SND.setMute(!SND.muted); say(SND.muted ? 'Som desligado' : 'Som ligado'); }
    else if (c === 'KeyH') { userInterface.stats = !userInterface.stats; RENDER.tsLive = userInterface.stats; hudMetrics[HUD_SLOT.SAMPLE_SECONDS] = 0; hudMetrics[HUD_SLOT.SAMPLE_FRAMES] = 0; hudVis(); }
    else if (userInterface.screen === 'inicio') return false;
    else if (c === 'KeyB') gameController.startBench();
    else if (paused) return false;
    else if (c === 'KeyF') gameController.watchLap();
    else if (c.length === 6 && c.startsWith('Digit') && c[5] >= '1' && c[5] <= '6') gameController.gotoPose(+c[5]);
    else if (c.length === 7 && c.startsWith('Numpad') && c[6] >= '1' && c[6] <= '6') gameController.gotoPose(+c[6]);
    else return false;
    return true;
  }
  window.addEventListener('keydown', (e) => { SND.kick(); onKey(e, true); });
  window.addEventListener('pointerdown', SND.kick);
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { for (const k in keysDown) keysDown[k] = false; lookKey = false; });

  // ------------------------------------------------ entrada: controle (Gamepad API, layout padrão)
  // gatilho direito acelera, esquerdo freia/ré (analógicos); analógico esquerdo faz curvas; A freio de mão; Y câmera; X volta à pista; RB olha para trás; Start menu
  const PADV = new Float64Array(3);                             // direção −1..1, acelerador 0..1, freio 0..1
  const padNow = new Uint8Array(17), padWas = new Uint8Array(17);
  const padCount = () => { padN = 0; const g = navigator.getGamepads ? navigator.getGamepads() : []; for (let i = 0; i < g.length; i++) if (g[i] && g[i].connected) padN++; if (!padN) { PADV.fill(0); padNow.fill(0); padHand = padLook = false; } };
  window.addEventListener('gamepadconnected', padCount);
  window.addEventListener('gamepaddisconnected', padCount);
  const hit = (i) => padNow[i] === 1 && padWas[i] === 0;
  function pollPad() {
    const gps = navigator.getGamepads();
    let gp = null;
    for (let i = 0; i < gps.length; i++) { const g = gps[i]; if (g && g.connected && (!gp || (g.mapping === 'standard' && gp.mapping !== 'standard'))) gp = g; }
    if (!gp) return;
    const b = gp.buttons, nb = b.length;
    // zona morta de 14% e curva suave no centro
    let x = gp.axes.length ? gp.axes[0] : 0;
    const ax = Math.abs(x);
    x = ax < 0.14 ? 0 : (ax > 1 ? 1 : (ax - 0.14) / 0.86) * (x < 0 ? -1 : 1);
    PADV[0] = x * (0.5 + 0.5 * x * x);
    for (let j = 0; j < 2; j++) {
      const bt = nb > 7 - j ? b[7 - j] : null, v = bt ? (bt.value > 0 ? bt.value : bt.pressed ? 1 : 0) : 0;
      PADV[1 + j] = v < 0.04 ? 0 : v > 0.96 ? 1 : (v - 0.04) / 0.92;
    }
    for (let i = 0; i < 17; i++) { padWas[i] = padNow[i]; padNow[i] = i < nb && b[i].pressed ? 1 : 0; }
    if (userInterface.on && paused) {
      padHand = padLook = false;
      if (hit(9) || hit(0)) { if (userInterface.screen === 'inicio') gameController.start(); else gameController.resume(); }
      return;
    }
    padHand = padNow[0] === 1; padLook = padNow[5] === 1;
    if (PADV[0] !== 0) stickLast = true;
    if (PADV[1] > 0.1 || PADV[2] > 0.1 || Math.abs(PADV[0]) > 0.25 || padHand) drive();
    if (hit(3)) camKey();
    if (hit(2)) resetKey();
    if (hit(9) && userInterface.on) gameController.pause();
  }

  gameController.cycleCamera = () => { gameController.camMode = (gameController.camMode + 1) % 3; camInit = false; renderFrameState.cut = true; gameController.debugCam = false; };
  const tmp3 = new Float64Array(3);
  gameController.resetCar = () => {
    // volta ao ponto mais próximo da pista, alinhado, parado
    TRACK.project(car.x, car.z, -1, tmp3);
    car.placeOnTrack(tmp3[0], clamp(tmp3[1], -3, 3));
    copyPrev(); camInit = false; renderFrameState.cut = true;
  };

  // ------------------------------------------------ pose visual (interpolada)
  const pose = { x: 0, y: 0, z: 0, fx: 1, fy: 0, fz: 0, ux: 0, uy: 1, uz: 0, roll: 0, pitch: 0, heave: 0, steer: 0, spin: new Float32Array(4), drop: new Float32Array(4), brake: 0, reverse: 0, lights: 0 };
  gameController.pose = pose;
  const previousCarPose = { x: 0, y: 0, z: 0, headingRadians: 0, roll: 0, pitch: 0, roadPitch: 0, roadRoll: 0, wheelSpinAngles: new Float64Array(4) };
  function copyPrev() {
    previousCarPose.x = car.x; previousCarPose.y = car.y; previousCarPose.z = car.z; previousCarPose.headingRadians = car.headingRadians; previousCarPose.roll = car.roll; previousCarPose.pitch = car.pitch;
    previousCarPose.roadPitch = car.roadPitch; previousCarPose.roadRoll = car.roadRoll; for (let k = 0; k < 4; k++) previousCarPose.wheelSpinAngles[k] = car.wheelSpinAngles[k];
  }
  function angLerp(a, b, t) { let d = b - a; while (d > PI) d -= TAU; while (d < -PI) d += TAU; return a + d * t; }
  function updatePose() {
    const alpha = clamp(simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] / PHYS.DT, 0, 1);
    const x = lerp(previousCarPose.x, car.x, alpha), y = lerp(previousCarPose.y, car.y, alpha), z = lerp(previousCarPose.z, car.z, alpha);
    const psi = angLerp(previousCarPose.headingRadians, car.headingRadians, alpha);
    const pg = lerp(previousCarPose.roadPitch, car.roadPitch, alpha), rg = lerp(previousCarPose.roadRoll, car.roadRoll, alpha);
    const c = Math.cos(psi), s = Math.sin(psi);
    const cp = Math.cos(pg), sp = Math.sin(pg);
    pose.fx = c * cp; pose.fy = sp; pose.fz = s * cp;
    // direita horizontal; cima = direita x frente; depois rolagem do terreno em torno da frente
    const rx = -s, rz = c;
    const ux = -rz * pose.fy, uy = rz * pose.fx - rx * pose.fz, uz = rx * pose.fy;
    const cr = Math.cos(rg), sr = Math.sin(rg);
    pose.ux = ux * cr + rx * sr; pose.uy = uy * cr; pose.uz = uz * cr + rz * sr;
    const ul = Math.hypot(pose.ux, pose.uy, pose.uz); pose.ux /= ul; pose.uy /= ul; pose.uz /= ul;
    pose.x = x; pose.y = y; pose.z = z;
    pose.roll = lerp(previousCarPose.roll, car.roll, alpha); pose.pitch = lerp(previousCarPose.pitch, car.pitch, alpha); pose.heave = car.heave;
    pose.steer = car.steeringAngle;
    for (let k = 0; k < 4; k++) { pose.spin[k] = angLerp(previousCarPose.wheelSpinAngles[k], car.wheelSpinAngles[k], alpha); pose.drop[k] = 0; }
    pose.brake = car.brake > 0.05 ? 1 : 0;
    pose.reverse = car.reverse && car.throttle > 0.05 ? 1 : 0;
  }

  // ------------------------------------------------ câmeras
  let camInit = false;
  const ch = { x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0 };
  const tvCams = [];
  function buildTvCams() {
    const S = [70, 250, 400, 520, 640, 760, 880, 1000, 1120];
    const ts = new Float64Array(6);
    for (const s0 of S) {
      TRACK.sampleS(s0, ts);
      const i = Math.floor(s0 / TRACK.ds) % TRACK.N;
      let sg = 0; for (let k = -30; k <= 30; k++) sg += TRACK.curv[(i + k + TRACK.N) % TRACK.N];
      const side = sg > 0 ? -1 : 1;           // lado externo da curva
      const wall = side < 0 ? TRACK.wallL[i] : TRACK.wallR[i];
      const u = side * (wall + 4.5);
      const x = ts[0] - ts[4] * u, z = ts[2] + ts[3] * u;
      tvCams.push({ s: s0, x, y: TERRAIN.heightAt(x, z) + 4.2, z });
    }
  }
  gameController.tvCams = tvCams;
  let tvIdx = -1;
  function updateCamera() {
    const dt = simulationClock[CLOCK_SLOT.DELTA_SECONDS];
    const c = renderFrameState.cam;
    const hx = pose.fx, hz = pose.fz, hl = Math.hypot(hx, hz) || 1;
    const fx = hx / hl, fz = hz / hl;
    const lb = gameController.lookBack ? -1 : 1;              // olhar para trás espelha a câmera (a de TV vira perseguição)
    if (gameController.camMode === 0 || (lb < 0 && gameController.camMode === 2)) {
      const yawT = Math.atan2(fz, fx);
      if (!camInit) { ch.yaw = yawT; ch.y = pose.y; camInit = true; }
      ch.yaw = angLerp(ch.yaw, yawT, 1 - Math.exp(-dt * 3.6));
      ch.y += (pose.y - ch.y) * (1 - Math.exp(-dt * 8));
      const spd = Math.abs(car.forwardVelocity);
      const dist = 6.2 + spd * 0.035, h = 1.95;
      const cx = Math.cos(ch.yaw), cz = Math.sin(ch.yaw);
      c.x = pose.x - cx * dist * lb; c.z = pose.z - cz * dist * lb;
      c.y = Math.max(ch.y + h, TERRAIN.heightAt(c.x, c.z) + 0.6);
      c.tx = pose.x + cx * 1.5 * lb; c.ty = ch.y + 1.05; c.tz = pose.z + cz * 1.5 * lb;
      c.fovy = (44 + Math.min(spd, 40) * 0.12) * PI / 180;
      renderFrameState.camIndex = 0;
    } else if (gameController.camMode === 1) {
      // capô: preso à carroceria (inclui arfagem e rolagem)
      const rx = -fz, rz = fx;
      const ax = lb > 0 ? 0.58 : -2.0, ay = lb > 0 ? 1.25 : 1.0;
      c.x = pose.x + pose.fx * ax + pose.ux * ay; c.y = pose.y + pose.fy * ax + pose.uy * ay + pose.heave; c.z = pose.z + pose.fz * ax + pose.uz * ay;
      const pit = pose.pitch, rol = pose.roll;
      c.tx = c.x + pose.fx * 20 * lb + pose.ux * (-1.9 + pit * 20) + rx * rol * 4;
      c.ty = c.y + pose.fy * 20 * lb + pose.uy * (-1.9 + pit * 20);
      c.tz = c.z + pose.fz * 20 * lb + pose.uz * (-1.9 + pit * 20) + rz * rol * 4;
      c.fovy = 52 * PI / 180;
      renderFrameState.camIndex = 1;
    } else {
      let best = 0, bd = 1e9;
      for (let i = 0; i < tvCams.length; i++) {
        let d = car.trackDistance - tvCams[i].s; if (d < -TRACK.L / 2) d += TRACK.L; if (d > TRACK.L / 2) d -= TRACK.L;
        const ad = Math.abs(d - 15);
        if (ad < bd) { bd = ad; best = i; }
      }
      if (best !== tvIdx) { tvIdx = best; renderFrameState.cut = true; camInit = false; }
      const tc = tvCams[best];
      c.x = tc.x; c.y = tc.y; c.z = tc.z;
      if (!camInit) { ch.tx = pose.x; ch.ty = pose.y + 0.7; ch.tz = pose.z; camInit = true; }
      const k = 1 - Math.exp(-dt * 9);
      ch.tx += (pose.x - ch.tx) * k; ch.ty += (pose.y + 0.7 - ch.ty) * k; ch.tz += (pose.z - ch.tz) * k;
      c.tx = ch.tx; c.ty = ch.ty; c.tz = ch.tz;
      const d = Math.hypot(c.tx - c.x, c.ty - c.y, c.tz - c.z);
      c.fovy = clamp(2 * Math.atan(5.0 / d), 7 * PI / 180, 50 * PI / 180);
      renderFrameState.camIndex = 2;
    }
  }

  // tela de início: órbita lenta em volta do carro parado no grid
  function orbitCamera() {
    const a = renderFrameState.time * 0.11 + 2.3, c = renderFrameState.cam;
    c.x = pose.x + Math.cos(a) * 6.6; c.z = pose.z + Math.sin(a) * 6.6;
    c.y = Math.max(pose.y + 1.55, TERRAIN.heightAt(c.x, c.z) + 0.5);
    c.tx = pose.x; c.ty = pose.y + 0.72; c.tz = pose.z; c.fovy = 40 * PI / 180; renderFrameState.camIndex = 0;
  }

  // ------------------------------------------------ simulação
  function simStep() {
    if (gameController.mode === 'replay' && LAP.keys) {
      const f = Math.floor(simFrame / 2);
      const k = f < LAP.keys.length ? LAP.keys[f] : 0;
      input.up = !!(k & 1); input.down = !!(k & 2); input.left = !!(k & 4); input.right = !!(k & 8); input.hand = !!(k & 16);
      if (f >= LAP.keys.length) { input.down = car.forwardVelocity > 0.5; }
      input.analog = false;
    } else if (gameController.mode === 'ai') {
      const a = AI.drive(car, 1.0);
      input.up = a.up; input.down = a.down; input.left = a.left; input.right = a.right; input.hand = a.hand;
      input.analog = false;
    } else {
      // teclado e controle somados; com teclas (0/1) o resultado é idêntico ao da entrada digital
      const ks = (keysDown.right ? 1 : 0) - (keysDown.left ? 1 : 0), A = input.a;
      input.up = keysDown.up; input.down = keysDown.down; input.left = keysDown.left; input.right = keysDown.right; input.hand = keysDown.hand || padHand;
      if (ks !== 0) stickLast = false;
      A[0] = ks !== 0 ? ks : PADV[0]; A[1] = keysDown.up ? 1 : PADV[1]; A[2] = keysDown.down ? 1 : PADV[2];
      input.analog = true; input.stick = stickLast;
    }
    copyPrev();
    car.step(input, PHYS.DT);
    simFrame++;
    simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] += PHYS.DT;
    let ds = car.trackDistance - simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE]; if (ds < -TRACK.L / 2) ds += TRACK.L; if (ds > TRACK.L / 2) ds -= TRACK.L;
    // cronômetro do painel: a volta conta ao cruzar a linha de largada, para a frente, depois de dar a volta inteira
    {
      let r0 = simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE] - TRACK.sStart; if (r0 > TRACK.L / 2) r0 -= TRACK.L; else if (r0 < -TRACK.L / 2) r0 += TRACK.L;
      lapTiming[LAP_SLOT.DISTANCE_SINCE_LINE] += ds;
      if (gameController.mode !== 'play') lapTiming[LAP_SLOT.PLAYER_LAP] = 0;
      if (r0 < 0 && r0 + ds >= 0) {
        const tc = simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] - PHYS.DT * (r0 + ds) / ds;
        if (lapTiming[LAP_SLOT.STARTED] === 1 && lapTiming[LAP_SLOT.DISTANCE_SINCE_LINE] > TRACK.L * 0.9) { lapTiming[LAP_SLOT.LAST_SECONDS] = tc - lapTiming[LAP_SLOT.START_SECONDS]; lapTiming[LAP_SLOT.COMPLETED_LAPS]++; if (lapTiming[LAP_SLOT.PLAYER_LAP] === 1 && (lapTiming[LAP_SLOT.BEST_SECONDS] < 0 || lapTiming[LAP_SLOT.LAST_SECONDS] < lapTiming[LAP_SLOT.BEST_SECONDS])) lapTiming[LAP_SLOT.BEST_SECONDS] = lapTiming[LAP_SLOT.LAST_SECONDS]; }
        lapTiming[LAP_SLOT.START_SECONDS] = tc; lapTiming[LAP_SLOT.DISTANCE_SINCE_LINE] = r0 + ds; lapTiming[LAP_SLOT.STARTED] = 1; lapTiming[LAP_SLOT.PLAYER_LAP] = gameController.mode === 'play' ? 1 : 0;
      }
    }
    simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE] = car.trackDistance; simulationClock[CLOCK_SLOT.TOTAL_TRACK_DISTANCE] += ds;
    if (simulationClock[CLOCK_SLOT.TOTAL_TRACK_DISTANCE] >= TRACK.L - 8) { if (lapRunning) gameController.lastLap = simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] - simulationClock[CLOCK_SLOT.LAP_START_SECONDS]; else if (!gameController.lapCount) gameController.lapCount = 0; gameController.lapCount = (gameController.lapCount || 0) + 1; lapRunning = true; simulationClock[CLOCK_SLOT.LAP_START_SECONDS] = simulationClock[CLOCK_SLOT.SIMULATION_SECONDS]; simulationClock[CLOCK_SLOT.TOTAL_TRACK_DISTANCE] -= TRACK.L; if (gameController.lapCount > 1) gameController.lastLap2 = gameController.lastLap; }
    if (typeof FX !== 'undefined') FX.simStep(car, PHYS.DT);
    SND.simStep(car, PHYS.DT);
  }
  gameController.startScripted = () => {
    gameController.mode = 'replay';
    car.placeOnTrack(LAP.meta.startS, LAP.meta.startU);
    simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] = 0; simFrame = 0; simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] = 0; simulationClock[CLOCK_SLOT.LAP_START_SECONDS] = 0; lapRunning = true; simulationClock[CLOCK_SLOT.TOTAL_TRACK_DISTANCE] = 0; simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE] = car.trackDistance; gameController.lastLap = 0;
    copyPrev(); camInit = false; renderFrameState.cut = true;
    if (typeof FX !== 'undefined') FX.reset();
    lapReset(); SND.reset();
  };
  gameController.advance = () => {
    simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] += simulationClock[CLOCK_SLOT.DELTA_SECONDS];
    let n = 0;
    while (simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] >= PHYS.DT - 1e-9 && n < 24) { simStep(); simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] -= PHYS.DT; n++; }
    if (n === 24) simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] = 0;
  };
  gameController.simFrame = (dt) => { simulationClock[CLOCK_SLOT.DELTA_SECONDS] = dt; gameController.advance(); };     // só a simulação, sem imagem (som fora do tempo real)

  // ------------------------------------------------ quadro
  const cubeC = new Float32Array(3);
  function frame() {
    const dt = simulationClock[CLOCK_SLOT.DELTA_SECONDS];
    if (!paused && !frozen) gameController.advance();
    if (gameController.camSchedule) gameController.applySchedule();
    updatePose();
    CARGFX.update(pose, renderFrameState.cut);
    if (userInterface.screen === 'inicio') orbitCamera(); else if (!gameController.debugCam) updateCamera();
    cubeC[0] = pose.x; cubeC[1] = pose.y + 0.75; cubeC[2] = pose.z; renderFrameState.cubeCenter = cubeC;
    { const hl = Math.hypot(pose.fx, pose.fz) || 1; renderFrameState.carFx = pose.fx / hl; renderFrameState.carFz = pose.fz / hl; }
    renderFrameState.dt = dt; renderFrameState.time += dt;
    renderFrameState.speedKmh = Math.abs(car.forwardVelocity) * 3.6;
    renderFrameState.lapTime = simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] - simulationClock[CLOCK_SLOT.LAP_START_SECONDS];
    if (typeof FX !== 'undefined') FX.frame(renderFrameState);
    RENDER.renderFrame(renderFrameState);
    renderFrameState.cut = false;
  }
  // um quadro do jogo: entrada do controle, quadro, painel e som (tudo sem alocar)
  function tick() {
    if (padN > 0) pollPad();
    const lb = lookKey || padLook;
    if (lb !== !!gameController.lookBack) { gameController.lookBack = lb; camInit = false; renderFrameState.cut = true; }
    if (!userInterface.on) { frame(); return; }
    if (userInterface.watch && gameController.mode === 'replay' && simFrame >= LAP.keys.length * 2 && Math.abs(car.forwardVelocity) < 0.5) takeOver();
    frame();
    lapTiming[LAP_SLOT.CURRENT_SECONDS] = lapTiming[LAP_SLOT.STARTED] === 1 ? simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] - lapTiming[LAP_SLOT.START_SECONDS] : 0;
    if (hudOn) HUD.draw(car, lapTiming);
    SND.frame(frozen);
    if (userInterface.stats) {
      hudMetrics[HUD_SLOT.SAMPLE_SECONDS] += simulationClock[CLOCK_SLOT.DELTA_SECONDS]; hudMetrics[HUD_SLOT.SAMPLE_FRAMES]++;
      if (hudMetrics[HUD_SLOT.SAMPLE_SECONDS] >= 0.5) { hudMetrics[HUD_SLOT.FPS] = hudMetrics[HUD_SLOT.SAMPLE_FRAMES] / hudMetrics[HUD_SLOT.SAMPLE_SECONDS]; hudMetrics[HUD_SLOT.FRAME_MS] = 1000 * hudMetrics[HUD_SLOT.SAMPLE_SECONDS] / hudMetrics[HUD_SLOT.SAMPLE_FRAMES]; hudMetrics[HUD_SLOT.GPU_MS] = RENDER.hasTimestamps ? RENDER.stats.gpuMs : -1; hudMetrics[HUD_SLOT.SAMPLE_SECONDS] = 0; hudMetrics[HUD_SLOT.SAMPLE_FRAMES] = 0; HUD.stats(hudMetrics); }
    }
    if (hudMetrics[HUD_SLOT.NOTICE_HIDE_SECONDS] > 0 && renderFrameState.time > hudMetrics[HUD_SLOT.NOTICE_HIDE_SECONDS]) { hudMetrics[HUD_SLOT.NOTICE_HIDE_SECONDS] = 0; avisoEl.className = ''; }
  }

  // ------------------------------------------------ interface: telas, avisos, poses, volta para assistir, benchmark
  const menuEl = $('menu'), avisoEl = $('aviso');
  function say(t) { if (!userInterface.on) return; avisoEl.textContent = t; avisoEl.className = 'on'; hudMetrics[HUD_SLOT.NOTICE_HIDE_SECONDS] = renderFrameState.time + 2.4; }
  function hudVis() {
    if (!userInterface.on) return;
    hudOn = userInterface.screen !== 'inicio' && userInterface.screen !== 'resultado' && !userInterface.bench && !userInterface.pose;
    HUD.show(hudOn, userInterface.stats && userInterface.screen !== 'inicio' && !userInterface.bench);
  }
  // telas: inicio → jogo ⇄ pausa; resultado (fim do benchmark) → jogo
  function setScreen(s) {
    userInterface.screen = s; paused = s !== 'jogo';
    if (!userInterface.on) return;
    menuEl.className = s; menuEl.hidden = !paused;
    for (const k in keysDown) keysDown[k] = false;
    lookKey = false;
    SND.run(!paused);
    hudVis();
    if (paused) $(s === 'inicio' ? 'bS' : 'bC').focus(); else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  gameController.start = () => { if (userInterface.screen !== 'inicio') return; SND.start(); setScreen('jogo'); camInit = false; renderFrameState.cut = true; };
  gameController.pause = () => { if (userInterface.screen !== 'jogo') return; if (userInterface.bench) benchCancel(); setScreen('pausa'); };
  gameController.resume = () => { if (userInterface.screen === 'pausa' || userInterface.screen === 'resultado') setScreen('jogo'); };
  function toGrid() { gameController.startScripted(); gameController.mode = 'play'; gameController.camMode = 0; gameController.camSchedule = null; gameController.debugCam = false; }
  function leavePose() {
    if (!userInterface.pose) return;
    userInterface.pose = 0; frozen = false; gameController.debugCam = false; renderFrameState.hud = false; gameController.camMode = 0; camInit = false; renderFrameState.cut = true;
    if (gameController.mode === 'replay') gameController.mode = 'play';
    hudVis();
  }
  // 1 a 6: as seis poses fixas da captura (mesmo carro, mesma câmera; a 4 é a câmera de TV no grampo, aos 14 s da volta)
  const POSES = [[5.6, -4.4, 1.25, 0, 0, 0.62, 33], [-5.8, 4.2, 2.5, -0.2, 0, 0.9, 34], [0.2, -4.6, 1.4, -0.1, 0, 0.95, 36], null, [-120, 7.5, -3, 60, 1.5, 2, 52], [-10, 38, 70, -170, 0, -190, 55]];
  const POSE_NAMES = ['frente ¾', 'traseira ¾ e escada', 'lateral e interior', 'TV no grampo', 'reta de largada', 'paisagem'];
  const ts6 = new Float64Array(6);
  gameController.gotoPose = (n) => {
    if (userInterface.bench || !(n >= 1 && n <= 6)) return;
    userInterface.watch = false; gameController.camSchedule = null;
    gameController.startScripted();
    if (n === 4) {
      gameController.camMode = 2; gameController.debugCam = false; renderFrameState.hud = true;
      for (let i = 0; i < 840; i++) gameController.simFrame(1 / 60);
      frozen = true;
    } else {
      gameController.mode = 'play'; gameController.camMode = 0; frozen = false; renderFrameState.hud = false;
      let best = 380, bd = -9; const sd = RENDER.sun.dir;      // trecho aberto, de frente para o sol
      for (let s = 360; s < 430; s += 1) { TRACK.sampleS(s, ts6); const d = ts6[3] * sd[0] + ts6[4] * sd[2]; if (d > bd) { bd = d; best = s; } }
      car.placeOnTrack(best, 1.5); simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE] = car.trackDistance; simulationClock[CLOCK_SLOT.FIXED_STEP_ACCUMULATOR] = 0; copyPrev(); updatePose();
      const q = POSES[n - 1], p = pose;
      if (n <= 3) gameController.setPose(p.x + p.fx * q[0] - p.fz * q[1], p.y + q[2], p.z + p.fz * q[0] + p.fx * q[1], p.x + p.fx * q[3] - p.fz * q[4], p.y + q[5], p.z + p.fz * q[3] + p.fx * q[4], q[6]);
      else gameController.setPose(q[0], q[1], q[2], q[3], q[4], q[5], q[6]);
    }
    userInterface.pose = n; camInit = false; renderFrameState.cut = true; lapReset();
    hudVis(); say('Pose ' + n + ' — ' + POSE_NAMES[n - 1]);
  };
  // simulationClock: a volta roteirizada, só para assistir (qualquer comando de direção devolve o carro ao jogador)
  gameController.watchLap = () => {
    if (userInterface.bench) return;
    leavePose(); gameController.startScripted(); gameController.camMode = 0; gameController.camSchedule = SCHED; gameController.debugCam = false; userInterface.watch = true;
    say('Volta roteirizada — acelere ou faça uma curva para assumir');
  };
  // B: a mesma volta medida de ?perf, em 2560×1440; no fim mostra os números
  gameController.startBench = () => {
    if (!userInterface.on || userInterface.bench || userInterface.screen === 'inicio' || !gameController.ready) return;
    leavePose(); userInterface.watch = false; gameController.camSchedule = null; gameController.debugCam = false;
    userInterface.bench = true; renderFrameState.hud = true;
    canvas.style.objectFit = 'contain'; RENDER.resize(2560, 1440);
    setScreen('jogo');
    startPerf();
    say('Benchmark: 60 s — Esc cancela');
  };
  function benchClose() { userInterface.bench = false; renderFrameState.hud = false; canvas.style.objectFit = ''; fit(); toGrid(); }
  function benchCancel() { perf.on = false; RENDER.stopTimestampLog(); benchClose(); }
  function benchEnd(r) {
    const st = (a) => { if (!a.length) return null; const v = Float64Array.from(a).sort(); let m = 0; for (let i = 0; i < v.length; i++) m += v[i]; return { media: m / v.length, p99: v[Math.min(v.length - 1, Math.floor(0.99 * v.length))], max: v[v.length - 1] }; };
    const over = (a, lim) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] > lim) n++; return n; };
    // como em perf.py: descarta as 5 primeiras amostras; 16,75 = 16,7 mais o arredondamento de 0,1 ms do relógio do navegador
    const fi = r.frameIntervals.slice(5), g = r.gpu.slice(5);
    const res = { quadros: r.frames, segundos: r.seconds, volta: r.lap, largura: RENDER.W, altura: RENDER.H, quadro: st(fi), gpu: st(g), acima16_7: over(fi, 16.75), gpuAcima16_7: g.length ? over(g, 16.7) : null };
    userInterface.result = res;
    const n = (x) => x.toFixed(2).replace('.', ','), row = (t, o) => `<tr><th>${t}</th>` + (o ? `<td>${n(o.media)}</td><td>${n(o.p99)}</td><td>${n(o.max)}</td>` : '<td colspan="3">indisponível neste navegador</td>') + '</tr>';
    $('res').innerHTML = `<h2>Benchmark — volta roteirizada, ${res.largura}×${res.altura}</h2><table><tr><th></th><th>média</th><th>percentil 99</th><th>máximo</th></tr>` +
      row('Tempo de quadro (ms)', res.quadro) + row('Tempo de GPU (ms)', res.gpu) + '</table>' +
      `<p>${res.quadros} quadros em ${n(res.segundos)} s (${n(res.quadros / res.segundos)} quadros/s). Passaram de 16,7 ms: <b>${res.acima16_7}</b> quadros no tempo de quadro` +
      (res.gpu ? ` e <b>${res.gpuAcima16_7}</b> no tempo de GPU.` : '.') + '</p>';
    benchClose();
    setScreen('resultado');
  }
  let canvas = null, fitT = 0;
  function fit() {
    const W = +(params.get('w') || Math.round(canvas.clientWidth * devicePixelRatio)), H = +(params.get('h') || Math.round(canvas.clientHeight * devicePixelRatio));
    if (W > 0 && H > 0) RENDER.resize(W, H);
    renderFrameState.cut = true;
  }
  function initUI() {
    HUD.resize();
    $('bS').onclick = gameController.start; $('bC').onclick = gameController.resume; $('bB').onclick = gameController.startBench;
    window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(() => { if (!userInterface.bench) fit(); HUD.resize(); hudVis(); }, 200); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) gameController.pause(); });
    padCount();
    setScreen('inicio');
  }

  async function main() {
    canvas = document.getElementById('c');
    try {
      msg('gerando circuito…');
      await new Promise(r => setTimeout(r, 0));
      await RENDER.init(canvas);
      RENDER.addMesh(WORLD.buildTrack().pack(), { name: 'track', shadow: false });
      const ter = WORLD.buildTerrain();
      const tp = ter.mb.pack();
      const tm = RENDER.addMesh(tp, { name: 'terrain', count: ter.innerCount, minShadowCascade: 2, maxShadowCascade: 3, cube: false });
      RENDER.addMeshShared(tm, { name: 'terrainFar', first: ter.innerCount, count: tp.count - ter.innerCount, shadow: false, min: null, cube: true });
      RENDER.addMesh(ter.coarse.pack(), { name: 'terrainCube', main: false, shadow: false, cube: true });
      RENDER.addMesh(WORLD.buildBarriers().pack(), { name: 'barriers', cube: false });
      RENDER.addMesh(WORLD.buildTyreStacks().pack(), { name: 'tyres', maxShadowCascade: 1, cube: false });
      if (WORLD.buildProps) { RENDER.addMesh(WORLD.buildProps().pack(), { name: 'props' }); RENDER.addMesh(WORLD.crowdMesh.pack(), { name: 'crowd', cube: false, maxShadowCascade: 1 }); }
      VEG.init();
      await CARGFX.init();
      if (typeof FX !== 'undefined') FX.init();
      buildTvCams();
      const W = +(params.get('w') || Math.round(canvas.clientWidth * devicePixelRatio));
      const H = +(params.get('h') || Math.round(canvas.clientHeight * devicePixelRatio));
      RENDER.resize(W, H);
      if (LAP.meta) car.placeOnTrack(LAP.meta.startS, LAP.meta.startU); else car.placeOnTrack(TRACK.sStart - 8, 2);
      simulationClock[CLOCK_SLOT.PREVIOUS_TRACK_DISTANCE] = car.trackDistance; copyPrev();
      if (gameController.mode === 'replay') gameController.startScripted();
      if (params.has('cam')) gameController.camMode = +params.get('cam');
      if (params.has('debug')) RENDER.debug = +params.get('debug');
      msg('');
      if (userInterface.on) initUI();
      gameController.ready = true;
      if (!params.has('manual')) requestAnimationFrame(loop);
      if (params.has('perf')) startPerf();
    } catch (e) {
      console.error(e);
      msg('Erro: ' + e.message);
      gameController.error = String(e.stack || e);
    }
  }

  // ------------------------------------------------ captura / testes (passo manual)
  gameController.setPose = (x, y, z, tx, ty, tz, fovDeg) => {
    gameController.debugCam = true;
    const c = renderFrameState.cam; c.x = x; c.y = y; c.z = z; c.tx = tx; c.ty = ty; c.tz = tz; c.fovy = fovDeg * PI / 180;
  };
  gameController.step = (dt) => { simulationClock[CLOCK_SLOT.DELTA_SECONDS] = dt; tick(); };
  // programação de câmeras da volta capturada: [tempo, câmera]
  gameController.camSchedule = null;
  gameController.applySchedule = () => {
    if (!gameController.camSchedule) return;
    let c = 0; const cs = gameController.camSchedule; for (let i = 0; i < cs.length; i++) if (simulationClock[CLOCK_SLOT.SIMULATION_SECONDS] >= cs[i][0]) c = cs[i][1];
    if (c !== gameController.camMode) { gameController.camMode = c; camInit = false; renderFrameState.cut = true; }
  };
  gameController.renderN = async (n, dt) => { for (let i = 0; i < n; i++) { simulationClock[CLOCK_SLOT.DELTA_SECONDS] = dt; tick(); } await RENDER.device.queue.onSubmittedWorkDone(); };
  gameController.state = () => ({ speed: car.forwardVelocity, kmh: Math.abs(car.forwardVelocity) * 3.6, steer: car.steeringAngle, steerIn: car.steeringInput, brake: car.brake, hb: car.handbrake, x: car.x, z: car.z, psi: car.headingRadians, s: car.trackDistance, u: car.trackLateralOffset,
    cam: gameController.camMode, camName: CAM_NAMES[gameController.camMode], camPos: [renderFrameState.cam.x, renderFrameState.cam.y, renderFrameState.cam.z], offWheels: car.offTrackWheelCount, gear: car.gear, reverse: car.reverse, simTime: simulationClock[CLOCK_SLOT.SIMULATION_SECONDS], lap: gameController.lastLap, yawRate: car.yawRate, roll: car.roll, pitch: car.pitch, mode: gameController.mode,
    thr: car.throttle, rpm: car.rpm, rpmSom: SND.M[0], steerRate: input.stick ? 'analógico' : 'teclas', pad: padN, lookBack: !!gameController.lookBack, camTarget: [renderFrameState.cam.tx, renderFrameState.cam.ty, renderFrameState.cam.tz],
    screen: userInterface.screen, paused, frozen, pose: userInterface.pose, bench: userInterface.bench, watch: userInterface.watch, stats: userInterface.stats, muted: SND.muted, audio: SND.ctx ? SND.ctx.state : 'nenhum', hud: hudOn, shaderHud: renderFrameState.hud,
    lapNow: lapTiming[LAP_SLOT.CURRENT_SECONDS], lapLast: lapTiming[LAP_SLOT.LAST_SECONDS], lapBest: lapTiming[LAP_SLOT.BEST_SECONDS], laps: lapTiming[LAP_SLOT.COMPLETED_LAPS], frame: simFrame });

  // ------------------------------------------------ laço em tempo real
  function loop(t) {
    simulationClock[CLOCK_SLOT.DELTA_SECONDS] = simulationClock[CLOCK_SLOT.PREVIOUS_RAF_MS] ? Math.min((t - simulationClock[CLOCK_SLOT.PREVIOUS_RAF_MS]) / 1000, 0.1) : 1 / 60;
    simulationClock[CLOCK_SLOT.PREVIOUS_RAF_MS] = t;
    tick();
    if (perf.on) perfTick(t);
    requestAnimationFrame(loop);
  }
  // ------------------------------------------------ medição (volta de 60 s em tempo real)
  const perf = { on: false, t0: 0, frames: 0, cpu: null };
  function startPerf() {
    // aquecimento (compila pipelines, enche históricos) antes da volta medida
    FX.warm(car);
    renderFrameState.allShadows = true; renderFrameState.allCubeFaces = true;
    simulationClock[CLOCK_SLOT.DELTA_SECONDS] = 1 / 60;
    for (let i = 0; i < 12; i++) frame();
    renderFrameState.allShadows = false; renderFrameState.allCubeFaces = false;
    for (let i = 0; i < 4; i++) { gameController.cycleCamera(); frame(); frame(); }
    gameController.camMode = 0;
    gameController.startScripted();
    for (let i = 0; i < 60; i++) frame();
    gameController.startScripted();
    perf.on = true; perf.t0 = 0; perf.frames = 0;
    perf.cpu = new Float32Array(20000);
    RENDER.startTimestampLog(20000);
    gameController.startScripted();
  }
  function perfTick(t) {
    if (!perf.t0) perf.t0 = t;
    if (simulationClock[CLOCK_SLOT.PREVIOUS_PERF_MS]) perf.cpu[perf.frames] = t - simulationClock[CLOCK_SLOT.PREVIOUS_PERF_MS];
    simulationClock[CLOCK_SLOT.PREVIOUS_PERF_MS] = t;
    perf.frames++;
    if (t - perf.t0 >= 60000) {
      perf.on = false;
      RENDER.stopTimestampLog().then((gpu) => {
        window.__perf = { gpu: Array.from(gpu || []), frameIntervals: Array.from(perf.cpu.subarray(1, perf.frames)), frames: perf.frames, seconds: (t - perf.t0) / 1000, lap: gameController.lastLap };
        if (userInterface.bench) benchEnd(window.__perf);
      });
    }
  }
  window.__game = gameController;
  window.__dbg = { VEG, RENDER, TRACK, TERRAIN, CARGFX, WORLD, AI, LAP, SND, HUD };
  main();
  return gameController;
})();
