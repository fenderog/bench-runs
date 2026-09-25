## Setup

Zero-shot, greedy decoding, `max_new_tokens=1024`. Answers were extracted with a
strict regex on the final `#### <answer>` line; anything unparseable counted as
incorrect (about 1.8% of items).

## Observations

- Most failures on *Diagrams* are **arithmetic slips inside a correct plan**, not
  planning failures — the model sets the right equations and then mis-adds.
- Prefill dominates latency above ~2k prompt tokens; decoding tracks output
  length almost linearly (see the chart below).
- A repetitive trailing pattern was observed on 0.7% of samples when the logit
  temperature was raised above 1.0. Reported numbers use greedy decoding, so this
  does not affect the score.

## Reproduction

```bash
python -m eval.run --model meta-llama/Llama-3.1-8B-Instruct \
  --suite gsm8k --shots 0 --temperature 0 --seed 7
```
