import fs from "node:fs";
import path from "node:path";

export const rootDir = path.resolve(new URL("..", import.meta.url).pathname);

export function resolveFromRoot(...parts) {
  return path.resolve(rootDir, ...parts);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function appendJsonLine(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`);
}

export function loadConfig() {
  const configPath = resolveFromRoot("config.json");
  return readJsonIfExists(configPath);
}

export function saveConfig(config) {
  const configPath = resolveFromRoot("config.json");
  writeJson(configPath, config);
}

export function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] ?? fallback;
  return fallback;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
