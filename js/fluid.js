/* ============================================================
 * 油画流体背景 —— WebGL2 实时流体模拟 (Stable Fluids)
 * 鼠标划过 = 在画布上泼颜料。
 *
 * 三档运行模式（开销从高到低）：
 *   full  桌面：持续模拟，滚过首屏后降到 30fps，页面不可见 / 档案页覆盖时完全停机
 *   lite  手机、触屏、低端设备：默认一帧不画，只在你触摸时醒来 1.5 秒再睡回去
 *   off   不支持 WebGL2：退回 CSS 渐变背景
 * 变暗与彩虹都在着色器里做，不再对整块画布叠 CSS filter（那等于每帧多一次全屏合成）。
 *
 * 对外暴露 window.FluidFX = {
 *   ready, mode, burst(n), splat(...), setBrush(k), setDim(v), setRainbow(b), hold(id, on)
 * }
 * ============================================================ */
(function () {
  "use strict";

  const canvas = document.getElementById("fluid");
  const FX = {
    ready: false, mode: "off",
    burst: noop, splat: noop, setBrush: noop, setDim: noop, setRainbow: noop, hold: noop,
  };
  function noop() {}
  window.FluidFX = FX;
  if (!canvas) return;

  const gl = canvas.getContext("webgl2", {
    alpha: false, depth: false, stencil: false,
    antialias: false, preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
    document.body.classList.add("no-fluid");
    return;
  }

  /* ---------------- 运行档位 ---------------- */
  const mql = (q) => window.matchMedia(q).matches;
  const prefersReduce = mql("(prefers-reduced-motion: reduce)");
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  // 触屏为主 / 窄屏 = 手机。这类设备跑满帧流体会直接烫手，一律降到 lite。
  const LITE = prefersReduce || saveData || mql("(pointer: coarse)") || window.innerWidth < 900;
  const MODE = LITE ? "lite" : "full";
  FX.mode = MODE;
  document.body.classList.add("fluid-" + MODE);

  /* ---------------- 配置 ---------------- */
  const CONF = LITE ? {
    SIM_RES: 96, DYE_RES: 384, MAX_DPR: 1,
    DENSITY_DISSIPATION: 0.72, VELOCITY_DISSIPATION: 0.25,
    PRESSURE_ITER: 8, CURL: 22,
    SPLAT_RADIUS: 0.0060, SPLAT_FORCE: 5200,
  } : {
    SIM_RES: 128, DYE_RES: 640, MAX_DPR: 1.75,
    DENSITY_DISSIPATION: 0.72, VELOCITY_DISSIPATION: 0.22,
    PRESSURE_ITER: 14, CURL: 24,
    SPLAT_RADIUS: 0.0048, SPLAT_FORCE: 5200,
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
    uniform float uDim;    // 正文区把背景压暗，替代整块画布的 CSS filter
    uniform float uHue;    // 彩虹秘技：色相旋转，替代 CSS hue-rotate 动画
    vec3 hueShift(vec3 col, float a) {
      const vec3 k = vec3(0.57735027);
      float cs = cos(a), sn = sin(a);
      return col * cs + cross(k, col) * sn + k * dot(k, col) * (1.0 - cs);
    }
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
      if (uHue != 0.0) c = hueShift(c, uHue);

      vec3 bg = vec3(0.05, 0.042, 0.10);        // 深夜蓝紫画布底色
      float vig = smoothstep(1.4, 0.32, length(vUv - 0.5));
      fragColor = vec4((bg * vig + c) * uDim, 1.0);
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
      dispose() { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); },
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
      dispose() { a.dispose(); b.dispose(); },
    };
  }

  let dye, velocity, divergence, curlFBO, pressure;
  let simW, simH, dyeW, dyeH;

  function initFBOs() {
    // 重建前先释放旧的，否则每次转屏都会漏一整套浮点纹理
    [dye, velocity, divergence, curlFBO, pressure].forEach((f) => f && f.dispose());
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
    const dpr = Math.min(window.devicePixelRatio || 1, CONF.MAX_DPR);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
      initFBOs();
      return true;
    }
    return false;
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
    wake();
  };

  // 商店道具：超级笔刷倍率
  let brushScale = 1;
  FX.setBrush = function (mult) { brushScale = mult || 1; };

  FX.burst = function (n) {
    const count = Math.min(n || 8, LITE ? 8 : 30);
    for (let i = 0; i < count; i++) {
      splat(Math.random(), Math.random(),
        900 * (Math.random() - 0.5), 900 * (Math.random() - 0.5),
        paletteColor(2.2), 1.5 + Math.random() * 2.5);
    }
    wake();
  };

  /* ---------------- 显示参数（着色器侧，不用 CSS filter） ---------------- */
  let dim = 1, dimTarget = 1;         // 1 = 全亮，滚进正文后压到 0.55
  let rainbow = false, hue = 0;
  // 变暗只需要补几帧过渡，不该像触摸那样把 lite 模式唤醒一整段时间——
  // 否则手机上每次滚动都会重新点着流体，等于没省。
  FX.setDim = function (v) { dimTarget = v; ensureLoop(); };
  FX.setRainbow = function (on) {
    rainbow = !!on;
    if (!on) hue = 0;
    else if (LITE) hue = 2.1;         // 手机上给一个固定色相偏移，不做每帧旋转
    if (LITE) renderOnce(); else ensureLoop();
  };

  /* ---------------- 停机闸门 ---------------- */
  // 档案页 / 结局这类全屏覆盖层打开时，背景一个像素都看不见，没有理由继续烧 GPU
  const holds = new Set();
  FX.hold = function (id, on) {
    if (on) { holds.add(id); sleep(); return; }
    holds.delete(id);
    if (holds.size) return;
    if (LITE) renderOnce(); else ensureLoop();
  };
  function blocked() { return holds.size > 0 || document.hidden; }

  /* ---------------- 指针交互 ---------------- */
  const pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, down: false, moved: false, color: paletteColor(1) };
  let colorSwapAt = 0;

  function updatePointer(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    const x = (cx - rect.left) / rect.width;
    const y = 1 - (cy - rect.top) / rect.height;
    pointer.dx = (x - pointer.x) * CONF.SPLAT_FORCE;
    pointer.dy = (y - pointer.y) * CONF.SPLAT_FORCE;
    pointer.x = x;
    pointer.y = y;
    pointer.moved = Math.abs(pointer.dx) > 1 || Math.abs(pointer.dy) > 1;
    if (pointer.moved) wake();
  }
  /* 桌面：鼠标划过即泼颜料，和以前一样。
     手机：整套手势判定的唯一目的，是让「滚动页面」这个动作一次流体都不触发——
     手指按下先不动手，等确认这一下不是在滚动，才把它当成画笔。
     否则用户每滑一次屏幕就点着一次流体，等于什么都没省。 */
  const gesture = { startX: 0, startY: 0, startScroll: 0, t0: 0, painting: false, scrolling: false };

  window.addEventListener("pointerdown", (e) => {
    pointer.down = true;
    if (!LITE) {
      updatePointer(e.clientX, e.clientY);
      pointer.color = paletteColor(1.6);
      splat(pointer.x, pointer.y, pointer.dx, pointer.dy, paletteColor(3), 3.5 * brushScale);
      wake();
      return;
    }
    gesture.startX = e.clientX;
    gesture.startY = e.clientY;
    gesture.startScroll = window.scrollY;
    gesture.t0 = e.timeStamp;
    gesture.painting = false;
    gesture.scrolling = false;
    // 先把指针位置对齐，避免之后第一笔带上一段跨越半个屏幕的假速度
    const rect = canvas.getBoundingClientRect();
    pointer.x = (e.clientX - rect.left) / rect.width;
    pointer.y = 1 - (e.clientY - rect.top) / rect.height;
  }, { passive: true });

  window.addEventListener("pointermove", (e) => {
    if (!LITE) { updatePointer(e.clientX, e.clientY); return; }
    if (!pointer.down || gesture.scrolling) return;
    if (window.scrollY !== gesture.startScroll) { gesture.scrolling = true; return; }  // 是在滚页面
    if (!gesture.painting) {
      const far = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 12;
      if (!far) return;
      gesture.painting = true;
      pointer.color = paletteColor(1.6);
    }
    updatePointer(e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener("pointerup", (e) => {
    pointer.down = false;
    if (!LITE || gesture.scrolling || gesture.painting) return;
    // 原地轻点 = 泼一大团颜料
    const still = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < 12;
    if (!still || e.timeStamp - gesture.t0 > 600) return;
    updatePointer(e.clientX, e.clientY);
    splat(pointer.x, pointer.y, 0, 0, paletteColor(3), 3.5 * brushScale);
    wake();
  }, { passive: true });

  window.addEventListener("pointercancel", () => { pointer.down = false; gesture.scrolling = true; }, { passive: true });

  /* ---------------- 自动泼溅（只在桌面，保持画面活着但克制） ---------------- */
  let nextAuto = 0;
  function autoSplat(now) {
    if (LITE || prefersReduce || now < nextAuto) return;
    nextAuto = now + 4200 + Math.random() * 3800;
    splat(
      0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7,
      520 * (Math.random() - 0.5), 520 * (Math.random() - 0.5),
      paletteColor(1.5), 1.4 + Math.random() * 1.6
    );
  }

  /* ---------------- 模拟主循环 ---------------- */
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

  function draw() {
    gl.useProgram(progDisplay.p);
    gl.uniform2f(progDisplay.u.texelSize, 1 / dyeW, 1 / dyeH);
    gl.uniform1i(progDisplay.u.uTexture, dye.read.attach(0));
    gl.uniform1f(progDisplay.u.uDim, dim);
    gl.uniform1f(progDisplay.u.uHue, hue);
    blit(null);
  }

  /* ---------------- 调度：只在需要的时候持有 rAF ---------------- */
  let rafId = 0;
  let lastTime = 0;
  let acc = 0;
  let awakeUntil = 0;          // lite 模式：交互后再多跑这么久
  const LITE_AWAKE_MS = 1500;

  function ensureLoop() {
    if (rafId || blocked()) return;
    lastTime = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(frame);
  }
  function wake() {
    awakeUntil = performance.now() + LITE_AWAKE_MS;
    ensureLoop();
  }
  function sleep() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }
  // 只重画一帧：颜料还完整存在我们自己的 FBO 里，重绘就是一次全屏 pass，几乎免费
  function renderOnce() { if (!blocked()) draw(); }

  // 滚进正文后降到 30fps：背景这时已经被压暗且大半被卡片盖住，60 帧纯属浪费
  function frameInterval() {
    if (LITE) return 1000 / 40;
    return dimTarget < 0.9 ? 1000 / 30 : 1000 / 60;
  }

  function frame(now) {
    rafId = 0;
    if (blocked()) return;                       // 覆盖层打开 / 标签页隐藏 → 彻底停机

    acc += now - lastTime;
    lastTime = now;
    if (acc >= frameInterval()) {
      const dt = Math.min(acc / 1000, 0.033) || 0.016;
      acc = 0;

      hueBase = (hueBase + dt * 9) % 360;
      if (rainbow && !LITE) hue = (hue + dt * 1.6) % 6.2831853;
      dim += (dimTarget - dim) * Math.min(1, dt * 6);   // 明暗过渡在着色器里做

      // lite 模式下滚动引起的明暗过渡不需要推进流体——只重画就够了，
      // 省掉这段时间里几十次完整的压力求解。
      const simulate = !LITE || now < awakeUntil;
      if (simulate) {
        if (now - colorSwapAt > 2600) { colorSwapAt = now; pointer.color = paletteColor(1); }
        if (pointer.moved) {
          pointer.moved = false;
          splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color, brushScale);
        }
        autoSplat(now);
        step(dt);
      }
      draw();
    }

    // full 一直转；lite 只在交互后的窗口期内转，随后完全释放 rAF
    if (!LITE || now < awakeUntil || Math.abs(dim - dimTarget) > 0.005) {
      rafId = requestAnimationFrame(frame);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { sleep(); return; }
    if (LITE) renderOnce(); else ensureLoop();
  });
  // 窗口失焦（切到别的应用、另一个窗口盖住）时 visibilitychange 不会触发，
  // 但这时没人在看背景。画布会保留最后一帧，停机不会有任何视觉跳变。
  window.addEventListener("blur", () => { holds.add("blur"); sleep(); });
  window.addEventListener("focus", () => {
    holds.delete("blur");
    if (LITE) renderOnce(); else ensureLoop();
  });

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    sleep();
    document.body.classList.add("no-fluid");
    FX.ready = false;
  });

  // 手机地址栏收放也会派发 resize；只有画布尺寸真的变了（转屏）才重建，
  // 否则每次滚动都要重铺一整套浮点纹理并重新暖机。
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!resize()) return;
      paintInitial();
      if (!LITE) ensureLoop();
    }, 250);
  }, { passive: true });

  /* ---------------- 起手：先画出一幅静态油画 ---------------- */
  function paintInitial() {
    const bursts = LITE ? 5 : 9;
    for (let i = 0; i < bursts; i++) {
      splat(Math.random(), Math.random(),
        900 * (Math.random() - 0.5), 900 * (Math.random() - 0.5),
        paletteColor(2.2), 2 + Math.random() * 2.5);
    }
    // 一次性把颜料推开成厚涂质感——lite 模式下这几十步就是全部开销，之后彻底静止
    const warm = LITE ? 46 : 26;
    for (let i = 0; i < warm; i++) step(0.016);
    draw();
  }

  resize();
  if (!dye) initFBOs();
  FX.ready = true;
  paintInitial();
  if (!LITE) wake();
})();
