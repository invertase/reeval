## reeval analysis · 20261025T095024Z_c705dc2_cursor-agent_asf8

**TL;DR** (medium). The house-style skill lifts the pass rate.

### What happened

- Every eval ran on two harnesses. [F1]

### Results

- The variant passed where the control failed. [F1] *(medium confidence)*

### Anomalies

- **noise**: The broken harness never started. [F1]

### Suggested actions

1. **Rerun the compare** (eval · impact medium · effort low)  
   Target: `evals/skill.eval.ts`. Run it three times.  
   Expect: A tighter interval.  
   Verify: `reeval run skill --runs 3` [F1]

**Confidence: medium.** One run.

<sub>fake-analysis · analysis-v11 · digest v12 · 0 in / 0 out tokens · 0s · 4 citations checked, 0 invalid, 0 dropped · 1 commands checked, 0 rejected</sub>
