import * as z from 'zod';
import { IdSchema } from '../../domain/common.ts';
import type { Memory, Evidence } from '../../domain/memory.ts';
import type { MessageSnapshot } from '../../contracts/validation.ts';
import type { Watermark } from '../../domain/common.ts';

const SpanSchema=z.strictObject({source_id:z.string().regex(/^s[1-9][0-9]*$/),quote:z.string().min(1).max(1000),start:z.int().nonnegative(),end:z.int().positive()});
const TimeDraftSchema=z.strictObject({precision:z.enum(['unknown','year','month','day','instant']),start:z.string().nullable(),end:z.string().nullable(),
  basis:z.enum(['unknown','user_explicit','context_inferred']),evidence_indices:z.array(z.int().nonnegative()).max(16)});
export const EpisodeDraftSchema=z.strictObject({
  local_id:IdSchema,memory_id:IdSchema.nullable(),summary:z.string().min(1).max(1200),details:z.string().max(12000),
  publication_status:z.enum(['staged','published']),content_status:z.enum(['active','disputed']),topic_status:z.enum(['ongoing','paused','closed']),
  occurred:TimeDraftSchema.optional(),evidence:z.array(SpanSchema).min(1).max(16),
});
export const ModelProposalSchema=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('none'),reason:z.string().min(1).max(1200)}),
  z.strictObject({action:z.literal('patch'),reason:z.string().min(1).max(1200),episodes:z.array(EpisodeDraftSchema).min(1).max(8),
    links:z.array(z.strictObject({from:IdSchema,to:IdSchema,relation:z.enum(['followup','supplement','correction','contradiction','alias'])})).max(32)}),
]);
export type ModelProposal=z.infer<typeof ModelProposalSchema>;
export interface ExtractionSnapshot {
  snapshot_version:1;job_id:string;companion_id:string;timezone:string;user_actor_id:string;character_actor_id:string;
  epoch:number;watermark:Watermark;first_sequence:number;created_at:string;
  sources:(MessageSnapshot & {id:string})[];memories:Memory[];memory_states:Record<string,'current'|'needs_rebuild'>;evidence:Evidence[];
}
