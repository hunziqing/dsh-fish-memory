import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { temporary,observation,runtime } from './runtime-helpers.ts';
import { ConversationHooks } from '../src/adapters/conversation-hooks.ts';

test('unavailable recall degrades promptly and durable observations retry exactly after hook restart',async t=>{
  const directory=join(temporary(t),'outbox'),input=observation(1);let fail=true;const payloads:unknown[]=[];
  const caller=async(name:string,value:unknown)=>{
    payloads.push(value);if(fail)throw new Error('offline');
    return {contract_version:'1.0.0',outcome:{status:'ok',data:{receipt:'accepted',processing_status:'pending',duplicate:false,job_ids:['job-1'],
      accepted_through:{conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,sequence:1},processed_through:{conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,sequence:0}}}};
  };
  const hooks=new ConversationHooks(caller,directory,50);
  const result=await hooks.beforeReply({contract_version:'1.0.0',conversation_id:input.conversation_id,branch_id:'main',chain_revision:1,query:'你好',recent_context:[],time_range:null,max_items:6,max_chars:2000});
  assert.equal(result.available,false);assert.equal((await hooks.afterReply(input)).accepted,false);assert.equal(readdirSync(directory).length,1);
  fail=false;const reopened=new ConversationHooks(caller,directory,50);assert.deepEqual(await reopened.retryOutbox(),{accepted:1,remaining:0});
  assert.deepEqual(payloads.at(-1),input);
});
test('a hook deadline does not falsely acknowledge a late accepted observation and replay is harmless',async t=>{
  const env=runtime(t),directory=join(temporary(t),'outbox'),input=observation(1);let delayed=true;
  const hooks=new ConversationHooks(async(name,value)=>{
    if(delayed)await new Promise(resolve=>setTimeout(resolve,50));
    return env.store.invokeTool(env.principal,name,value);
  },directory,10);
  assert.equal((await hooks.afterReply(input)).accepted,false);
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(env.store.status().messages,2);
  delayed=false;assert.deepEqual(await hooks.retryOutbox(),{accepted:1,remaining:0});assert.equal(env.store.status().messages,2);
});
