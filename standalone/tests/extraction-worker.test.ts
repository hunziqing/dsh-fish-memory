import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { runtime,observation,track } from './runtime-helpers.ts';
import { FakeProvider,simpleProposal } from './extraction-helpers.ts';
import { ExtractionWorker } from '../src/workers/extraction-worker.ts';
import { normalizeProposal } from '../src/adapters/deepseek/normalize.ts';
import { RuntimeError } from '../src/runtime/errors.ts';
import type { Episode } from '../src/domain/memory.ts';
import { startServer } from '../src/server.ts';

test('sequential conversation revises the same episode with immutable original messages',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  for(const [i,text] of ['今天又加班了。','方案改第三遍了。','怎么做都没人认可。','我只是想说说。'].entries()) {
    env.store.observe(env.principal,observation(i+1,text));assert.equal((await worker.runOnce()).status,'processed');env.advance(1000);
  }
  assert.equal(env.store.status().memories,1);assert.equal(provider.calls.length,4);assert.equal(env.store.status().messages,8);
  const last=provider.calls.at(-1)!,id=last.memories[0]!.id,memory=env.store.readMemory(env.principal,id) as Episode;
  assert.equal(memory.version,4);assert.match(memory.summary,/只是想说说/);assert.equal(memory.occurred.precision,'unknown');assert.equal(memory.interpretations.length,0);
  assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,4);
});
test('adjacent accepted turns coalesce into one call and only covered jobs advance the watermark',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  for(let i=1;i<=4;i++)env.store.observe(env.principal,observation(i));
  assert.equal((await worker.runOnce()).status,'processed');assert.equal(provider.calls.length,1);
  assert.deepEqual(provider.calls[0]!.sources.filter(source=>source.role==='user').map(source=>source.ref.sequence),[1,2,3,4]);
  assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,4);
  assert.equal((await worker.runOnce()).status,'idle');
  const duplicate=env.store.observe(env.principal,{...observation(4),request_id:'new-receipt'});assert.equal(duplicate.value.processing_status,'processed');
});
test('a memory epoch prevents late create proposals from bypassing an intervening user correction',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  const first=observation(1);env.store.observe(env.principal,first);await worker.runOnce();env.store.observe(env.principal,observation(2));
  const lease=env.store.jobs.claimExtraction()!,snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value)),memory=snapshot.memories[0] as Episode;
  const proposal=simpleProposal(snapshot);proposal.episodes[0]!.memory_id=null;
  const patch=normalizeProposal(proposal,snapshot)!;assert.equal(patch.targets.length,0);
  const result=env.store.invokeTool(env.principal,'correct_memory',{contract_version:'1.0.0',request_id:'human-correction',correction_kind:'fact',targets:[{memory_id:memory.id,expected_version:1,suppression_generation:0}],
    mutations:[{operation:'revise',memory_id:memory.id,record:{...memory,version:2,summary:'用户明确修正后的理解。'}}],links:[],evidence_ids:memory.evidence_ids,reason:'用户明确纠正。'});
  assert.equal(result.outcome.status,'ok');assert.throws(()=>env.store.saveCandidate(lease,patch),error=>error instanceof RuntimeError && error.code==='VERSION_CONFLICT');assert.equal(env.store.status().memories,1);
});
test('malformed proposals are retried finitely and explicit retry gets a new durable job identity',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(async()=>({proposal:{bad:'shape'},usage:null})),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  const receipt=env.store.observe(env.principal,observation(1));
  for(let i=0;i<3;i++) {await worker.runOnce();env.advance(100000);}
  assert.equal(provider.calls.length,3);assert.equal(env.store.status().memories,0);assert.equal((await worker.runOnce()).status,'idle');
  const prior=receipt.value.job_ids[0]!,retry=env.store.retryFailedJob(env.principal,{request_id:'manual-retry',job_id:prior});assert.notEqual(retry.job_id,prior);
  assert.deepEqual(env.store.retryFailedJob(env.principal,{request_id:'manual-retry',job_id:prior}),retry);
  provider.respond=async()=>({proposal:{action:'none',reason:'重新检查，无新记忆。'},usage:{prompt_tokens:10,completion_tokens:10}});
  await worker.runOnce();assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,1);
  assert.deepEqual(env.store.observe(env.principal,observation(1)).value,receipt.value);
});
test('daily budgets defer uncalled work without consuming attempts and resume on the next UTC day',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;env.store.config.deepseek.daily_calls=1;
  const provider=new FakeProvider(async()=>({proposal:{action:'none',reason:'无新经历。'},usage:null})),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  env.store.observe(env.principal,observation(1));await worker.runOnce();env.store.observe(env.principal,observation(2));assert.equal((await worker.runOnce()).status,'budget_wait');assert.equal(provider.calls.length,1);
  const db=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});try {assert.equal(db.prepare("SELECT attempts FROM jobs WHERE status='retry_wait'").get()!.attempts,0);} finally {db.close();}
  env.advance(13*60*60*1000);assert.equal((await worker.runOnce()).status,'processed');assert.equal(provider.calls.length,2);
});
test('expired workers cannot publish and oversized original turns remain durable without a model call',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;let release:()=>void=()=>{};
  const provider=new FakeProvider(async snapshot=>{await new Promise<void>(resolve=>{release=resolve;});return {proposal:simpleProposal(snapshot),usage:null};});
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());env.store.observe(env.principal,observation(1));const pending=worker.runOnce();
  while(provider.calls.length===0)await new Promise(resolve=>setTimeout(resolve,1));env.advance(31000);env.store.jobs.recover();release();await pending;assert.equal(env.store.status().memories,0);
  provider.respond=async snapshot=>({proposal:simpleProposal(snapshot),usage:null});await worker.runOnce();assert.equal(env.store.status().memories,1);
  env.store.config.deepseek.max_input_bytes=8192;env.store.observe(env.principal,observation(2,'长'.repeat(12000)));const before=provider.calls.length;
  assert.equal((await worker.runOnce()).status,'failed');assert.equal(provider.calls.length,before);assert.equal(env.store.status().messages,4);
});
test('enabled service consumes jobs through an injected provider and closes its worker cleanly',async t=>{
  const env=runtime(t);env.store.config.server.port=0;env.store.config.deepseek.enabled=true;env.store.config.deepseek.poll_interval_ms=100;
  const provider=new FakeProvider(),service=await startServer(env.store,{extractionProvider:provider});track(t,()=>service.close());
  env.store.observe(env.principal,observation(1));const deadline=Date.now()+5000;
  while(env.store.status().memories===0 && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(env.store.status().memories,1);assert.equal(env.store.status().model_worker_enabled,true);await service.close();
});
