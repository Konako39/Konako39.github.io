/* ============================================================
 * 油画流体背景 —— WebGL2 实时流体模拟 (Stable Fluids)
 * 鼠标划过 = 在画布上泼颜料。
 * 不支持 WebGL2 的设备自动降级为 CSS 渐变背景。
 * 对外暴露 window.FluidFX = { ready, burst(n), splat(...) }
 * ============================================================ */
(function () {
  "use strict";

  const canvas = document.getElementById("fluid");
  const FX = { ready: false, burst: function () {}, splat: function () {} };
  window.FluidFX = FX;
  if (!canvas) return;

  const gl = canvas.getContext("webgl2", {
    alpha: false, depth: false, stencil: false,
    antialias: false, preserveDrawingBuffer: false,
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
    document.body.classList.add("no-fluid");
    return;
  }

  /* ---------------- 配置 ---------------- */
  const CONF = {
    SIM_RES: 144,            // 速度场分辨率
    DYE_RES: 800,            // 颜料分辨率
    DENSITY_DISSIPATION: 0.72, // 颜料消散（越小留得越久）
    VELOCITY_DISSIPATION: 0.22,
    PRESSURE_ITER: 22,
    CURL: 24,                // 涡旋强度（略收敛，减少碎乱小漩涡）
    SPLAT_RADIUS: 0.0048,
    SPLAT_FORCE: 5200,
  };

  /* 协调色相系统：全局色相缓慢漂移，每次泼溅取邻近色相，
     画面始终是一族和谐的浓彩，而不是彩虹大乱炖 */
  let hueBase = Math.random() * 360;
  function hsv2rgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const m = i % 6;
    return m === 0 ? [v, t, p] : m === 1 ? [q, v, p] : m === 2 ? [p, v, t]
         : m === 3 ? [p, q, v] : m === 4 ? [t, p, v] : [v, p, q];
  }
  function paletteColor(scale) {
    const h = ((hueBase + (Math.random() * 80 - 40)) % 360 + 360) % 360;
    const s = 0.82 + Math.random() * 0.18;
    const c = hsv2rgb(h / 360, s, 1.0);
    const k = 0.24 * (scale || 1) * (0.7 + Math.random() * 0.6);
    return [c[0] * k, c[1] * k, c[2] * k];
  }

  /* ---------------- WebGL 基础 ---------------- */
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(vs, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  const VERT = compile(gl.VERTEX_SHADER, `#version 300 es
    precision highp float;
    in vec2 aPos;
    out vec2 vUv, vL, vR, vT, vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPos * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`);

  const HEAD = `#version 300 es
    precision highp float; precision highp sampler2D;
    in vec2 vUv, vL, vR, vT, vB; out vec4 fragColor;`;

  const progSplat = program(VERT, HEAD + `
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
      vec2 p = vUv - point;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture(uTarget, vUv).xyz;
      fragColor = vec4(base + splat, 1.0);
    }`);

  const progAdvect = program(VERT, HEAD + `
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform float dt;
    uniform float dissipation;
    void main () {
      vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
      vec4 result = texture(uSource, coord);
      float decay = 1.0 + dissipation * dt;
      fragColor = result / decay;
    }`);

  const progDiv = program(VERT, HEAD + `
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).x;
      float R = texture(uVelocity, vR).x;
      float T = texture(uVelocity, vT).y;
      float B = texture(uVelocity, vB).y;
      vec2 C = texture(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`);

  const progCurl = program(VERT, HEAD + `
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uVelocity, vL).y;
      float R = texture(uVelocity, vR).y;
      float T = texture(uVelocity, vT).x;
      float B = texture(uVelocity, vB).x;
      fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`);

  const progVort = program(VERT, HEAD + `
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;
    void main () {
      float L = texture(uCurl, vL).x;
      float R = texture(uCurl, vR).x;
      float T = texture(uCurl, vT).x;
      float B = texture(uCurl, vB).x;
      float C = texture(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 vel = texture(uVelocity, vUv).xy + force * dt;
      fragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
    }`);

  const progPressure = program(VERT, HEAD + `
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      float divergence = texture(uDivergence, vUv).x;
      fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }`);

  const progGrad = program(VERT, HEAD + `
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture(uPressure, vL).x;
      float R = texture(uPressure, vR).x;
      float T = texture(uPressure, vT).x;
      float B = texture(uPressure, vB).x;
      vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
      fragColor = vec4(vel, 0.0, 1.0);
    }`);

  const progDisplay = program(VERT, HEAD + `
    uniform sampler2D uTexture;
    uniform vec2 texelSize;
    void main () {
      vec3 c  = texture(uTexture, vUv).rgb;
      vec3 lc = texture(uTexture, vL).rgb;
      vec3 rc = texture(uTexture, vR).rgb;
      vec3 tc = texture(uTexture, vT).rgb;
      vec3 bc = texture(uTexture, vB).rgb;

      // 用颜料浓度梯度构造法线 → 侧光照亮，颜料呈现厚涂立体感
      float gx = length(rc) - length(lc);
      float gy = length(tc) - length(bc);
      vec3 n = normalize(vec3(gx, gy, length(texelSize) * 2.2));
      vec3 lightDir = normalize(vec3(-0.42, 0.55, 0.72));
      float diffuse = clamp(dot(n, lightDir) + 0.84, 0.58, 1.1);
      float spec = pow(clamp(reflect(-lightDir, n).z, 0.0, 1.0), 26.0)
                 * 0.26 * smoothstep(0.04, 0.5, length(c));

      // 柔和高光压缩，浓而不曝
      c = c / (1.0 + dot(c, vec3(0.26)));
      c = pow(c, vec3(0.87));
      c = c * diffuse + vec3(spec);

      vec3 bg = vec3(0.05, 0.042, 0.10);        // 深夜蓝紫画布底色
      float vig = smoothstep(1.4, 0.32, length(vUv - 0.5));
      fragColor = vec4(bg * vig + c, 1.0);
    }`);

  /* ---------------- 全屏四边形 ---------------- */
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.w, target.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* ---------------- FBO ---------------- */
  function createFBO(w, h, internal, format, type) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      tex, fbo, w, h,
      attach(unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        return unit;
      },
    };
  }
  function createDouble(w, h, internal, format, type) {
    let a = createFBO(w, h, internal, format, type);
    let b = createFBO(w, h, internal, format, type);
    return {
      w, h,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
    };
  }

  let dye, velocity, divergence, curlFBO, pressure;
  let simW, simH, dyeW, dyeH;

  function initFBOs() {
    const aspect = canvas.width / Math.max(1, canvas.height);
    const simMin = CONF.SIM_RES, dyeMin = CONF.DYE_RES;
    if (aspect > 1) {
      simW = Math.round(simMin * aspect); simH = simMin;
      dyeW = Math.round(dyeMin * aspect); dyeH = dyeMin;
    } else {
      simW = simMin; simH = Math.round(simMin / aspect);
      dyeW = dyeMin; dyeH = Math.round(dyeMin / aspect);
    }
    const HF = gl.HALF_FLOAT;
    dye = createDouble(dyeW, dyeH, gl.RGBA16F, gl.RGBA, HF);
    velocity = createDouble(simW, simH, gl.RG16F, gl.RG, HF);
    divergence = createFBO(simW, simH, gl.R16F, gl.RED, HF);
    curlFBO = createFBO(simW, simH, gl.R16F, gl.RED, HF);
    pressure = createDouble(simW, simH, gl.R16F, gl.RED, HF);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      initFBOs();
    }
  }

  /* ---------------- 泼颜料 ---------------- */
  function splat(x, y, dx, dy, color, radiusScale) {
    const r = CONF.SPLAT_RADIUS * (radiusScale || 1);
    gl.useProgram(progSplat.p);
    gl.uniform2f(progSplat.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progSplat.u.uTarget, velocity.read.attach(0));
    gl.uniform1f(progSplat.u.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(progSplat.u.point, x, y);
    gl.uniform3f(progSplat.u.color, dx, dy, 0);
    gl.uniform1f(progSplat.u.radius, r);
    blit(velocity.write); velocity.swap();

    gl.uniform2f(progSplat.u.texelSize, 1 / dyeW, 1 / dyeH);
    gl.uniform1i(progSplat.u.uTarget, dye.read.attach(0));
    gl.uniform3f(progSplat.u.color, color[0], color[1], color[2]);
    blit(dye.write); dye.swap();
  }

  FX.splat = function (x, y, dx, dy, color, radiusScale) {
    splat(x, y, dx, dy, color || paletteColor(1), radiusScale || 1);
  };

  // 商店道具：超级笔刷倍率
  let brushScale = 1;
  FX.setBrush = function (mult) { brushScale = mult || 1; };

  FX.burst = function (n) {
    const count = n || 8;
    for (let i = 0; i < count; i++) {
      const color = paletteColor(2.2);
      const x = Math.random();
      const y = Math.random();
      const dx = 900 * (Math.random() - 0.5);
      const dy = 900 * (Math.random() - 0.5);
      splat(x, y, dx, dy, color, 1.5 + Math.random() * 2.5);
    }
  };

  /* ---------------- 指针交互 ---------------- */
  const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, down: false, moved: false, color: paletteColor(1) };

  function updatePointer(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const x = (cx - rect.left) / rect.width;
    const y = 1 - (cy - rect.top) / rect.height;
    pointer.dx = (x - pointer.x) * CONF.SPLAT_FORCE;
    pointer.dy = (y - pointer.y) * CONF.SPLAT_FORCE;
    pointer.x = x;
    pointer.y = y;
    pointer.moved = Math.abs(pointer.dx) > 1 || Math.abs(pointer.dy) > 1;
  }
  window.addEventListener("pointermove", (e) => updatePointer(e.clientX, e.clientY), { passive: true });
  window.addEventListener("pointerdown", (e) => {
    updatePointer(e.clientX, e.clientY);
    pointer.color = paletteColor(1.6);
    splat(pointer.x, pointer.y, pointer.dx, pointer.dy, paletteColor(3), 3.5 * brushScale);
  }, { passive: true });
  // 每隔一段时间换一种颜料
  setInterval(() => { pointer.color = paletteColor(1); }, 2600);

  /* ---------------- 自动泼溅（保持画面活着，但克制） ---------------- */
  let nextAuto = performance.now() + 1600;
  function autoSplat(now) {
    if (now < nextAuto) return;
    nextAuto = now + 4200 + Math.random() * 3800;
    splat(
      0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7,
      520 * (Math.random() - 0.5), 520 * (Math.random() - 0.5),
      paletteColor(1.5), 1.4 + Math.random() * 1.6
    );
  }

  /* ---------------- 模拟主循环 ---------------- */
  let lastTime = performance.now();
  const prefersReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function step(dt) {
    gl.disable(gl.BLEND);

    gl.useProgram(progCurl.p);
    gl.uniform2f(progCurl.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progCurl.u.uVelocity, velocity.read.attach(0));
    blit(curlFBO);

    gl.useProgram(progVort.p);
    gl.uniform2f(progVort.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progVort.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progVort.u.uCurl, curlFBO.attach(1));
    gl.uniform1f(progVort.u.curl, CONF.CURL);
    gl.uniform1f(progVort.u.dt, dt);
    blit(velocity.write); velocity.swap();

    gl.useProgram(progDiv.p);
    gl.uniform2f(progDiv.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progDiv.u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    gl.useProgram(progPressure.p);
    gl.uniform2f(progPressure.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progPressure.u.uDivergence, divergence.attach(0));
    for (let i = 0; i < CONF.PRESSURE_ITER; i++) {
      gl.uniform1i(progPressure.u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    gl.useProgram(progGrad.p);
    gl.uniform2f(progGrad.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progGrad.u.uPressure, pressure.read.attach(0));
    gl.uniform1i(progGrad.u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    gl.useProgram(progAdvect.p);
    gl.uniform2f(progAdvect.u.texelSize, 1 / simW, 1 / simH);
    gl.uniform1i(progAdvect.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progAdvect.u.uSource, velocity.read.attach(0));
    gl.uniform1f(progAdvect.u.dt, dt);
    gl.uniform1f(progAdvect.u.dissipation, CONF.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(progAdvect.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(progAdvect.u.uSource, dye.read.attach(1));
    gl.uniform1f(progAdvect.u.dissipation, CONF.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.033) || 0.016;
    lastTime = now;
    resize();
    hueBase = (hueBase + dt * 9) % 360;   // 色相缓慢漂移

    if (pointer.moved) {
      pointer.moved = false;
      splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color, brushScale);
    }
    if (!prefersReduce) autoSplat(now);

    step(dt);

    gl.useProgram(progDisplay.p);
    gl.uniform2f(progDisplay.u.texelSize, 1 / dyeW, 1 / dyeH);
    gl.uniform1i(progDisplay.u.uTexture, dye.read.attach(0));
    blit(null);

    requestAnimationFrame(frame);
  }

  resize();
  initFBOs();
  FX.ready = true;
  // 开屏先来一波颜料
  FX.burst(prefersReduce ? 3 : 10);
  requestAnimationFrame(frame);
})();
