# Shopping assistant model comparison, 2026-09-28

14 questions × 2 run(s) per model, against https://nexus-api-staging.mingzhe030228.workers.dev.
Checks are mechanical (catalogue category and price, which tool ran, whether
the answer names a product no tool returned); see scripts/eval-assistant.mjs.

| Model | Questions passed | Checks passed | Answers naming products no tool returned | Errors | Median time |
|---|---|---|---|---|---|
| mistral-small-3.1-24b-instruct | 27/28 | 97% | 0 | 1 | 3.6s |

## Failures

- **mistral-small-3.1-24b-instruct** · "a gift under $100" · failed: answered, price, cards · cards: none · error: fetch failed
