import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReport } from '../src/preflight/domain.mjs';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export async function verifyReportFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_REPORT_BYTES) {
      return { ok: false, code: 'REPORT_FILE_INVALID' };
    }
    const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_REPORT_BYTES) return { ok: false, code: 'REPORT_FILE_INVALID' };
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    const result = verifyReport(report);
    if (!result.ok) return result;
    return {
      ...result,
      mode: report.mode,
      verdict: report.verdict,
      reportHash: report.reportHash,
      publication: 'LOCAL_ONLY',
    };
  } catch {
    return { ok: false, code: 'REPORT_FILE_INVALID' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/verify-preflight-report.mjs <report.json>\n');
    process.exitCode = 2;
  } else {
    const result = await verifyReportFile(resolve(process.argv[2]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
