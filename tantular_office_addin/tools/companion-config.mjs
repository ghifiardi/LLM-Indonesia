import fs from "node:fs";
import path from "node:path";

export const COMPANION_CONFIG_NAME = "companion.json";

// Local, explicit opt-in. data/ is gitignored, so enabling lookup on one
// developer/workshop machine never silently changes the privacy posture of a
// release or another installation.
export function companionEnvironment({
  root,
  baseEnv = process.env,
  readFile = (file) => fs.readFileSync(file, "utf8")
}) {
  const env = { ...baseEnv };
  const configPath = path.join(root, "data", COMPANION_CONFIG_NAME);
  let config = {};
  let warning = "";
  try {
    config = JSON.parse(readFile(configPath));
  } catch (error) {
    if (error?.code !== "ENOENT") warning = `config tidak terbaca: ${error.message}`;
  }

  // An explicit process environment always wins. This preserves the emergency
  // kill switch: TANTULAR_LOOKUP_ENABLED=false overrides a persisted opt-in.
  if (!Object.hasOwn(baseEnv, "TANTULAR_LOOKUP_ENABLED")
      && config?.lookup?.enabled === true) {
    env.TANTULAR_LOOKUP_ENABLED = "true";
  }
  if (!Object.hasOwn(baseEnv, "TANTULAR_LOOKUP_HOSTS")
      && Array.isArray(config?.lookup?.hosts)) {
    const hosts = config.lookup.hosts
      .map((host) => String(host || "").trim().toLowerCase())
      .filter(Boolean);
    if (hosts.length) env.TANTULAR_LOOKUP_HOSTS = [...new Set(hosts)].join(",");
  }
  if (!Object.hasOwn(baseEnv, "TANTULAR_LOOKUP_DISCOVERY_ALPHA")
      && config?.lookup?.discoveryAlpha === true) {
    env.TANTULAR_LOOKUP_DISCOVERY_ALPHA = "true";
  }
  if (!Object.hasOwn(baseEnv, "TANTULAR_SEARCH_PROVIDER")
      && config?.lookup?.provider) {
    env.TANTULAR_SEARCH_PROVIDER = String(config.lookup.provider).trim().toLowerCase();
  }
  if (!Object.hasOwn(baseEnv, "TANTULAR_SEARXNG_URL")
      && config?.lookup?.searxngUrl) {
    env.TANTULAR_SEARXNG_URL = String(config.lookup.searxngUrl).trim();
  }

  return {
    env,
    configPath,
    lookupEnabled: String(env.TANTULAR_LOOKUP_ENABLED || "").toLowerCase() === "true",
    lookupHosts: String(env.TANTULAR_LOOKUP_HOSTS || "")
      .split(",").map((host) => host.trim()).filter(Boolean),
    discoveryAlpha: String(env.TANTULAR_LOOKUP_DISCOVERY_ALPHA || "").toLowerCase() === "true",
    searchProvider: String(env.TANTULAR_SEARCH_PROVIDER || "official-federated"),
    searxngUrl: String(env.TANTULAR_SEARXNG_URL || ""),
    warning
  };
}
