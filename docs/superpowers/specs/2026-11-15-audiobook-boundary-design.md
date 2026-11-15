# Cached audiobook boundary continuation

Approved in chat on 2026-11-15.

Reduce the silence between pages by synthesizing the remaining current-page text
and the next page's first sentence together. This includes the current page's final
sentence in the same recording as the next page's opening. Cache and prefetch these
recordings using the existing bounded cache.

Use word timings to stop at the current page's last word, perform the existing
page turn, then resume the retained recording at the next page's first word.
Prefetch the next page's remainder and its following opening while playback runs.
Never replay or skip the consumed opening. Manual navigation, settings changes,
document replacement, and incompatible relayout abandon the continuation.

The page-turn animation and navigation remain unchanged, so the animation still
contributes a pause. Preserve highlighting in book offsets and pause/resume behavior.
If service timings cannot identify the boundary, fall back to ordinary page audio.

Implementation detail: decoded Web Audio sources enforce each timed stop in the
audio engine, so delayed background callbacks cannot play or repeat lookahead.
The service chunker protects the final sentence pair when it fits the 2000-byte
escaped-text budget. Oversized sentence pairs still need bounded chunking.

## Approaches

Existing full-page prefetch already hides synthesis latency but retains separate
recordings and their silence. Trimming only those recordings cannot provide shared
sentence context. The approved joint recording approach preserves context and reuses
the player across the page turn, at the cost of tracking a consumed page prefix.

## Validation

Test the public Audiobook interface with controlled speech and media adapters:
boundary timing, retained continuation, no skipped/repeated words, manual navigation,
pause/resume, settings/relayout invalidation, missing timing fallback, and book end.
These deterministic tests verify scheduling; perceived audio quality still needs a
live listening check against the speech service.
