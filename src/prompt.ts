export function buildVisionPrompt(imageAbsolutePath: string, extraPrompt?: string): string {
    const basePrompt = `Analyze this image: ${imageAbsolutePath}

You are an image parsing engine.
Analyze the provided image.

Goal: Convert all image information into structured results consumable by a text-only LLM.

Strict requirements:
1. Output JSON only. No Markdown, no explanatory text.
2. Cover all visible text, semantics, structure, layout, and visual clues as thoroughly as possible.
3. If any information is uncertain, note it in the uncertainty field.

Output JSON structure:
{
  "summary": "",
  "ocr": {
    "full_text": "",
    "lines": [
      {
        "text": "",
        "language": "",
        "confidence": 0
      }
    ]
  },
  "layout": {
    "regions": [
      {
        "id": "",
        "type": "title|subtitle|paragraph|list|table|chart|form|image|icon|other",
        "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 },
        "reading_order": 1,
        "text": ""
      }
    ]
  },
  "semantics": {
    "scene": "",
    "intent": "",
    "entities": [
      {
        "name": "",
        "type": "",
        "evidence": ""
      }
    ],
    "relations": [
      {
        "subject": "",
        "predicate": "",
        "object": ""
      }
    ]
  },
  "visual": {
    "dominant_colors": [""],
    "style": "",
    "notes": [""]
  },
  "uncertainty": [""]
}`;

    if (!extraPrompt || !extraPrompt.trim()) {
        return basePrompt;
    }

    return `${basePrompt}\n\nAdditional requirements:\n${extraPrompt.trim()}`;
}
