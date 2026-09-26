# The mutation sweep

A sweep is worth what its enumeration is worth. "Every guard" is an adjective;
this file is the list, so that somebody else can re-derive it and count
independently rather than believe a number.

## How the list is produced

Five categories, each a pattern over named files. The tool ships no development
tooling and no dependencies, so the harness lives outside the repository: it
copies the tree into a sandbox **named `pii-discovery-report`**, applies one
mutation, and runs `node --test`.

The sandbox name is not cosmetic. `test/schema.test.mjs` asserts that the tool
id equals the directory the tool lives in, so a sandbox called anything else
fails for **every** mutant and reports a perfect score.

| Category | What is enumerated | The mutation |
| --- | --- | --- |
| `A_severity` | every line of the `RULE_SEVERITY` freeze in `src/rules.mjs` matching `^\s*'<id>': '(error\|warning\|info)',$` | the severity is replaced by the next weaker one (`error`→`warning`, `warning`→`info`, `info`→`warning`) |
| `B_unsettled` | every line of the `UNSETTLED_RULES` freeze matching `^\s*'<id>',$` | the line is deleted |
| `C_guard` | every statement in `src/*.mjs` and `bin/*.mjs` whose first token is `throw`, `refuse(`, `.push(`, `.set(`, `.add(`, a counter assignment (`state.X =`, `state.X +=`, `observation.X +=`), a single-line `if (…) <statement>`, or an `if (…) { }` block with no `else` | the whole statement, or the whole block and everything it guards, is removed |
| `D_ordering` | `byCodeUnit`'s body, every `byCodeUnit(…)` call site and every `.sort(byCodeUnit)` | given an `Intl.Collator` |
| `E_semantic` | named modifications, listed literally in the harness: every declared threshold moved one step, every boundary comparison loosened by one, the path escape and both text scans disabled, the status branches reordered | as listed |

Two rules the counting depends on, both of them learned the hard way here:

- **A mutation that does not parse is not a mutation.** Two of the enumerated
  statements cannot be removed without leaving a syntax error, so every test
  fails and the sweep would score them as catches. They are checked with
  `node --check` and reported as `INVALID`, outside the totals.
- **A timeout is a timeout, and so is a kill.** A non-zero exit whose output
  carries no failing assertion is the machine, not the suite. Measured: three
  mutations came back `CAUGHT` in a batch run at load 230 and `SILENT` when
  re-run alone. Such a run is retried once and then named `ENVIRONMENT`, never
  counted as a catch. The final sweep below has none, and no timeouts.

## What the sweeps found

| Sweep | Mutations | Caught | Silent | Invalid |
| --- | ---: | ---: | ---: | ---: |
| First, with the guard category narrowed to control-flow bodies | 185 | 138 | 47 | 0 |
| Final, over the finished tree | 231 | 219 | 10 | 2 |

The first sweep's guard category enumerated only `if` statements whose body was
a `return`, `continue` or `throw`. Broadening it to every `if` block added **89
more guards** in the same files — a third of the category, missed by a
definition that read as though it covered everything. That is the difference
between reporting an enumeration and reporting an adjective.

Per category, over the finished tree:

| Category | Mutations | Caught | Silent |
| --- | ---: | ---: | ---: |
| `A_severity` | 20 | 20 | 0 |
| `B_unsettled` | 17 | 17 | 0 |
| `C_guard` | 149 (2 invalid) | 140 | 7 |
| `D_ordering` | 10 | 7 | 3 |
| `E_semantic` | 35 | 35 | 0 |

By file: `src/rules.mjs` 48, `src/dataset.mjs` 49, `src/index.mjs` 46,
`src/recognisers.mjs` 34, `src/text.mjs` 25, `src/config.mjs` 23,
`bin/pii-discovery-report.mjs` 6.

### What the silence was hiding

**Two defects.** Removing `luhnValid`'s length bound and moving the issuer
table's shortest length both went unnoticed, which is how the table turned out
to declare 12-digit Maestro numbers that `CARD_SHAPE` and `luhnValid` refuse —
a table promising a length the recogniser cannot reach. And `makeFinding` had a
branch for an `evidence` excerpt that no rule passes: a capability nothing
reached and nothing defended.

**Missing tests**, in the order they were closed:

- three memberships of the unsettled set, including `record-too-deep`, whose own
  test asserts `incomplete` and passed with the membership deleted because the
  report it drives raises a second unsettled rule that held the status up;
- nine refusals in the configuration schema, among them an unknown recogniser id
  and a document that is not an object;
- the dataset `schemaVersion` refusal, so a document written to another schema
  was read as though it were this one;
- seven guards in the dataset reader, including the branch that counts a subtree
  past the depth limit **inside an array**, which was silently skipped;
- four ordering sites, three of them terms of `compareFindings` that one report
  can never reach, so the exported comparator is driven directly;
- four thresholds that were asserted against the constants defining them, so
  moving a constant moved the test with it;
- `summary.uncertain`, never asserted, so the line counting it could go and the
  number stayed 0 in every report;
- the guard around `suggestion`, whose removal wrote the string `"undefined"`
  onto every finding that has no next step, because nothing looked at the KEYS a
  finding carries;
- three shape guards in the recognisers and three lines of the human summary;
- the parse-failure backstop, whose test reached the generic fallback instead.

### The ten that remain, and why

Each is an equivalent mutant, and each was proven byte-identical across the
three shipped corpora and the seeded corpus at two confidence floors.

| Mutation | Why nothing can observe it |
| --- | --- |
| `describeValue`'s three early returns for a string, `null` and `undefined` | `String(value)` returns exactly those three answers |
| `confidenceFor`'s `matchesValue === null` branch | the only recogniser with no value matcher is `person-name`, whose ceiling is `low`, which is what the fallback returns |
| `confidenceFor`'s `matched <= 0 \|\| evaluated <= 0` branch | a zero match rate and a `NaN` rate both fall through to `low` |
| `ipv6Matches`'s character check and its second-marker check | the group checks refuse everything they refuse: measured over 37461 inputs over `: 0 1 a f g . Z` up to five characters plus the structured cases, with identical answers |
| the collator on `RULE_IDS`, on the categories beside an ambiguous field, and on the candidate tie-break | every id in this tool is lower-case letters, digits and hyphens, and no pair of them orders differently under the two rules. `test/ordering.test.mjs` asserts that grammar, so an id with an underscore or a capital makes the equivalence fail loudly |

Naming one as equivalent is worth more than a mutation score: the next person to
read that line knows why nothing defends it.
