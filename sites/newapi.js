import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { resolveFromRoot } from "../scripts/utils.js";

const DEFAULT_REMOTE_DEBUGGING_PORT = 9223;
const CONFIG_PLACEHOLDERS = [
  "在这里粘贴cookie",
  "session=xxx",
  "其他cookie=yyy",
  "在这里填账号",
  "在这里填密码",
  "你的用户名或邮箱",
  "你的密码"
];

function sessionFileForSite(siteId) {
  return `data/sessions/${siteId}.json`;
}

function defaultProfileDirForSite(siteId) {
  return `browser-profile/${siteId}`;
}

function loadSavedSession(siteId) {
  const sessionPath = resolveFromRoot(sessionFileForSite(siteId));
  if (!fs.existsSync(sessionPath)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (Date.now() - session.savedAt > 7 * 86400_000) return null;
    return session;
  } catch {
    return null;
  }
}

function saveSession(siteId, session) {
  const sessionPath = resolveFromRoot(sessionFileForSite(siteId));
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({ ...session, savedAt: Date.now() }));
  console.log(`Session 已保存到 ${sessionPath}，下次自动复用`);
}

function isUsableCookie(cookie) {
  return (
    typeof cookie === "string" &&
    cookie.trim() &&
    !CONFIG_PLACEHOLDERS.some((placeholder) => cookie.includes(placeholder))
  );
}

function isUsableUserId(userId) {
  return Number.isInteger(Number(userId)) && Number(userId) > 0;
}

function isUsableToken(token) {
  return isFilledConfigValue(token);
}

function hasUsableCredentials(siteConfig) {
  return isFilledConfigValue(siteConfig.username) && isFilledConfigValue(siteConfig.password);
}

function isFilledConfigValue(value) {
  return (
    typeof value === "string" &&
    value.trim() &&
    !CONFIG_PLACEHOLDERS.some((placeholder) => value.includes(placeholder)) &&
    !value.startsWith("在这里")
  );
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function frameworkFor(siteConfig) {
  const framework = siteConfig.framework;
  if (framework !== "newapi" && framework !== "sub2api") {
    throw new Error(`缺少或无效的 framework 配置，必须为 "newapi" 或 "sub2api"`);
  }
  return framework;
}

function apiPrefixFor(siteConfig) {
  if (siteConfig.apiPrefix != null) return String(siteConfig.apiPrefix).replace(/^\/?/, "/").replace(/\/+$/, "");
  return frameworkFor(siteConfig) === "sub2api" ? "/api/v1" : "";
}

function apiUrl(baseUrl, siteConfig, endpoint) {
  return `${baseUrl}${apiPrefixFor(siteConfig)}${endpoint}`;
}

function authHeaders(session, siteConfig) {
  if (frameworkFor(siteConfig) === "sub2api") {
    return {
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(session.cookie ? { Cookie: session.cookie } : {})
    };
  }

  return {
    "New-Api-User": String(session.userId),
    Cookie: session.cookie
  };
}

function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function buildCookieHeaderFromSetCookie(setCookieHeaders) {
  return setCookieHeaders
    .map((header) => header.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function getChromeAppPath() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function getChromium(siteName) {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new Error(`${siteName} 需要 playwright 来读取或创建浏览器登录态。请先运行 npm install`);
  }
}

async function extractSessionFromContext(context, page, baseUrl, siteConfig) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);

  if (frameworkFor(siteConfig) === "sub2api") {
    const token = await page.evaluate(() => {
      const candidateKeys = ["auth_token", "token", "access_token"];
      for (const key of candidateKeys) {
        const value = window.localStorage.getItem(key);
        if (value) return value;
      }
      return null;
    });
    const cookie = buildCookieHeader(await context.cookies(baseUrl));
    if (!isUsableToken(token) && !isUsableCookie(cookie)) return null;
    return { token, cookie };
  }

  const userId = await page.evaluate(() => {
    const candidateKeys = ["uid", "userId", "user_id", "id"];
    for (const key of candidateKeys) {
      const value = window.localStorage.getItem(key);
      if (value && Number(value) > 0) return value;
    }
    return null;
  });

  const cookies = await context.cookies(baseUrl);
  const cookie = buildCookieHeader(cookies);
  if (!isUsableCookie(cookie) || !isUsableUserId(userId)) return null;

  return { cookie, userId };
}

async function extractSessionFromCdp(browser, baseUrl, siteConfig) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().startsWith(baseUrl)) ?? pages[0];
  if (!page) return null;
  return await extractSessionFromContext(context, page, baseUrl, siteConfig);
}

function getProfilePath(siteId, siteConfig) {
  return resolveFromRoot(siteConfig.profileDir ?? defaultProfileDirForSite(siteId));
}

