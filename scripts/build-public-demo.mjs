import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const defaultOutput=join(projectRoot,'public-demo-dist');
const fontNames=['instrument-sans-latin-wght-normal.woff2','instrument-sans-latin-ext-wght-normal.woff2',
  'newsreader-latin-standard-normal.woff2','newsreader-latin-ext-standard-normal.woff2'];

export async function buildPublicDemo(outputDirectory=defaultOutput) {
  const output=resolve(outputDirectory),fonts=join(output,'fonts');await mkdir(fonts,{recursive:true});
  const html=await readFile(join(projectRoot,'preflight.html'),'utf8');
  const staticHtml=html.replace('<script type="module" src="/preflight.mjs"></script>',
    '<script type="module" src="/public-demo.mjs"></script>');
  if(staticHtml===html)throw new Error('PREFLIGHT_ENTRY_NOT_FOUND');
  await Promise.all([
    writeFile(join(output,'index.html'),staticHtml,'utf8'),
    copyFile(join(projectRoot,'public','preflight.css'),join(output,'preflight.css')),
    copyFile(join(projectRoot,'public','public-demo.mjs'),join(output,'public-demo.mjs')),
    copyFile(join(projectRoot,'public','replay-examples.mjs'),join(output,'examples.mjs')),
    ...fontNames.map(name=>copyFile(join(projectRoot,'public','fonts',name),join(fonts,name)))
  ]);
  return {output,files:['index.html','preflight.css','public-demo.mjs','examples.mjs',...fontNames.map(name=>'fonts/'+name)]};
}

export async function generatePublicReplayFixtures(outputFile=join(projectRoot,'public','replay-examples.mjs')) {
  const {REPLAY_EXAMPLES,runReplayExample}=await import('../src/preflight/examples.mjs');
  const examples=Object.fromEntries(REPLAY_EXAMPLES.map(name=>[name,runReplayExample(name)]));
  await writeFile(outputFile,`export const PUBLIC_REPLAY_EXAMPLES=Object.freeze(${JSON.stringify(examples,null,2)});\n`,'utf8');
  return examples;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv[2]==='--refresh-fixtures')await generatePublicReplayFixtures();
  const result=await buildPublicDemo(process.argv[2]&&process.argv[2]!=='--refresh-fixtures'?process.argv[2]:defaultOutput);
  console.log(`Public demo built: ${result.files.length} files`);
}

