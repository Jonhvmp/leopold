---
name: persona-contract-runtime
description: Validates and enacts an existing persona contract for immersive first-person reactions, decisions, evaluations, conversations, or experience tests while preserving knowledge limits, voice, evidence boundaries, and state across turns. Use when an agent must consume, role-play, audit, or run a persona contract. Do not use to research or invent a missing persona.
metadata:
  version: "1.0.0"
  accepts-contract: "persona-contract/1.0"
  result-schema: "persona-runtime-result/1.0"
---

# Persona Contract Runtime

Consume a validated persona contract and execute it as a bounded behavioral runtime.

Immersion means consistent perception, vocabulary, emotion, decisions, and limitations. It does not mean claiming that a synthetic persona is a real identifiable human.

## Core architecture

Treat persona enactment as a stateful interpreter:

`contract + prior state + visible stimulus + task -> bounded reaction + observable action + state delta`

The persona contract is authoritative. Do not complete missing fields from stereotypes, generic user archetypes, model priors, or a helpful-assistant instinct.

Do not embed worked persona examples, sample reactions, domain defaults, or canonical scores in this skill.

## Input variables

Required:

- `PERSONA_CONTRACT`: a complete persona contract.
- `STIMULUS`: the material, situation, interface, message, choice, or event the persona can perceive.
- `RUNTIME_TASK`: what the persona must react to, decide, evaluate, or do.

Optional:

- `MODE`: `immersive`, `instrumented`, or `contract-audit`.
- `TURN_ID`: stable identifier for the current interaction.
- `PRIOR_STATE`: state produced by a previous turn.
- `VISIBLE_CONTEXT`: additional information explicitly available to the persona.
- `OUTPUT_LANGUAGE`: requested runtime language; the contract wins when they conflict.
- `RATING_REQUEST`: dimensions and scale to apply after the natural reaction.
- `STRICTNESS`: behavior for missing or contradictory contract fields.
- `RESPONSE_BOUNDARY`: maximum length or format constraint.
- `DISCLOSURE_CONTEXT`: whether the runtime is being shown as research simulation or direct role-play.

Default `MODE` to `immersive` only when the user clearly wants in-character output. Default `STRICTNESS` to `strict`.

## Contract acceptance gate

Before role-play, validate:

- `schema_version` is supported;
- `persona_id`, `scope`, `epistemic_boundary`, `communication_model`, `behavior_model`, and `runtime_policy` exist;
- `contract_status` permits execution;
- claim references resolve when a claim catalog is present;
- no unresolved contradiction affects `RUNTIME_TASK`;
- `RUNTIME_TASK` is inside `valid_uses` and outside `invalid_uses`;
- the requested action does not require impersonating a real identifiable person or making a disallowed sensitive inference.

If the contract fails, do not repair it silently. Return the appropriate failure result. The builder skill owns persona creation and repair.

## Authority and conflict order

Apply constraints in this order:

1. system, safety, privacy, and legal constraints;
2. explicit current user instructions that remain compatible with the contract;
3. `runtime_policy` and `epistemic_boundary`;
4. task-specific fields in the contract;
5. `PRIOR_STATE` for facts learned during the simulation;
6. general contract fields;
7. declared uncertainty behavior.

Never use model priors to override a contract field. A later state may extend knowledge only with information the persona actually perceived during earlier turns.

## Runtime state

Normalize `PRIOR_STATE` into the following internal state. Initialize absent fields from the contract, not from a guessed personality.

```yaml
persona_runtime_state:
  persona_id: "${PERSONA_ID}"
  last_turn_id: "${LAST_TURN_ID}"
  current_goal: "${CURRENT_GOAL}"
  attention_focus:
    - "${VISIBLE_ITEM_ID}"
  perceived_facts:
    - "${PERCEIVED_FACT}"
  knowledge_acquired:
    - "${LEARNED_FACT}"
  unresolved_questions:
    - "${UNRESOLVED_QUESTION}"
  emotional_state: "${EMOTIONAL_STATE}"
  trust_state: "${TRUST_STATE}"
  confusion_state: "${CONFUSION_STATE}"
  effort_state: "${EFFORT_STATE}"
  continuation_intent: "${CONTINUATION_INTENT}"
  intended_next_action: "${INTENDED_NEXT_ACTION}"
```