async function openBrowserProfile(siteId, siteName, siteConfig, headless) {
  const chromium = await getChromium(siteName);
  const profilePath = getProfilePath(siteId, siteConfig);
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, { headless });
  } catch (error) {
    throw new Error(`无法打开 ${profilePath} 中的浏览器登录态。\n原因: ${error.message.split("\n")[0]}`);
  }
  return context;
}

async function loadSessionFromBrowserProfile(siteId, siteName, baseUrl, siteConfig) {
  const profilePath = getProfilePath(siteId, siteConfig);
  if (!fs.existsSync(profilePath)) return null;

  const context = await openBrowserProfile(siteId, siteName, siteConfig, true);
  try {
    const page = await context.newPage();
    return await extractSessionFromContext(context, page, baseUrl, siteConfig);
  } finally {
    await context.close();
  }
}

async function promptForBrowserLogin(siteId, siteName, baseUrl, siteConfig, options = {}) {
  const waitForConfirm = options.waitForLoginConfirm;
  if (!waitForConfirm && !process.stdin.isTTY) return null;

  const profilePath = getProfilePath(siteId, siteConfig);
  fs.mkdirSync(profilePath, { recursive: true });

  const session = await promptForSystemChromeLogin(siteId, siteName, baseUrl, siteConfig, profilePath, options);
  if (session) return session;

  console.log(`将打开 ${siteName} 浏览器窗口，请手动登录并通过验证。`);
  if (waitForConfirm) {
    console.log("等待网页确认登录完成...");
  } else {
    console.log("登录完成后回到终端按回车继续，脚本会保存 session。");
  }

  const context = await openBrowserProfile(siteId, siteName, siteConfig, false);
  try {
    const page = await context.newPage();
    await page.goto(loginUrlFor(baseUrl, siteConfig), {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    }).catch(() => null);

    if (hasUsableCredentials(siteConfig)) {
      await prefillLoginForm(page, siteConfig).catch(() => null);
    }

    await waitForLoginStep(siteId, siteName, waitForConfirm);
    return await extractSessionFromContext(context, page, baseUrl, siteConfig);
  } finally {
    await context.close();
  }
}

function loginUrlFor(baseUrl, siteConfig) {
  if (siteConfig.loginPath) return `${baseUrl}${siteConfig.loginPath.startsWith("/") ? "" : "/"}${siteConfig.loginPath}`;
  const loginPath = frameworkFor(siteConfig) === "sub2api" ? "/login" : "/sign-in";
  return hasUsableCredentials(siteConfig) ? `${baseUrl}${loginPath}` : `${baseUrl}/keys`;
}

async function promptForSystemChromeLogin(siteId, siteName, baseUrl, siteConfig, profilePath, options = {}) {
  const waitForConfirm = options.waitForLoginConfirm;
  const chromePath = getChromeAppPath();
  if (!chromePath) return null;

  const port = siteConfig.remoteDebuggingPort ?? DEFAULT_REMOTE_DEBUGGING_PORT;
  console.log(`将使用系统 Chrome 打开 ${siteName}，以便通过 Cloudflare/Turnstile 验证。`);
  if (waitForConfirm) {
    console.log("等待网页确认登录完成...");
  } else {
    console.log("登录完成后回到终端按回车继续，脚本会保存 session。");
  }

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check",
      loginUrlFor(baseUrl, siteConfig)
    ],
    { detached: true, stdio: "ignore" }
  );
  chrome.unref();

  await waitForLoginStep(siteId, siteName, waitForConfirm);

  const chromium = await getChromium(siteName);
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return await extractSessionFromCdp(browser, baseUrl, siteConfig);
  } catch (error) {
    console.log(`无法从系统 Chrome 读取登录态: ${error.message.split("\n")[0]}`);
    return null;
  } finally {
    await browser?.close().catch(() => null);
    try { process.kill(-chrome.pid); } catch {}
  }
}

async function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function waitForLoginStep(siteId, siteName, waitForConfirm) {
  if (waitForConfirm) {
    await waitForConfirm(siteId, siteName);
  } else {
    await waitForEnter(`完成 ${siteName} 登录后按回车继续...`);
  }
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(value);
    return true;
  }
  return false;
}

async function prefillLoginForm(page, siteConfig) {
  const filledUsername = await fillFirstVisible(
    page,
    [
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="账号"]',
      'input[placeholder*="用户"]'
    ],
    siteConfig.username
  );

  const filledPassword = await fillFirstVisible(
    page,
    [
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[placeholder*="密码"]'
    ],
    siteConfig.password
  );

  if (filledUsername && filledPassword) {
    console.log("已在登录页预填账号密码，请在浏览器里完成验证并登录。");
  }
}

