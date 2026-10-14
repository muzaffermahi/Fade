import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const run=(...args)=>execFileSync(process.execPath,args,{cwd:root,stdio:'inherit'});
run('node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.test.json');
run('--import','tsx','--test',...readdirSync(root+'/tests').filter(name=>name.endsWith('.test.ts')).sort().map(name=>'tests/'+name));
run('node_modules/typescript/bin/tsc','-p','tsconfig.json');run('dist/cli.js','--help');
