import { mkdirSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashJson } from '../contracts/canonical.ts';
import { ObserveInputSchema, toolContracts, type ToolInput, type ToolName, type ToolOutput } from '../contracts/tools.ts';
import { writeExclusive } from '../config.ts';
import { requireState } from '../runtime/errors.ts';
import { connectMemoryClient } from '../mcp/client.ts';

type Caller=(name:ToolName,input:unknown)=>Promise<unknown>;
export class ConversationHooks {
  readonly #call:Caller;readonly #directory:string;readonly #timeout:number;
  constructor(call:Caller,outboxDirectory:string,timeoutMs=1500) {
    requireState(Number.isInteger(timeoutMs)&&timeoutMs>=10 && timeoutMs<=60000,'INVALID_CONFIG','Invalid hook timeout');
    this.#call=call;this.#directory=outboxDirectory;this.#timeout=timeoutMs;
    mkdirSync(outboxDirectory,{recursive:true,mode:0o700});
  }
  async #bounded(name:ToolName,input:unknown):Promise<ToolOutput<ToolName>> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const value=await Promise.race([this.#call(name,input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Memory hook timed out')),this.#timeout);})]);
      return toolContracts[name].output.parse(value);
    } finally {if(timer)clearTimeout(timer);}
  }
  async beforeReply(input:ToolInput<'recall_context'>) {
    try {
      const value=await this.#bounded('recall_context',input);
      if(value.outcome.status==='error') return {available:false as const,background:null,warning:value.outcome.error.code};
      return {available:true as const,background:value,warning:null};
    } catch {return {available:false as const,background:null,warning:'MEMORY_UNAVAILABLE'};}
  }
  async afterReply(raw:ToolInput<'observe_turn'>) {
    const input=ObserveInputSchema.parse(raw),file=join(this.#directory,`${hashJson(input.request_id)}.json`);
    if(existsSync(file)) requireState(hashJson(JSON.parse(readFileSync(file,'utf8')))===hashJson(input),'IDEMPOTENCY_CONFLICT','Outbox request ID has another payload');
    else writeExclusive(file,JSON.stringify(input)+'\n');
    try {
      const value=await this.#bounded('observe_turn',input);
      if(value.outcome.status==='error') return {accepted:false as const,durable:true as const,warning:value.outcome.error.code};
      // A timeout can occur after the service committed; retry uses the same ID and exact payload.
      unlinkSync(file);return {accepted:true as const,durable:true as const,receipt:value};
    } catch {return {accepted:false as const,durable:true as const,warning:'MEMORY_UNAVAILABLE'};}
  }
  async retryOutbox():Promise<{accepted:number;remaining:number}> {
    let accepted=0;
    for(const file of readdirSync(this.#directory).filter(file=>/^[a-f0-9]{64}\.json$/.test(file))) {
      const input=ObserveInputSchema.parse(JSON.parse(readFileSync(join(this.#directory,file),'utf8')));
      requireState(file===`${hashJson(input.request_id)}.json`,'INVALID_OUTBOX','Outbox filename differs from its request');
      const result=await this.afterReply(input);if(!result.accepted)break;accepted++;
    }
    return {accepted,remaining:readdirSync(this.#directory).filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).length};
  }
}
export function remoteConversationHooks(home:string,tokenFile:string,outboxDirectory:string,timeoutMs=1500):ConversationHooks {
  return new ConversationHooks(async(name,input)=>{
    const client=await connectMemoryClient(home,tokenFile);
    try {const result=await client.callTool({name,arguments:input as Record<string,unknown>},{timeout:timeoutMs});return result.structuredContent;}
    finally {await client.close();}
  },outboxDirectory,timeoutMs);
}
