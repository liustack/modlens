# ModLens Output Schema (v2)

The CLI prints one JSON object to stdout:

```json
{
  "image": "/abs/path/or/url",
  "provider": "antigravity-cli",
  "result": { "...": "see below" },
  "meta": {
    "generatedAt": "2026-08-01T12:00:00.000Z",
    "model": "gemini-3.6-flash-low",
    "conversationId": "string|null",
    "durationSeconds": 25.4,
    "usage": {}
  }
}
```

`result` is enforced by JSON schema on the provider side (`--json-schema`):

```json
{
  "summary": "string",
  "ocr": {
    "full_text": "string",
    "lines": [
      { "text": "string", "language": "string (optional)" }
    ]
  },
  "layout": {
    "regions": [
      {
        "type": "title|subtitle|paragraph|list|table|chart|form|code|image|icon|other",
        "reading_order": 1,
        "text": "string"
      }
    ]
  },
  "semantics": {
    "scene": "string",
    "intent": "string (optional)",
    "entities": [
      { "name": "string", "type": "string", "evidence": "string (optional)" }
    ],
    "relations": [
      { "subject": "string", "predicate": "string", "object": "string" }
    ]
  },
  "visual": {
    "dominant_colors": ["string"],
    "style": "string",
    "notes": ["string"]
  },
  "uncertainty": ["string"]
}
```

Required fields: `summary`, `ocr`, `layout`, `semantics`, `uncertainty`. `visual` is optional.

Changes from v1: pixel `bbox` coordinates and numeric `confidence` scores were removed. Vision models fabricate both, so v2 stops pretending to provide them. `layout.regions[].type` gained `code`.
