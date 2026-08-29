# P10 Final Business Parity

Owner: Product Architecture
Phase: P10
Decision: D-039
Baseline: `bb55746b7e08cf7ee764d06a8fa23da91ad48e2f`
Historical input: `e18dc0b616fa7ab2b00a6c05db23890ccd940175`

## Parity rule

P10 closes business and Web workflow parity, not interface-shape parity. Each
historical route, collection, primary Web route, L0-L7 case, and optimization
package has one stable source identity, one business group, one disposition,
and one Clean verification reference. The allowed dispositions are:

- `equivalent`: the Clean workflow retains the same business meaning;
- `consolidated`: one Clean workflow owns semantics formerly split across
  multiple historical entries;
- `retired_interface`: the entry has no independent business meaning and names
  its replacement group;
- `fixture_only`: the entry is retained only as immutable import or test input.

Development maps may carry `gap`; the final audit and Evidence reject every
remaining gap, duplicate, missing, stale, orphan, or unexplained entry.
`retired_business` is not a valid disposition.

## Business groups

1. Identity and ACL
2. Provider settings
3. Project and Brief
4. Workflow
5. Repository
6. Context
7. Assist
8. Files and Approval
9. Terminal and Bridge
10. Runner and Execution
11. Evidence
12. Parser
13. Quality
14. Outcome
15. MCP, Exchange, and Gateway
16. Delivery
17. Operations and Recovery
18. Offline and PWA
19. Complete Web experience

These groups are acceptance partitions. They do not create new persistence,
authorization, operation, event, CAS, aggregate-head, or cursor owners.

## Retired interfaces

The following interface shapes are retired because their business semantics
are owned elsewhere in Clean: versioned Assist routes, pre-v2 API routes,
duplicate health addresses, CC Switch-specific endpoints, online Workflow
migration, dynamic tool CRUD, direct Git commands, and deletion routes that
bypass confirmation intents. Retirement never removes the underlying business
capability.

## Retained design

P10 retains the five Quality dimensions (`coverage`, `accuracy`, `depth`,
`consistency`, `clarity`), separates model advice from human scores, records
included asset versions and excluded reasons, preserves stale/superseded review
history, supports Assist fork/side-thread/review, snapshots Brief templates,
and requires recoverable Project deletion plus two session-bound confirmations
for remote Repository deletion.

Parser registrations advance atomically to the additive `node24-p10` worker at
`sha256:3c2c0f8f550f4c8a14c33661f1e4e85227aa02e3bd0844a8e1044ed368d202a0`.
The image extends the immutable P7 digest, resolves its nested archive worker on
Windows, and proves 21 real valid samples plus malformed, signature, quota,
traversal, encryption, and nested-bomb cases in an isolated container.

## Release and closure

Production pointers and production volumes are excluded. Release verification
uses only fresh temporary volumes, a dynamic loopback origin, an isolated
pointer switch, two byte-identical Docker builds, an exported SPDX SBOM, and an
actual P9 rollback. The GitHub deletion probe creates one uniquely named
private fixture only after proving the name absent, binds full name, repository
id, and HEAD, deletes through the production GitHub App adapter, reconciles
absence, and restricts failure cleanup to that exact repository id. The Catalog
stays at `27/0/27` and is not inferred from route, collection, or table counts.

Final Evidence must bind the implementation commit and runtime tree, contain
all four workspace artifact roles, map every fixed input, verify all three
viewports and external adapters, and restore schema v8, ledger `[1..8]`, and
all P9 component snapshots with `byte_exact_mismatches=[]`. Once the annotated
P10 tag is published, P0-P10 governance artifacts are frozen.
