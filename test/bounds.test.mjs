/**
 * Every declared limit, from BOTH sides.
 *
 * A bound has two sides and most suites only test one. "Fires at N+1" and
 * "stays silent at exactly N" are two assertions, and the second is the one
 * users notice: widening a comparison by one starts refusing documents that sit
 * exactly on a limit the documentation calls legal, with the whole suite green.
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

import {
  ConfigError,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MASK_LIMIT,
  MAX_ACKNOWLEDGED,
  MAX_FIELD_PATH_LENGTH,
  MAX_CELLS,
  MAX_CONFIG_BYTES,
  MAX_NODES,
  MAX_MASKED_EXAMPLES,
  MAX_PATH_LENGTH,
  countNodes,
  maskValue,
  validateConfig,
} from '../src/index.mjs'
import { fieldNamed, reportFor, ruleIds, runCli, withTempDir, writeJson, writeText } from './helpers.mjs'

const EMAILS = [
  'a@example.test', 'b@example.test', 'c@example.test', 'd@example.test', 'e@example.test',
  'f@example.test', 'g@example.test', 'h@example.test', 'i@example.test', 'j@example.test',
]

function emailRecords(matching, total) {
  return Array.from({ length: total }, (_, index) => ({
    contact: index < matching ? EMAILS[index] : `ref-${index}`,
  }))
}

test('maxRecords: exactly the limit is read in full, one more is reported as unread', () => {
  const records = Array.from({ length: 4 }, () => ({ note: 'x' }))
  const atLimit = reportFor(records, { limits: { maxRecords: 4 } })
  assert.equal(atLimit.summary.recordsRead, 4)
  assert.equal(ruleIds(atLimit).includes('record-limit-exceeded'), false)
  assert.equal(atLimit.status, 'pass')

  const overLimit = reportFor(records, { limits: { maxRecords: 3 } })
  assert.ok(ruleIds(overLimit).includes('record-limit-exceeded'))
  assert.equal(overLimit.summary.recordsRead, 3)
  assert.equal(overLimit.status, 'incomplete')
  assert.equal(fieldNamed(overLimit, 'note').classification, 'undetermined')
})

test('maxFields: exactly the limit is tracked, one more is reported as unattributed', () => {
  const wide = [{ a: '1', b: '2', c: '3', d: '4' }]
  const atLimit = reportFor(wide, { limits: { maxFields: 4 } })
  assert.equal(atLimit.summary.fields, 4)
  assert.equal(ruleIds(atLimit).includes('field-limit-exceeded'), false)
  assert.equal(atLimit.status, 'pass')

  const overLimit = reportFor(wide, { limits: { maxFields: 3 } })
  assert.ok(ruleIds(overLimit).includes('field-limit-exceeded'))
  assert.equal(overLimit.summary.fields, 3)
  assert.equal(overLimit.status, 'incomplete')
})

test('maxValueLength: a value of exactly the limit is examined, one longer is not', () => {
  const sixteen = 'x'.repeat(16)
  const atLimit = reportFor([{ note: sixteen }], { limits: { maxValueLength: 16 } })
  assert.equal(fieldNamed(atLimit, 'note').values.examined, 1)
  assert.equal(fieldNamed(atLimit, 'note').values.tooLong, 0)
  assert.equal(fieldNamed(atLimit, 'note').classification, 'clean')
  assert.equal(atLimit.status, 'pass')

  const overLimit = reportFor([{ note: `${sixteen}x` }], { limits: { maxValueLength: 16 } })
  assert.equal(fieldNamed(overLimit, 'note').values.examined, 0)
  assert.equal(fieldNamed(overLimit, 'note').values.tooLong, 1)
  assert.equal(fieldNamed(overLimit, 'note').classification, 'undetermined')
  assert.ok(ruleIds(overLimit).includes('value-too-long'))
  assert.equal(overLimit.status, 'incomplete')
})

function nest(levels) {
  // `levels` counts containers, the record itself being the first.
  let value = 'leaf'
  for (let index = 0; index < levels; index += 1) value = { a: value }
  return value
}

test('maxDepth: exactly the permitted nesting is walked, one level more is not', () => {
  const atLimit = reportFor([nest(3)], { limits: { maxDepth: 3 } })
  assert.equal(ruleIds(atLimit).includes('record-too-deep'), false)
  assert.equal(atLimit.summary.fields, 1)
  assert.equal(fieldNamed(atLimit, 'a.a.a').values.examined, 1)
  assert.equal(atLimit.status, 'pass')

  const overLimit = reportFor([nest(4)], { limits: { maxDepth: 3 } })
  assert.ok(ruleIds(overLimit).includes('record-too-deep'))
  assert.equal(overLimit.summary.fields, 0)
  assert.equal(overLimit.status, 'incomplete')
})

test('maxDatasetBytes: a file of exactly the limit is read, one byte more is refused', async () => {
  await withTempDir(async (directory) => {
    const path = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      dataset: 'sized',
      source: 'tabular-export',
      records: [{ note: 'x' }],
    })
    const size = (await stat(path)).size

    const atLimit = await runCli([
      '--dataset', path, '--json',
      '--config', await writeJson(directory, 'at.json', { schemaVersion: '1', limits: { maxDatasetBytes: size } }),
    ])
    assert.equal(atLimit.code, 0)
    assert.equal(JSON.parse(atLimit.stdout).status, 'pass')

    const overLimit = await runCli([
      '--dataset', path, '--json',
      '--config', await writeJson(directory, 'over.json', { schemaVersion: '1', limits: { maxDatasetBytes: size - 1 } }),
    ])
    assert.equal(overLimit.code, 2)
    const report = JSON.parse(overLimit.stdout)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['dataset-too-large'])
    assert.equal(report.status, 'incomplete')
  })
})

test('countNodes counts what the parse would build, and not a bracket inside a string', () => {
  // The scan is what stands between a legal 16 MiB document and the heap, so
  // the two ways it could be wrong are pinned: counting a bracket that is text,
  // and missing one that is a node.
  assert.deepEqual(countNodes('{"a": [1, 2]}', 10), { nodes: 2, exceeded: false })
  assert.deepEqual(countNodes('{"a": "[[[[["}', 10), { nodes: 1, exceeded: false })
  assert.deepEqual(countNodes('{"a": "\\"[["}', 10), { nodes: 1, exceeded: false })
  assert.deepEqual(countNodes('[[[]]]', 10), { nodes: 3, exceeded: false })
  // It stops at the limit rather than counting a document out.
  assert.deepEqual(countNodes('[[[[[[', 3), { nodes: 4, exceeded: true })
})

test('maxNodes: a document of exactly the cap is read, one node more is refused before it is parsed', async () => {
  // The defect this pins: `maxDatasetBytes` bounds the text and
  // `maxRecords * maxFields` bounds the traversal, and neither bounds the
  // PARSE. A file of 16777216 bytes -- legal at the documented ceiling -- holds
  // eight million empty arrays, and building them took 1.31 GB of memory before
  // the depth limit refused a single subtree.
  await withTempDir(async (directory) => {
    const document = (nodes) =>
      `{"schemaVersion":"1","source":"tabular-export","records":[{"a":[${Array.from({ length: nodes - 4 }, () => '[]').join(',')}]}]}`
    // 4 nodes are the envelope: the document, the records array, the record and
    // the array in `a`.
    const atLimit = await writeText(directory, 'at.json', document(MAX_NODES))
    assert.equal(countNodes(await readFile(atLimit, 'utf8'), MAX_NODES).exceeded, false)

    const past = await writeText(directory, 'past.json', document(MAX_NODES + 1))
    // The byte bound is cheaper and fires first, so it is raised to its ceiling
    // here: this run is about the node bound.
    const config = await writeJson(directory, 'config.json', {
      schemaVersion: '1',
      limits: { maxDatasetBytes: LIMIT_CEILINGS.maxDatasetBytes },
    })
    const refused = await runCli(['--dataset', past, '--config', config, '--json'])
    assert.equal(refused.code, 2)
    const report = JSON.parse(refused.stdout)
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['node-limit-exceeded'])
    assert.equal(report.findings[0].severity, 'error')
    assert.match(report.findings[0].message, /was not parsed and nothing in it was examined/u)
    assert.equal(report.summary.checked, 0)
  })
})

test('the configuration document has its own byte bound, enforced from both sides', async () => {
  await withTempDir(async (directory) => {
    const dataset = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1',
      source: 'tabular-export',
      records: [{ note: 'x' }],
    })
    const body = '{"schemaVersion":"1"}'
    // Trailing whitespace is legal JSON and changes no parsed value, so the
    // byte count is the only thing that differs between these two runs.
    const atLimit = await writeText(directory, 'at.json', body + ' '.repeat(MAX_CONFIG_BYTES - body.length))
    const overLimit = await writeText(directory, 'over.json', body + ' '.repeat(MAX_CONFIG_BYTES - body.length + 1))
    assert.equal((await stat(atLimit)).size, MAX_CONFIG_BYTES)
    assert.equal((await stat(overLimit)).size, MAX_CONFIG_BYTES + 1)

    const accepted = await runCli(['--dataset', dataset, '--config', atLimit, '--json'])
    assert.equal(accepted.code, 0)

    const refused = await runCli(['--dataset', dataset, '--config', overLimit, '--json'])
    assert.equal(refused.code, 2)
    // A configuration error: stdout stays empty because the run never had a
    // subject to report on.
    assert.equal(refused.stdout, '')
    assert.ok(refused.stderr.includes('exceeds the 65536 byte limit'))
  })
})

test('every configurable limit accepts 1 and its ceiling, and refuses 0 and one past the ceiling', () => {
  // Enumerated from LIMIT_NAMES rather than listed by hand, so a limit added
  // later is covered without anybody remembering to add it here.
  assert.deepEqual([...LIMIT_NAMES].sort(), ['maxDatasetBytes', 'maxDepth', 'maxFields', 'maxRecords', 'maxValueLength'])
  for (const name of LIMIT_NAMES) {
    // `maxRecords` and `maxFields` also multiply into MAX_CELLS, so the other
    // factor is held small enough that only the bound under test can fire.
    const companion = name === 'maxRecords' ? { maxFields: 10 } : name === 'maxFields' ? { maxRecords: 488 } : {}
    const build = (value) => validateConfig({ schemaVersion: '1', limits: { ...companion, [name]: value } })

    assert.equal(build(1).limits[name], 1, `${name} must accept 1`)
    assert.equal(build(LIMIT_CEILINGS[name]).limits[name], LIMIT_CEILINGS[name], `${name} must accept its ceiling`)
    assert.throws(() => build(0), ConfigError, `${name} must refuse 0`)
    assert.throws(() => build(LIMIT_CEILINGS[name] + 1), ConfigError, `${name} must refuse one past its ceiling`)
    assert.throws(() => build(1.5), ConfigError, `${name} must refuse a fraction`)
  }
})

test('the product of maxRecords and maxFields is bounded, at exactly the cap and one past it', () => {
  const atCap = validateConfig({ schemaVersion: '1', limits: { maxRecords: 1000, maxFields: 2000 } })
  assert.equal(atCap.limits.maxRecords * atCap.limits.maxFields, MAX_CELLS)
  assert.throws(
    () => validateConfig({ schemaVersion: '1', limits: { maxRecords: 1000, maxFields: 2001 } }),
    (error) => error instanceof ConfigError && error.message.includes('field observations'),
  )
})

test('the acknowledged list is bounded, at exactly the cap and one past it', () => {
  const paths = Array.from({ length: MAX_ACKNOWLEDGED }, (_, index) => `field_${index}`)
  assert.equal(validateConfig({ schemaVersion: '1', acknowledged: paths }).acknowledged.length, MAX_ACKNOWLEDGED)
  assert.throws(
    () => validateConfig({ schemaVersion: '1', acknowledged: [...paths, 'one_more'] }),
    ConfigError,
  )
})

test('an acknowledged path of exactly the path length is accepted, and one character more is not', () => {
  const path = 'a'.repeat(MAX_FIELD_PATH_LENGTH)
  assert.equal(validateConfig({ schemaVersion: '1', acknowledged: [path] }).acknowledged[0], path)
  assert.throws(
    () => validateConfig({ schemaVersion: '1', acknowledged: [`${path}a`] }),
    ConfigError,
  )
})

test('a field path of exactly the printable length is used, and one character more is not', () => {
  const key = 'k'.repeat(MAX_PATH_LENGTH)
  const atLimit = reportFor([{ [key]: 'value' }])
  assert.equal(atLimit.summary.fields, 1)
  assert.equal(atLimit.fields[0].path, key)
  assert.equal(atLimit.status, 'pass')

  const overLimit = reportFor([{ [`${key}k`]: 'value' }])
  assert.equal(overLimit.summary.fields, 0)
  assert.ok(ruleIds(overLimit).includes('field-path-unusable'))
  assert.equal(overLimit.status, 'incomplete')
})

test('a mask of exactly the mask limit is whole, and one character more is marked as cut', () => {
  // The literal 48 is the number the README documents. Reading MASK_LIMIT here
  // instead made this test agree with whatever the constant said -- a sweep
  // moved it to 49 and nothing failed.
  assert.equal(MASK_LIMIT, 48)
  assert.equal(maskValue('a'.repeat(48)), 'x'.repeat(48))
  assert.equal(maskValue('a'.repeat(49)), `${'x'.repeat(48)}...`)
})

test('the documented confidence rates decide at the number the README prints', () => {
  // The threshold tests below drive 9 of 10 and 8 of 10, which is 0.9 against
  // 0.8: they cannot tell 0.9 from 0.89, and a sweep moving HIGH_RATE,
  // MEDIUM_RATE and CHECKSUM_RATE one hundredth left the suite green. These
  // rates land between the documented number and the number one hundredth
  // below it, so only the documented one gives these answers.
  const column = (matching, total, value) => Array.from({ length: total }, (unused, index) => ({
    contact: index < matching ? value(index) : `ref-${index}`,
  }))
  const confidenceOf = (records) => fieldNamed(reportFor(records), 'contact').confidence
  const address = (index) => `p${index}@example.test`

  // 0.9 or more is high; 0.89 is not.
  assert.equal(confidenceOf(column(90, 100, address)), 'high')
  assert.equal(confidenceOf(column(89, 100, address)), 'medium')
  // 0.5 or more is medium; 0.49 is not.
  assert.equal(confidenceOf(column(50, 100, address)), 'medium')
  assert.equal(confidenceOf(column(49, 100, address)), 'low')

  // A checksum recogniser reaches high at 0.5, and 0.49 is not 0.5 either.
  const card = (index) => ['4111 1111 1111 1111', '5555 5555 5555 4444'][index % 2]
  assert.equal(confidenceOf(column(50, 100, card)), 'high')
  assert.equal(confidenceOf(column(49, 100, card)), 'low')
})

test('a field keeps exactly the masked-example cap and no more', () => {
  const three = reportFor([
    { mail: 'a@example.test' }, { mail: 'bb@example.test' }, { mail: 'ccc@example.test' },
  ])
  assert.equal(fieldNamed(three, 'mail').maskedExamples.length, MAX_MASKED_EXAMPLES)

  const four = reportFor([
    { mail: 'a@example.test' }, { mail: 'bb@example.test' },
    { mail: 'ccc@example.test' }, { mail: 'dddd@example.test' },
  ])
  assert.equal(fieldNamed(four, 'mail').maskedExamples.length, MAX_MASKED_EXAMPLES)
  // The cap keeps the lowest by code unit, so which examples survive does not
  // depend on the order the records happened to arrive in.
  assert.deepEqual(fieldNamed(four, 'mail').maskedExamples, [
    'x@xxxxxxx.xxxx', 'xx@xxxxxxx.xxxx', 'xxx@xxxxxxx.xxxx',
  ])
})

test('the high-confidence threshold holds on both sides of the rate and of the evidence count', () => {
  const confidence = (matching, total) => fieldNamed(reportFor(emailRecords(matching, total)), 'contact').confidence
  assert.equal(confidence(9, 10), 'high')
  assert.equal(confidence(8, 10), 'medium')
  assert.equal(confidence(4, 4), 'high')
  assert.equal(confidence(3, 3), 'medium')
})

test('the medium-confidence threshold holds on both sides of the rate and of the evidence count', () => {
  const confidence = (matching, total) => fieldNamed(reportFor(emailRecords(matching, total)), 'contact').confidence
  assert.equal(confidence(2, 4), 'medium')
  assert.equal(confidence(2, 5), 'low')
  assert.equal(confidence(1, 2), 'medium')
  assert.equal(confidence(1, 1), 'low')
})

test('a checksum recogniser reaches high confidence at half the values, and not below', () => {
  const card = (matching, total) => {
    const records = Array.from({ length: total }, (_, index) => ({
      pan: index < matching ? '4111 1111 1111 1111' : `SKU-${index}`,
    }))
    return fieldNamed(reportFor(records), 'pan').confidence
  }
  assert.equal(card(1, 2), 'high')
  assert.equal(card(2, 5), 'low')
  assert.equal(card(1, 1), 'low')
})
