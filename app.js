/* ==========================================================
   Snapmake: photo in, step-by-step plan out.
   AI: Puter.js (free for the developer, no API key; each user
   signs in to a free Puter account). Text-only fallback:
   Pollinations (keyless).
   ========================================================== */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);

  // Vision-capable models on Puter, tried in order.
  const MODELS = ["gemini-3.5-flash", "gpt-5.4-mini", "claude-sonnet-4-6"];
  const MAX_PHOTOS = 4;
  const STORE_KEY = "snapmake.saved.v1";
  const CHIPS = ["Dinner for two", "Fix this", "A gift from this", "Is this safe for my pet?"];

  const state = {
    photos: [], // { blob, url }
    result: null,
    record: null,
    heroImg: null,
    abort: null,
    timers: {}, // stepIndex -> { left, id, ringing, ringId }
    focusIndex: 0,
    speak: false,
    wakeLock: null,
    chat: [],
  };

  /* ---------------- utilities ---------------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  const ICON = {
    back: `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    gauge: `<svg viewBox="0 0 24 24"><path d="M4 18a8 8 0 1116 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 18l4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    yield: `<svg viewBox="0 0 24 24"><path d="M4 12h16a8 8 0 01-16 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    list: `<svg viewBox="0 0 24 24"><path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>`,
    share: `<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    print: `<svg viewBox="0 0 24 24"><path d="M7 9V4h10v5M7 17H5a1 1 0 01-1-1v-5a2 2 0 012-2h12a2 2 0 012 2v5a1 1 0 01-1 1h-2M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    arrow: `<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    up: `<svg viewBox="0 0 24 24"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    alert: `<svg viewBox="0 0 24 24"><path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5M12 7.7v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    doc: `<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20a.5.5 0 01-.5.5h-10A.5.5 0 017 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  };

  let toastT;
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), ms);
  }

  function showView(id) {
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === id));
    window.scrollTo(0, 0);
  }

  /* ---------------- images ---------------- */
  function loadImg(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
  }

  async function resized(blob, max, type = "blob", q = 0.86) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return type === "dataURL" ? c.toDataURL("image/jpeg", q) : await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Several photos are stitched into one labeled grid so any vision model can see them all.
  async function collage(blobs) {
    if (blobs.length === 1) return blobs[0];
    const imgs = await Promise.all(blobs.map((b) => loadImg(URL.createObjectURL(b))));
    const cols = 2, rows = Math.ceil(imgs.length / 2), cell = 760, gap = 12;
    const c = document.createElement("canvas");
    c.width = cols * cell + gap * (cols - 1);
    c.height = rows * cell + gap * (rows - 1);
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    imgs.forEach((img, i) => {
      const x = (i % cols) * (cell + gap), y = Math.floor(i / cols) * (cell + gap);
      const s = Math.max(cell / img.naturalWidth, cell / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      g.save();
      g.beginPath();
      g.rect(x, y, cell, cell);
      g.clip();
      g.drawImage(img, x + (cell - w) / 2, y + (cell - h) / 2, w, h);
      g.restore();
      g.fillStyle = "rgba(0,0,0,.65)";
      g.fillRect(x + 12, y + 12, 120, 44);
      g.fillStyle = "#fff";
      g.font = "bold 26px sans-serif";
      g.fillText("Photo " + (i + 1), x + 22, y + 44);
      URL.revokeObjectURL(img.src);
    });
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return toast("That isn't an image");
    const room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) return toast(`Up to ${MAX_PHOTOS} photos`);
    if (imgs.length > room) toast(`Added ${room}. The limit is ${MAX_PHOTOS} photos.`);
    for (const f of imgs.slice(0, room)) {
      try {
        const blob = await resized(f, 1280);
        state.photos.push({ blob, url: URL.createObjectURL(blob) });
      } catch {
        toast("Couldn't read that image");
      }
    }
    renderThumbs();
  }

  function renderThumbs() {
    const tray = $("#tray"), list = $("#thumbs");
    const n = state.photos.length;
    tray.classList.toggle("has-photos", n > 0);
    tray.setAttribute("role", n ? "group" : "button");
    tray.tabIndex = n ? -1 : 0;
    $("#trayEmpty").hidden = n > 0;
    list.hidden = n === 0;
    list.classList.toggle("one", n === 1);
    list.innerHTML = state.photos
      .map((p, i) => `<li><img src="${p.url}" alt="Photo ${i + 1}" /><button type="button" class="rm" data-rm="${i}" aria-label="Remove photo">${ICON.x}</button></li>`)
      .join("");
    if (n > 0 && n < MAX_PHOTOS) list.insertAdjacentHTML("beforeend", `<li class="add" role="button" tabindex="0" data-add aria-label="Add another photo">${ICON.plus}<span>Add photo</span></li>`);
    updateSend();
  }

  function updateSend() {
    $("#makeBtn").classList.toggle("is-dim", !state.photos.length && !$("#goal").value.trim());
  }

  /* ---------------- AI ---------------- */
  async function waitForPuter(ms = 9000) {
    const t0 = Date.now();
    let retried = false;
    while (!window.puter?.ai) {
      if (Date.now() - t0 > ms) throw new Error("PUTER_UNAVAILABLE");
      // The CDN script occasionally drops; load it once more before giving up.
      if (!retried && Date.now() - t0 > 3000) {
        retried = true;
        const sc = document.createElement("script");
        sc.src = "https://js.puter.com/v2/";
        document.head.appendChild(sc);
      }
      await sleep(120);
    }
    return window.puter;
  }

  function textOf(res) {
    if (res == null) return "";
    if (typeof res === "string") return res;
    const c = res.message?.content ?? res.text ?? res.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p.text || "")).join("");
    return String(res);
  }

  function errMsg(e) {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    return e.message || e.error?.message || e.error || JSON.stringify(e);
  }

  const isAuthErr = (e) => /auth|sign.?in|popup|cancel|closed|denied/i.test(errMsg(e));

  async function puterChat(promptOrMsgs, file, opts = {}) {
    const puter = await waitForPuter();
    let lastErr;
    for (const model of MODELS) {
      if (state.abort?.signal.aborted) throw new Error("ABORTED");
      try {
        const res = file ? await puter.ai.chat(promptOrMsgs, file, { model, ...opts }) : await puter.ai.chat(promptOrMsgs, { model, ...opts });
        if (opts.stream) return res;
        const txt = textOf(res);
        if (txt.trim()) return txt;
        lastErr = new Error("Empty reply");
      } catch (e) {
        lastErr = e;
        if (isAuthErr(e)) throw e;
        console.warn("[snapmake] model failed", model, e);
      }
    }
    throw lastErr || new Error("No model answered");
  }

  async function pollinationsText(prompt) {
    const r = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abort?.signal,
      body: JSON.stringify({ model: "openai", messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error("Backup AI returned " + r.status);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || "";
  }

  function buildPrompt({ goal, hasPhoto, photoCount, described }) {
    return `You are Snapmake, an expert cook, maker, handyman, crafter, and pet/plant care guide.
${hasPhoto ? `Look carefully at the attached image${photoCount > 1 ? ` (a grid of ${photoCount} photos labeled "Photo 1" to "Photo ${photoCount}")` : ""}. Identify exactly what is in it.` : described ? `The user can't send a photo. They describe what they have as: "${described}".` : "No photo was given; work from the request alone."}
The user wants: "${goal || "Suggest the best thing to make with what is shown"}"

Work out what kind of project this is (cooking, building/repair, craft, or pet/plant care). Produce a practical, specific, safe plan a beginner can follow. For cooking give amounts, temperatures (°F with °C), and doneness cues. For repairs name exact hardware and sizes. For pets and plants put safety first, flag anything toxic, and say when to call a vet or expert. Prefer what the user already has; mark anything extra they need. Each step is one clear action (usually 4-10 steps). If the request is unsafe or impossible with what's shown, set "feasible": false, explain why in "summary", and offer realistic "alternatives".

Reply with ONLY a JSON object (no markdown fences, no prose) in exactly this shape:
{
  "feasible": true,
  "category": "cook" | "build" | "craft" | "care" | "other",
  "title": "Short name of the thing to make (max 7 words)",
  "summary": "1-2 friendly sentences on what they'll make and why it suits what they have",
  "spotted": [{"label": "item seen in the photo (1-3 words)", "x": 0-100, "y": 0-100}],
  "time": "total time, e.g. 25 min",
  "difficulty": 1-5,
  "yield": "e.g. Serves 2 / 1 bracelet / 1 door fixed",
  "alert": {"kind": "warning" | "info", "title": "...", "text": "..."} or null,
  "materials": [{"name": "...", "amount": "...", "have": true, "note": "optional short note or substitute"}],
  "tools": ["..."],
  "steps": [{"title": "Short imperative title", "detail": "2-3 sentences with exact amounts, sizes, temps and what 'done' looks like", "minutes": number or null, "tip": "optional pro tip or empty string", "warning": "optional safety warning or empty string"}],
  "finish": ["2-4 short lines on serving, finishing, storing or maintaining"],
  "alternatives": [{"title": "Another thing they could make", "why": "one short line"}]
}
"spotted" x/y are the approximate centre of each item in the image as percentages (use 50,50 if there is no photo). Give 2-3 alternatives. Use "alert" for allergy, toxicity (e.g. foods dangerous to pets), electrical or tool safety, or null.`;
  }

  function parseJSON(txt) {
    let s = txt.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b < 0) throw new Error("NO_JSON");
    s = s.slice(a, b + 1);
    try {
      return JSON.parse(s);
    } catch {
      // Common model slip: trailing commas.
      return JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    }
  }

  function normalize(r) {
    const arr = (x) => (Array.isArray(x) ? x : []);
    return {
      feasible: r.feasible !== false,
      category: r.category || "other",
      title: r.title || "Your plan",
      summary: r.summary || "",
      spotted: arr(r.spotted).map((s) => (typeof s === "string" ? { label: s, x: 50, y: 50 } : s)).filter((s) => s && s.label).slice(0, 8),
      time: r.time || "",
      difficulty: Math.max(1, Math.min(5, Number(r.difficulty) || 2)),
      yield: r.yield || "",
      alert: r.alert && r.alert.text ? r.alert : null,
      materials: arr(r.materials).map((m) => (typeof m === "string" ? { name: m, have: true } : m)).filter((m) => m && m.name),
      tools: arr(r.tools).filter(Boolean),
      steps: arr(r.steps).map((s) => (typeof s === "string" ? { title: s, detail: "" } : s)).filter((s) => s && (s.title || s.detail)),
      finish: arr(r.finish).filter(Boolean),
      alternatives: arr(r.alternatives).map((a) => (typeof a === "string" ? { title: a, why: "" } : a)).filter((a) => a && a.title),
    };
  }

  /* ---------------- run flow ---------------- */
  let scanTicker;
  function startScanUI() {
    const frame = $("#scanFrame"), img = $("#scanImg");
    $("#scanTags").innerHTML = "";
    frame.classList.remove("done");
    if (state.photos[0]) {
      img.src = state.photos[0].url;
      frame.classList.add("has-img");
    } else {
      img.removeAttribute("src");
      frame.classList.remove("has-img");
    }
    const lines = state.photos.length
      ? ["Looking at your photo…", "Figuring out what's there…", "Planning the steps…", "Adding tips…", "Almost done…"]
      : ["Thinking…", "Planning the steps…", "Adding tips…", "Almost done…"];
    let k = 0;
    const paint = () => {
      $("#scanStatus").textContent = lines[Math.min(k, lines.length - 1)];
      $("#scanBar").style.width = `${Math.min(92, 12 + k * 18)}%`;
    };
    paint();
    clearInterval(scanTicker);
    scanTicker = setInterval(() => { k++; paint(); }, 2800);
    showView("viewScan");
  }
  function stopScanUI() {
    clearInterval(scanTicker);
    $("#scanBar").style.width = "100%";
    $("#scanFrame").classList.add("done");
  }

  function tagsHTML(spotted) {
    return spotted
      .map((s, i) => {
        const x = Math.max(12, Math.min(88, Number(s.x) || 50));
        const y = Math.max(8, Math.min(92, Number(s.y) || 50));
        return `<span class="tag" style="left:${x}%;top:${y}%;animation-delay:${i * 90}ms">${esc(s.label)}</span>`;
      })
      .join("");
  }

  async function run({ goal, described } = {}) {
    goal = (goal ?? $("#goal").value).trim();
    if (!state.photos.length && !goal && !described) {
      toast("Add a photo or type what you want");
      $("#goal").focus();
      return;
    }

    // Open Puter sign-in inside the click so the popup isn't blocked.
    if (!params.has("mock") && window.puter?.auth && !puter.auth.isSignedIn()) {
      try {
        await puter.auth.signIn();
      } catch (e) {
        return renderError({ kind: "auth", detail: errMsg(e), goal });
      }
    }

    const hasPhoto = state.photos.length > 0 && !described;
    state.abort = new AbortController();
    startScanUI();
    const prompt = buildPrompt({ goal, hasPhoto, photoCount: state.photos.length, described });

    try {
      let txt;
      if (params.has("mock")) {
        await sleep(2400);
        txt = JSON.stringify(EXAMPLE);
      } else if (hasPhoto) {
        const blob = await collage(state.photos.map((p) => p.blob));
        txt = await puterChat(prompt, new File([blob], "snapmake.jpg", { type: "image/jpeg" }));
      } else {
        try {
          txt = await puterChat(prompt);
        } catch (e) {
          if (isAuthErr(e) || errMsg(e) === "ABORTED") throw e;
          txt = await pollinationsText(prompt).catch(() => { throw e; });
        }
      }
      if (state.abort.signal.aborted) return;
      let result;
      try {
        result = normalize(parseJSON(txt));
      } catch {
        // One repair attempt: ask the model to fix its own output.
        const fixed = await puterChat(`Convert this into the valid JSON object described earlier, output JSON only:\n\n${txt.slice(0, 6000)}`).catch(() => "");
        result = normalize(parseJSON(fixed));
      }
      if (!result.steps.length && result.feasible) throw new Error("The AI didn't return any steps.");

      stopScanUI();
      // Pin what was found onto the photo before revealing the plan.
      if (hasPhoto && result.spotted.length) {
        $("#scanStatus").textContent = `Found ${result.spotted.length} thing${result.spotted.length > 1 ? "s" : ""}`;
        $("#scanTags").innerHTML = tagsHTML(result.spotted);
        await sleep(1100 + result.spotted.length * 90);
      }
      const record = {
        id: uid(),
        at: Date.now(),
        goal,
        result,
        hero: hasPhoto ? await resized(state.photos[0].blob, 1100, "dataURL", 0.8) : null,
        thumb: hasPhoto ? await resized(state.photos[0].blob, 160, "dataURL", 0.7) : null,
        done: [],
      };
      saveRecord(record);
      openRecord(record);
    } catch (e) {
      stopScanUI();
      if (errMsg(e) === "ABORTED" || state.abort?.signal.aborted) return;
      console.error(e);
      const m = errMsg(e);
      renderError({ kind: m === "PUTER_UNAVAILABLE" ? "offline" : isAuthErr(e) ? "auth" : m === "NO_JSON" ? "format" : "generic", detail: m, goal });
    }
  }

  function renderError({ kind, detail, goal }) {
    const [title, body] = {
      auth: ["Sign in to continue", "Snapmake's AI is free through Puter. It needs a quick one-time sign-in. If nothing opened, allow pop-ups for this site and try again."],
      offline: ["Can't reach the AI", "Check your connection, or turn off any blocker for js.puter.com, then try again."],
      format: ["That didn't come out right", "The AI's answer was garbled. Trying again usually fixes it."],
      generic: ["Something went wrong", "The AI couldn't finish this one. Try again, or describe what's in the photo instead."],
    }[kind];
    const v = $("#viewResult");
    v.innerHTML = `<div class="err">
      <h1>${title}</h1>
      <p>${body}</p>
      <div class="row">
        <button class="btn btn-primary" data-act="retry">Try again</button>
        <button class="btn btn-secondary" data-act="home">Go back</button>
      </div>
      ${state.photos.length ? `<div class="alt-box"><p>Or type what's in the photo:</p>
        <form class="ask" id="describeForm"><input id="describeBox" placeholder="e.g. chicken, rice, a lemon, spinach" /><button class="send" type="submit" aria-label="Go">${ICON.up}</button></form></div>` : ""}
      <details><summary>Details</summary>${esc(detail)}</details>
    </div>`;
    v.onclick = (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (act === "retry") run({ goal });
      if (act === "home") showView("viewCompose");
    };
    v.onsubmit = (ev) => {
      if (ev.target.id !== "describeForm") return;
      ev.preventDefault();
      const d = $("#describeBox").value.trim();
      if (!d) return toast("Type what's in the photo first");
      run({ goal, described: d });
    };
    showView("viewResult");
  }

  /* ---------------- result ---------------- */
  const KICKER = { cook: "Recipe", build: "Build & fix", craft: "Craft", care: "Care guide" };
  const LEVEL = ["", "Easy", "Easy", "Medium", "Tricky", "Advanced"];

  function hints(s) {
    return `${s.tip ? `<div class="hint"><b>Tip</b><span>${esc(s.tip)}</span></div>` : ""}${s.warning ? `<div class="hint warn"><b>Careful</b><span>${esc(s.warning)}</span></div>` : ""}`;
  }

  function timerLabel(i) {
    const t = state.timers[i];
    if (t?.ringing) return `${ICON.clock}Time's up · stop`;
    if (t?.id) return `${ICON.clock}${fmt(t.left)}`;
    return `${ICON.clock}${state.result.steps[i].minutes} min timer`;
  }

  function openRecord(rec) {
    Object.values(state.timers).forEach((t) => { clearInterval(t.id); clearInterval(t.ringId); });
    state.timers = {};
    state.record = rec;
    state.result = rec.result;
    state.chat = [];
    renderResult();
    showView("viewResult");
  }

  function renderResult() {
    const r = state.result, rec = state.record;
    const done = new Set(rec.done || []);
    const mats = new Set(rec.mats || []);
    const toBuy = r.materials.filter((m) => m.have === false).length;
    const v = $("#viewResult");
    v.onclick = v.onsubmit = null;

    v.innerHTML = `
      <button class="back" data-act="new">${ICON.back}New</button>
      ${rec.hero ? `<div class="r-media"><img src="${rec.hero}" alt="Your photo" /><div class="tags">${tagsHTML(r.spotted)}</div></div>` : ""}
      <p class="r-kicker">${r.feasible ? esc(KICKER[r.category] || "Plan") : "Not quite possible"}</p>
      <h1 class="r-title">${esc(r.title)}</h1>
      ${r.summary ? `<p class="r-summary">${esc(r.summary)}</p>` : ""}
      ${r.feasible ? `<ul class="meta">
        ${r.time ? `<li>${ICON.clock}${esc(r.time)}</li>` : ""}
        <li>${ICON.gauge}${LEVEL[r.difficulty]}</li>
        ${r.yield ? `<li>${ICON.yield}${esc(r.yield)}</li>` : ""}
        <li>${ICON.list}${r.steps.length} steps</li>
      </ul>` : ""}

      <div class="cta-row">
        ${r.feasible && r.steps.length ? `<button class="btn btn-primary" data-act="focus">${ICON.play}${done.size && done.size < r.steps.length ? "Continue" : "Start"}</button>` : ""}
        <button class="btn btn-icon" data-act="share" aria-label="Share">${ICON.share}</button>
        <button class="btn btn-icon" data-act="print" aria-label="Print">${ICON.print}</button>
      </div>

      ${r.alert ? `<div class="notice ${r.alert.kind === "info" ? "info" : ""}">${r.alert.kind === "info" ? ICON.info : ICON.alert}<div><b>${esc(r.alert.title || "Heads up")}.</b> ${esc(r.alert.text)}</div></div>` : ""}

      ${r.feasible && r.materials.length ? `<section class="section">
        <div class="section-head"><h2>You'll need</h2><span>${toBuy ? `${toBuy} to get` : "You have everything"}</span></div>
        <ul class="list">${r.materials.map((m, i) => `<li><label class="check"><input type="checkbox" data-mat="${i}" ${mats.has(i) ? "checked" : ""} /><span class="name">${esc(m.name)}${m.have === false ? `<span class="buy">Get</span>` : ""}${m.note ? `<small>${esc(m.note)}</small>` : ""}</span><span class="amt">${esc(m.amount || "")}</span></label></li>`).join("")}</ul>
        ${r.tools.length ? `<p class="tools"><b>Tools:</b> ${r.tools.map(esc).join(", ")}</p>` : ""}
      </section>` : ""}

      ${r.feasible && r.steps.length ? `<section class="section">
        <div class="section-head"><h2>Steps</h2><span class="progress-mini"><i><b id="progFill"></b></i><em id="progText" style="font-style:normal"></em></span></div>
        <ol class="steps">${r.steps.map((s, i) => `
          <li class="step ${done.has(i) ? "done" : ""}" data-step="${i}">
            <button class="step-num" data-done="${i}" aria-label="Mark step ${i + 1} done" aria-pressed="${done.has(i)}">${done.has(i) ? ICON.check : i + 1}</button>
            <div>
              <h3>${esc(s.title)}</h3>
              ${s.detail ? `<p>${esc(s.detail)}</p>` : ""}
              ${hints(s)}
              ${Number(s.minutes) > 0 ? `<button class="timer" data-timer="${i}">${timerLabel(i)}</button>` : ""}
            </div>
          </li>`).join("")}</ol>
      </section>` : ""}

      ${r.finish.length ? `<section class="section"><div class="section-head"><h2>When you're done</h2></div><ul class="plain">${r.finish.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}

      ${r.alternatives.length ? `<section class="section" id="ideasSection"><div class="section-head"><h2>${r.feasible ? "Other ideas" : "Try instead"}</h2></div>
        <ul class="list">${r.alternatives.map((a, i) => `<li><button class="idea" data-alt="${i}"><span>${esc(a.title)}${a.why ? `<small>${esc(a.why)}</small>` : ""}</span>${ICON.arrow}</button></li>`).join("")}</ul></section>` : ""}

      <section class="section" id="askSection"><div class="section-head"><h2>Questions?</h2></div>
        <div class="chat-log" id="chatLog"></div>
        <form class="ask" id="chatForm"><input id="chatInput" placeholder="e.g. What can I use instead of butter?" /><button class="send" type="submit" aria-label="Ask">${ICON.up}</button></form>
      </section>
    `;
    updateProgress();
    renderChat();
  }

  function updateProgress() {
    const fill = $("#progFill");
    if (!fill) return;
    const n = state.result.steps.length, d = (state.record.done || []).length;
    fill.style.width = `${(d / n) * 100}%`;
    $("#progText").textContent = `${d}/${n}`;
  }

  function toggleDone(i, force) {
    const rec = state.record;
    const set = new Set(rec.done || []);
    const on = force ?? !set.has(i);
    on ? set.add(i) : set.delete(i);
    rec.done = [...set];
    saveRecord(rec);
    const li = $(`.step[data-step="${i}"]`);
    if (li) {
      li.classList.toggle("done", on);
      const b = $(".step-num", li);
      b.setAttribute("aria-pressed", on);
      b.innerHTML = on ? ICON.check : i + 1;
    }
    updateProgress();
  }

  /* ---------------- timers ---------------- */
  let audioCtx;
  function beep() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach((t) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.2);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + t);
        o.stop(audioCtx.currentTime + t + 0.22);
      });
    } catch {}
    navigator.vibrate?.([200, 100, 200]);
  }

  function paintTimer(i) {
    $$(`[data-timer="${i}"]`).forEach((b) => {
      const t = state.timers[i];
      b.classList.toggle("running", !!t?.id);
      b.classList.toggle("ring", !!t?.ringing);
      b.innerHTML = timerLabel(i);
    });
  }

  function toggleTimer(i) {
    const t = state.timers[i];
    if (t) {
      clearInterval(t.id);
      clearInterval(t.ringId);
      delete state.timers[i];
      return paintTimer(i);
    }
    try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); } catch {} // unlock audio inside the tap
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    const total = Math.round(Number(state.result.steps[i].minutes) * 60);
    const end = Date.now() + total * 1000;
    const nt = { left: total };
    nt.id = setInterval(() => {
      nt.left = Math.max(0, Math.round((end - Date.now()) / 1000));
      if (nt.left === 0) {
        clearInterval(nt.id);
        nt.id = null;
        nt.ringing = true;
        beep();
        nt.ringId = setInterval(beep, 2500);
        const title = state.result.steps[i].title;
        toast(`Timer done: ${title}`, 5000);
        if ("Notification" in window && Notification.permission === "granted" && document.hidden) new Notification("Snapmake timer", { body: title, icon: "icon-192.png" });
      }
      paintTimer(i);
    }, 1000);
    state.timers[i] = nt;
    paintTimer(i);
  }

  /* ---------------- step-by-step mode ---------------- */
  function openFocus() {
    const firstUndone = state.result.steps.findIndex((_, i) => !(state.record.done || []).includes(i));
    state.focusIndex = firstUndone < 0 ? 0 : firstUndone;
    $("#focus").hidden = false;
    document.body.style.overflow = "hidden";
    renderFocus();
    if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => (state.wakeLock = l)).catch(() => {});
    $("#focusNext").focus();
  }
  function closeFocus() {
    $("#focus").hidden = true;
    document.body.style.overflow = "";
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
    if (state.result) renderResult();
  }
  function renderFocus(dir = 1) {
    const steps = state.result.steps, n = steps.length, i = state.focusIndex;
    const body = $("#focusBody");
    $("#focusBar").style.width = `${(Math.min(i, n) / n) * 100}%`;
    $("#focusPrev").disabled = i === 0;
    if (i >= n) {
      body.innerHTML = `<div class="fx f-done"><div class="badge">${ICON.check}</div><h2>All done</h2>${state.result.finish.length ? `<p class="f-detail">${esc(state.result.finish[0])}</p>` : ""}</div>`;
      $("#focusNext").textContent = "Close";
      steps.forEach((_, k) => toggleDone(k, true));
      speak(`All done! ${state.result.finish[0] || ""}`);
      return;
    }
    const s = steps[i];
    body.innerHTML = `<div class="fx ${dir < 0 ? "back" : ""}">
      <p class="f-count">Step ${i + 1} of ${n}</p>
      <h2>${esc(s.title)}</h2>
      ${s.detail ? `<p class="f-detail">${esc(s.detail)}</p>` : ""}
      ${hints(s)}
      ${Number(s.minutes) > 0 ? `<button class="timer" data-timer="${i}">${timerLabel(i)}</button>` : ""}
    </div>`;
    paintTimer(i);
    $("#focusNext").textContent = i === n - 1 ? "Finish" : "Next";
    speak(`Step ${i + 1}. ${s.title}. ${s.detail || ""} ${s.warning ? "Careful: " + s.warning : ""}`);
  }
  function focusGo(d) {
    const n = state.result.steps.length;
    if (state.focusIndex >= n && d > 0) return closeFocus();
    if (d > 0 && state.focusIndex < n) toggleDone(state.focusIndex, true);
    state.focusIndex = Math.max(0, Math.min(n, state.focusIndex + d));
    renderFocus(d);
  }
  function speak(text) {
    if (!state.speak || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  /* ---------------- questions ---------------- */
  function renderChat() {
    const log = $("#chatLog");
    if (!log) return;
    log.innerHTML = state.chat.map((m) => `<div class="bubble ${m.role === "user" ? "me" : "ai"}${m.typing ? " typing" : ""}">${esc(m.content)}</div>`).join("");
  }
  async function ask(q) {
    const r = state.result;
    const ctx = `You are Snapmake's helper. The user is following this plan:\n${JSON.stringify({ title: r.title, materials: r.materials, tools: r.tools, steps: r.steps })}\nOriginal request: "${state.record.goal}". Answer briefly (under 120 words), practically, in plain text with no markdown.`;
    state.chat.push({ role: "user", content: q });
    const reply = { role: "assistant", content: "", typing: true };
    state.chat.push(reply);
    renderChat();
    const msgs = [{ role: "system", content: ctx }, ...state.chat.filter((m) => m !== reply).map(({ role, content }) => ({ role, content }))];
    try {
      if (params.has("mock") || state.record.id === "example") {
        await sleep(700);
        reply.content = "Olive oil works. Use about three quarters as much, and add a pinch of salt.";
      } else {
        try {
          const stream = await puterChat(msgs, null, { stream: true });
          for await (const part of stream) {
            if (part?.text) {
              reply.content += part.text;
              renderChat();
            }
          }
        } catch (e) {
          if (isAuthErr(e)) throw e;
          reply.content = await pollinationsText(`${ctx}\n\nConversation:\n${msgs.slice(1).map((m) => `${m.role}: ${m.content}`).join("\n")}\nassistant:`);
        }
      }
      if (!reply.content.trim()) reply.content = "Sorry, I didn't catch that. Try asking another way.";
    } catch (e) {
      reply.content = isAuthErr(e) ? "Please sign in to Puter and try again." : "I couldn't reach the AI just now. Try again in a moment.";
    }
    reply.typing = false;
    renderChat();
  }

  /* ---------------- saving ---------------- */
  function loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
    } catch {
      return [];
    }
  }
  function saveRecord(rec) {
    if (rec.id === "example") return;
    let all = loadSaved().filter((r) => r.id !== rec.id);
    all.unshift(rec);
    all = all.slice(0, 30);
    for (;;) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(all));
        break;
      } catch {
        // Storage full: drop the oldest photos first, then whole records.
        const withHero = [...all].reverse().find((r) => r.hero && r.id !== rec.id);
        if (withHero) withHero.hero = null;
        else if (all.length > 1) all.pop();
        else break;
      }
    }
    paintSavedCount();
  }
  function paintSavedCount() {
    const n = loadSaved().length, c = $("#savedCount");
    c.hidden = n === 0;
    c.textContent = n;
  }
  function openDrawer() {
    const all = loadSaved();
    $("#savedList").innerHTML = all.length
      ? all.map((r) => `<li data-open="${r.id}">${r.thumb ? `<img class="th" src="${r.thumb}" alt="" />` : `<span class="th">${ICON.doc}</span>`}<div class="t"><b>${esc(r.result.title)}</b><span>${new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${r.done?.length || 0}/${r.result.steps.length} steps</span></div><button class="del" data-del="${r.id}" aria-label="Delete">${ICON.x}</button></li>`).join("")
      : `<li class="empty">Your plans will show up here.</li>`;
    $("#drawer").hidden = false;
  }

  /* ---------------- share ---------------- */
  function asText(r) {
    return `${r.title}\n${r.summary}\n\nYou'll need:\n${r.materials.map((m) => `- ${m.amount ? m.amount + " " : ""}${m.name}`).join("\n")}\n\nSteps:\n${r.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.detail}`).join("\n")}\n\nMade with Snapmake: ${location.origin}${location.pathname}`;
  }
  async function share() {
    const text = asText(state.result);
    if (navigator.share) {
      try {
        await navigator.share({ title: state.result.title, text });
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard");
    } catch {
      toast("Couldn't copy. Try Print instead.");
    }
  }

  /* ---------------- wiring ---------------- */
  function init() {
    $("#chips").innerHTML = CHIPS.map((c) => `<button type="button" class="chip">${esc(c)}</button>`).join("");
    paintSavedCount();
    updateSend();

    const pick = () => $("#fileInput").click();
    $("#fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
    const tray = $("#tray");
    tray.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        const i = +rm.dataset.rm;
        URL.revokeObjectURL(state.photos[i].url);
        state.photos.splice(i, 1);
        return renderThumbs();
      }
      if (e.target.closest("[data-add]") || !state.photos.length) pick();
    });
    tray.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target === tray || e.target.matches("[data-add]"))) { e.preventDefault(); pick(); }
    });
    ["dragenter", "dragover"].forEach((t) => tray.addEventListener(t, (e) => { e.preventDefault(); tray.classList.add("is-drag"); }));
    ["dragleave", "drop"].forEach((t) => tray.addEventListener(t, (e) => { e.preventDefault(); tray.classList.remove("is-drag"); }));
    tray.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    window.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && $("#viewCompose").classList.contains("is-active")) addFiles(files);
    });

    const goal = $("#goal");
    const grow = () => {
      goal.style.height = "auto";
      goal.style.height = goal.scrollHeight + "px";
      goal.style.overflowY = goal.scrollHeight > 160 ? "auto" : "hidden";
      updateSend();
    };
    goal.addEventListener("input", grow);
    goal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
    });
    $("#chips").onclick = (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      goal.value = c.textContent;
      grow();
      goal.focus();
    };
    $("#composer").onsubmit = (e) => { e.preventDefault(); run(); };
    $("#exampleBtn").onclick = () => openRecord({ id: "example", at: Date.now(), goal: "Dinner for two", result: normalize(EXAMPLE), hero: null, thumb: null, done: [] });
    $("#cancelBtn").onclick = () => { state.abort?.abort(); stopScanUI(); showView("viewCompose"); };

    const result = $("#viewResult");
    result.addEventListener("click", (e) => {
      if (!state.result || !e.target.closest(".back, .cta-row, .step, .idea")) return;
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "focus") openFocus();
      if (act === "share") share();
      if (act === "print") window.print();
      if (act === "new") showView("viewCompose");
      const d = e.target.closest("[data-done]");
      if (d) toggleDone(+d.dataset.done);
      const t = e.target.closest("[data-timer]");
      if (t) toggleTimer(+t.dataset.timer);
      const a = e.target.closest("[data-alt]");
      if (a) {
        const alt = state.result.alternatives[+a.dataset.alt];
        goal.value = alt.title;
        run({ goal: alt.title });
      }
    });
    result.addEventListener("change", (e) => {
      const m = e.target.closest("[data-mat]");
      if (!m || !state.record) return;
      const set = new Set(state.record.mats || []);
      m.checked ? set.add(+m.dataset.mat) : set.delete(+m.dataset.mat);
      state.record.mats = [...set];
      saveRecord(state.record);
    });
    result.addEventListener("submit", (e) => {
      if (e.target.id !== "chatForm") return;
      e.preventDefault();
      const q = $("#chatInput").value.trim();
      if (!q) return;
      $("#chatInput").value = "";
      ask(q);
    });

    // step-by-step mode
    $("#focusClose").onclick = closeFocus;
    $("#focusNext").onclick = () => focusGo(1);
    $("#focusPrev").onclick = () => focusGo(-1);
    $("#focusSpeak").onclick = (e) => {
      state.speak = !state.speak;
      e.currentTarget.setAttribute("aria-pressed", state.speak);
      if (state.speak) renderFocus(0);
      else if ("speechSynthesis" in window) speechSynthesis.cancel();
      toast(state.speak ? "Reading steps aloud" : "Read aloud off");
    };
    $("#focus").addEventListener("click", (e) => { const t = e.target.closest("[data-timer]"); if (t) toggleTimer(+t.dataset.timer); });
    document.addEventListener("keydown", (e) => {
      if (!$("#focus").hidden) {
        if (e.key === "ArrowRight") { e.preventDefault(); focusGo(1); }
        if (e.key === "ArrowLeft") focusGo(-1);
        if (e.key === "Escape") closeFocus();
      } else if (e.key === "Escape" && !$("#drawer").hidden) $("#drawer").hidden = true;
    });
    let sx = null;
    $("#focusBody").addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
    $("#focusBody").addEventListener("touchend", (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 60) focusGo(dx < 0 ? 1 : -1);
      sx = null;
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !$("#focus").hidden && "wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => (state.wakeLock = l)).catch(() => {});
    });

    // saved
    $("#historyBtn").onclick = openDrawer;
    $("#drawer").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return ($("#drawer").hidden = true);
      const del = e.target.closest("[data-del]");
      if (del) {
        localStorage.setItem(STORE_KEY, JSON.stringify(loadSaved().filter((r) => r.id !== del.dataset.del)));
        paintSavedCount();
        return openDrawer();
      }
      const o = e.target.closest("[data-open]");
      if (o) {
        const rec = loadSaved().find((r) => r.id === o.dataset.open);
        $("#drawer").hidden = true;
        if (rec) openRecord(rec);
      }
    });

    if (window.puter) puter.quiet = true;
    if (params.has("demo")) $("#exampleBtn").click();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ---------------- example plan ---------------- */
  const EXAMPLE = {
    feasible: true,
    category: "cook",
    title: "Lemon chicken & crispy rice",
    summary: "Your chicken, leftover rice, and half a lemon make a bright 25-minute dinner for two. The rice crisps in the same pan.",
    spotted: [{ label: "Chicken", x: 30, y: 40 }, { label: "Rice", x: 62, y: 30 }, { label: "Lemon", x: 70, y: 66 }, { label: "Spinach", x: 24, y: 72 }, { label: "Garlic", x: 48, y: 56 }],
    time: "25 min",
    difficulty: 2,
    yield: "Serves 2",
    alert: { kind: "info", title: "Food safety", text: "Cook chicken to 165°F (74°C) in the thickest part. Use rice that's under 2 days old and kept cold." },
    materials: [
      { name: "Chicken breasts", amount: "2", have: true },
      { name: "Cooked rice, cold", amount: "2 cups", have: true, note: "Day-old rice crisps best" },
      { name: "Lemon", amount: "½", have: true },
      { name: "Garlic", amount: "2 cloves", have: true },
      { name: "Baby spinach", amount: "2 handfuls", have: true },
      { name: "Olive oil", amount: "3 tbsp", have: true },
      { name: "Soy sauce", amount: "1 tbsp", have: false, note: "Or a pinch more salt" },
      { name: "Salt & pepper", amount: "To taste", have: true },
    ],
    tools: ["Large non-stick pan", "Cutting board", "Knife"],
    steps: [
      { title: "Prep the chicken", detail: "Slice each breast in half horizontally so it's about ½ inch thick. Pat dry and season both sides with salt and pepper.", minutes: null, tip: "Dry chicken browns; wet chicken steams.", warning: "" },
      { title: "Sear until golden", detail: "Heat 1½ tbsp oil over medium-high. Lay the chicken in and leave it for 5 minutes until deep golden, then flip.", minutes: 5, tip: "", warning: "Oil can spit. Lay the chicken away from you." },
      { title: "Add lemon and garlic", detail: "Cook the second side for 4 minutes, adding minced garlic for the last minute. Squeeze over half the lemon and move to a board.", minutes: 4, tip: "", warning: "Check it reads 165°F (74°C) inside." },
      { title: "Crisp the rice", detail: "Add the rest of the oil to the same pan. Press the rice into a flat layer and leave it for 6 minutes, until the bottom is golden.", minutes: 6, tip: "A steady crackle means the crust is forming.", warning: "" },
      { title: "Wilt the spinach", detail: "Toss in the spinach and soy sauce for about a minute, just until the leaves soften.", minutes: 1, tip: "", warning: "" },
      { title: "Slice and serve", detail: "Slice the chicken, pile it on the rice, and spoon over the pan juices.", minutes: null, tip: "", warning: "" },
    ],
    finish: ["Leftovers keep 2 days in the fridge. Reheat until steaming hot.", "A fried egg or chili crisp on top is great."],
    alternatives: [
      { title: "Chicken fried rice", why: "Same ingredients, one pan, 15 minutes" },
      { title: "Lemon chicken soup", why: "Cozier, and stretches to serve 4" },
      { title: "Chicken lettuce wraps", why: "Lighter, no rice needed" },
    ],
  };

  init();
})();
