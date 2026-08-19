---
name: persona-contract-builder
description: Researches and compiles an evidence-grounded, domain-agnostic persona contract for any target, market, product, service, workflow, policy, content, or decision context. Use when an agent must create, refresh, segment, or validate a synthetic persona before role-play, evaluation, messaging, discovery, or experience testing. Do not use to enact an existing persona contract.
metadata:
  version: "1.0.0"
  contract-schema: "persona-contract/1.0"
---

# Persona Contract Builder

Create a portable persona contract that another model can execute without receiving a worked persona example.

The output is a synthetic research archetype, not a real person, demographic average, fictional biography, or prediction about every member of a group.

## Core architecture

Treat persona creation as a compilation pipeline:

`brief -> evidence ledger -> bounded claims -> coherent archetype -> validated contract`

Keep these layers separate. Never let fluent prose hide missing evidence, unresolved uncertainty, or a scenario choice made only to make the persona concrete.

Use semantic variables, explicit invariants, typed records, provenance, confidence, and failure states. Do not add worked examples, default persona profiles, or domain-specific demonstrations to this skill.

## Input variables

Resolve the following variables from the request, supplied files, prior conversation, or research.

Required:

- `TARGET`: what the persona relates to.
- `PERSONA_PURPOSE`: the decision, evaluation, simulation, or workflow the persona must support.

Conditionally required:

- `EVALUATION_CONTEXT`: what the persona will encounter or decide about.
- `PERSONA_UNIT`: the human, role, household, team, buying group, or organization represented.
- `GEOGRAPHY`: relevant location boundary.
- `TIME_CONTEXT`: relevant date or period.
- `OUTPUT_LANGUAGE`: language for the contract and runtime voice.
- `SEGMENT_CONSTRAINTS`: characteristics that must be present.
- `EXCLUSION_CONSTRAINTS`: characteristics that must be absent.
- `KNOWN_FACTS`: user-supplied facts that may be treated as authoritative.
- `RESEARCH_MODE`: `live`, `supplied-evidence`, or `hypothesis-only`.
- `RESEARCH_DEPTH`: desired breadth and confidence.
- `SOURCE_BOUNDARIES`: allowed, preferred, and prohibited source classes.
- `RECENCY_REQUIREMENT`: freshness required for claims that may drift.
- `SENSITIVITY_CONSTRAINTS`: privacy, safety, legal, or domain constraints.
- `OUTPUT_MODE`: machine contract only or machine contract plus human summary.

Infer a missing variable only when the current context makes it unambiguous. Ask one compact question when a missing variable would materially change the persona. Otherwise record the field as unknown instead of silently filling it from model priors.

## Evidence policy

### Build an evidence plan

Translate `PERSONA_PURPOSE` into the behavioral dimensions the contract must support. Research only dimensions that can change the intended decision.

Cover the relevant functions of evidence:

- population or market context;
- real activities, constraints, tools, and environment;
- language, questions, coping strategies, and social norms;
- motivations, anxieties, trust, resistance, and abandonment behavior;
- decision rules and observable actions;
- current conditions that can change over time.

Use multiple source functions rather than repeating one source type. Prefer primary research, official statistics, original documentation, direct public behavior, and first-person accounts. Treat community discussions, professional posts, reviews, and comments as qualitative signals, not representative population estimates.

### Preserve provenance

Create an evidence record for every external claim:

```yaml
evidence_record:
  evidence_id: "${EVIDENCE_ID}"
  source_type: "${SOURCE_TYPE}"
  title: "${SOURCE_TITLE}"
  publisher_or_community: "${SOURCE_OWNER}"
  url_or_reference: "${SOURCE_REFERENCE}"
  published_at: "${SOURCE_DATE}"
  accessed_at: "${ACCESS_TIMESTAMP}"
  geography: "${SOURCE_GEOGRAPHY}"
  population_or_context: "${SOURCE_CONTEXT}"
  method: "${SOURCE_METHOD}"
  supported_claim: "${SUPPORTED_CLAIM}"
  limitations: "${SOURCE_LIMITATIONS}"
  evidence_strength: "${EVIDENCE_STRENGTH}"
```

Do not fabricate citations, dates, sample sizes, quotations, or source methods. If source access is unavailable, use `supplied-evidence` or `hypothesis-only` and lower the contract status accordingly.

### Classify every persona claim

Store claims in a claim catalog. Do not blur observed evidence and synthesis.

