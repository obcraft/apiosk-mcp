#!/usr/bin/env node
import { readConfig, CLI_HELP } from '../src/config.mjs';

async function main() {
  const config = readConfig();
  if (config.help) { process.stdout.write(CLI_HELP); return; }
  const [{ GatewayClient }, { StateStore, scopeKey }, { createAskService }, { startHttp, startStdio }, { withEmbeddedCards }] = await Promise.all([
    import('../src/gateway.mjs'), import('../src/store.mjs'), import('../src/service.mjs'), import('../src/server.mjs'), import('../src/card-adapter.mjs'),
  ]);
  const createService = ({ token, workspace }) => {
    const gateway = new GatewayClient({ baseUrl: config.gatewayUrl, token, workspace });
    const store = new StateStore({ directory: config.stateDir, scope: scopeKey({ gatewayUrl: config.gatewayUrl, token, workspace }) });
    return withEmbeddedCards(createAskService({ gateway, store }), { gateway, store });
  };
  let running;
  if (config.transport === 'http') {
    running = await startHttp({ createService, host: config.host, port: config.port, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins, maxBodyBytes: config.maxBodyBytes });
    process.stderr.write(`Apiosk MCP 2 listening at ${running.url}\n`);
  } else {
    if (!config.token) throw new Error('Set APIOSK_TOKEN or APIOSK_CONNECT_TOKEN before starting the stdio server.');
    running = await startStdio({ service: await createService({ token: config.token, workspace: config.workspace }) });
  }
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await running.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  // Configuration errors are local and deliberately omit credential values.
  process.stderr.write(`Apiosk MCP 2: ${error?.message || 'Unable to start.'}\n`);
  process.exitCode = 1;
});
