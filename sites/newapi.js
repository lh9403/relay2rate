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

  // 新版 newapi 使用 JWT access token；旧版仍用 session cookie + New-Api-User
  if (isUsableToken(session.token)) {
    return {
      Authorization: `Bearer ${session.token}`,
      ...(isUsableUserId(session.userId) ? { "New-Api-User": String(session.userId) } : {}),
      ...(isUsableCookie(session.cookie) ? { Cookie: session.cookie } : {})
    };
  }

  return {
    ...(isUsableUserId(session.userId) ? { "New-Api-User": String(session.userId) } : {}),
    ...(isUsableCookie(session.cookie) ? { Cookie: session.cookie } : {})
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

function mergeCookieHeaders(...headers) {
  const jar = new Map();
  for (const header of headers) {
    if (!isUsableCookie(header)) continue;
    for (const part of header.split(";")) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!name) continue;
      jar.set(name, value);
    }
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function cookiesForBaseUrl(cookies, baseUrl) {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return cookies;
  }
  return cookies.filter((cookie) => {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    if (!domain) return true;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

function hasNewApiAuthCookie(cookie) {
  return /(?:^|;\s*)(session|new_api_refresh)=/i.test(cookie || "");
}

function userIdFromAccessToken(token) {
  if (!isUsableToken(token)) return null;
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const candidate = payload.sub ?? payload.user_id ?? payload.userId ?? payload.id ?? payload.uid;
    return isUsableUserId(candidate) ? String(candidate) : null;
  } catch {
    return null;
  }
}

function isUsableNewApiSession(session) {
  if (!session) return false;
  if (isUsableToken(session.token)) return true;
  return hasNewApiAuthCookie(session.cookie) && isUsableUserId(session.userId);
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

async function readStorageSession(page, siteConfig) {
  return await page.evaluate((framework) => {
    const storageKeys = framework === "sub2api"
      ? ["auth_token", "token", "access_token"]
      : ["uid", "userId", "user_id", "id", "user", "userInfo"];

    const readValue = (store) => {
      for (const key of storageKeys) {
        const raw = store.getItem(key);
        if (!raw) continue;
        if (framework === "sub2api") return raw;
        if (Number(raw) > 0) return String(raw);
        try {
          const parsed = JSON.parse(raw);
          const candidate = parsed?.id ?? parsed?.user_id ?? parsed?.userId ?? parsed?.uid;
          if (candidate != null && Number(candidate) > 0) return String(candidate);
        } catch {}
      }
      return null;
    };

    return {
      local: readValue(window.localStorage),
      session: readValue(window.sessionStorage)
    };
  }, frameworkFor(siteConfig));
}

async function refreshNewApiSession(baseUrl, session, siteConfig, siteName, page = null) {
  const cookie = session?.cookie;
  if (!hasNewApiAuthCookie(cookie) && !isUsableToken(session?.token)) return null;

  // 优先走页面内 fetch，确保 path 限定的 refresh cookie 与 Cloudflare 态都能带上
  if (page) {
    try {
      const result = await page.evaluate(async () => {
        const res = await fetch("/api/user/auth/refresh", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        const text = await res.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {}
        return { ok: res.ok, status: res.status, body, text: text.slice(0, 200) };
      });
      if (result.ok) {
        const token =
          result.body?.data?.access_token ??
          result.body?.data?.token ??
          result.body?.access_token ??
          result.body?.token;
        const userId =
          result.body?.data?.id ??
          result.body?.data?.user?.id ??
          result.body?.data?.user_id ??
          userIdFromAccessToken(token) ??
          (isUsableUserId(session?.userId) ? String(session.userId) : null);
        if (isUsableToken(token)) {
          return {
            token,
            cookie,
            userId: isUsableUserId(userId) ? String(userId) : undefined
          };
        }
      }
    } catch {
      // fall through to node fetch
    }
  }

  try {
    const res = await fetch(apiUrl(baseUrl, siteConfig, "/api/user/auth/refresh"), {
      method: "POST",
      headers: {
        ...(isUsableCookie(cookie) ? { Cookie: cookie } : {}),
        "Content-Type": "application/json",
        Origin: baseUrl,
        Referer: `${baseUrl}/`
      },
      body: "{}"
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const token = body?.data?.access_token ?? body?.data?.token ?? body?.access_token ?? body?.token;
    const setCookie = buildCookieHeaderFromSetCookie(res.headers.getSetCookie?.() ?? []);
    const mergedCookie = mergeCookieHeaders(cookie, setCookie);
    const userId =
      body?.data?.id ??
      body?.data?.user?.id ??
      body?.data?.user_id ??
      userIdFromAccessToken(token) ??
      (isUsableUserId(session?.userId) ? String(session.userId) : null);
    if (!isUsableToken(token) && !hasNewApiAuthCookie(mergedCookie)) return null;
    return {
      token: isUsableToken(token) ? token : undefined,
      cookie: isUsableCookie(mergedCookie) ? mergedCookie : undefined,
      userId: isUsableUserId(userId) ? String(userId) : undefined
    };
  } catch (error) {
    console.log(`${siteName} access token 刷新失败: ${error.message.split("\n")[0]}`);
    return null;
  }
}

async function resolveUserIdFromCookie(baseUrl, cookie, siteConfig, siteName) {
  if (!isUsableCookie(cookie)) return null;
  try {
    const body = await fetchJson(
      apiUrl(baseUrl, siteConfig, "/api/user/self"),
      {
        headers: {
          Cookie: cookie,
          // 部分 newapi 部署在缺少 New-Api-User 时仍可用 cookie 返回用户信息
          "New-Api-User": "0"
        }
      },
      siteName
    );
    const userId = body?.data?.id ?? body?.data?.user_id ?? body?.data?.userId;
    return isUsableUserId(userId) ? String(userId) : null;
  } catch {
    return null;
  }
}

async function extractSessionFromContext(context, page, baseUrl, siteConfig, siteName = "site") {
  const candidateUrls = [
    `${baseUrl}/`,
    `${baseUrl}/dashboard/overview`,
    `${baseUrl}/console`,
    `${baseUrl}/keys`,
    `${baseUrl}/personal`,
    loginUrlFor(baseUrl, siteConfig)
  ];

  for (const url of candidateUrls) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // new_api_refresh 等 cookie 可能带 path 限制，不能只用首页 URL 过滤
    const siteCookies = cookiesForBaseUrl(await context.cookies(), baseUrl);
    const cookie = buildCookieHeader(siteCookies);

    if (frameworkFor(siteConfig) === "sub2api") {
      const stored = await readStorageSession(page, siteConfig);
      const token = stored.local || stored.session;
      if (isUsableToken(token) || isUsableCookie(cookie)) {
        return {
          token: isUsableToken(token) ? token : undefined,
          cookie: isUsableCookie(cookie) ? cookie : undefined
        };
      }
      continue;
    }

    if (hasNewApiAuthCookie(cookie)) {
      const refreshed = await refreshNewApiSession(baseUrl, { cookie }, siteConfig, siteName, page);
      if (isUsableNewApiSession(refreshed)) return refreshed;

      // 即使 refresh 暂时失败（如 429），也先把 refresh cookie 存下来
      const stored = await readStorageSession(page, siteConfig);
      let userId = stored.local || stored.session;
      if (!isUsableUserId(userId)) {
        userId = await resolveUserIdFromCookie(baseUrl, cookie, siteConfig, siteName);
      }
      if (hasNewApiAuthCookie(cookie)) {
        return {
          cookie,
          userId: isUsableUserId(userId) ? String(userId) : undefined
        };
      }
    }

    const stored = await readStorageSession(page, siteConfig);
    let userId = stored.local || stored.session;
    if (!isUsableUserId(userId) && isUsableCookie(cookie)) {
      userId = await resolveUserIdFromCookie(baseUrl, cookie, siteConfig, siteName);
    }
    if (isUsableCookie(cookie) && isUsableUserId(userId) && hasNewApiAuthCookie(cookie)) {
      return { cookie, userId: String(userId) };
    }
  }

  return null;
}

async function extractSessionFromCdp(browser, baseUrl, siteConfig, siteName) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().startsWith(baseUrl)) ?? pages[0] ?? (await context.newPage());
  if (!page) return null;
  return await extractSessionFromContext(context, page, baseUrl, siteConfig, siteName);
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

  const chromeResult = await promptForSystemChromeLogin(siteId, siteName, baseUrl, siteConfig, profilePath, options);
  if (chromeResult.session) return chromeResult.session;
  // 系统 Chrome 已经完成一次确认，但没读到登录态时，不要再卡第二次确认
  if (chromeResult.attempted) {
    console.log(`${siteName} 已完成浏览器确认，但未读到可用登录态，不再重复等待。`);
    return null;
  }
  const previousLoginToken = chromeResult.loginToken;

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

    await waitForLoginStep(siteId, siteName, waitForConfirm, previousLoginToken);
    return await extractSessionFromContext(context, page, baseUrl, siteConfig, siteName);
  } finally {
    await context.close();
  }
}

function loginUrlFor(baseUrl, siteConfig) {
  if (siteConfig.loginPath) return `${baseUrl}${siteConfig.loginPath.startsWith("/") ? "" : "/"}${siteConfig.loginPath}`;
  const loginPath = frameworkFor(siteConfig) === "sub2api" ? "/login" : "/sign-in";
  return hasUsableCredentials(siteConfig) ? `${baseUrl}${loginPath}` : `${baseUrl}/keys`;
}

async function waitForCdp(port, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function promptForSystemChromeLogin(siteId, siteName, baseUrl, siteConfig, profilePath, options = {}) {
  const waitForConfirm = options.waitForLoginConfirm;
  const chromePath = getChromeAppPath();
  if (!chromePath) return { attempted: false, session: null };

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

let loginToken = `chrome:${siteId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try {
    if (waitForConfirm) {
      await waitForConfirm(siteId, siteName, null);
    } else {
      await waitForEnter(`完成 ${siteName} 登录后按回车继续...`);
    }

    const cdpReady = await waitForCdp(port);
    if (!cdpReady) {
      console.log(`无法连接系统 Chrome 调试端口 ${port}，请确认浏览器仍在运行。`);
      return { attempted: true, session: null, loginToken };
    }

    const chromium = await getChromium(siteName);
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const session = await extractSessionFromCdp(browser, baseUrl, siteConfig, siteName);
      if (!session) {
        console.log(`${siteName} 浏览器已确认，但未读到 cookie/userId。请确认已登录成功后再点确认。`);
      }
      return { attempted: true, session, loginToken };
    } catch (error) {
      console.log(`无法从系统 Chrome 读取登录态: ${error.message.split("\n")[0]}`);
      return { attempted: true, session: null, loginToken };
    } finally {
      // 只断开 CDP 连接；不要 kill 用户刚登录的 Chrome 窗口
      await browser?.close().catch(() => null);
    }
  } catch (error) {
    console.log(`${siteName} 系统 Chrome 登录流程异常: ${error.message.split("\n")[0]}`);
    return { attempted: true, session: null, loginToken };
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

async function waitForLoginStep(siteId, siteName, waitForConfirm, previousToken) {
  if (waitForConfirm) {
    await waitForConfirm(siteId, siteName, previousToken);
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

function isAuthFailure(error) {
  return /HTTP 401|HTTP 403/.test(error?.message || "");
}

async function ensureFreshSession(baseUrl, session, siteConfig, siteName) {
  if (!session) return null;
  if (frameworkFor(siteConfig) === "sub2api") return session;
  if (isUsableToken(session.token) && isUsableNewApiSession(session)) return session;
  if (!hasNewApiAuthCookie(session.cookie) && !isUsableToken(session.token)) return session;
  const refreshed = await refreshNewApiSession(baseUrl, session, siteConfig, siteName);
  return refreshed || session;
}

async function fetchGroups(baseUrl, session, siteConfig, siteName) {
  try {
    if (frameworkFor(siteConfig) === "sub2api") {
      const headers = authHeaders(session, siteConfig);
      const [availableBody, ratesBody] = await Promise.all([
        fetchJson(apiUrl(baseUrl, siteConfig, "/groups/available"), { headers }, siteName),
        fetchJson(apiUrl(baseUrl, siteConfig, "/groups/rates"), { headers }, siteName)
      ]);
      return normalizeSub2ApiGroups(availableBody, ratesBody);
    }

    let active = session;
    // 新版 JWT 站点：没有 access token 时先用 refresh cookie 换一次
    if (!isUsableToken(active?.token) && hasNewApiAuthCookie(active?.cookie)) {
      active = (await refreshNewApiSession(baseUrl, active, siteConfig, siteName)) || active;
    }

    const body = await fetchJson(
      apiUrl(baseUrl, siteConfig, "/api/user/self/groups?include_usage=1"),
      { headers: authHeaders(active, siteConfig) },
      siteName
    );

    // 兼容 success 字段缺失但 data 有效的返回
    if (body?.success === false) return null;
    if (body?.data == null) return null;
    // 把刷新后的 token 回写，方便调用方保存
    if (active !== session && active) Object.assign(session, active);
    return body.data;
  } catch (error) {
    // access token 过期时尝试 refresh 一次
    if (
      frameworkFor(siteConfig) === "newapi" &&
      isAuthFailure(error) &&
      hasNewApiAuthCookie(session?.cookie)
    ) {
      const refreshed = await refreshNewApiSession(baseUrl, session, siteConfig, siteName);
      if (refreshed && isUsableToken(refreshed.token)) {
        Object.assign(session, refreshed);
        try {
          const body = await fetchJson(
            apiUrl(baseUrl, siteConfig, "/api/user/self/groups?include_usage=1"),
            { headers: authHeaders(session, siteConfig) },
            siteName
          );
          if (body?.success === false || body?.data == null) return null;
          return body.data;
        } catch (retryError) {
          if (isAuthFailure(retryError)) return null;
          throw retryError;
        }
      }
    }
    // 登录态失效时返回 null，让 scrape 流程继续走重新登录 / 浏览器验证
    if (isAuthFailure(error)) return null;
    throw error;
  }
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

  const cookies = loginRes.headers.getSetCookie?.() ?? [];
  const loginCookie = buildCookieHeaderFromSetCookie(cookies);
  const token = body.data?.access_token ?? body.data?.token ?? body.access_token ?? body.token;
  const loginUserId =
    body.data?.id ??
    body.data?.user?.id ??
    body.data?.user_id ??
    userIdFromAccessToken(token);

  // 新版 JWT：有 access token 即可；旧版仍要求 cookie + userId
  if (isUsableToken(token)) {
    return {
      token,
      cookie: isUsableCookie(loginCookie) ? loginCookie : undefined,
      userId: isUsableUserId(loginUserId) ? String(loginUserId) : undefined
    };
  }

  if (hasNewApiAuthCookie(loginCookie)) {
    const refreshed = await refreshNewApiSession(
      baseUrl,
      { cookie: loginCookie, userId: loginUserId },
      siteConfig,
      siteName
    );
    if (isUsableNewApiSession(refreshed)) return refreshed;
  }

  if (!isUsableCookie(loginCookie) || !isUsableUserId(loginUserId)) {
    console.log(`${siteName} 账号密码登录成功，但没有拿到可用的 cookie/token 或用户 ID`);
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
    const reusable = (await ensureFreshSession(baseUrl, saved, siteConfig, siteName)) || saved;
    const data = await fetchGroups(baseUrl, reusable, siteConfig, siteName);
    if (data) {
      console.log(`${siteName} session 有效`);
      saveSession(siteId, reusable);
      const balance = await fetchBalance(baseUrl, reusable, siteConfig, siteName);
      return buildResult(siteConfig, siteId, siteName, baseUrl, data, balance);
    }
    console.log(`${siteName} session 已过期，尝试其他登录态...`);
  }

  let activeSession = null;
  if (frameworkFor(siteConfig) === "sub2api" && isUsableToken(siteConfig.token)) {
    activeSession = { token: siteConfig.token, cookie: isUsableCookie(cookie) ? cookie : undefined };
  } else if (frameworkFor(siteConfig) === "newapi" && isUsableToken(siteConfig.token)) {
    activeSession = {
      token: siteConfig.token,
      cookie: isUsableCookie(cookie) ? cookie : undefined,
      userId: isUsableUserId(userId) ? userId : userIdFromAccessToken(siteConfig.token)
    };
  } else if (isUsableCookie(cookie) && (isUsableUserId(userId) || hasNewApiAuthCookie(cookie))) {
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
        : `请先用 ${defaultProfileDirForSite(siteId)} 登录一次，或在 config.json 中填写 cookie/token 和 userId。`;
    throw new Error(
      `无法获取 ${siteName} 登录态。\n` +
        "如果账号密码自动登录失败，通常是站点要求 Turnstile/Cloudflare 验证。\n" +
        loginHint
    );
  }

  activeSession = (await ensureFreshSession(baseUrl, activeSession, siteConfig, siteName)) || activeSession;
  const data = await fetchGroups(baseUrl, activeSession, siteConfig, siteName);
  if (!data) {
    throw new Error(`${siteName} 登录态无效或已过期，请重新登录。`);
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
