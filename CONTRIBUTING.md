# Contributing

Thank you for improving the Suwappu Trading Bot. This repository is intentionally small: prefer changes that make the Suwappu integration, operating safety, or builder experience clearer over adding a broad strategy framework.

## Local verification

Use Bun 1.3.14+ and Python 3.12+:

```bash
bun install --frozen-lockfile
bun run verify
```

Pull requests also run the container build and CodeQL.

## Money-path review

Treat a change as money-path sensitive if it affects live flags, wallet binding, quote/simulation checks, `src/execution.ts`, managed API calls, durable state, idempotency, reconciliation, Docker commands, or retry behavior.

For those changes, explain in the PR:

1. what the economic action is;
2. where permission is granted;
3. what is durable before a side effect can begin;
4. which failures are outcome-unknown;
5. how the same action recovers without becoming a duplicate;
6. which regression test proves the invariant.

Never weaken preview-by-default or turn a timeout into a proven failure merely to simplify control flow.

## Product claims

Do not describe this price-target example as profitable, “AI alpha,” or a backtested strategy unless the repository actually contains reproducible evidence for that claim. Keep customer strategy P&L separate from a builder's subscription/usage contribution margin.

When adding an integration claim, prefer a source-of-truth API contract or the maintained implementation over screenshots or stale prose.

## Scope

Good additions include stronger response validation, outcome recovery, observability that avoids sensitive data, operator tooling, realistic product economics, and examples that map precisely to current Suwappu REST/SDK/MCP authority.

Large strategy engines, multi-exchange connector suites, and generalized backtest platforms are usually better built on dedicated frameworks and integrated at the Suwappu boundary rather than copied here.
