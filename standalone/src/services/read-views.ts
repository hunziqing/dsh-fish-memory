import type { DatabaseSync } from 'node:sqlite';
import type { Memory } from '../domain/memory.ts';
import type { ToolInput } from '../contracts/tools.ts';
import type { ValidationContext } from '../contracts/validation.ts';
import { allEvidence } from '../db/memory-writer.ts';
import { conversationId } from '../db/context.ts';
import { codePointLength, sliceCodePoints, type TimeRange } from '../domain/common.ts';
import { requireState, RuntimeError } from '../runtime/errors.ts';

function projection(memory:Memory,history=false):Memory {
  const copy=structuredClone(memory);
  if(copy.kind==='episode' && !history) copy.interpretations=copy.interpretations.filter(item=>item.status!=='corrected');
  return copy;
}
function metadata(memory:Memory,context:ValidationContext) {
  const evidence=allEvidence(memory).map(id=>context.evidence.get(id)!);
  requireState(evidence.length<=128 && evidence.every(Boolean),'BUDGET_EXCEEDED','The evidence set cannot fit the detail contract');
  const ids=new Set(evidence.map(item=>item.speaker_actor_id));
  if(memory.kind==='episode') for(const id of memory.participant_ids) ids.add(id);
  const actors=[...ids].map(id=>context.actors.get(id)!);
  requireState(actors.length<=32 && actors.every(Boolean),'BUDGET_EXCEEDED','The actor set cannot fit the detail contract');
  return {evidence,actors};
}
function size(value:unknown):number {return codePointLength(JSON.stringify(value));}
// Only text prefixes may be shortened. Evidence, dates and interpretation identities stay exact.
function fit<T>(value:T,memory:Memory,budget:number,measure:(value:T)=>number):boolean {
  if(measure(value)<=budget) return true;
  if(memory.kind!=='episode') return false;
  const details=memory.details,summary=memory.summary;memory.details='';
  if(measure(value)>budget) {
    memory.summary=sliceCodePoints(summary,0,1);
    if(measure(value)>budget) return false;
    let lo=1,hi=codePointLength(summary);
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);memory.summary=sliceCodePoints(summary,0,mid);if(measure(value)<=budget)lo=mid;else hi=mid-1;}
    memory.summary=sliceCodePoints(summary,0,lo);
  } else {
    let lo=0,hi=codePointLength(details);
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);memory.details=sliceCodePoints(details,0,mid);if(measure(value)<=budget)lo=mid;else hi=mid-1;}
    memory.details=sliceCodePoints(details,0,lo);
  }
  return true;
}
export function watermarks(db:DatabaseSync,companion:string,conversation:string,branch:string) {
  const row=db.prepare('SELECT chain_revision,accepted_through,processed_through FROM branches WHERE companion_id=? AND conversation_id=? AND id=?')
    .get(companion,conversationId(companion,conversation),branch);
  const mark={conversation_id:conversation,branch_id:branch,chain_revision:Number(row?.chain_revision??1)};
  return {accepted_through:row?{...mark,sequence:Number(row.accepted_through)}:null,processed_through:row?{...mark,sequence:Number(row.processed_through)}:null};
}
export function visible(db:DatabaseSync,companion:string,memory:Memory):boolean {
  const row=db.prepare('SELECT status,version FROM memory_validity WHERE companion_id=? AND memory_id=?').get(companion,memory.id);
  return memory.content_status==='active' && memory.publication_status==='published' && row?.status==='valid' && row.version===memory.version;
}
export function episodeView(db:DatabaseSync,input:ToolInput<'get_episode'>,context:ValidationContext) {
  const stored=context.memories.get(input.episode_id)!;
  requireState(visible(db,context.companion_id,stored),'STALE_INPUT','Episode is awaiting source reprocessing');
  const episode=projection(stored,input.include_history);
  requireState(episode.kind==='episode','NOT_FOUND','An episode is required');
  const revisions=input.include_history?db.prepare('SELECT version,reason,created_at FROM memory_revisions WHERE companion_id=? AND memory_id=? ORDER BY version DESC LIMIT 128')
    .all(context.companion_id,episode.id).map(row=>({version:Number(row.version),reason:row.reason as string,created_at:row.created_at as string})):[];
  const links=db.prepare('SELECT from_id AS "from",to_id AS "to",relation FROM memory_links WHERE companion_id=? AND (from_id=? OR to_id=?) LIMIT 64')
    .all(context.companion_id,episode.id,episode.id);
  const value={episode,...metadata(episode,context),links,historical:true as const,truncated:false,revisions};
  while(size(value)>input.max_chars && value.revisions.length) {value.revisions.pop();value.truncated=true;}
  while(size(value)>input.max_chars && value.links.length) {value.links.pop();value.truncated=true;}
  if(size(value)>input.max_chars) value.truncated=true;
  requireState(fit(value,episode,input.max_chars,size),'BUDGET_EXCEEDED','Episode metadata exceeds this budget; request more characters');
  return value;
}
function terms(text:string):string[] {
  const chunks=text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu)??[];
  return [...new Set(chunks.flatMap(chunk=>/\p{Script=Han}/u.test(chunk)&&[...chunk].length>2?[...chunk].slice(1).map((c,i)=>[...chunk][i]!+c):[chunk]))];
}
function overlaps(a:TimeRange,b:TimeRange,timezone:string):boolean {
  if(a.precision==='unknown' || b.precision==='unknown')return false;
  if(a.precision==='instant' && b.precision==='instant')
    return Date.parse(a.start)<=Date.parse(b.end??b.start) && Date.parse(b.start)<=Date.parse(a.end??a.start);
  const local=(value:string,instant:boolean)=>{
    if(!instant)return value;
    const date=new Date(value),parts=new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const get=(kind:string)=>parts.find(part=>part.type===kind)!.value;
    return `${get('year').padStart(4,'0')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${String(date.getUTCMilliseconds()).padStart(3,'0')}`;
  };
  const startA=local(a.start,a.precision==='instant'),endA=local(a.end??a.start,a.precision==='instant');
  const startB=local(b.start,b.precision==='instant'),endB=local(b.end??b.start,b.precision==='instant');
  const x=Math.min(startA.length,endB.length),y=Math.min(startB.length,endA.length);
  return startA.slice(0,x)<=endB.slice(0,x) && startB.slice(0,y)<=endA.slice(0,y);
}
export function recallView(db:DatabaseSync,input:ToolInput<'recall_context'>,context:ValidationContext) {
  requireState(input.branch_id==='main','VALIDATION_ERROR','Only main is supported by this host boundary');
  const marks=watermarks(db,context.companion_id,input.conversation_id,input.branch_id);
  const queryTerms=terms(input.query+' '+input.recent_context.filter(item=>item.role==='user').map(item=>item.text).join(' '));
  const ranked=[...context.memories.values()].filter(memory=>visible(db,context.companion_id,memory)).map(memory=>{
    if(memory.kind==='response_need') return {memory,score:0}; // Scoped response planning is implemented in phase 5.
    if(memory.kind==='communication_pattern') return {memory,score:memory.pattern_kind==='explicit_preference'?0.5:0};
    if(input.time_range && input.time_range.precision!=='unknown') {
      if(!overlaps(memory.occurred,input.time_range,context.timezone))return {memory,score:0};
    }
    const text=(memory.summary+' '+memory.details).toLocaleLowerCase('en');
    return {memory,score:queryTerms.reduce((sum,term)=>sum+Number(text.includes(term)),0)};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score || b.memory.updated_at.localeCompare(a.memory.updated_at));
  const items: {memory:Memory;evidence:ReturnType<typeof metadata>['evidence'];actors:ReturnType<typeof metadata>['actors'];historical:true;awakened:boolean;truncated:boolean;match_reasons:('topic'|'communication_preference')[]}[]=[];
  let truncated=false,preferences=0;
  for(const {memory:stored} of ranked) {
    if(items.length>=input.max_items) {truncated=true;break;}
    if(stored.kind==='communication_pattern' && preferences>=2) continue;
    const memory=projection(stored);let meta:ReturnType<typeof metadata>;
    try {meta=metadata(memory,context);} catch(error) {if(error instanceof RuntimeError && error.code==='BUDGET_EXCEEDED'){truncated=true;continue;}throw error;}
    const item={memory,...meta,historical:true as const,awakened:false,truncated:false,
      match_reasons:[memory.kind==='communication_pattern'?'communication_preference':'topic'] as ('topic'|'communication_preference')[]};
    if(size([...items,item])>input.max_chars) item.truncated=true;
    if(!fit(item,memory,input.max_chars,()=>size([...items,item]))) {truncated=true;continue;}
    items.push(item);truncated ||= item.truncated;if(stored.kind==='communication_pattern')preferences++;
  }
  const warnings:('processing_pending'|'budget_truncated')[]=[];
  if(marks.accepted_through && marks.processed_through!.sequence<marks.accepted_through.sequence) warnings.push('processing_pending');
  if(truncated)warnings.push('budget_truncated');
  // An empty array needs two serialized code points; budgets below that return a business error.
  requireState(size(items)<=input.max_chars,'BUDGET_EXCEEDED','Budget cannot contain even an empty item list');
  return {context_type:'user_history' as const,...marks,items,truncated,warnings};
}