async function fetchJson(url, options, siteName) {
  const res = await fetch(url, options);

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${siteName} API 返回了非 JSON 内容: HTTP ${res.status} ${text.slice(0, 120)}`);
  }

  if (!res.ok) {
    throw new Error(`${siteName} API 请求失败: HTTP ${res.status} ${body.message || text.slice(0, 120)}`);
  }

  return body;
}

async function fetchGroups(baseUrl, session, siteConfig, siteName) {
  if (frameworkFor(siteConfig) === "sub2api") {
    const headers = authHeaders(session, siteConfig);
    try {
      const [availableBody, ratesBody] = await Promise.all([
        fetchJson(apiUrl(baseUrl, siteConfig, "/groups/available"), { headers }, siteName),
        fetchJson(apiUrl(baseUrl, siteConfig, "/groups/rates"), { headers }, siteName)
      ]);
      return normalizeSub2ApiGroups(availableBody, ratesBody);
    } catch (error) {
      if (/HTTP 401|HTTP 403/.test(error.message)) return null;
      throw error;
    }
  }

  const body = await fetchJson(
    apiUrl(baseUrl, siteConfig, "/api/user/self/groups?include_usage=1"),
    { headers: authHeaders(session, siteConfig) },
    siteName
  );

  if (!body.success) return null;
  return body.data;
}

async function fetchBalance(baseUrl, session, siteConfig, siteName) {
  const isSub2Api = frameworkFor(siteConfig) === "sub2api";
  const endpoint = isSub2Api ? "/auth/me" : "/api/user/self";
  try {
    const body = await fetchJson(
      apiUrl(baseUrl, siteConfig, endpoint),
      { headers: authHeaders(session, siteConfig) },
      siteName
    );
    if (isSub2Api) {
      const data = unwrapData(body);
      if (data == null) return null;
      return {
        balance: typeof data.balance === "number" ? data.balance : null,
        totalRecharged: typeof data.total_recharged === "number" ? data.total_recharged : null,
        currency: "USD"
      };
    }
    const data = body.data;
    if (!data) return null;
    return {
      quota: typeof data.quota === "number" ? data.quota : null,
      usedQuota: typeof data.used_quota === "number" ? data.used_quota : null,
      currency: "quota"
    };
  } catch (error) {
    console.log(`${siteName} 余额获取失败: ${error.message.split("\n")[0]}`);
    return null;
  }
}

async function loginWithPassword(baseUrl, siteConfig, siteName) {
  if (!hasUsableCredentials(siteConfig)) return null;

  const isSub2Api = frameworkFor(siteConfig) === "sub2api";
  const loginEndpoint = isSub2Api ? "/auth/login" : "/api/user/login?turnstile=";
  const loginBody = isSub2Api
    ? {
        email: siteConfig.username,
        password: siteConfig.password,
        turnstile_token: siteConfig.turnstileToken || undefined
      }
    : {
        username: siteConfig.username,
        password: siteConfig.password
      };

  const loginRes = await fetch(apiUrl(baseUrl, siteConfig, loginEndpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(loginBody),
    redirect: "manual"
  });

  const text = await loginRes.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${siteName} 登录接口返回了非 JSON 内容: HTTP ${loginRes.status} ${text.slice(0, 120)}`);
  }

  const loginSucceeded =
    body.success === true ||
    body.code === 0 ||
    String(body.message || "").toLowerCase() === "success";

  if (!loginRes.ok || !loginSucceeded) {
    const message = body.message || text.slice(0, 120) || `HTTP ${loginRes.status}`;
    console.log(`${siteName} 账号密码自动登录失败: ${message}`);
    return null;
  }

  if (isSub2Api) {
    const token = body.data?.token ?? body.data?.access_token ?? body.token ?? body.access_token;
    const cookies = loginRes.headers.getSetCookie?.() ?? [];
    const cookie = buildCookieHeaderFromSetCookie(cookies);
    if (!isUsableToken(token) && !isUsableCookie(cookie)) {
      console.log(`${siteName} 账号密码登录成功，但没有拿到可用 token 或 cookie`);
      return null;
    }
    return { token, cookie };
  }

  const loginUserId = body.data?.id;
  const cookies = loginRes.headers.getSetCookie?.() ?? [];
  const loginCookie = buildCookieHeaderFromSetCookie(cookies);
  if (!isUsableCookie(loginCookie) || !isUsableUserId(loginUserId)) {
    console.log(`${siteName} 账号密码登录成功，但没有拿到可用的 cookie 或用户 ID`);
    return null;
  }

  return { cookie: loginCookie, userId: loginUserId };
}

function unwrapData(body) {
  return body?.data ?? body;
}

