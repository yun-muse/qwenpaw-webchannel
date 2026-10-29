# M20 — Feature probes + implementation (CodeBuddy task)

Rule for items 1–2: PROBE FIRST against the QwenPaw v2.2.2.post1 reference
source (~/workspace/qwenpaw-ref) and the plugin's existing API usage. Only
implement if a clean, supported API path exists. History-file surgery or
undocumented hacks = SKIP with evidence, do not improvise.

1. Regenerate last reply: can the last assistant turn be dropped and the
   last user message re-run through a supported API? If yes: plugin frame
   + SPA button on the last assistant reply （重新生成）, streaming behaves
   like a normal turn, usage receipts keep working. If no: report the APIs
   inspected and why each fails.
2. Edit last user message & resend: same gate. If feasible with the same
   mechanism as (1), add 编辑并重发 on the last user message; else skip
   with evidence.
3. Export v2 (plugin-side, low risk): probe the current export assembly
   (M12). Add a metadata header (agent, model if known, exported-at,
   message count) and, only if the history payload already carries it,
   per-turn usage footnotes in the exported Markdown. Keep the chunked
   transfer + sha256 verification exactly as-is; update plugin tests.
4. duration_ms cleanup: the plugin still emits duration_ms in turn receipts
   but the source timestamps carry no span (always ~0) and the SPA stopped
   parsing it in M17. Probe ALL consumers (SPA, relay-cf, relay-node,
   tests, protocol/frames.md). If nothing consumes it: stop emitting it,
   update protocol/frames.md per its versioning conventions, update plugin
   tests. If something consumes it: document it as deprecated instead and
   change nothing else.

All existing plugin suites must pass (update them where behaviour changed);
SPA build must pass if the SPA changed. Rebuild dist/webchannel.zip in the
repo's established way and report its size + MD5. Do NOT commit, do NOT
install to the hosted instance — deployment is the coordinator's step.
Report per item: probe evidence, implemented or skipped (why), tests.
