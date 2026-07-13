# Architecture Decision Records

Short documents capturing **why** a significant technical decision was made —
the context, the options weighed, and the consequences we accepted. They keep
the reasoning available long after the PR discussion is forgotten.

## Conventions

- One decision per file: `NNNN-short-slug.md`, numbered in order of adoption.
- Statuses: **Accepted** (in force), **Superseded by NNNN**, or **Rejected**.
- A new decision that reverses an old one gets a new number; the old record's
  status is updated to point at it. Records are never deleted or rewritten.
- Keep them short: Context → Decision → Consequences. If it takes more than a
  screen or two, it's a design doc (put it in `docs/`) with an ADR pointing to
  it.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](./0001-local-song-library-indexeddb.md) | Persist user songs locally in IndexedDB | Accepted |
| [0002](./0002-community-catalog-charts-only.md) | Community catalog shares charts, never audio | Accepted |
| [0003](./0003-chart-editor-v1-scope.md) | Chart editor v1: beat-grid taps, no timeline audio | Accepted (hold limit lifted by 0006) |
| [0004](./0004-guitar-feel-gameplay.md) | Guitar-feel gameplay: star power, rock meter, perspective highway | Accepted (amended by 0005) |
| [0005](./0005-hopo-whammy-star-authoring.md) | HOPOs, whammy, and star-phrase authoring | Accepted |
| [0006](./0006-practice-leaderboards-hold-authoring.md) | Practice mode, local leaderboards, hold authoring | Accepted |
