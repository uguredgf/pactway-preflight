import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectLatestPreflightReport,preparePreflightFujiPublication} from './lib/preflight-fuji-publication.mjs';

export async function preparePreflightFujiFiles(inputPaths,outputPath) {
  if(!Array.isArray(inputPaths) || inputPaths.length===0)throw new Error('PREFLIGHT_REPORT_REQUIRED');
  const reports=[];
  for(const inputPath of inputPaths)reports.push(JSON.parse(await readFile(resolve(inputPath),'utf8')));
  const selected=selectLatestPreflightReport(reports);
  const manifest=await preparePreflightFujiPublication(selected);
  await writeFile(resolve(outputPath),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),separator=args.indexOf('--output');
  if(separator<1 || separator!==args.length-2) {
    process.stderr.write('Usage: node scripts/prepare-preflight-fuji-publication.mjs <report.json> [more-report.json ...] --output <manifest.json>\n');
    process.exitCode=2;
  } else {
    try {
      const manifest=await preparePreflightFujiFiles(args.slice(0,separator),args.at(-1));
      process.stdout.write(JSON.stringify({status:manifest.status,submitted:manifest.submitted,reportHash:manifest.reportHash,
        taskId:manifest.taskId,output:resolve(args.at(-1))})+'\n');
    } catch(error) {
      process.stderr.write(`${/^PREFLIGHT_|^FUJI_/.test(error?.message)?error.message:'PREFLIGHT_FUJI_PREPARATION_FAILED'}\n`);
      process.exitCode=1;
    }
  }
}
