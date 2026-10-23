#!/usr/bin/env node
import { startHosted } from './src/hosted.mjs';

try {
  const running = await startHosted();
  process.stderr.write(`Apiosk Ask MCP listening on ${running.config.host}:${running.config.port}\n`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await running.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
  process.stderr.write('Apiosk MCP could not start. Check the configured listener, Gateway URL and OAuth signing secret.\n');
  process.exitCode = 1;
}
