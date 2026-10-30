import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,observation,track } from './runtime-helpers.ts';
import { FakeProvider } from './extraction-helpers.ts';
import { ModelProposalSchema,type ExtractionSnapshot } from '../src/adapters/deepseek/proposal.ts';
import { normalizeProposal } from '../src/adapters/deepseek/normalize.ts';
import { ExtractionWorker } from '../src/workers/extraction-worker.ts';
import type { CommunicationPattern,Memory } from '../src/domain/memory.ts';

function pattern(snapshot:ExtractionSnapshot,ready=false) {
  const source=snapshot.sources.filter(source=>source.role==='user'&&!source.suppressed).at(-1)!,old=snapshot.memories.find(memory=>memory.kind==='communication_pattern');
  const value=ModelProposalSchema.parse({action:'patch',reason:'有条件地记录交流方式。',episodes:[],links:[],patterns:[{local_id:'pattern',memory_id:old?.id??null,
    pattern_kind:'observed_pattern',content:'难过的语境中，没事有时表示暂不想展开。',conditions:['难过'],counterexamples_reviewed:ready,
    evidence:[{source_id:source.id,quote:source.text,start:0,end:[...source.text].length}],existing_evidence_ids:[],counterexample_evidence_ids:[],
    status:ready?'supported':'tentative',publication_status:ready?'published':'staged',content_status:'active'}]});
  if(value.action!=='patch')throw new Error('Expected patch');return value;
}
function recalled(env:ReturnType<typeof runtime>,conversation:string,query:string):Memory[] {
  const output=env.store.invokeTool(env.principal,'recall_context',{contract_version:'1.0.0',conversation_id:conversation,branch_id:'main',chain_revision:1,
    query,recent_context:[],time_range:null,max_items:6,max_chars:6000});assert.equal(output.outcome.status,'ok');
  if(output.outcome.status!=='ok'||!('items' in output.outcome.data))throw new Error('Expected recall');return output.outcome.data.items.map(item=>item.memory);
}
test('observed habits need independent conversations and retain conditions and counterexamples without claiming user confirmation',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{const value=pattern(snapshot,snapshot.watermark.conversation_id!=='context-one');
    if(snapshot.watermark.conversation_id==='context-three')value.patterns![0]!.counterexample_evidence_indices=[0];return {proposal:value,usage:null};});
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());let id='';
  for(const [i,conversation] of ['context-one','context-two','context-three','context-four'].entries()) {
    env.store.observe(env.principal,{...observation(1,i===2?'这次我说没事确实没事，今天很开心。':'我有些难过，不过没事，暂时不想展开。'),conversation_id:conversation,request_id:conversation});
    assert.equal((await worker.runOnce()).status,'processed');
    if(i===0) {assert.equal(recalled(env,conversation,'难过').length,0);continue;}
    const memory=recalled(env,conversation,'有些难过')[0] as CommunicationPattern;id||=memory.id;assert.equal(memory.id,id);assert.equal(memory.status,'supported');
    assert.equal(memory.independent_context_ids.length,i+1);if(i>=2)assert.equal(memory.counterexample_evidence_ids.length,1);
    assert.equal(recalled(env,conversation,'今天很开心').length,0);
  }
  assert.equal(env.store.status().memories,1);
});
test('a one-off wish to vent cannot be published as an explicit permanent preference',t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1,'这次只是想说说，不用建议。'));const lease=env.store.jobs.claimExtraction()!,provider=new FakeProvider(),snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const value=pattern(snapshot);Object.assign(value.patterns![0]!,{pattern_kind:'explicit_preference',status:'user_confirmed',publication_status:'published',conditions:[]});
  assert.throws(()=>normalizeProposal(value,snapshot),/one-off/);assert.equal(env.store.status().memories,0);
});
test('explicit long-term preferences can be revised using new user evidence while model-inferred downgrades are rejected',async t=>{
  const env=runtime(t);env.store.config.deepseek.enabled=true;
  const provider=new FakeProvider(async snapshot=>{const value=pattern(snapshot);Object.assign(value.patterns![0]!,{pattern_kind:'explicit_preference',status:'user_confirmed',publication_status:'published',conditions:[],content:snapshot.watermark.sequence===1?'平时先听我说':'以后可以先问我要不要建议'});return {proposal:value,usage:null};});
  const worker=new ExtractionWorker(env.store,provider);track(t,()=>worker.stop());env.store.observe(env.principal,observation(1,'请记住，平时我希望先听我说。'));assert.equal((await worker.runOnce()).status,'processed');
  const before=recalled(env,'conversation-test','你好')[0]!;env.store.observe(env.principal,observation(2,'更正，以后可以先问我要不要建议。'));assert.equal((await worker.runOnce()).status,'processed');
  const after=recalled(env,'conversation-test','你好')[0] as CommunicationPattern;assert.equal(after.id,before.id);assert.equal(after.version,2);assert.equal(env.store.status().memories,1);
  env.store.observe(env.principal,observation(3,'今天换个话题'));const lease=env.store.jobs.claimExtraction()!,snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const bad=pattern(snapshot,true);assert.throws(()=>normalizeProposal(bad,snapshot),/confirmed preference/);
});
test('repeating several turns of the same conversation does not meet the independent-context gate',t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1,'难过时有时说没事'));env.store.observe(env.principal,observation(2,'还是有点难过，不过没事'));
  const lease=env.store.jobs.claimExtraction()!,provider=new FakeProvider(),snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const patch=normalizeProposal(pattern(snapshot,true),snapshot);assert.throws(()=>env.store.saveCandidate(lease,patch),/independent contexts/);
  assert.throws(()=>ModelProposalSchema.parse({action:'patch',reason:'空变化',episodes:[],patterns:[],links:[]}),/at least one/);
});
