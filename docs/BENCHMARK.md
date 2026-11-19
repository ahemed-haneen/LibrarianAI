# Retrieval benchmark and changelog

`librarian bench` replays past commits with leave-one-out memory and reports token savings, recall and where tokens were lost.
Run it on your own repo (numbers on another repo are not comparable in absolute terms):

```
librarian bench --commits 50 --write-pin pin.json --label before --out before.json   # pins the commit set
# ...change something...
librarian bench --pin pin.json --label after --out after.json
librarian bench-compare before.json after.json                                          # table + tasks better/worse
```

Flags: `--temporal` (only earlier commits as memory), `--strict` (only files with an expanded skeleton count as found), `--max-files`, `--max-related`.
`templates/librarian-bench.yml` is a manual CI workflow that runs skeleton-only vs AI-summaries and prints the comparison, including how many misses of each reason (`no public names`, `wording mismatch`) the summaries recovered.

## Results on the proxy repos

Proxy = apache/superset (131 pinned tasks, large files, so absolute % are inflated; read the deltas, median and small-task rows) and an Angular library (141 tasks, small repo, a harsh test for small tasks).

| Metric | Original | Final | Your report 1 (17 tasks) | Your report 2 (48 tasks) |
|---|---:|---:|---:|---:|
| Superset: saved, all tasks | 29.3% | 58.8% | – | – |
| Superset: median task | 6.1% | 55.6% | – | – |
| Superset: small tasks (≤2 files) median | −0.4% | 69.5% | – | – |
| Superset: recall | 32.9% | 54.4% | 14% | 17% |
| Superset: full hits | 16.8% | 40.5% | 12% | 8% |
| Superset: avg pack | 5.4k | ~5.5k | – | – |
| Angular: saved, all tasks | 11.7% | 11.9% | – | – |
| Your repo: saved / median | – | run `bench` | 2% / −8% | 12% / −2% |

## Changelog (Superset, one change at a time)

| # | Change | Saved / median / recall / full hits | Verdict |
|---|---|---|---|
| 0 | Original | 29.3 / 6.1 / 32.9 / 16.8 | – |
| 1 | Deterministic pinned harness | identical reruns | keep |
| 2 | Per-language BM25 statistics | 35.0 / 10.0 / 32.7 / 19.1 | keep (quota slots and test demotion reverted) |
| 3 | Test/spec pairing | 42.5 / 14.1 / 35.9 / 24.4 | keep |
| 4 | Skeleton caps 300/100/60, 32 files | 51.9 / 29.8 / 49.8 / 32.8 | keep (adaptive pack size reverted) |
| 5 | Second-stage rerank by word coverage | 56.9 / 45.0 / 51.0 / 37.4 | keep (co-change, proximity reverted) |
| 6 | Learn from commits | 57.9 / 45.0 / 51.0 / 37.4 (temporal) | keep (small here: unique titles) |
| 7 | Query expansion (pseudo-relevance feedback) | median 44.0→41.7 | reverted; working-context boost kept, not replayable |
| 8 | More file types (yaml, proto, graphql, html, scss, pyi), JSON opt-in | no change / Angular 11.7→11.7 | keep |
| 9 | Fallback skeletons for files with no public names | 57.9 / 44.0 / 52.5 / 38.9 | keep (test titles reverted) |
| 10 | AI summaries via CI | not run (needs a model) | harness + reason split ready |
| 11a | tsconfig paths / baseUrl / workspace package imports | 57.1 / 54.1 / 53.1 / 39.7 | keep: median +10, small tasks and pack-cost losers 7→3; Angular neutral |
| 11b | Neighbour limit 6→8 | 58.8 / 55.6 / 54.4 / 40.5 | keep: 10 and 14 gain more on Superset but lose more on small Angular tasks |

Which tasks got worse is listed by `bench-compare` after each change. Regression cause for the Python indexing drop: thousands of Python files, and verbose `*_test.py` skeletons crowded the pack; fixed by steps 2–5.

## Ranked by effect

1. Skeleton caps and 32 candidate files (+9.4 pts saved, median +15.7)
2. Test/spec pairing (+7.5)
3. Per-language BM25 statistics (+5.7)
4. Second-stage rerank (+5.0, median +15.2)
5. Import aliases (median +10 and fewer pack-cost losers; aggregate −0.8)
6. Neighbour limit 8 (+1.7)
7. Fallback skeletons (+recall, small-task losers 51→47 on Angular)
8. Learned memory (+0.9; larger where task titles repeat)

Not replayable (no historical editor state): branch words, open and modified files, diff words.
Misses still open: wording mismatch and no-public-names, which AI summaries from CI are meant to address.
