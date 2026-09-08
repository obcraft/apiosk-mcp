import { fileURLToPath } from "node:url";

export const BRAND_LINKS = `<link rel="icon" href="/favicon.ico?v=20260908" sizes="any" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=20260908" />
<link rel="icon" type="image/png" sizes="512x512" href="/brand/mark-light-20260905-transparent.png" media="(prefers-color-scheme: light)" />
<link rel="icon" type="image/png" sizes="512x512" href="/brand/mark-dark-20260905-transparent.png" media="(prefers-color-scheme: dark)" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=20260908" />`;

export function registerBrandRoutes(app) {
  for (const [path, filename, type] of [
    ["/favicon.ico", "favicon.ico", "image/x-icon"],
    ["/favicon.svg", "mark-20260905-transparent.svg", "image/svg+xml"],
    ["/favicon.png", "mark-light-20260905-transparent.png", "image/png"],
    ["/apple-touch-icon.png", "mark-light-20260905-transparent.png", "image/png"],
  ]) {
    app.get(path, (_req, res) => {
      res.setHeader("cache-control", "public, max-age=0, must-revalidate");
      res.type(type).sendFile(fileURLToPath(new URL(`../assets/brand/${filename}`, import.meta.url)));
    });
  }
}
