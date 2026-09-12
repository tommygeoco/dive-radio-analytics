# September 12 classifier transport review

Morning production deployed automatically, but the legacy comment model returned a mutated YouTube reply ID and the strict parser withheld two comments. The failed:10 attempt remains intact.

Request-local aliases now keep native IDs outside model transcription in golden, first and second reads. Complete exact alias membership is required before restoring native IDs; no fuzzy ID matching or relaxed validation. Native-ID deterministic audit sampling, prompts, classifier versions and historical labels remain unchanged.

Independent focused critic: PASS, no blocking findings. Regression proves full long-ID restoration with reordered output and rejects duplicate, missing and foreign aliases. Model failure preservation and expanded feedback tests also passed. Source adoption does not claim a new production data release or unattended success; the reserved noon chain remains the next complete scheduled attempt.