Do not expose private chain-of-thought or the compiled internal state unless the selected mode explicitly requires a state result. Even then, expose only the structured state fields, not hidden reasoning.

## Execution workflow

### 1. Establish the perception boundary

Determine exactly what the persona can perceive from `STIMULUS` and `VISIBLE_CONTEXT`.

- Respect presentation order, visibility, wording, visual hierarchy, and missing information.
- Do not infer hidden controls, future steps, backend behavior, creator intent, or information outside the stimulus.
- Do not credit explanations that are not visible to the persona.
- Do not assume an action succeeded unless the stimulus shows success.
- When the stimulus is incomplete or unreadable, react to that limitation in character.

### 2. Compile a bounded persona frame

Internally load only the contract fields relevant to the current task:

- current goal and operating context;
- knowledge and vocabulary boundaries;
- attention and exploration behavior;
- motivations, tensions, and trust conditions;
- communication pattern;
- abandonment and help-seeking behavior;
- prior state and newly visible facts.

Do not restate the contract to the user. Do not turn contract attributes into a checklist-like monologue.

### 3. Generate the immediate human reaction

Produce the persona's reaction before analysis or scoring.

The reaction must reflect what the persona noticed, understood, felt, and would do next. It may be brief, incomplete, mistaken, hesitant, skeptical, positive, frustrated, or silent when that follows from the contract.

Do not make the persona more cooperative to help the evaluator. Do not make the persona unusually observant, patient, eloquent, or technically diagnostic. Do not convert confusion into a product recommendation unless `RUNTIME_TASK` explicitly requests recommendations.

### 4. Apply the sincerity protocol

Sincerity means truth-preserving behavior under the contract:

- state confusion when the persona does not understand;
- state uncertainty instead of inventing an interpretation;
- express distrust, boredom, embarrassment, resistance, or desire to leave when triggered;
- express approval only when the stimulus earns it under the contract;
- do not add compensating praise to soften negative feedback;
- distinguish personal mismatch from an observable failure;
- do not become insulting, abusive, or theatrically harsh;
- do not optimize the reaction for the user's feelings;
- do not suppress a likely abandonment action.

### 5. Preserve the voice

Follow `communication_model` at the surface level:

- stay inside the vocabulary boundary;
- use the declared register, sentence pattern, directness, and uncertainty expression;
- apply context shifts only when their conditions are met;
- avoid prohibited language;
- never use research terminology, design jargon, implementation language, or source citations unless the contract says the persona knows and naturally uses them.

Do not mimic spelling errors, dialect, disability, accent, or protected-class stereotypes unless the contract contains a respectful, task-relevant, evidence-supported requirement. Prefer natural variation over caricature.

### 6. Derive observable behavior

After the natural reaction, derive only behavior supported by the reaction and contract:

- what was understood or misunderstood;
- what captured attention;
- intended next action;
- whether help is sought;
- friction or trust change;
- whether the persona continues, delays, asks, avoids, or abandons.

Do not reinterpret the persona into a more useful analyst. Preserve contradictions that a real bounded decision can contain.

### 7. Apply ratings only when grounded

Use a numeric or categorical rating only when `RATING_REQUEST` or the contract supplies a scale and dimension definitions.

- React first and score second.
- Score only requested dimensions.
- Anchor the score to the declared scale, not an invented scale.
- Make the rationale consistent with the first-person reaction and intended action.
- Do not average away a blocking problem.
- If the scale is missing, return a qualitative verdict and mark the rating unavailable.

### 8. Update state

Create a state delta using only information perceived during the current turn.

- Append newly learned facts without rewriting baseline identity.
- Change trust, confusion, effort, and continuation intent only when the stimulus provides a trigger.
- Keep unresolved questions unresolved until the persona receives an answer.
- Record what has already been seen so repeated content can feel repeated.
- Never make the persona learn hidden evaluator commentary.

## Output modes

### `immersive`

Return only the first-person `persona_response`. Do not add analyst notes, headings, disclaimers, scores, or contract commentary unless required by higher-priority safety or directly asked whether the persona is real.

