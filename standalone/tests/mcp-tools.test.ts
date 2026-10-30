import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtime,track,observation,candidate,ref } from './runtime-helpers.ts';
import { startServer } from '../src/server.ts';
import { toolContracts, type ToolName, type ToolInput } from '../src/contracts/tools.ts';
import type { Episode } from '../src/domain/memory.ts';

test('official MCP HTTP client lists six authorized tools and executes validated reads and atomic edits',async t=>{
  const env=runtime(t);env.store.config.server.port=0;const service=await startServer(env.store);track(t,()=>service.close());
  const client=new Client({name:'test-host',version:'1.0.0'});track(t,()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.metadata.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${env.credential.token}`}}}));
  assert.equal((await client.listTools()).tools.length,6);
  async function call<N extends ToolName>(name:N,input:ToolInput<N>) {
    const result=await client.callTool({name,arguments:input});return toolContracts[name].output.parse(result.structuredContent);
  }
  const input=observation(1,'今天加班修改方案，有点累，只想说说。');assert.equal((await call('observe_turn',input)).outcome.status,'ok');
  const lease=env.store.jobs.claim()!;env.store.saveCandidate(lease,candidate(env.store,lease,input));
  const id=env.store.commitCandidate(lease).created[0]!.memory_id,memory=env.store.readMemory(env.principal,id) as Episode;
  const recalled=await call('recall_context',{contract_version:'1.0.0',conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,query:'修改方案',recent_context:[],time_range:null,max_items:6,max_chars:6000});
  assert.equal(recalled.outcome.status,'ok');if(recalled.outcome.status==='ok' && 'items' in recalled.outcome.data)assert.equal(recalled.outcome.data.items.length,1);
  const detail=await call('get_episode',{contract_version:'1.0.0',episode_id:id,include_history:true,max_chars:6000});assert.equal(detail.outcome.status,'ok');
  const edit:ToolInput<'correct_memory'>={contract_version:'1.0.0',request_id:'correction-1',correction_kind:'reinterpret',targets:[{memory_id:id,expected_version:1,suppression_generation:0}],
    mutations:[{operation:'revise',memory_id:id,record:{...memory,version:2,summary:'用户加班修改方案，本次希望被倾听。'}}],links:[],evidence_ids:memory.evidence_ids,reason:'根据用户明确陈述纠正。'};
  assert.equal((await call('correct_memory',edit)).outcome.status,'ok');assert.deepEqual(await call('correct_memory',edit),await call('correct_memory',edit));
  const conflict=await call('correct_memory',{...edit,reason:'相同请求号换了载荷。'});assert.equal(conflict.outcome.status,'error');
  const preference:ToolInput<'set_memory_preference'>={contract_version:'1.0.0',request_id:'local-need',operation:'create',expected_version:0,
    value:{category:'response_need',scope:{kind:'conversation',id:input.conversation_id},content:'本次先听用户说。',evidence_ids:memory.evidence_ids,basis_kind:'user_explicit',status:'user_confirmed'}};
  assert.equal((await call('set_memory_preference',preference)).outcome.status,'ok');
  const retraction=await call('retract_memory',{contract_version:'1.0.0',request_id:'withdraw-1',memory_id:id,expected_version:2,suppression_generation:0,reason:'用户撤回。',evidence_ids:memory.evidence_ids});
  assert.equal(retraction.outcome.status,'ok');assert.equal((await call('get_episode',{contract_version:'1.0.0',episode_id:id,include_history:false,max_chars:6000})).outcome.status,'error');
  const fresh=observation(2);env.store.observe(env.principal,fresh);const late=env.store.jobs.claim()!;
  const restore=candidate(env.store,late,input);restore.input_watermark.sequence=2;restore.input_messages.push(ref(fresh));
  assert.throws(()=>env.store.saveCandidate(late,restore),/withdrawn/);
});

test('read-only credentials expose only read tools over HTTP and stdio forwards without opening a second writer',async t=>{
  const env=runtime(t);env.store.config.server.port=0;const reader=env.store.issueCredential('read'),tokenFile=join(env.home,'mcp-read-token');writeFileSync(tokenFile,reader.token);
  const service=await startServer(env.store);track(t,()=>service.close());
  const client=new Client({name:'test-reader',version:'1.0.0'});track(t,()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.metadata.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${reader.token}`}}}));
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),['get_episode','recall_context']);
  await assert.rejects(()=>client.callTool({name:'observe_turn',arguments:observation(1)}));
  const bridge=new Client({name:'stdio-reader',version:'1.0.0'});track(t,()=>bridge.close());
  await bridge.connect(new StdioClientTransport({command:process.execPath,args:['src/cli.ts','mcp-stdio','--home',env.home,'--token-file',tokenFile],cwd:fileURLToPath(new URL('../',import.meta.url)),stderr:'pipe'}));
  assert.equal((await bridge.listTools()).tools.length,2);
  const result=await bridge.callTool({name:'recall_context',arguments:{contract_version:'1.0.0',conversation_id:'new-conversation',branch_id:'main',chain_revision:1,query:'你好',recent_context:[],time_range:null,max_items:6,max_chars:2000}});
  assert.equal((result.structuredContent as {outcome:{status:string}}).outcome.status,'ok');
  env.store.disableCredential(reader.id);await assert.rejects(()=>client.listTools());
});

test('host creates evidence only from exact persisted user spans and detail budgets never overflow',t=>{
  const env=runtime(t),input=observation(1);env.store.observe(env.principal,input);
  const evidence=env.store.createUserEvidence(env.principal,{request_id:'evidence-1',ref:ref(input),start:0,end:2});assert.equal(evidence.quote,'今天');
  assert.throws(()=>env.store.createUserEvidence(env.principal,{request_id:'bad-span',ref:ref(input),start:0,end:99999}));
  const lease=env.store.jobs.claim()!;env.store.saveCandidate(lease,candidate(env.store,lease,input));const id=env.store.commitCandidate(lease).created[0]!.memory_id;
  const result=env.store.invokeTool(env.principal,'get_episode',{contract_version:'1.0.0',episode_id:id,include_history:false,max_chars:1});
  assert.equal(result.outcome.status,'error');if(result.outcome.status==='error')assert.equal(result.outcome.error.code,'BUDGET_EXCEEDED');
});
