import { scrapeNewApi } from "../sites/newapi.js";
import {
  appendJsonLine,
  getArg,
  loadConfig,
  readJsonIfExists,
  resolveFromRoot,
  writeJson
} from "./utils.js";

const adapters = {
  newapi: scrapeNewApi,
  sub2api: scrapeNewApi
};

function adapterForSite(siteId, siteConfig) {
  const adapterId = siteConfig.adapter ?? siteConfig.framework;
  const adapter = adapters[adapterId];
  if (!adapter) {
    throw new Error(`没有找到站点适配器: ${adapterId ?? "（未配置 framework）"}`);
  }
  return adapter;
}

function resultPathForSite(siteId) {
  return resolveFromRoot("data/sites", `${siteId}.json`);
}

function buildAggregate(results) {
  return {
    provider: "All",
    siteId: "all",
    scrapedAt: new Date().toISOString(),
    sites: results,
    groups: results.flatMap((site) =>
      (site.groups ?? []).map((group) => ({
        ...group,
        provider: site.provider,
        siteId: site.siteId,
        framework: site.framework,
        sourceUrl: site.sourceUrl,
        scrapedAt: site.scrapedAt
      }))
    )
  };
}

function buildErrorResult(siteId, siteConfig, error) {
  return {
    provider: siteConfig.name ?? siteId,
    siteId,
    framework: siteConfig.framework ?? siteConfig.adapter ?? siteId,
    sourceUrl: siteConfig.baseUrl ? `${String(siteConfig.baseUrl).replace(/\/+$/, "")}/keys` : "",
    scrapedAt: new Date().toISOString(),
    error: error.message || String(error),
    groups: []
  };
}

async function scrapeSite(siteId, siteConfig, options = {}) {
  const adapter = adapterForSite(siteId, siteConfig);
  return await adapter(siteConfig, { siteId, ...options });
}

export async function runScrape(siteId = "all", options = {}) {
  const config = loadConfig();

  if (!config?.sites) throw new Error("没有找到 sites 配置");

  const siteIds = siteId === "all" ? Object.keys(config.sites) : [siteId];
  const results = [];
  const errors = [];
  let hadError = false;

  for (const currentSiteId of siteIds) {
    const siteConfig = config.sites[currentSiteId];
    if (!siteConfig) {
      throw new Error(`没有找到站点配置: ${currentSiteId}`);
    }

    try {
      const result = await scrapeSite(currentSiteId, siteConfig, options);
      writeJson(resultPathForSite(currentSiteId), result);
      appendJsonLine(resolveFromRoot("data/history.jsonl"), result);
      results.push(result);
      console.log(`已采集 ${result.provider}: ${result.groups.length} 个分组`);
    } catch (error) {
      hadError = true;
      const result = buildErrorResult(currentSiteId, siteConfig, error);
      writeJson(resultPathForSite(currentSiteId), result);
      results.push(result);
      errors.push({ siteId: currentSiteId, provider: result.provider, error: result.error });
      console.error(`${result.provider} 采集失败: ${result.error}`);
    }
  }

  const latestPath = resolveFromRoot("data/latest.json");

  if (siteId === "all") {
    writeJson(latestPath, buildAggregate(results));
  } else {
    const prev = readJsonIfExists(latestPath);
    const prevSites = Array.isArray(prev?.sites) ? prev.sites : [];
    const mergedSites = [...prevSites.filter(s => s.siteId !== siteId), results[0]];
    writeJson(latestPath, buildAggregate(mergedSites));
  }

  console.log(`最新数据: ${latestPath}`);
  console.log(`站点数据: ${resolveFromRoot("data/sites")}`);
  console.log(`历史记录: ${resolveFromRoot("data/history.jsonl")}`);

  const latest = readJsonIfExists(latestPath);
  return { hadError, errors, result: latest };
}

// CLI 入口
if (process.argv[1] && resolveFromRoot(process.argv[1]) === import.meta.filename) {
  const siteId = getArg("site", "all");
  try {
    const { hadError } = await runScrape(siteId);
    if (hadError) process.exitCode = 1;
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