```yaml
claim_record:
  claim_id: "${CLAIM_ID}"
  statement: "${CLAIM_STATEMENT}"
  basis: "${BASIS_CLASS}"
  evidence_refs:
    - "${EVIDENCE_ID}"
  confidence: "${CONFIDENCE_LEVEL}"
  decision_relevance: "${DECISION_RELEVANCE}"
  contradiction_refs:
    - "${CONTRADICTING_CLAIM_ID}"
  notes: "${CLAIM_NOTES}"
```

`BASIS_CLASS` must be one of:

- `observed-quantitative`;
- `observed-qualitative`;
- `user-supplied`;
- `inferred-synthesis`;
- `scenario-choice`;
- `unknown`.

A `scenario-choice` makes the archetype coherent but must never be presented as research-backed. An `inferred-synthesis` must reference the evidence it interprets. Preserve meaningful disagreement instead of averaging it away.

## Research and synthesis workflow

### 1. Normalize the brief

Write a private working brief containing the resolved variables, unresolved variables, required decisions, and out-of-scope uses. Do not expose internal chain-of-thought.

Reject a brief that asks for a real identifiable person's private traits, hidden mental state, or sensitive attributes inferred from unrelated data. Convert it to a synthetic archetype when possible.

### 2. Research the behavioral reality

Collect evidence until each decision-relevant dimension is either supported or explicitly unknown. Search for behavior and constraints, not only opinions or demographic descriptions.

For time-sensitive claims, verify against the recency requirement. For high-stakes contexts, prioritize authoritative sources and mark the contract unsuitable for replacing professional judgment.

### 3. Build the evidence and claim ledgers

Normalize sources into `evidence_record` entries and assertions into `claim_record` entries. Merge duplicate claims without losing independent evidence references. Record source limitations and selection bias.

### 4. Select one coherent archetype

Choose a persona whose behaviors can coexist in one operating context and whose tensions matter to `PERSONA_PURPOSE`.

Do not create a collage of every observed behavior. Do not make the persona unusually articulate, technical, rational, available, motivated, or patient unless supported. Do not use a protected characteristic as a shortcut for behavior.

Add only the minimum scenario choices needed for continuity. Prefer role, context, constraints, habits, and knowledge boundaries over decorative biography.

### 5. Compile the persona contract

Produce the schema below. Every `*_claim_refs` entry must resolve to `claim_catalog`. Every external claim must ultimately resolve to `source_ledger`.

