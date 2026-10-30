import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,observation,track } from './runtime-helpers.ts';
import { FakeProvider,simpleProposal } from './extraction-helpers.ts';
import { ModelProposalSchema,type ExtractionSnapshot } from '../src/adapters/deepseek/proposal.ts';
import { normalizeProposal } from '../src/adapters/deepseek/normalize.ts';
import { ExtractionWorker } from '../src/workers/extraction-worker.ts';
import type { Episode,Memory } from '../src/domain/memory.ts';

const unknown={precision:'unknown' as const,start:null,end:null,basis:'unknown' as const,evidence_indices:[]};
function proposal(snapshot:ExtractionSnapshot) {
  const value=ModelProposalSchema.parse(simpleProposal(snapshot));if(value.action!=='patch')throw new Error('patch required');return value;
}
function interpretation(snapshot:ExtractionSnapshot,kind:'emotion'|'intent'|'response_need',label:string,inferred=false) {
  const user=snapshot.sources.filter(source=>source.role==='user'&&!source.suppressed).at(-1)!;
  return {local_id:`${kind}-${user.ref.sequence}`,kind,label,basis_kind:inferred?'context_inferred' as const:'user_explicit' as const,
    status:inferred?'tentative' as const:'user_confirmed' as const,felt_time:unknown,expressed_source_id:user.id,
    evidence_indices:[snapshot.sources.filter(source=>source.role==='user'&&!source.suppressed).length-1],
    temporal_update:'as_expressed' as 'as_expressed'|'retrospective',retrospective_evidence_indices:[] as number[],replaces_id:null as string|null};
}
function recall(env:ReturnType<typeof runtime>,query:string,conversation='conversation-test'):Memory[] {
  const output=env.store.invokeTool(env.principal,'recall_context',{contract_version:'1.0.0',conversation_id:conversation,branch_id:'main',chain_revision:1,
    query,recent_context:[],time_range:null,max_items:6,max_chars:6000});
  assert.equal(output.outcome.status,'ok');if(output.outcome.status!=='ok'||!('items' in output.outcome.data))throw new Error('recall required');
  return output.outcome.data.items.map(item=>item.memory);
}
test('gradual venting adds scoped understanding without retroactively confirming the opening or creating a permanent preference',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{
    const value=proposal(snapshot),seq=snapshot.watermark.sequence;
    value.episodes[0]!.interpretations=seq===1?[]:seq===2?[interpretation(snapshot,'emotion','可能疲惫',true)]:
      seq===3?[interpretation(snapshot,'emotion','努力未被认可的委屈')]:[interpretation(snapshot,'intent','本次倾诉'),interpretation(snapshot,'response_need','本次先听我说，不急着建议')];
    return {proposal:value,usage:null};
  });
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  for(const [i,text] of ['今天又加班了','方案已经改第三遍','怎么做都没人认可，我很委屈','关于加班这次我只是想说说'].entries()) {
    env.store.observe(env.principal,observation(i+1,text));assert.equal((await worker.runOnce()).status,'processed');
  }
  const snapshot=provider.calls.at(-1)!,id=snapshot.memories.find(memory=>memory.kind==='episode')!.id,memory=env.store.readMemory(env.principal,id) as Episode;
  assert.equal(memory.version,4);assert.equal(memory.interpretations[0]!.status,'tentative');
  assert.equal(memory.interpretations[0]!.expressed_at!.sequence,2);assert.equal(memory.interpretations[1]!.expressed_at!.sequence,3);
  assert.equal(env.store.status().memories,2);const items=recall(env,'加班');assert.equal(items[0]!.kind,'response_need');
  assert.ok(!items.some(memory=>memory.kind==='communication_pattern'));
  assert.ok(!recall(env,'周末去哪里旅行').some(memory=>memory.kind==='response_need'));
  env.advance(13*3600_000);assert.ok(!recall(env,'加班').some(memory=>memory.kind==='response_need'));
});
test('historical fear and present relief retain different times and unmarked backdating is rejected',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{
    const value=proposal(snapshot),past=interpretation(snapshot,'emotion','去年害怕'),present=interpretation(snapshot,'emotion','现在不再害怕');
    past.local_id='past';past.felt_time={precision:'year',start:'2025',end:null,basis:'user_explicit',evidence_indices:[0]} as never;
    past.temporal_update='retrospective';past.retrospective_evidence_indices=[0];present.local_id='now';
    value.episodes[0]!.interpretations=[past,present];return {proposal:value,usage:null};
  });
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());env.store.observe(env.principal,observation(1,'去年我很怕面试，现在已经不怕了。'));
  assert.equal((await worker.runOnce()).status,'processed');const result=recall(env,'面试').find(memory=>memory.kind==='episode') as Episode;
  assert.equal(result.interpretations.length,2);assert.equal(result.interpretations[0]!.felt_time.start,'2025');assert.equal(result.interpretations[1]!.felt_time.precision,'unknown');
  const bad=proposal(provider.calls[0]!);bad.episodes[0]!.interpretations=[{...interpretation(provider.calls[0]!,'emotion','害怕'),felt_time:{precision:'year',start:'2025',end:null,basis:'user_explicit',evidence_indices:[0]}}];
  const patch=normalizeProposal(bad,provider.calls[0]!);assert.ok(patch); // Persisted candidate validation enforces the temporal boundary, not schema parsing alone.
  env.store.observe(env.principal,observation(2,'再说说面试。'));const lease=env.store.jobs.claimExtraction()!,snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const next=proposal(snapshot);next.episodes[0]!.interpretations=bad.episodes[0]!.interpretations.map(item=>({...item,evidence_indices:[1],expressed_source_id:snapshot.sources.filter(source=>source.role==='user').at(-1)!.id}));
  assert.throws(()=>env.store.saveCandidate(lease,normalizeProposal(next,snapshot)),/retrospective|Backdated|expressed/i);
});
test('explicit corrections keep a valid history chain and inferred replacements cannot downgrade confirmed understanding',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{
    const value=proposal(snapshot),old=snapshot.memories.find(memory=>memory.kind==='episode') as Episode|undefined;
    const current=old?.interpretations.find(item=>item.status!=='corrected'),next=interpretation(snapshot,'emotion',snapshot.watermark.sequence===1?'可能伤心':snapshot.watermark.sequence===2?'其实只是累':'也不是累，只是困',snapshot.watermark.sequence===1);
    next.replaces_id=current?.id??null;value.episodes[0]!.interpretations=[next];return {proposal:value,usage:null};
  });
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());
  for(const [i,text] of ['今天不太想说话','不是伤心，我只是累','也不是累，我只是困了'].entries()) {env.store.observe(env.principal,observation(i+1,text));assert.equal((await worker.runOnce()).status,'processed');}
  const memory=recall(env,'不太想说话').find(memory=>memory.kind==='episode') as Episode;assert.equal(memory.interpretations.length,1);assert.equal(memory.interpretations[0]!.label,'也不是累，只是困');
  const id=memory.id,stored=env.store.readMemory(env.principal,id) as Episode;assert.equal(stored.interpretations.length,3);assert.ok(stored.interpretations.slice(0,2).every(item=>item.superseded_by===stored.interpretations[2]!.id));
  env.store.observe(env.principal,observation(4,'我想聊聊这件事。'));const lease=env.store.jobs.claimExtraction()!,snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const bad=proposal(snapshot),next=interpretation(snapshot,'emotion','还是难过',true);next.replaces_id=stored.interpretations[2]!.id;bad.episodes[0]!.interpretations=[next];
  assert.throws(()=>normalizeProposal(bad,snapshot),/user-confirmed/);assert.equal((snapshot.memories.find(item=>item.id===id) as Episode).interpretations[2]!.status,'user_confirmed');
});
test('a local need is revised in place when the user later asks for advice and does not cross conversations',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{const value=proposal(snapshot),old=snapshot.memories.find(memory=>memory.kind==='episode') as Episode|undefined,
    next=interpretation(snapshot,'response_need',snapshot.watermark.sequence===1?'加班这件事先倾听':'加班这件事现在需要建议');
    next.replaces_id=old?.interpretations.find(item=>item.kind==='response_need'&&item.status!=='corrected')?.id??null;
    value.episodes[0]!.interpretations=[next];return {proposal:value,usage:null};});
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());env.store.observe(env.principal,observation(1,'加班这件事这次只想说说。'));assert.equal((await worker.runOnce()).status,'processed');
  const before=recall(env,'加班').find(memory=>memory.kind==='response_need')!;env.store.observe(env.principal,observation(2,'加班这件事现在可以给我建议。'));
  assert.equal((await worker.runOnce()).status,'processed');
  const after=recall(env,'加班').find(memory=>memory.kind==='response_need')!;assert.equal(after.id,before.id);assert.equal(after.version,2);assert.equal(env.store.status().memories,2);
  const other={...observation(1,'你好'),conversation_id:'other-conversation',request_id:'other-conversation'};env.store.observe(env.principal,other);
  assert.ok(!recall(env,'加班','other-conversation').some(memory=>memory.kind==='response_need'));
  provider.respond=async snapshot=>{const value=proposal(snapshot);value.episodes[0]!.topic_status='closed';return {proposal:value,usage:null};};
  // The other conversation has earlier queued work; keep this assertion scoped to the current processing branch.
  env.store.observe(env.principal,observation(3,'加班这件事已经解决，先不聊了。'));await worker.runOnce();await worker.runOnce();
  assert.ok(!recall(env,'加班').some(memory=>memory.kind==='response_need'));
});
