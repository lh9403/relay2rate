import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import child_process from "node:child_process";
import { readJsonIfExists, resolveFromRoot, loadConfig, saveConfig } from "./utils.js";
import { runScrape } from "./scrape.js";
import { scrapeNewApi } from "../sites/newapi.js";

const port = Number(process.env.PORT || 4173);

const SENSITIVE_FIELDS = ["password", "token", "cookie"];

let pendingLogin = null;

function waitForLoginConfirm(siteId, siteName) {
  return new Promise((resolve, reject) => {
    pendingLogin = { siteId, siteName, resolve, reject };
  });
}

function resolvePendingLogin() {
  if (pendingLogin) {
    pendingLogin.resolve();
    pendingLogin = null;
  }
}

function rejectPendingLogin(error) {
  if (pendingLogin) {
    pendingLogin.reject(error);
    pendingLogin = null;
  }
}

function readHistoryLines() {
  const filePath = resolveFromRoot("data/history.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
}

function isSameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function loadPrevDayBySite() {
  const today = new Date();
  const lastBySite = {};
  const prevDayBySite = {};
  for (const line of readHistoryLines()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const siteId = entry?.siteId;
    if (!siteId || siteId === "all") continue;
    const scrapedAt = entry?.scrapedAt;
    if (!scrapedAt) continue;
    if (isSameDay(scrapedAt, today)) {
      if (lastBySite[siteId]) {
        if (!prevDayBySite[siteId]) prevDayBySite[siteId] = lastBySite[siteId];
      }
      lastBySite[siteId] = entry;
    } else {
      prevDayBySite[siteId] = entry;
    }
  }
  return prevDayBySite;
}

function normalizeLatest(payload) {
  if (!payload) return { sites: [], groups: [], scrapedAt: new Date().toISOString() };
  if (Array.isArray(payload.sites)) return payload;
  if (Array.isArray(payload.groups)) {
    return {
      provider: "All",
      siteId: "all",
      scrapedAt: payload.scrapedAt,
      sites: [{
        provider: payload.provider,
        siteId: payload.siteId,
        framework: payload.framework,
        sourceUrl: payload.sourceUrl,
        scrapedAt: payload.scrapedAt,
        groups: payload.groups
      }],
      groups: payload.groups
    };
  }
  return { sites: [], groups: [], scrapedAt: new Date().toISOString() };
}

function attachPrevMultiplier(payload) {
  if (!payload || !Array.isArray(payload.sites)) return payload;
  const prevBySite = loadPrevDayBySite();
  for (const site of payload.sites) {
    const prev = prevBySite[site.siteId];
    if (!prev || !Array.isArray(prev.groups)) continue;
    const prevMap = new Map();
    for (const g of prev.groups) {
      if (g?.name != null) prevMap.set(String(g.name), Number(g.multiplier));
    }
    const curNames = new Set();
    for (const group of site.groups || []) {
      if (group?.name == null) continue;
      const name = String(group.name);
      curNames.add(name);
      const prevVal = prevMap.get(name);
      if (prevVal === undefined) {
        group.isNew = true;
        continue;
      }
      const cur = Number(group.multiplier);
      if (Number.isFinite(prevVal) && Number.isFinite(cur) && prevVal !== cur) {
        group.prevMultiplier = prevVal;
      }
    }
    const disappeared = [];
    for (const [name, multiplier] of prevMap) {
      if (!curNames.has(name) && Number.isFinite(multiplier)) {
        disappeared.push({ name, multiplier });
      }
    }
    if (disappeared.length) {
      site.disappearedGroups = disappeared.sort((a, b) =>
        a.name.localeCompare(b.name, "zh-CN"));
    }
  }
  return payload;
}

function sanitizeSiteConfig(siteId, siteConfig) {
  const safe = { siteId };
  for (const [key, value] of Object.entries(siteConfig)) {
    if (SENSITIVE_FIELDS.includes(key)) {
      safe[key] = value ? "已配置" : "";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validateSiteInput(input) {
  const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
  const name = String(input.name || "").trim();
  const framework = String(input.framework || "").trim();
  if (!baseUrl) return "baseUrl 不能为空";
  if (!name) return "name 不能为空";
  if (framework !== "newapi" && framework !== "sub2api") return "framework 必须为 newapi 或 sub2api";
  try { new URL(baseUrl); } catch { return "baseUrl 不是合法 URL"; }
  return null;
}

function slugifySiteId(name, existingIds) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "site";
  let id = base;
  let n = 2;
  while (existingIds.includes(id)) { id = `${base}${n++}`; }
  return id;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(`${body}\n`);
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      sendFile(res, resolveFromRoot("dashboard.html"), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/data") {
      const payload = readJsonIfExists(resolveFromRoot("data/latest.json")) ?? { sites: [], groups: [] };
      sendJson(res, 200, attachPrevMultiplier(normalizeLatest(payload)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      const siteId = url.searchParams.get("site") || "all";
      await runScrape(siteId, { waitForLoginConfirm });
      const payload = readJsonIfExists(resolveFromRoot("data/latest.json")) ?? { sites: [], groups: [] };
      sendJson(res, 200, { ok: true, siteId, data: attachPrevMultiplier(normalizeLatest(payload)) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/login/pending") {
      if (pendingLogin) {
        sendJson(res, 200, { pending: true, siteId: pendingLogin.siteId, siteName: pendingLogin.siteName });
      } else {
        sendJson(res, 200, { pending: false });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login/confirm") {
      if (!pendingLogin) {
        sendJson(res, 200, { ok: false, error: "当前没有等待登录确认的站点" });
        return;
      }
      resolvePendingLogin();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      const config = loadConfig() ?? { sites: {} };
      const sites = Object.entries(config.sites || {}).map(([siteId, siteConfig]) =>
        sanitizeSiteConfig(siteId, siteConfig)
      );
      sendJson(res, 200, { ok: true, sites });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config/site/test") {
      const input = await readBody(req);
      const error = validateSiteInput(input);
      if (error) { sendJson(res, 400, { ok: false, error }); return; }

      const config = loadConfig() ?? { sites: {} };
      const existingIds = Object.keys(config.sites || {});
      const siteId = String(input.siteId || "").trim() || slugifySiteId(input.name, existingIds);

      const existing = config.sites?.[siteId] || {};
      const merged = {
        name: String(input.name).trim(),
        baseUrl: String(input.baseUrl).trim().replace(/\/+$/, ""),
        framework: String(input.framework).trim()
      };
      for (const field of ["username", "password", "token", "cookie", "userId", "apiPrefix", "loginPath", "remoteDebuggingPort", "profileDir", "turnstileToken", "adapter"]) {
        const value = input[field];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          merged[field] = typeof value === "string" ? value.trim() : value;
        } else if (existing[field] !== undefined && SENSITIVE_FIELDS.includes(field) && input[field] === undefined) {
          merged[field] = existing[field];
        }
      }

      try {
        const result = await scrapeNewApi(merged, { siteId, waitForLoginConfirm });
        sendJson(res, 200, { ok: true, siteId, groups: result.groups?.length ?? 0 });
      } catch (err) {
        rejectPendingLogin();
        sendJson(res, 200, { ok: false, siteId, error: err.message || String(err) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config/site") {
      const input = await readBody(req);
      const error = validateSiteInput(input);
      if (error) { sendJson(res, 400, { ok: false, error }); return; }

      const config = loadConfig() ?? { sites: {} };
      if (!config.sites) config.sites = {};
      const existingIds = Object.keys(config.sites);
      const siteId = String(input.siteId || "").trim() || slugifySiteId(input.name, existingIds);
      if (!/^[a-z0-9_-]+$/i.test(siteId)) {
        sendJson(res, 400, { ok: false, error: "siteId 只能包含字母、数字、下划线和连字符" });
        return;
      }

      const existing = config.sites[siteId] || {};
      const merged = {
        name: String(input.name).trim(),
        baseUrl: String(input.baseUrl).trim().replace(/\/+$/, ""),
        framework: String(input.framework).trim()
      };
      for (const field of ["username", "password", "token", "cookie", "userId", "apiPrefix", "loginPath", "remoteDebuggingPort", "profileDir", "turnstileToken", "adapter"]) {
        const value = input[field];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          merged[field] = typeof value === "string" ? value.trim() : value;
        } else if (existing[field] !== undefined && SENSITIVE_FIELDS.includes(field) && input[field] === undefined) {
          merged[field] = existing[field];
        }
      }

      config.sites[siteId] = merged;
      saveConfig(config);
      sendJson(res, 200, { ok: true, siteId, site: sanitizeSiteConfig(siteId, merged) });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/config/site") {
      const siteId = url.searchParams.get("site");
      if (!siteId) { sendJson(res, 400, { ok: false, error: "缺少 site 参数" }); return; }
      const config = loadConfig() ?? { sites: {} };
      if (!config.sites || !(siteId in config.sites)) {
        sendJson(res, 404, { ok: false, error: `站点 ${siteId} 不存在` });
        return;
      }
      delete config.sites[siteId];
      saveConfig(config);
      sendJson(res, 200, { ok: true, siteId });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

const config = loadConfig();
if (!config?.sites || Object.keys(config.sites).length === 0) {
  console.log("未检测到 config.json 或未配置任何站点，跳过启动采集。");
  console.log("请在看板页面 http://localhost:" + port + " 上配置站点。");
} else {
  console.log("启动前先采集一次所有站点...");
  try {
    await runScrape("all");
  } catch (error) {
    console.error("启动采集失败，看板仍会启动:", error.message || error);
  }
}

server.listen(port, () => {
  const url = `http://localhost:${port}`;
  console.log(`Price Watch 看板已启动: ${url}`);
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  child_process.exec(`${cmd} ${url}`);
});