```yaml
persona_contract:
  schema_version: "persona-contract/1.0"
  persona_id: "${PERSONA_ID}"
  contract_status: "${CONTRACT_STATUS}"
  created_at: "${CREATED_AT}"
  output_language: "${OUTPUT_LANGUAGE}"

  scope:
    target: "${TARGET}"
    purpose: "${PERSONA_PURPOSE}"
    persona_unit: "${PERSONA_UNIT}"
    evaluation_context: "${EVALUATION_CONTEXT}"
    valid_uses:
      - "${VALID_USE}"
    invalid_uses:
      - "${INVALID_USE}"
    geography: "${GEOGRAPHY}"
    time_context: "${TIME_CONTEXT}"

  identity:
    display_label: "${DISPLAY_LABEL}"
    synthetic_identity: true
    contextual_role: "${CONTEXTUAL_ROLE}"
    operating_context: "${OPERATING_CONTEXT}"
    identity_claim_refs:
      - "${CLAIM_ID}"

  epistemic_boundary:
    knows:
      - "${KNOWN_CONCEPT}"
    partially_knows:
      - "${PARTIAL_CONCEPT}"
    does_not_know:
      - "${UNKNOWN_CONCEPT}"
    must_not_infer:
      - "${FORBIDDEN_INFERENCE}"
    knowledge_claim_refs:
      - "${CLAIM_ID}"

  environment_model:
    routines_claim_refs:
      - "${CLAIM_ID}"
    tools_and_channels_claim_refs:
      - "${CLAIM_ID}"
    interruptions_claim_refs:
      - "${CLAIM_ID}"
    constraints_claim_refs:
      - "${CLAIM_ID}"

  motivation_model:
    desired_outcomes_claim_refs:
      - "${CLAIM_ID}"
    anxieties_claim_refs:
      - "${CLAIM_ID}"
    tensions_claim_refs:
      - "${CLAIM_ID}"
    identity_threats_claim_refs:
      - "${CLAIM_ID}"

  behavior_model:
    current_behaviors_claim_refs:
      - "${CLAIM_ID}"
    decision_rules_claim_refs:
      - "${CLAIM_ID}"
    coping_strategies_claim_refs:
      - "${CLAIM_ID}"
    exploration_style_claim_refs:
      - "${CLAIM_ID}"
    help_seeking_claim_refs:
      - "${CLAIM_ID}"
    abandonment_triggers_claim_refs:
      - "${CLAIM_ID}"
    trust_builders_claim_refs:
      - "${CLAIM_ID}"
    trust_breakers_claim_refs:
      - "${CLAIM_ID}"

  communication_model:
    default_register: "${DEFAULT_REGISTER}"
    vocabulary_boundary: "${VOCABULARY_BOUNDARY}"
    sentence_pattern: "${SENTENCE_PATTERN}"
    directness: "${DIRECTNESS_POLICY}"
    uncertainty_expression: "${UNCERTAINTY_EXPRESSION}"
    frustration_expression: "${FRUSTRATION_EXPRESSION}"
    context_shifts:
      - condition: "${CONTEXT_CONDITION}"
        register: "${CONTEXT_REGISTER}"
    prohibited_language:
      - "${PROHIBITED_TERM_OR_CLASS}"
    communication_claim_refs:
      - "${CLAIM_ID}"

  interaction_model:
    attention_pattern: "${ATTENTION_PATTERN}"
    first_scan_targets:
      - "${SCAN_TARGET}"
    action_threshold: "${ACTION_THRESHOLD}"
    error_response: "${ERROR_RESPONSE}"
    learning_preference: "${LEARNING_PREFERENCE}"
    interaction_claim_refs:
      - "${CLAIM_ID}"

  evaluation_model:
    evaluation_dimensions:
      - dimension_id: "${DIMENSION_ID}"
        question: "${DIMENSION_QUESTION}"
        observable_signal: "${OBSERVABLE_SIGNAL}"
    rating_scale: "${RATING_SCALE_OR_NULL}"
    verdict_policy: "${VERDICT_POLICY}"

  runtime_policy:
    first_person: true
    reaction_before_analysis: true
    honesty_over_pleasantness: true
    knowledge_leakage_forbidden: true
    hidden_context_inference_forbidden: true
    technical_language_requires_contract_support: true
    unsupported_trait_invention_forbidden: true
    disclose_synthetic_nature_if_directly_asked: true
    uncertainty_behavior: "${UNCERTAINTY_BEHAVIOR}"

  source_ledger:
    - "${EVIDENCE_RECORD}"

  claim_catalog:
    - "${CLAIM_RECORD}"

  uncertainty:
    unsupported_dimensions:
      - "${UNSUPPORTED_DIMENSION}"
    unresolved_contradictions:
      - "${CONTRADICTION}"
    open_questions:
      - "${OPEN_QUESTION}"
    overall_confidence: "${OVERALL_CONFIDENCE}"
```

If `OUTPUT_MODE` includes a human summary, derive it from the contract after validation. Keep the contract authoritative. The summary must not introduce new traits.

## Validation gate

Set `CONTRACT_STATUS` to `ready` only when all applicable checks pass:

- both required input variables are resolved;
- valid and invalid uses are explicit;
- all claim and evidence references resolve;
- inferred claims cite supporting evidence;
- scenario choices are labeled;
- decision-relevant contradictions are resolved or surfaced;
- knowledge boundaries can prevent expert-language leakage;
- communication guidance is behavioral, not a caricature;
- behavior includes observable actions, not only adjectives;
- trust and abandonment conditions are specific enough to execute;
- no unsupported sensitive attribute or real-person impersonation is present;
- no human summary adds information absent from the contract;
- the contract can be consumed without access to research prose or worked examples.

Use `draft` when the contract remains usable as a hypothesis but lacks evidence or required fields. Use `blocked` when safety, missing authority, or missing critical input prevents a responsible contract.

## Failure output

When a ready contract cannot be produced, return a compact machine-readable result:

```yaml
persona_build_result:
  status: "${STATUS_CODE}"
  missing_inputs:
    - "${MISSING_INPUT}"
  evidence_gaps:
    - "${EVIDENCE_GAP}"
  conflicts:
    - "${CONFLICT}"
  safety_constraints:
    - "${SAFETY_CONSTRAINT}"
  next_action: "${NEXT_ACTION}"
```

Do not hide a weak contract behind polished narrative.
