import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { RESERVED_ROUTE_LITERAL, START_EXPORT, STDOUT_CALL, UNGUARDED_SERVER } from '../contract.mjs';
import { pathExists } from '../fs.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export async function checkNode(report, { packageDir, entry, nodeRoots }) {
  const scripts = new Set();
  for (const root of nodeRoots) {
    const absolute = path.join(packageDir, ...root.split('/'));
    if (await pathExists(absolute, 'directory')) {
      for (const file of await collectScripts(absolute, root)) scripts.add(file);
    } else if (SCRIPT_EXTENSIONS.has(path.extname(root)) && (await pathExists(absolute, 'file'))) {
      scripts.add(root);
    }
  }
  if (entry) scripts.add(entry);

  for (const relativePath of [...scripts].sort()) {
    const absolute = path.join(packageDir, ...relativePath.split('/'));
    if (!(await pathExists(absolute, 'file'))) continue;
    const isEntry = relativePath === entry;
    if (path.extname(relativePath) !== '.js') {
      try {
        await execFileAsync(process.execPath, ['--check', absolute], { windowsHide: true });
      } catch (error) {
        report.error('ENTRY_SYNTAX', firstLine(error.stderr) || 'syntax check failed', relativePath);
        continue;
      }
    }
    const source = await readFile(absolute, 'utf8');
    if (STDOUT_CALL.test(source)) {
      const message = 'writes to stdout, which belongs to the Host; log through context.logger instead';
      if (isEntry) report.error('ENTRY_STDOUT', message, relativePath);
      else report.warning('ENTRY_STDOUT', message, relativePath);
    }
    if (isEntry && !START_EXPORT.test(source)) {
      report.error('ENTRY_START_EXPORT_MISSING', 'the Node entry must export a named start function using ESM syntax', relativePath);
    }
    if (UNGUARDED_SERVER.test(source)) {
      report.warning('NODE_UNGUARDED_SERVER', "creates an https, http2, net, or tls server; the Host's loopback guard covers only node:http, so context.listen.port must be served by node:http or the Mini App never becomes ready", relativePath);
    }
    if (RESERVED_ROUTE_LITERAL.test(source)) {
      report.warning('NODE_RESERVED_ROUTE', 'mentions a /__mavis/ route; the Host reserves that prefix and plugin routes under it do not work', relativePath);
    }
  }
}

async function collectScripts(absoluteDir, relativeDir) {
  const files = [];
  for (const dirent of await readdir(absoluteDir, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (dirent.name.toLowerCase() === 'node_modules') continue;
      files.push(...(await collectScripts(path.join(absoluteDir, dirent.name), relativePath)));
    } else if (dirent.isFile() && SCRIPT_EXTENSIONS.has(path.extname(dirent.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

function firstLine(text) {
  return typeof text === 'string' ? text.split(/\r?\n/u).find((line) => line.trim()) ?? '' : '';
}
