import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.env.DEEPCOMPOSE_SOURCE||path.resolve(root,'../DeepCompose');
await fs.mkdir(path.join(root,'.bridge'),{recursive:true});
await build({entryPoints:[path.join(root,'bridge/engine.ts')],outfile:path.join(root,'.bridge/engine.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',alias:{'deepcompose-core':path.join(source,'src/core')},logLevel:'warning'});
if(!process.argv.includes('--engine-only'))await build({entryPoints:[path.join(root,'web/app.mjs')],outfile:path.join(root,'assets/remote.js'),bundle:true,platform:'browser',target:['safari16.4','chrome110'],format:'esm',minify:true,legalComments:'linked',logLevel:'warning'});
if(!process.argv.includes('--engine-only')){const legal=path.join(root,'assets/remote.js.LEGAL.txt');const content=await fs.readFile(legal,'utf8');await fs.writeFile(legal,content.split(String.fromCharCode(10)).map(line=>line.trimEnd()).join(String.fromCharCode(10)));}
console.log('Build complete: private desktop engine + self-hosted browser client.');
