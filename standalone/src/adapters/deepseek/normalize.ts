import { ModelProposalSchema, type ExtractionSnapshot } from './proposal.ts';
import { TimeRangeSchema, sliceCodePoints, codePointLength } from '../../domain/common.ts';
import { CandidatePatchSchema, memoryEvidenceIds, type CandidatePatch, type Episode, type Evidence } from '../../domain/memory.ts';
import { messageKey } from '../../contracts/validation.ts';
import { storedId } from '../../db/context.ts';
import { requireState } from '../../runtime/errors.ts';

export function normalizeProposal(raw:unknown,snapshot:ExtractionSnapshot):CandidatePatch|null {
  const proposal=ModelProposalSchema.parse(raw);if(proposal.action==='none')return null;
  const memories=new Map(snapshot.memories.map(memory=>[memory.id,memory])),sources=new Map(snapshot.sources.map(source=>[source.id,source]));
  const validEvidence=new Map(snapshot.evidence.map(evidence=>[evidence.id,evidence])),newEvidence=new Map<string,Evidence>();
  const localIds=new Map<string,string>();
  for(const draft of proposal.episodes) {
    requireState(!localIds.has(draft.local_id),'VALIDATION_ERROR','Proposal local IDs must be unique');
    localIds.set(draft.local_id,draft.memory_id??storedId('draft',[snapshot.job_id,draft.local_id]));
  }
  const targets:CandidatePatch['targets']=[],mutations:CandidatePatch['mutations']=[];
  for(const draft of proposal.episodes) {
    const id=localIds.get(draft.local_id)!,previous=draft.memory_id?memories.get(draft.memory_id):undefined;
    requireState(!draft.memory_id || previous?.kind==='episode','NOT_FOUND','Model may only revise supplied episodes');
    requireState(previous?.content_status!=='retracted','STALE_INPUT','Withdrawn memories cannot be restored');
    const evidence=draft.evidence.map(span=>{
      const source=sources.get(span.source_id);
      requireState(source?.active && source.role==='user' && !source.suppressed,'VALIDATION_ERROR','An episode needs original unsuppressed user evidence');
      requireState(span.end>span.start && span.end<=codePointLength(source.text) && sliceCodePoints(source.text,span.start,span.end)===span.quote,
        'VALIDATION_ERROR','Model evidence must match exact source code points');
      const eid=storedId('evidence',[snapshot.companion_id,messageKey(source.ref),String(span.start),String(span.end)]);
      const result:Evidence={id:eid,companion_id:snapshot.companion_id,source:{kind:'message',ref:source.ref},speaker_actor_id:source.actor_id,quote:span.quote,start:span.start,end:span.end};
      newEvidence.set(eid,result);return result;
    });
    const prior=previous?.kind==='episode'?previous:undefined;
    const oldIds=prior?.evidence_ids.filter(id=>validEvidence.has(id))??[];
    let occurred=prior && prior.occurred.evidence_ids.every(id=>validEvidence.has(id))?prior.occurred:
      TimeRangeSchema.parse({precision:'unknown',start:null,end:null,basis:'unknown',evidence_ids:[]});
    if(draft.occurred) {
      const {evidence_indices,...time}=draft.occurred;
      requireState(evidence_indices.every(index=>index<evidence.length),'VALIDATION_ERROR','Event-time evidence index is outside this episode');
      occurred=TimeRangeSchema.parse({...time,evidence_ids:evidence_indices.map(index=>evidence[index]!.id)});
    }
    const interpretations=prior?.interpretations.filter(item=>[...item.evidence_ids,...item.felt_time.evidence_ids,...item.retrospective_evidence_ids].every(id=>validEvidence.has(id)))??[];
    const consistent=interpretations.filter(item=>item.status!=='corrected' || interpretations.some(replacement=>replacement.id===item.superseded_by && replacement.status!=='corrected'));
    const mention=draft.evidence.map(span=>sources.get(span.source_id)!).filter(source=>source.ref.conversation_id===snapshot.watermark.conversation_id && source.ref.sequence===snapshot.watermark.sequence)
      .map(source=>source.captured_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
    const record:Episode={contract_version:'1.0.0',kind:'episode',id,companion_id:snapshot.companion_id,version:(prior?.version??0)+1,
      suppression_generation:prior?.suppression_generation??0,content_status:draft.content_status,publication_status:draft.publication_status,
      created_at:prior?.created_at??snapshot.created_at,updated_at:snapshot.created_at,evidence_ids:[...new Set([...oldIds,...evidence.map(item=>item.id)])],
      summary:draft.summary,details:draft.details,participant_ids:prior?.participant_ids??[snapshot.user_actor_id],occurred,
      topic_status:draft.topic_status,storage_tier:prior?.storage_tier??'hot',last_effective_mention_at:mention??prior?.last_effective_mention_at??null,interpretations:consistent};
    requireState(memoryEvidenceIds(record).length<=128,'BUDGET_EXCEEDED','Model proposal has too much evidence for the read contract');
    if(prior) {targets.push({memory_id:prior.id,expected_version:prior.version,suppression_generation:prior.suppression_generation});mutations.push({operation:'revise',memory_id:prior.id,record});}
    else mutations.push({operation:'create',temporary_id:id,record});
  }
  const reference=(id:string)=>{
    const value=localIds.get(id)??id;requireState(localIds.has(id)||memories.has(id),'NOT_FOUND','Link must use supplied episodes or proposal local IDs');return value;
  };
  return CandidatePatchSchema.parse({contract_version:'1.0.0',job_id:snapshot.job_id,request_id:storedId('proposal',[snapshot.job_id,String(snapshot.epoch)]),companion_id:snapshot.companion_id,
    input_watermark:snapshot.watermark,input_messages:snapshot.sources.map(source=>source.ref),targets,source_guards:[],mutations,evidence:[...newEvidence.values()],
    links:proposal.links.map(link=>({...link,from:reference(link.from),to:reference(link.to)})),reason:proposal.reason});
}
