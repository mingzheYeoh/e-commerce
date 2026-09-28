# Shopping assistant model comparison, 2026-09-28

14 questions × 1 run(s) per model, against https://nexus-api-staging.mingzhe030228.workers.dev.
Checks are mechanical (catalogue category and price, which tool ran, whether
the answer names a product no tool returned); see scripts/eval-assistant.mjs.

| Model | Questions passed | Checks passed | Answers naming products no tool returned | Errors | Median time |
|---|---|---|---|---|---|
| mistral-small-3.1-24b-instruct | 12/14 | 96% | 0 | 0 | 3.9s |
| llama-3.3-70b-instruct-fp8-fast | 1/14 | 74% | 0 | 0 | 8.9s |
| llama-4-scout-17b-16e-instruct | 9/14 | 87% | 0 | 0 | 2.3s |

## Failures

- **mistral-small-3.1-24b-instruct** · "cheapest mechanical keyboard" · failed: category · cards: none
- **mistral-small-3.1-24b-instruct** · "which phone has the biggest screen?" · failed: category · cards: none
- **llama-3.3-70b-instruct-fp8-fast** · "I have $500 budget, I want to buy the phone, any recommend?" · failed: answered · cards: phone-3a · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "noise cancelling headphones under $400" · failed: answered · cards: momentum-4, soundlink-max, soundcore-liberty · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "best laptop under $2000" · failed: answered · cards: thinkpad-x1-carbon, xps-16, zenbook-s14 · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "I need a phone that charges at 80W or faster" · failed: answered · cards: oneplus-15, xiaomi-17-ultra · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "headphones with at least 30 hours of battery" · failed: answered · cards: momentum-4, wh1000xm6 · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "a camera or drone for travel under $1000" · failed: answered · cards: osmo-pocket, rs4-gimbal · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "compare the XPS 16 and the ThinkPad X1 Carbon" · failed: answered · cards: xps-16, thinkpad-x1-carbon · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "what can charge my MacBook Pro on a flight?" · failed: answered · cards: prime-powerbank · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "something for a noisy open-plan office" · failed: answered · cards: momentum-4, soundcore-liberty, ear-open · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "cheapest mechanical keyboard" · failed: answered · cards: viper-v3, mx-mechanical · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "do you sell refrigerators?" · failed: answered, none · cards: switch-set, zenbook-s14, xiaomi-17-ultra, fx3-cinema, open-earbuds · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "which phone has the biggest screen?" · failed: answered · cards: iphone-18-pro-max, galaxy-s26-ultra, xiaomi-17-ultra, galaxy-s26 · ran out of steps
- **llama-3.3-70b-instruct-fp8-fast** · "a gift under $100" · failed: answered · cards: k-pro-mouse, cmf-buds, switch-set · ran out of steps
- **llama-4-scout-17b-16e-instruct** · "I have $500 budget, I want to buy the phone, any recommend?" · failed: category, price · cards: none
- **llama-4-scout-17b-16e-instruct** · "noise cancelling headphones under $400" · failed: category, price · cards: none
- **llama-4-scout-17b-16e-instruct** · "what can charge my MacBook Pro on a flight?" · failed: tool · cards: prime-powerbank, macbook-pro, airpods-max, gan-charger, iphone-18-pro
- **llama-4-scout-17b-16e-instruct** · "do you sell refrigerators?" · failed: none · cards: switch-set, zenbook-s14, xiaomi-17-ultra, fx3-cinema, open-earbuds
- **llama-4-scout-17b-16e-instruct** · "which phone has the biggest screen?" · failed: category · cards: none
