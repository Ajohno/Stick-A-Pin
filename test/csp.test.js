const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function publicHtmlFiles() {
  return fs.readdirSync("public")
    .filter((name) => name.endsWith(".html"))
    .map((name) => path.join("public", name));
}

test("Helmet script policy forbids inline scripts and script attributes", () => {
  const source = fs.readFileSync("server.js", "utf8");
  const scriptSrc = source.match(/scriptSrc:\s*\[([^\]]+)\]/)?.[1] || "";
  const scriptSrcAttr = source.match(/scriptSrcAttr:\s*\[([^\]]+)\]/)?.[1] || "";
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  assert.match(scriptSrc, /"'self'"/);
  assert.match(scriptSrcAttr, /"'none'"/);
});

test("production HTML contains no inline scripts, event handlers, or javascript URLs", () => {
  for (const file of publicHtmlFiles()) {
    const html = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, file);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, file);
    assert.doesNotMatch(html, /(?:href|src)\s*=\s*["']\s*javascript:/i, file);
  }
});

test("important pages retain required external application scripts", () => {
  const expected = {
    "public/login.html": ["js/main.js"],
    "public/register.html": ["js/main.js"],
    "public/dashboard.html": ["js/main.js", "js/duration-utils.js"],
    "public/focus-page.html": ["js/main.js", "js/duration-utils.js"],
  };
  for (const [file, scripts] of Object.entries(expected)) {
    const html = fs.readFileSync(file, "utf8");
    scripts.forEach((script) => assert.match(html, new RegExp(`<script[^>]+src=["']${script.replace(".", "\\.")}["']`), file));
  }
});
