const express = require("express");
const fs = require("fs");
const path = require("path");
const nunjucks = require("nunjucks");
const sanitizeHtml = require("sanitize-html");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ROOT_DIR = __dirname;
const SETTINGS_PATH = path.join(ROOT_DIR, "settings.json");
const SETTINGS_DEFAULT_PATH = path.join(ROOT_DIR, "settings.default.json");
const TEMPLATES_DIR = path.join(ROOT_DIR, "templates");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = String(process.env.NODE_ENV || "development").toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const SELLAUTH_API_BASE_URL = String(process.env.SELLAUTH_API_BASE_URL || "").trim();
const SELLAUTH_API_KEY = String(process.env.SELLAUTH_API_KEY || "").trim();
const SELLAUTH_SHOP_ID = Number(process.env.SELLAUTH_SHOP_ID) || 212660;
const SELLAUTH_SHOP_URL = String(process.env.SELLAUTH_SHOP_URL || "").trim();
const DEFAULT_ASSETS_CACHE_MAX_AGE_MS = IS_PRODUCTION ? 3600000 : 0;
const ASSETS_CACHE_MAX_AGE_MS = Number(process.env.ASSETS_CACHE_MAX_AGE_MS ?? DEFAULT_ASSETS_CACHE_MAX_AGE_MS);
const META_JSON_CACHE_MAX_AGE_S = Number(process.env.META_JSON_CACHE_MAX_AGE_S) || 300;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 15000;
const PROXY_BODY_LIMIT = String(process.env.PROXY_BODY_LIMIT || "2mb");
const GENERAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GENERAL_RATE_LIMIT_WINDOW_MS) || 60000;
const GENERAL_RATE_LIMIT_MAX = Number(process.env.GENERAL_RATE_LIMIT_MAX) || 240;
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 60000;
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX) || 90;
const ALLOWED_API_ORIGINS = new Set(
  [SELLAUTH_SHOP_URL, ...(String(process.env.ALLOWED_API_ORIGINS || "").split(","))]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean)
);

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadSettings() {
  const settings = loadJson(SETTINGS_PATH);
  if (settings) {
    return settings;
  }

  const settingsDefault = loadJson(SETTINGS_DEFAULT_PATH);
  return settingsDefault || { templates: {}, global: { properties: {}, components: {} } };
}

let currentSettings = loadSettings();

function getAssetVersion(fileName) {
  try {
    const absolutePath = path.join(ASSETS_DIR, fileName);
    const stats = fs.statSync(absolutePath);
    return String(Math.trunc(stats.mtimeMs));
  } catch {
    return String(Date.now());
  }
}

const templateNames = fs
  .readdirSync(TEMPLATES_DIR)
  .filter((file) => file.endsWith(".njk"))
  .map((file) => file.replace(/\.njk$/i, ""));
const templateSet = new Set(templateNames);

const env = nunjucks.configure(ROOT_DIR, {
  autoescape: false,
  noCache: true,
  throwOnUndefined: false,
});

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(value) || /^\/\//.test(value);
}

function formatPrice(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "";
  }

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function hexToRgb(value) {
  const input = String(value || "").trim().replace(/^#/, "");
  const hex = input.length >= 6 ? input.slice(0, 6) : "";
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return "255, 255, 255";
  }

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function decodeHtmlEntities(value) {
  const text = String(value || "");
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractYouTubeId(value) {
  const text = String(value || "");
  const regexes = [
    /youtu\.be\/([a-zA-Z0-9_-]{6,})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{6,})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/,
  ];

  for (const regex of regexes) {
    const match = text.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }

  return text;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toShopUrl(value) {
  const text = String(value || "");
  if (!text) {
    return "/";
  }
  if (isAbsoluteUrl(text) || text.startsWith("#") || text.startsWith("mailto:") || text.startsWith("tel:")) {
    return text;
  }
  return text.startsWith("/") ? text : `/${text}`;
}

function toApiInternalUrl(value) {
  const text = String(value || "");
  if (!text) {
    return "/api/";
  }
  if (isAbsoluteUrl(text)) {
    return text;
  }
  return text.startsWith("/") ? `/api${text}` : `/api/${text}`;
}

function parseCookieHeader(cookieHeader) {
  const header = String(cookieHeader || "");
  if (!header) {
    return new Map();
  }

  const map = new Map();
  const parts = header.split(";");
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (!name) {
      continue;
    }
    try {
      map.set(name, decodeURIComponent(value));
    } catch {
      map.set(name, value);
    }
  }
  return map;
}

function getCookieValue(req, name) {
  const cookies = parseCookieHeader(req?.headers?.cookie);
  return cookies.get(name) || "";
}

function hasShopCustomerToken(req) {
  const token = getCookieValue(req, "shop_customer_token");
  return Boolean(String(token || "").trim());
}

function getDevCustomerId(req) {
  const raw = getCookieValue(req, "dev_customer_id");
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function hasCustomerSession(req) {
  return hasShopCustomerToken(req) || Boolean(getDevCustomerId(req));
}

function setCookieHeaderValue(name, value, options = {}) {
  const parts = [];
  parts.push(`${name}=${encodeURIComponent(String(value ?? ""))}`);
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAgeSeconds !== undefined && options.maxAgeSeconds !== null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAgeSeconds)))}`);
  }
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function toAssetUrl(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  if (isAbsoluteUrl(text) || text.startsWith("/")) {
    return text;
  }
  return `/assets/${text.replace(/^assets\//, "")}`;
}

function toImageUrl(value) {
  if (!value) {
    return "/assets/hero.jpg";
  }
  return toAssetUrl(value);
}

const SANITIZE_HTML_OPTIONS = {
  allowedTags: [
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "iframe",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    "*": ["class", "title"],
    a: ["href", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    iframe: [
      "src",
      "width",
      "height",
      "allow",
      "allowfullscreen",
      "frameborder",
      "loading",
      "referrerpolicy",
      "title",
    ],
  },
  allowedSchemes: ["http", "https", "mailto", "tel", "data"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    iframe: ["https"],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      rel: "noopener noreferrer nofollow",
      target: "_blank",
    }, true),
  },
};

function sanitizeRichHtml(value) {
  return sanitizeHtml(String(value || ""), SANITIZE_HTML_OPTIONS);
}

function sanitizeText(value) {
  return sanitizeHtml(String(value || ""), { allowedTags: [], allowedAttributes: {} });
}

function stringifyJsonSafe(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin.toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedApiOrigin(req) {
  const originHeader = String(req.headers.origin || "").trim();
  const refererHeader = String(req.headers.referer || "").trim();
  const requestOrigin = normalizeOrigin(`${req.protocol}://${req.get("host") || ""}`);
  const origin = normalizeOrigin(originHeader);
  if (origin && (ALLOWED_API_ORIGINS.has(origin) || origin === requestOrigin)) {
    return true;
  }

  const refererOrigin = normalizeOrigin(refererHeader);
  if (refererOrigin && (ALLOWED_API_ORIGINS.has(refererOrigin) || refererOrigin === requestOrigin)) {
    return true;
  }

  return !originHeader && !refererHeader;
}

function createMemoryRateLimiter({ windowMs, max, namespace }) {
  const hits = new Map();
  const gcInterval = Math.max(5000, Math.floor(windowMs / 2));

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (!entry || entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }, gcInterval).unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const ip = String(req.ip || req.headers["x-forwarded-for"] || "unknown");
    const key = `${namespace}:${ip}`;
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count <= max) {
      return next();
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Please slow down and try again.",
      retry_after_seconds: retryAfterSeconds,
    });
  };
}

