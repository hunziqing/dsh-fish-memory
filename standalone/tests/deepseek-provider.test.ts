import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime,observation } from './runtime-helpers.ts';
import { DeepSeekProvider,ProviderError } from '../src/adapters/deepseek/provider.ts';

test('DeepSeek JSON requests are bounded, disable thinking and never return keys or reasoning',async t=>{
  const env=runtime(t),input=observation(1);env.store.observe(env.principal,input);const lease=env.store.jobs.claimExtraction()!;
  let captured:RequestInit|undefined;
  const fakeFetch:typeof fetch=async(url,options)=>{assert.equal(url,'https://api.deepseek.com/chat/completions');captured=options;
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'none',reason:'普通问候。'}),reasoning_content:'PRIVATE_REASONING'}}],usage:{prompt_tokens:10,completion_tokens:20}});};
  const provider=new DeepSeekProvider(env.store.config.deepseek,'UNIT_TEST_KEY',fakeFetch),snapshot=env.store.captureExtraction(lease,value=>provider.requestBytes(value));
  const result=await provider.extract(snapshot,new AbortController().signal),body=JSON.parse(captured!.body as string);
  assert.deepEqual(body.response_format,{type:'json_object'});assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.model,'deepseek-flash');
  assert.equal(captured!.redirect,'error');assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'),false);assert.equal(JSON.stringify(result).includes('UNIT_TEST_KEY'),false);
  assert.equal(JSON.stringify(provider),'{}');assert.deepEqual(result.usage,{prompt_tokens:10,completion_tokens:20});
});
test('provider failures sanitize remote bodies and reject empty or incomplete JSON without publishing',async t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1));const lease=env.store.jobs.claimExtraction()!;
  const snapshot=env.store.captureExtraction(lease,()=>1000);
  for(const [response,expected] of [[new Response('SECRET_REMOTE_BODY',{status:401}),'MODEL_HTTP_401'],
    [Response.json({choices:[{finish_reason:'stop',message:{content:''}}]}),'MODEL_EMPTY'],
    [Response.json({choices:[{finish_reason:'length',message:{content:'{"action":'}}]}),'MODEL_INCOMPLETE'],
    [Response.json({choices:[{finish_reason:'stop',message:{content:'not-json'}}]}),'MODEL_INVALID_JSON']] as const) {
    const provider=new DeepSeekProvider(env.store.config.deepseek,'UNIT_TEST_KEY',async()=>response);
    await assert.rejects(()=>provider.extract(snapshot,new AbortController().signal),error=>error instanceof ProviderError && error.code===expected && !error.message.includes('SECRET_REMOTE_BODY'));
  }
  assert.equal(env.store.status().memories,0);
});
test('oversized model responses are cancelled and oversized requests never reach fetch',async t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1));const snapshot=env.store.captureExtraction(env.store.jobs.claimExtraction()!,()=>1000);
  const huge=new DeepSeekProvider(env.store.config.deepseek,'UNIT_TEST_KEY',async()=>new Response('x'.repeat(2_097_153)));
  await assert.rejects(()=>huge.extract(snapshot,new AbortController().signal),error=>error instanceof ProviderError && error.code==='MODEL_RESPONSE_TOO_LARGE');
  env.store.config.deepseek.max_input_bytes=8192;let fetched=false;
  const provider=new DeepSeekProvider(env.store.config.deepseek,'UNIT_TEST_KEY',async()=>{fetched=true;throw new Error('unexpected');});
  snapshot.sources[0]!.text='长'.repeat(12000);await assert.rejects(()=>provider.extract(snapshot,new AbortController().signal));assert.equal(fetched,false);
});
