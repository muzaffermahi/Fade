import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
/** Resolve npm's Node entry point without platform-dependent shell shims. */
export function npmCli() {
  const paths = [process.env.FADE_NPM_CLI, process.env.npm_execpath, join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js'];
  for(const directory of (process.env.PATH ?? '').split(delimiter)) {
    paths.push(join(directory,'node_modules/npm/bin/npm-cli.js'));
    const executable=join(directory,'npm');if(existsSync(executable)) {const resolved=realpathSync(executable);if(resolved.endsWith('npm-cli.js'))paths.push(resolved);}
  }
  const path=paths.find(path=>path && existsSync(path)); if(!path)throw new Error('Cannot locate npm-cli.js. Set FADE_NPM_CLI to its absolute path.'); return path;
}