env.addFilter("renderString", (value) => (value === null || value === undefined ? "" : String(value)));
env.addFilter("shopUrl", toShopUrl);
env.addFilter("apiInternalUrl", toApiInternalUrl);
env.addFilter("assetUrl", toAssetUrl);
env.addFilter("imageUrl", toImageUrl);
env.addFilter("hex_to_rgb", hexToRgb);
env.addFilter("decodeHtmlEntities", decodeHtmlEntities);
env.addFilter("ytEmbedVideoId", extractYouTubeId);
env.addFilter("formatDate", formatDate);
env.addFilter("formatDateTime", formatDateTime);
env.addFilter("themeColor", () => currentSettings?.global?.properties?.theme_color || "#4A90D9");
env.addFilter("json", stringifyJsonSafe);
env.addFilter("sanitizeHtml", (value) => new nunjucks.runtime.SafeString(sanitizeRichHtml(value)));
env.addFilter("sanitizeText", sanitizeText);

env.addGlobal("formatPrice", formatPrice);
env.addGlobal("range", (start, stop, step = 1) => {
  let from = Number(start);
  let to = Number(stop);
  let increment = Number(step);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return [];
  }

  if (!Number.isFinite(increment) || increment === 0) {
    increment = 1;
  }

  if (to === undefined || Number.isNaN(to)) {
    to = from;
    from = 0;
  }

  const values = [];
  if (increment > 0) {
    for (let i = from; i < to; i += increment) {
      values.push(i);
    }
  } else {
    for (let i = from; i > to; i += increment) {
      values.push(i);
    }
  }
  return values;
});

function getKeywordArgs(args) {
  if (!args.length) {
    return { positional: [], keyword: {} };
  }

  const last = args[args.length - 1];
  if (last && typeof last === "object" && last.__keywords) {
    const keyword = { ...last };
    delete keyword.__keywords;
    return { positional: args.slice(0, -1), keyword };
  }
  return { positional: args, keyword: {} };
}

