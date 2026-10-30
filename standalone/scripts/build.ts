import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const compiler=join(dirname(require.resolve('typescript/package.json')),'bin','tsc');
const result=spawnSync(process.execPath,[compiler,'-p','tsconfig.build.json'],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.error) throw result.error;
if(result.status!==0) process.exit(result.status??1);
mkdirSync(new URL('../dist/db/migrations/',import.meta.url),{recursive:true});
for(const file of readdirSync(new URL('../src/db/migrations/',import.meta.url)).filter(file=>file.endsWith('.sql')))
  copyFileSync(new URL(`../src/db/migrations/${file}`,import.meta.url),new URL(`../dist/db/migrations/${file}`,import.meta.url));
