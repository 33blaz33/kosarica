// basket.js


// -----------------------------
// Basket page logic
// -----------------------------
$(document).ready(function () {
  let products = [];

  const fmt = (n) => {
    const x = Number(n);
    return Number.isFinite(x) ? x.toFixed(2) : "0.00";
  };

  // search normalize (case-insensitive + ignore č/š/ž etc)
  const norm = (s) =>
    (s ?? "")
      .toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

  const isValidStore = (url) => {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return ["spar.si", "mercator.si", "mercatoronline.si", "hofer.si"].some((d) => h.includes(d));
    } catch (e) {
      return false;
    }
  };

  const sameYMD = (a, b) => {
    const da = new Date(a);
    const db = new Date(b);
    if (isNaN(da) || isNaN(db)) return false;
    return (
      da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate()
    );
  };

  // ---------------------------
  // Render cards
  // ---------------------------
  function renderList() {
    const $list = $("#product-list");
    const $template = $("#product-template");
    const $emptyState = $("#empty-state");
    const $controls = $("#controls-bar");

    $list.empty();

    // If no products at all
    if (!products.length) {
      $emptyState.removeClass("hidden");
      $controls.addClass("hidden");
      return;
    }

    // We have products -> show controls
    $emptyState.addClass("hidden");
    $controls.removeClass("hidden");

    // Sort
    const sortMode = $("#sort-select").val();
    let sorted = [...products];

    const getEqMeta = (eq, product) => {
      const hist = Array.isArray(eq?.history) ? [...eq.history] : [];
      hist.sort((a, b) => new Date(b.date) - new Date(a.date));

      const latest = Number((hist[0]?.price ?? eq?.price ?? product?.price) ?? 0) || 0;
      const prev = Number((hist[1]?.price ?? latest) ?? 0) || latest;

      const diff = latest - prev;

      return {
        hist,
        latest,
        prev,
        diff,
        changed: hist.length > 1 && diff !== 0,
        absDiff: Math.abs(diff),
        lastDate: hist[0]?.date ? new Date(hist[0].date).getTime() : 0,
      };
    };

    const getCardMeta = (product) => {
      const secondary = Array.isArray(product.secondary) ? product.secondary : [];

      let changed = false;
      let maxAbsDiff = 0;
      let mostRecentChangeTs = 0;

      for (const eq of secondary) {
        const m = getEqMeta(eq, product);
        if (m.changed) {
          changed = true;
          if (m.absDiff > maxAbsDiff) maxAbsDiff = m.absDiff;
          if (m.lastDate > mostRecentChangeTs) mostRecentChangeTs = m.lastDate;
        }
      }

      return { changed, maxAbsDiff, mostRecentChangeTs };
    };


    if (sortMode === "name_asc") {
      // Naziv
      sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (sortMode === "price_delta") {
      // Sprememba cene: changed on top, then biggest change
      const meta = new Map(sorted.map((p) => [p.id, getCardMeta(p)]));

      sorted.sort((a, b) => {
        const A = meta.get(a.id);
        const B = meta.get(b.id);

        // 1) changed cards on top
        if (A.changed !== B.changed) return Number(B.changed) - Number(A.changed);

        // 2) biggest price change first (any secondary)
        if (B.maxAbsDiff !== A.maxAbsDiff) return B.maxAbsDiff - A.maxAbsDiff;

        // 3) more recently changed first
        if (B.mostRecentChangeTs !== A.mostRecentChangeTs) return B.mostRecentChangeTs - A.mostRecentChangeTs;

        // 4) tie-breaker
        return (b.id || 0) - (a.id || 0);
      });
    } else {
      // Zadnje dodano
      sorted.sort((a, b) => (b.id || 0) - (a.id || 0));
    }

    // Filter by product name (FIXED)
    const q = norm($("#name-input").val()).trim();
    if (q) {
      sorted = sorted.filter((p) => norm(p.name).includes(q));
    }

    // If filter yields no results -> show empty state but keep controls visible
    if (!sorted.length) {
      $emptyState.removeClass("hidden");
      return;
    } else {
      $emptyState.addClass("hidden");
    }

    // Render cards
    sorted.forEach((product) => {
      const $clone = $($template.html());
      const secondary = Array.isArray(product.secondary) ? product.secondary : [];

      const selfEq =
        secondary.find((s) => Number(s.product_id) === Number(product.id)) ||
        secondary.find((s) => s.url === product.url) ||
        null;

      const hist = Array.isArray(selfEq?.history) ? [...selfEq.history] : [];
      hist.sort((a, b) => new Date(b.date) - new Date(a.date));

      const latestPrice = hist.length ? Number(hist[0].price) : Number(product.price || 0);
      const prevPrice = hist.length > 1 ? Number(hist[1].price) : latestPrice;
      const diff = latestPrice - prevPrice;

      const latestPricePerUnit = hist.length
        ? Number(hist[0].price_per_unit ?? 0)
        : Number(product.price_per_unit ?? 0);

      const mainUnit = selfEq?.unit || product.unit || "";
      const lastChecked = hist.length ? hist[0].date : null;

      $clone.attr("data-id", product.id);
      $clone.attr("data-self-secondary-id", selfEq?.id || "");

      // Name + link + store badge
      $clone.find(".product-name").text(product.name || "Izdelek");
      $clone.find(".product-name-link").attr("href", product.url).attr("title", product.name || "");
      $clone.find(".store-badge").text(getStoreName(product.url));

      // Total price
      $clone.find(".product-price").text(`${fmt(latestPrice)} EUR`);

      // Unit price visibility
      const hasUnit = Number(latestPricePerUnit) > 0 && !!mainUnit;
      if (!hasUnit) $clone.find(".product-unit-price").addClass("hidden");
      else $clone.find(".product-unit-price").removeClass("hidden");

      // Price change
      if (hist.length > 1 && diff !== 0) {
        const colorClass = diff > 0 ? "text-red-500" : "text-green-600";
        const arrow = diff > 0 ? "▲" : "▼";
        $clone
          .find(".price-change")
          .text(`${arrow} ${fmt(Math.abs(diff))} EUR`)
          .removeClass("text-red-500 text-green-600")
          .addClass(colorClass);
      } else {
        $clone.find(".price-change").text("").removeClass("text-red-500 text-green-600");
      }

      // Last checked (date only)
      const dateStr = lastChecked ? new Date(lastChecked).toLocaleDateString("sl-SI") : "-";
      $clone.find(".last-checked").text(`Posodobljeno: ${dateStr}`);

      // Image
      const img = product.image_src || "";
      const $imgEl = $clone.find(".product-img");
      const $ph = $clone.find(".product-img-placeholder");

      if (!img) {
        $imgEl.hide();
        $ph.removeClass("hidden");
      } else {
        $imgEl
          .attr("src", img)
          .off("error")
          .on("error", function () {
            $(this).hide();
            $ph.removeClass("hidden");
          })
          .show();
        $ph.addClass("hidden");
      }

      // Secondary list
      if (secondary.length > 1) {
        const $eqList = $clone.find(".secondary-list");
        const basePerUnit = Number(latestPricePerUnit || 0);

        secondary.forEach((eq) => {
          const eqHist = Array.isArray(eq.history) ? [...eq.history] : [];
          eqHist.sort((a, b) => new Date(b.date) - new Date(a.date));

          const eqLatestPerUnit = eqHist.length
            ? Number(eqHist[0].price_per_unit ?? 0)
            : Number(eq.price_per_unit ?? 0);

          const eqUnit = eq.unit || mainUnit || "";
          const isSelf = Number(eq.product_id) === Number(product.id) || eq.url === product.url;

          const eqDiffPerUnit = isSelf ? 0 : eqLatestPerUnit - basePerUnit;
          const sign = eqDiffPerUnit === 0 ? "=" : eqDiffPerUnit < 0 ? "" : "+";

          const color =
            eqDiffPerUnit === 0
              ? "text-gray-500"
              : eqDiffPerUnit < 0
                ? "text-green-600 font-bold"
                : "text-red-500";

          const nameLabel = eq.name || "Primerjava";

          const deleteBtnHtml = isSelf
            ? ""
            : `
              <button
                type="button"
                class="btn-delete-secondary text-gray-500 hover:text-red-600 px-2 py-1 rounded"
                title="Odstrani primerjavo"
                data-secondary-id="${eq.id}">
                <i class="fa-solid fa-trash"></i>
              </button>
            `;

          const showPrice = Number(eqLatestPerUnit) > 0 && !!eqUnit;
          const showDiff = !isSelf && showPrice && basePerUnit > 0;

          const eqHtml = `
            <div class="flex items-center justify-between p-2 my-2 bg-blue-50 rounded-lg border border-blue-100 text-sm">
              <div class="min-w-0 flex-1 pr-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="bg-blue-200 text-blue-800 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase">
                    ${getStoreName(eq.url)}
                  </span>
                  <a href="${eq.url}" target="_blank"
                    class="font-medium text-gray-800 truncate block min-w-0"
                    title="${eq.name || ""}">
                    ${nameLabel}
                  </a>
                </div>
              </div>

              <div class="text-right flex items-center gap-3">
                <div>
                  <div class="font-bold text-gray-900">
                    ${showPrice
              ? `<span>${fmt(eqLatestPerUnit)}</span> <span class="text-[10px] text-gray-500">EUR/${eqUnit}</span>`
              : "-"
            }
                  </div>
                  <div class="text-[10px] ${color}">
                    ${showDiff
              ? `<span>${sign}${fmt(eqDiffPerUnit)}</span> <span class="text-[9px] text-gray-500">EUR/${eqUnit}</span>`
              : isSelf
                ? ""
                : ""
            }
                  </div>
                </div>

                ${deleteBtnHtml}
              </div>
            </div>
          `;

          $eqList.append(eqHtml);
        });
      }

      // Chart ID
      $clone.find(".price-chart").attr("id", `chart-${product.id}`);

      // Loading state
      if (product.isLoading) {
        $clone.find(".btn-refresh").addClass("animate-spin text-gray-400").prop("disabled", true);
      } else {
        $clone.find(".btn-refresh").removeClass("animate-spin text-gray-400").prop("disabled", false);
      }

      $list.append($clone);

      setTimeout(() => {
        renderChart(product.id, product.secondary || []);
      }, 0);
    });
  }

  // ---------------------------
  // Fetch products
  // ---------------------------
  async function loadProducts() {
    try {
      const res = await $.get("/api/products");
      products = Array.isArray(res) ? res : [];
      renderList();
    } catch (err) {
      console.error(err?.responseJSON?.error || err?.message);
      products = [];
      renderList();
    }
  }

  // ---------------------------
  // Add main product
  // ---------------------------
  $("#add-product-form").on("submit", async function (e) {
    e.preventDefault();

    const url = $("#url-input").val();
    const $btn = $("#btn-add");
    const $error = $("#add-error");

    if (!isValidStore(url)) {
      $error.text("Podprte so le trgovine: Spar, Mercator in Hofer.").removeClass("hidden");
      return;
    }

    $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin mr-2"></i> Analiziram...');
    $error.addClass("hidden");

    try {
      const product = await $.getJSON("/api/extract", { url });

      await $.ajax({
        url: "/api/product",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify(product),
      });

      $("#url-input").val("");
      await loadProducts();
    } catch (err) {
      console.error(err?.responseJSON?.error);
      $error.text(err?.responseJSON?.error || "Napaka pri dodajanju izdelka.").removeClass("hidden");
    } finally {
      $btn.prop("disabled", false).html('<i class="fa-solid fa-plus mr-2"></i> Dodaj');
    }
  });

  // ---------------------------
  // Delete main product
  // ---------------------------
  $(document).on("click", ".btn-delete", async function () {
    const $card = $(this).closest(".product-card");
    const selfSecondaryId = $card.data("self-secondary-id");
    if (!selfSecondaryId) return;

    try {
      await $.ajax({ url: `/api/product/${encodeURIComponent(selfSecondaryId)}`, method: "DELETE" });
      await loadProducts();
    } catch (err) {
      console.error(err?.responseJSON?.error);
      alert("Napaka pri odstranjevanju.");
    }
  });

  // ---------------------------
  // Delete secondary
  // ---------------------------
  $(document).on("click", ".btn-delete-secondary", async function () {
    const secondaryId = $(this).data("secondary-id");
    if (!secondaryId) return;

    try {
      await $.ajax({
        url: `/api/secondary/${encodeURIComponent(secondaryId)}`,
        method: "DELETE",
      });
      await loadProducts();
    } catch (err) {
      console.error(err?.responseJSON?.error);
      alert("Brisanje primerjave ni uspelo.");
    }
  });

  // ---------------------------
  // Refresh helpers
  // ---------------------------
  async function refreshProductAndSecondary(product) {
    if (product.secondary && product.secondary.length) {
      for (const ps of product.secondary) {
        const params = { url: ps.url };
        if (ps?.code) params.code = ps.code;

        // refresh only once per day
        const lastDate = ps.history?.[0]?.date;
        const alreadyToday = lastDate ? sameYMD(lastDate, new Date()) : false;

        if (!alreadyToday) {
          const p = await $.getJSON("/api/extract", params);
          p.parentProductId = product.id;

          await $.ajax({
            url: "/api/product",
            method: "POST",
            contentType: "application/json",
            data: JSON.stringify(p),
          });
        }
      }
    }
  }

  // ---------------------------
  // Refresh single product
  // ---------------------------
  $(document).on("click", ".btn-refresh", async function () {
    const id = $(this).closest(".product-card").data("id");
    const product = products.find((p) => p.id === id);
    if (!product || product.isLoading) return;

    product.isLoading = true;
    renderList();

    try {
      await refreshProductAndSecondary(product);
      await loadProducts();
    } catch (err) {
      console.error(err?.responseJSON?.error);
      alert("Osvežitev ni uspela.");
      product.isLoading = false;
      renderList();
    }
  });

  // ---------------------------
  // Refresh all
  // ---------------------------
  $("#btn-refresh-all").on("click", async function () {
    if (!products.length) return;

    const $btn = $(this);
    $btn.addClass("opacity-50 cursor-not-allowed").find("i").addClass("fa-spin");

    try {
      for (const p of products) {
        try {
          await refreshProductAndSecondary(p);
        } catch (_) { }
        await new Promise((r) => setTimeout(r, 600));
      }
      await loadProducts();
    } finally {
      $btn.removeClass("opacity-50 cursor-not-allowed").find("i").removeClass("fa-spin");
    }
  });

  // ---------------------------
  // Sort change
  // ---------------------------
  $("#sort-select").on("change", function () {
    renderList();
  });

  // ---------------------------
  // Compare UI
  // ---------------------------
  $(document).on("click", ".btn-toggle-compare", function () {
    $(this).closest(".product-card").find(".compare-form-container").removeClass("hidden");
  });

  $(document).on("click", ".btn-cancel-compare", function () {
    $(this).closest(".compare-form-container").addClass("hidden").find("input").val("");
    $(this).closest(".compare-form-container").find(".compare-error").addClass("hidden");
  });

  // ---------------------------
  // - use input event (with tiny debounce)
  // ---------------------------
  let searchTimer = null;
  $("#name-input").on("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderList(), 80);
  });

  // ---------------------------
  // Add secondary product
  // ---------------------------
  $(document).on("submit", ".form-add-compare", async function (e) {
    e.preventDefault();
    const $form = $(this);
    const url = $form.find("input").val();
    const parentProductId = $form.closest(".product-card").data("id");
    const $btn = $form.find('button[type="submit"]');
    const $error = $form.find(".compare-error");

    if (!isValidStore(url)) {
      $error.text("Neveljavna trgovina.").removeClass("hidden");
      return;
    }

    $btn.prop("disabled", true).text("Dodajam...");
    $error.addClass("hidden");

    try {
      const product = await $.getJSON("/api/extract", { url });
      product.parentProductId = parentProductId;

      await $.ajax({
        url: "/api/product",
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify(product),
      });

      await loadProducts();
      $form.closest(".compare-form-container").addClass("hidden").find("input").val("");
    } catch (err) {
      console.error(err?.responseJSON?.error);
      $error.text(err?.responseJSON?.error || "Napaka pri dodajanju primerjave.").removeClass("hidden");
    } finally {
      $btn.prop("disabled", false).text("Dodaj");
    }
  });

  loadProducts();
});