function renderSafe(templatePath, data) {
  try {
    const absolutePath = path.join(ROOT_DIR, templatePath.replace(/\//g, path.sep));
    if (!fs.existsSync(absolutePath)) {
      return "";
    }
    const html = env.render(templatePath, data);
    return new nunjucks.runtime.SafeString(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown render error";
    return new nunjucks.runtime.SafeString(`<!-- render error in ${templatePath}: ${message} -->`);
  }
}

class RenderSnippetExtension {
  constructor() {
    this.tags = ["render_snippet"];
  }

  parse(parser, nodes) {
    const token = parser.nextToken();
    const args = parser.parseSignature(null, true) || new nodes.NodeList();
    parser.advanceAfterBlockEnd(token.value);
    return new nodes.CallExtension(this, "run", args);
  }

  run(context, snippetName, ...args) {
    const { keyword } = getKeywordArgs(args);
    const baseContext = context?.ctx || {};
    const name = String(snippetName || "");
    if (!name) {
      return "";
    }

    const snippetPath = name.startsWith("snippets/") ? name : `snippets/${name}`;
    return renderSafe(snippetPath, { ...baseContext, ...keyword });
  }
}

class RenderComponentExtension {
  constructor() {
    this.tags = ["render_component"];
  }

  parse(parser, nodes) {
    const token = parser.nextToken();
    const args = parser.parseSignature(null, true) || new nodes.NodeList();
    parser.advanceAfterBlockEnd(token.value);
    return new nodes.CallExtension(this, "run", args);
  }

  run(context, componentId, ...args) {
    const { keyword } = getKeywordArgs(args);
    const baseContext = context?.ctx || {};
    const id = String(componentId || "");
    if (!id) {
      return "";
    }

    const templateComponents = baseContext.components && !Array.isArray(baseContext.components) ? baseContext.components : {};
    const globalComponents = currentSettings?.global?.components || {};

    let component = templateComponents[id];
    if (!component && globalComponents[id]) {
      component = { type: id, properties: globalComponents[id] };
    }

    const type = component?.type || id;
    const properties = component?.properties || {};
    const componentPath = `components/${type}.njk`;

    return renderSafe(componentPath, {
      ...baseContext,
      ...keyword,
      componentId: id,
      component,
      properties,
    });
  }
}

env.addExtension("RenderSnippetExtension", new RenderSnippetExtension());
env.addExtension("RenderComponentExtension", new RenderComponentExtension());

function buildPaginator(basePath, totalItems) {
  return {
    current_page: 1,
    from: totalItems > 0 ? 1 : 0,
    to: totalItems,
    total: totalItems,
    last_page: 1,
    prev_page_url: null,
    next_page_url: null,
    links: [
      { label: "1", active: true, url: basePath },
    ],
    data: [],
  };
}

const LIVE_CACHE_TTL_MS = Number(process.env.SELLAUTH_CACHE_TTL_MS) || 120000;
const LIVE_STALE_TTL_MS = Number(process.env.SELLAUTH_STALE_TTL_MS) || 300000;
const LIVE_DATA_CACHE = {
  key: "",
  expiresAt: 0,
  staleUntil: 0,
  data: null,
  refreshingPromise: null,
};

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function toNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeQuantityRange(rawMin, rawMax) {
  const minInput = Number(rawMin);
  const maxInput = Number(rawMax);

  const min = Number.isFinite(minInput) && minInput >= 1 ? Math.floor(minInput) : 1;
  let max = Number.isFinite(maxInput) && maxInput >= 1 ? Math.floor(maxInput) : 999999;

  if (max < min) {
    max = min;
  }

  return { min, max };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getAdminApiBaseUrl() {
  const configured = SELLAUTH_API_BASE_URL.replace(/\/+$/, "");
  if (!configured) {
    return "https://api.sellauth.com";
  }

  if (/api\.sellauth\.com/i.test(configured)) {
    return configured.replace(/\/v1$/i, "");
  }

  // If a storefront/shop domain is configured, still use the official admin API base.
  return "https://api.sellauth.com";
}

function withQuery(basePath, params = {}) {
  const filtered = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (filtered.length === 0) {
    return basePath;
  }
  const query = new URLSearchParams(filtered.map(([key, value]) => [key, String(value)])).toString();
  const joiner = basePath.includes("?") ? "&" : "?";
  return `${basePath}${joiner}${query}`;
}

async function fetchSellAuthAdminJson(endpointPath, init = {}) {
  if (!SELLAUTH_API_KEY) {
    throw new Error("SELLAUTH_API_KEY missing");
  }

  const normalizedBase = getAdminApiBaseUrl();
  const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  const url = `${normalizedBase}${normalizedPath}`;
  const headers = new Headers(init.headers || {});

  headers.set("Authorization", `Bearer ${SELLAUTH_API_KEY}`);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const textBody = await response.text();
  let payload = null;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    payload = textBody;
  }

  if (!response.ok) {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`SellAuth API ${response.status} on ${normalizedPath}: ${message}`);
  }

  return payload;
}

async function fetchSellAuthPaginated(endpointPath, options = {}) {
  const perPage = options.perPage || 100;
  const maxPages = options.maxPages || 5;
  const firstPath = withQuery(endpointPath, { page: 1, perPage });
  const firstPayload = await fetchSellAuthAdminJson(firstPath);
  const firstItems = extractCollection(firstPayload);

  if (!firstPayload || Array.isArray(firstPayload) || !("last_page" in firstPayload)) {
    return firstItems;
  }

  const lastPage = Math.min(toNumber(firstPayload.last_page, 1), maxPages);
  if (lastPage <= 1) {
    return firstItems;
  }

  const allItems = [...firstItems];
  for (let page = 2; page <= lastPage; page += 1) {
    const pagePath = withQuery(endpointPath, { page, perPage });
    const pagePayload = await fetchSellAuthAdminJson(pagePath);
    allItems.push(...extractCollection(pagePayload));
  }

  return allItems;
}

function resolveEntityImageUrls(entity, imageById = new Map()) {
  const urls = [];
  const addUrl = (value) => {
    const url = String(value || "").trim();
    if (!url) {
      return;
    }
    if (!urls.includes(url)) {
      urls.push(url);
    }
  };

  addUrl(entity?.image_url);
  addUrl(entity?.image?.url);

  for (const image of ensureArray(entity?.images)) {
    addUrl(image?.url);
  }

  for (const imageUrl of ensureArray(entity?.image_urls)) {
    addUrl(imageUrl);
  }

  const imageId = entity?.image_id;
  if (imageId && imageById.has(Number(imageId))) {
    addUrl(imageById.get(Number(imageId)));
  }

  return urls;
}

function mapSellAuthCategory(category, imageById = new Map()) {
  const pathValue = category?.path || slugify(category?.name || `category-${category?.id || "x"}`);
  const imageUrls = resolveEntityImageUrls(category, imageById);

  return {
    id: category?.id,
    name: category?.name || "Category",
    path: pathValue,
    url: `/products/${pathValue}`,
    meta_title: category?.meta_title || `${category?.name || "Category"} Products`,
    meta_description: category?.meta_description || "",
    meta_image_url: imageUrls[0] || null,
  };
}

function isSellAuthProductVisible(product) {
  const visibility = String(product?.visibility || "").trim().toLowerCase();
  const status = String(product?.status || "").trim().toLowerCase();
  const privateFlag = product?.is_private === true || product?.private === true || product?.hidden === true;

  if (privateFlag) {
    return false;
  }

  const hiddenStates = new Set(["private", "hidden", "draft", "disabled", "archived", "inactive"]);
  if (hiddenStates.has(visibility) || hiddenStates.has(status)) {
    return false;
  }

  return true;
}

function mapSellAuthProduct(product, categoriesById, themeColor, imageById = new Map()) {
  const variantsRaw = ensureArray(product?.variants);
  const fallbackQuantityRange = normalizeQuantityRange(product?.quantity_min, product?.quantity_max);
  const variants = variantsRaw.length > 0
    ? variantsRaw.map((variant, index) => {
      const quantityRange = normalizeQuantityRange(variant?.quantity_min, variant?.quantity_max);
      return {
        id: variant?.id ?? `${product?.id || "p"}-v${index + 1}`,
        name: variant?.name || product?.name || "Default",
        description: variant?.description || "",
        price: toNumber(variant?.price, toNumber(product?.price, 0)),
        price_slash: variant?.price_slash !== undefined && variant?.price_slash !== null
          ? toNumber(variant.price_slash, null)
          : null,
        stock: variant?.stock ?? variant?.stock_count ?? product?.stock ?? -1,
        quantity_min: quantityRange.min,
        quantity_max: quantityRange.max,
        volume_discounts: ensureArray(variant?.volume_discounts),
      };
    })
    : [{
      id: `${product?.id || "p"}-default`,
      name: product?.name || "Default",
      description: "",
      price: toNumber(product?.price, 0),
      price_slash: null,
      stock: product?.stock ?? product?.stock_count ?? -1,
      quantity_min: fallbackQuantityRange.min,
      quantity_max: fallbackQuantityRange.max,
      volume_discounts: [],
    }];

  const prices = variants.map((variant) => toNumber(variant.price, 0));
  const slashPrices = variants
    .map((variant) => variant.price_slash)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  const categoryFromPayload = product?.category
    ? mapSellAuthCategory(product.category, imageById)
    : null;
  const category = categoryFromPayload || categoriesById.get(Number(product?.category_id)) || null;
  const imageUrls = resolveEntityImageUrls(product, imageById);
  const badgeText = product?.badge_text || null;
  const badgeColor = product?.badge_color || themeColor;

  return {
    id: product?.id,
    path: product?.path || slugify(`${product?.name || "product"}-${product?.id || ""}`),
    type: "product",
    name: product?.name || "Product",
    description: product?.description || "",
    image_url: imageUrls[0] || "",
    image_urls: imageUrls,
    min_price: prices.length > 0 ? Math.min(...prices) : 0,
    max_price: prices.length > 0 ? Math.max(...prices) : 0,
    min_price_slash: slashPrices.length > 0 ? Math.min(...slashPrices) : null,
    max_price_slash: slashPrices.length > 0 ? Math.max(...slashPrices) : null,
    currency: product?.currency || "USD",
    status_color: product?.status_color || (product?.visibility === "on_hold" ? "#f59e0b" : "#22c55e"),
    status_text: product?.status_text || (product?.visibility === "on_hold" ? "On Hold" : "Online"),
    hide_stock_count: false,
    quantity_min: variants[0]?.quantity_min || 1,
    quantity_max: variants[0]?.quantity_max || 999999,
    category_id: product?.category_id || category?.id || null,
    category,
    product_badges: {
      card: badgeText ? [{ label: badgeText, color: badgeColor }] : [],
      page: badgeText ? [{ label: badgeText, color: badgeColor }] : [],
    },
    product_tabs: ensureArray(product?.tabs).map((tab) => ({
      slug: tab?.slug || slugify(tab?.title || "tab"),
      title: tab?.title || "Tab",
      content: tab?.content || "",
    })),
    variants,
    visibility: product?.visibility || "public",
    meta_title: product?.meta_title || product?.name || "Product",
    meta_description: product?.meta_description || "",
    meta_image_url: imageUrls[0] || null,
    meta_twitter_card: product?.meta_twitter_card || "summary_large_image",
    group_id: product?.group_id || null,
  };
}

function mapSellAuthGroup(group, productById, imageById = new Map()) {
  const groupProducts = ensureArray(group?.products)
    .map((groupProduct) => productById.get(Number(groupProduct?.id || groupProduct?.product_id)))
    .filter(Boolean);

  if (groupProducts.length === 0) {
    return null;
  }

  const imageUrls = resolveEntityImageUrls(group, imageById);
  const prices = groupProducts.map((product) => toNumber(product.min_price, 0));
  const slashPrices = groupProducts
    .map((product) => product.min_price_slash)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  return {
    id: group?.id,
    path: group?.path || slugify(`${group?.name || "group"}-${group?.id || ""}`),
    type: "group",
    group_id: null,
    name: group?.name || "Group",
    image_url: imageUrls[0] || "",
    image_urls: imageUrls,
    products: groupProducts,
    min_price: prices.length > 0 ? Math.min(...prices) : 0,
    max_price: prices.length > 0 ? Math.max(...prices) : 0,
    min_price_slash: slashPrices.length > 0 ? Math.min(...slashPrices) : null,
    max_price_slash: slashPrices.length > 0 ? Math.max(...slashPrices) : null,
    currency: groupProducts[0]?.currency || "USD",
    product_badges: { card: [], page: [] },
    status_color: "#22c55e",
    status_text: "Online",
    category_id: group?.category_id || null,
  };
}

function mapSellAuthFeedback(feedback) {
  const fallbackReviewMessages = [
    "Fast delivery and smooth setup. Works exactly as expected.",
    "Great support team and excellent product stability.",
    "Clean interface, good performance, and very easy to use.",
    "Quick checkout and instant access. Solid overall experience.",
    "Reliable service with great value for the price.",
    "Everything was straightforward and worked right away.",
    "Very good quality. Support helped me in just a few minutes.",
    "Perfect for daily use. Stable, responsive, and easy to configure.",
  ];

  const buildFallbackMessage = (id, firstItemName) => {
    const numericId = Number(id);
    const index = Number.isFinite(numericId)
      ? Math.abs(numericId) % fallbackReviewMessages.length
      : 0;
    const base = fallbackReviewMessages[index];
    const itemLabel = String(firstItemName || "").trim();
    return itemLabel && itemLabel.toLowerCase() !== "item"
      ? `${base} (${itemLabel})`
      : base;
  };

  const items = ensureArray(feedback?.invoice?.items).map((item) => ({
    name: item?.product?.name || item?.variant?.name || "Item",
  }));

  const rawMessage = String(feedback?.message || "").replace(/\s+/g, " ").trim();
  const message = rawMessage.length >= 8
    ? rawMessage
    : buildFallbackMessage(feedback?.id, items[0]?.name);

  return {
    id: feedback?.id,
    rating: toNumber(feedback?.rating, 5),
    message,
    reply: feedback?.reply || null,
    items,
  };
}

function mapSellAuthBlogPost(post, imageById = new Map()) {
  const imageUrls = resolveEntityImageUrls(post, imageById);
  const summary = post?.summary || post?.excerpt || post?.meta_description || "";

  return {
    id: post?.id,
    path: post?.path || slugify(`${post?.title || "post"}-${post?.id || ""}`),
    title: post?.title || "Blog Post",
    summary,
    content: post?.content || "",
    created_at: post?.created_at || new Date().toISOString(),
    meta_title: post?.meta_title || post?.title || "Blog Post",
    meta_description: post?.meta_description || summary,
    image_url: imageUrls[0] || null,
    image_id: post?.image_id || null,
  };
}

function mapSellAuthShop(shopData) {
  if (!shopData || typeof shopData !== "object") {
    return null;
  }

  const shopUrlFromSubdomain = shopData.subdomain
    ? `https://${shopData.subdomain}.mysellauth.com`
    : null;

  return {
    id: shopData.id || SELLAUTH_SHOP_ID,
    name: shopData.name || "SellAuth Shop",
    url: SELLAUTH_SHOP_URL || shopUrlFromSubdomain || `http://localhost:${PORT}`,
    image_url: shopData.logo_image_url || "",
    favicon_url: shopData.favicon_image_url || shopData.logo_image_url || "",
    background_image_url: shopData.background_image_url || "",
    meta_title: shopData.meta_title || shopData.name || "SellAuth Shop",
    meta_description: shopData.meta_description || shopData.description || "",
    meta_image_url: shopData.meta_image_url || shopData.logo_image_url || "",
    meta_twitter_card: shopData.meta_twitter_card || "summary_large_image",
    max_cart_limit: toNumber(shopData.cart_item_limit, 10),
    tickets_enabled: true,
    customer_balance_enabled: true,
    affiliate_enabled: true,
    affiliate_percentage: toNumber(shopData.affiliate_percentage, 10),
    affiliate_code_editable: true,
    discord_url: "https://discord.gg/onlyskills",
    telegram_url: shopData.telegram_url || "#",
    instagram_url: shopData.instagram_url || "#",
    tiktok_url: shopData.tiktok_url || "#",
    youtube_url: shopData.youtube_url || "#",
    recaptcha_key: shopData.recaptcha_key || "",
    gtag_id: shopData.gtag_id || "",
    tawkto_id: shopData.tawkto_id || "",
    crisp_website_id: shopData.crisp_website_id || "",
  };
}

async function loadSellAuthLiveData(cacheKey) {
  const now = Date.now();

  const shopPath = `/v1/shops/${SELLAUTH_SHOP_ID}`;
  const [
    shopData,
    statsData,
    imageList,
    categoriesData,
    productsData,
    groupsData,
    feedbacksData,
    blogPostsData,
  ] = await Promise.all([
    fetchSellAuthAdminJson(shopPath).catch(() => null),
    fetchSellAuthAdminJson(`${shopPath}/stats`).catch(() => null),
    fetchSellAuthAdminJson(`${shopPath}/images`).catch(() => []),
    fetchSellAuthPaginated(`${shopPath}/categories`).catch(() => []),
    fetchSellAuthPaginated(`${shopPath}/products`, { perPage: 100, maxPages: 10 }).catch(() => []),
    fetchSellAuthPaginated(`${shopPath}/groups`, { perPage: 100, maxPages: 10 }).catch(() => []),
    fetchSellAuthPaginated(`${shopPath}/feedbacks`, { perPage: 100, maxPages: 5 }).catch(() => []),
    fetchSellAuthPaginated(`${shopPath}/blog-posts`, { perPage: 100, maxPages: 3 }).catch(() => []),
  ]);

  const imageById = new Map(
    ensureArray(imageList).map((image) => [Number(image?.id || image?.$id), image?.url]).filter((entry) => entry[0] && entry[1])
  );

  const categories = ensureArray(categoriesData).map((category) => mapSellAuthCategory(category, imageById));
  const categoriesById = new Map(categories.map((category) => [Number(category.id), category]));
  const themeColor = currentSettings?.global?.properties?.theme_color || "#4A90D9";

  const mappedProducts = ensureArray(productsData)
    .filter((product) => product?.type !== "addon" && isSellAuthProductVisible(product))
    .map((product) => mapSellAuthProduct(product, categoriesById, themeColor, imageById));
  const productById = new Map(mappedProducts.map((product) => [Number(product.id), product]));

  const mappedGroups = ensureArray(groupsData)
    .map((group) => mapSellAuthGroup(group, productById, imageById))
    .filter(Boolean);

  const groupedProductIds = new Set(
    mappedGroups.flatMap((group) => ensureArray(group.products).map((product) => Number(product.id)))
  );
  const ungroupedProducts = mappedProducts.filter((product) => !groupedProductIds.has(Number(product.id)));
  const sortedItems = mappedGroups.length > 0 ? [...mappedGroups, ...ungroupedProducts] : ungroupedProducts;

  const feedbacks = ensureArray(feedbacksData).map(mapSellAuthFeedback);

  const blogPosts = ensureArray(blogPostsData).map((post) => mapSellAuthBlogPost(post, imageById));

  const liveData = {
    shop: mapSellAuthShop(shopData),
    sortedItems,
    statuses: sortedItems,
    products: mappedProducts,
    groups: mappedGroups,
    categories,
    product: mappedProducts[0] || null,
    productUpsells: [],
    productAddons: [],
    feedbacks,
    feedbacks_paginator: buildPaginator("/feedback", feedbacks.length),
    blog_posts: blogPosts,
    latest_blog_posts: blogPosts,
    related_blog_posts: blogPosts.slice(0, 1),
    blog_posts_paginator: buildPaginator("/blog", blogPosts.length),
    blogPost: blogPosts[0] || null,
    liveStats: {
      latestOrders: [],
      ...(statsData && typeof statsData === "object" ? statsData : {}),
    },
  };

  LIVE_DATA_CACHE.key = cacheKey;
  LIVE_DATA_CACHE.expiresAt = now + LIVE_CACHE_TTL_MS;
  LIVE_DATA_CACHE.staleUntil = now + LIVE_CACHE_TTL_MS + LIVE_STALE_TTL_MS;
  LIVE_DATA_CACHE.data = liveData;

  return liveData;
}

function refreshLiveDataInBackground(cacheKey) {
  if (LIVE_DATA_CACHE.refreshingPromise) {
    return LIVE_DATA_CACHE.refreshingPromise;
  }

  LIVE_DATA_CACHE.key = cacheKey;
  LIVE_DATA_CACHE.refreshingPromise = loadSellAuthLiveData(cacheKey)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SellAuth] Live data refresh failed: ${message}`);
      return LIVE_DATA_CACHE.data;
    })
    .finally(() => {
      LIVE_DATA_CACHE.refreshingPromise = null;
    });

  return LIVE_DATA_CACHE.refreshingPromise;
}

async function fetchSellAuthLiveData() {
  const cacheKey = `${SELLAUTH_SHOP_ID}|${SELLAUTH_API_KEY}|${getAdminApiBaseUrl()}`;
  const now = Date.now();
  if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID) {
    return null;
  }

  if (LIVE_DATA_CACHE.key !== cacheKey) {
    LIVE_DATA_CACHE.key = cacheKey;
    LIVE_DATA_CACHE.expiresAt = 0;
    LIVE_DATA_CACHE.staleUntil = 0;
    LIVE_DATA_CACHE.data = null;
    LIVE_DATA_CACHE.refreshingPromise = null;
  }

  if (LIVE_DATA_CACHE.data && LIVE_DATA_CACHE.expiresAt > now) {
    return LIVE_DATA_CACHE.data;
  }

  if (LIVE_DATA_CACHE.data && LIVE_DATA_CACHE.staleUntil > now) {
    void refreshLiveDataInBackground(cacheKey);
    return LIVE_DATA_CACHE.data;
  }

  if (LIVE_DATA_CACHE.refreshingPromise) {
    const refreshed = await LIVE_DATA_CACHE.refreshingPromise;
    return refreshed || LIVE_DATA_CACHE.data;
  }

  const refreshed = await refreshLiveDataInBackground(cacheKey);
  return refreshed || LIVE_DATA_CACHE.data;
}

function createSampleData() {
  const nowIso = new Date().toISOString();

  const sampleProducts = [
    {
      id: 101,
      path: "starter-key",
      type: "product",
      name: "Starter Key",
      description: "A solid starter package.",
      image_url: "/assets/hero.jpg",
      image_urls: ["/assets/hero.jpg"],
      min_price: 9.99,
      max_price: 9.99,
      min_price_slash: 14.99,
      max_price_slash: 14.99,
      currency: "USD",
      status_color: "#22c55e",
      status_text: "Online",
      hide_stock_count: false,
      quantity_min: 1,
      quantity_max: 10,
      category_id: 1,
      category: { id: 1, name: "Keys", url: "/products/keys" },
      product_badges: {
        card: [{ label: "Popular", color: "#4A90D9", icon: "fa-solid fa-fire" }],
        page: [{ label: "Instant Delivery", color: "#4A90D9", icon: "fa-solid fa-bolt" }],
      },
      product_tabs: [{ slug: "details", title: "Details", content: "<p>Extra technical details.</p>" }],
      variants: [
        {
          id: 1001,
          name: "1 Month",
          description: "Best for quick testing",
          price: 9.99,
          price_slash: 14.99,
          stock: 120,
          quantity_min: 1,
          quantity_max: 10,
          volume_discounts: [
            { quantity: 2, percentage: 5 },
            { quantity: 5, percentage: 12 },
          ],
        },
      ],
      visibility: "visible",
    },
    {
      id: 102,
      path: "pro-key",
      type: "product",
      name: "Pro Key",
      description: "Advanced package with priority support.",
      image_url: "/assets/operators.png",
      image_urls: ["/assets/operators.png"],
      min_price: 19.99,
      max_price: 19.99,
      min_price_slash: 29.99,
      max_price_slash: 29.99,
      currency: "USD",
      status_color: "#22c55e",
      status_text: "Online",
      hide_stock_count: false,
      quantity_min: 1,
      quantity_max: 10,
      category_id: 1,
      category: { id: 1, name: "Keys", url: "/products/keys" },
      product_badges: { card: [], page: [] },
      product_tabs: [],
      variants: [
        {
          id: 1002,
          name: "1 Month",
          description: "",
          price: 19.99,
          price_slash: 29.99,
          stock: 70,
          quantity_min: 1,
          quantity_max: 10,
          volume_discounts: [],
        },
      ],
      visibility: "visible",
    },
  ];

  const group = {
    id: 201,
    path: "featured-group",
    type: "group",
    group_id: null,
    name: "Featured Pack",
    image_url: "/assets/hero.jpg",
    image_urls: ["/assets/hero.jpg"],
    products: sampleProducts,
    min_price: 9.99,
    max_price: 19.99,
    min_price_slash: 14.99,
    max_price_slash: 29.99,
    currency: "USD",
    product_badges: { card: [], page: [] },
    status_color: "#22c55e",
    status_text: "Online",
  };

  const feedbacks = [
    {
      id: 1,
      rating: 5,
      message: "Super service, livraison rapide et support au top.",
      reply: "Merci beaucoup pour votre retour.",
      items: [{ name: "Starter Key" }],
    },
    {
      id: 2,
      rating: 4,
      message: "Bonne expérience globale, je recommande.",
      reply: null,
      items: [{ name: "Pro Key" }],
    },
  ];

  const blogPosts = [
    {
      id: 1,
      path: "launch-update",
      title: "Launch Update",
      summary: "What changed this month.",
      content: "<p>New features and fixes are live.</p>",
      created_at: nowIso,
      meta_title: "Launch Update",
      meta_description: "Latest release notes.",
      image_url: "/assets/hero.jpg",
    },
    {
      id: 2,
      path: "tips-and-tricks",
      title: "Tips and Tricks",
      summary: "How to get the best experience.",
      content: "<p>Useful usage tips.</p>",
      created_at: nowIso,
      meta_title: "Tips and Tricks",
      meta_description: "Helpful recommendations.",
      image_url: "/assets/operators.png",
    },
  ];

  const sampleInvoice = {
    id: 1,
    unique_id: "INV-1001",
    status: "completed",
    price: 19.99,
    currency: "USD",
    created_at: nowIso,
    url: "#",
    items: [
      {
        product: { name: "Pro Key" },
        variant: { name: "1 Month" },
      },
    ],
    ticket: null,
  };

  const tickets = [
    {
      id: 501,
      subject: "Need help with setup",
      status: "open",
      created_at: nowIso,
      messages: [
        {
          id: 1,
          sender_type: "user",
          content: "Hello! How can I help you?",
          created_at: nowIso,
        },
        {
          id: 2,
          sender_type: "shop_customer",
          content: "I need help setting up my product.",
          created_at: nowIso,
        },
      ],
      invoice: { unique_id: sampleInvoice.unique_id, url: sampleInvoice.url },
    },
  ];

  return {
    sortedItems: [group, ...sampleProducts],
    statuses: [group, ...sampleProducts],
    products: sampleProducts,
    groups: [group],
    categories: [{ id: 1, name: "Keys", path: "keys", url: "/products/keys", meta_title: "Keys", meta_description: "Keys category", meta_image_url: "/assets/hero.jpg" }],
    product: sampleProducts[0],
    category: { id: 1, name: "Keys", path: "keys", url: "/products/keys", meta_title: "Keys", meta_description: "Keys category", meta_image_url: "/assets/hero.jpg" },
    productUpsells: [sampleProducts[1]],
    productAddons: [
      {
        id: 301,
        name: "Priority Support",
        description: "Faster response times",
        currency: "USD",
        image_urls: [],
        variants: [{ id: 3001, name: "Addon", price: 4.99 }],
        is_mandatory: false,
      },
    ],
    feedbacks,
    feedbacks_paginator: buildPaginator("/feedback", feedbacks.length),
    blog_posts: blogPosts,
    latest_blog_posts: blogPosts,
    related_blog_posts: blogPosts.slice(0, 1),
    blog_posts_paginator: buildPaginator("/blog", blogPosts.length),
    blogPost: blogPosts[0],
    liveStats: {
      latestOrders: [{ completed_at: nowIso, country_code: "fr" }],
    },
    invoices: {
      ...buildPaginator("/customer/invoices", 1),
      data: [sampleInvoice],
      total: 1,
      from: 1,
      to: 1,
    },
    latest_invoice: sampleInvoice,
    tickets,
    tickets_paginator: buildPaginator("/customer/tickets", tickets.length),
    ticket: tickets[0],
    balance_transactions: [
      { id: 1, type: "credit", description: "Manual top-up", amount: 20, created_at: nowIso, invoice: null },
    ],
    balance_transactions_paginator: buildPaginator("/customer/balance", 1),
    referred_customers: [
      { email: "friend@example.com", affiliate_referrer_earnings: 5.5, created_at: nowIso },
    ],
    referred_customers_paginator: buildPaginator("/customer/affiliate", 1),
  };
}

function normalizeComponentMap(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return value;
}

function slugToName(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveTemplate(requestPath) {
  const clean = String(requestPath || "/").replace(/^\/+|\/+$/g, "");
  if (!clean) {
    return { templateName: "shop", routeData: {} };
  }

  if (
    clean === "feedback" ||
    clean.startsWith("feedback/") ||
    clean === "vouches" ||
    clean.startsWith("vouches/")
  ) {
    return null;
  }

  const aliases = {
    "terms-of-service": "terms",
    "customer/dashboard": "customer-dashboard",
    "customer/invoices": "customer-invoices",
    "customer/tickets": "customer-tickets",
    "customer/balance": "customer-balance",
    "customer/affiliate": "customer-affiliate",
  };

  if (aliases[clean]) {
    return { templateName: aliases[clean], routeData: {} };
  }

  const segments = clean.split("/");
  if (segments[0] === "customer" && segments[1] === "tickets" && segments[2]) {
    return { templateName: "customer-ticket", routeData: { ticketId: segments[2] } };
  }

  if (segments[0] === "product" && segments[1]) {
    return { templateName: "product", routeData: { productPath: segments.slice(1).join("/") } };
  }

  if (segments[0] === "products" && segments[1]) {
    return { templateName: "products", routeData: { categorySlug: segments.slice(1).join("/") } };
  }

  if (segments[0] === "blog" && segments[1]) {
    return { templateName: "blog-post", routeData: { blogPath: segments.slice(1).join("/") } };
  }

  if (templateSet.has(clean)) {
    return { templateName: clean, routeData: {} };
  }

  if (segments.length === 1) {
    return {
      templateName: "custom-page",
      routeData: { customPagePath: clean, customPageName: slugToName(clean) || "Custom Page" },
    };
  }

  return null;
}

function mapSellAuthCustomerToThemeCustomer(customer) {
  if (!customer || typeof customer !== "object") {
    return null;
  }
  const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id: toNumber(customer.id),
    email: String(customer.email || ""),
    balance: toNumber(customer.balance),
    total_completed: toNumber(customer.total_completed),
    total_spent_usd: toNumber(customer.total_spent_usd),
    created_at: customer.created_at ? String(customer.created_at) : new Date().toISOString(),
    affiliate_code: customer.affiliate_code ? String(customer.affiliate_code) : null,
    affiliate_referrer_earnings: toNumber(customer.affiliate_referrer_earnings),
  };
}

async function createContext(req, templateName, routeData) {
  const settings = currentSettings;
  const templateConfig = settings.templates?.[templateName] || {};
  const sample = createSampleData();
  const live = await fetchSellAuthLiveData().catch(() => null);
  const source = live || sample;

  const helperItemsById = (items, ids) => {
    if (!Array.isArray(items)) {
      return [];
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return items;
    }
    const wanted = new Set(ids.map((id) => String(id)));
    return items.filter((item) => wanted.has(String(item.id)));
  };

  const defaultShopCustomer = {
    id: 9001,
    email: "customer@example.com",
    balance: 30,
    total_completed: 12,
    total_spent_usd: 249.5,
    created_at: new Date().toISOString(),
    affiliate_code: "MYCODE",
    affiliate_referrer_earnings: 12.5,
  };
  const shouldMockCustomer = String(process.env.MOCK_CUSTOMER || "").trim() === "1";
  const devCustomerId = getDevCustomerId(req);
  let devShopCustomer = null;
  if (!shouldMockCustomer && devCustomerId && SELLAUTH_API_KEY) {
    devShopCustomer = await fetchSellAuthAdminJson(`/v1/shops/${SELLAUTH_SHOP_ID}/customers/${devCustomerId}`)
      .then(mapSellAuthCustomerToThemeCustomer)
      .catch(() => null);
  }

  const availableProducts = ensureArray(source.products).length > 0
    ? ensureArray(source.products)
    : ensureArray(sample.sortedItems).filter((item) => item?.type === "product");
  const availableGroups = ensureArray(source.groups).length > 0
    ? ensureArray(source.groups)
    : ensureArray(source.sortedItems).filter((item) => item?.type === "group");
  const availableCategories = ensureArray(source.categories);
  const fallbackCategory = source.category || sample.category;

  let routeGroup = null;
  let routeCategory = fallbackCategory;
  if (routeData.categorySlug) {
    routeGroup = availableGroups.find((group) => group.path === routeData.categorySlug) || null;

    if (!routeGroup) {
      routeCategory = availableCategories.find((category) => category.path === routeData.categorySlug)
        || {
          id: 2,
          name: slugToName(routeData.categorySlug),
          path: routeData.categorySlug,
          url: `/products/${routeData.categorySlug}`,
          meta_title: `${slugToName(routeData.categorySlug)} Products`,
          meta_description: `Browse ${slugToName(routeData.categorySlug)} products.`,
          meta_image_url: "/assets/hero.jpg",
        };
    } else {
      routeCategory = availableCategories.find((category) => Number(category.id) === Number(routeGroup.category_id))
        || fallbackCategory;
    }
  }

  const routeCollectionProducts = routeGroup
    ? ensureArray(routeGroup.products).filter((item) => !item?.type || item.type === "product")
    : (routeData.categorySlug && routeCategory?.id
      ? availableProducts.filter((item) => Number(item.category_id) === Number(routeCategory.id))
      : []);

  const routeCollectionName = routeGroup
    ? routeGroup.name
    : (routeData.categorySlug ? routeCategory?.name || slugToName(routeData.categorySlug) : "");

  const routeProduct =
    availableProducts.find((item) => item.type === "product" && item.path === routeData.productPath)
    || source.product
    || sample.product;

  const routeBlogPost =
    ensureArray(source.blog_posts).find((post) => post.path === routeData.blogPath)
    || source.blogPost
    || sample.blogPost;

  const fallbackShop = {
    id: SELLAUTH_SHOP_ID,
    name: "Theme Preview Shop",
    url: SELLAUTH_SHOP_URL || `http://localhost:${PORT}`,
    image_url: "/assets/hero.jpg",
    favicon_url: "/assets/hero.jpg",
    background_image_url: "",
    meta_title: "Theme Preview Shop",
    meta_description: "Local preview for Nunjucks theme.",
    meta_image_url: "/assets/hero.jpg",
    meta_twitter_card: "summary_large_image",
    max_cart_limit: 10,
    tickets_enabled: true,
    customer_balance_enabled: true,
    affiliate_enabled: true,
    affiliate_percentage: 10,
    affiliate_code_editable: true,
    discord_url: "https://discord.gg/onlyskills",
    telegram_url: "#",
    instagram_url: "#",
    tiktok_url: "#",
    youtube_url: "#",
    recaptcha_key: "",
    gtag_id: "",
    tawkto_id: "",
    crisp_website_id: "",
  };

  return {
    templateName,
    isBuilder: false,
    schemaOrg: null,
    name: routeData.customPageName || "Custom Page",
    custom_page: {
      path: routeData.customPagePath || "custom-page",
      name: routeData.customPageName || "Custom Page",
    },
    components: normalizeComponentMap(templateConfig.components),
    components_order: Array.isArray(templateConfig.components_order) ? templateConfig.components_order : [],
    global: settings.global || { properties: {}, components: {} },
    helpers: {
      components: {
        products: {
          getItemsByIds: helperItemsById,
        },
      },
    },
    shop: { ...fallbackShop, ...(source.shop || {}) },
    shop_customer: shouldMockCustomer ? defaultShopCustomer : devShopCustomer,
    customer: shouldMockCustomer ? defaultShopCustomer : devShopCustomer,
    currency: "USD",
    currency_rates_usd: { USD: 1, EUR: 0.92 },
    currency_symbols: { USD: "$", EUR: "EUR" },
    altcha: null,
    altcha_shop_customer: null,
    is_embed: false,
    balance_product_id: 101,
    balance_product_variant_id: 1001,
    asset_versions: {
      pro: getAssetVersion("pro.css"),
      custom: getAssetVersion("custom.css"),
    },
    ...sample,
    ...source,
    all_products: availableProducts,
    groups_listing: availableGroups,
    route_category_slug: routeData.categorySlug || "",
    current_group: routeGroup,
    current_collection: {
      name: routeCollectionName,
      path: routeData.categorySlug || "",
      type: routeGroup ? "group" : (routeData.categorySlug ? "category" : ""),
    },
    collection_products: routeCollectionProducts,
    category: routeCategory,
    product: routeProduct,
    blogPost: routeBlogPost,
    page_title: routeData.customPageName || "Custom Page",
  };
}

