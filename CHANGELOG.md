# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public surface: renaming one is a breaking change and is recorded as such.

## Unreleased

### Fixed

- The exit-code table in the README and the exit-code section of `--help` both
  said exit 0 meant no field reached the configured confidence. That is false for
  every run whose fields are acknowledged: `personal-data-acknowledged` is `info`
  and outside the unsettled set, so a run exits 0 with fields classified
  `personal-data` at high confidence. The behaviour was always the intended one;
  both sentences now say so, and a CLI test drives the run they describe.

- A field path is now composed by ESCAPING each key, and read back with a parser
  rather than by splitting on `.`. A flat column named `contact.email` and a
  nested `contact` holding `email` composed to the same path, so they became one
  report entry with one merged match rate -- 4 of 8, for two fields that were 4
  of 4 and 0 of 4 -- and acknowledging one of them silenced the other at exit 0,
  status `pass`. A column literally named `tags[]` collided with the array `tags`
  the same way, and the pointer reproduced the collision even where the paths
  differed. `\`, `.`, `[` and `]` in a key are escaped with a backslash, which
  changes the path an `acknowledged` entry must name for such a key.

- `person-name` no longer matches a column named exactly `name`. The recogniser
  classifies no value, so a product catalogue with a `name` column became
  `uncertain` at low confidence and a correct run ended `incomplete` at exit 2.
  `surname`, `forename` and the `*_name` family are unchanged. The cost, named in
  the README: a `name` column that does hold people is reported `clean` unless
  the configuration acknowledges it.

- `payment-card` no longer draws a candidate from a Luhn collision. A Luhn check
  accepts one uniformly random digit string in ten at any length, so two of
  twelve internal sixteen-digit order numbers matched by chance and a clean run
  ended `incomplete` at exit 2. The recogniser now also requires an issuer
  identification number (ISO/IEC 7812-1) that a card network issues at that
  length, which takes a sixteen-digit reference from one in ten to 0.02833. The
  cost, named in the README: a card from a network the table does not list.

- `network-address` no longer reports a four-part build number as a network
  identifier. Every value in a column such as `app_version` is a legal dotted
  quad, so the column was classified `network-identifier` at high confidence and
  raised `personal-data-detected` at error severity, exit 1, on correct input. A
  column name that declares a version and says nothing about a network now
  refuses the recogniser. The cost, named in the README: a column of real
  addresses called `firmware_version` is missed.

## 0.1.0

First working version.

- Seven recognisers with a declared basis and a ceiling on their confidence:
  `email-address`, `payment-card`, `phone-number`, `government-id`,
  `network-address`, `date-of-birth` and `person-name`.
- Four classifications. `clean` is the only one that claims an absence, and it
  requires every value in the field to have been examined and the whole dataset
  to have been read.
- Eighteen rules with a frozen severity table, and an unsettled set that makes a
  run `incomplete` whenever a question it was asked stayed open.
- Masked examples only: no value from the dataset reaches the report.
- Declared byte, record, field, value-length and depth limits, each enforced
  before the work it bounds, plus a cap on the number of field observations one
  run may make.
- Three runnable corpora under `examples/`, ending at exit 0, 1 and 2.
