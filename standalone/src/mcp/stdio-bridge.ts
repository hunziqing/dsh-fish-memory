import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { connectMemoryClient } from './client.ts';

export async function serveBridge(home:string,tokenFile:string):Promise<void> {
  // This process never opens SQLite. All effects are forwarded to the single service owner.
  const remote=await connectMemoryClient(home,tokenFile);
  let catalog:Awaited<ReturnType<typeof remote.listTools>>;
  try {catalog=await remote.listTools();} catch(error) {await remote.close();throw error;}
  const handle=serveStdio(()=>{
    const server=new McpServer({name:'fish-companion-stdio-bridge',version:'0.3.0'},{capabilities:{tools:{listChanged:false}}});
    for(const tool of catalog.tools) server.registerTool(tool.name,{
      ...(tool.description?{description:tool.description}:{}),inputSchema:fromJsonSchema(tool.inputSchema as Parameters<typeof fromJsonSchema>[0]),
      ...(tool.outputSchema?{outputSchema:fromJsonSchema(tool.outputSchema as Parameters<typeof fromJsonSchema>[0])}:{}),
      ...(tool.annotations?{annotations:tool.annotations}:{}),
    },args=>remote.callTool({name:tool.name,arguments:args as Record<string,unknown>},{timeout:10000}));
    return server;
  },{onerror:()=>{process.stderr.write('MCP bridge protocol error\n');}});
  await new Promise<void>(resolve=>{
    const stop=()=>{void handle.close().finally(()=>remote.close()).finally(resolve);};
    process.stdin.once('end',stop);process.once('SIGTERM',stop);process.once('SIGINT',stop);
  });
}
