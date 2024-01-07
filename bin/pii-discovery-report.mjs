#!/usr/bin/env node

import {
  ConfigError,
  discoverPersonalData,
  exitCodeFor,
  formatSummary,
  renderReport,
  sanitize,
} from '../src/index.mjs'

const HELP = `pii-discovery-report

Run configured recognisers over an exported dataset and report which fields look
like they hold personal data, with the basis, the confidence, the counts behind
the confidence, and masked examples.

This tool reads one document. It opens no connection, runs no query, resolves no
host and writes no file: the report goes to stdout. Every result is evidence
about the SHAPE of a value, and a value shaped like an identifier is not the
same fact as a value that identifies a person.

No value is ever printed. Examples are masked: every digit becomes "#", every
letter becomes "x", a few separators survive and everything else becomes "?".

A field is reported as holding no personal data only when every one of its
values was examined. A value past the length limit, a whole number wider than a
JSON reader keeps digit for digit, a record that is not an object, a subtree
past the depth limit or a key that prints as nothing each makes the field
undetermined and the run incomplete -- never clean.

Usage:
  pii-discovery-report --dataset FILE [--config FILE] [--min-confidence LEVEL] [--json]

Options:
  --dataset FILE          Exported dataset document to examine (required)
  --config FILE           Configuration: recognisers, minConfidence,
                          acknowledged fields and limits
  --min-confidence LEVEL  low, medium or high. Overrides the configuration, and
                          is validated the same way. Default medium.
  --json                  Suppress the human summary on stderr
  -h, --help              Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every field was examined in full and no UNACKNOWLEDGED field reached the
     configured confidence. A field the configuration acknowledges is still
     reported as personal data, at info severity, so a run can exit 0 with
     fields classified personal-data at high confidence
  1  the run completed and at least one field that is not acknowledged looks
     like personal data
  2  invalid configuration, or evidence the run could not obtain. A dataset that
     could not be read, decoded or parsed, records past the limit, a field whose
     values were not all examined, and a candidate below the configured
     confidence all land here, and none of them is ever reported as an absence
     of personal data.
     On a configuration error stdout stays EMPTY and the message goes to stderr.
     On unreadable or incomplete evidence stdout carries an "incomplete" report
     naming what was not examined.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { dataset: null, config: null, minConfidence: null, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--dataset') options.dataset = takeValue('--dataset')
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--min-confidence') options.minConfidence = takeValue('--min-confidence')
    // The option text is argv, which this tool did not write either: a newline
    // or a bidi control in it would forge lines in the diagnostic below just as
    // one in the dataset would.
    else throw new Error(`Unknown option "${sanitize(argument, 64)}"`)
  }

  if (options.dataset === null) throw new Error('--dataset is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await discoverPersonalData({
      dataset: options.dataset,
      config: options.config,
      minConfidence: options.minConfidence,
    })
  } catch (error) {
    // A ConfigError means the run never had a subject: stdout stays empty, by
    // the contract. Anything else escaping here is a defect in this tool, and
    // it is reported the same way rather than as a report about the dataset.
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : `Execution failure: ${error.message}`}\n`,
    )
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