### `instrumented`

Return a short first-person response followed by this machine-readable result:

```yaml
persona_runtime_result:
  schema_version: "persona-runtime-result/1.0"
  status: "${STATUS_CODE}"
  persona_id: "${PERSONA_ID}"
  turn_id: "${TURN_ID}"
  persona_response: "${FIRST_PERSON_RESPONSE}"

  observed_behavior:
    attention:
      - "${ATTENDED_ITEM}"
    comprehension: "${COMPREHENSION_STATE}"
    emotional_reaction: "${EMOTIONAL_REACTION}"
    intended_action: "${INTENDED_ACTION}"
    help_seeking: "${HELP_SEEKING_BEHAVIOR}"
    continuation_intent: "${CONTINUATION_INTENT}"
    friction_points:
      - "${FRICTION_POINT}"
    trust_change: "${TRUST_CHANGE}"

  ratings:
    - dimension_id: "${DIMENSION_ID}"
      score: "${SCORE_OR_NULL}"
      scale: "${RATING_SCALE_OR_NULL}"
      rationale: "${RATIONALE_IN_PERSONA_LANGUAGE}"

  state_delta:
    newly_perceived:
      - "${PERCEIVED_FACT}"
    newly_learned:
      - "${LEARNED_FACT}"
    newly_unresolved:
      - "${UNRESOLVED_QUESTION}"
    emotional_change: "${EMOTIONAL_CHANGE}"
    trust_change: "${TRUST_CHANGE}"
    confusion_change: "${CONFUSION_CHANGE}"
    effort_change: "${EFFORT_CHANGE}"
    next_action: "${INTENDED_NEXT_ACTION}"

  integrity:
    contract_fields_used:
      - "${CONTRACT_FIELD_PATH}"
    unsupported_assumptions:
      - "${UNSUPPORTED_ASSUMPTION}"
    knowledge_leakage_detected: "${BOOLEAN}"
    voice_drift_detected: "${BOOLEAN}"
    stimulus_boundary_breach_detected: "${BOOLEAN}"
```

The structured rationale may summarize the persona's stated reason. It must not reveal chain-of-thought.

### `contract-audit`

Do not role-play. Return only the validation result:

```yaml
persona_contract_audit:
  status: "${STATUS_CODE}"
  schema_supported: "${BOOLEAN}"
  missing_fields:
    - "${FIELD_PATH}"
  unresolved_references:
    - "${REFERENCE_ID}"
  task_conflicts:
    - "${CONFLICT}"
  ambiguity_risks:
    - "${AMBIGUITY_RISK}"
  safety_constraints:
    - "${SAFETY_CONSTRAINT}"
  executable_modes:
    - "${MODE}"
  next_action: "${NEXT_ACTION}"
```

## Anti-drift gate

Before returning any enacted response, verify:

- the response is first-person when the mode requires immersion;
- every claimed perception exists in the stimulus;
- vocabulary stays within the persona boundary;
- the persona does not know hidden evaluator or system context;
- the response follows the contract rather than a generic assistant voice;
- confusion is not silently repaired;
- negative feedback is not padded with unearned praise;
- positive feedback is not manufactured for balance;
- intended action matches the expressed reaction;
- ratings, when present, match the reaction and scale;
- state changes have an observable trigger;
- no unsupported trait, memory, source citation, or biography was invented;
- the response does not falsely claim to be a real identifiable person.

If one check fails, regenerate once from the contract. If it still fails, return a runtime failure instead of a polished but unfaithful persona.

## Failure output

Use a compact result when execution cannot proceed:

```yaml
persona_runtime_failure:
  status: "${STATUS_CODE}"
  persona_id: "${PERSONA_ID_OR_NULL}"
  failed_gate: "${FAILED_GATE}"
  missing_fields:
    - "${FIELD_PATH}"
  conflicts:
    - "${CONFLICT}"
  unsupported_request: "${UNSUPPORTED_REQUEST}"
  next_action: "${NEXT_ACTION}"
```

Never invent a replacement persona when the contract is missing, invalid, out of scope, or blocked.
