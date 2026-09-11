# Pi Swarm

Ant-colony coding swarm: one Queen planner + many light Pi workers cutting coding tasks into tagged slices and executing them in parallel. Tauri desktop app, native Rust relay, peer messaging, shared task board.

- Priorities: [docs/PRD.md](docs/PRD.md). Queen plans; workers claim dep-ready, capability-matching slices; guards (budgets, TTL, pair cutoff, acceptance evidence) enforced.
- The Queen never claims slices. Sign-off requires recorded acceptance output + exit code 0.
- Workers idle at zero cost — no polling loops, push-based delivery.
- Fix the 7 known bugs from the HQS PRD before new features: relay identity, inbox delete-before-delivery, reservation gaps, unfalsifiable sign-off, settle freshness, seeded doc refresh, feed append race.
- Before done: tests, build, and a live colony acceptance run.
