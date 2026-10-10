import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import ts from 'typescript'

/** Derive routing from the same source as the compiled Worker. Export only a
 * boolean/hash, never the password. Missing/mismatched metadata fails closed. */
export async function writeAssetRouting(root) {
  const filename = resolve(root, 'uptime.config.ts')
  const source = await readFile(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  new Function('exports', 'require', 'module', compiled)(exports, createRequire(filename), {
    exports,
  })
  const value = {
    sourceHash: createHash('sha256').update(source).digest('hex'),
    protected: !!exports.workerConfig?.passwordProtection,
  }
  await writeFile(resolve(root, 'out/_worker-routing.json'), JSON.stringify(value))
  return value
}
