// The MCP transports, seen from a browser.
//
// A host that calls /mcp from a page (ChatGPT's connector sheet does) gets
// nothing at all unless the preflight is answered, and cannot read the 401
// challenge unless WWW-Authenticate is exposed. Both were missing while the
// OAuth endpoints next to them had CORS from the SDK, so the failure looked
// like "cannot connect" rather than "sign in".

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerMcpTransportCors } from '../src/transport-cors.mjs';
import { TRANSPORT_RESOURCE_PATHS } from '../src/oauth.mjs';

test('every transport surface answers a cross-origin preflight and exposes the auth challenge', async () => {
 const app=express();registerMcpTransportCors(app);
 app.post('/mcp',(_req,res)=>{res.setHeader('WWW-Authenticate','Bearer error="invalid_token"');res.status(401).json({error:'invalid_token'})});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const origin='https://chatgpt.com';
 try {
  for(const path of TRANSPORT_RESOURCE_PATHS) {
   const preflight=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type,authorization'}});
   assert.equal(preflight.status,204,`${path} preflight`);
   assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
   assert.match(preflight.headers.get('access-control-allow-methods'),/POST/);
   assert.match(preflight.headers.get('access-control-allow-headers'),/authorization/i);
   assert.match(preflight.headers.get('access-control-expose-headers'),/WWW-Authenticate/i);
  }

  const challenge=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(challenge.status,401);
  assert.equal(challenge.headers.get('access-control-allow-origin'),'*');
  for(const header of ['WWW-Authenticate','Mcp-Session-Id','Mcp-Protocol-Version'])
   assert.match(challenge.headers.get('access-control-expose-headers'),new RegExp(header,'i'),`${header} must be readable`);
 } finally { await new Promise(resolve=>server.close(resolve)) }
});
