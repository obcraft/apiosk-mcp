// Preserve the installed connector identity; only the implementation changed.
export const SERVER_BASE_VERSION = '3.0.0';
export const SERVER_DESCRIPTION = 'Ask a data question, compare matching sources, review one total, and receive saved source-backed results.';
export const SERVER_ICONS = [
  { src: 'https://mcp.apiosk.com/brand/apiosk-a-20260921.png', mimeType: 'image/png', sizes: ['1254x1254'], theme: 'light' },
  { src: 'https://mcp.apiosk.com/brand/mark-20260918.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
  { src: 'https://mcp.apiosk.com/brand/mark-light-20260918.png', mimeType: 'image/png', sizes: ['512x512'], theme: 'light' },
  { src: 'https://mcp.apiosk.com/brand/mark-dark-20260918.png', mimeType: 'image/png', sizes: ['512x512'], theme: 'dark' },
];

export function resolveServerVersion(env = process.env) {
  const explicit = typeof env.APIOSK_MCP_VERSION === 'string' ? env.APIOSK_MCP_VERSION.trim() : '';
  if (explicit) return explicit;
  const build = String(env.FLY_MACHINE_VERSION || env.FLY_IMAGE_REF?.split('deployment-')?.[1] || '').toUpperCase().slice(0, 10);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  if (build.length !== 10 || [...build].some(character => !alphabet.includes(character))) return SERVER_BASE_VERSION;
  const milliseconds = [...build].reduce((value, character) => value * 32 + alphabet.indexOf(character), 0);
  return milliseconds ? `3.0.${Math.floor(milliseconds / 1000)}` : SERVER_BASE_VERSION;
}

export function resolveServerInfo(env = process.env) {
  return { name: 'apiosk-mcp', title: 'Apiosk', version: resolveServerVersion(env),
    description: SERVER_DESCRIPTION, websiteUrl: 'https://apiosk.com', icons: SERVER_ICONS };
}

export const SERVER_INFO = resolveServerInfo();
