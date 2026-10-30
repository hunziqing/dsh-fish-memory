import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runtime,observation,candidate,ref,track } from './runtime-helpers.ts';
import type { Episode } from '../src/domain/memory.ts';
import { startServer } from '../src/server.ts';

test('aggregate evidence limits reject unreadable preference records before publishing',t=>{
  const env=runtime(t),input=observation(1,'我喜欢简洁表达。'.repeat(32));env.store.observe(env.principal,input);
  const ids=[];
  for(let i=1;i<=129;i++)ids.push(env.store.createUserEvidence(env.principal,{request_id:`span-${i}`,ref:ref(input),start:0,end:i}).id);
  const result=env.store.invokeTool(env.principal,'set_memory_preference',{contract_version:'1.0.0',request_id:'too-many-evidence',operation:'create',expected_version:0,
    value:{category:'communication_pattern',scope:{kind:'companion',id:env.store.companion},content:'喜欢简洁表达。',pattern_kind:'explicit_preference',status:'user_confirmed',
      evidence_ids:ids.slice(0,128),counterexample_evidence_ids:ids.slice(128),independent_context_ids:[],conditions:[],counterexamples_reviewed:false}});
  assert.equal(result.outcome.status,'error');if(result.outcome.status==='error')assert.equal(result.outcome.error.code,'BUDGET_EXCEEDED');
  assert.equal(env.store.status().memories,0);
  assert.equal(env.store.invokeTool(env.principal,'recall_context',{contract_version:'1.0.0',conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,query:'你好',recent_context:[],time_range:null,max_items:6,max_chars:2000}).outcome.status,'ok');
});
test('ordinary corrections and automatic candidates cannot bypass dedicated withdrawal',t=>{
  const env=runtime(t),input=observation(1);env.store.observe(env.principal,input);const lease=env.store.jobs.claim()!;
  env.store.saveCandidate(lease,candidate(env.store,lease,input));const id=env.store.commitCandidate(lease).created[0]!.memory_id;
  const memory=env.store.readMemory(env.principal,id) as Episode;
  const result=env.store.invokeTool(env.principal,'correct_memory',{contract_version:'1.0.0',request_id:'wrong-withdrawal',correction_kind:'fact',reason:'撤回必须走专用工具',
    targets:[{memory_id:id,expected_version:1,suppression_generation:0}],mutations:[{operation:'revise',memory_id:id,record:{...memory,version:2,suppression_generation:1,content_status:'retracted'}}],links:[],evidence_ids:memory.evidence_ids});
  assert.equal(result.outcome.status,'error');assert.equal(env.store.readMemory(env.principal,id).version,1);
  const nextInput=observation(2);env.store.observe(env.principal,nextInput);const next=env.store.jobs.claim()!;
  const patch=candidate(env.store,next,nextInput,memory,[input]);patch.mutations[0]!.record.content_status='retracted';patch.mutations[0]!.record.suppression_generation=1;
  assert.throws(()=>env.store.saveCandidate(next,patch),/Automatic candidates/);
});
test('fresh host evidence can create a preference before any model-produced memory exists',t=>{
  const env=runtime(t),input=observation(1,'这次我只是想说说。');env.store.observe(env.principal,input);
  const e=env.store.createUserEvidence(env.principal,{request_id:'new-evidence',ref:ref(input),start:0,end:[...input.messages[0]!.text].length});
  const result=env.store.invokeTool(env.principal,'set_memory_preference',{contract_version:'1.0.0',request_id:'fresh-need',operation:'create',expected_version:0,
    value:{category:'response_need',scope:{kind:'conversation',id:input.conversation_id},content:'本次先听用户说。',basis_kind:'user_explicit',status:'user_confirmed',evidence_ids:[e.id]}});
  assert.equal(result.outcome.status,'ok');assert.equal(env.store.status().memories,1);
});
test('equivalent instant offsets and local calendar dates select the same episode',t=>{
  const env=runtime(t),input=observation(1,'今晚八点讨论方案。');env.store.observe(env.principal,input);const lease=env.store.jobs.claim()!;
  const patch=candidate(env.store,lease,input),record=patch.mutations[0]!.record;assert.equal(record.kind,'episode');
  if(record.kind!=='episode')throw new Error('Expected episode');
  record.occurred={precision:'instant',start:'2026-10-30T20:00:00+08:00',end:null,basis:'user_explicit',evidence_ids:record.evidence_ids};
  env.store.saveCandidate(lease,patch);env.store.commitCandidate(lease);
  for(const time_range of [{precision:'instant' as const,start:'2026-10-30T12:00:00Z',end:null,basis:'user_explicit' as const,evidence_ids:record.evidence_ids},
    {precision:'day' as const,start:'2026-10-30',end:null,basis:'user_explicit' as const,evidence_ids:record.evidence_ids}]) {
    const result=env.store.invokeTool(env.principal,'recall_context',{contract_version:'1.0.0',conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,query:'讨论方案',recent_context:[],time_range,max_items:6,max_chars:6000});
    assert.equal(result.outcome.status,'ok');if(result.outcome.status==='ok' && 'items' in result.outcome.data)assert.equal(result.outcome.data.items.length,1);
  }
});
test('unavailable tool-list subscriptions cannot keep the service alive during shutdown',{timeout:15000},async t=>{
  const env=runtime(t);env.store.config.server.port=0;env.store.config.server.request_timeout_ms=60000;
  const service=await startServer(env.store);track(t,()=>service.close());
  const client=new Client({name:'listen-probe',version:'1.0.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});track(t,()=>client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.metadata.port}/mcp`),{requestInit:{headers:{authorization:`Bearer ${env.credential.token}`}}}));
  assert.equal(client.getServerCapabilities()?.tools?.listChanged,false);
  const subscription=await client.listen({toolsListChanged:true},{timeout:3000});
  const closed=await Promise.race([subscription.closed,new Promise<string>(resolve=>{const timeout=setTimeout(()=>resolve('timeout'),3000);timeout.unref();})]);
  assert.notEqual(closed,'timeout');await service.close();
});