function normalizeSub2ApiGroups(availableBody, ratesBody) {
  const available = unwrapData(availableBody);
  const rates = unwrapData(ratesBody) ?? {};
  const list = Array.isArray(available)
    ? available
    : Array.isArray(available?.items)
      ? available.items
      : Array.isArray(available?.groups)
        ? available.groups
        : Object.entries(available ?? {}).map(([id, value]) => ({
            id,
            ...(typeof value === "object" && value ? value : { name: String(value) })
          }));

  return Object.fromEntries(
    list.map((group) => {
      const id = group.id ?? group.group_id ?? group.key ?? group.name;
      const name = group.name ?? group.label ?? group.title ?? String(id);
      const rateInfo = rates[id] ?? rates[name] ?? {};
      const ratio =
        group.ratio ??
        group.rate ??
        group.multiplier ??
        group.rate_multiplier ??
        rateInfo.ratio ??
        rateInfo.rate ??
        rateInfo.multiplier ??
        rateInfo.rate_multiplier ??
        1;
      const concurrency =
        group.max_concurrent ??
        group.concurrency ??
        group.max_concurrency ??
        rateInfo.max_concurrent ??
        rateInfo.concurrency ??
        rateInfo.max_concurrency ??
        null;
      return [
        name,
        {
          ratio: Number(ratio),
          max_concurrent: concurrency,
          desc: group.desc ?? group.description ?? rateInfo.desc ?? rateInfo.description ?? ""
        }
      ];
    })
  );
}

export async function scrapeNewApi(siteConfig, options = {}) {
  const siteId = options.siteId ?? siteConfig.id ?? "newapi";
  const siteName = siteConfig.name ?? options.name ?? siteId;
  const baseUrl = normalizeBaseUrl(siteConfig.baseUrl);
  const { cookie, userId } = siteConfig;

  const saved = loadSavedSession(siteId);
  if (saved) {
    console.log(`尝试复用 ${siteName} session...`);
    const data = await fetchGroups(baseUrl, saved, siteConfig, siteName);
    if (data) {
      console.log(`${siteName} session 有效`);
      const balance = await fetchBalance(baseUrl, saved, siteConfig, siteName);
      return buildResult(siteConfig, siteId, siteName, baseUrl, data, balance);
    }
    console.log(`${siteName} session 已过期，尝试其他登录态...`);
  }

  let activeSession = null;
  if (frameworkFor(siteConfig) === "sub2api" && isUsableToken(siteConfig.token)) {
    activeSession = { token: siteConfig.token, cookie: isUsableCookie(cookie) ? cookie : undefined };
  } else if (isUsableCookie(cookie) && isUsableUserId(userId)) {
    activeSession = { cookie, userId };
  } else {
    if (hasUsableCredentials(siteConfig)) {
      console.log(`尝试使用 ${siteName} 账号密码自动登录...`);
      activeSession = await loginWithPassword(baseUrl, siteConfig, siteName);
    }

    if (!activeSession) {
      console.log(`尝试读取 ${siteName} 本地浏览器登录态...`);
      try {
        activeSession = await loadSessionFromBrowserProfile(siteId, siteName, baseUrl, siteConfig);
      } catch (error) {
        console.log(error.message || error);
      }
    }

    if (!activeSession) {
      activeSession = await promptForBrowserLogin(siteId, siteName, baseUrl, siteConfig, options);
    }
  }

  if (!activeSession) {
    const loginHint =
      frameworkFor(siteConfig) === "sub2api"
        ? `请先用 ${defaultProfileDirForSite(siteId)} 登录一次，或在 config.json 中填写 token。`
        : `请先用 ${defaultProfileDirForSite(siteId)} 登录一次，或在 config.json 中填写 cookie 和 userId。`;
    throw new Error(
      `无法获取 ${siteName} 登录态。\n` +
        "如果账号密码自动登录失败，通常是站点要求 Turnstile/Cloudflare 验证。\n" +
        loginHint
    );
  }

  const data = await fetchGroups(baseUrl, activeSession, siteConfig, siteName);
  if (!data) {
    throw new Error(`${siteName} Cookie 无效或已过期，请重新登录。`);
  }

  const balance = await fetchBalance(baseUrl, activeSession, siteConfig, siteName);
  saveSession(siteId, activeSession);
  return buildResult(siteConfig, siteId, siteName, baseUrl, data, balance);
}

function buildResult(siteConfig, siteId, siteName, baseUrl, groupsData, balance = null) {
  const groups = Object.entries(groupsData).map(([name, info]) => ({
    name,
    multiplier: info.ratio,
    concurrency: info.max_concurrent ?? null,
    description: info.desc || "",
    rawText: ""
  }));

  return {
    provider: siteName,
    siteId,
    framework: frameworkFor(siteConfig),
    sourceUrl: `${baseUrl}/keys`,
    scrapedAt: new Date().toISOString(),
    balance,
    groups: groups.sort(
      (a, b) => a.multiplier - b.multiplier || a.name.localeCompare(b.name, "zh-CN")
    )
  };
}
