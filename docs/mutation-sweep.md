# The mutation sweep

A sweep is only worth what its enumeration is worth. "Every guard" is an
adjective; this file is the list, so that somebody else can re-derive it and
count independently rather than believe a number.

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
| `C_guard` | every statement in `src/*.mjs` and `bin/*.mjs` whose first token is `throw`, `refuse(`, `.push(`, `.set(`, `.add(`, a counter assignment (`state.X =`, `state.X +=`, `observation.X +=`), a single-line `if (…) return\|continue\|throw\|refuse`, or an `if (…) { }` block whose body is only one of those | the whole statement is removed |
| `D_ordering` | `byCodeUnit`'s body, every `byCodeUnit(…)` call site and every `.sort(byCodeUnit)` | given an `Intl.Collator` |
| `E_semantic` | named modifications, listed literally in the harness: every declared threshold moved one step, every boundary comparison loosened by one, the escape and the node scan disabled, the status branches reordered | as listed |

A run that does not finish inside the timeout is recorded as `TIMEOUT`, never as
a catch: under load a slow suite has not noticed anything. Both sweeps below ran
with zero timeouts.

## What the sweeps found

The first sweep ran over the tree as the defect round received it, after the
false positives, the path collision and the parse bound had been fixed.

| Sweep | Mutations | Caught | Silent | Timeouts |
| --- | ---: | ---: | ---: | ---: |
| First, before the tests below were written | 185 | 138 | 47 | 0 |
| Final | 187 | 180 | 7 | 0 |

The 47 silent mutations of the first sweep split into one defect, thirty-nine
missing tests and seven equivalent mutants.

**The defect.** Removing `luhnValid`'s length bound and moving the issuer
table's shortest length both went unnoticed, which is how the table turned out
to declare 12-digit Maestro numbers that `CARD_SHAPE` and `luhnValid` refuse:
the table promised a length the recogniser could not reach.

**The missing tests**, in the order they were closed:

- three memberships of the unsettled set, including `record-too-deep`, whose own
  test asserts `incomplete` and passed with the membership deleted because the
  report it drives raises a second unsettled rule that held the status up;
- nine refusals in the configuration schema, among them an unknown recogniser id
  and a document that is not an object;
- seven guards in the dataset reader, including the branch that counts a subtree
  past the depth limit **inside an array**, which was silently skipped;
- four ordering sites, three of them terms of `compareFindings` that one report
  can never reach, so the exported comparator is driven directly;
- four thresholds that were asserted against the constants defining them, so
  moving a constant moved the test with it;
- three shape guards in the recognisers and three lines of the human summary;
- the parse-failure backstop, whose test reached the generic fallback instead.

**The equivalent mutants**, each proven byte-identical across the three shipped
corpora and the seeded corpus at two confidence floors:

| Mutation | Why nothing can observe it |
| --- | --- |
| `describeValue`'s three early returns for a string, `null` and `undefined` | `String(value)` returns exactly those three answers |
| `confidenceFor`'s `matchesValue === null` branch | the only recogniser with no value matcher is `person-name`, whose ceiling is `low`, which is what the fallback returns |
| `confidenceFor`'s `matched <= 0 \|\| evaluated <= 0` branch | a zero match rate and a `NaN` rate both fall through to `low` |
| `ipv6Matches`'s character check and its second-marker check | the group checks refuse everything they refuse: measured over 37461 inputs over `: 0 1 a f g . Z` up to five characters plus the structured cases, with identical answers |
| the collator on `RULE_IDS`, on the categories beside an ambiguous field, and on the candidate tie-break | every id in this tool is lower-case letters, digits and hyphens, and no pair of them orders differently under the two rules. `test/ordering.test.mjs` asserts that grammar, so an id with an underscore or a capital makes the equivalence fail loudly |

Seven remain silent in the final sweep, and they are those seven equivalent
mutants. Naming one as equivalent is worth more than a mutation score: the next
person to read that line knows why nothing defends it.
