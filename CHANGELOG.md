# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public surface: renaming one is a breaking change and is recorded as such.

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
