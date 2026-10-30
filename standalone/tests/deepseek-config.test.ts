import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtime,track } from './runtime-helpers.ts';
import { readConfig } from '../src/config.ts';
import { RuntimeStore } from '../src/runtime/store.ts';

test('offline CLI updates non-secret DeepSeek settings and refuses invalid model names atomically',t=>{
  const env=runtime(t);env.store.close();const cwd=fileURLToPath(new URL('../',import.meta.url));
  const run=(args:string[])=>spawnSync(process.execPath,['src/cli.ts','configure-deepseek','--home',env.home,...args],{cwd,windowsHide:true,encoding:'utf8',timeout:10000});
  const first=run(['--enabled','true','--api-key-env','FISH_TEST_CONFIG_KEY','--daily-calls','1']);assert.equal(first.status,0,first.stderr);
  const config=readConfig(env.home);assert.equal(config.deepseek.enabled,true);assert.equal(config.deepseek.daily_calls,1);assert.equal(config.companion.id,env.store.companion);
  const before=readFileSync(join(env.home,'config.json'),'utf8'),bad=run(['--model','some-other-provider']);assert.equal(bad.status,1);
  assert.equal(readFileSync(join(env.home,'config.json'),'utf8'),before);assert.equal(first.stdout.includes('Bearer'),false);
});
test('older configuration without a model section stays disabled after a schema upgrade',t=>{
  const env=runtime(t);env.store.close();const {deepseek:_,...legacy}=readConfig(env.home);writeFileSync(join(env.home,'config.json'),JSON.stringify(legacy));
  const reopened=RuntimeStore.open(env.home,{clock:env.clock});track(t,()=>reopened.close());
  assert.equal(reopened.config.deepseek.enabled,false);assert.equal(reopened.status().model_worker_enabled,false);assert.deepEqual(reopened.status().model_calls,[]);
});
