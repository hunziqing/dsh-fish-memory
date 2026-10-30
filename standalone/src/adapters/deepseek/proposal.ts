import * as z from 'zod';
import { IdSchema } from '../../domain/common.ts';
import type { Memory, Evidence } from '../../domain/memory.ts';
import type { MessageSnapshot } from '../../contracts/validation.ts';
import type { Watermark } from '../../domain/common.ts';

const SpanSchema=z.strictObject({source_id:z.string().regex(/^s[1-9][0-9]*$/),quote:z.string().min(1).max(1000),start:z.int().nonnegative(),end:z.int().positive()});
const TimeDraftSchema=z.strictObject({precision:z.enum(['unknown','year','month','day','instant']),start:z.string().nullable(),end:z.string().nullable(),
  basis:z.enum(['unknown','user_explicit','context_inferred']),evidence_indices:z.array(z.int().nonnegative()).max(16)});
const InterpretationDraftSchema=z.strictObject({
  local_id:IdSchema,kind:z.enum(['emotion','intent','response_need']),label:z.string().min(1).max(256),
  basis_kind:z.enum(['user_explicit','context_inferred']),status:z.enum(['tentative','supported','user_confirmed']),
  felt_time:TimeDraftSchema,expressed_source_id:z.string().regex(/^s[1-9][0-9]*$/),
  evidence_indices:z.array(z.int().nonnegative()).min(1).max(16),temporal_update:z.enum(['as_expressed','retrospective']),
  retrospective_evidence_indices:z.array(z.int().nonnegative()).max(16),replaces_id:IdSchema.nullable(),
});
export const EpisodeDraftSchema=z.strictObject({
  local_id:IdSchema,memory_id:IdSchema.nullable(),summary:z.string().min(1).max(1200),details:z.string().max(12000),
  publication_status:z.enum(['staged','published']),content_status:z.enum(['active','disputed']),topic_status:z.enum(['ongoing','paused','closed']),
  occurred:TimeDraftSchema.optional(),evidence:z.array(SpanSchema).min(1).max(16),
  interpretations:z.array(InterpretationDraftSchema).max(16).optional(),
});
const PatternDraftSchema=z.strictObject({local_id:IdSchema,memory_id:IdSchema.nullable(),
  pattern_kind:z.enum(['explicit_preference','observed_pattern']),content:z.string().min(1).max(1200),
  conditions:z.array(z.string().min(1).max(512)).max(16),counterexamples_reviewed:z.boolean(),
  evidence:z.array(SpanSchema).min(1).max(16),existing_evidence_ids:z.array(IdSchema).max(32),counterexample_evidence_ids:z.array(IdSchema).max(32),
  counterexample_evidence_indices:z.array(z.int().nonnegative()).max(16).optional(),
  status:z.enum(['tentative','supported','user_confirmed']),publication_status:z.enum(['staged','published']),content_status:z.enum(['active','disputed']),
});
export const ModelProposalSchema=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('none'),reason:z.string().min(1).max(1200)}),
  z.strictObject({action:z.literal('patch'),reason:z.string().min(1).max(1200),episodes:z.array(EpisodeDraftSchema).max(8),
    patterns:z.array(PatternDraftSchema).max(4).optional(),
    links:z.array(z.strictObject({from:IdSchema,to:IdSchema,relation:z.enum(['followup','supplement','correction','contradiction','alias'])})).max(32)}),
]).refine(value=>value.action==='none' || value.episodes.length+(value.patterns?.length??0)>0,{message:'A patch requires at least one episode or pattern; use none for no change'});
export type ModelProposal=z.infer<typeof ModelProposalSchema>;
export interface ExtractionSnapshot {
  snapshot_version:1;job_id:string;companion_id:string;timezone:string;user_actor_id:string;character_actor_id:string;
  epoch:number;watermark:Watermark;first_sequence:number;created_at:string;
  sources:(MessageSnapshot & {id:string})[];memories:Memory[];memory_states:Record<string,'current'|'needs_rebuild'>;evidence:Evidence[];
}
