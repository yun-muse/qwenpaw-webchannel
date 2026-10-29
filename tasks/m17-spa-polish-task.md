# M17 — SPA polish nits (CodeBuddy task, SPA only)

Scope: spa/ only. Do NOT touch plugin/ or relay-*. Investigate first with
evidence, fix only what is proven, keep changes minimal.

1. Export feedback (proven nit from M12): clicking export currently gives no
   visible progress/success feedback (the download itself works). Add a small
   toast/status: in-progress on click, success after the verified download
   starts, error on E_TOOBIG/failure. Reuse the SPA's existing toast/status
   patterns if any exist — check first.
2. Duration "0.0s" (proven nit from M15): the per-turn receipt tooltip shows
   duration 0.0s in production because source timestamps carry no span.
   Investigate what timing data the SPA actually receives. If no real span
   exists, REMOVE the misleading duration display (do not fabricate one).
   Only compute a duration if real start/end timestamps are present in the
   data the SPA already gets.
3. Reload restore: check whether the SPA restores the last opened chat after
   a page reload or lands on a new empty chat. Evidence from code first.
   If it does not restore: persist the current chat id in localStorage and,
   on load, reopen it when it still exists in the server chat list; fall
   back to current behaviour otherwise. If it already restores, report the
   evidence and change nothing for this item.

Verify: `npm run build` in spa/ must pass; if spa has any test/lint script,
run it. Do NOT commit, do NOT deploy. Report per item: evidence found,
change made (or why none), files touched.
