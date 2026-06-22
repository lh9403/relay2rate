# relay2rate

本地中转站倍率看板。聚合多个 NewAPI / Sub2API 中转站的分组倍率与并发，支持一键刷新、自动定时刷新、搜索筛选排序，并在倍率变化时标记涨跌。

## 使用方式

1. 安装依赖：

   ```bash
   npm install
   ```

2. 复制配置：

   ```bash
   cp config.example.json config.json
   ```

3. 运行采集：

   ```bash
   npm run scrape
   ```

   也可以只刷新单个站点（`<siteId>` 为 `config.json` 里的站点 key）：

   ```bash
   node scripts/scrape.js --site <siteId>
   ```

   NewAPI/Sub2API 站点会优先使用 `config.json` 里的 `username` 和 `password` 自动登录。若站点要求 Turnstile 或 Cloudflare 验证，脚本会改为打开对应的 `browser-profile/<siteId>` 浏览器窗口，请手动登录并通过验证，登录完成后回到终端按回车继续。脚本会把 cookie 和用户 ID 保存到 `data/sessions/<siteId>.json`，后续通常不用重新登录。

4. 打开看板：

   ```bash
   npm start
   ```

   然后打开 `http://localhost:4173`。页面支持刷新全部、刷新单站、自动定时刷新、搜索、筛选和排序。

聚合结果会保存到 `data/latest.json`，单站结果会保存到 `data/sites/<siteId>.json`，历史快照会保存到 `data/history.jsonl`。

## 后续扩展

新增中转站时，只要它是 NewAPI 或 Sub2API 框架，只需在 `config.json` 的 `sites` 里加一段配置即可，无需写任何代码：

```json
"新站点": {
  "name": "显示名",
  "baseUrl": "https://example.com",
  "framework": "newapi",
  "username": "你的用户名或邮箱",
  "password": "你的密码"
}
```

`framework` 为必填项，NewAPI 站点填 `"newapi"`，Sub2API 站点填 `"sub2api"`。脚本会自动用账号密码登录、拉取分组倍率与并发，登录态缓存到 `data/sessions/<siteId>.json`，7 天内自动复用。

只有当站点接口与 NewAPI/Sub2API 都不兼容时，才需要在 `sites/` 下新增适配器，并在 `scripts/scrape.js` 的 `adapters` 里注册。适配器返回统一格式：

```json
{
  "provider": "示例站点",
  "groups": [
    {
      "name": "gpt-plus",
      "multiplier": 0.04,
      "concurrency": 25,
      "description": ""
    }
  ]
}
```
