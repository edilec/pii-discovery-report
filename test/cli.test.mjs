/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * EMPTY and the message goes to stderr. Unreadable evidence means the run had a
 * subject and failed to obtain evidence about it, so stdout carries an
 * `incomplete` report naming what was not examined. A consumer that pipes
 * stdout has to handle both, which is why both are pinned.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { EXAMPLES, ROOT, runCli, withTempDir, writeJson, writeText } from './helpers.mjs'

const CLEAN = join(EXAMPLES, 'clean', 'dataset.json')
const SEEDED = join(EXAMPLES, 'seeded', 'dataset.json')
const SEEDED_CONFIG = join(EXAMPLES, 'seeded', 'config.json')
const INCOMPLETE = join(EXAMPLES, 'incomplete', 'dataset.json')
const INCOMPLETE_CONFIG = join(EXAMPLES, 'incomplete', 'config.json')

test('--help prints the help on stderr, leaves stdout empty and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag])
    assert.equal(result.code, 0, flag)
    assert.equal(result.stdout, '', flag)
    assert.ok(result.stderr.includes('Usage:'), flag)
    assert.ok(result.stderr.includes('Exit codes:'), flag)
  }
})

test('the help states the three exit codes and the two shapes of exit 2', async () => {
  const { stderr } = await runCli(['--help'])
  assert.ok(stderr.includes('stdout stays EMPTY'))
  assert.ok(stderr.includes('incomplete'))
  assert.ok(stderr.includes('writes no file'))
})

test('exit 0 with every field acknowledged, exactly as both documents describe it', async () => {
  // The defect this pins was in the prose, not the code. The exit-code table
  // said 0 meant "none reached the configured confidence" and the help said
  // "no field reached the configured confidence"; both are false for every run
  // whose fields are acknowledged, which is the run below.
  await withTempDir(async (directory) => {
    const config = await writeJson(directory, 'acknowledged.json', {
      schemaVersion: '1',
      acknowledged: [
        'contact.email', 'contact.phone', 'date_of_birth', 'full_name',
        'government_id', 'last_seen_ip', 'legacy_ref', 'payment.card_number',
      ],
    })
    const result = await runCli([
      '--dataset', join(EXAMPLES, 'seeded', 'dataset.json'), '--config', config, '--json',
    ])
    assert.equal(result.code, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.personalData, 8)
    assert.equal(report.summary.errors, 0)
    const high = report.fields.filter((entry) => entry.confidence === 'high')
    assert.equal(high.length, 6)
    for (const entry of high) assert.equal(entry.classification, 'personal-data')
  })

  // And both documents now say so where a reader looks for it.
  const help = (await runCli(['--help'])).stderr
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const helpExitZero = help.slice(help.indexOf('  0  '), help.indexOf('  1  '))
  const readmeExitZero = readme.slice(readme.indexOf('| `0` |'), readme.indexOf('| `1` |'))
  assert.match(helpExitZero, /UNACKNOWLEDGED field reached the/u)
  assert.match(helpExitZero, /still\n     reported as personal data, at info severity/u)
  assert.match(readmeExitZero, /does not\s+\*\*acknowledge\*\* reached the configured confidence/u)
  assert.match(readmeExitZero, /still reported as personal\s+data, at `info` severity/u)
})

test('an unknown option is a configuration error: empty stdout, message on stderr, exit 2', async () => {
  const result = await runCli(['--dataset', CLEAN, '--wat'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('Unknown option "--wat"'))
})

test('an option value carrying a control character cannot forge a line in the diagnostic', async () => {
  const forged = `--x${String.fromCharCode(0x0a)}Unknown option "--y"`
  const result = await runCli(['--dataset', CLEAN, forged])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('Unknown option "--x Unknown option "--y""'))
})

test('a missing --dataset is a configuration error', async () => {
  const result = await runCli([])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('--dataset is required'))
})

test('an option that needs a value and has none is refused', async () => {
  const result = await runCli(['--dataset'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('--dataset requires a value'))
})

test('a configuration file that does not exist is a configuration error, not a report', async () => {
  const result = await runCli(['--dataset', CLEAN, '--config', join(EXAMPLES, 'no-such-config.json')])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('The configuration was not read'))
})

