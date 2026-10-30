import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { runtime,observation,track } from './runtime-helpers.ts';
import { FakeProvider,simpleProposal } from './extraction-helpers.ts';
import { ExtractionWorker } from '../src/workers/extraction-worker.ts';
import { normalizeProposal } from '../src/adapters/deepseek/normalize.ts';
import { startServer } from '../src/server.ts';
import type { Episode } from '../src/domain/memory.ts';
import { RuntimeStore } from '../src/runtime/store.ts';

test('withdrawn turns and assistant echoes are redacted from subsequent model contexts',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  const input=observation(1,'我昨天去医院复查。');input.messages[1]!.text='你昨天去医院复查了。';env.store.observe(env.principal,input);await worker.runOnce();
  env.store.observe(env.principal,observation(2,'今天只是打个招呼。'));
  const lease=env.store.jobs.claimExtraction()!,before=env.store.captureExtraction(lease,value=>provider.requestBytes(value)),memory=before.memories[0]!;
  env.store.jobs.fail(lease,true,'RETRY_AFTER_WITHDRAWAL');
  const result=env.store.invokeTool(env.principal,'retract_memory',{contract_version:'1.0.0',request_id:'withdraw-private-event',memory_id:memory.id,expected_version:memory.version,suppression_generation:0,reason:'不再使用这件事。',evidence_ids:memory.evidence_ids});
  assert.equal(result.outcome.status,'ok');env.advance(3000);
  provider.respond=async snapshot=>{
    assert.equal(JSON.stringify(snapshot).includes('医院'),false);assert.equal(JSON.stringify(snapshot).includes('复查'),false);
    assert.ok(snapshot.sources.filter(source=>source.ref.sequence===1).every(source=>source.suppressed && source.text===''));
    return {proposal:{action:'none',reason:'本轮无新经历。'},usage:null};
  };
  assert.equal((await worker.runOnce()).status,'processed');
});
test('out-of-order queued turns wait for gaps and are processed in branch order',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  env.store.observe(env.principal,observation(3));assert.equal((await worker.runOnce()).status,'idle');assert.equal(provider.calls.length,0);
  env.store.observe(env.principal,observation(1));await worker.runOnce();assert.equal(provider.calls[0]!.watermark.sequence,1);
  env.store.observe(env.principal,observation(2));await worker.runOnce();assert.equal(provider.calls[1]!.first_sequence,2);assert.equal(provider.calls[1]!.watermark.sequence,3);
  assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,3);
});
test('a stale no-change decision cannot falsely advance processing after a user correction',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  env.store.observe(env.principal,observation(1));await worker.runOnce();env.store.observe(env.principal,observation(2));
  const old=provider.calls.length;let release:()=>void=()=>{};
  provider.respond=async()=>{await new Promise<void>(resolve=>{release=resolve;});return {proposal:{action:'none',reason:'无变化。'},usage:null};};
  const pending=worker.runOnce();while(provider.calls.length===old)await new Promise(resolve=>setTimeout(resolve,1));
  const memory=provider.calls.at(-1)!.memories[0] as Episode;
  const correction=env.store.invokeTool(env.principal,'correct_memory',{contract_version:'1.0.0',request_id:'correction-during-no-change',correction_kind:'fact',targets:[{memory_id:memory.id,expected_version:1,suppression_generation:0}],
    mutations:[{operation:'revise',memory_id:memory.id,record:{...memory,version:2,summary:'用户纠正后的内容。'}}],evidence_ids:memory.evidence_ids,links:[],reason:'按用户明确更正。'});
  assert.equal(correction.outcome.status,'ok');release();await pending;
  assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,1);assert.equal(env.store.readMemory(env.principal,memory.id).version,2);
});
test('editing a message while the provider is running fences the old result and recomputes the new chain',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;let release:()=>void=()=>{};
  const provider=new FakeProvider(async snapshot=>{await new Promise<void>(resolve=>{release=resolve;});return {proposal:simpleProposal(snapshot),usage:null};});
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());const input=observation(1,'今天加班。');env.store.observe(env.principal,input);
  const pending=worker.runOnce();while(!provider.calls.length)await new Promise(resolve=>setTimeout(resolve,1));
  env.store.observe(env.principal,{...input,request_id:'edit-while-running',chain_revision:2,messages:[{...input.messages[0]!,revision:2,text:'更正：今天没有加班。'},input.messages[1]!]});
  release();await pending;assert.equal(env.store.status().memories,0);
  provider.respond=async snapshot=>({proposal:simpleProposal(snapshot),usage:null});await worker.runOnce();
  const status=env.store.status();assert.equal(status.memories,1);assert.equal(status.messages,3);assert.equal((status.branches as {chain_revision:number}[])[0]!.chain_revision,2);
});
test('coalescing never advances beyond the bounded source window',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;env.store.config.deepseek.window_turns=2;
  const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  for(let i=1;i<=4;i++)env.store.observe(env.principal,observation(i));await worker.runOnce();
  assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,2);assert.equal(provider.calls[0]!.watermark.sequence,2);
  await worker.runOnce();assert.equal((env.store.status().branches as {processed_through:number}[])[0]!.processed_through,4);assert.equal(provider.calls.length,2);
});
test('proposal normalization rejects assistant evidence, UTF-16 offsets and personality fields',t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1,'🙂今天有点累'));const provider=new FakeProvider(),snapshot=env.store.captureExtraction(env.store.jobs.claimExtraction()!,value=>provider.requestBytes(value));
  const proposal=simpleProposal(snapshot),user=snapshot.sources.find(source=>source.role==='user')!,assistant=snapshot.sources.find(source=>source.role==='assistant')!;
  proposal.episodes[0]!.evidence=[{source_id:user.id,quote:'今天',start:2,end:4}];assert.throws(()=>normalizeProposal(proposal,snapshot),/code points/);
  proposal.episodes[0]!.evidence=[{source_id:assistant.id,quote:assistant.text,start:0,end:[...assistant.text].length}];assert.throws(()=>normalizeProposal(proposal,snapshot),/user evidence/);
  assert.throws(()=>normalizeProposal({...simpleProposal(snapshot),main_personality:'changed'},snapshot));assert.equal(env.store.config.companion.character.persona_reference,'unconfigured');
});
test('enabled configuration without its own key leaves tasks durable and does not start a provider',async t=>{
  const env=runtime(t);env.store.config.server.port=0;env.store.config.deepseek.enabled=true;
  env.store.config.deepseek.api_key_env=`FISH_TEST_${randomUUID().replaceAll('-','').toUpperCase()}`;
  const service=await startServer(env.store);track(t,()=>service.close());env.store.observe(env.principal,observation(1));
  assert.equal(env.store.status().model_worker_enabled,false);assert.equal((env.store.status().worker_status as {last_error:string}).last_error,'MODEL_NOT_CONFIGURED');
  assert.equal(env.store.status().memories,0);assert.equal((env.store.status().jobs as {status:string}[])[0]!.status,'queued');
});
test('edited-source records provide only rebuild identities and valid evidence, then retain their stable ID',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  const input=observation(1,'旧的错误地点是桃花岛。');env.store.observe(env.principal,input);await worker.runOnce();
  env.store.observe(env.principal,{...input,request_id:'edit-rebuild-shell',chain_revision:2,messages:[{...input.messages[0]!,revision:2,text:'正确地点是星光桥。'},input.messages[1]!]});
  const lease=env.store.jobs.claimExtraction()!,snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  assert.equal(snapshot.memories.length,1);const id=snapshot.memories[0]!.id;
  assert.equal(snapshot.memory_states[id],'needs_rebuild');assert.equal(JSON.stringify(snapshot).includes('桃花岛'),false);
  assert.equal((snapshot.memories[0] as Episode).topic_status,'paused');assert.equal((snapshot.memories[0] as Episode).last_effective_mention_at,null);
  const patch=normalizeProposal(simpleProposal(snapshot),snapshot)!;env.store.saveCandidate(lease,patch);env.store.commitCandidate(lease);
  assert.equal(env.store.status().memories,1);assert.equal((env.store.readMemory(env.principal,id) as Episode).version,2);assert.match((env.store.readMemory(env.principal,id) as Episode).summary,/星光桥/);
});
test('stopping an in-flight worker is bounded even when an injected provider ignores its abort signal',{timeout:5000},async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(()=>new Promise(()=>{})),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  env.store.observe(env.principal,observation(1));const running=worker.runOnce();while(!provider.calls.length)await new Promise(resolve=>setTimeout(resolve,1));
  await worker.stop();await running;assert.equal(env.store.status().memories,0);assert.equal(env.store.status().model_worker_enabled,false);
});
test('reserved calls survive restart as interrupted reservations without resetting the daily budget',t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;env.store.observe(env.principal,observation(1));
  const lease=env.store.jobs.claimExtraction()!,provider=new FakeProvider(),snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  env.store.reserveModelCall(lease,provider.requestBytes(snapshot));env.store.close();env.advance(31000);
  const reopened=RuntimeStore.open(env.home,{clock:env.clock});track(t,()=>reopened.close());
  const db=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});try {
    assert.equal(db.prepare('SELECT status FROM model_invocations').get()!.status,'interrupted');assert.equal(db.prepare('SELECT count(*) AS n FROM model_invocations').get()!.n,1);
    assert.equal(db.prepare('SELECT status FROM jobs').get()!.status,'queued');
  } finally {db.close();}
});
test('a multi-record split publishes atomically and retries without partial memories or links',async t=>{
  let fail=false;const env=runtime(t,{fault:point=>{if(fail&&point==='afterRevision')throw new Error('synthetic split interruption');}});
  env.store.config.deepseek.enabled=true;const provider=new FakeProvider(),worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  env.store.observe(env.principal,observation(1,'第一次面试后又参加了第二次面试。'));await worker.runOnce();env.store.observe(env.principal,observation(2,'其实这是两次不同的面试。'));
  provider.respond=async snapshot=>{
    const old=snapshot.memories[0]!,first=snapshot.sources.find(source=>source.role==='user'&&source.ref.sequence===1)!,second=snapshot.sources.find(source=>source.role==='user'&&source.ref.sequence===2)!;
    const span=(text:string)=>({source_id:first.id,quote:text,start:[...first.text.slice(0,first.text.indexOf(text))].length,end:[...first.text.slice(0,first.text.indexOf(text))].length+[...text].length});
    const base={details:'',publication_status:'published',topic_status:'closed'};
    return {proposal:{action:'patch',reason:'用户明确区分两次经历。',episodes:[
      {...base,local_id:'old',memory_id:old.id,summary:'原合并记录已被拆分。',content_status:'disputed',evidence:[{source_id:second.id,quote:second.text,start:0,end:[...second.text].length}]},
      {...base,local_id:'first',memory_id:null,summary:'用户参加第一次面试。',content_status:'active',evidence:[span('第一次面试')]},
      {...base,local_id:'second',memory_id:null,summary:'用户参加第二次面试。',content_status:'active',evidence:[span('第二次面试')]},
    ],links:[{from:'old',to:'first',relation:'correction'},{from:'old',to:'second',relation:'correction'},{from:'first',to:'second',relation:'followup'}]},usage:null};
  };
  fail=true;const failed=await worker.runOnce();assert.equal(failed.status,'failed');assert.equal(env.store.status().memories,1);
  env.store.retryFailedJob(env.principal,{request_id:'retry-atomic-split',job_id:failed.job_id});
  fail=false;assert.equal((await worker.runOnce()).status,'processed');assert.equal(env.store.status().memories,3);
  const db=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM memory_records WHERE content_status='active'").get()!.n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_links').get()!.n,3);assert.equal(db.prepare('SELECT count(*) AS n FROM message_suppressions').get()!.n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n,2);
  } finally {db.close();}
});
