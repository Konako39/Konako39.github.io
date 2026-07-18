/* ============================================================
 * KONAKO ～被夺走的公主～ 游戏主逻辑
 * 多语言 / 存档 / 金币 / 商店 / 任务 / 钥匙 / 成就 / 结局
 * ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const MAINS = PROJECTS.filter((p) => p.featured);
  const SIDES = PROJECTS.filter((p) => !p.featured);
  const KEYS_NEEDED = MAINS.length;

  /* ================= 静态文案注入 ================= */
  document.documentElement.lang = { zh: "zh-CN", en: "en", ja: "ja" }[LANG];
  document.title = T("htmlTitle");
  if (LANG === "ja") document.body.classList.add("lang-ja");
  $$("[data-i18n]").forEach((el) => { el.textContent = T(el.dataset.i18n); });
  $$("[data-i18n-html]").forEach((el) => { el.innerHTML = T(el.dataset.i18nHtml); });
  $$(".lang-switch button").forEach((b) => {
    if (b.dataset.lang === LANG) b.classList.add("cur");
    b.addEventListener("click", () => {
      try { localStorage.setItem("konako_lang", b.dataset.lang); } catch (e) {}
      location.reload();
    });
  });

  /* ================= 存档 ================= */
  const SAVE_KEY = "konako_save_v1";
  let save = { coins: 0, quests: {}, ach: [], picked: [], shop: {}, shopOn: {}, ended: false };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) save = Object.assign(save, JSON.parse(raw));
  } catch (e) { /* 无痕模式下静默降级 */ }
  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
  }

  /* ================= 成就系统 ================= */
  const ACH_TOTAL = 19;
  const toastStack = $("#toast-stack");

  function toast(icon, title, detail, cls) {
    const el = document.createElement("div");
    el.className = "toast " + (cls || "");
    el.innerHTML =
      '<div class="toast-icon">' + icon + "</div>" +
      '<div class="toast-body"><div class="toast-title">' + title + "</div>" +
      '<div class="toast-detail">' + detail + "</div></div>";
    toastStack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 600);
    }, 4200);
  }

  function achieve(id) {
    if (save.ach.includes(id)) return;
    save.ach.push(id);
    persist();
    const a = T("ach")[id] || I18N.zh.ui.ach[id] || [id, ""];
    toast("🏆", T("achToast") + a[0], a[1]);
    addCoins(20, null, true);
    addXP(120);
    renderQuestLog();
  }
  // T() 只做字符串；成就表单独取
  function achData(id) {
    const table = I18N[LANG].ui.ach || I18N.zh.ui.ach;
    return table[id] || I18N.zh.ui.ach[id] || [id, ""];
  }

  /* ================= HUD / 经验 / 金币 ================= */
  let xp = 0;
  const hudLevel = $("#hud-level");
  const hudExpFill = $("#hud-exp .bar-fill");
  const hudCoins = $("#hud-coins");

  function addXP(n) { xp += n; renderHUD(); }

  function addCoins(n, evt, silent) {
    save.coins += n;
    persist();
    syncCoins();
    if (evt) coinFloat(evt.clientX, evt.clientY, "+" + n);
    if (!silent && n >= 50) toast("💰", T("coinT", { n }), T("coinD"));
    if (save.coins >= 500) achieve("rich");
    renderHUD();
  }
  function spendCoins(n) {
    if (save.coins < n) return false;
    save.coins -= n;
    persist();
    syncCoins();
    return true;
  }
  function syncCoins() {
    hudCoins.textContent = save.coins;
    $("#ql-coins").textContent = save.coins;
    $("#shop-coins").textContent = save.coins;
  }

  function coinFloat(x, y, text) {
    const el = document.createElement("div");
    el.className = "coin-float";
    el.textContent = text;
    el.style.left = x + "px";
    el.style.top = y + "px";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  function scrollProgress() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, window.scrollY / max) : 0;
  }
  function renderHUD() {
    const p = scrollProgress();
    const level = 1 + Math.floor(p * 4 + xp / 500);
    hudLevel.textContent = level;
    hudExpFill.style.width = (((p * 4 + xp / 500) % 1) * 100).toFixed(1) + "%";
    $("#hud-keys").innerHTML = MAINS.map((m) =>
      '<span class="key ' + (save.quests[m.id] ? "on" : "") + '">🔑</span>'
    ).join("");
  }
  window.addEventListener("scroll", () => {
    renderHUD();
    // 滚过首屏一半后调暗背景，保证正文可读
    document.body.classList.toggle("dim-bg", window.scrollY > window.innerHeight * 0.55);
    if (scrollProgress() > 0.96) achieve("explore");
  }, { passive: true });

  function keysOwned() { return MAINS.filter((m) => save.quests[m.id]).length; }
  function questsDone() { return PROJECTS.filter((p) => save.quests[p.id]).length; }

  /* ================= 泼颜料计数成就 ================= */
  let paintClicks = 0;
  window.addEventListener("pointerdown", () => {
    paintClicks++;
    if (paintClicks >= 10) achieve("painter");
  }, { passive: true });

  /* ================= 页面金币 ================= */
  const COIN_SPOTS = [
    { sec: "#hero", top: 24, left: 12 }, { sec: "#hero", top: 62, left: 86 },
    { sec: "#stats", top: 12, left: 78 }, { sec: "#stats", top: 70, left: 5 },
    { sec: "#main-quest", top: 8, left: 55 }, { sec: "#main-quest", top: 50, left: 3 },
    { sec: "#side-quests", top: 6, left: 90 }, { sec: "#side-quests", top: 45, left: 2 }, { sec: "#side-quests", top: 80, left: 94 },
    { sec: "#boss-gate", top: 15, left: 10 },
  ];
  function spawnCoins() {
    COIN_SPOTS.forEach((c, i) => {
      const id = "c" + i;
      if (save.picked.includes(id)) return;
      const sec = $(c.sec);
      if (!sec) return;
      const el = document.createElement("button");
      el.className = "coin";
      el.dataset.coin = id;
      el.style.top = c.top + "%";
      el.style.left = c.left + "%";
      el.style.animationDelay = (i * 0.3) + "s";
      sec.appendChild(el);
    });
  }
  function pickCoin(el, evt) {
    const id = el.dataset.coin;
    if (save.picked.includes(id)) return;
    save.picked.push(id);
    addCoins(10, null, true);
    coinFloat(evt.clientX, evt.clientY, "+10");
    el.classList.add("got");           // 向上渐变悬浮消失
    setTimeout(() => el.remove(), 750);
    if (window.FluidFX.ready) {
      window.FluidFX.splat(evt.clientX / innerWidth, 1 - evt.clientY / innerHeight, 0, 400, [0.5, 0.35, 0], 2);
    }
    if (save.picked.length >= COIN_SPOTS.length) achieve("coinall");
  }

  /* ================= 项目渲染 ================= */
  function tagChips(tags) {
    return tags.map((t) => '<span class="chip">' + t + "</span>").join("");
  }
  function techRow(p) {
    if (!p.tech) return "";
    let html = '<div class="tech-row"><span class="tech-label">' + T("techLabel") + "</span>" +
      (LP(p, "tech") || p.tech).map((t) => '<span class="chip tech-chip">' + t + "</span>").join("") + "</div>";
    if (p.vibe != null) {
      html += `
        <div class="vibe-row">
          <span class="vibe-label">✨ ${T("vibeLabel")}</span>
          <div class="vibe-bar"><div class="vibe-fill" data-v="${p.vibe}"></div></div>
          <b class="vibe-num">${p.vibe}%</b>
        </div>`;
    }
    return html;
  }
  // VibeCoding 条：进入视野后从 0 平滑充能到目标值
  // 注意：必须观察有面积的外框，宽度为 0 的填充元素永远不会触发阈值
  function armVibeBars(root) {
    $$(".vibe-bar", root || document).forEach((bar) => {
      if (bar.dataset.armed) return;
      bar.dataset.armed = "1";
      const fill = $(".vibe-fill", bar);
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          setTimeout(() => { fill.style.width = fill.dataset.v + "%"; }, 150);
          io.unobserve(bar);
        });
      }, { threshold: 0.4 });
      io.observe(bar);
    });
  }
  function steamBtn(p, cls) {
    return p.steam
      ? '<a class="' + (cls || "btn-ghost") + ' steam-btn" href="' + p.steam +
        '" target="_blank" rel="noopener" data-steam="1">' + T("steamBtn") + "</a>"
      : "";
  }
  function paperBtn(p, cls) {
    return p.paper
      ? '<a class="' + (cls || "btn-ghost") + ' paper-btn" href="' + p.paper +
        '" target="_blank" rel="noopener">' + T("paperBtn") + "</a>"
      : "";
  }

  function renderFeatured() {
    const host = $("#featured-host");
    MAINS.forEach((p, i) => {
      const done = !!save.quests[p.id];
      const el = document.createElement("article");
      el.className = "featured-card reveal" + (done ? " done" : "");
      el.id = "card-" + p.id;
      el.innerHTML = `
        <div class="featured-media">
          <img src="${p.thumb}" alt="${LP(p, "title")}" loading="lazy">
          <div class="featured-frame"></div>
          <div class="boss-tag">${T("bossTag")} ${String(i + 1).padStart(2, "0")}</div>
          <div class="key-tag">${done ? T("keyTagDone") : T("keyTagHas")}</div>
        </div>
        <div class="featured-info">
          <div class="quest-line">MAIN QUEST ${String(i + 1).padStart(2, "0")}</div>
          <h3 class="featured-title">${LP(p, "title")}<span class="featured-sub">${p.subtitle}</span></h3>
          <div class="type-line">${LP(p, "type")}</div>
          <div class="chips">${tagChips(LP(p, "tags") || p.tags)}</div>
          ${techRow(p)}
          <p class="featured-desc">${LP(p, "desc")[0]}</p>
          <div class="card-actions">
            <button class="btn-primary" data-open="${p.id}">${done ? T("reopenFile") : T("openFile")}</button>
            ${steamBtn(p)}${paperBtn(p)}
          </div>
        </div>`;
      host.appendChild(el);
    });
  }

  function renderSide() {
    const host = $("#side-host");
    SIDES.forEach((p, i) => {
      const done = !!save.quests[p.id];
      const el = document.createElement("article");
      el.className = "side-card reveal" + (done ? " done" : "");
      el.id = "card-" + p.id;
      el.style.transitionDelay = (i * 0.08) + "s";
      el.innerHTML = `
        <div class="side-media">
          <img src="${p.thumb}" alt="${LP(p, "title")}" loading="lazy">
          <div class="side-num">SIDE QUEST ${String(i + 1).padStart(2, "0")}</div>
          <div class="done-stamp">${T("doneStamp")}</div>
        </div>
        <div class="side-body">
          <h4 class="side-title"><img class="side-icon" src="${p.icon}" alt="" loading="lazy">${LP(p, "title")}</h4>
          <div class="type-line">${LP(p, "type")}</div>
          <p class="side-desc">${LP(p, "short")}</p>
          ${techRow(p)}
          <div class="chips">${tagChips(LP(p, "tags") || p.tags)}</div>
          <button class="btn-ghost" data-open="${p.id}">${done ? T("viewIntelDone") : T("viewIntel")}</button>
        </div>`;
      host.appendChild(el);
    });

    const slot = document.createElement("article");
    slot.className = "side-card slot reveal";
    slot.id = "slot-card";
    slot.innerHTML = `
      <div class="slot-inner">
        <div class="slot-q">?</div>
        <div class="slot-text">${T("slotText")}</div>
        <div class="slot-hint">${T("slotHint")}</div>
      </div>`;
    host.appendChild(slot);
  }

  /* ================= 任务日志（可点击跳转 + 成就大全） ================= */
  const ACH_IDS = ["begin", "main", "side", "gate", "intel", "quest1", "allquests",
    "keymaster", "painter", "rich", "coinall", "patience", "explore", "curious",
    "poke", "konami", "steam", "shopper", "hero"];

  function qlItem(m) {
    return "<li class='" + (save.quests[m.id] ? "done" : "") + "' data-goto='" + m.id + "'>" +
      (save.quests[m.id] ? "☑" : "☐") + " " + LP(m, "title") + "</li>";
  }
  function renderQuestLog() {
    $("#ql-keys").textContent = keysOwned() + " / " + KEYS_NEEDED;
    $("#ql-mains").innerHTML = MAINS.map(qlItem).join("");
    $("#ql-sides").innerHTML = SIDES.map(qlItem).join("");
    $("#ql-coins").textContent = save.coins;
    $("#ql-ach").textContent = save.ach.length + " / " + ACH_TOTAL;
    $("#ql-ach-list").innerHTML = ACH_IDS.map((id) => {
      if (!save.ach.includes(id)) return "<li class='locked'>🔒 " + T("achLocked") + "</li>";
      const a = achData(id);
      return "<li class='on'>🏆 <b>" + a[0] + "</b><span>" + a[1] + "</span></li>";
    }).join("");
  }
  $("#quest-toggle").addEventListener("click", () => {
    $("#quest-log").classList.toggle("open");
  });
  $("#ql-ach-toggle").addEventListener("click", () => {
    $("#ql-ach-list").classList.toggle("open");
    $("#ql-ach-toggle").classList.toggle("open");
  });

  /* ================= 全屏特效：闪光 / 震屏 / 飘浮颜料粒 ================= */
  function screenFlash() {
    const f = $("#fx-flash");
    f.classList.remove("go");
    void f.offsetWidth;
    f.classList.add("go");
  }
  function screenShake() {
    document.body.classList.remove("shake");
    void document.body.offsetWidth;
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 500);
  }
  function spawnEmbers() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const hues = ["#ff4e00", "#e900ff", "#00e5ff", "#b8ff00", "#ffb300"];
    for (let i = 0; i < 14; i++) {
      const d = document.createElement("div");
      d.className = "ember";
      const size = 3 + Math.random() * 6;
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.random() * 100 + "vw";
      d.style.background = hues[i % hues.length];
      d.style.animationDuration = (9 + Math.random() * 14) + "s";
      d.style.animationDelay = (-Math.random() * 20) + "s";
      document.body.appendChild(d);
    }
  }
  function gotoCard(id) {
    const card = $("#card-" + id);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;   // 重启动画
    card.classList.add("flash");
    if (window.innerWidth < 900) $("#quest-log").classList.remove("open");
  }

  /* ================= 魔王城 ================= */
  function renderGate() {
    const got = keysOwned();
    $("#gate-slots").innerHTML = MAINS.map((m) =>
      '<div class="gate-slot ' + (save.quests[m.id] ? "on" : "") + '">' +
      (save.quests[m.id] ? "🔑" : "🕳") + "</div>"
    ).join("");
    const btn = $("#btn-gate");
    if (got >= KEYS_NEEDED) {
      btn.disabled = false;
      btn.textContent = save.ended ? T("gateAgain") : T("gateOpen");
      $("#gate-desc").textContent = T("gateDescReady");
      achieve("keymaster");
    } else {
      btn.disabled = true;
      btn.textContent = T("gateLocked", { n: got, m: KEYS_NEEDED });
      $("#gate-desc").textContent = T("gateDesc");
    }
  }

  /* ================= 任务完成 ================= */
  function completeQuest(id, evt) {
    const p = PROJECTS.find((x) => x.id === id);
    if (!p || save.quests[id]) return;
    save.quests[id] = true;
    persist();
    const isMain = p.featured;
    addCoins(isMain ? 150 : 80, evt, true);
    toast(isMain ? "🔑" : "✅",
      isMain ? T("keyGotT", { t: LP(p, "title") }) : T("sideDoneT", { t: LP(p, "title") }),
      isMain ? T("keyGotD", { n: keysOwned(), m: KEYS_NEEDED }) : T("sideDoneD"),
      isMain ? "key-toast" : "");
    addXP(200);
    if (questsDone() === 1) achieve("quest1");
    if (questsDone() >= PROJECTS.length) achieve("allquests");
    const card = $("#card-" + id);
    if (card) {
      card.classList.add("done");
      const openBtn = $("[data-open]", card);
      if (openBtn) openBtn.textContent = isMain ? T("reopenFile") : T("viewIntelDone");
      const keyTag = $(".key-tag", card);
      if (keyTag) keyTag.textContent = T("keyTagDone");
    }
    renderQuestLog();
    renderGate();
    renderHUD();
    // 舞台页里完成任务 → 原地刷新完成区
    if (stageId === id) {
      const zone = $("#stage-complete");
      if (zone) zone.innerHTML = completeZone(p);
    }
    if (window.FluidFX.ready) window.FluidFX.burst(isMain ? 10 : 5);
    if (isMain) { screenFlash(); screenShake(); }
  }

  /* ================= 项目档案 · 全屏舞台页 ================= */
  const stage = $("#stage");
  let stageId = null;          // 当前打开的项目
  let stageGallery = [];       // 当前舞台的可放大图片列表

  function completeZone(p) {
    const done = !!save.quests[p.id];
    return done
      ? '<div class="quest-done-mark">' + T("doneMark") + (p.featured ? T("doneMarkKey") : "") + "</div>"
      : '<button class="btn-primary quest-complete" data-complete="' + p.id + '">' +
        (p.featured ? T("completeMain") : T("completeSide")) + "</button>";
  }

  function stageMediaRow(p, m, idx) {
    const label = LPMedia(p, idx);
    const text = LPMediaText(p, idx);
    const media = m.video
      ? `<video src="${m.src}" poster="${m.poster || ""}" controls muted loop playsinline preload="none"></video>`
      : `<img src="${m.src}" alt="${label}" loading="lazy" decoding="async" data-zoom="${idx}">`;
    return `
      <div class="st-row ${idx % 2 ? "rev" : ""}">
        <figure class="st-media">${media}</figure>
        <div class="st-txt">
          <div class="st-num">${String(idx + 1).padStart(2, "0")}</div>
          <h3>${m.video ? "▶ " : ""}${label}</h3>
          <p>${text || ""}</p>
          ${m.video ? "" : '<div class="st-zoom-hint">🔍 ' + T("zoomHint") + "</div>"}
        </div>
      </div>`;
  }

  function nextProject(id) {
    const i = PROJECTS.findIndex((x) => x.id === id);
    return PROJECTS[(i + 1) % PROJECTS.length];
  }

  function renderStage(id) {
    const p = PROJECTS.find((x) => x.id === id);
    if (!p) return false;
    stageId = id;
    stageGallery = p.media.map((m, i) => ({ m, i })).filter((x) => !x.m.video);
    const np = nextProject(id);
    stage.innerHTML = `
      <div class="stage-scroll" style="--acc:${p.accent || "#ffb300"}">
        <button class="stage-back">← ${T("backToMap")}</button>
        <header class="st-hero">
          <img class="st-hero-bg" src="${p.thumb}" alt="">
          <div class="st-hero-grad"></div>
          <div class="st-hero-inner">
            <div class="quest-line">${p.featured ? "MAIN QUEST" : "SIDE QUEST"} · ${T("modalFile")}</div>
            <h1 class="st-title">${LP(p, "title")}</h1>
            <div class="st-sub">${p.subtitle}</div>
            <div class="type-line">${LP(p, "type")}</div>
            <div class="chips">${tagChips(LP(p, "tags") || p.tags)}</div>
            ${techRow(p)}
            <div class="card-actions">${steamBtn(p, "btn-primary")}${paperBtn(p)}</div>
          </div>
        </header>
        <section class="st-intro">
          ${LP(p, "desc").map((d) => `<p>${d}</p>`).join("")}
        </section>
        <section class="st-showcase">${p.media.map((m, i) => stageMediaRow(p, m, i)).join("")}</section>
        <footer class="st-foot">
          <div class="quest-complete-zone" id="stage-complete">${completeZone(p)}</div>
          <div class="st-foot-nav">
            <button class="btn-ghost stage-back">← ${T("backToMap")}</button>
            <button class="btn-ghost st-next" data-stage-open="${np.id}">${T("nextFile")}：${LP(np, "title")} →</button>
          </div>
        </footer>
      </div>`;
    stage.classList.add("open");
    stage.scrollTop = 0;
    document.body.style.overflow = "hidden";
    armVibeBars(stage);
    achieve("intel");
    if (window.FluidFX.ready) window.FluidFX.burst(4);
    return true;
  }

  function openStage(id) {
    if (!renderStage(id)) return;
    if (location.hash !== "#p/" + id) {
      history.pushState(null, "", "#p/" + id);
    }
  }

  function closeStage(skipHistory) {
    stage.classList.remove("open");
    stage.innerHTML = "";
    stageId = null;
    document.body.style.overflow = "";
    if (!skipHistory && location.hash.startsWith("#p/")) {
      history.pushState(null, "", location.pathname + location.search);
    }
  }

  // 浏览器前进/后退 与 hash 深链接
  function syncFromHash() {
    const mHash = location.hash.match(/^#p\/(.+)$/);
    if (mHash && PROJECTS.some((p) => p.id === mHash[1])) {
      renderStage(mHash[1]);
    } else if (stageId) {
      closeStage(true);
    }
  }
  window.addEventListener("popstate", syncFromHash);

  /* ================= 图片灯箱 ================= */
  const lightbox = $("#lightbox");
  let lbIndex = 0;

  function openLightbox(gi) {
    if (!stageGallery.length) return;
    lbIndex = ((gi % stageGallery.length) + stageGallery.length) % stageGallery.length;
    const p = PROJECTS.find((x) => x.id === stageId);
    const item = stageGallery[lbIndex];
    $("#lb-img").src = item.m.src;
    $("#lb-caption").textContent =
      (lbIndex + 1) + " / " + stageGallery.length + " · " + LPMedia(p, item.i);
    lightbox.classList.add("open");
  }
  function stepLightbox(d) { openLightbox(lbIndex + d); }
  function closeLightbox() { lightbox.classList.remove("open"); $("#lb-img").src = ""; }

  /* ================= 商店 ================= */
  const SHOP_ITEMS = [
    { id: "fireworks", icon: "🎆", price: 50, kind: "repeat" },
    { id: "goldrain", icon: "🌧", price: 150, kind: "repeat" },
    { id: "brush", icon: "🖌", price: 200, kind: "toggle" },
    { id: "rainbow", icon: "🌈", price: 300, kind: "toggle" },
    { id: "letter", icon: "💌", price: 500, kind: "once" },
  ];
  function shopName(it) { return T("shop" + it.id.charAt(0).toUpperCase() + it.id.slice(1)); }
  function shopDesc(it) { return T("shop" + it.id.charAt(0).toUpperCase() + it.id.slice(1) + "D"); }

  function renderShop() {
    $("#shop-items").innerHTML = SHOP_ITEMS.map((it) => {
      const owned = !!save.shop[it.id];
      let btnTxt, btnCls = "btn-primary";
      if (it.kind === "repeat") { btnTxt = owned ? T("use") : T("buy"); }
      else if (it.kind === "toggle" && owned) { btnTxt = save.shopOn[it.id] ? T("on") : T("off"); btnCls = "btn-ghost"; }
      else if (it.kind === "once" && owned) { btnTxt = T("read"); btnCls = "btn-ghost"; }
      else { btnTxt = T("buy"); }
      return `
        <div class="shop-item ${owned ? "owned" : ""}">
          <div class="shop-ico">${it.icon}</div>
          <div class="shop-name">${shopName(it)}</div>
          <div class="shop-desc">${shopDesc(it)}</div>
          <div class="shop-price"><div class="hud-coin-ico"></div>${it.price}${owned && it.kind !== "repeat" ? ' · <i>' + T("owned") + "</i>" : ""}</div>
          <button class="${btnCls} shop-buy" data-item="${it.id}">${btnTxt}</button>
        </div>`;
    }).join("");
    syncCoins();
  }

  function applyToggles() {
    if (window.FluidFX.ready) window.FluidFX.setBrush(save.shopOn.brush ? 2.6 : 1);
    document.body.classList.toggle("rainbow", !!save.shopOn.rainbow);
  }

  function goldRain() {
    for (let i = 0; i < 44; i++) {
      setTimeout(() => {
        const d = document.createElement("div");
        d.className = "gold-drop";
        d.textContent = "🪙";
        d.style.left = Math.random() * 100 + "vw";
        d.style.animationDuration = (2 + Math.random() * 2.5) + "s";
        d.style.fontSize = (14 + Math.random() * 22) + "px";
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 5000);
      }, i * 320);
    }
  }

  function shopAction(itemId, evt) {
    const it = SHOP_ITEMS.find((x) => x.id === itemId);
    if (!it) return;
    const owned = !!save.shop[it.id];

    // 已拥有的开关型 / 一次型：免费使用
    if (owned && it.kind === "toggle") {
      save.shopOn[it.id] = !save.shopOn[it.id];
      persist(); applyToggles(); renderShop();
      return;
    }
    if (owned && it.kind === "once") { openLetter(); return; }

    // 付费（repeat 每次都付）
    if (!spendCoins(it.price)) { toast("💸", T("noCoinsT"), T("noCoinsD")); return; }
    save.shop[it.id] = true;
    if (it.kind === "toggle") save.shopOn[it.id] = true;
    persist();
    achieve("shopper");
    toast("🛒", T("boughtT") + " · " + shopName(it), T("boughtD", { p: it.price }));

    if (it.id === "fireworks" && window.FluidFX.ready) window.FluidFX.burst(25);
    if (it.id === "goldrain") goldRain();
    if (it.id === "letter") openLetter();
    applyToggles();
    renderShop();
  }

  function openLetter() {
    $("#shop").classList.remove("open");
    $("#letter").classList.add("open");
  }

  /* ================= 结局（对话随支线完成情况变化） ================= */
  function buildEndingLines() {
    const lines = [
      { t: T("endPlace"), cls: "el-place" },
      { t: T("endBoss1"), cls: "" },
    ];
    const doneSides = SIDES.filter((s) => save.quests[s.id]);
    if (doneSides.length === 0) {
      lines.push({ t: T("endSideNone"), cls: "" });
    } else {
      doneSides.forEach((s) => {
        const key = "endSide_" + s.id;
        const txt = I18N[LANG].ui[key] || I18N.zh.ui[key];
        if (txt) lines.push({ t: txt, cls: "" });
      });
    }
    lines.push(
      { t: T("endBossLose"), cls: "" },
      { t: "👸", cls: "el-princess" },
      { t: T("endRescued"), cls: "el-big" },
      { t: T("endTreasure"), cls: "el-gold" },
      { t: T("endFin"), cls: "el-fin" },
    );
    return lines;
  }

  let endingTimer = null;
  function playEnding() {
    save.ended = true;
    persist();
    const ending = $("#ending");
    const lines = $("#ending-lines");
    const stats = $("#ending-stats");
    const actions = $("#ending-actions");
    lines.innerHTML = ""; stats.innerHTML = ""; actions.innerHTML = "";
    ending.classList.add("open");
    document.body.style.overflow = "hidden";
    screenFlash();
    screenShake();
    achieve("hero");

    const SCRIPT = buildEndingLines();
    let i = 0;
    clearInterval(endingTimer);
    endingTimer = setInterval(() => {
      if (i < SCRIPT.length) {
        const l = SCRIPT[i++];
        const div = document.createElement("div");
        div.className = "el " + l.cls;
        div.textContent = l.t;
        lines.appendChild(div);
        requestAnimationFrame(() => div.classList.add("show"));
        if (window.FluidFX.ready) window.FluidFX.burst(3);
      } else {
        clearInterval(endingTimer);
        stats.innerHTML =
          "<div>" + T("endCoins") + " <b>" + save.coins + "</b></div>" +
          "<div>" + T("endAch") + " <b>" + save.ach.length + " / " + ACH_TOTAL + "</b></div>" +
          "<div>" + T("endQuests") + " <b>" + questsDone() + " / " + PROJECTS.length + "</b></div>";
        actions.innerHTML =
          '<button class="btn-primary" id="btn-again">' + T("endAgain") + "</button>" +
          '<button class="btn-ghost" id="btn-free">' + T("endFree") + "</button>";
      }
    }, 1400);
  }
  function closeEnding() {
    $("#ending").classList.remove("open");
    document.body.style.overflow = "";
    renderGate();
  }

  /* ================= 全局点击路由 ================= */
  document.addEventListener("click", (e) => {
    const coin = e.target.closest(".coin");
    if (coin) { pickCoin(coin, e); return; }
    const goto = e.target.closest("[data-goto]");
    if (goto) { gotoCard(goto.dataset.goto); return; }
    const opener = e.target.closest("[data-open]");
    if (opener) { openStage(opener.dataset.open); return; }
    const stOpener = e.target.closest("[data-stage-open]");
    if (stOpener) { openStage(stOpener.dataset.stageOpen); return; }
    const completer = e.target.closest("[data-complete]");
    if (completer) { completeQuest(completer.dataset.complete, e); return; }
    const zoomImg = e.target.closest("[data-zoom]");
    if (zoomImg) {
      const idx = +zoomImg.dataset.zoom;
      const gi = stageGallery.findIndex((x) => x.i === idx);
      if (gi >= 0) openLightbox(gi);
      return;
    }
    if (e.target.closest(".lb-prev")) { stepLightbox(-1); return; }
    if (e.target.closest(".lb-next")) { stepLightbox(1); return; }
    if (e.target.closest(".lb-close") || e.target === lightbox) { closeLightbox(); return; }
    if (e.target.closest(".stage-back")) { closeStage(); return; }
    const shopBuy = e.target.closest(".shop-buy");
    if (shopBuy) { shopAction(shopBuy.dataset.item, e); return; }
    if (e.target.closest("#btn-shop-open")) { renderShop(); $("#shop").classList.add("open"); return; }
    if (e.target.closest("#shop-close") || e.target === $("#shop")) { $("#shop").classList.remove("open"); return; }
    if (e.target.closest("#letter-close") || e.target === $("#letter")) { $("#letter").classList.remove("open"); return; }
    if (e.target.closest("#btn-gate") && !$("#btn-gate").disabled) { playEnding(); return; }
    if (e.target.closest("#btn-again")) {
      try { localStorage.removeItem(SAVE_KEY); } catch (err) {}
      location.reload(); return;
    }
    if (e.target.closest("#btn-free")) { closeEnding(); return; }
    if (e.target.closest("#btn-reset")) {
      e.preventDefault();
      try { localStorage.removeItem(SAVE_KEY); } catch (err) {}
      location.reload(); return;
    }
    if (e.target.closest("[data-steam]")) { achieve("steam"); return; }
    if (e.target.closest("#slot-card")) { achieve("curious"); return; }
    const loader = e.target.closest(".gif-loader");
    if (loader) {
      const img = document.createElement("img");
      img.src = loader.dataset.src;
      img.alt = "";
      loader.replaceWith(img);
      achieve("patience");
    }
  });
  // 视频播放（play 事件不冒泡，用捕获阶段全局监听）
  document.addEventListener("play", (e) => {
    if (e.target.tagName === "VIDEO") achieve("patience");
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (lightbox.classList.contains("open")) { closeLightbox(); return; }
      if ($("#shop").classList.contains("open") || $("#letter").classList.contains("open")) {
        $("#shop").classList.remove("open");
        $("#letter").classList.remove("open");
        return;
      }
      if (stageId) closeStage();
    }
    // 灯箱左右键切换
    if (lightbox.classList.contains("open")) {
      if (e.key === "ArrowLeft") stepLightbox(-1);
      if (e.key === "ArrowRight") stepLightbox(1);
    }
  });

  /* ================= 头像彩蛋 ================= */
  let avatarPokes = 0;
  $("#hud-avatar").addEventListener("click", () => {
    avatarPokes++;
    const quips = T("quips");
    const bubble = document.createElement("div");
    bubble.className = "quip";
    bubble.textContent = avatarPokes <= quips.length
      ? quips[avatarPokes - 1]
      : quips[(Math.random() * quips.length) | 0];
    $(".hud").appendChild(bubble);
    setTimeout(() => bubble.remove(), 2200);
    if (avatarPokes >= 5) achieve("poke");
  });

  /* ================= 科乐美秘技 ================= */
  const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
  let kIdx = 0;
  document.addEventListener("keydown", (e) => {
    kIdx = (e.key === KONAMI[kIdx]) ? kIdx + 1 : (e.key === KONAMI[0] ? 1 : 0);
    if (kIdx === KONAMI.length) {
      kIdx = 0;
      save.shopOn.rainbow = !save.shopOn.rainbow;
      save.shop.rainbow = true;   // 秘技玩家白嫖彩虹
      persist();
      applyToggles();
      achieve("konami");
      if (window.FluidFX.ready) window.FluidFX.burst(20);
    }
  });

  /* ================= 滚动显现 + 区块成就 ================= */
  function observe() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("in");
        const ach = en.target.dataset.achieve;
        if (ach) achieve(ach);
        io.unobserve(en.target);
      });
    }, { threshold: 0.18 });
    $$(".reveal, [data-achieve]").forEach((el) => io.observe(el));
  }

  /* ================= 技能条动画 ================= */
  function statBars() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        $$(".stat-fill", en.target).forEach((f) => { f.style.width = f.dataset.v + "%"; });
        io.unobserve(en.target);
      });
    }, { threshold: 0.3 });
    const panel = $("#stats-panel");
    if (panel) io.observe(panel);
  }

  /* ================= 开始画面 ================= */
  const startScreen = $("#start-screen");
  $("#btn-start").addEventListener("click", () => {
    startScreen.classList.add("gone");
    setTimeout(() => startScreen.remove(), 900);
    if (window.FluidFX.ready) window.FluidFX.burst(14);
    achieve("begin");
  });

  /* ================= 初始化 ================= */
  renderFeatured();
  renderSide();
  armVibeBars();
  spawnCoins();
  spawnEmbers();
  renderQuestLog();
  renderGate();
  renderShop();
  observe();
  statBars();
  syncCoins();
  renderHUD();
  applyToggles();
  syncFromHash();   // 支持 #p/项目id 深链接直达档案页
  // fluid.js 可能晚于本脚本就绪，笔刷设置再补一次
  setTimeout(applyToggles, 600);
})();
