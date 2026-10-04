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

  const CHIPS = {
    auto: ["What can I make with these?", "Dinner for two from what's here", "Fix this", "Turn this into a gift"],
    cook: ["A 20-minute dinner", "Something sweet", "Use it all, waste nothing", "Make it kid-friendly"],
    build: ["Fix this cabinet door", "Build a shelf from this", "Mount this on the wall", "Why is this broken?"],
    craft: ["Turn these beads into a bracelet", "A birthday gift from this", "Upcycle this into decor", "Matching pair of earrings"],
    care: ["Is this safe for my cat?", "A cozy bed for my pet", "Why is this plant drooping?", "Homemade dog treats"],
  };
  const MODE_HINT = {
    auto: "Work out the project type yourself.",
    cook: "This is a cooking or baking project. Give amounts, temperatures (°F with °C), and doneness cues.",
    build: "This is a build, repair, or DIY home project. Name exact hardware and sizes where you can, and include safety steps.",
    craft: "This is a craft or jewelry project. Name materials, sizes, and techniques precisely.",
    care: "This is about pets or plants. Put animal or plant safety first, flag anything toxic, and say when to call a vet or expert.",
  };

  const state = {
    photos: [], // { blob, url }
    result: null,
    record: null, // saved record for the current result
    heroImg: null, // data URL of first photo for result hero
    abort: null,
    timers: {}, // stepIndex -> { total, left, id, ringing }
    focusIndex: 0,
    speak: false,
    wakeLock: null,
    chat: [],
  };

  /* ---------------- utilities ---------------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

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
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
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

  async function shrink(file, max = 1280) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
      return blob;
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

  async function thumbDataURL(blob, max = 900, q = 0.8) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", q);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return toast("That isn't an image. Try a photo.");
    const room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) return toast(`You can add up to ${MAX_PHOTOS} photos.`);
    if (imgs.length > room) toast(`Added the first ${room}. The limit is ${MAX_PHOTOS} photos.`);
    for (const f of imgs.slice(0, room)) {
      try {
        const blob = await shrink(f);
        state.photos.push({ blob, url: URL.createObjectURL(blob) });
      } catch {
        toast("Couldn't read one of those images.");
      }
    }
    renderThumbs();
  }

  function renderThumbs() {
    const tray = $("#tray"), list = $("#thumbs"), empty = $("#trayEmpty");
    const n = state.photos.length;
    tray.classList.toggle("has-photos", n > 0);
    empty.hidden = n > 0;
    list.hidden = n === 0;
    list.classList.toggle("one", n === 1);
    list.innerHTML = state.photos
      .map((p, i) => `<li><img src="${p.url}" alt="Photo ${i + 1}" /><button type="button" class="rm" data-rm="${i}" aria-label="Remove photo ${i + 1}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button></li>`)
      .join("");
    if (n > 0 && n < MAX_PHOTOS) {
      list.insertAdjacentHTML("beforeend", `<li class="add" role="button" tabindex="0" data-add><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Add another</li>`);
    }
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

  function buildPrompt({ goal, mode, hasPhoto, photoCount, described }) {
    return `You are Snapmake, an expert maker, chef, handyman, crafter, and pet/plant care guide.
${hasPhoto ? `Look carefully at the attached image${photoCount > 1 ? ` (a grid of ${photoCount} photos labeled "Photo 1" to "Photo ${photoCount}")` : ""}. Identify exactly what is in it.` : described ? `The user can't send a photo. They describe what they have as: "${described}".` : "No photo was given; work from the request alone."}
The user wants: "${goal || "Suggest the best thing to make with what is shown"}"
${MODE_HINT[mode] || MODE_HINT.auto}

Produce a practical, specific, safe plan a beginner can follow. Prefer what the user already has; mark anything extra they need. Steps should each be one clear action (usually 4-10 steps). If the request is unsafe or impossible with what's shown, set "feasible": false, explain why in "summary", and offer realistic "alternatives".

Reply with ONLY a JSON object (no markdown fences, no prose) in exactly this shape:
{
  "feasible": true,
  "category": "cook" | "build" | "craft" | "care" | "other",
  "title": "Short name of the thing to make (max 7 words)",
  "title_emphasis": "one word from the title to emphasise",
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
      title_emphasis: r.title_emphasis || "",
      summary: r.summary || "",
      spotted: arr(r.spotted).map((s) => (typeof s === "string" ? { label: s, x: 50, y: 50 } : s)).filter((s) => s && s.label).slice(0, 10),
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
    if (state.photos[0]) {
      img.src = state.photos[0].url;
      frame.classList.add("has-img");
    } else {
      img.removeAttribute("src");
      frame.classList.remove("has-img");
    }
    const lines = state.photos.length
      ? ["Looking closely at your photo…", "Naming what's in the picture…", "Matching it to your goal…", "Writing your steps…", "Adding the pro tips…"]
      : ["Thinking it through…", "Planning the steps…", "Adding the pro tips…"];
    let k = 0;
    const status = $("#scanStatus");
    const items = $$("#scanSteps li");
    const paint = () => {
      status.textContent = lines[Math.min(k, lines.length - 1)];
      const stage = Math.min(3, Math.floor(k * 0.9));
      items.forEach((li, i) => {
        li.classList.toggle("is-done", i < stage);
        li.classList.toggle("is-on", i === stage);
      });
    };
    paint();
    clearInterval(scanTicker);
    scanTicker = setInterval(() => {
      if (k < lines.length - 1) k++;
      paint();
    }, 2600);
    showView("viewScan");
  }
  function stopScanUI() {
    clearInterval(scanTicker);
    $$("#scanSteps li").forEach((li) => {
      li.classList.remove("is-on");
      li.classList.add("is-done");
    });
  }

  function tagsHTML(spotted) {
    return spotted
      .map((s, i) => {
        const x = Math.max(4, Math.min(78, Number(s.x) || 50));
        const y = Math.max(6, Math.min(92, Number(s.y) || 50));
        return `<span class="tag" style="left:${x}%;top:${y}%;--i:${i};animation-delay:${i * 110}ms">${esc(s.label)}</span>`;
      })
      .join("");
  }

  async function run({ goal, mode, described } = {}) {
    goal = (goal ?? $("#goal").value).trim();
    mode = mode ?? (new FormData($("#composer")).get("mode") || "auto");
    if (!state.photos.length && !goal && !described) {
      toast("Add a photo or say what you want to make.");
      $("#goal").focus();
      return;
    }

    const hasPhoto = state.photos.length > 0 && !described;
    // Open Puter sign-in inside the click so the popup isn't blocked.
    if (!params.has("mock") && window.puter?.auth && !puter.auth.isSignedIn()) {
      try {
        await puter.auth.signIn();
      } catch (e) {
        return renderError({ kind: "auth", detail: errMsg(e), goal, mode });
      }
    }

    state.abort = new AbortController();
    startScanUI();
    const prompt = buildPrompt({ goal, mode, hasPhoto, photoCount: state.photos.length, described });

    try {
      let txt;
      if (params.has("mock")) {
        await sleep(2400);
        txt = JSON.stringify(MOCK_RESULT);
      } else if (hasPhoto) {
        const blob = await collage(state.photos.map((p) => p.blob));
        const file = new File([blob], "snapmake.jpg", { type: "image/jpeg" });
        txt = await puterChat(prompt, file);
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
      // Signature moment: pin what was found onto the photo before revealing the plan.
      if (hasPhoto && result.spotted.length) {
        $("#scanStatus").textContent = `Found ${result.spotted.length} thing${result.spotted.length > 1 ? "s" : ""}.`;
        $("#scanTags").innerHTML = tagsHTML(result.spotted);
        await sleep(900 + result.spotted.length * 110);
      }
      state.heroImg = hasPhoto ? await thumbDataURL(state.photos[0].blob) : null;
      const record = {
        id: uid(),
        at: Date.now(),
        goal,
        mode,
        result,
        hero: state.heroImg,
        thumb: hasPhoto ? await thumbDataURL(state.photos[0].blob, 160, 0.7) : null,
        done: [],
      };
      saveRecord(record);
      openRecord(record);
    } catch (e) {
      stopScanUI();
      if (errMsg(e) === "ABORTED" || state.abort?.signal.aborted) return;
      console.error(e);
      const m = errMsg(e);
      renderError({ kind: m === "PUTER_UNAVAILABLE" ? "offline" : isAuthErr(e) ? "auth" : m === "NO_JSON" ? "format" : "generic", detail: m, goal, mode });
    }
  }

  function renderError({ kind, detail, goal, mode }) {
    const copy = {
      auth: ["Sign in to use the free AI", "Snapmake uses Puter's free AI. It needs a one-time sign-in to a free Puter account, and the sign-in window was closed or blocked. Allow pop-ups for this site, then try again."],
      offline: ["Couldn't reach the AI", "The free AI service didn't load. Check your connection or turn off any blocker for js.puter.com, then try again."],
      format: ["That answer came back garbled", "The AI replied in a format Snapmake couldn't read. Trying again usually fixes it."],
      generic: ["Something went sideways", "The AI couldn't finish this one. Try again, or type what's in the photo below to get a plan without the image."],
    }[kind];
    const v = $("#viewResult");
    v.innerHTML = `<div class="err">
      <p class="eyebrow">Hmm</p>
      <h2>${copy[0]}</h2>
      <p>${copy[1]}</p>
      <div class="btns">
        <button class="btn btn-tomato" data-act="retry">Try again</button>
        <button class="btn btn-ghost" data-act="home">Change photo or request</button>
      </div>
      ${state.photos.length ? `<p style="margin-top:22px">Or describe what's in the photo and skip the image:</p>
      <textarea id="describeBox" rows="2" placeholder="e.g. 2 chicken breasts, half an onion, rice, soy sauce, a lemon"></textarea>
      <button class="btn btn-ink" data-act="describe">Plan from my description</button>` : ""}
      <details style="color:var(--ink-3);font-size:.8rem;margin-top:10px"><summary>Technical detail</summary>${esc(detail)}</details>
    </div>`;
    v.onclick = (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (act === "retry") run({ goal, mode });
      if (act === "home") showView("viewCompose");
      if (act === "describe") {
        const d = $("#describeBox").value.trim();
        if (!d) return toast("Type what's in the photo first.");
        run({ goal, mode, described: d });
      }
    };
    showView("viewResult");
  }

  /* ---------------- result rendering ---------------- */
  const ILLUS = {
    cook: `<svg viewBox="0 0 200 200" aria-hidden="true"><ellipse cx="100" cy="150" rx="78" ry="14" fill="#14281e" opacity=".5"/><path d="M24 96h152c0 44-34 64-76 64S24 140 24 96z" fill="#f4efe6"/><path d="M24 96h152" stroke="#f2c94c" stroke-width="5" stroke-linecap="round"/><circle cx="72" cy="88" r="12" fill="#e4532c"/><circle cx="104" cy="84" r="10" fill="#f2c94c"/><circle cx="132" cy="90" r="9" fill="#a9c9ab"/><path d="M78 60c-6-10 6-16 0-28M100 56c-6-10 6-16 0-28M122 60c-6-10 6-16 0-28" stroke="#f4efe6" stroke-width="4" fill="none" stroke-linecap="round" opacity=".55"/></svg>`,
    build: `<svg viewBox="0 0 200 200" aria-hidden="true"><rect x="40" y="40" width="120" height="130" rx="8" fill="#f4efe6"/><rect x="52" y="52" width="96" height="50" rx="4" fill="none" stroke="#1f3b2d" stroke-width="4"/><rect x="52" y="110" width="96" height="48" rx="4" fill="none" stroke="#1f3b2d" stroke-width="4"/><circle cx="138" cy="78" r="5" fill="#e4532c"/><circle cx="138" cy="134" r="5" fill="#e4532c"/><path d="M150 30l28 28-10 10-28-28z" fill="#f2c94c"/><path d="M140 40l-50 50" stroke="#f2c94c" stroke-width="8" stroke-linecap="round"/></svg>`,
    craft: `<svg viewBox="0 0 200 200" aria-hidden="true"><ellipse cx="100" cy="104" rx="64" ry="56" fill="none" stroke="#f4efe6" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round"/>${Array.from({ length: 14 }, (_, i) => { const a = (i / 14) * Math.PI * 2; return `<circle cx="${100 + Math.cos(a) * 64}" cy="${104 + Math.sin(a) * 56}" r="${i % 3 ? 9 : 12}" fill="${["#e4532c", "#f2c94c", "#a9c9ab", "#f4efe6"][i % 4]}"/>`; }).join("")}<path d="M100 48l6 14 15 1-12 9 4 15-13-8-13 8 4-15-12-9 15-1z" fill="#f2c94c"/></svg>`,
    care: `<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="122" r="40" fill="#f4efe6"/><circle cx="58" cy="78" r="16" fill="#f4efe6"/><circle cx="86" cy="58" r="16" fill="#f4efe6"/><circle cx="118" cy="58" r="16" fill="#f4efe6"/><circle cx="144" cy="78" r="16" fill="#f4efe6"/><path d="M100 138c-14-10-22-18-22-27 0-7 6-12 12-12 4 0 8 2 10 6 2-4 6-6 10-6 6 0 12 5 12 12 0 9-8 17-22 27z" fill="#e4532c"/></svg>`,
  };
  ILLUS.other = ILLUS.craft;

  function titleHTML(r) {
    const t = esc(r.title);
    const w = r.title_emphasis && esc(r.title_emphasis);
    if (w && t.includes(w)) return t.replace(w, `<em>${w}</em>`);
    return t;
  }

  function stepCallouts(s) {
    return `${s.tip ? `<div class="callout tip"><b>Tip</b><span>${esc(s.tip)}</span></div>` : ""}${s.warning ? `<div class="callout warn"><b>Careful</b><span>${esc(s.warning)}</span></div>` : ""}`;
  }

  const ICON = {
    timer: `<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l2.5 2M9 2h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>`,
    share: `<svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    print: `<svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    alert: `<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  };

  function timerLabel(i) {
    const t = state.timers[i];
    const s = state.result.steps[i];
    if (t?.ringing) return `${ICON.timer} Time's up! Tap to stop`;
    if (t && t.id) return `${ICON.timer} ${fmt(t.left)} · tap to stop`;
    return `${ICON.timer} Start ${s.minutes} min timer`;
  }
  const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  function openRecord(rec) {
    Object.values(state.timers).forEach((t) => clearInterval(t.id));
    state.timers = {};
    state.record = rec;
    state.result = rec.result;
    state.heroImg = rec.hero;
    state.chat = [];
    renderResult();
    showView("viewResult");
  }

  function renderResult() {
    const r = state.result, rec = state.record;
    const done = new Set(rec.done || []);
    const v = $("#viewResult");
    const have = r.materials.filter((m) => m.have !== false).length;

    v.innerHTML = `
      <article class="r-hero">
        <div class="r-hero-copy">
          <p class="eyebrow">${r.feasible ? esc(labelFor(r.category)) : "Not quite possible"}</p>
          <h1 class="r-title">${titleHTML(r)}</h1>
          ${r.summary ? `<p class="r-summary">${esc(r.summary)}</p>` : ""}
          ${r.feasible ? `<div class="r-stats">
            ${r.time ? `<div class="r-stat"><b>${esc(r.time)}</b><span>Total time</span></div>` : ""}
            <div class="r-stat"><b><span class="dots" aria-label="Difficulty ${r.difficulty} of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= r.difficulty ? "on" : ""}"></i>`).join("")}</span></b><span>${["", "Easy", "Easy-ish", "Medium", "Tricky", "Expert"][r.difficulty]}</span></div>
            ${r.yield ? `<div class="r-stat"><b>${esc(r.yield)}</b><span>Makes</span></div>` : ""}
            <div class="r-stat"><b>${r.steps.length}</b><span>Steps</span></div>
          </div>` : ""}
        </div>
        ${state.heroImg ? `<div class="r-photo"><img src="${state.heroImg}" alt="Your photo" /><div class="scan-tags">${tagsHTML(r.spotted)}</div></div>` : `<div class="r-photo illus">${ILLUS[r.category] || ILLUS.other}</div>`}
      </article>

      <div class="r-actions">
        ${r.feasible && r.steps.length ? `<button class="btn btn-tomato btn-xl" data-act="focus">${ICON.play}<span>Start step-by-step</span></button>` : ""}
        <button class="btn btn-ghost" data-act="share">${ICON.share}Share</button>
        <button class="btn btn-ghost" data-act="print">${ICON.print}Print</button>
        <button class="btn btn-ghost" data-act="new">${ICON.plus}New make</button>
      </div>

      ${r.alert ? `<div class="note ${r.alert.kind === "info" ? "ok" : ""}">${r.alert.kind === "info" ? ICON.info : ICON.alert}<div><b>${esc(r.alert.title || (r.alert.kind === "info" ? "Good to know" : "Heads up"))}</b>${esc(r.alert.text)}</div></div>` : ""}

      ${r.spotted.length ? `<div class="r-spotted"><h3>Spotted</h3>${r.spotted.map((s) => `<span class="pill">${esc(s.label)}</span>`).join("")}</div>` : ""}

      ${r.feasible && r.steps.length ? `
      <div class="r-body">
        <aside class="r-side">
          ${r.materials.length ? `<section class="panel">
            <h3>What you need <small>${have}/${r.materials.length} on hand</small></h3>
            <p class="sub">Tick things off as you gather them.</p>
            <ul class="checklist">${r.materials.map((m, i) => `<li><label><input type="checkbox" data-mat="${i}" ${rec.mats?.includes(i) ? "checked" : ""} /><span class="it">${esc(m.name)}<span class="badge ${m.have === false ? "need" : "have"}">${m.have === false ? "Get" : "Have"}</span>${m.note ? `<small>${esc(m.note)}</small>` : ""}</span><span class="amt">${esc(m.amount || "")}</span></label></li>`).join("")}</ul>
          </section>` : ""}
          ${r.tools.length ? `<section class="panel"><h3>Tools</h3><p class="sub">Have these within reach.</p><div class="toolrow">${r.tools.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</div></section>` : ""}
        </aside>

        <div class="r-main">
          <div class="steps-head">
            <h2>The steps</h2>
            <div class="progress"><div class="track"><div class="fill" id="progFill"></div></div><span id="progText"></span></div>
          </div>
          <ol class="steps">
            ${r.steps.map((s, i) => `
              <li class="step ${done.has(i) ? "done" : ""}" data-step="${i}">
                <div class="step-n">${String(i + 1).padStart(2, "0")}</div>
                <div class="step-main">
                  <h4>${esc(s.title)}</h4>
                  ${s.detail ? `<p>${esc(s.detail)}</p>` : ""}
                  ${s.tip || s.warning ? `<div class="step-extras">${stepCallouts(s)}</div>` : ""}
                  <div class="step-tools">
                    <button class="mini done-btn" data-done="${i}" aria-pressed="${done.has(i)}">${ICON.check}${done.has(i) ? "Done" : "Mark done"}</button>
                    ${Number(s.minutes) > 0 ? `<button class="mini timer" data-timer="${i}">${timerLabel(i)}</button>` : ""}
                  </div>
                </div>
              </li>`).join("")}
          </ol>
          ${r.finish.length ? `<section class="finish"><p class="eyebrow">To finish</p><h3>And that's it. <em>Nicely done.</em></h3><ul>${r.finish.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}
          ${altsHTML(r)}
          ${chatHTML()}
        </div>
      </div>` : `${altsHTML(r)}${chatHTML()}`}
    `;
    updateProgress();
    revealSteps();
    renderChat();
  }

  function altsHTML(r) {
    if (!r.alternatives.length) return "";
    return `<section class="finish"><p class="eyebrow">${r.feasible ? "Or try" : "You could make"}</p><h3>Other ideas from the <em>same stuff</em></h3>
      <div class="alts">${r.alternatives.map((a, i) => `<button class="alt" data-alt="${i}"><b>${esc(a.title)}</b>${a.why ? `<span>${esc(a.why)}</span>` : ""}<i>Make this instead →</i></button>`).join("")}</div></section>`;
  }

  function chatHTML() {
    return `<section class="panel chat"><h3>Got a question?</h3><p class="sub">Ask about swaps, sizes, or what to do if something goes wrong.</p>
      <div class="chat-log" id="chatLog"></div>
      <form class="chat-form" id="chatForm"><input id="chatInput" placeholder="e.g. What can I use instead of butter?" autocomplete="off" /><button class="btn btn-ink" type="submit">Ask</button></form></section>`;
  }

  function labelFor(c) {
    return { cook: "Recipe", build: "Build & fix", craft: "Craft project", care: "Care guide" }[c] || "Your plan";
  }

  function revealSteps() {
    const steps = $$(".step");
    if (!("IntersectionObserver" in window)) return steps.forEach((s) => s.classList.add("in"));
    const io = new IntersectionObserver(
      (ents) => ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -8% 0px" }
    );
    steps.forEach((s, i) => { s.style.transitionDelay = `${Math.min(i, 4) * 70}ms`; io.observe(s); });
  }

  function updateProgress() {
    const fill = $("#progFill");
    if (!fill) return;
    const n = state.result.steps.length, d = (state.record.done || []).length;
    fill.style.width = `${(d / n) * 100}%`;
    $("#progText").textContent = `${d} of ${n} done`;
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
      const b = $(".done-btn", li);
      b.setAttribute("aria-pressed", on);
      b.innerHTML = `${ICON.check}${on ? "Done" : "Mark done"}`;
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
        o.type = "sine";
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
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); // unlock audio inside the tap
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    const total = Math.round(Number(state.result.steps[i].minutes) * 60);
    const end = Date.now() + total * 1000;
    const nt = { total, left: total };
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

  /* ---------------- focus mode ---------------- */
  function openFocus(start) {
    const n = state.result.steps.length;
    const firstUndone = state.result.steps.findIndex((_, i) => !(state.record.done || []).includes(i));
    state.focusIndex = start ?? (firstUndone < 0 ? 0 : firstUndone);
    $("#focus").hidden = false;
    document.body.style.overflow = "hidden";
    renderFocus();
    if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => (state.wakeLock = l)).catch(() => {});
    $("#focusNext").focus();
    void n;
  }
  function closeFocus() {
    $("#focus").hidden = true;
    document.body.style.overflow = "";
    speechSynthesis?.cancel();
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
  }
  function renderFocus(dir = 1) {
    const steps = state.result.steps, n = steps.length, i = state.focusIndex;
    const body = $("#focusBody");
    $("#focusBar").style.width = `${(Math.min(i, n) / n) * 100}%`;
    $("#focusPrev").disabled = i === 0;
    if (i >= n) {
      body.innerHTML = `<div class="fx focus-done">
        <svg class="burst" viewBox="0 0 120 120" aria-hidden="true">${Array.from({ length: 12 }, (_, k) => `<line x1="60" y1="60" x2="${60 + Math.cos((k / 12) * 6.283) * 56}" y2="${60 + Math.sin((k / 12) * 6.283) * 56}" stroke="${k % 2 ? "#f2c94c" : "#e4532c"}" stroke-width="5" stroke-linecap="round" stroke-dasharray="14 60" stroke-dashoffset="-30"/>`).join("")}<circle cx="60" cy="60" r="18" fill="#f2c94c"/></svg>
        <p class="focus-count">All ${n} steps</p>
        <h2>You made it. <em>Enjoy.</em></h2>
        ${state.result.finish.length ? `<p class="fdetail">${esc(state.result.finish[0])}</p>` : ""}
      </div>`;
      $("#focusNext").textContent = "Finish";
      steps.forEach((_, k) => toggleDone(k, true));
      speak(`You made it! ${state.result.finish[0] || ""}`);
      return;
    }
    const s = steps[i];
    body.innerHTML = `<div class="fx ${dir < 0 ? "back" : ""}">
      <p class="focus-count">Step ${i + 1} of ${n}</p>
      <div class="focus-n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</div>
      <h2>${esc(s.title)}</h2>
      ${s.detail ? `<p class="fdetail">${esc(s.detail)}</p>` : ""}
      ${stepCallouts(s)}
      ${Number(s.minutes) > 0 ? `<button class="mini timer" data-timer="${i}">${timerLabel(i)}</button>` : ""}
    </div>`;
    paintTimer(i);
    $("#focusNext").textContent = i === n - 1 ? "Finish" : "Next step";
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
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    speechSynthesis.speak(u);
  }

  /* ---------------- chat ---------------- */
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
      if (params.has("mock")) {
        await sleep(600);
        reply.content = "Olive oil works well: use about three quarters as much, and add a pinch of salt.";
      } else {
        try {
          const stream = await puterChat(msgs, null, { stream: true });
          for await (const part of stream) {
            if (part?.text) {
              reply.content += part.text;
              renderChat();
            }
          }
        } catch {
          reply.content = await pollinationsText(`${ctx}\n\nConversation:\n${msgs.slice(1).map((m) => `${m.role}: ${m.content}`).join("\n")}\nassistant:`);
        }
      }
      if (!reply.content.trim()) reply.content = "Sorry, I didn't catch that. Try asking another way.";
    } catch (e) {
      reply.content = "I couldn't reach the AI just now. " + (isAuthErr(e) ? "Please sign in to Puter and try again." : "Try again in a moment.");
    }
    reply.typing = false;
    renderChat();
    $("#chatLog")?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    let all = loadSaved().filter((r) => r.id !== rec.id);
    all.unshift(rec);
    all = all.slice(0, 30);
    for (;;) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(all));
        break;
      } catch {
        // Storage full: drop the oldest hero images first, then whole records.
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
      ? all.map((r) => `<li data-open="${r.id}">${r.thumb ? `<img class="th" src="${r.thumb}" alt="" />` : `<div class="th" style="display:grid;place-items:center">${(ILLUS[r.result.category] || ILLUS.other).replace("<svg", '<svg width="44"')}</div>`}<div><b>${esc(r.result.title)}</b><span>${new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${r.result.steps.length} steps${r.done?.length ? ` · ${r.done.length} done` : ""}</span></div><button class="del" data-del="${r.id}" aria-label="Delete">✕</button></li>`).join("")
      : `<li class="empty-saved" style="display:block;cursor:default;border:0;background:none">Your makes will show up here automatically.</li>`;
    $("#drawer").hidden = false;
  }

  /* ---------------- share ---------------- */
  function asText(r) {
    return `${r.title}\n${r.summary}\n\nYou need:\n${r.materials.map((m) => `- ${m.amount ? m.amount + " " : ""}${m.name}`).join("\n")}\n\nSteps:\n${r.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.detail}`).join("\n")}\n\nMade with Snapmake: ${location.origin}${location.pathname}`;
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
      toast("Copied the plan. Paste it anywhere.");
    } catch {
      toast("Couldn't copy. Try Print instead.");
    }
  }

  /* ---------------- wiring ---------------- */
  function renderChips(mode) {
    $("#chips").innerHTML = CHIPS[mode].map((c) => `<button type="button" class="chip" role="listitem">${esc(c)}</button>`).join("");
  }

  function init() {
    renderChips("auto");
    paintSavedCount();

    $("#cameraBtn").onclick = () => $("#cameraInput").click();
    $("#uploadBtn").onclick = () => $("#fileInput").click();
    $("#fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
    $("#cameraInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };

    $("#thumbs").addEventListener("click", (e) => {
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        const i = +rm.dataset.rm;
        URL.revokeObjectURL(state.photos[i].url);
        state.photos.splice(i, 1);
        return renderThumbs();
      }
      if (e.target.closest("[data-add]")) $("#fileInput").click();
    });
    $("#thumbs").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-add]")) $("#fileInput").click(); });

    const tray = $("#tray");
    ["dragenter", "dragover"].forEach((t) => tray.addEventListener(t, (e) => { e.preventDefault(); tray.classList.add("is-drag"); }));
    ["dragleave", "drop"].forEach((t) => tray.addEventListener(t, (e) => { e.preventDefault(); tray.classList.remove("is-drag"); }));
    tray.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    window.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length && $("#viewCompose").classList.contains("is-active")) addFiles(files);
    });

    $("#chips").onclick = (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      $("#goal").value = c.textContent;
      $("#goal").focus();
    };
    $("#modes").onchange = (e) => renderChips(e.target.value);
    $("#goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#composer").requestSubmit(); });
    $("#composer").onsubmit = (e) => { e.preventDefault(); run(); };
    $("#exampleBtn").onclick = () => openRecord({ id: "example", at: Date.now(), goal: "Dinner for two", mode: "cook", result: normalize(MOCK_RESULT), hero: null, thumb: null, done: [] });
    $("#cancelBtn").onclick = () => { state.abort?.abort(); stopScanUI(); showView("viewCompose"); };

    $("#viewResult").addEventListener("click", (e) => {
      if (!state.result) return;
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "focus") openFocus();
      if (act === "share") share();
      if (act === "print") window.print();
      if (act === "new") { showView("viewCompose"); $("#goal").focus(); }
      const d = e.target.closest("[data-done]");
      if (d) toggleDone(+d.dataset.done);
      const t = e.target.closest("[data-timer]");
      if (t) toggleTimer(+t.dataset.timer);
      const a = e.target.closest("[data-alt]");
      if (a) {
        const alt = state.result.alternatives[+a.dataset.alt];
        $("#goal").value = alt.title;
        run({ goal: alt.title, mode: state.record.mode });
      }
    });
    $("#viewResult").addEventListener("change", (e) => {
      const m = e.target.closest("[data-mat]");
      if (!m) return;
      const set = new Set(state.record.mats || []);
      m.checked ? set.add(+m.dataset.mat) : set.delete(+m.dataset.mat);
      state.record.mats = [...set];
      saveRecord(state.record);
    });
    $("#viewResult").addEventListener("submit", (e) => {
      if (e.target.id !== "chatForm") return;
      e.preventDefault();
      const q = $("#chatInput").value.trim();
      if (!q) return;
      $("#chatInput").value = "";
      ask(q);
    });

    // focus mode
    $("#focusClose").onclick = closeFocus;
    $("#focusNext").onclick = () => focusGo(1);
    $("#focusPrev").onclick = () => focusGo(-1);
    $("#focusSpeak").onclick = (e) => {
      state.speak = !state.speak;
      e.currentTarget.setAttribute("aria-pressed", state.speak);
      if (state.speak) renderFocus(0);
      else speechSynthesis?.cancel();
      toast(state.speak ? "Reading steps aloud" : "Read-aloud off");
    };
    $("#focus").addEventListener("click", (e) => { const t = e.target.closest("[data-timer]"); if (t) toggleTimer(+t.dataset.timer); });
    document.addEventListener("keydown", (e) => {
      if ($("#focus").hidden) return;
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); focusGo(1); }
      if (e.key === "ArrowLeft") focusGo(-1);
      if (e.key === "Escape") closeFocus();
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

    // drawer
    $("#historyBtn").onclick = openDrawer;
    $("#drawer").addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return ($("#drawer").hidden = true);
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) $("#drawer").hidden = true; });

    if (window.puter) puter.quiet = true;
    if (params.has("demo")) $("#exampleBtn").click();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ---------------- example / mock result ---------------- */
  const MOCK_RESULT = {
    feasible: true,
    category: "cook",
    title: "Lemony chicken & crispy rice bowls",
    title_emphasis: "crispy",
    summary: "Your chicken, leftover rice, and that half lemon make a bright 25-minute dinner for two. The rice crisps in the same pan the chicken cooks in.",
    spotted: [{ label: "Chicken breasts", x: 30, y: 40 }, { label: "Cooked rice", x: 62, y: 30 }, { label: "Lemon", x: 70, y: 66 }, { label: "Spinach", x: 22, y: 72 }, { label: "Garlic", x: 48, y: 58 }],
    time: "25 min",
    difficulty: 2,
    yield: "Serves 2",
    alert: { kind: "info", title: "Food safety", text: "Cook chicken to 165°F (74°C) in the thickest part. Leftover rice should be under 2 days old and kept cold." },
    materials: [
      { name: "Chicken breasts", amount: "2 (about 1 lb)", have: true },
      { name: "Cooked rice, cold", amount: "2 cups", have: true, note: "Day-old rice crisps best" },
      { name: "Lemon", amount: "½", have: true },
      { name: "Garlic", amount: "2 cloves", have: true },
      { name: "Baby spinach", amount: "2 handfuls", have: true },
      { name: "Olive oil", amount: "3 tbsp", have: true },
      { name: "Soy sauce", amount: "1 tbsp", have: false, note: "Or a pinch more salt" },
      { name: "Salt & pepper", amount: "to taste", have: true },
    ],
    tools: ["Large non-stick or cast-iron pan", "Cutting board", "Sharp knife", "Meat thermometer (optional)"],
    steps: [
      { title: "Prep the chicken", detail: "Slice each breast in half horizontally so they're about ½ inch thick. Pat very dry and season both sides with salt and pepper.", minutes: null, tip: "Dry chicken browns; wet chicken steams.", warning: "" },
      { title: "Sear until golden", detail: "Heat 1½ tbsp oil over medium-high. Lay the chicken in and leave it alone for 5 minutes until deep golden, then flip.", minutes: 5, tip: "", warning: "Oil can spit. Lay chicken away from you." },
      { title: "Finish with lemon & garlic", detail: "Cook the second side 4 minutes, add minced garlic for the last minute, then squeeze over half the lemon. Rest on a board.", minutes: 4, tip: "", warning: "Check it's 165°F (74°C) inside before resting." },
      { title: "Crisp the rice", detail: "Add the rest of the oil to the same pan. Press the rice into a flat layer and don't stir for 6 minutes, until the bottom is crackly and golden.", minutes: 6, tip: "Listen for a steady crackle. That's the crust forming.", warning: "" },
      { title: "Wilt the spinach", detail: "Toss the spinach and soy sauce through the rice for about 1 minute, just until the leaves collapse.", minutes: 1, tip: "", warning: "" },
      { title: "Slice and serve", detail: "Slice the chicken, pile it on the rice, and spoon over any pan juices. Finish with a last squeeze of lemon.", minutes: null, tip: "", warning: "" },
    ],
    finish: ["Leftovers keep 2 days in the fridge; reheat until steaming hot.", "A fried egg or chili crisp on top makes it even better."],
    alternatives: [
      { title: "Chicken fried rice", why: "Same ingredients, one pan, 15 minutes" },
      { title: "Lemon chicken soup", why: "Cozier, and stretches to serve 4" },
      { title: "Chicken lettuce wraps", why: "Lighter, with no rice needed" },
    ],
  };

  init();
})();
