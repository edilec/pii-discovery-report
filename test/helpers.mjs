import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { buildReport, observeRecords, validateConfig } from '../src/index.mjs'

const run = promisify(execFile)

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const BIN = join(ROOT, 'bin', 'pii-discovery-report.mjs')
export const EXAMPLES = join(ROOT, 'examples')

/** Build a report from records in process: no file system, no child process. */
export function reportFor(records, configDocument = {}) {
  const config = validateConfig({ schemaVersion: '1', ...configDocument })
  const { fields, state } = observeRecords(records, config.limits, config.recognisers)
  return buildReport({
    fields,
    state,
    records,
    config,
    file: 'dataset.json',
    dataset: { name: 'test-export', source: 'tabular-export' },
  })
}

export function fieldNamed(report, path) {
  return report.fields.find((entry) => entry.path === path) ?? null
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingFor(report, ruleId, pointer = null) {
  return report.findings.find(
    (finding) => finding.ruleId === ruleId && (pointer === null || finding.location.pointer === pointer),
  ) ?? null
}

export function datasetDocument(records, extra = {}) {
  return {
    schemaVersion: '1',
    dataset: 'test-export',
    source: 'tabular-export',
    records,
    ...extra,
  }
}

export async function withTempDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'pii-discovery-report-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function writeJson(directory, name, value) {
  const path = join(directory, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

export async function writeText(directory, name, text) {
  const path = join(directory, name)
  await writeFile(path, text, 'utf8')
  return path
}

/** Run the real CLI and report exactly what a shell would see. */
export async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}
