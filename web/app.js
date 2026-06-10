/* PantryDeal UI — Apple-style design, wired to the real /api backend.
   The big hero number is the projected whole-recipe cost (sale prices + an
   estimated regular price for items not on sale here), which is how stores are
   ranked. Breakdown rows sum to that total. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const money = (n) => Number(n || 0).toFixed(2);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- live availability ---------- */
  let liveAvailable = false;
  fetch("/api/config")
    .then((r) => r.json())
    .then((cfg) => {
      liveAvailable = Boolean(cfg.liveAvailable);
      if (!liveAvailable) {
        const radio = $("src-live");
        radio.disabled = true;
        const label = document.querySelector('label[for="src-live"]');
        label.style.opacity = "0.45";
        label.style.cursor = "not-allowed";
        label.title = "Set GEMINI_API_KEY on the server to enable live flyers";
      }
    })
    .catch(() => {});

  /* ---------- state machine ---------- */
  function show(stateId) {
    ["emptyState", "loadingState", "noResults", "results"].forEach((id) => {
      $(id).hidden = id !== stateId;
    });
  }

  /* ---------- rendering ---------- */
  function renderRecipe(recipe) {
    $("recipeName").textContent = recipe.dish;
    $("recipeMeta").innerHTML = `Serves <b>${recipe.servings}</b> · ${recipe.ingredients.length} ingredients`;
    const list = $("recipeIngs");
    list.innerHTML = "";
    recipe.ingredients.forEach((i) => {
      const li = el("li");
      li.innerHTML = `${esc(i.name)}<span class="ing-q">${i.qtyGrams} g</span>`;
      list.appendChild(li);
    });
  }

  const perKg = (ppg) => "$" + money(ppg * 1000) + "/kg";
  const hasUnit = (raw) => /\/\s*\d*\s*(lb|kg|g|oz|ml|l)\b/i.test(raw || "");

  function renderHero(p) {
    const twoStore = p.storeCount === 2;
    $("heroRibbon").textContent = "Cheapest way to shop";
    $("heroStore").textContent = twoStore ? "2 stores" : p.storeCount === 1 ? "1 store" : "—";
    const staplesBit =
      p.staplesCount > 0
        ? ` · ${p.staplesCount} pantry staple${p.staplesCount === 1 ? "" : "s"} assumed`
        : "";
    $("heroSub").textContent = `${p.coverage} of ${p.totalIngredients} ingredients on sale this week${staplesBit}`;
    $("heroTotal").textContent = money(p.fullTotal);

    $("savePill").textContent = p.savingsVsRegular > 0.01 ? `Save ~$${money(p.savingsVsRegular)} vs. regular price` : "Best prices nearby";

    if (twoStore) {
      $("heroDeals").textContent = `Two stops save $${money(p.savingsVsOneStore)} vs. one store`;
    } else if (p.secondStopSavings > 0.01) {
      $("heroDeals").textContent = `One stop — a 2nd would save only $${money(p.secondStopSavings)}`;
    } else {
      $("heroDeals").textContent = "One stop does it";
    }
  }

  // One ingredient row inside a trip card.
  function itemRow(it) {
    const row = el("div", "ing-row is-deal");
    const name = el("div", "ing-row__name", it.ingredient);

    const deal = el("div", "ing-row__deal");
    const tag = it.goodDeal ? `<span class="deal-tag">🔥 ${esc(perKg(it.pricePerGram))}</span>` : `<span class="deal-tag">${esc(perKg(it.pricePerGram))}</span>`;
    const shelf = hasUnit(it.rawPrice) ? ` · ${esc(it.rawPrice)}` : "";
    deal.innerHTML = `${tag}<span class="elsewhere">${esc(it.product)}${shelf}</span>`;

    const price = el("div", "ing-row__price");
    const detail =
      it.basis === "weight"
        ? `${it.neededGrams} g`
        : `${it.unitsNeeded}× ${it.packGrams} g${it.leftoverGrams > 0 ? ` · ${it.leftoverGrams} g left` : ""}`;
    price.innerHTML = `$${money(it.realCost)}<span class="est-note">${detail}</span>`;

    row.appendChild(name);
    row.appendChild(deal);
    row.appendChild(price);
    return row;
  }

  function renderTrips(p) {
    const wrap = $("tripsContainer");
    wrap.innerHTML = "";
    p.trips.forEach((t, i) => {
      const card = el("article", "card breakdown");
      const head = el("div", "breakdown__head");
      const label = p.trips.length > 1 ? `Trip ${i + 1} · ${esc(t.store)}` : esc(t.store);
      head.innerHTML = `<h3>${label}</h3><span class="breakdown__at">$${money(t.realSubtotal)}</span>`;
      card.appendChild(head);
      const table = el("div", "ing-table");
      t.items.forEach((it) => table.appendChild(itemRow(it)));
      card.appendChild(table);
      wrap.appendChild(card);
    });
  }

  function renderExtras(p) {
    const wrap = $("planExtras");
    wrap.innerHTML = "";
    const parts = [];

    if (p.storeCount === 2 && p.oneStore) {
      parts.push(
        `<div class="card others"><div class="store-row"><div class="store-row__info">` +
          `<div class="store-row__name">Prefer one stop?</div>` +
          `<div class="store-row__meta">${esc(p.oneStore.name)} does the whole list for ~$${money(p.oneStore.fullTotal)} ` +
          `<span class="gap">+$${money(p.savingsVsOneStore)}</span> more</div></div></div></div>`,
      );
    }

    const elsewhere = (p.onSaleElsewhere || []).filter((e) => e.store);
    if (elsewhere.length) {
      parts.push(
        `<div class="card others"><h3>Cheaper at another store</h3><div class="others__list">` +
          elsewhere
            .map(
              (e) =>
                `<div class="store-row"><div class="store-row__info"><div class="store-row__name">${esc(e.ingredient)}</div>` +
                `<div class="store-row__meta">${esc(e.product || "")} at ${esc(e.store)}</div></div>` +
                `<div class="store-row__price"><div class="store-row__total">$${money(e.realCost)}</div></div></div>`,
            )
            .join("") +
          `</div></div>`,
      );
    }

    if ((p.neverOnSale || []).length) {
      parts.push(
        `<div class="card others"><h3>Not on sale anywhere</h3>` +
          `<p class="others__note" style="margin-top:8px">Buy at regular price wherever you shop: ${p.neverOnSale.map(esc).join(", ")}.</p></div>`,
      );
    }

    // Pantry staples the plan assumes you already own (excluded from the total).
    if ((p.staples || []).length) {
      const delta = Number(p.fullTotalWithStaples || 0) - Number(p.fullTotal || 0);
      parts.push(
        `<div class="card others"><h3>Pantry staples assumed</h3>` +
          `<p class="others__note" style="margin-top:8px">Assumes you have: ${p.staples.map((s) => esc(s.ingredient)).join(", ")}.` +
          (delta > 0.01 ? ` Buying them all adds ~$${money(delta)} (total $${money(p.fullTotalWithStaples)}).` : "") +
          `</p></div>`,
      );
    }

    wrap.innerHTML = parts.join("");
  }

  function render(data, source) {
    renderRecipe(data.recipe);
    renderHero(data.plan);
    renderTrips(data.plan);
    renderExtras(data.plan);

    const note = $("liveNote");
    if (source === "live") {
      note.hidden = false;
      note.innerHTML =
        `<b>Live flyer data.</b> Deals come from Flipp's unofficial feed for your area and are matched by AI, ` +
        `so coverage and accuracy vary. Prices are flyer sale prices, not coupons; pack sizes are best-effort.`;
    } else {
      note.hidden = true;
    }
  }

  /* ---------- search ---------- */
  const LOADING_SAMPLE = ["Checking weekly flyers…", "Matching deals to your basket…", "Crowning the cheapest cart…"];
  const LOADING_LIVE = [
    "Reading real flyers near you…",
    "Asking AI to match each ingredient…",
    "Pricing the whole recipe…",
    "This takes ~30 seconds…",
  ];

  // `onSuccess` (optional) fires only after a successful render, so failed
  // searches don't pollute the Recents list.
  function runSearch(zip, dinner, people, source, onSuccess) {
    show("loadingState");
    $("searchBtn").disabled = true;
    $("footStamp").textContent = source === "live" ? "live flyer data" : "sample data";

    const msgs = source === "live" ? LOADING_LIVE : LOADING_SAMPLE;
    let mi = 0;
    $("loadingMsg").textContent = msgs[0];
    const msgTimer = setInterval(() => {
      mi = (mi + 1) % msgs.length;
      $("loadingMsg").textContent = msgs[mi];
    }, source === "live" ? 4000 : 700);

    const done = () => {
      clearInterval(msgTimer);
      $("searchBtn").disabled = false;
    };

    fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postal: zip, dinner: dinner, people: people, live: source === "live" }),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        done();
        if (!ok) {
          $("noResultsMsg").textContent = body.error || "Something went wrong.";
          show("noResults");
          return;
        }
        if (!body.plan || body.plan.storeCount === 0) {
          $("noResultsMsg").textContent = `No deals found near “${zip}” for that dinner. Try a different postal code or dish.`;
          show("noResults");
          return;
        }
        render(body, source);
        show("results");
        if (onSuccess) onSuccess();
        const r = $("results");
        r.classList.remove("is-in");
        requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add("is-in")));
        window.scrollTo({ top: 0, behavior: "smooth" });
      })
      .catch((err) => {
        done();
        $("noResultsMsg").textContent = err.message || "Network error.";
        show("noResults");
      });
  }

  /* ---------- recent searches ---------- */
  const LS_KEY = "pantrydeal.recents";
  const loadRecents = () => {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
  };
  function saveRecent(entry) {
    let r = loadRecents().filter(
      (x) => !(x.zip === entry.zip && x.dinner.toLowerCase() === entry.dinner.toLowerCase() && x.people === entry.people),
    );
    r.unshift(entry);
    r = r.slice(0, 4);
    localStorage.setItem(LS_KEY, JSON.stringify(r));
    renderRecents();
  }
  function renderRecents() {
    const r = loadRecents();
    const box = $("recents");
    const list = $("recentsList");
    if (!r.length) { box.hidden = true; return; }
    box.hidden = false;
    list.innerHTML = "";
    r.forEach((entry) => {
      const b = el("button", "recent");
      b.type = "button";
      b.innerHTML = `<b>${esc(entry.dinner)}</b> · ${entry.people}p · ${esc(entry.zip)}`;
      b.addEventListener("click", () => {
        $("zip").value = entry.zip;
        $("dinner").value = entry.dinner;
        $("people").value = entry.people;
        const src = document.querySelector(`input[name="source"][value="${entry.source}"]`);
        if (src && !src.disabled) src.checked = true;
        const source = document.querySelector('input[name="source"]:checked').value;
        runSearch(entry.zip, entry.dinner, entry.people, source, () =>
          saveRecent({ ...entry, source }),
        );
      });
      list.appendChild(b);
    });
  }

  /* ---------- suggestion chips ---------- */
  const SUGGESTIONS = ["Butter chicken", "Beef tacos", "Spaghetti bolognese", "Chicken stir-fry", "Margherita pizza"];
  function renderChips() {
    const box = $("dinnerChips");
    SUGGESTIONS.forEach((s) => {
      const c = el("button", "chip", s);
      c.type = "button";
      c.addEventListener("click", () => {
        $("dinner").value = s;
        $("dinner").classList.remove("invalid");
        $("dinner").focus();
      });
      box.appendChild(c);
    });
  }

  /* ---------- init ---------- */
  function init() {
    renderChips();
    renderRecents();

    document.querySelectorAll(".stepper__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = $("people");
        const step = parseInt(btn.dataset.step, 10);
        let v = parseInt(input.value, 10) || 1;
        input.value = Math.min(20, Math.max(1, v + step));
      });
    });

    $("searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const zip = $("zip").value.trim();
      const dinner = $("dinner").value.trim();
      let people = parseInt($("people").value, 10);
      if (!Number.isFinite(people) || people < 1) people = 1;
      people = Math.min(20, people);
      $("people").value = people;
      const source = document.querySelector('input[name="source"]:checked').value;

      let ok = true;
      if (!zip) { $("zip").classList.add("invalid"); ok = false; } else $("zip").classList.remove("invalid");
      if (!dinner) { $("dinner").classList.add("invalid"); ok = false; } else $("dinner").classList.remove("invalid");
      if (!ok) { (zip ? $("dinner") : $("zip")).focus(); return; }

      runSearch(zip, dinner, people, source, () => saveRecent({ zip, dinner, people, source }));
    });

    ["zip", "dinner"].forEach((id) =>
      $(id).addEventListener("input", () => $(id).classList.remove("invalid")),
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
