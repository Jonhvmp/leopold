# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- v0.1 in-session engine: `/leopold-brief`, `/leopold-run`, `/leopold-status`, `/leopold-stop` skills.
- Stop hook (`stop-continuity.sh`) for autonomous continuity.
- PreToolUse hook (`guard-irreversible.sh`) that keeps git commit/push and destructive commands locked while autonomous.
- Brief artifact templates: MISSION, CHARTER, GUARDRAILS, PLAN, DECISIONS.
- `install.sh` installer and `settings.template.json` wiring.
- Architecture, decision-protocol, guardrails, and gstack-playbook docs.
