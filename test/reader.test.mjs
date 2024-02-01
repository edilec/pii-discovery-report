/**
 * The guards in the dataset reader, one at a time.
 *
 * A mutation sweep removed each of these and the suite stayed green. They are
 * not all the same weight -- one turns a counted subtree into a silently
 * skipped one, another only changes a message -- but a guard nothing fails on
 * is a guard that will quietly stop being there, and the message is the whole
 * value of a refusal to whoever has to act on it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, discoverPersonalData, observeRecords, validateConfig } from '../src/index.mjs'
import {
  EXAMPLES,
  datasetDocument,
  fieldNamed,
  findingFor,
  reportFor,
  ruleIds,
  runCli,
  withTempDir,
  writeJson,
  writeText,
} from './helpers.mjs'

test('a directory named as the dataset is unreadable, and says which kind of thing it is', async () => {
  const result = await runCli(['--dataset', EXAMPLES, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-unreadable'])
  assert.match(report.findings[0].message, /not a regular file/u)
})

test('a document that is not a JSON object is refused as one, whatever else it is', async () => {
  await withTempDir(async (directory) => {
    for (const [name, text] of [['array.json', '[]'], ['string.json', '"a document"'], ['null.json', 'null']]) {
      const path = await writeText(directory, name, text)
      const result = await runCli(['--dataset', path, '--json'])
      assert.equal(result.code, 2, name)
      const report = JSON.parse(result.stdout)
      assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-invalid'], name)
      assert.match(report.findings[0].message, /the document is not a JSON object/u, name)
    }
  })
})

test('a dataset name that would not print as it is stored is refused, not printed', async () => {
  await withTempDir(async (directory) => {
    for (const name of [7, '', `‎‏`, 'x'.repeat(129)]) {
      const path = await writeJson(directory, 'dataset.json', {
        schemaVersion: '1', dataset: name, source: 'tabular-export', records: [{ a: 'b' }],
      })
      const result = await runCli(['--dataset', path, '--json'])
      assert.equal(result.code, 2, String(name))
      const report = JSON.parse(result.stdout)
      assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-invalid'], String(name))
      assert.match(report.findings[0].message, /the dataset name is not a printable string/u)
      assert.equal(report.dataset.name, null)
    }
    // And the name next to those: a printable one is carried through.
    const fine = await writeJson(directory, 'fine.json', {
      schemaVersion: '1', dataset: 'crm-export', source: 'tabular-export', records: [{ a: 'b' }],
    })
    const ok = JSON.parse((await runCli(['--dataset', fine, '--json'])).stdout)
    assert.equal(ok.dataset.name, 'crm-export')
  })
})

test('a recogniser left out of the configuration takes its masked examples with it too', () => {
  // Removing the enabled check leaves the candidate out of the report, because
  // candidates are built from the configured list -- and quietly keeps the
  // masked example, so a field with no candidate arrives carrying a mask of
  // something that matched a recogniser nobody asked for.
  const records = [{ contact: 'ada@example.test' }, { contact: 'grace@example.test' }]
  const withEmail = reportFor(records)
  assert.deepEqual(withEmail.fields[0].maskedExamples, ['xxx@xxxxxxx.xxxx', 'xxxxx@xxxxxxx.xxxx'])

  const withoutEmail = reportFor(records, { recognisers: ['payment-card', 'phone-number'] })
  assert.deepEqual(withoutEmail.fields[0].candidates, [])
  assert.deepEqual(withoutEmail.fields[0].maskedExamples, [])
  assert.equal(withoutEmail.fields[0].classification, 'clean')
})

test('the field limit reports how many values it could not attribute, not just that it fired', () => {
  const records = [{ a: '1', b: '2', c: '3' }, { a: '4', b: '5', c: '6' }]
  const report = reportFor(records, { limits: { maxFields: 1 } })
  assert.ok(ruleIds(report).includes('field-limit-exceeded'))
  // Four values -- two each in `b` and `c` -- were not attributed to any field.
  assert.match(findingFor(report, 'field-limit-exceeded').message, /so 4 value or values were not attributed/u)

  const { state } = observeRecords(records, validateConfig({ schemaVersion: '1', limits: { maxFields: 2 } }).limits, [])
  assert.equal(state.droppedObservations, 2)
})

test('a subtree too deep is counted inside an array as well as inside an object', () => {
  // Two branches of the walk increment the same counter, and only one of them
  // was driven: an array level past the limit was silently skipped, with no
  // finding and nothing to say a value had gone unexamined.
  const inArray = reportFor([{ rows: [[{ contact: 'ada@example.test' }]] }], { limits: { maxDepth: 2 } })
  assert.ok(ruleIds(inArray).includes('record-too-deep'), 'an array past the limit must be counted')
  assert.match(findingFor(inArray, 'record-too-deep').message, /1 subtree or subtrees are nested deeper/u)
  assert.match(findingFor(inArray, 'record-too-deep').message, /first at rows\[\]/u)
  assert.equal(inArray.status, 'incomplete')

  const inObject = reportFor([{ rows: { one: { contact: 'ada@example.test' } } }], { limits: { maxDepth: 2 } })
  assert.ok(ruleIds(inObject).includes('record-too-deep'))
  assert.match(findingFor(inObject, 'record-too-deep').message, /first at rows.one/u)

  // Both sides: at exactly the limit each shape is walked and examined.
  const atLimit = reportFor([{ rows: [{ contact: 'ada@example.test' }] }], { limits: { maxDepth: 3 } })
  assert.equal(ruleIds(atLimit).includes('record-too-deep'), false)
  assert.equal(fieldNamed(atLimit, 'rows[].contact').values.examined, 1)
})

test('the library refuses a missing dataset path as configuration, not as an execution failure', async () => {
  // The CLI requires --dataset, so this guard is reachable only through the
  // module -- and without it the path resolver throws a TypeError, which the
  // entry point reports as "Execution failure": a defect in this tool, said out
  // loud, for what is really a caller's mistake.
  for (const dataset of [undefined, null, '', 7]) {
    await assert.rejects(
      () => discoverPersonalData({ dataset }),
      (error) => {
        assert.ok(error instanceof ConfigError, String(dataset))
        assert.match(error.message, /A dataset path is required/u)
        return true
      },
    )
  }
})

test('a dataset the reader accepts still reaches the same report through the module', async () => {
  // The other side of the guard above: the module path works.
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', datasetDocument([
      { contact: 'ada@example.test' }, { contact: 'grace@example.test' },
    ]))
    const report = await discoverPersonalData({ dataset: path })
    assert.equal(report.status, 'fail')
    assert.equal(report.dataset.file, 'dataset.json')
  })
})