async function renderPage(req, templateName, routeData = {}) {
  const context = await createContext(req, templateName, routeData);
  const templatePath = `templates/${templateName}.njk`;

  const templateHtml = env.render(templatePath, context);
  const layoutName = currentSettings.templates?.[templateName]?.layout;

  if (!layoutName) {
    return templateHtml;
  }

  const layoutPath = `layouts/${layoutName}.njk`;
  return env.render(layoutPath, {
    ...context,
    templateContent: new nunjucks.runtime.SafeString(templateHtml),
  });
}

const generalRateLimiter = createMemoryRateLimiter({
  windowMs: GENERAL_RATE_LIMIT_WINDOW_MS,
  max: GENERAL_RATE_LIMIT_MAX,
  namespace: "general",
});

const apiRateLimiter = createMemoryRateLimiter({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  namespace: "api",
});

function buildCspValue() {
  const connectSources = new Set(["'self'"]);
  if (SELLAUTH_API_BASE_URL) {
    const apiOrigin = normalizeOrigin(SELLAUTH_API_BASE_URL);
    if (apiOrigin) connectSources.add(apiOrigin);
  }
  const shopOrigin = normalizeOrigin(SELLAUTH_SHOP_URL);
  if (shopOrigin) connectSources.add(shopOrigin);
  connectSources.add("https://api.sellauth.com");
  connectSources.add("https://www.google.com");
  connectSources.add("https://www.gstatic.com");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://www.google.com https://www.gstatic.com https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com https://unpkg.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "frame-src https://www.google.com https://www.youtube-nocookie.com https://myvouch.es",
  ].join("; ");
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/assets/")) {
    generalRateLimiter(req, res, next);
    return;
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Content-Security-Policy", buildCspValue());

  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  const isSecureRequest = req.secure || proto === "https";
  if (IS_PRODUCTION && isSecureRequest) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  next();
});

