import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { registerBrandRoutes, BRAND_LINKS } from '../src/brand-routes.mjs';

test('favicon discovery serves the same transparent marks as MCP metadata', async () => {
 const app=express();registerBrandRoutes(app);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try {
  for(const [route,file,type] of [['/favicon.svg','mark-20260905-transparent.svg','image/svg+xml'],['/favicon.png','mark-light-20260905-transparent.png','image/png'],['/favicon.ico','favicon.ico','image/x-icon'],['/apple-touch-icon.png','mark-light-20260905-transparent.png','image/png']]) {
   const res=await fetch(`http://127.0.0.1:${server.address().port}${route}`);
   assert.equal(res.status,200);assert.ok(res.headers.get('content-type').startsWith(type));
   assert.match(res.headers.get('cache-control'),/must-revalidate/);
   assert.deepEqual(Buffer.from(await res.arrayBuffer()),await readFile(new URL(`../assets/brand/${file}`,import.meta.url)));
  }
  assert.match(BRAND_LINKS,/prefers-color-scheme: dark/);
 } finally { await new Promise(resolve=>server.close(resolve)) }
});
