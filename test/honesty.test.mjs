/**
 * Unknown is never a pass -- on both sides of the comparison.
 *
 * `clean` is the only word this tool uses that makes a claim about ABSENCE, and
 * every test here attacks it. Each one constructs a run where something was not
 * examined and asserts that the report says so, rather than reporting the
 * quieter half of what it saw.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, validateConfig } from '../src/index.mjs'
import { fieldNamed, reportFor, ruleIds, runCli, withTempDir, writeJson } from './helpers.mjs'

const BIDI_MARK = String.fromCharCode(0x200e)

test('a record that is not an object makes every field undetermined, not clean', () => {
  const report = reportFor([{ note: 'x' }, null, { note: 'y' }])
  assert.equal(report.summary.recordsRead, 2)
  assert.equal(fieldNamed(report, 'note').classification, 'undetermined')
  assert.equal(report.summary.clean, 0)
  assert.ok(ruleIds(report).includes('record-invalid'))
  assert.equal(report.status, 'incomplete')
})

test('a value past the length limit makes ITS field undetermined and leaves the others alone', () => {
  const report = reportFor(
    [{ long: 'x'.repeat(40), short: 'ok' }],
    { limits: { maxValueLength: 8 } },
  )
  assert.equal(fieldNamed(report, 'long').classification, 'undetermined')
  assert.equal(fieldNamed(report, 'long').values.examined, 0)
  // The scope matters: over-refusing is its own defect, and a field whose every
  // value was examined is still entitled to the verdict it earned.
  assert.equal(fieldNamed(report, 'short').classification, 'clean')
  assert.equal(report.summary.clean, 1)
  assert.equal(report.summary.undetermined, 1)
  assert.equal(report.status, 'incomplete')
})

test('a whole number wider than a JSON reader keeps is not examined, and the field says so', () => {
  const report = reportFor([{ account: 9007199254740993 }])
  const entry = fieldNamed(report, 'account')
  assert.equal(entry.values.examined, 0)
  assert.equal(entry.values.notExact, 1)
  assert.equal(entry.classification, 'undetermined')
  assert.deepEqual(ruleIds(report), ['value-not-exactly-representable'])
  assert.equal(report.status, 'incomplete')
})

test('an export shape this tool does not read stays unknown: nothing is examined and nothing is claimed', async () => {
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      dataset: 'from-somewhere-else',
      source: 'columnar-shard-v9',
      records: [{ contact: 'ada@example.test' }],
    })
    const result = await runCli(['--dataset', path, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-source-unsupported'])
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(report.fields, [])
    // The address in that document is real enough to match a recogniser. An
    // unsupported shape must not produce a verdict about it either way.
    assert.equal(result.stdout.includes('ada@example.test'), false)
  })
})

test('a dataset with no records is an error, never a green run on no evidence', () => {
  const report = reportFor([])
  assert.deepEqual(ruleIds(report), ['no-fields-checked'])
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
})

test('a run whose only finding is a warning still exits 2, because the question stayed open', async () => {
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      source: 'tabular-export',
      records: [{ ref: '987-65-4320' }, { ref: 'AB-1' }, { ref: 'AB-2' }, { ref: 'AB-3' }],
    })
    const result = await runCli(['--dataset', path, '--json'])
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['classification-uncertain'])
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 1)
    // Membership of the unsettled set is the ONLY thing between this warning
    // and exit 0, which is exactly why the exit code is asserted rather than
    // the membership.
    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
  })
})

test('acknowledging a field settles presence, and settles nothing about a value nobody examined', () => {
  const report = reportFor(
    [{ contact: 'ada@example.test' }, { contact: 'x'.repeat(40) }],
    { acknowledged: ['contact'], limits: { maxValueLength: 20 } },
  )
  const entry = fieldNamed(report, 'contact')
  assert.equal(entry.classification, 'personal-data')
  assert.equal(entry.acknowledged, true)
  assert.deepEqual(ruleIds(report).sort(), ['personal-data-acknowledged', 'value-too-long'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'incomplete')
})

test('an acknowledged entry that prints as nothing is refused, not dropped from the index', () => {
  // Evidence dropped while building an index makes every comparison against it
  // incomplete. The acknowledged list is such an index, so an entry that cannot
  // be used is refused up front rather than quietly discarded -- a discarded
  // entry would silently un-acknowledge a field.
  assert.throws(() => validateConfig({ schemaVersion: '1', acknowledged: [BIDI_MARK] }), ConfigError)
  assert.throws(() => validateConfig({ schemaVersion: '1', acknowledged: ['a'.repeat(513)] }), ConfigError)
  assert.throws(() => validateConfig({ schemaVersion: '1', acknowledged: ['a', 'a'] }), ConfigError)
  // A name that merely SURVIVES sanitising is refused too: `a<U+0001>b` prints
  // as `a b`, so accepting it would acknowledge a field that is not this one.
  assert.throws(
    () => validateConfig({ schemaVersion: '1', acknowledged: [`a${String.fromCharCode(1)}b`] }),
    ConfigError,
  )
  assert.equal(validateConfig({ schemaVersion: '1', acknowledged: ['a b'] }).acknowledged.length, 1)
  assert.equal(validateConfig({ schemaVersion: '1', acknowledged: ['a'.repeat(512)] }).acknowledged.length, 1)
})

test('a key that prints as nothing takes its values out of the examination, and says so', () => {
  const report = reportFor([{ [BIDI_MARK]: 'ada@example.test', ok: 'plain' }])
  assert.equal(report.summary.fields, 1)
  assert.equal(fieldNamed(report, 'ok').classification, 'undetermined')
  assert.ok(ruleIds(report).includes('field-path-unusable'))
  assert.equal(report.status, 'incomplete')
})

test('two categories above the floor are both named; the presence is settled and the category is not', () => {
  const report = reportFor(
    [
      { full_name: 'ada@example.test' },
      { full_name: 'grace@example.test' },
      { full_name: 'alan@example.test' },
      { full_name: 'edsger@example.test' },
    ],
    { minConfidence: 'low' },
  )
  const entry = fieldNamed(report, 'full_name')
  assert.equal(entry.classification, 'personal-data')
  assert.equal(entry.categoryCertain, false)
  assert.deepEqual(entry.categories, ['email', 'person-name'])
  assert.equal(entry.category, 'email')
  assert.deepEqual(ruleIds(report).sort(), ['classification-ambiguous', 'personal-data-detected'])
  // An open CATEGORY is not an open DETECTION: the field holds personal data
  // either way, so this is a policy failure and not missing evidence.
  assert.equal(report.status, 'fail')
})

test('a field of booleans and nulls is examined in full and reported with the counts behind it', () => {
  const report = reportFor([{ active: true }, { active: false }, { active: null }])
  const entry = fieldNamed(report, 'active')
  assert.equal(entry.classification, 'clean')
  assert.equal(entry.values.examined, 0)
  assert.equal(entry.values.notApplicable, 3)
  assert.equal(entry.values.unexamined, 0)
  assert.equal(report.status, 'pass')
})

test('the report names what this kind of evidence never settles', () => {
  const report = reportFor([{ note: 'x' }])
  assert.ok(report.disclaimer.includes('only when every one of its values was examined'))
  assert.equal(report.notEstablished.length, 4)
  assert.ok(report.notEstablished.some((line) => line.includes('belongs to a real person')))
})
