import * as cheerio from "cheerio";
import { Agent } from "undici";

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

// -----------------------------
// Shared scraping helpers (NO Playwright)
// -----------------------------

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.8",
};

const throwIfCloudflareChallenge = (response, body) => {
  const contentType = response.headers.get("content-type") || "";
  const isChallenge =
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
    (contentType.includes("text/html") &&
      /<title[^>]*>\s*Just a moment\.\.\./i.test(body) &&
      /cdn-cgi\/challenge-platform/i.test(body));

  if (isChallenge) {
    const error = new Error(
      "Spletna trgovina je prikazala varnostno preverjanje Cloudflare. Podatkov izdelka trenutno ni mogoče samodejno pridobiti."
    );
    error.code = "CLOUDFLARE_CHALLENGE";
    throw error;
  }
};

const PRICE_SELECTORS = [
  // SPAR
  '[data-testid="detail-base-price"]',
  '[data-testid="product-price"]',
  // common ecommerce
  ".price-final_price",
  ".product-price .price",
  '[itemprop="price"]',
  ".current-price",
  ".price__value",
  ".marketing-price__price",
  ".price",
];

const PRICE_REGEX_PATTERNS = [
  /(?:\\?["'])price(?:\\?["'])\s*:\s*(?:\\?["'])?([0-9]+[.,][0-9]+|[0-9]+)(?:\\?["'])?/i,
  /(?:\\?["'])salesPrice(?:\\?["'])\s*:\s*(?:\\?["'])?([0-9]+[.,][0-9]+|[0-9]+)(?:\\?["'])?/i,
  /(?:\\?["'])currentPrice(?:\\?["'])\s*:\s*(?:\\?["'])?([0-9]+[.,][0-9]+|[0-9]+)(?:\\?["'])?/i,
  /(?:\\?["'])amount(?:\\?["'])\s*:\s*(?:\\?["'])?([0-9]+[.,][0-9]+|[0-9]+)(?:\\?["'])?/i,
];

const parsePrice = (input) => {
  if (!input) return 0;
  let str = input.toString().trim();
  if (str.endsWith(",") || str.endsWith(".")) str = str.slice(0, -1);

  let clean = str.replace(/[^\d,.]/g, "");
  if (!clean) return 0;

  // Handle 1.234,56 vs 1,234.56
  if (clean.includes(",") && clean.includes(".")) {
    const lastDot = clean.lastIndexOf(".");
    const lastComma = clean.lastIndexOf(",");
    if (lastComma > lastDot) clean = clean.replace(/\./g, "").replace(",", ".");
    else clean = clean.replace(/,/g, "");
  } else if (clean.includes(",")) {
    clean = clean.replace(",", ".");
  }

  const val = parseFloat(clean);
  return Number.isFinite(val) ? val : 0;
};

const extractJsonLd = ($) => {
  const data = [];
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const graph = parsed["@graph"] || parsed;
      const items = Array.isArray(graph) ? graph : [graph];
      items.forEach((i) => data.push(i));
    } catch (_) {
      // ignore broken JSON-LD blocks
    }
  });
  return data;
};

const getPriceFromJsonLd = (json) => {
  if (!json) return 0;

  if (Array.isArray(json)) {
    for (const item of json) {
      const p = getPriceFromJsonLd(item);
      if (p > 0) return p;
    }
    return 0;
  }

  if (typeof json === "object") {
    if (json.offers) return getPriceFromJsonLd(json.offers);
    if (json.priceSpecification) return getPriceFromJsonLd(json.priceSpecification);

    // schema.org PriceSpecification
    if (json["@type"] === "PriceSpecification") {
      if (json.price) return parsePrice(json.price);
      if (json.minPrice) return parsePrice(json.minPrice);
    }

    // schema.org Offer
    if (json.price) return parsePrice(json.price);
    if (json.lowPrice) return parsePrice(json.lowPrice);
    if (json.highPrice) return parsePrice(json.highPrice);

    // Sometimes nested
    if (json.amount) return parsePrice(json.amount);
  }

  return 0;
};

const absolutizeUrl = (src, pageUrl) => {
  if (!src) return null;
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) {
    try {
      return new URL(src, pageUrl).toString();
    } catch (_) {
      return src;
    }
  }
  return src;
};

const findImage = ($, pageUrl, jsonLdData) => {
  // JSON-LD
  for (const item of jsonLdData) {
    const img = item?.image;
    if (!img) continue;
    if (Array.isArray(img)) {
      const first = img[0];
      if (typeof first === "string") return absolutizeUrl(first, pageUrl);
      if (first?.url) return absolutizeUrl(first.url, pageUrl);
    } else if (typeof img === "string") {
      return absolutizeUrl(img, pageUrl);
    } else if (img?.url) {
      return absolutizeUrl(img.url, pageUrl);
    }
  }

  // og:image
  const ogImg = $("meta[property='og:image']").attr("content");
  if (ogImg) return absolutizeUrl(ogImg, pageUrl);

  // sometimes used by Mercator
  const metaImg = $("meta[name='image']").attr("content");
  if (metaImg) return absolutizeUrl(metaImg, pageUrl);

  // generic selectors
  const selectors = [
    ".product-hero__image img",
    ".product-image img",
    ".single-product-image img",
    ".main-image img",
    "#product-image img",
    ".lib-general-image img",
    ".pdp_main-image img",
    "img[itemprop='image']",
  ];

  for (const s of selectors) {
    const el = $(s).first();
    const src = el.attr("src") || el.attr("data-src");
    if (src) return absolutizeUrl(src, pageUrl);
  }

  return null;
};

const parseValueUnitLoose = (text) => {
  if (!text) return null;

  const s = String(text).trim().toLowerCase();
  const result = {};

  const add = (unit, value) => {
    if (!result[unit]) {
      result[unit] = value;
    }
  };

  let m;

  // 1) Packs like "8/1", "8x1", "8 × 1" -> kos
  const packRegex = /\b(\d+(?:[.,]\d+)?)\s*(?:\/|x|×)\s*1\b/g;
  while ((m = packRegex.exec(s)) !== null) {
    const value = Number(m[1].replace(",", "."));
    if (Number.isFinite(value) && value > 0) {
      add("kos", value);
    }
  }

  // 2) Explicit pieces "8 kos"
  const kosRegex = /\b(\d+(?:[.,]\d+)?)\s*(kos)\b/g;
  while ((m = kosRegex.exec(s)) !== null) {
    const value = Number(m[1].replace(",", "."));
    if (Number.isFinite(value) && value > 0) {
      add("kos", value);
    }
  }

  // 3) Multipack weights like "3x200g", "3 × 200 g"
  const multiWeightRegex =
    /\b(\d+(?:[.,]\d+)?)\s*(?:x|×)\s*(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b/g;

  while ((m = multiWeightRegex.exec(s)) !== null) {
    let count = Number(m[1].replace(",", "."));
    let value = Number(m[2].replace(",", "."));
    let unit = m[3];

    if (!Number.isFinite(count) || !Number.isFinite(value)) continue;
    if (count <= 0 || value <= 0) continue;

    let total = count * value;

    // normalize
    if (unit === "g") {
      total /= 1000;
      unit = "kg";
    }
    if (unit === "ml") {
      total /= 1000;
      unit = "l";
    }

    add(unit, total);
  }

  // 4) Single weight / volume / usage units
  const unitRegex = /\b(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|pranj)\b/g;
  while ((m = unitRegex.exec(s)) !== null) {
    let value = Number(m[1].replace(",", "."));
    let unit = m[2];

    if (!Number.isFinite(value) || value <= 0) continue;

    // normalize
    if (unit === "g") {
      value /= 1000;
      unit = "kg";
    }
    if (unit === "ml") {
      value /= 1000;
      unit = "l";
    }

    add(unit, value);
  }

  return Object.keys(result).length ? result : {};
};


const fetchHtml = async (url) => {
  const resp = await fetch(url, {
    dispatcher: insecureAgent,
    headers: DEFAULT_HEADERS,
  });
  const html = await resp.text();
  throwIfCloudflareChallenge(resp, html);
  return html;
};


const extractDataFromMercator = async function (url, code) {
  // Najprej pridobi šifro po kateri iščeš
  if (!code) {
    // 2. Pridobi šifro izdelka
    const html = await (await fetch(url, { dispatcher: insecureAgent })).text();
    const $ = cheerio.load(html);
    const content = $('meta[name="image"]').attr("content")
    code = content?.match(/\/(\d+)\.jpg$/)?.[1];
  }

  if (!code)
    return null;

  // 3. Najdi podatke v Json-u glede na naziv izdelka
  const apiUrl = new URL("https://mercatoronline.si/products/browseProducts/getProducts");
  apiUrl.searchParams.set("limit", "10");
  apiUrl.searchParams.set("offset", "0");
  apiUrl.searchParams.set("filterData[search]", code);

  const apiResp = await (await fetch(apiUrl, { dispatcher: insecureAgent })).json();

  const p = apiResp.products[0];

  //const unitFromPrice = removeNumbers(p?.data?.price_per_unit_base);
  let valueUnit = parseValueUnitLoose(p.data.name);
  const price = parseFloat(p?.data?.current_price);

  if (!(p.data.price_per_unit_base in valueUnit)) {
    valueUnit[p.data.price_per_unit_base] = p.data.unit_quantity;
  }



  // determine primary unit (exception: pranj)
  let primaryUnit;
  if (valueUnit?.pranj !== undefined) {
    primaryUnit = "pranj";
  }
  else {
    primaryUnit = Object.keys(valueUnit)[0];
  }

  // primary quantity
  const primaryValueUnit = valueUnit?.[primaryUnit] ?? null;

  // alternate unit
  let alternateUnit = null;
  let alternateValueUnit = null;

  if (valueUnit) {
    for (const [u, v] of Object.entries(valueUnit)) {
      if (u !== primaryUnit) {
        alternateUnit = u;
        alternateValueUnit = v;
        break;
      }
    }
  }

  // ---- CALCULATE PRICE PER UNIT ----
  const price_per_unit =
    primaryValueUnit && price > 0 ? price / primaryValueUnit : null;

  const price_per_unit_alternate =
    alternateValueUnit && price > 0 ? price / alternateValueUnit : null;

  return {
    code: p?.data?.code,
    name: p?.data?.name,
    url: url.toString(),
    unit_quantity: parseFloat(p?.data?.unit_quantity),
    unit: primaryUnit,
    price,
    price_per_unit: price_per_unit,
    image_src: p?.mainImageSrc,
    price_per_unit_alternate: price_per_unit_alternate,
    unit_alternate: alternateUnit
  };



}

const extractDataFromSpar = async function (url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const jsonLdData = extractJsonLd($);

  const name = $("title").first().text().trim();
  // ---- Price (total) ----
  let price = 0;

  // 4) regex fallback
  if (price === 0) {
    const candidates = [];
    for (const pattern of PRICE_REGEX_PATTERNS) {
      const re = new RegExp(pattern, "gi");
      let m;
      while ((m = re.exec(html)) !== null) {
        const p = parsePrice(m?.[1]);
        if (p > 0) candidates.push(p);
      }
    }
    if (candidates.length) price = Math.min(...candidates);
  }

  // ---- Image ----
  const image_src = findImage($, url, jsonLdData);
  const valueUnit = parseValueUnitLoose(name);

  // determine primary unit (exception: pranj)
  let primaryUnit;
  if (valueUnit?.pranj !== undefined) {
    primaryUnit = "pranj";
  }
  else {
    primaryUnit = Object.keys(valueUnit)[0];
  }

  // alternate unit
  let alternateUnit = null;
  let alternateValueUnit = null;

  if (valueUnit) {
    for (const [u, v] of Object.entries(valueUnit)) {
      if (u !== primaryUnit) {
        alternateUnit = u;
        alternateValueUnit = v;
        break;
      }
    }
  }

  const unit_quantity = valueUnit[primaryUnit];

  // Poračunaj ceno na enoto mere
  const price_per_unit =
    unit_quantity && price > 0 ? price / unit_quantity : null;

  const price_per_unit_alternate =
    alternateValueUnit && price > 0 ? price / alternateValueUnit : null;



  return {
    code: null,
    name: name.trim(),
    url: url.toString(),
    unit_quantity: unit_quantity,
    unit: primaryUnit,
    price: price,
    price_per_unit: price_per_unit,
    image_src: image_src,
    price_per_unit_alternate: price_per_unit_alternate,
    unit_alternate: alternateUnit
  };
};

function removeNumbers(text) {
  if (text == null) return null;

  return text.replace(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i, "").trim();
}

const extractDataFromDM = async function (url, code) {
  // Najprej pridobi šifro po kateri iščeš
  if (!code) {
    code = url.toString().match(/-p(\d+)\.html(?:[?#].*)?$/)?.[1];
  }


  if (!code)
    return null;

  // 3. Najdi podatke v Json-u glede na naziv izdelka
  const apiUrl = new URL("https://products.dm.de/product/products/detail/SI/gtin/" + code);
  const apiResp = await (await fetch(apiUrl, { dispatcher: insecureAgent })).json();

  const valueUnit = parseValueUnitLoose(apiResp?.price?.infos[0]);
  const price = apiResp?.metadata?.price;

  // determine primary unit (exception: pranj)
  let primaryUnit;
  if (valueUnit?.pranj !== undefined) {
    primaryUnit = "pranj";
  }
  else {
    primaryUnit = Object.keys(valueUnit)[0];
  }

  // alternate unit
  let alternateUnit = null;
  let alternateValueUnit = null;

  if (valueUnit) {
    for (const [u, v] of Object.entries(valueUnit)) {
      if (u !== primaryUnit) {
        alternateUnit = u;
        alternateValueUnit = v;
        break;
      }
    }
  }

  const unit_quantity = valueUnit[primaryUnit];

  const price_per_unit =
    unit_quantity && price > 0 ? price / unit_quantity : null;

  const price_per_unit_alternate =
    alternateValueUnit && price > 0 ? price / alternateValueUnit : null;

  return {
    code: apiResp?.gtin,
    name: apiResp?.title?.headline,
    url: url.toString(),
    unit_quantity: unit_quantity,
    //unit: p?.data?.invoice_unit,
    unit: primaryUnit,
    price: price,
    price_per_unit: price_per_unit,
    image_src: apiResp?.images[0]?.src,
    price_per_unit_alternate: price_per_unit_alternate,
    unit_alternate: alternateUnit
  };

}

const extractDataFromMimovrste = async function (url, code) {
  if (!code) {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    code = $("span[data-sel='catalog-number']").first().text().trim();
  }

  if (!code) return null;

  const gqlResponse = await fetch("https://www.mimovrste.com/web-gateway/graphql", {
    method: "POST",
    dispatcher: insecureAgent,
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operationName: "getProductVariantsByIdsForGtm",
      variables: {
        withGifts: true,
        withBundles: true,
        ids: [code],
      },
      query: `
        query getProductVariantsByIdsForGtm($ids: [ID!]!, $withGifts: Boolean = false, $withBundles: Boolean = false) {\n  products: getProductVariantsByIds(ids: $ids) {\n    id\n    title\n    division\n    productTypeId\n    rank {\n      count\n      rank\n      __typename\n    }\n    mainCategoryUrlKey\n    mainMenuUrlKey\n    variants {\n      brief\n      id\n      title\n      labels\n      price\n      vatRate\n      discountPrice\n      priceRrp\n      currency\n      priceType\n      rrpSavePercent\n      defaultActualPrice\n      discountPromotionPrice\n      discountPromotionSalePrice\n      discountPromotionAmount\n      mainMenuPath\n      availableOutlets\n      availability {\n        ...productAvailabilityFragment\n        __typename\n      }\n      estimatedDeliveries {\n        ...productEstimatedDeliveryFragment\n        __typename\n      }\n      brand {\n        title\n        __typename\n      }\n      brandManufacturer {\n        id\n        street\n        city\n        zipCode\n        country\n        email\n        __typename\n      }\n      mediaIds\n      variantUrl\n      isAvailable\n      giftDetails @include(if: $withGifts) {\n        variants {\n          count\n          variant {\n            price\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      bundles @include(if: $withBundles) {\n        ... on BaseProductBundle {\n          type\n          variants {\n            id\n            yearsNumber\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    marketplace {\n      marketplacePartnerTitle\n      marketplacePartnerId\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment productAvailabilityFragment on ProductAvailability {\n  key\n  status\n  countMall\n  countOutlets\n  countSupplier\n  countExternal\n  countShowrooms\n  isAvailable\n  showrooms {\n    id\n    count\n    __typename\n  }\n  __typename\n}\n\nfragment productEstimatedDeliveryFragment on EstimatedDelivery {\n  containsSmartDelivery\n  home {\n    name\n    deliveryFrom\n    deliveryTo\n    locality\n    totalPrice\n    closeTime\n    __typename\n  }\n  pup {\n    name\n    deliveryFrom\n    deliveryTo\n    locality\n    totalPrice\n    type\n    closeTime\n    readyForPickup\n    __typename\n  }\n  cac {\n    name\n    deliveryFrom\n    deliveryTo\n    locality\n    totalPrice\n    type\n    closeTime\n    readyForPickup\n    __typename\n  }\n  __typename\n}\n
      `,
    }),
  });
  const gqlBody = await gqlResponse.text();
  throwIfCloudflareChallenge(gqlResponse, gqlBody);
  const gqlResp = JSON.parse(gqlBody);

  const product = gqlResp?.data?.products?.[0];
  const variant = product?.variants?.[0];
  if (!product || !variant) return null;

  // 3) Parse unit from name (e.g. "1000 ml")
  const valueUnit = parseValueUnitLoose(product.title);

  // determine primary unit (exception: pranj)
  let primaryUnit;
  if (valueUnit?.pranj !== undefined) {
    primaryUnit = "pranj";
  }
  else {
    primaryUnit = Object.keys(valueUnit)[0];
  }

  // alternate unit
  let alternateUnit = null;
  let alternateValueUnit = null;

  if (valueUnit) {
    for (const [u, v] of Object.entries(valueUnit)) {
      if (u !== primaryUnit) {
        alternateUnit = u;
        alternateValueUnit = v;
        break;
      }
    }
  }

  const unit_quantity = valueUnit[primaryUnit];
  const discountMatch = variant.brief.match(/(\d+)\s*%/);
  const discount = discountMatch ? Number(discountMatch[1]) / 100 : null;
  const price = variant.price * (1 - discount);

  const price_per_unit =
    unit_quantity && price > 0 ? price / unit_quantity : null;

  const price_per_unit_alternate =
    alternateValueUnit && price > 0 ? price / alternateValueUnit : null;

  // 5) Image (media IDs are used by CDN)
  let image_src = null;
  if (variant.mediaIds?.length) {
    image_src = `https://www.mimovrste.com/i/${variant.mediaIds[0]}`;
  }

  return {
    code,
    name: product.title,
    url: url.toString(),
    unit_quantity,
    unit: primaryUnit,
    price,
    price_per_unit,
    image_src,
    price_per_unit_alternate: price_per_unit_alternate,
    unit_alternate: alternateUnit
  };
};


export { extractDataFromMercator, extractDataFromSpar, extractDataFromDM, extractDataFromMimovrste };
