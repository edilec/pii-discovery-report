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

import {
  CATEGORIES,
  RECOGNISER_IDS,
  RULE_IDS,
  byCodeUnit,
  compareFindings,
  sortFindings,
} from '../src/index.mjs'
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

test('masked examples are ordered by code unit, and a collator disagrees about these', () => {
  // A sweep put a collator on this sort and nothing failed. These two masks are
  // the disagreement: by code unit `#.#.#.#` follows `##.#.#.#`, because `.`
  // (0x2E) follows `#` (0x23); a collator puts them the other way round.
  const addresses = ['1.2.3.4', '10.4.0.2', '1.2.3.4', '10.4.0.2']
  const forwards = reportFor(addresses.map((source) => ({ source })))
  const backwards = reportFor([...addresses].reverse().map((source) => ({ source })))
  assert.deepEqual(forwards.fields[0].maskedExamples, ['##.#.#.#', '#.#.#.#'])
  assert.deepEqual(backwards.fields[0].maskedExamples, forwards.fields[0].maskedExamples)

  const collated = [...forwards.fields[0].maskedExamples].sort((a, b) => new Intl.Collator('en').compare(a, b))
  assert.notDeepEqual(collated, forwards.fields[0].maskedExamples)
})

test('compareFindings orders by file, then pointer, then rule, then message, each by code unit', () => {
  // The file, rule and message terms cannot be reached from a single report:
  // one run reports one file, and no two findings in it share a pointer AND a
  // rule id. So the exported comparator is driven directly, with the pairs a
  // collator disagrees about, and the reason is written down rather than left
  // for the next reader to rediscover.
  const finding = (file, pointer, ruleId, message) => ({ location: { file, pointer }, ruleId, message })
  const sorted = sortFindings([
    finding('a.json', '/x', 'r', 'm'),
    finding('Z.json', '/x', 'r', 'm'),
    finding('README.json', '/x', 'r', 'm'),
  ])
  assert.deepEqual(sorted.map((entry) => entry.location.file), ['README.json', 'Z.json', 'a.json'])

  assert.equal(compareFindings(finding('d', '/p', 'a-b', 'm'), finding('d', '/p', 'a_b', 'm')), -1)
  assert.equal(compareFindings(finding('d', '/p', 'r', 'a-b'), finding('d', '/p', 'r', 'a_b')), -1)
  assert.equal(compareFindings(finding('d', '/p', 'r', 'Zulu'), finding('d', '/p', 'r', 'assets')), -1)
  // A collator says the opposite about every one of those three pairs.
  const collator = new Intl.Collator('en')
  assert.equal(collator.compare('a-b', 'a_b'), 1)
  assert.equal(collator.compare('Zulu', 'assets'), 1)
})

test('the ids this tool sorts cannot disagree with a collator, and the grammar is why', () => {
  // Three sort sites -- RULE_IDS, the categories listed beside an ambiguous
  // field, and the candidate tie-break by recogniser id -- survive a collator
  // substitution, and this is the reason rather than a missing test: every id
  // in this tool is lower-case letters, digits and hyphens, and no pair of them
  // orders differently under the two rules. The grammar is pinned here so that
  // an id with an underscore or a capital cannot arrive without this test
  // failing and the equivalence being reconsidered.
  const collator = new Intl.Collator('en')
  for (const [label, ids] of [['rules', RULE_IDS], ['categories', CATEGORIES], ['recognisers', RECOGNISER_IDS]]) {
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/u, `${label}: ${id}`)
    assert.deepEqual([...ids].sort(byCodeUnit), [...ids].sort((a, b) => collator.compare(a, b)), label)
  }
  // The order itself, so that a rule renamed or removed is visible here.
  assert.deepEqual([...RULE_IDS], [...RULE_IDS].sort(byCodeUnit))
  assert.equal(RULE_IDS[0], 'classification-ambiguous')
  assert.equal(RULE_IDS[RULE_IDS.length - 1], 'value-too-long')
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
