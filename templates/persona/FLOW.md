# Flow — <name it after the journey, e.g. "checkout" or "onboarding">

## Entry point

<Where the persona starts: a URL for web, an app + launch state for desktop, a
command for CLI. Be exact — the persona perceives only what the tools show.>

## Goal (the persona's own goal, in their terms)

<What the persona is trying to accomplish — "subscribe to the Pro plan", "create my
first project and understand what it did". Not a test script: personas explore, get
confused, and abandon. That is the data.>

## Success criteria

<How the run knows the persona made it — an observable end state, e.g. "the
dashboard shows the active subscription".>

## Domain allowlist (hard boundary)

- staging.example.com
- accounts.example.com

The persona never navigates outside these. Point flows at staging, not production.

## Out of bounds (never executed, even inside the allowlist)

Payments, account deletion, and destructive submits are always out of bounds — the
conductor journals the intent as a finding instead of acting. List anything else
here that must not be touched:

- <e.g. the "invite teammates" email sender>

## App version pin

<How to identify the build under test: a git commit, a package version, a deployed
version string on the page, or the URL + date. The report pins this so runs are
comparable across releases.>

## Step budget (optional)

max_turns: 40
