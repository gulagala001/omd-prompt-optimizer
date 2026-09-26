import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
await mkdir(new URL('./lib/', import.meta.url), {recursive:true});
await build({entryPoints:[root+'src/host.mjs'],outfile:root+'lib/host.mjs',bundle:true,platform:'node',format:'esm',target:'node22',minify:false});
await build({entryPoints:[root+'src/client.jsx'],outfile:root+'lib/client.js',bundle:true,platform:'browser',format:'cjs',target:'es2022',external:['react','react-dom'],loader:{'.css':'text'},
  banner:{js:'window.__ModuleLoader__.load({id:"omd-prompt-optimizer",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},
  footer:{js:'return module.exports;}});'}});
await copyFile(new URL('../LICENSE',import.meta.url),new URL('./LICENSE',import.meta.url));
await writeFile(new URL('./UPSTREAM.json',import.meta.url),JSON.stringify({repository:'WestFox-AwA/dsh-prompt-optimizer',commit:'84674b1e6c8a7a032dc390180360469ba35ba71f',version:'0.7.4',engine:'Original po06 interpreter, reducer, compiler, pipeline, strategy and read-only tools; bundled from source without rewriting their prompts.'},null,2)+'\n');
console.log('Built omd-prompt-optimizer (no Bash runtime or production self-checks).');
