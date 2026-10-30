import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../config.ts';
import { ObserveInputSchema } from '../contracts/tools.ts';
import { branchKey, messageKey, type MessageSnapshot } from '../contracts/validation.ts';
import { memoryEvidenceIds, type Memory } from '../domain/memory.ts';
import { canonicalJson } from '../contracts/canonical.ts';
import { transaction } from './connection.ts';
import { conversationId,loadContext } from './context.ts';
import { readJson,putJson } from './objects.ts';
import { requireState } from '../runtime/errors.ts';
import type { JobQueue,JobLease } from './jobs.ts';
import type { Observations } from './observations.ts';
import type { ExtractionSnapshot } from '../adapters/deepseek/proposal.ts';

export class ExtractionRepository {
  readonly #db:DatabaseSync;readonly #config:RuntimeConfig;readonly #jobs:JobQueue;readonly #observations:Observations;readonly #clock:()=>Date;
  constructor(db:DatabaseSync,config:RuntimeConfig,jobs:JobQueue,observations:Observations,clock:()=>Date) {
    this.#db=db;this.#config=config;this.#jobs=jobs;this.#observations=observations;this.#clock=clock;
  }
  get #companion():string {return this.#config.companion.id;}
  #epoch():number {return Number(this.#db.prepare('SELECT memory_epoch FROM companion_epochs WHERE companion_id=?').get(this.#companion)!.memory_epoch);}
  snapshot(lease:JobLease):ExtractionSnapshot|null {
    const row=this.#db.prepare('SELECT content_object_id FROM model_contexts WHERE companion_id=? AND job_id=? AND lease_generation=?').get(this.#companion,lease.job_id,lease.generation);
    return row?readJson(this.#db,this.#companion,row.content_object_id as string) as ExtractionSnapshot:null;
  }
  assertCurrent(lease:JobLease):ExtractionSnapshot|null {
    this.#jobs.assertLease(lease);const input=this.#observations.assertJobInputCurrent(lease.input),snapshot=this.snapshot(lease);
    if(!snapshot)return null;
    requireState(snapshot.epoch===this.#epoch(),'VERSION_CONFLICT','Memory changed after this model context was captured');
    requireState(snapshot.companion_id===this.#companion && snapshot.job_id===lease.job_id && snapshot.first_sequence===input.sequence
      && snapshot.watermark.conversation_id===input.conversation_id && snapshot.watermark.branch_id===input.branch_id
      && snapshot.watermark.chain_revision===input.chain_revision,'STALE_INPUT','Model context differs from its owning job');
    return snapshot;
  }
  capture(lease:JobLease,measure:(snapshot:ExtractionSnapshot)=>number):ExtractionSnapshot {
    return transaction(this.#db,()=>{
      const prior=this.assertCurrent(lease);if(prior)return prior;
      const input=ObserveInputSchema.parse(lease.input),context=loadContext(this.#db,this.#companion,new Set(['candidate']));
      const branch=context.branches.get(branchKey(input.conversation_id,input.branch_id))!;
      const marks=this.#db.prepare('SELECT accepted_through FROM branches WHERE companion_id=? AND conversation_id=? AND id=?')
        .get(this.#companion,conversationId(this.#companion,input.conversation_id),input.branch_id)!;
      requireState(Number(marks.accepted_through)>=input.sequence,'STALE_INPUT','Earlier conversation turns are not yet durably received');
      const withdrawnTurns=new Set([...context.messages.values()].filter(source=>source.suppressed && source.role==='user').map(source=>`${source.ref.conversation_id}/${source.ref.turn_id}`));
      const eligible=[...context.messages.values()].filter(source=>source.ref.conversation_id===input.conversation_id && source.ref.branch_id===input.branch_id
        && source.active).map(source=>withdrawnTurns.has(`${source.ref.conversation_id}/${source.ref.turn_id}`)?{...source,text:'',suppressed:true}:source)
        .sort((a,b)=>a.ref.sequence-b.ref.sequence || (a.position??0)-(b.position??0));
      const words=[...new Set((input.messages.filter(message=>message.role==='user').map(message=>message.text).join(' ')).match(/[\p{L}\p{N}]{2,}/gu)??[])];
      const validity=new Map(this.#db.prepare('SELECT memory_id,status,reason,version FROM memory_validity WHERE companion_id=?').all(this.#companion).map(row=>[row.memory_id,row]));
      const liveEvidence=(id:string)=>{
        const e=context.evidence.get(id);if(e?.source.kind!=='message')return false;
        const source=context.messages.get(messageKey(e.source.ref));return source?.active && !source.suppressed;
      };
      const states=new Map<string,'current'|'needs_rebuild'>();
      const ranked=[...context.memories.values()].filter(memory=>memory.kind==='episode' && memory.content_status==='active'
        && validity.get(memory.id)?.version===memory.version && validity.get(memory.id)?.reason!=='SOURCE_RETRACTED').map(original=>{
        const source_state=validity.get(original.id)?.status==='valid'?'current' as const:'needs_rebuild' as const;
        const base:Memory=source_state==='needs_rebuild' && original.kind==='episode'?{...original,
          summary:'来源已编辑，请依据有效用户原话重新整理。',details:'',occurred:{precision:'unknown',start:null,end:null,basis:'unknown',evidence_ids:[]},
          evidence_ids:original.evidence_ids.filter(liveEvidence),interpretations:[],participant_ids:[this.#config.companion.user.id],publication_status:'staged',
          topic_status:'paused',last_effective_mention_at:null}:original;
        states.set(original.id,source_state);const memory=base;
        const evidence=memoryEvidenceIds(original).map(id=>context.evidence.get(id));
        const same=evidence.some(e=>e?.source.kind==='message' && e.source.ref.conversation_id===input.conversation_id);
        const text=memory.kind==='episode'?memory.summary+' '+memory.details:'';
        return {memory,score:(same?10:0)+(source_state==='current'?words.filter(word=>text.includes(word)).length:0)};
      }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score || b.memory.updated_at.localeCompare(a.memory.updated_at)).slice(0,6).map(item=>item.memory);
      const validEvidence=(memories:Memory[])=>[...new Set(memories.flatMap(memoryEvidenceIds))].filter(liveEvidence).map(id=>context.evidence.get(id)!);
      let memories=ranked;
      const create=(sources:MessageSnapshot[],end:number):ExtractionSnapshot=>({snapshot_version:1,job_id:lease.job_id,companion_id:this.#companion,
        timezone:context.timezone,user_actor_id:this.#config.companion.user.id,character_actor_id:this.#config.companion.character.id,epoch:this.#epoch(),
        first_sequence:input.sequence,created_at:this.#clock().toISOString(),watermark:{conversation_id:input.conversation_id,branch_id:input.branch_id,chain_revision:branch.chain_revision,sequence:end},
        sources:sources.map((source,i)=>({...source,id:`s${i+1}`})),memories,memory_states:Object.fromEntries(memories.map(memory=>[memory.id,states.get(memory.id)!])),evidence:validEvidence(memories)});
      let sources=eligible.filter(source=>source.ref.sequence===input.sequence),snapshot=create(sources,input.sequence);
      while(measure(snapshot)>this.#config.deepseek.max_input_bytes && memories.length) {memories=memories.slice(0,-1);snapshot=create(sources,input.sequence);}
      requireState(sources.length<=128 && measure(snapshot)<=this.#config.deepseek.max_input_bytes,'BUDGET_EXCEEDED','The complete visible turn cannot fit the configured model input budget');
      const preceding=eligible.filter(source=>source.ref.sequence<input.sequence && source.ref.sequence>=input.sequence-2);
      if(preceding.length && preceding.length+sources.length<=128 && measure(create([...preceding,...sources],input.sequence))<=this.#config.deepseek.max_input_bytes) {
        sources=[...preceding,...sources];snapshot=create(sources,input.sequence);
      }
      const end=Math.min(Number(marks.accepted_through),input.sequence+this.#config.deepseek.window_turns-1);
      for(let next=input.sequence+1;next<=end;next++) {
        const turn=eligible.filter(source=>source.ref.sequence===next),combined=[...sources,...turn],candidate=create(combined,next);
        if(combined.length>128 || measure(candidate)>this.#config.deepseek.max_input_bytes)break;
        sources=combined;snapshot=candidate;
      }
      this.#db.prepare('INSERT INTO model_contexts VALUES(?,?,?,?,?)').run(this.#companion,lease.job_id,lease.generation,putJson(this.#db,this.#companion,snapshot),snapshot.epoch);
      return snapshot;
    });
  }
  finishCoverage(lease:JobLease,snapshot:ExtractionSnapshot|null):void {
    requireState(this.#db.isTransaction,'TRANSACTION_REQUIRED','Coalesced completion requires the publication transaction');
    if(!snapshot)return;
    this.#db.prepare(`UPDATE jobs SET status='cancelled',error_code='COALESCED',lease_token=NULL,lease_until=NULL,result_json=? WHERE companion_id=? AND id<>? AND status IN ('queued','retry_wait') AND id IN
      (SELECT p.job_id FROM turn_processing p JOIN turns t ON t.id=p.turn_id WHERE p.companion_id=? AND p.conversation_id=? AND p.branch_id=? AND p.chain_revision=? AND t.sequence BETWEEN ? AND ?)`)
      .run(canonicalJson({covered_by:lease.job_id}),this.#companion,lease.job_id,this.#companion,conversationId(this.#companion,snapshot.watermark.conversation_id),snapshot.watermark.branch_id,
        snapshot.watermark.chain_revision,snapshot.first_sequence,snapshot.watermark.sequence);
  }
  reserve(lease:JobLease,bytes:number):string {
    return transaction(this.#db,()=>{
      requireState(this.assertCurrent(lease),'STALE_INPUT','Capture a model context before reserving a call');
      requireState(Number.isSafeInteger(bytes)&&bytes>0 && bytes<=this.#config.deepseek.max_input_bytes,'BUDGET_EXCEEDED','Model input exceeds its budget');
      const day=this.#clock().toISOString().slice(0,10),tokens=bytes+this.#config.deepseek.max_output_tokens+2048;
      const prior=this.#db.prepare('SELECT count(*) AS n,coalesce(sum(reserved_tokens),0) AS tokens FROM model_invocations WHERE companion_id=? AND budget_day=?').get(this.#companion,day)!;
      requireState(Number(prior.n)<this.#config.deepseek.daily_calls && Number(prior.tokens)+tokens<=this.#config.deepseek.daily_reserved_tokens,'BUDGET_EXCEEDED','Daily model call or conservative token reservation budget reached');
      const id=`invocation-${randomUUID()}`;
      this.#db.prepare(`INSERT INTO model_invocations(id,companion_id,job_id,lease_generation,budget_day,model,reserved_tokens,input_bytes,status) VALUES(?,?,?,?,?,?,?,?,'reserved')`)
        .run(id,this.#companion,lease.job_id,lease.generation,day,this.#config.deepseek.model,tokens,bytes);
      return id;
    });
  }
  nextBudgetWindow():string {
    const next=this.#clock();next.setUTCDate(next.getUTCDate()+1);next.setUTCHours(0,0,0,0);return next.toISOString();
  }
  finishInvocation(id:string,success:boolean,usage:{prompt_tokens:number;completion_tokens:number}|null,code:string|null):void {
    transaction(this.#db,()=>{
      this.#db.prepare(`UPDATE model_invocations SET status=?,prompt_tokens=?,completion_tokens=?,error_code=? WHERE companion_id=? AND id=? AND status IN ('reserved','interrupted')`)
        .run(success?'succeeded':'failed',usage?.prompt_tokens??null,usage?.completion_tokens??null,code,this.#companion,id);
    });
  }
  retryFailed(job:string):{job_id:string;replaces:string} {
    requireState(this.#db.isTransaction,'TRANSACTION_REQUIRED','User retry must share an idempotent transaction');
    const row=this.#db.prepare(`SELECT j.input_json,j.status,p.* FROM jobs j JOIN turn_processing p ON p.job_id=j.id WHERE j.companion_id=? AND j.id=?`).get(this.#companion,job);
    requireState(row?.status==='failed','VERSION_CONFLICT','Only the current failed processing job can be retried');
    const input=this.#observations.assertJobInputCurrent(JSON.parse(row.input_json as string));
    const id=this.#jobs.enqueueInTransaction('extract',`retry-${randomUUID()}`,input);
    this.#db.prepare('UPDATE turn_processing SET job_id=?,generation=generation+1 WHERE companion_id=? AND job_id=?').run(id,this.#companion,job);
    this.#observations.refresh(input.conversation_id);return {job_id:id,replaces:job};
  }
}
