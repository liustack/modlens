# ModLens Output Schema (v1)

```json
{
  "summary": "string",
  "ocr": {
    "full_text": "string",
    "lines": [
      {
        "text": "string",
        "language": "string",
        "confidence": 0
      }
    ]
  },
  "layout": {
    "regions": [
      {
        "id": "string",
        "type": "title|subtitle|paragraph|list|table|chart|form|image|icon|other",
        "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 },
        "reading_order": 1,
        "text": "string"
      }
    ]
  },
  "semantics": {
    "scene": "string",
    "intent": "string",
    "entities": [
      {
        "name": "string",
        "type": "string",
        "evidence": "string"
      }
    ],
    "relations": [
      {
        "subject": "string",
        "predicate": "string",
        "object": "string"
      }
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

Notes:
- `confidence` is 0-1 numeric estimate.
- `bbox` uses image-relative coordinates.
- If a field is unavailable, return empty string/array and explain in `uncertainty`.
