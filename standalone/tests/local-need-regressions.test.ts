import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,observation,ref,candidate } from './runtime-helpers.ts';
import type { Evidence } from '../src/domain/memory.ts';

function read(env:ReturnType<typeof runtime>,conversation='conversation-test') {
  const result=env.store.invokeTool(env.principal,'recall_context',{contract_version:'1.0.0',conversation_id:conversation,branch_id:'main',chain_revision:1,
    query:'你好',recent_context:[],time_range:null,max_items:6,max_chars:6000});assert.equal(result.outcome.status,'ok');
  if(result.outcome.status!=='ok'||!('items' in result.outcome.data))throw new Error('Expected recall');return result.outcome.data.items;
}
test('one user evidence must satisfy both turn and time windows, and future timestamps do not activate a local need',t=>{
  const env=runtime(t),ids:string[]=[];
  for(let sequence=1;sequence<=8;sequence++) {
    const input=observation(sequence,'本次希望先听我说。');input.messages[0]!.captured_at=sequence===1?'2026-10-30T11:00:00Z':'2026-10-29T00:00:00Z';env.store.observe(env.principal,input);
    if(sequence===1||sequence===8)ids.push(env.store.createUserEvidence(env.principal,{request_id:`time-evidence-${sequence}`,ref:ref(input),start:0,end:[...input.messages[0]!.text].length}).id);
  }
  const preference=(request_id:string,evidence_ids:string[])=>({contract_version:'1.0.0' as const,request_id,operation:'create' as const,expected_version:0,
    value:{category:'response_need' as const,scope:{kind:'conversation' as const,id:'conversation-test'},content:'这次先倾听',basis_kind:'user_explicit' as const,status:'user_confirmed' as const,evidence_ids}});
  assert.equal(env.store.invokeTool(env.principal,'set_memory_preference',preference('mixed-windows',ids)).outcome.status,'ok');assert.equal(read(env).length,0);
  const future=observation(9,'这次先听我说');future.messages[0]!.captured_at='2026-10-31T12:00:00Z';env.store.observe(env.principal,future);
  const e=env.store.createUserEvidence(env.principal,{request_id:'future-evidence',ref:ref(future),start:0,end:[...future.messages[0]!.text].length});
  assert.equal(env.store.invokeTool(env.principal,'set_memory_preference',preference('future-window',[e.id])).outcome.status,'ok');assert.equal(read(env).length,0);
});
test('an assistant quote in the current conversation cannot activate a need grounded in another conversation',t=>{
  const env=runtime(t),a=observation(1,'本次希望先听我说。');env.store.observe(env.principal,a);
  const user=env.store.createUserEvidence(env.principal,{request_id:'a-evidence',ref:ref(a),start:0,end:[...a.messages[0]!.text].length});env.store.completeNoChange(env.store.jobs.claim()!);
  const b={...observation(1,'你好'),request_id:'conversation-b',conversation_id:'conversation-b'};env.store.observe(env.principal,b);const lease=env.store.jobs.claim()!,patch=candidate(env.store,lease,b);
  const assistant=b.messages[1]!,assistantRef={...ref(b),message_id:assistant.message_id,revision:assistant.revision};
  const e:Evidence={id:'assistant-evidence',companion_id:env.store.companion,source:{kind:'message',ref:assistantRef},speaker_actor_id:env.store.config.companion.character.id,
    quote:assistant.text,start:0,end:[...assistant.text].length};const base=patch.mutations[0]!.record;
  patch.input_messages=[assistantRef];patch.evidence=[e];patch.mutations=[{operation:'create',temporary_id:base.id,record:{contract_version:'1.0.0',kind:'response_need',id:base.id,
    companion_id:base.companion_id,version:1,suppression_generation:0,created_at:base.created_at,updated_at:base.updated_at,content_status:'active',publication_status:'published',
    evidence_ids:[user.id,e.id],scope:{kind:'conversation',id:b.conversation_id},content:'本次先倾听',basis_kind:'user_explicit',status:'user_confirmed'}}];
  env.store.saveCandidate(lease,patch);env.store.commitCandidate(lease);assert.equal(read(env,b.conversation_id).length,0);
});