test('an unknown configuration key is refused rather than ignored', async () => {
  await withTempDir(async (directory) => {
    const config = await writeJson(directory, 'config.json', { schemaVersion: '1', minConfidance: 'low' })
    const result = await runCli(['--dataset', CLEAN, '--config', config])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    // A one-character typo must not turn a real failure into a green run.
    assert.ok(result.stderr.includes('Unknown configuration key "minConfidance"'))
  })
})

test('a configuration that is not valid JSON is refused without being reproduced', async () => {
  await withTempDir(async (directory) => {
    const config = await writeText(directory, 'config.json', 'apikey=not-a-real-key-9f3a')
    const result = await runCli(['--dataset', CLEAN, '--config', config])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('not-a-real-key-9f3a'), false)
    assert.ok(result.stderr.includes("unexpected token 'a' at the start of the document"))
  })
})

test('--min-confidence is validated the same way the document is', async () => {
  const result = await runCli(['--dataset', CLEAN, '--min-confidence', 'certain'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('must be one of low, medium, high'))
})

test('an unreadable dataset is the OTHER shape of exit 2: a report on stdout', async () => {
  const result = await runCli(['--dataset', join(EXAMPLES, 'no-such-dataset.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-unreadable'])
  assert.equal(report.findings[0].location.file, 'no-such-dataset.json')
})

test('the human summary goes to stderr by default and is suppressed by --json', async () => {
  const noisy = await runCli(['--dataset', CLEAN])
  assert.equal(noisy.code, 0)
  assert.ok(noisy.stderr.includes('Status pass.'))
  assert.ok(noisy.stderr.includes('field(s) over'))
  JSON.parse(noisy.stdout)

  const quiet = await runCli(['--dataset', CLEAN, '--json'])
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, noisy.stdout)
})

test('the human summary says every number the report does, line for line', async () => {
  // A sweep deleted three of the lines this builds and nothing failed: the old
  // test asked whether two phrases appeared somewhere in it. The summary is
  // what a person reads in a terminal, so it is pinned whole, against a run
  // whose numbers are not all the same.
  const result = await runCli(['--dataset', SEEDED, '--config', SEEDED_CONFIG])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  const lines = result.stderr.trimEnd().split('\n')

  // One line per finding, ordered exactly as the report orders them.
  assert.equal(lines.length, report.findings.length + 5)
  for (const [index, finding] of report.findings.entries()) {
    assert.match(lines[index], new RegExp(`^${finding.severity.toUpperCase()} +${finding.ruleId} +dataset.json `, 'u'))
    assert.ok(lines[index].endsWith(finding.location.pointer), lines[index])
  }
  // A blank line, then the three count lines, then the disclaimer.
  assert.equal(lines[report.findings.length], '')
  assert.equal(
    lines[report.findings.length + 1],
    '19 field(s) over 12 record(s) read of 12; 216 value(s) examined, 0 not examined.',
  )
  assert.equal(
    lines[report.findings.length + 2],
    '8 field(s) look like personal data, 0 uncertain, 0 undetermined, 11 with every value examined '
    + 'and nothing matched.',
  )
  assert.equal(lines[report.findings.length + 3], '7 error, 0 warning, 1 info. Status fail.')
  assert.equal(lines[report.findings.length + 4], report.disclaimer)
})

test('the shipped examples run, and each ends where its name says it does', async () => {
  const clean = await runCli(['--dataset', CLEAN, '--json'])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const seeded = await runCli(['--dataset', SEEDED, '--config', SEEDED_CONFIG, '--json'])
  assert.equal(seeded.code, 1)
  assert.equal(JSON.parse(seeded.stdout).status, 'fail')

  const partial = await runCli(['--dataset', INCOMPLETE, '--config', INCOMPLETE_CONFIG, '--json'])
  assert.equal(partial.code, 2)
  const report = JSON.parse(partial.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.fields.map((entry) => entry.classification),
    ['undetermined', 'undetermined', 'undetermined'],
  )
})

test('a dataset path is never echoed back as an absolute host path', async () => {
  const result = await runCli(['--dataset', CLEAN, '--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.dataset.file, 'dataset.json')
  assert.equal(result.stdout.includes(EXAMPLES), false)
})