app.use(
  "/assets",
  express.static(ASSETS_DIR, {
    maxAge: ASSETS_CACHE_MAX_AGE_MS,
    etag: true,
    lastModified: true,
  })
);

app.get("/features.json", (req, res) => {
  const filePath = path.join(ROOT_DIR, "features.json");
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "features_not_found" });
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.type("application/json").send(fs.readFileSync(filePath, "utf8"));
});

app.get("/requirements.json", (req, res) => {
  const filePath = path.join(ROOT_DIR, "requirements.json");
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "requirements_not_found" });
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.type("application/json").send(fs.readFileSync(filePath, "utf8"));
});

app.use(
  "/api",
  apiRateLimiter,
  express.raw({ type: "*/*", limit: PROXY_BODY_LIMIT }),
  async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const allowedMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
      if (!allowedMethods.has(method)) {
        res.status(405).json({
          error: "method_not_allowed",
          message: "Unsupported method for /api proxy.",
        });
        return;
      }

      if (!isAllowedApiOrigin(req)) {
        res.status(403).json({
          error: "forbidden_origin",
          message: "This origin is not allowed to access the API proxy.",
        });
        return;
      }

      if (method === "OPTIONS") {
        res.status(204).end();
        return;
      }

      const storefrontBase = SELLAUTH_API_BASE_URL
        .replace(/\/+$/, "")
        .replace(/\/v1$/i, "");
      let upstreamPath = req.originalUrl.replace(/^\/api/, "");
      if (!upstreamPath.startsWith("/")) {
        upstreamPath = `/${upstreamPath}`;
      }

      if (upstreamPath.length > 2048 || !upstreamPath.startsWith("/v1/") || /[\r\n]/.test(upstreamPath)) {
        res.status(400).json({
          error: "invalid_api_path",
          message: "Invalid API path.",
        });
        return;
      }

      // Doc-based mapping:
      // local theme endpoint /v1/checkout -> official /v1/shops/{shopId}/checkout
      const isCheckoutRequest =
        upstreamPath === "/v1/checkout" || upstreamPath.startsWith("/v1/checkout?");
      if (isCheckoutRequest) {
        upstreamPath = upstreamPath.replace(
          /^\/v1\/checkout/,
          `/v1/shops/${SELLAUTH_SHOP_ID}/checkout`
        );
      }

      const adminCheckoutPrefix = `/v1/shops/${SELLAUTH_SHOP_ID}/checkout`;
      const shouldUseApiKey =
        upstreamPath === adminCheckoutPrefix ||
        upstreamPath.startsWith(`${adminCheckoutPrefix}?`) ||
        upstreamPath.startsWith(`${adminCheckoutPrefix}/`);

      if (upstreamPath.startsWith(`/v1/shops/${SELLAUTH_SHOP_ID}/`) && !shouldUseApiKey) {
        res.status(403).json({
          error: "forbidden_admin_path",
          message: "This admin API path is not allowed via the local proxy.",
        });
        return;
      }

      const upstreamBase = shouldUseApiKey
        ? `${getAdminApiBaseUrl().replace(/\/+$/, "")}/`
        : (storefrontBase ? `${storefrontBase}/` : null);

      if (!upstreamBase) {
        res.status(501).json({
          error: "SELLAUTH_API_BASE_URL is not configured",
          message: "Set SELLAUTH_API_BASE_URL in your .env file to enable storefront API proxying.",
        });
        return;
      }

      const upstreamUrl = new URL(upstreamPath, upstreamBase).toString();

      const requestHeaders = new Headers();
      let hasAuthorizationHeader = false;
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) {
          continue;
        }

        const lower = key.toLowerCase();
        if (
          lower === "host" ||
          lower === "content-length" ||
          lower === "connection" ||
          lower === "cookie" ||
          lower === "x-forwarded-for" ||
          lower === "x-real-ip" ||
          lower === "cf-connecting-ip"
        ) {
          continue;
        }

        if (lower === "authorization") {
          hasAuthorizationHeader = true;
        }

        if (Array.isArray(value)) {
          requestHeaders.set(key, value.join(", "));
        } else {
          requestHeaders.set(key, value);
        }
      }

      if (!hasAuthorizationHeader && shouldUseApiKey && SELLAUTH_API_KEY) {
        requestHeaders.set("Authorization", `Bearer ${SELLAUTH_API_KEY}`);
      }

      if (!hasAuthorizationHeader && shouldUseApiKey && !SELLAUTH_API_KEY) {
        res.status(501).json({
          error: "SELLAUTH_API_KEY is not configured",
          message:
            "This endpoint requires SellAuth API key auth. Set SELLAUTH_API_KEY in your .env file.",
        });
        return;
      }

      if (!requestHeaders.has("accept")) {
        requestHeaders.set("Accept", "application/json");
      }

      const methodHasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
      const body = methodHasBody && req.body && req.body.length > 0 ? req.body : undefined;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers: requestHeaders,
        body,
        redirect: "manual",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      res.status(upstreamResponse.status);

      upstreamResponse.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (
          lower === "content-encoding" ||
          lower === "transfer-encoding" ||
          lower === "content-length" ||
          lower === "set-cookie"
        ) {
          return;
        }
        res.setHeader(key, value);
      });

      const buffer = Buffer.from(await upstreamResponse.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      if (error && error.name === "AbortError") {
        res.status(504).json({
          error: "upstream_timeout",
          message: "SellAuth API timeout. Please retry in a few seconds.",
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown proxy error";
      res.status(502).json({
        error: "sellauth_proxy_failed",
        message,
      });
    }
  }
);

app.post("/dev/customer-login", express.json(), async (req, res) => {
  try {
    const secret = String(process.env.DEV_CUSTOMER_LOGIN_SECRET || "").trim();
    if (!secret) {
      res.status(501).json({
        error: "dev_login_not_configured",
        message: "Set DEV_CUSTOMER_LOGIN_SECRET in .env to use dev customer login.",
      });
      return;
    }

    const provided = String(req.headers["x-dev-secret"] || "").trim();
    if (!provided || provided !== secret) {
      res.status(401).json({ error: "unauthorized", message: "Invalid dev secret." });
      return;
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ error: "invalid_email", message: "Provide a valid email." });
      return;
    }

    if (!SELLAUTH_API_KEY || !SELLAUTH_SHOP_ID) {
      res.status(501).json({
        error: "sellauth_not_configured",
        message: "SELLAUTH_API_KEY and SELLAUTH_SHOP_ID must be set for dev login.",
      });
      return;
    }

    const listUrl = `/v1/shops/${SELLAUTH_SHOP_ID}/customers?email=${encodeURIComponent(email)}&perPage=1`;
    const payload = await fetchSellAuthAdminJson(listUrl).catch(() => null);
    const first = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    const mapped = mapSellAuthCustomerToThemeCustomer(first);
    if (!mapped || !mapped.id) {
      res.status(404).json({ error: "customer_not_found", message: "Customer not found for this email." });
      return;
    }

    const isSecureRequest = Boolean(req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https");
    res.setHeader(
      "Set-Cookie",
      setCookieHeaderValue("dev_customer_id", String(mapped.id), {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: IS_PRODUCTION && isSecureRequest,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      })
    );
    res.json({ success: true, customer: mapped });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown dev login error";
    res.status(500).json({ error: "dev_login_failed", message });
  }
});

