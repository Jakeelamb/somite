import { access } from "node:fs/promises";

const browserCandidates = process.platform === "darwin"
  ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

export async function systemBrowserExecutable() {
  const candidates = [process.env.SOMITE_BROWSER_PATH, ...browserCandidates].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(`No supported system Chrome/Chromium was found. Set SOMITE_BROWSER_PATH to one of: ${browserCandidates.join(", ")}`);
}
