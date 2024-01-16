/**
 * Every refusal the configuration schema makes.
 *
 * The configuration is POLICY: a problem with it means the run never had a
 * subject, so stdout stays empty and the process exits 2. A mutation sweep
 * removed each of these guards in turn and the suite stayed green for ten of
 * them -- an unknown recogniser id, a recogniser listed twice, a document that
 * is not an object, a `limits` that is not an object, an `acknowledged` that is
 * not an array, and the rest below. A guard nothing calls and a guard nothing
 * tests fail the same way: quietly, one release later.
 *
 * Each case names the MESSAGE as well as the error, because "it threw" is
 * satisfied by throwing for the wrong reason -- and the message is the whole
 * value of a configuration refusal to whoever has to fix the file.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConfigError, validateConfig } from '../src/index.mjs'
import { runCli, withTempDir, writeJson } from './helpers.mjs'

const base = { schemaVersion: '1' }

/** [what it is, the document, the phrase the refusal must name]. */
const REFUSALS = [
  ['a document that is not a JSON object', [], /configuration document must be a JSON object/u],
  ['a document that is a string', 'schemaVersion=1', /configuration document must be a JSON object/u],
  ['an unknown top-level key', { ...base, recognizers: [] }, /Unknown configuration key "recognizers"/u],
  ['a schemaVersion this tool does not read', { schemaVersion: '2' }, /declares schemaVersion 2/u],
  ['a missing schemaVersion', {}, /declares schemaVersion undefined; this tool reads version 1/u],
  ['a minConfidence outside the scale', { ...base, minConfidence: 'certain' }, /"minConfidence" must be one of low, medium, high/u],
  ['limits that are not an object', { ...base, limits: 5 }, /key "limits" must be an object/u],
  ['limits that are an array', { ...base, limits: [] }, /key "limits" must be an object/u],
  ['an unknown limit name', { ...base, limits: { maxRecord: 10 } }, /Unknown limit "maxRecord"/u],
  ['a limit that is not a whole number', { ...base, limits: { maxRecords: 1.5 } }, /"maxRecords" must be a whole number/u],
  ['recognisers that are not an array', { ...base, recognisers: 'email-address' }, /"recognisers" must be a non-empty array/u],
  ['an empty recogniser list', { ...base, recognisers: [] }, /"recognisers" must be a non-empty array/u],
  ['an unknown recogniser id', { ...base, recognisers: ['email-adress'] }, /Unknown recogniser "email-adress"/u],
  ['a recogniser that is not a string', { ...base, recognisers: [7] }, /Unknown recogniser "7"/u],
  ['a recogniser listed twice', { ...base, recognisers: ['email-address', 'email-address'] }, /listed twice/u],
  ['acknowledged that is not an array', { ...base, acknowledged: 'full_name' }, /"acknowledged" must be an array/u],
  ['an acknowledged entry that is not a string', { ...base, acknowledged: [7] }, /prints exactly as it is written/u],
  ['an acknowledged field listed twice', { ...base, acknowledged: ['full_name', 'full_name'] }, /listed twice/u],
]

test('every malformed configuration is refused, and the refusal says which one it is', () => {
  for (const [what, document, phrase] of REFUSALS) {
    assert.throws(
      () => validateConfig(document),
      (error) => {
        assert.ok(error instanceof ConfigError, `${what} must be a ConfigError`)
        assert.match(error.message, phrase, what)
        return true
      },
      what,
    )
  }
})

test('the configurations next to those refusals are accepted', () => {
  // The other side of every guard above: a guard that refuses everything passes
  // a refusal test while making the tool useless.
  assert.equal(validateConfig({ ...base }).minConfidence, 'medium')
  assert.equal(validateConfig({ ...base, minConfidence: 'high' }).minConfidence, 'high')
  assert.deepEqual(validateConfig({ ...base, limits: {} }).limits.maxRecords, 5000)
  assert.equal(validateConfig({ ...base, limits: { maxRecords: 10 } }).limits.maxRecords, 10)
  assert.deepEqual(validateConfig({ ...base, recognisers: ['email-address'] }).recognisers, ['email-address'])
  assert.deepEqual(
    validateConfig({ ...base, acknowledged: ['full_name', 'contact.email'] }).acknowledged,
    ['full_name', 'contact.email'],
  )
  assert.deepEqual(validateConfig({ ...base, acknowledged: [] }).acknowledged, [])
})

test('a refused configuration reaches the caller as an empty stdout and exit 2', async () => {
  // The shape the contract reserves for a run that never had a subject, driven
  // through the real entry point for one of the cases above.
  await withTempDir(async (directory) => {
    const config = await writeJson(directory, 'config.json', { schemaVersion: '1', recognisers: ['email-adress'] })
    const dataset = await writeJson(directory, 'dataset.json', {
      schemaVersion: '1', source: 'tabular-export', records: [{ contact: 'ada@example.test' }],
    })
    const result = await runCli(['--dataset', dataset, '--config', config, '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Unknown recogniser "email-adress"/u)
  })
})
