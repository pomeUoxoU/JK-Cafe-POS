import {build} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
await build({entryPoints:['src/pancake-preview.tsx'],outfile:'artifacts/preview-render.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {PancakeLayers}=await import('../artifacts/preview-render.mjs');
let panels=['choco','maple','berry'].map(n=>`<section><h2>${`${n}：ホイップ・アイス・スプレー・オレオ`}</h2>${renderToStaticMarkup(createElement(PancakeLayers,{animate:false,special:false,line:{productId:'plain',syrupId:n,includedId:'cream',quantity:1,extras:[{id:'oreo',quantity:2},{id:'ice',quantity:1},{id:'sprinkles',quantity:3}]}}))}</section>`).join('');
panels=panels.replace(/src="\//g,`src="${pathToFileURL(resolve('public')).href}/`);
const css=readFileSync('src/style.css','utf8').replaceAll('url(/',`url(${pathToFileURL(resolve('public')).href}/`);
writeFileSync('artifacts/oreo-check.html',`<!doctype html><meta charset="utf-8"><style>${css}body{margin:0;padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}section{background:white;border-radius:16px;padding:10px}h2{font-size:22px}.pancake-scene{width:100%;aspect-ratio:1;height:auto}</style>${panels}`);

// Embed local files to avoid file-URL image/preload timing differences in headless capture.
import {fileURLToPath} from 'node:url';
let html=readFileSync('artifacts/oreo-check.html','utf8').replace(/<link[^>]+>/g,'');
html=html.replace(/src="(file:[^"]+)"/g,(_,url)=>{const path=fileURLToPath(url);return `src="data:image/${path.endsWith('.png')?'png':'webp'};base64,${readFileSync(path).toString('base64')}"`;});
html=html.replace(/url\((?:&quot;)?\/menu\/([^)&]+)(?:&quot;)?\)/g,(_,name)=>`url(data:image/webp;base64,${readFileSync('public/menu/'+name).toString('base64')})`);
writeFileSync('artifacts/oreo-check.html',html.replaceAll('decoding="async"','decoding="sync"'));
