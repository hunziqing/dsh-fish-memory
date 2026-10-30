import { ModelProposalSchema, type ExtractionSnapshot } from './proposal.ts';
import { TimeRangeSchema, sliceCodePoints, codePointLength } from '../../domain/common.ts';
import { CandidatePatchSchema, memoryEvidenceIds, type CandidatePatch, type Episode, type Evidence, type Interpretation, type ResponseNeedRecord, type CommunicationPattern } from '../../domain/memory.ts';
import { messageKey } from '../../contracts/validation.ts';
import { storedId } from '../../db/context.ts';
import { requireState } from '../../runtime/errors.ts';

export function normalizeProposal(raw:unknown,snapshot:ExtractionSnapshot):CandidatePatch|null {
  const proposal=ModelProposalSchema.parse(raw);if(proposal.action==='none')return null;
  const memories=new Map(snapshot.memories.map(memory=>[memory.id,memory])),sources=new Map(snapshot.sources.map(source=>[source.id,source]));
  const validEvidence=new Map(snapshot.evidence.map(evidence=>[evidence.id,evidence])),newEvidence=new Map<string,Evidence>();
  const spans=(items:{source_id:string;quote:string;start:number;end:number}[])=>items.map(span=>{
    const source=sources.get(span.source_id);
    requireState(source?.active && source.role==='user' && !source.suppressed,'VALIDATION_ERROR','An episode needs original unsuppressed user evidence');
    requireState(span.end>span.start && span.end<=codePointLength(source.text) && sliceCodePoints(source.text,span.start,span.end)===span.quote,
      'VALIDATION_ERROR','Model evidence must match exact source code points');
    const eid=storedId('evidence',[snapshot.companion_id,messageKey(source.ref),String(span.start),String(span.end)]);
    const result:Evidence={id:eid,companion_id:snapshot.companion_id,source:{kind:'message',ref:source.ref},speaker_actor_id:source.actor_id,quote:span.quote,start:span.start,end:span.end};
    newEvidence.set(eid,result);return result;
  });
  const localIds=new Map<string,string>();
  for(const draft of [...proposal.episodes,...proposal.patterns??[]]) {
    requireState(!localIds.has(draft.local_id),'VALIDATION_ERROR','Proposal local IDs must be unique');
    localIds.set(draft.local_id,draft.memory_id??storedId('draft',[snapshot.job_id,draft.local_id]));
  }
  const targets:CandidatePatch['targets']=[],mutations:CandidatePatch['mutations']=[];
  for(const draft of proposal.episodes) {
    const id=localIds.get(draft.local_id)!,previous=draft.memory_id?memories.get(draft.memory_id):undefined;
    requireState(!draft.memory_id || previous?.kind==='episode','NOT_FOUND','Model may only revise supplied episodes');
    requireState(previous?.content_status!=='retracted','STALE_INPUT','Withdrawn memories cannot be restored');
    const evidence=spans(draft.evidence);
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
    const consistent=interpretations.filter(item=>item.status!=='corrected' || interpretations.some(replacement=>replacement.id===item.superseded_by && replacement.status!=='corrected')).map(item=>structuredClone(item));
    for(const item of draft.interpretations??[]) {
      const indices=(values:number[])=>{
        requireState(values.every(index=>index<evidence.length),'VALIDATION_ERROR','Interpretation evidence index is outside this episode');return [...new Set(values.map(index=>evidence[index]!.id))];
      };
      const expressed=sources.get(item.expressed_source_id);
      requireState(expressed?.role==='user' && !expressed.suppressed && expressed.active,'VALIDATION_ERROR','Interpretation expression must be an active user source');
      const iid=storedId('understanding',[snapshot.job_id,draft.local_id,item.local_id]);
      requireState(!consistent.some(old=>old.id===iid),'VALIDATION_ERROR','Interpretation IDs must be unique');
      const {evidence_indices,...time}=item.felt_time;
      const next:Interpretation={id:iid,kind:item.kind,actor_id:snapshot.user_actor_id,label:item.label,basis_kind:item.basis_kind,status:item.status,
        scope:{kind:'episode',id},felt_time:TimeRangeSchema.parse({...time,evidence_ids:indices(evidence_indices)}),expressed_at:expressed.ref,
        evidence_ids:indices(item.evidence_indices),temporal_update:item.temporal_update,retrospective_evidence_ids:indices(item.retrospective_evidence_indices),superseded_by:null};
      if(item.replaces_id) {
        const old=consistent.find(old=>old.id===item.replaces_id);
        requireState(old && old.status!=='corrected' && old.kind===next.kind,'VALIDATION_ERROR','Only an active interpretation of the same kind can be corrected');
        requireState(old.status!=='user_confirmed' || (next.basis_kind==='user_explicit' && next.evidence_ids.some(eid=>{
          const e=newEvidence.get(eid);return e?.source.kind==='message' && e.source.ref.sequence>=snapshot.first_sequence && !old.evidence_ids.includes(eid);
        })),'VALIDATION_ERROR','An inference cannot replace a user-confirmed understanding');
        for(const earlier of consistent)if(earlier.status==='corrected' && earlier.superseded_by===old.id)earlier.superseded_by=iid;
        old.status='corrected';old.superseded_by=iid;
      }
      consistent.push(next);
    }
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
    // The standalone local need mirrors the newest active episode interpretation in the same transaction.
    const need=consistent.filter(item=>item.kind==='response_need' && item.status!=='corrected').at(-1);
    if(need) {
      const previousNeed=snapshot.memories.find(memory=>memory.kind==='response_need' && memory.scope.kind==='episode' && memory.scope.id===id) as ResponseNeedRecord|undefined;
      const nid=previousNeed?.id??storedId('need',[snapshot.job_id,draft.local_id]);
      const value:ResponseNeedRecord={contract_version:'1.0.0',kind:'response_need',id:nid,companion_id:snapshot.companion_id,version:(previousNeed?.version??0)+1,
        suppression_generation:previousNeed?.suppression_generation??0,content_status:draft.content_status,publication_status:draft.publication_status,
        created_at:previousNeed?.created_at??snapshot.created_at,updated_at:snapshot.created_at,evidence_ids:need.evidence_ids,scope:{kind:'episode',id},content:need.label,
        basis_kind:need.basis_kind==='user_explicit'?'user_explicit':'context_inferred',status:need.status as ResponseNeedRecord['status']};
      if(previousNeed) {targets.push({memory_id:nid,expected_version:previousNeed.version,suppression_generation:previousNeed.suppression_generation});mutations.push({operation:'revise',memory_id:nid,record:value});}
      else mutations.push({operation:'create',temporary_id:nid,record:value});
    }
  }
  for(const draft of proposal.patterns??[]) {
    const id=localIds.get(draft.local_id)!,prior=draft.memory_id?memories.get(draft.memory_id):undefined;
    requireState(!draft.memory_id || prior?.kind==='communication_pattern','NOT_FOUND','Only supplied communication patterns may be revised');
    requireState(prior?.content_status!=='retracted','STALE_INPUT','Withdrawn preferences cannot be restored');
    const current=spans(draft.evidence),old=prior?.evidence_ids.filter(id=>validEvidence.has(id))??[];
    requireState(draft.existing_evidence_ids.every(id=>validEvidence.has(id)),'VALIDATION_ERROR','Pattern evidence must be supplied and valid');
    const ids=[...new Set([...old,...draft.existing_evidence_ids,...current.map(e=>e.id)])];
    const all=ids.map(id=>newEvidence.get(id)??validEvidence.get(id)!);
    requireState(current.some(e=>e.source.kind==='message' && e.source.ref.sequence>=snapshot.first_sequence),'VALIDATION_ERROR','Pattern changes need fresh user evidence');
    if(draft.pattern_kind==='explicit_preference' && draft.publication_status==='published') {
      requireState(current.some(e=>/以后|每次|一直|通常|总是|习惯|长期|平时|请记住/u.test(e.quote)),'VALIDATION_ERROR','A one-off need cannot become a long-term preference');
    }
    requireState(draft.counterexample_evidence_ids.every(eid=>validEvidence.has(eid)||newEvidence.has(eid)),'VALIDATION_ERROR','Counterexamples must use supplied evidence');
    requireState((draft.counterexample_evidence_indices??[]).every(index=>index<current.length),'VALIDATION_ERROR','Counterexample index is outside this pattern');
    requireState(prior?.kind!=='communication_pattern' || prior.status!=='user_confirmed' || (draft.pattern_kind==='explicit_preference' && draft.status==='user_confirmed'),
      'VALIDATION_ERROR','An inferred pattern cannot replace a confirmed preference');
    const record:CommunicationPattern={contract_version:'1.0.0',kind:'communication_pattern',id,companion_id:snapshot.companion_id,version:(prior?.version??0)+1,
      suppression_generation:prior?.suppression_generation??0,content_status:draft.content_status,publication_status:draft.publication_status,
      created_at:prior?.created_at??snapshot.created_at,updated_at:snapshot.created_at,evidence_ids:ids,scope:{kind:'companion',id:snapshot.companion_id},
      content:draft.content,pattern_kind:draft.pattern_kind,conditions:draft.conditions,counterexample_evidence_ids:[...new Set([
        ...(prior?.kind==='communication_pattern'?prior.counterexample_evidence_ids.filter(eid=>validEvidence.has(eid)):[]),...draft.counterexample_evidence_ids,
        ...(draft.counterexample_evidence_indices??[]).map(index=>current[index]!.id)])],
      independent_context_ids:[...new Set(all.flatMap(e=>e.source.kind==='message'?[e.source.ref.conversation_id]:[]))],counterexamples_reviewed:draft.counterexamples_reviewed,status:draft.status};
    if(prior) {targets.push({memory_id:id,expected_version:prior.version,suppression_generation:prior.suppression_generation});mutations.push({operation:'revise',memory_id:id,record});}
    else mutations.push({operation:'create',temporary_id:id,record});
  }
  const reference=(id:string)=>{
    const value=localIds.get(id)??id;requireState(localIds.has(id)||memories.has(id),'NOT_FOUND','Link must use supplied episodes or proposal local IDs');return value;
  };
  return CandidatePatchSchema.parse({contract_version:'1.0.0',job_id:snapshot.job_id,request_id:storedId('proposal',[snapshot.job_id,String(snapshot.epoch)]),companion_id:snapshot.companion_id,
    input_watermark:snapshot.watermark,input_messages:snapshot.sources.map(source=>source.ref),targets,source_guards:[],mutations,evidence:[...newEvidence.values()],
    links:proposal.links.map(link=>({...link,from:reference(link.from),to:reference(link.to)})),reason:proposal.reason});
}
