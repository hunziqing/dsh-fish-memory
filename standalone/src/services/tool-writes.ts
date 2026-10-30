import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ToolInput } from '../contracts/tools.ts';
import type { ValidationContext } from '../contracts/validation.ts';
import { MemorySchema, type CandidatePatch } from '../domain/memory.ts';
import { allEvidence, persistPatch } from '../db/memory-writer.ts';
import { requireState } from '../runtime/errors.ts';

type WriteName='correct_memory'|'set_memory_preference'|'retract_memory';
function apply(db:DatabaseSync,mutations:CandidatePatch['mutations'],targets:CandidatePatch['targets'],links:CandidatePatch['links'],reason:string,context:ValidationContext,now:string,hook:(point:string)=>void,authorizationIds:string[]=[],allowRetraction=false) {
  const evidence=[...new Set([...mutations.flatMap(item=>allEvidence(item.record)),...authorizationIds])].map(id=>context.evidence.get(id)!);
  const refs=evidence.flatMap(item=>item.source.kind==='message'?[item.source.ref]:[]);
  const anchor=refs[0];requireState(anchor,'VALIDATION_ERROR','Live user evidence is required before import support');
  const branch=context.branches.get(`${anchor.conversation_id}/${anchor.branch_id}`)!;
  const patch:CandidatePatch={contract_version:'1.0.0',job_id:`interactive-${randomUUID()}`,request_id:`patch-${randomUUID()}`,companion_id:context.companion_id,
    input_messages:refs,input_watermark:{conversation_id:anchor.conversation_id,branch_id:anchor.branch_id,chain_revision:branch.chain_revision,sequence:anchor.sequence},
    targets,source_guards:[],mutations,evidence,links,reason};
  for(const {record} of mutations) if(record.kind==='episode') {
    const previous=context.memories.get(record.id);
    requireState(record.storage_tier===(previous?.kind==='episode'?previous.storage_tier:'hot'),'VALIDATION_ERROR','Memory tools cannot relocate physical storage');
  }
  return persistPatch(db,context.companion_id,patch,now,hook,allowRetraction);
}
export function writeTool(db:DatabaseSync,name:WriteName,raw:ToolInput<WriteName>,context:ValidationContext,now:string,hook:(point:string)=>void):unknown {
  if(name==='correct_memory') {
    const input=raw as ToolInput<'correct_memory'>;
    return apply(db,input.mutations,input.targets,input.links,input.reason,context,now,hook,input.evidence_ids);
  }
  if(name==='set_memory_preference') {
    const input=raw as ToolInput<'set_memory_preference'>,value=input.value;
    const previous=input.operation==='update'?context.memories.get(input.memory_id)!:undefined;
    const {category,...fields}=value;
    const record=MemorySchema.parse({contract_version:'1.0.0',id:previous?.id??`temporary-${randomUUID()}`,companion_id:context.companion_id,version:input.expected_version+1,
      suppression_generation:previous?.suppression_generation??0,content_status:'active',publication_status:'published',created_at:previous?.created_at??now,updated_at:now,kind:category,...fields});
    const result=apply(db,input.operation==='create'?[{operation:'create',temporary_id:record.id,record}]:[{operation:'revise',memory_id:record.id,record}],
      input.operation==='update'?[{memory_id:input.memory_id,expected_version:input.expected_version,suppression_generation:input.suppression_generation}]:[],[],
      '用户管理交流偏好或本次回应需要。',context,now,hook);
    return {memory_id:result.created[0]?.memory_id??record.id,version:record.version,effect:category==='response_need'?'local_response_need':value.pattern_kind};
  }
  const input=raw as ToolInput<'retract_memory'>,before=context.memories.get(input.memory_id)!;
  const record={...structuredClone(before),version:before.version+1,suppression_generation:before.suppression_generation+1,content_status:'retracted' as const,updated_at:now,evidence_ids:input.evidence_ids};
  apply(db,[{operation:'revise',memory_id:before.id,record}],[input],[],input.reason,context,now,hook,[],true);
  // Source identity survives revisions: a new memory ID cannot restore the withdrawn statement.
  db.prepare(`INSERT OR IGNORE INTO message_suppressions SELECT ?,msg.id,?,?,? FROM revision_evidence i
    JOIN memory_revisions r ON r.id=i.memory_revision_id JOIN evidence e ON e.id=i.evidence_id
    JOIN turn_versions v ON v.id=e.turn_version_id JOIN messages msg ON msg.id=v.message_id
    WHERE r.companion_id=? AND r.memory_id=? AND r.version=? AND msg.role='user'`).run(context.companion_id,before.id,record.suppression_generation,input.reason,context.companion_id,before.id,before.version);
  db.prepare(`UPDATE memory_validity SET status='stale',reason='SOURCE_RETRACTED' WHERE companion_id=? AND memory_id IN
    (SELECT r.memory_id FROM memory_revisions r JOIN revision_inputs i ON i.memory_revision_id=r.id JOIN memory_records m ON m.id=r.memory_id AND m.version=r.version
     JOIN turn_versions v ON v.id=i.turn_version_id JOIN message_suppressions s ON s.message_id=v.message_id WHERE s.companion_id=?)`).run(context.companion_id,context.companion_id);
  db.prepare(`DELETE FROM search_terms WHERE companion_id=? AND document_id IN (SELECT d.id FROM search_documents d JOIN memory_validity v ON v.memory_id=d.memory_id WHERE v.status='stale')`).run(context.companion_id);
  db.prepare(`DELETE FROM search_documents WHERE companion_id=? AND memory_id IN (SELECT memory_id FROM memory_validity WHERE companion_id=? AND status='stale')`).run(context.companion_id,context.companion_id);
  return {memory_id:record.id,version:record.version,suppression_generation:record.suppression_generation,content_status:'retracted',physical_deletion:false};
}
