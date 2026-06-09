// PantryDeal "price any recipe" view — talks to /api/recipe.
// Parses a recipe URL (or pasted text) server-side, prices it through the same
// pipeline as the other views, and shows a gentle prediabetes blood-sugar read.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const perKg = (ppg) => money(ppg * 1000) + "/kg";
  const hasUnit = (raw) => /\/\s*\d*\s*(lb|kg|g|oz|ml|l)\b/i.test(raw || "");
  const km = (d) => (d || d === 0 ? Number(d).toFixed(1) + " km" : "");
  const isPlaceholderAddr = (a) => !a || /^near\b/i.test(a);
  const mapsUrl = (store, address, postal) =>
    "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent([store, isPlaceholderAddr(address) ? postal : address].filter(Boolean).join(" "));
  const initials = (name) =>
    String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  // A collapsible FAQ-style section. `metaHtml`/`bodyHtml` are raw HTML —
  // callers MUST esc() any data-derived text. `title` is escaped here.
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
        showStatus("Recipe import needs GEMINI_API_KEY set on the server.", true);
        $("recipeBtn").disabled = true;
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

  function whereSection(plan, postal) {
    const trips = plan.trips || [];
    if (!trips.length) return "";
    const cards = trips
      .map((t, i) => {
        const dist = km(t.distanceKm);
        const showMerchant = t.merchant && !String(t.store).includes(t.merchant);
        const line2 = [showMerchant ? esc(t.merchant) : "", esc(t.address)].filter(Boolean).join(" · ");
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
        ? trips.length + " stops — listed in the order that keeps your cart cheapest."
        : "One stop covers your whole on-sale list.";
    const meta = '<span class="panel__pill">' + trips.length + (trips.length === 1 ? " store" : " stores") + "</span>";
    return section("Where to shop", meta, '<p class="panel__lead">' + lead + "</p>" + cards, true);
  }

  // The differentiator: a gentle prediabetes read on the imported recipe.
  function healthSection(h) {
    if (!h) return "";
    const ps = h.perServing;
    const macros =
      '<div class="meal__macros">' +
      '<span class="macro"><b>' + ps.carbsG + "g</b> carb</span>" +
      '<span class="macro"><b>' + ps.fiberG + "g</b> fiber</span>" +
      '<span class="macro"><b>' + ps.proteinG + "g</b> protein</span>" +
      "</div>";
    const verdict = h.verdict
      ? '<p class="health__verdict ' + (h.verdict.fits ? "is-ok" : "is-amber") + '">' +
        (h.verdict.fits ? "✓ Fits the draft prediabetes targets." : "⚠ " + esc(h.verdict.notes.join("; "))) +
        "</p>"
      : "";
    const swaps = (h.swaps || []).length
      ? '<div class="health__swaps"><div class="health__swaps-h">Lower-carb swaps</div>' +
        h.swaps
          .map((s) => '<div class="swap-row">💡 <b>' + esc(s.ingredient) + "</b> — " + esc(s.suggestion) + "</div>")
          .join("") +
        "</div>"
      : "";
    const coverage = h.coverageNote ? '<p class="health__cov">' + esc(h.coverageNote) + "</p>" : "";
    const body =
      '<p class="panel__lead">Per serving (estimate, not medical advice)</p>' +
      macros +
      '<p class="health__read">' + esc(h.read) + "</p>" +
      verdict +
      swaps +
      coverage;
    const meta = '<span class="panel__pill">' + ps.carbsG + "g carb / serving</span>";
    return section("Blood-sugar lens", meta, body, true);
  }

  function cartSection(plan) {
    const tripsHtml = plan.trips
      .map((t) => {
        const head =
          plan.trips.length > 1
            ? '<div class="cart-store"><span class="cart-store__name">' + esc(t.store) + '</span><span class="cart-store__sub">' + money(t.realSubtotal) + "</span></div>"
            : "";
        return head + '<div class="ing-table">' + t.items.map(itemRow).join("") + "</div>";
      })
      .join("");
    const gaps = plan.neverOnSale && plan.neverOnSale.length
      ? '<p class="note">Buy at regular price (not on sale near you this week): ' + plan.neverOnSale.map(esc).join(", ") + ".</p>"
      : "";
    const meta = '<span class="panel__meta-val">' + money(plan.fullTotal) + '</span><span class="panel__pill">' + plan.coverage + "/" + plan.totalIngredients + " on sale</span>";
    return section("Shopping cart", meta, tripsHtml + gaps, false);
  }

  function render(data) {
    const plan = data.plan;
    const r = data.recipe;
    $("heroDish").textContent = r.dish;
    $("heroSub").textContent =
      r.ingredients.length + " ingredients · " + plan.coverage + "/" + plan.totalIngredients + " on sale · " + esc(data.postal);
    $("heroTotal").textContent = Number(plan.fullTotal).toFixed(2);
    const save = plan.savingsVsRegular;
    $("savePill").textContent = save && save > 0.5 ? "saved ~" + money(save) + " vs. regular price" : "best prices we found";
    $("heroNote").textContent = plan.storeCount > 1 ? plan.storeCount + " stops" : "1 stop";

    if (!plan.trips.length) {
      // Parsed fine but nothing matched a local deal — still show the recipe + health read.
      $("resultsContainer").innerHTML =
        healthSection(data.health) +
        section("Shopping cart", "", '<p class="note">No deals matched near ' + esc(data.postal) + " this week. Try a different postal code.</p>", true);
    } else {
      $("resultsContainer").innerHTML =
        whereSection(plan, data.postal) + healthSection(data.health) + cartSection(plan);
    }
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

  $("pasteToggle").addEventListener("click", () => {
    const f = $("pasteField");
    const show = f.style.display === "none";
    f.style.display = show ? "" : "none";
    $("pasteToggle").textContent = show ? "…use a link instead" : "…or paste the ingredients instead";
    if (show) $("text").focus();
  });

  function run() {
    const postal = $("zip").value.trim();
    const url = $("url").value.trim();
    const text = $("text").value.trim();
    const people = Math.min(12, Math.max(1, parseInt($("people").value, 10) || 4));
    if (!postal) return showStatus("Enter your postal code.", true);
    if (!url && !text) return showStatus("Paste a recipe link, or paste the ingredients.", true);

    $("recipeBtn").disabled = true;
    showStatus('<div class="spinner"></div>Reading the recipe and pricing it with AI… ~30s.');
    fetch("/api/recipe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postal, url: url || undefined, text: text || undefined, people }),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) {
          // If a URL failed, nudge toward the always-works paste box.
          const urlFailed = body.code && body.code !== "InvalidUrlError" && url && !text;
          showStatus(
            esc(body.error || "Something went wrong.") +
              (urlFailed ? ' <button type="button" id="openPaste" class="linklike">Paste the ingredients instead →</button>' : ""),
            true,
          );
          const op = $("openPaste");
          if (op) op.addEventListener("click", () => { $("pasteToggle").click(); $("status").hidden = true; });
        } else {
          render(body);
        }
      })
      .catch((err) => showStatus(esc(err.message || "Network error."), true))
      .finally(() => {
        $("recipeBtn").disabled = false;
      });
  }

  $("recipeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    run();
  });
})();
