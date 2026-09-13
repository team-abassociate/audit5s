# Visual QA Comparison — Agent Vision

No scripts, no Python. The agent reads both images and performs the QA analysis directly.

---

## How to compare

1. Read the **reference** image (Figma screenshot or local file) with the Read tool.
2. Read the **live screenshot** (`/tmp/pixel_perfect_iter.png`) with the Read tool.
3. Analyze both images side by side using the checklist below.
4. Delete `/tmp/pixel_perfect_iter.png` immediately after reading.

---

## What to check — full QA checklist

Work through every category. For each defect, note:
- **Where** — element name or visual location (e.g. "nav bar", "hero button", "left sidebar")
- **Current** — what the live page shows
- **Expected** — what the reference shows
- **Severity** — CRITICAL / MAJOR / MINOR

---

### Layout & Structure
- Overall page structure: header, nav, sidebar, main content, footer — positions match?
- Section order and nesting
- Elements aligned on the correct axis (horizontal / vertical)
- No unexpected overflow or wrapping at this viewport
- Grid columns / flex rows — correct count and proportion

### Spacing
- Padding inside components (all four sides)
- Margin / gap between elements
- Section spacing (top/bottom of each major block)
- Consistent rhythm where spacing repeats

### Typography
- Font family (serif / sans-serif / mono — does it visually match?)
- Font size (larger, smaller, or matching?)
- Font weight (lighter or heavier than reference?)
- Line height (tighter or looser?)
- Letter spacing
- Text color (exact shade)
- Text alignment (left / center / right / justified)
- Text truncation or wrapping (expected?)

### Colors
- Background colors (solid, gradient, transparent)
- Text colors on all variants (headings, body, captions, links)
- Button fill and label colors
- Border and divider colors
- Icon colors
- Badge / chip / tag colors
- Focus rings and interactive states visible in the screenshot
- Shadows (color, offset, blur, spread)

### Borders & Shapes
- Border width (thin / medium / thick)
- Border style (solid / dashed / dotted / none)
- Border radius (sharp corners / slightly rounded / pill / circle)
- Outline vs box-shadow distinction

### Icons & Images
- Icons present, correct visual size, correct fill color
- Images/illustrations present, correct aspect ratio, not distorted or cropped wrong
- SVG icons match design (not swapped with a different icon)

### Components & Elements
- All buttons: label text, size, corner radius, color, border
- Input fields: height, border, placeholder style
- Dropdowns, selects: appearance when closed
- Badges, chips, tags: text, background, border-radius
- Cards: padding, shadow, corner radius
- Navigation: item order, active/selected state indicator
- Tables: column widths, header style, row borders
- Modals / popovers: if visible in reference
- Loading states / skeletons: if visible
- **Missing elements** — in reference but absent from live page
- **Extra elements** — on live page but not in reference

---

## Severity guide

| Severity | Examples |
|---|---|
| **CRITICAL** | Missing entire section, wrong component type, layout completely broken, wrong page shown |
| **MAJOR** | Spacing off by more than ~4px visually, wrong font size/weight on key text, key color incorrect, icon wrong or missing |
| **MINOR** | Slight shade difference, 1-2px misalignment, minor padding difference, font rendering difference |

---

## Output format

Produce a structured defect list:

```
### CRITICAL
- **[Element/Area]**: {current} → {expected}

### MAJOR
- **[Element/Area]**: {current} → {expected}

### MINOR
- **[Element/Area]**: {current} → {expected}

### What matches
- {item} ✓
- {item} ✓
```

Then give an **overall verdict**:
- **PASS** — only MINOR defects or none
- **NEEDS WORK** — one or more MAJOR defects
- **FAIL** — one or more CRITICAL defects
