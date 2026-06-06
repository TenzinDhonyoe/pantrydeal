// PantryDeal prediabetes week planner — talks to /api/plan-week.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const perKg = (ppg) => money(ppg * 1000) + "/kg";
  const hasUnit = (raw) => /\/\s*\d*\s*(lb|kg|g|oz|ml|l)\b/i.test(raw || "");

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
    const tag = (it.goodDeal ? "🔥 " : "") + perKg(it.pricePerGram);
    const shelf = hasUnit(it.rawPrice) ? " · " + esc(it.rawPrice) : "";
    const detail =
      it.basis === "weight"
        ? it.neededGrams + " g"
        : it.unitsNeeded + "× " + it.packGrams + " g" + (it.leftoverGrams > 0 ? " · " + it.leftoverGrams + " g left" : "");
    return (
      '<div class="ing-row is-deal"><div class="ing-row__name">' + esc(it.ingredient) + "</div>" +
      '<div class="ing-row__deal"><span class="deal-tag">' + esc(tag) + '</span>' +
      '<span class="elsewhere">' + esc(it.product) + shelf + "</span></div>" +
      '<div class="ing-row__price">' + money(it.realCost) + '<span class="est-note">' + detail + "</span></div></div>"
    );
  }

  function menuCard(meals) {
    const rows = meals
      .map((m) => {
        const nutri = m.nutrition
          ? '<span class="nutri">' + m.nutrition.carbsG + "g carb · " + m.nutrition.fiberG + "g fiber · " + m.nutrition.proteinG + "g protein</span>"
          : "";
        return (
          '<div class="ing-row">' +
          '<div class="ing-row__name">' + esc(m.dish) + nutri +
          '<div class="ing-row__deal"><span class="elsewhere">' + m.ingredients.map((i) => esc(i.name)).join(", ") + "</span></div></div>" +
          '<div class="ing-row__price"><button type="button" class="swap-btn" data-dish="' + esc(m.dish) + '">↻ swap</button></div>' +
          "</div>"
        );
      })
      .join("");
    return (
      '<article class="card breakdown"><div class="breakdown__head"><h3>This week’s dinners</h3>' +
      '<span class="breakdown__at">all meet your targets ✓</span></div>' +
      '<div class="ing-table">' + rows + "</div></article>"
    );
  }

  function cartCard(cart) {
    const tripsHtml = cart.trips
      .map((t) => {
        const head =
          cart.trips.length > 1
            ? '<div class="breakdown__head"><h3 style="font-size:15px">' + esc(t.store) + '</h3><span class="breakdown__at">' + money(t.realSubtotal) + "</span></div>"
            : "";
        return head + '<div class="ing-table">' + t.items.map(itemRow).join("") + "</div>";
      })
      .join("");
    const gaps = cart.neverOnSale && cart.neverOnSale.length
      ? '<p class="note">Buy at regular price (not on sale anywhere this week): ' + cart.neverOnSale.map(esc).join(", ") + ".</p>"
      : "";
    return (
      '<article class="card breakdown"><div class="breakdown__head"><h3>Weekly shopping cart</h3>' +
      '<span class="breakdown__at">' + money(cart.fullTotal) + " · " + cart.coverage + "/" + cart.totalIngredients + " on sale</span></div>" +
      tripsHtml + gaps + "</article>"
    );
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
    $("mealsContainer").innerHTML = menuCard(data.meals) + cartCard(data.cart);
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
