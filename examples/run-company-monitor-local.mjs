#!/usr/bin/env node
// Live, resumable acceptance driver. Uses the production MCP child process.
// Never approves a price, sends email, invents receipts, or creates a schedule.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function advance({ call, state, save, receipt, emit = () => {} }) {
  const invoke = async (name, args) => {
    emit({ tool: name, phase: 'calling' });
    const r = await call(name, args);
    if (r.isError) {
      const e = new Error(r.structuredContent?.error_code || 'mcp_tool_failed');
      e.code = r.structuredContent?.error_code || 'mcp_tool_failed'; throw e;
    }
    assert.ok(r.structuredContent && typeof r.structuredContent === 'object', 'MCP structured response missing');
    return r.structuredContent;
  };
  const scope = { check_id: state.check_id, occurrence: state.occurrence };
  const blocked = async reason => {
    state.outcome = { accepted: false, reason, schedule_verified: false };
    await save(state); return state.outcome;
  };
  // IDs and immutable companies are saved BEFORE the first potentially paid call.
  await save(state);
  if (!state.report) {
    if (!state.started) {
      const start = await invoke('apiosk_company_check', { ...scope, companies: state.companies });
      state.started = true;
      state.task_ref = start.state?.state_ref || null;
      await save(state);
      if (start.view === 'company_check') state.report = start;
    }
    if (!state.report) {
      const report = await invoke('apiosk_company_check_result', scope);
      if (report.view !== 'company_check') {
        state.task_ref ||= report.state?.state_ref || null;
        if (report.view === 'company_check_pending' && !state.task_ref) state.started = false;
        state.approval_url = report.proposal?.approval_url || null;
        return blocked(report.status || 'report_pending');
      }
      state.report = report;
    }
    await save(state);
  }
  const report = state.report;
  assert.equal(report.check_id, state.check_id);
  assert.equal(report.occurrence, state.occurrence);
  assert.deepEqual(report.companies, state.companies);
  const coverage = report.coverage || [];
  const complete = state.companies.every(c => ['registry','sanctions','news'].every(category =>
    coverage.some(row => row.kvk_number === c.kvk_number && row.category === category && row.status === 'checked')));
  if (!complete || report.status !== 'completed') return blocked('incomplete_source_coverage');
  // Prove evidence can be reopened through MCP, not just that counts were returned.
  assert.ok(report.sources?.length, 'No saved source evidence');
  for (const source of report.sources) {
    const evidence = await invoke('apiosk_company_check_read', { ...scope, result_ref: source.result_ref });
    assert.equal(evidence.view, 'company_check_evidence');
    assert.equal(evidence.source?.result_ref, source.result_ref);
    assert.ok(evidence.source?.document?.data, 'Saved source data missing');
  }
  state.evidence_verified = true;
  if (!state.delivery_id) { state.delivery_id = randomUUID(); await save(state); }
  if (!state.delivery) {
    // A lost prepare reply never grants another dispatch. Persist the checkpoint.
    state.delivery_attempted = true; await save(state);
    state.delivery = await invoke('apiosk_company_check_email', { ...scope, delivery_id: state.delivery_id });
    await save(state);
  }
  if (state.delivery.status === 'suppressed') return blocked('no_new_signals_to_test_email');
  assert.equal(state.delivery.delivery_id, state.delivery_id, 'Another pending delivery requires reconciliation');
  if (!receipt) return blocked(state.delivery.dispatch_allowed ? 'host_email_receipt_required' : 'reconcile_existing_delivery');
  assert.equal(receipt.delivery_id, state.delivery_id, 'Receipt must identify the exact saved delivery');
  assert.equal(receipt.recipient, state.recipient, 'Receipt must identify the intended recipient');
  assert.equal(receipt.sent, true, 'A draft or pending mail is not a successful send receipt');
  assert.ok(typeof receipt.provider === 'string' && receipt.provider.trim());
  assert.ok(typeof receipt.provider_message_id === 'string' && receipt.provider_message_id.trim());
  const confirmed = await invoke('apiosk_company_check_acknowledge', {
    check_id: state.check_id, delivery_id: state.delivery_id,
    provider: receipt.provider, provider_message_id: receipt.provider_message_id,
  });
  assert.equal(confirmed.status, 'sent');
  const reopened = await invoke('apiosk_company_check_result', scope);
  const delivered = new Set(state.delivery.payload.signal_ids);
  assert.ok(reopened.new_signals.every(s => !delivered.has(s.signal_id)), 'Delivered signals reappeared');
  const replay = await invoke('apiosk_company_check_email', { ...scope, delivery_id: state.delivery_id });
  assert.equal(replay.dispatch_allowed, false, 'Delivery replay permits a duplicate email');
  assert.equal(replay.status, 'sent');
  if (reopened.new_signals.length) return blocked('additional_new_signals_remain');
  const suppressed = await invoke('apiosk_company_check_email', { ...scope, delivery_id: randomUUID() });
  assert.equal(suppressed.status, 'suppressed');
  assert.equal(suppressed.dispatch_allowed, false);
  state.outcome = { accepted: true, scope: 'source_evidence_host_receipt_and_saved_report_replay',
    evidence_verified: true, receipt: 'host_attested', duplicate_email_suppressed: true,
    fresh_weekly_run_verified: false, schedule_verified: false };
  await save(state); return state.outcome;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node examples/run-company-monitor-local.mjs --config <json> --state <private-json> [--receipt <successful-host-receipt-json>]\nUses APIOSK_CONNECT_TOKEN from the environment and loopback Gateway. Re-run the SAME state file to resume. Exit 2 means blocked, not passed. The driver never approves spending or sends mail.'); return;
  }
  const options = {};
  for (let i=0; i<args.length; i+=2) {
    assert.ok(['--config','--state','--receipt'].includes(args[i]) && args[i+1], 'Use --help');
    assert.ok(!options[args[i]], 'Duplicate option'); options[args[i]] = args[i+1];
  }
  assert.ok(options['--state'], '--state is required so retries retain their identity');
  const statePath = path.resolve(options['--state']);
  let state;
  try { state = JSON.parse(await fs.readFile(statePath,'utf8')); }
  catch(e) { if(e.code !== 'ENOENT') throw e; }
  if (!state) {
    assert.ok(options['--config'], '--config is required on first use');
    const config = JSON.parse(await fs.readFile(options['--config'],'utf8'));
    assert.ok(config.recipient && config.companies?.length, 'Config needs companies and recipient');
    state = { version:1, check_id:randomUUID(), occurrence:`local-${new Date().toISOString().replace(/[^A-Za-z0-9_.:-]/g,'')}`,
      companies:config.companies, recipient:config.recipient };
  }
  const save = async value => {
    await fs.mkdir(path.dirname(statePath),{recursive:true,mode:0o700});
    const temp = `${statePath}.tmp`;
    await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
    await fs.rename(temp,statePath); await fs.chmod(statePath,0o600);
  };
  const gateway = new URL(process.env.APIOSK_GATEWAY_V2_URL || 'http://127.0.0.1:8082');
  assert.ok(gateway.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(gateway.hostname)
    && gateway.pathname === '/' && !gateway.username && !gateway.password && !gateway.search && !gateway.hash, 'Local Gateway origin required');
  await save(state);
  if (!process.env.APIOSK_CONNECT_TOKEN) {
    console.log(JSON.stringify({accepted:false,reason:'local_mcp_token_missing',state_file:statePath}));
    process.exitCode=2; return;
  }
  const client = new Client({name:'apiosk-company-monitor-acceptance',version:'1.0.0'});
  const transport = new StdioClientTransport({command:process.execPath,args:['index.mjs'],
    cwd:fileURLToPath(new URL('../',import.meta.url)),stderr:'pipe',env:{PATH:process.env.PATH,
      APIOSK_GATEWAY_V2_URL:gateway.href,APIOSK_CONNECT_TOKEN:process.env.APIOSK_CONNECT_TOKEN}});
  transport.stderr?.on('data',()=>{});
  try {
    await client.connect(transport);
    const receipt = options['--receipt'] ? JSON.parse(await fs.readFile(options['--receipt'],'utf8')) : null;
    const outcome = await advance({state,save,receipt,call:(name,arguments_)=>client.callTool({name,arguments:arguments_}),
      emit:entry=>console.log(JSON.stringify(entry))});
    console.log(JSON.stringify({...outcome,state_file:statePath}));
    if(!outcome.accepted)process.exitCode=2;
  } catch(e) {
    console.log(JSON.stringify({accepted:false,reason:e.code || 'acceptance_assertion_failed',state_file:statePath}));
    process.exitCode=2;
  } finally { await client.close(); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(()=>{ console.error('Acceptance stopped. Check arguments with --help; no credentials are printed.');process.exitCode=2; });
}
