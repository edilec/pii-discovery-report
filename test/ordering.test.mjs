/**
 * Ordering is observable, and it is pinned behaviourally.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. These inputs are chosen because code-unit order and collation order
 * genuinely disagree about them, and the test asserts the emitted order.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit } from '../src/index.mjs'
import { reportFor, runCli, withTempDir, writeJson } from './helpers.mjs'

// `Z` (0x5A) precedes `a` (0x61) by code unit and follows it by collation;
// `-` (0x2D) precedes `_` (0x5F) by code unit and is ignorable punctuation to a
// collator. Both disagreements were measured in this catalog.
const NAMES = ['alpha', 'assets', 'a_b', 'a-b', 'Zulu', 'README']

function recordsWithNames() {
  return [
    Object.fromEntries(NAMES.map((name, index) => [name, `p${index}@example.test`])),
    Object.fromEntries(NAMES.map((name, index) => [name, `q${index}@example.test`])),
  ]
}

test('fields and findings come out in UTF-16 code-unit order', () => {
  const report = reportFor(recordsWithNames(), { minConfidence: 'low' })
  const paths = report.fields.map((entry) => entry.path)
  assert.deepEqual(paths, ['README', 'Zulu', 'a-b', 'a_b', 'alpha', 'assets'])
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    ['/README', '/Zulu', '/a-b', '/a_b', '/alpha', '/assets'],
  )

  // Without this the test would pass under a collator too, and an assertion
  // that cannot fail is not a test.
  const collated = [...paths].sort((a, b) => new Intl.Collator('en').compare(a, b))
  assert.notDeepEqual(collated, paths)
})

test('two findings about one field sort by rule id', () => {
  const report = reportFor(
    [
      { full_name: 'ada@example.test' },
      { full_name: 'grace@example.test' },
      { full_name: 'alan@example.test' },
      { full_name: 'edsger@example.test' },
    ],
    { minConfidence: 'low' },
  )
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['classification-ambiguous', 'personal-data-detected'],
  )
})

test('candidates are ordered strongest first, and ties break by recogniser id', () => {
  const report = reportFor(
    [
      { full_name: 'ada@example.test' },
      { full_name: 'grace@example.test' },
      { full_name: 'alan@example.test' },
      { full_name: 'edsger@example.test' },
    ],
    { minConfidence: 'low' },
  )
  const entry = report.fields[0]
  assert.deepEqual(entry.candidates.map((candidate) => candidate.recogniser), ['email-address', 'person-name'])
  assert.deepEqual(entry.candidates.map((candidate) => candidate.confidence), ['high', 'low'])
})

test('masked examples are ordered by code unit, not by the order the records arrived in', () => {
  const forwards = reportFor([{ m: 'bb@example.test' }, { m: 'a@example.test' }])
  const backwards = reportFor([{ m: 'a@example.test' }, { m: 'bb@example.test' }])
  assert.deepEqual(forwards.fields[0].maskedExamples, ['x@xxxxxxx.xxxx', 'xx@xxxxxxx.xxxx'])
  assert.deepEqual(forwards.fields[0].maskedExamples, backwards.fields[0].maskedExamples)
})

test('byCodeUnit is a total order over the cases collation disagrees about', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('running the CLI twice over one dataset produces byte-identical stdout', async () => {
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      dataset: 'repeatable',
      source: 'tabular-export',
      records: recordsWithNames(),
    })
    const first = await runCli(['--dataset', path, '--json'])
    const second = await runCli(['--dataset', path, '--json'])
    assert.equal(first.stdout, second.stdout)
    assert.equal(first.code, second.code)
    assert.ok(first.stdout.length > 500)
  })
})
