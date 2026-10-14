import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
const notices=[];const licenses=[];const seen=new Set();
for(const [path, entry] of Object.entries(lock.packages)) {
  if(!path || entry.dev)continue;
  const name=path.split('node_modules/').at(-1);if(!name || typeof entry.version!=='string')throw new Error('Invalid production dependency lock entry');
  const identity=`${name}@${entry.version}`;if(seen.has(identity))continue;seen.add(identity);
  const directory=join(root,path);const manifestPath=join(directory,'package.json');let texts=[];
  if(existsSync(manifestPath)) {
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));if(manifest.version!==entry.version)throw new Error(`Installed dependency differs from lock: ${identity}`);
    for(const file of readdirSync(directory).sort())if(/^(licen[cs]e|copying|notice)(?:$|[._-])/i.test(file)&&statSync(join(directory,file)).isFile()) texts.push(`### ${identity} — ${file}\n\n${readFileSync(join(directory,file),'utf8').trim()}\n`);
  }
  notices.push(`| ${name} | ${entry.version} | ${String(entry.license ?? 'See upstream package')} | ${texts.length ? 'Text below' : 'Platform optional/upstream package'} |`);
  licenses.push(...texts);
}
const output=`# Third-party notices\n\nFade is MIT licensed. Dependencies keep their own licenses. This inventory comes from the locked production graph, including platform-optional packages; it excludes development-only packages. Full license/NOTICE text is copied from installed packages where supplied. Packages absent on this platform retain their upstream notices in the npm distribution; inspect those packages during the platform rehearsal. No dependency code is vendored in Fade's archive.\n\nRegenerate with \`node scripts/license-notices.mjs\` after installing the lock.\n\n| Package | Locked version | License metadata | Notice source |\n| --- | --- | --- | --- |\n${notices.sort().join('\n')}\n\n${licenses.join('\n')}`;
writeFileSync(join(root,'THIRD_PARTY_NOTICES.md'),output);console.log(`Recorded ${seen.size} locked production dependencies and ${licenses.length} installed license/notice texts.`);
