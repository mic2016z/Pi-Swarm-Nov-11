# 24-agent greeting benchmark

Timing starts at local relay submission, not the start of speech. Completion requires a fresh marked greeting from every worker. Measure first worker completion, last worker completion, and master reply publication separately. Missing replies are reported as incomplete, never as a completed 24-agent round trip.

| Test | Master / transport | Result |
|---|---|---|
| 1 | Existing running Codex CLI / legacy dispatch | Incomplete: 23/24. First 42.06s; last received 51.09s; master report 249.89s. Pi 9 pending; raw data in hello-01.json |
| 2 | Restarted app / Codex CLI; verify actual dispatch transport | Pending user restart |
| 3 | Pi master / Astra; verify actual dispatch transport | Pending master adapter implementation and user switch |

One trial per condition is exploratory. Keep worker models, prompts, roster, provider concurrency and comparable idle state fixed; record differences. The Intercom peer integration alone does not replace Codex's legacy worker dispatcher.

Test 1 is not an all-24 completion measurement: Pi 9 had a pre-existing pending job and did not complete this greeting. The master reported a partial result. Retest from a comparable ready state before drawing speed conclusions.
