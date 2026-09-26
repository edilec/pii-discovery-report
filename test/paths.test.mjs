/**
 * Field-path identity.
 *
 * A path is composed from document keys, and a document key may legally contain
 * the characters a path is composed from. Joining them raw made two different
 * fields one line of the report: a flat column named `contact.email` and a
 * nested `contact` object holding `email` shared one entry, one merged match
 * rate and one pointer, and one `acknowledged` entry silenced the other -- exit
 * 0, status `pass`, over a field the configuration never named.
 *
 * Every test here drives the real report path, and the CLI test drives the real
 * entry point, because the thing that must not happen is an exit code.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { escapePathSegment, fieldNameOf, pointerForPath, splitFieldPath } from '../src/index.mjs'
import { datasetDocument, fieldNamed, reportFor, runCli, withTempDir, writeJson } from './helpers.mjs'

const REFERENCES = ['INT-0001', 'INT-0002', 'INT-0003', 'INT-0004']
const ADDRESSES = ['ada@example.test', 'grace@example.test', 'alan@example.test', 'edsger@example.test']

/** Four records holding BOTH a flat `contact.email` column and a nested contact->email. */
function collidingRecords() {
  return REFERENCES.map((reference, index) => ({
    'contact.email': reference,
    contact: { email: ADDRESSES[index] },
  }))
}

test('a dotted key and a nested field are two fields, with their own counts and pointers', () => {
  const report = reportFor(collidingRecords())
  assert.equal(report.summary.fields, 2)

  const nested = fieldNamed(report, 'contact.email')
  const flat = fieldNamed(report, 'contact\\.email')
  assert.notEqual(nested, null)
  assert.notEqual(flat, null)
  assert.equal(nested.pointer, '/contact/email')
  assert.equal(flat.pointer, '/contact\\.email')

  // The merged entry reported 4 matches of 8 values examined, a match rate of
  // 0.5 for two fields that are 1.0 and 0.0.
  assert.equal(nested.values.examined, 4)
  assert.equal(nested.values.matched, 4)
  assert.equal(nested.candidates[0].matchRate, 1)
  assert.equal(nested.classification, 'personal-data')
  assert.equal(flat.values.examined, 4)
  assert.equal(flat.values.matched, 0)
  assert.deepEqual(flat.candidates, [])
  assert.equal(flat.classification, 'clean')
})

test('acknowledging the dotted column does not silence the nested field', async () => {
  // The exit code is the assertion: this is the run that came back 0 and
  // "pass" over four addresses nobody had declared.
  await withTempDir(async (directory) => {
    const dataset = await writeJson(directory, 'collision.json', datasetDocument(collidingRecords()))
    const config = await writeJson(directory, 'config.json', {
      schemaVersion: '1',
      acknowledged: ['contact\\.email'],
    })
    const result = await runCli(['--dataset', dataset, '--config', config, '--json'])
    assert.equal(result.code, 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'fail')
    const detected = report.findings.find((finding) => finding.ruleId === 'personal-data-detected')
    assert.notEqual(detected, undefined)
    assert.equal(detected.severity, 'error')
    assert.equal(detected.location.pointer, '/contact/email')
    const acknowledged = report.findings.find((finding) => finding.ruleId === 'personal-data-acknowledged')
    assert.equal(acknowledged.location.pointer, '/contact\\.email')
  })
})

test('a key named for the array marker is not the array', () => {
  const report = reportFor([
    { 'tags[]': 'ada@example.test', tags: ['INT-0001'] },
    { 'tags[]': 'grace@example.test', tags: ['INT-0002'] },
  ])
  const literal = fieldNamed(report, 'tags\\[\\]')
  const array = fieldNamed(report, 'tags[]')
  assert.equal(literal.pointer, '/tags\\[\\]')
  assert.equal(array.pointer, '/tags[]')
  assert.equal(literal.classification, 'personal-data')
  assert.equal(array.classification, 'clean')
})

test('the name a recogniser is asked about is the last KEY, not the text after the last dot', () => {
  // `user.full_name` as one flat column is not a column named for people: the
  // name the exporter wrote is `user.full_name`, and reading `full_name` out of
  // it invents a column that is not in the document.
  const report = reportFor(
    [{ 'user.full_name': 'Hex Bolt M8', user: { full_name: 'Avery Stone' } }],
    { minConfidence: 'low' },
  )
  assert.equal(fieldNamed(report, 'user\\.full_name').classification, 'clean')
  assert.equal(fieldNamed(report, 'user.full_name').classification, 'personal-data')
  assert.equal(fieldNameOf('user\\.full_name'), 'user.full_name')
  assert.equal(fieldNameOf('user.full_name'), 'full_name')
})

test('escaping a segment and splitting a path are exact inverses', () => {
  for (const key of ['contact.email', 'tags[]', 'a\\b', 'plain', '[]', 'a.b[].c', '\\', '.']) {
    assert.deepEqual(splitFieldPath(escapePathSegment(key)), [{ key, arrays: 0, segment: escapePathSegment(key) }], key)
  }
  // Composed paths, one entry per level, with the array levels counted.
  assert.deepEqual(
    splitFieldPath('orders[][].id').map(({ key, arrays }) => [key, arrays]),
    [['orders', 2], ['id', 0]],
  )
  assert.equal(pointerForPath('orders[].contact\\.email'), '/orders[]/contact\\.email')
})