app.post("/dev/customer-logout", (req, res) => {
  res.setHeader(
    "Set-Cookie",
    setCookieHeaderValue("dev_customer_id", "", {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
      maxAgeSeconds: 0,
    })
  );
  res.json({ success: true });
});

app.get("*", async (req, res) => {
  currentSettings = loadSettings();

  if (req.path.startsWith("/customer/") && !hasCustomerSession(req)) {
    const clean = String(req.path || "").replace(/^\/+|\/+$/g, "");
    const parts = clean.split("/").filter(Boolean);
    const section = parts[1] || "dashboard";
    const allowedBack = new Set(["dashboard", "invoices", "tickets", "balance", "affiliate"]);
    const back = allowedBack.has(section) ? section : "dashboard";
    res.redirect(`/?login=1&back=${encodeURIComponent(back)}`);
    return;
  }

  const resolved = resolveTemplate(req.path);
  if (!resolved) {
    res.status(404).send("Page not found");
    return;
  }

  try {
    const html = await renderPage(req, resolved.templateName, resolved.routeData);
    res.send(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    res.status(500).send(`<pre>Render error: ${message}</pre>`);
  }
});

app.listen(PORT, () => {
  const pages = [
    "/",
    "/products",
    "/product/starter-key",
    "/status",
    "/blog",
  ];

  console.log(`NJK preview running on http://localhost:${PORT}`);
  console.log(
    SELLAUTH_API_BASE_URL
      ? `SellAuth API proxy enabled: /api/* -> ${SELLAUTH_API_BASE_URL}`
      : "SellAuth API proxy disabled. Set SELLAUTH_API_BASE_URL to enable live API calls."
  );
  console.log(
    SELLAUTH_API_KEY
      ? "SellAuth API key loaded from .env."
      : "SellAuth API key not set. Endpoints requiring backend API auth will fail until SELLAUTH_API_KEY is set."
  );
  console.log(
    SELLAUTH_API_KEY
      ? `Live data mode enabled for shop ${SELLAUTH_SHOP_ID} via ${getAdminApiBaseUrl()}.`
      : "Live data mode disabled (missing SELLAUTH_API_KEY) - preview fallback will be used."
  );
  console.log("Sample routes:");
  for (const route of pages) {
    console.log(`  - http://localhost:${PORT}${route}`);
  }

  if (SELLAUTH_API_KEY) {
    void fetchSellAuthLiveData()
      .then(() => {
        console.log("Live data cache pre-warmed.");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Live data pre-warm skipped: ${message}`);
      });
  }
});
