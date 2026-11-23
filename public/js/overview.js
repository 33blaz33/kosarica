// public/js/overview.js
$(document).ready(function () {
  let products = [];
  let isLoadingProducts = true;
  let sortMode = "name_asc"; // name_asc | name_desc | store_asc | store_desc

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const parsePrice = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
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
      return ["spar.si", "mercator.si", "mercatoronline.si", "dm.si", "mimovrste.com"].some((d) => h.includes(d));
    } catch (e) {
      return false;
    }
  };

  // IMPORTANT: compare by price_per_unit
  const samePrice = (a, b) => Math.abs(a - b) < 1e-9;

  const formatPricePerUnit = (n) => {
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(n < 10 ? 2 : 1);
  };

  const setLoading = (on) => {
    isLoadingProducts = !!on;
    $("#loading-screen").toggleClass("hidden", !isLoadingProducts);
    $("#empty-state").toggleClass("hidden", isLoadingProducts);
  };

  const groupByParent = (items) => {
    const map = new Map();
    for (const p of items) {
      const id = p.parent_product_id;
      if (id == null) continue;

      if (!map.has(id)) {
        map.set(id, {
          parent_product_id: id,
          parent_product_name: p.parent_product_name || p.name || "",
          items: [],
        });
      }
      map.get(id).items.push(p);
    }
    return Array.from(map.values());
  };

  function buildGroups(items) {
    return groupByParent(items).map((g) => {
      // sort by price_per_unit asc
      g.items.sort((a, b) => parsePrice(a.price_per_unit) - parsePrice(b.price_per_unit));

      const bestPrice = parsePrice(g.items[0]?.price_per_unit);
      g.bestPrice = bestPrice;

      // all items that share the lowest price_per_unit
      g.bestItems = g.items.filter((x) => samePrice(parsePrice(x.price_per_unit), bestPrice));

      // unit + image (take first non-empty)
      g.unit = g.items.find((x) => x.unit)?.unit || "";
      g.image_src = g.items.find((x) => x.image_src)?.image_src || "";

      // unique cheapest stores + url
      const storeMap = new Map();
      for (const bi of g.bestItems) {
        const store = (bi.store || "").trim();
        const url = bi.url || "#";
        if (!store) continue;
        if (!storeMap.has(store)) storeMap.set(store, url);
      }

      // sort store names for stable display
      g.bestStores = Array.from(storeMap.entries())
        .map(([store, url]) => ({ store, url }))
        .sort((a, b) => a.store.localeCompare(b.store, "sl"));

      // for store sorting: first store alphabetically among cheapest ones
      g.storeSortKey = g.bestStores[0]?.store || "";

      return g;
    });
  }

  function sortGroups(groups) {
    const nameCmp = (a, b) =>
      (a.parent_product_name || "").localeCompare(b.parent_product_name || "", "sl");

    const storeCmp = (a, b) => {
      const s = (a.storeSortKey || "").localeCompare(b.storeSortKey || "", "sl");
      return s !== 0 ? s : nameCmp(a, b);
    };

    switch (sortMode) {
      case "store_asc":
        groups.sort(storeCmp);
        break;
      case "store_desc":
        groups.sort((a, b) => storeCmp(b, a));
        break;
      case "name_asc":
      default:
        groups.sort(nameCmp);
        break;
    }
    return groups;
  }

  function renderList() {
    const $list = $("#product-list");

    const loadingCardHtml = $("#loading-screen").prop("outerHTML");
    $list.empty().append(loadingCardHtml);

    if (isLoadingProducts) return;

    let items = Array.isArray(products) ? products : [];

    // Filter by product name
    const q = norm($("#name-input").val()).trim();
    if (q) {
      items = items.filter((p) => norm(p.parent_product_name).includes(q));
    }

    if (items.length === 0) {
      $("#empty-state").removeClass("hidden");
      return;
    }
    $("#empty-state").addClass("hidden");

    let groups = buildGroups(items);
    groups = sortGroups(groups);

    const html = groups
      .map((g) => {
        const parentName = escapeHtml(g.parent_product_name);
        const bestPpu = formatPricePerUnit(g.bestPrice);

        const unitLabel = (g.unit || "en.").trim();
        const unitHtml = escapeHtml(unitLabel);

        const imgSrc = (g.image_src || "").trim();
        const imgHtml = imgSrc
          ? `<img src="${imgSrc}" alt="" class="h-14 w-14 rounded-lg border border-gray-200 bg-white object-contain" loading="lazy" />`
          : `<div class="h-14 w-14 rounded-lg border border-gray-200 bg-gray-50"></div>`;

        const storesHtml =
          g.bestStores.length > 0
            ? g.bestStores
              .map(
                (s) => `
                    <a class="text-xs text-gray-600 hover:text-gray-900 hover:underline"
                       href="${s.url}" target="_blank" rel="noopener">
                      ${escapeHtml(s.store)}
                    </a>
                  `
              )
              .join(`<span class="text-gray-300">=</span>`)
            : `<span class="text-xs text-gray-400">—</span>`;

        return `
          <div class="rounded-xl border border-gray-200 bg-white shadow-sm">
            <div class="px-4 py-3 flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 min-w-0">
                ${imgHtml}

                <div class="min-w-0">
                  <div class="text-sm font-medium text-gray-900 line-clamp-2">
                    ${g.items[0].name}
                  </div>

                  <div class="mt-1 flex items-center gap-2 flex-wrap">
                    <span class="text-xs text-gray-500">Najceneje pri:</span>
                    ${storesHtml}
                  </div>
                </div>
              </div>

              <div class="shrink-0 text-right">
                <div class="text-base font-semibold text-gray-900 leading-none">
                  ${bestPpu} €
                </div>
                <div class="mt-1 text-[11px] text-gray-500">
                  / ${unitHtml}
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    $list.append(html);
  }

  // ---------------------------
  // Sort dropdown
  // ---------------------------
  $("#sort-select").on("change", function () {
    sortMode = $(this).val() || "name_asc";
    renderList();
  });

  // ---------------------------
  // Search input (tiny debounce)
  // ---------------------------
  let searchTimer = null;
  $("#name-input").on("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderList(), 80);
  });

  async function loadProducts() {
    setLoading(true);
    try {
      const res = await $.get("/api/overview");
      products = Array.isArray(res) ? res : [];
    } catch (err) {
      console.error(err?.responseJSON?.error || err?.message);
      products = [];
    } finally {
      setLoading(false);
      renderList();
    }
  }

  setLoading(true);
  loadProducts();
});
