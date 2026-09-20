import { fileURLToPath } from "node:url";

export const BRAND_LINKS = `<link rel="icon" href="/favicon.ico?v=20260920-3d" sizes="16x16 32x32 48x48" media="(prefers-color-scheme: light)" />
<link rel="icon" href="/favicon-dark.ico?v=20260920-3d" sizes="16x16 32x32 48x48" media="(prefers-color-scheme: dark)" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=20260920-3d" />
<link rel="icon" type="image/png" sizes="512x512" href="/brand/mark-light-20260920-3d.png" media="(prefers-color-scheme: light)" />
<link rel="icon" type="image/png" sizes="512x512" href="/brand/mark-dark-20260920-3d.png" media="(prefers-color-scheme: dark)" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=20260920-3d" />`;

export function registerBrandRoutes(app) {
  for (const [path, filename, type] of [
    ["/favicon.ico", "favicon.ico", "image/x-icon"],
    ["/favicon-dark.ico", "favicon-dark.ico", "image/x-icon"],
    ["/favicon.svg", "mark-20260920-3d.svg", "image/svg+xml"],
    ["/favicon.png", "mark-light-20260920-3d.png", "image/png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
    // Cached clients can still request earlier metadata and card URLs.
    ["/brand/mark-20260918.svg", "mark-20260920-3d.svg", "image/svg+xml"],
    ["/brand/mark-light-20260918.png", "mark-light-20260920-3d.png", "image/png"],
    ["/brand/mark-dark-20260918.png", "mark-dark-20260920-3d.png", "image/png"],
    ["/brand/mark-20260905-transparent.svg", "mark-20260920-3d.svg", "image/svg+xml"],
    ["/brand/mark-light-20260905-transparent.png", "mark-light-20260920-3d.png", "image/png"],
    ["/brand/mark-dark-20260905-transparent.png", "mark-dark-20260920-3d.png", "image/png"],
  ]) {
    app.get(path, (_req, res) => {
      res.setHeader("cache-control", "public, max-age=0, must-revalidate");
      res.type(type).sendFile(fileURLToPath(new URL(`../assets/brand/${filename}`, import.meta.url)));
    });
  }
}
