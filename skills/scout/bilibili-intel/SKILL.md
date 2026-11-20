---
name: bilibili-intel
role: scout
description: Use when extracting Bilibili video subtitles/transcripts and comments for security intelligence.
---

# Bilibili Video Intelligence Skill (Scout)

When assigned to extract technical intelligence from a Bilibili video (`BV...`, `bilibili.com/video/...`, or `b23.tv/...`):

1. Run the WBI-signed subtitle extractor via `bash`:
   ```bash
   python3 "$(dirname "$SCOUT_WORKSPACE")/../scripts/bili_sub.py" "<url_or_bvid>" > "$SCOUT_WORKSPACE/bili_transcript.txt"
   head -n 120 "$SCOUT_WORKSPACE/bili_transcript.txt"
   ```
2. Read through `$SCOUT_WORKSPACE/bili_transcript.txt` (note that Bilibili ASR `ai-zh` often homophone-mangles English security terms — reconstruct technical terms from context).
3. Record key architectural facts via `record_fact(insight_id=..., ...)` and submit the structured digest via `submit_scout_report`.
