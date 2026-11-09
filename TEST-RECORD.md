# Signal Traffic - test record, 9 November 2026

What this is: a plain-language record of the test runs behind the two demo videos on
the product page. What was run, on what, what came out, and what is not covered.

## Test 1 - free public report (video: signal-traffic-demo-free-run.mp4, 32s)

- Where: the live public page, https://fizzle89.github.io/signal-traffic/, in a
  signed-out browser. No account, no login.
- Input: the "Try with sample data" button, which loads the product's own bundled
  sample log. That sample is synthetic demo data (447 lines, sample dates October
  2026). It is not a real server's log.
- What happened: the report built in the browser and was scrolled end to end.
  Result: 287 agent visits out of 447 requests (64%), 13 known AI or search agents,
  with per-agent tables (hits, most-read pages, status codes, first/last visit) and
  the "pages agents read most" table.
- The $29 buy link was shown but never opened. No checkout was started.

## Test 2 - paid offline full-report copy (video: signal-traffic-demo-offline-copy.mp4, 30s)

- Where: the actual offline full-report HTML file a buyer receives, opened locally.
  No server, no network, no license key entry.
- Part A (real data): the file opens on its embedded report, which is the analysis
  of a real server log from the original production run (20,000 requests, October
  2025). The video scrolls it to show the full, uncapped tables.
- Part B (synthetic data): 5 synthetic demo log lines (TEST-NET-2 addresses
  198.51.100.x, 9 Nov 2026) were pasted in and "Build the report" was clicked. The
  report built locally: 5 requests, 5 agent visits, 4 agents, all classified
  correctly.
- Part C (exports): "Export agent table (CSV)" and "Export full data (JSON)" were
  clicked and both downloaded real files with the correct contents.

## What these tests do not cover

- The actual purchase: no real card charge or refund has been tested. The buy link
  goes to the payment provider's checkout; that page was not opened in these runs.
- The earlier $0 test purchase (9 Nov 2026, earlier that morning) is a separate
  piece of evidence for the purchase and license-key path; it is not part of these
  two videos and is not re-run here.
- Real customer logs at scale (a month of production traffic) are supported by the
  paid copy's design (no line limit) but the largest log actually run in these tests
  is the embedded 20,000-line one.

## Environment

Continuous screen recordings of a real Chrome session, 1280x720, 9 Nov 2026.
Nothing was staged or mocked; the videos are unedited except for the caption bar
stating what each run shows.
