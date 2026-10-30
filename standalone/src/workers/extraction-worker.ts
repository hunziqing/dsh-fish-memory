import { setTimeout as pause } from 'node:timers/promises';
import * as z from 'zod';
import { DeepSeekProvider,ProviderError,type ExtractionProvider,type ModelResult } from '../adapters/deepseek/provider.ts';
import { normalizeProposal } from '../adapters/deepseek/normalize.ts';
import { RuntimeStore } from '../runtime/store.ts';
import { RuntimeError } from '../runtime/errors.ts';

export interface WorkerResult {status:'idle'|'processed'|'retry_wait'|'failed'|'budget_wait';job_id?:string;}
export class ExtractionWorker {
  readonly #store:RuntimeStore;readonly #provider:ExtractionProvider;
  readonly #shutdown=new AbortController();
  #current:Promise<WorkerResult>|null=null;#loop:Promise<void>|null=null;
  constructor(store:RuntimeStore,provider:ExtractionProvider) {this.#store=store;this.#provider=provider;}
  start():void {
    if(this.#loop)return;
    this.#loop=(async()=>{
      while(!this.#shutdown.signal.aborted) {
        await this.runOnce();
        try {await pause(this.#store.config.deepseek.poll_interval_ms,undefined,{signal:this.#shutdown.signal});} catch {break;}
      }
    })();
  }
  async stop():Promise<void> {
    this.#shutdown.abort();await this.#current;await this.#loop;
    this.#store.setWorkerState({enabled:false,busy:false});
  }
  runOnce():Promise<WorkerResult> {
    if(this.#current)return this.#current;
    this.#current=this.#run().finally(()=>{this.#current=null;});return this.#current;
  }
  async #run():Promise<WorkerResult> {
    if(this.#shutdown.signal.aborted || !this.#store.config.deepseek.enabled) {
      this.#store.setWorkerState({enabled:false,busy:false});return {status:'idle'};
    }
    this.#store.setWorkerState({enabled:true});
    let lease;
    try {lease=this.#store.jobs.claimExtraction();} catch {return {status:'idle'};}
    if(!lease)return {status:'idle'};
    this.#store.setWorkerState({busy:true,last_job_id:lease.job_id,last_error:null});
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.#shutdown.signal]);
    let invocation:string|null=null,prepared=false,usage:ModelResult['usage']=null;
    const renew=setInterval(()=>{
      try {lease=this.#store.jobs.renew(lease!);} catch(error) {if(!(error instanceof RuntimeError && error.code==='SERVICE_BUSY'))controller.abort();}
    },Math.max(250,Math.floor(this.#store.config.jobs.lease_ms/3)));renew.unref();
    try {
      const snapshot=this.#store.captureExtraction(lease,value=>this.#provider.requestBytes(value));prepared=true;
      if(!snapshot.sources.some(source=>source.role==='user' && !source.suppressed)) {
        this.#store.completeNoChange(lease);return {status:'processed',job_id:lease.job_id};
      }
      invocation=this.#store.reserveModelCall(lease,this.#provider.requestBytes(snapshot));
      let onAbort:()=>void=()=>{};
      let result:ModelResult;
      try {
        result=await Promise.race([this.#provider.extract(snapshot,signal),new Promise<never>((_,reject)=>{
          onAbort=()=>reject(new ProviderError('MODEL_CANCELLED',true));
          if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
        })]);
      } finally {signal.removeEventListener('abort',onAbort);}
      usage=result.usage;
      if(signal.aborted)throw new ProviderError('MODEL_CANCELLED',true);
      const patch=normalizeProposal(result.proposal,snapshot);
      if(patch) {this.#store.saveCandidate(lease,patch);this.#store.commitCandidate(lease);}
      else this.#store.completeNoChange(lease);
      try {this.#store.finishModelCall(invocation,true,usage,null);} catch {this.#store.setWorkerState({last_error:'ACCOUNTING_WRITE_PENDING'});}
      return {status:'processed',job_id:lease.job_id};
    } catch(error) {
      const code=error instanceof RuntimeError?error.code:error instanceof z.ZodError?'MODEL_VALIDATION':'WORKER_FAILED';
      this.#store.setWorkerState({last_error:code});
      if(invocation)try {this.#store.finishModelCall(invocation,false,usage,code);} catch { /* reservation remains counted */ }
      if(prepared && !invocation && code==='BUDGET_EXCEEDED') {
        try {this.#store.jobs.deferWithoutCall(lease,this.#store.nextModelBudgetWindow(),'BUDGET_EXCEEDED');} catch { /* fenced or recovering */ }
        return {status:'budget_wait',job_id:lease.job_id};
      }
      const retryable=error instanceof ProviderError?error.retryable:error instanceof z.ZodError || ['VERSION_CONFLICT','STALE_INPUT','STALE_LEASE','SERVICE_BUSY','VALIDATION_ERROR'].includes(code);
      try {this.#store.jobs.fail(lease,retryable,code);} catch { /* a source edit or expired lease already fenced this worker */ }
      return {status:retryable?'retry_wait':'failed',job_id:lease.job_id};
    } finally {clearInterval(renew);this.#store.setWorkerState({busy:false});}
  }
}
export function startConfiguredWorker(store:RuntimeStore,override?:ExtractionProvider):ExtractionWorker|null {
  if(!store.config.deepseek.enabled) {store.setWorkerState({enabled:false});return null;}
  const key=process.env[store.config.deepseek.api_key_env];
  if(!override && !key?.trim()) {store.setWorkerState({enabled:false,last_error:'MODEL_NOT_CONFIGURED'});return null;}
  const worker=new ExtractionWorker(store,override??new DeepSeekProvider(store.config.deepseek,key!));worker.start();return worker;
}
