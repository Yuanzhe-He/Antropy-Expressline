const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

const publicDir = path.join(__dirname, "../../public");
const templatePath = path.join(__dirname, "../../views/quote-document.ejs");

const MIME_BY_EXT = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

let assetCache = null;
let browserPromise = null;

function fileToDataUri(relativePath) {
  const absolute = path.join(publicDir, relativePath);
  try {
    const buffer = fs.readFileSync(absolute);
    const ext = path.extname(absolute).toLowerCase();
    const mime = MIME_BY_EXT[ext] || "application/octet-stream";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (_error) {
    return null;
  }
}

// Read fonts + logos once and inline them as data URIs so the rendered HTML is
// fully self-contained — no network, no dependency on host fonts. Missing logos
// resolve to null; the template draws a labelled placeholder instead of crashing.
function loadAssets() {
  if (assetCache) {
    return assetCache;
  }
  assetCache = {
    fontSans: fileToDataUri("fonts/NotoSans-Regular.woff2"),
    fontSansBold: fileToDataUri("fonts/NotoSans-Bold.woff2"),
    fontCjk: fileToDataUri("fonts/NotoSansSC-Regular.woff2"),
    logoExpressLine: fileToDataUri("express-line-logo.png"),
    logoDewell: fileToDataUri("dewell-logo.svg"),
    logoIata: fileToDataUri("iata-logo.png"),
    logoCtpat: fileToDataUri("ctpat-logo.png"),
  };
  return assetCache;
}

async function getBrowser() {
  if (!browserPromise) {
    // Lazy require: only pulled in when a PDF is actually requested, so the
    // rest of the app boots even if Chromium is unavailable.
    const puppeteer = require("puppeteer");
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--font-render-hinting=none",
      ],
    });
  }
  return browserPromise;
}

async function renderQuoteHtml(quoteView) {
  return ejs.renderFile(templatePath, { ...quoteView, assets: loadAssets() });
}

async function renderQuotePdf(quoteView) {
  const html = await renderQuoteHtml(quoteView);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Inlined @font-face data URIs never trigger network activity, so
    // networkidle0 would stall until timeout. Wait for load + fonts instead —
    // this is what makes CJK render reliably, incl. on Railway cold start.
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    await page.evaluateHandle(() => document.fonts.ready);
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "12mm", right: "10mm", bottom: "14mm", left: "10mm" },
      displayHeaderFooter: false,
    });
  } finally {
    await page.close();
  }
}

async function closeQuoteBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch (_error) {
      /* already closed */
    }
    browserPromise = null;
  }
}

module.exports = {
  loadAssets,
  renderQuoteHtml,
  renderQuotePdf,
  closeQuoteBrowser,
};
