import type { ExtractionSnapshot } from '../src/adapters/deepseek/proposal.ts';
import type { ExtractionProvider,ModelResult } from '../src/adapters/deepseek/provider.ts';
export function simpleProposal(snapshot:ExtractionSnapshot) {
  const sources=snapshot.sources.filter(source=>source.role==='user'&&!source.suppressed),previous=snapshot.memories.find(memory=>memory.kind==='episode');
  return {action:'patch',reason:'根据可见用户陈述逐步整理。',episodes:[{local_id:'e1',memory_id:previous?.id??null,
    summary:sources.map(source=>source.text).join(' '),details:'',content_status:'active',publication_status:'published',topic_status:'ongoing',
    evidence:sources.map(source=>({source_id:source.id,quote:source.text,start:0,end:[...source.text].length}))}],links:[]};
}
export class FakeProvider implements ExtractionProvider {
  calls:ExtractionSnapshot[]=[];
  respond:(snapshot:ExtractionSnapshot,signal:AbortSignal)=>Promise<ModelResult>;
  constructor(respond:(snapshot:ExtractionSnapshot,signal:AbortSignal)=>Promise<ModelResult>=async snapshot=>({proposal:simpleProposal(snapshot),usage:{prompt_tokens:20,completion_tokens:30}})) {this.respond=respond;}
  requestBytes(snapshot:ExtractionSnapshot):number {return Buffer.byteLength(JSON.stringify(snapshot))+1000;}
  async extract(snapshot:ExtractionSnapshot,signal:AbortSignal):Promise<ModelResult> {this.calls.push(snapshot);return this.respond(snapshot,signal);}
}
