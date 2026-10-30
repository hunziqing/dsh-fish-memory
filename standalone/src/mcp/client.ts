import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceFileSchema } from '../server.ts';
import { requireState } from '../runtime/errors.ts';

export async function connectMemoryClient(home:string,tokenFile:string):Promise<Client> {
  const endpoint=ServiceFileSchema.parse(JSON.parse(readFileSync(join(home,'service.json'),'utf8')));
  const base=`http://127.0.0.1:${endpoint.port}`;
  const response=await fetch(base+'/health',{signal:AbortSignal.timeout(3000)});
  const health=await response.json() as {instance_id?:unknown};
  requireState(response.ok && health.instance_id===endpoint.instance_id,'NOT_RUNNING','Endpoint is stale or belongs to another service');
  const token=readFileSync(tokenFile,'utf8').trim();requireState(/^fmc_[A-Za-z0-9_-]{43}$/.test(token),'FORBIDDEN','Invalid local token file');
  const client=new Client({name:'fish-companion-client',version:'0.3.0'},{versionNegotiation:{mode:'auto',probe:{timeoutMs:3000,maxRetries:0}}});
  try {await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));return client;}
  catch(error) {await client.close();throw error;}
}
