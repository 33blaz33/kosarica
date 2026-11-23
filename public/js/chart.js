// -----------------------------
// Chart
// -----------------------------
const chartInstances = {};

const getStoreName = (url) => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("spar")) return "Spar";
    if (hostname.includes("mercator")) return "Mercator";
    if (hostname.includes("hofer")) return "Hofer";
    if (hostname.includes("dm")) return "DM";
    if (hostname.includes("mimovrste")) return "Mimovrste";
    return hostname.replace("www.", "");
  } catch (e) {
    return "Trgovina";
  }
};

const getArticleName = (eq) =>
  eq?.fullArticleName ||
  eq?.articleName ||
  eq?.name ||
  eq?.title ||
  eq?.productName ||
  eq?.product_title ||
  "";

// Draw chart for product
function renderChart(productId, secondary = []) {
  const ctx = document.getElementById(`chart-${productId}`);
  if (!ctx) return;

  if (chartInstances[productId]) {
    chartInstances[productId].destroy();
  }

  const toDateKey = (d) => {
    const dt = new Date(d);
    if (isNaN(dt)) return String(d);
    return dt.toISOString(); // full datetime key
  };

  const sec = Array.isArray(secondary) ? secondary : [];

  // Build series from ALL secondary objects
  let series = sec
    .map((eq) => {
      const m = new Map();
      const h = Array.isArray(eq.history) ? eq.history : [];
      h.forEach((pt) => m.set(toDateKey(pt.date), Number(pt.price)));

      // fallback single point with current price
      if (m.size === 0 && eq.price != null) {
        const p = Number(eq.price);
        if (Number.isFinite(p) && p > 0) m.set(toDateKey(new Date().toISOString()), p);
      }

      return {
        url: eq.url,
        map: m,
        articleName: getArticleName(eq),
        // main line if product_id matches current productId
        isMain: Number(eq.product_id) === Number(productId),
      };
    })
    .filter((s) => s.map.size > 0);

  if (!series.length) return;

  // ensure main series is first (so it always gets the blue color)
  if (series.some((s) => s.isMain)) {
    series = series.slice().sort((a, b) => Number(b.isMain) - Number(a.isMain));
  }

  // Collect all timestamps
  const allKeys = new Set();
  series.forEach((s) => s.map.forEach((_, k) => allKeys.add(k)));
  const labels = Array.from(allKeys).sort((a, b) => new Date(a) - new Date(b));

  // unique legend labels when same store repeats
  const storeCounts = new Map();
  const storeLabelForUrl = (url) => {
    const base = getStoreName(url);
    const n = (storeCounts.get(base) || 0) + 1;
    storeCounts.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  };

  // colors: main always blue
  const MAIN_COLOR = "#3b82f6";
  const OTHER_COLORS = ["#f59e0b", "#8b5cf6", "#ec4899", "#22c55e", "#ef4444", "#06b6d4"];

  const datasets = series.map((s, index) => {
    const color = index === 0 ? MAIN_COLOR : OTHER_COLORS[(index - 1) % OTHER_COLORS.length];
    return {
      label: storeLabelForUrl(s.url),
      articleName: s.articleName,
      url: s.url,
      data: labels.map((k) => (s.map.has(k) ? s.map.get(k) : null)),
      borderColor: color,
      backgroundColor: color,
      tension: 0.1,
      spanGaps: true,
    };
  });

  chartInstances[productId] = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { boxWidth: 10, font: { size: 10 } },
        },
        tooltip: {
          callbacks: {
            title(items) {
              const label = items?.[0]?.label;
              const d = new Date(label);
              return isNaN(d) ? String(label) : d.toLocaleDateString("sl-SI");
            },
            label(context) {
              const y = context.parsed?.y;
              const store = context.dataset?.label ?? "";
              if (y == null) return `${store}: -`;
              return `${store}: ${Number(y).toFixed(2)} EUR`;
            },
            afterLabel(context) {
              const fullName = context.dataset?.articleName;
              return fullName.slice(0, 35) + '...';
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10 },
            callback: function (_value, index) {
              const label = labels[index];
              const d = new Date(label);
              return isNaN(d) ? String(label) : d.toLocaleDateString("sl-SI");
            },
          },
        },
        y: {
          beginAtZero: false,
          ticks: { font: { size: 10 } },
        },
      },
    },
  });
}
