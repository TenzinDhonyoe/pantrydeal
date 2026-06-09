// PantryDeal prediabetes week planner — talks to /api/plan-week.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const perKg = (ppg) => money(ppg * 1000) + "/kg";
  const hasUnit = (raw) => /\/\s*\d*\s*(lb|kg|g|oz|ml|l)\b/i.test(raw || "");
  const km = (d) => (d || d === 0 ? Number(d).toFixed(1) + " km" : "");
  // Live-mode stores have no street address — Backflipp stamps a "Near <postal>"
  // placeholder. Don't feed that into Maps; fall back to the store name + postal.
  const isPlaceholderAddr = (a) => !a || /^near\b/i.test(a);
  const mapsUrl = (store, address, postal) =>
    "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent([store, isPlaceholderAddr(address) ? postal : address].filter(Boolean).join(" "));
  const initials = (name) =>
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // A collapsible FAQ-style section. `open` controls the initial state.
  // `title` is plain text (escaped here). `metaHtml` and `bodyHtml` are raw
  // HTML — callers MUST esc() any data-derived text they put in them.
  function section(title, metaHtml, bodyHtml, open) {
    return (
      '<details class="panel"' + (open ? " open" : "") + ">" +
      '<summary class="panel__head"><span class="panel__title">' + esc(title) + "</span>" +
      (metaHtml ? '<span class="panel__meta">' + metaHtml + "</span>" : "") +
      '<svg class="panel__chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      "</summary>" +
      '<div class="panel__body">' + bodyHtml + "</div></details>"
    );
  }

  let liveAvailable = false;
  fetch("/api/config")
    .then((r) => r.json())
    .then((cfg) => {
      liveAvailable = Boolean(cfg.liveAvailable);
      if (!liveAvailable) {
        $("src-live").disabled = true;
        const l = document.querySelector('label[for="src-live"]');
        l.style.opacity = "0.45";
        l.title = "Set GEMINI_API_KEY on the server to enable live flyers";
      }
    })
    .catch(() => {});

  function showStatus(html, isError) {
    const s = $("status");
    s.hidden = false;
    s.className = "status" + (isError ? " error" : "");
    s.innerHTML = html;
    $("results").hidden = true;
  }

  function itemRow(it) {
    const flame = it.goodDeal ? "🔥 " : "";
    // A per-kg price only makes sense when you buy by weight. For a packaged
    // good you buy WHOLE units — you can't buy 0.8 of a can — so show the pack
    // price you actually pay and how many packs the week needs.
    const pack = it.basis === "pack" && it.packGrams > 0;
    const tag = flame + (pack ? money(it.packPrice) + " / " + it.packGrams + " g" : perKg(it.pricePerGram));
    const shelf = hasUnit(it.rawPrice) ? " · " + esc(it.rawPrice) : "";
    const packWord = it.packGrams >= 1000 ? "bag" : "pack";
    const detail = pack
      ? (it.unitsNeeded > 1 ? '<b class="buy-n">buy ' + it.unitsNeeded + " " + packWord + "s</b>" : "1 " + packWord) +
        " · need " + it.neededGrams + " g" +
        (it.leftoverGrams > 0 ? " · " + it.leftoverGrams + " g left" : "")
      : it.neededGrams + " g";
    return (
      '<div class="ing-row is-deal"><div class="ing-row__name">' + esc(it.ingredient) + "</div>" +
      '<div class="ing-row__deal"><span class="deal-tag">' + esc(tag) + '</span>' +
      '<span class="elsewhere">' + esc(it.product) + shelf + "</span></div>" +
      '<div class="ing-row__price">' + money(it.realCost) + '<span class="est-note">' + detail + "</span></div></div>"
    );
  }

  function menuSection(meals) {
    const macro = (val, label) =>
      '<span class="macro"><b>' + val + "</b> " + label + "</span>";
    const rows = meals
      .map((m, i) => {
        const nutri = m.nutrition
          ? '<div class="meal__macros">' +
            macro(m.nutrition.carbsG + "g", "carb") +
            macro(m.nutrition.fiberG + "g", "fiber") +
            macro(m.nutrition.proteinG + "g", "protein") +
            "</div>"
          : "";
        return (
          '<div class="meal">' +
          '<div class="meal__top"><span class="meal__num">' + (i + 1) + "</span>" +
          '<h4 class="meal__dish">' + esc(m.dish) + "</h4>" +
          '<button type="button" class="swap-btn" data-dish="' + esc(m.dish) + '">↻ swap</button></div>' +
          nutri +
          '<p class="meal__ings">' + m.ingredients.map((ing) => esc(ing.name)).join(", ") + "</p>" +
          "</div>"
        );
      })
      .join("");
    const meta = '<span class="panel__pill">all meet your targets ✓</span>';
    return section("This week’s dinners", meta, '<div class="meal-list">' + rows + "</div>", true);
  }

  // "Where to shop" — the direction the old UI never gave: named stores, in
  // visit order, each with an address + a one-tap Google Maps link.
  function whereSection(cart, postal) {
    const trips = cart.trips || [];
    if (!trips.length) return "";
    const cards = trips
      .map((t, i) => {
        const dist = km(t.distanceKm);
        // t.store is the store NAME; show the merchant only when it isn't already
        // part of that name (e.g. name "Fortinos Hamilton" already implies "Fortinos").
        const showMerchant = t.merchant && !String(t.store).includes(t.merchant);
        const line2 = [showMerchant ? esc(t.merchant) : "", esc(t.address)]
          .filter(Boolean)
          .join(" · ");
        const stop = trips.length > 1 ? '<span class="store-card__order">Stop ' + (i + 1) + "</span>" : "";
        return (
          '<div class="store-card">' +
          '<div class="store-card__mark">' + esc(initials(t.store)) + "</div>" +
          '<div class="store-card__info">' +
          '<div class="store-card__name">' + esc(t.store) + stop +
          (dist ? '<span class="store-card__dist">' + dist + "</span>" : "") + "</div>" +
          (line2 ? '<div class="store-card__addr">' + line2 + "</div>" : "") +
          "</div>" +
          '<div class="store-card__side">' +
          '<div class="store-card__sub">' + money(t.realSubtotal) + "</div>" +
          '<a class="store-card__dir" href="' + esc(mapsUrl(t.store, t.address, postal)) + '" target="_blank" rel="noopener">Directions ↗</a>' +
          "</div></div>"
        );
      })
      .join("");
    const lead =
      trips.length > 1
        ? trips.length + " stops this week — listed in the order that keeps your cart cheapest."
        : "One stop covers your whole on-sale list.";
    const meta = '<span class="panel__pill">' + trips.length + (trips.length === 1 ? " store" : " stores") + "</span>";
    return section("Where to shop", meta, '<p class="panel__lead">' + lead + "</p>" + cards, true);
  }

  function cartSection(cart) {
    const tripsHtml = cart.trips
      .map((t) => {
        const head =
          cart.trips.length > 1
            ? '<div class="cart-store"><span class="cart-store__name">' + esc(t.store) + '</span><span class="cart-store__sub">' + money(t.realSubtotal) + "</span></div>"
            : "";
        return head + '<div class="ing-table">' + t.items.map(itemRow).join("") + "</div>";
      })
      .join("");
    const gaps = cart.neverOnSale && cart.neverOnSale.length
      ? '<p class="note">Buy at regular price (not on sale anywhere this week): ' + cart.neverOnSale.map(esc).join(", ") + ".</p>"
      : "";
    const meta = '<span class="panel__meta-val">' + money(cart.fullTotal) + '</span><span class="panel__pill">' + cart.coverage + "/" + cart.totalIngredients + " on sale</span>";
    return section("Weekly shopping cart", meta, tripsHtml + gaps, false);
  }

  function render(data) {
    const feeds = data.people === 1 ? "1 person" : data.people + " people";
    $("heroDays").textContent =
      data.meals.length + (data.meals.length === 1 ? " dinner" : " dinners") + " · feeds " + feeds;
    // Lead with the affordability verdict, not the raw number.
    $("heroSub").textContent = data.withinBudget
      ? "✓ within your " + money(data.budget) + " budget · " + esc(data.postal)
      : money(data.overBy) + " over your " + money(data.budget) + " budget · " + esc(data.postal);
    $("heroTotal").textContent = Number(data.total).toFixed(2);
    const save = data.cart && data.cart.savingsVsRegular;
    $("budgetPill").textContent =
      save && save > 0.5 ? "saved ~" + money(save) + " vs. regular price" : "best prices we found this week";
    $("heroNote").textContent =
      (data.shortfall > 0 ? data.shortfall + " fewer than asked · " : "") + "not medical advice";
    $("mealsContainer").innerHTML =
      whereSection(data.cart, data.postal) + menuSection(data.meals) + cartSection(data.cart);
    $("status").hidden = true;
    $("results").hidden = false;
  }

  document.querySelectorAll(".stepper__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target || "people");
      const step = parseInt(btn.dataset.step, 10);
      const min = parseInt(input.min, 10) || 1;
      const max = parseInt(input.max, 10) || 99;
      input.value = Math.min(max, Math.max(min, (parseInt(input.value, 10) || min) + step));
    });
  });

  // Dishes the shopper has swapped out this session; re-planning excludes them.
  let excluded = [];

  function runPlan() {
    const postal = $("zip").value.trim();
    const budget = Number($("budget").value);
    const people = Math.min(12, Math.max(1, parseInt($("people").value, 10) || 1));
    const nights = Math.min(7, Math.max(1, parseInt($("nights").value, 10) || 5));
    const restrictions = $("restrictions").value.split(",").map((s) => s.trim()).filter(Boolean);
    const live = document.querySelector('input[name="source"]:checked').value === "live";
    if (!postal || !(budget > 0)) {
      showStatus("Enter a postal code and a weekly budget.", true);
      return;
    }
    $("planBtn").disabled = true;
    showStatus(
      '<div class="spinner"></div>' + (live ? "Reading real flyers and pricing the week with AI… ~30s." : "Pricing this week's compliant dinners…"),
    );
    fetch("/api/plan-week", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postal, budget, people, days: nights, live, restrictions, exclude: excluded }),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) showStatus(esc(body.error || "Something went wrong."), true);
        else if (!body.meals || !body.meals.length) showStatus("No more compliant dinners to plan. Reset and try a different budget or postal code.", true);
        else render(body);
      })
      .catch((err) => showStatus(esc(err.message || "Network error."), true))
      .finally(() => {
        $("planBtn").disabled = false;
      });
  }

  $("planForm").addEventListener("submit", (e) => {
    e.preventDefault();
    excluded = []; // fresh search resets swaps
    runPlan();
  });

  // Swap a dinner: exclude it and re-plan the rest.
  $("mealsContainer").addEventListener("click", (e) => {
    const btn = e.target.closest(".swap-btn");
    if (!btn) return;
    const dish = btn.dataset.dish;
    if (dish && !excluded.includes(dish)) excluded.push(dish);
    runPlan();
  });
})();
