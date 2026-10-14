import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { npmCli } from './npm-cli.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));const output=resolve(root,'releases');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
if(manifest.name!==lock.name||manifest.name!==lock.packages[''].name||manifest.version!==lock.version||manifest.version!==lock.packages[''].version)throw new Error('Package and lock identity differ');
if(manifest.name!=='@muzaffermahi/fade'||manifest.bin?.Fade!=='dist/cli.js'||manifest.bin?.fade!=='dist/cli.js')throw new Error('Expected scoped package with both executable aliases');
if(!Array.isArray(manifest.files)||!manifest.files.every(path=>typeof path==='string'&&!path.endsWith('/')&&!/(^|\/)(?:\.\.|node_modules|\.fade|\.git|auth\.json|models\.json|releases|tests|work-orders|scripts)(?:\/|$)/.test(path)&&!/(?:lmstudio-agent|run3|_debug)/.test(path)))throw new Error('Expected intentional public file allowlist');
let previous;
if(existsSync(join(output,'candidate.json'))) {
  const candidate=JSON.parse(readFileSync(join(output,'candidate.json'),'utf8'));
  if(candidate.version!==manifest.version) previous={name:candidate.name??'fade',version:candidate.version,archive:candidate.archive,sha256:candidate.sha256};
  else previous=candidate.previous;
}
if(!previous||previous.version===manifest.version||!existsSync(previous.archive)||createHash('sha256').update(readFileSync(previous.archive)).digest('hex')!==previous.sha256)throw new Error('A real previous-version archive with matching recorded checksum is required');
if(!existsSync(join(root,'dist/cli.js')))throw new Error('Build the CLI before packaging');
const stage=mkdtempSync(join(tmpdir(),'fade-release-stage-'));writeFileSync(join(stage,'package.json'),JSON.stringify({...manifest,files:[...manifest.files,'npm-shrinkwrap.json']},null,2));
writeFileSync(join(stage,'npm-shrinkwrap.json'),JSON.stringify(lock,null,2));
const canonicalRoot=realpathSync(root);
for(const path of manifest.files) {
  const source=join(root,path);if(!existsSync(source)||!lstatSync(source).isFile()||lstatSync(source).isSymbolicLink())throw new Error(`Missing/nonregular public file: ${path}`);
  const location=relative(canonicalRoot,realpathSync(source));if(location==='..'||location.startsWith('..'+sep)||isAbsolute(location))throw new Error(`Public path escapes source root: ${path}`);
  cpSync(source,join(stage,path));
}
const result=JSON.parse(execFileSync(process.execPath,[npmCli(),'pack','--ignore-scripts','--json','--pack-destination',output],{cwd:stage,encoding:'utf8',maxBuffer:10000000}));
if(!Array.isArray(result)||result.length!==1||typeof result[0]?.filename!=='string')throw new Error('Unexpected npm pack result');
const artifact=result[0];if(!Array.isArray(artifact.files))throw new Error('Missing package inventory');
if(artifact.files.some(file=>typeof file.path!=='string'||/(^|\/)(?:node_modules|\.fade|\.git|auth\.json|models\.json|releases)(?:\/|$)/.test(file.path)))throw new Error('Package contains a protected path');
const allowlist=new Set([...manifest.files,'package.json','npm-shrinkwrap.json']);
if(artifact.files.some(file=>!allowlist.has(file.path))||[...allowlist].some(path=>!artifact.files.some(file=>file.path===path)))throw new Error('Packed inventory differs from the public allowlist');
const archive=join(output,artifact.filename);const sha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(archive+'.sha256',`${sha256}  ${artifact.filename}\n`);writeFileSync(join(output,'candidate.json'),JSON.stringify({name:manifest.name,version:manifest.version,archive,sha256,previous,files:artifact.files.map(file=>file.path),stage},null,2));
console.log(JSON.stringify({archive,sha256,fileCount:artifact.files.length,stage},null,2));
