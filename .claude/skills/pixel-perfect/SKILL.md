---
name: pixel-perfect
description: |
  Use this skill when the user says "pixel perfect", "QA this design", "check this against Figma",
  "compare this page to the design", "visual QA", or provides a Figma URL / reference image and a
  live URL to compare against. Works for web pages (via browser MCP) and React Native apps running
  on iOS Simulator or Android Emulator (via xcrun simctl / adb). This is a QA assessment skill: it
  captures the live UI, compares it visually against the design reference, and reports every visual
  defect — colors, spacing, typography, alignment, missing elements, wrong sizes — without touching code.
context: fork
---

# Visual QA Assessment

$ARGUMENTS

Parse the arguments — freeform text:
- **Design source** — a Figma URL (`figma.com/...`) or a local image path (the reference)
- **Target** — one of:
  - A web URL (starts with `http://` or `https://`) → **Web target**
  - `ios-simulator` / `ios` / mentions of "simulator" / "React Native" with no URL → **iOS Simulator target**
  - `android-emulator` / `android` / "emulator" → **Android Emulator target**
  - If ambiguous and no URL given, ask the user: "Is this a web page or a React Native app on simulator/emulator?"
- **Viewport** — optional WxH (web only; default: match Figma frame dimensions, fallback `1440x900`)
- **Credentials** — optional username/password (web only)

---

## Step 1 — Get the reference design

### If a Figma URL was provided

1. Parse `fileKey` and `nodeId` from the URL per the Figma MCP rules (see system prompt).
2. Call `get_design_context` (or `get_screenshot`) with `fileKey` and `nodeId`.
3. Read the returned screenshot — note its **pixel dimensions** (use as viewport for web; note for comparison for native).
4. Keep it in memory only — **do not save to disk**.

### If a local image path was provided

1. Read it with the Read tool.
2. Note its dimensions.

---

## Step 2 — Capture the live UI

**Choose the path based on the target type.**

---

### PATH A — Web target (URL provided)

Use **browser MCP tools** (`browser_navigate`, `browser_snapshot`, `browser_resize`, `browser_take_screenshot`). No Python, no scripts.

#### 2a — Navigate

```
browser_navigate(url = TARGET_URL)
```

#### 2b — Diagnose what you landed on

After navigation, call `browser_snapshot` and reason about the result:

| What you see | Diagnosis | Action |
|---|---|---|
| HTTP 404 / "Page not found" in title or body | **Page does not exist** | Stop, report to user (see §PageNotFound) |
| URL changed to `/login`, `/sign-in`, `/auth`, `/hub/auth` or snapshot shows password field / "Sign in" CTA | **Login required** | Go to §Login |
| URL and content match the target (nav, layout, expected page title) | **Ready** | Continue to 2c |

#### §PageNotFound — Page does not exist

Tell the user:
> "Could not reach `{TARGET_URL}` — the server returned a 404 or the page does not exist.  
> Possible reasons: wrong URL, the route needs a specific ID/slug, or the page isn't deployed yet.  
> Please double-check the URL and retry."

Stop the skill here.

#### §Login — Login required

The **agent handles login** — never ask the user to log in manually.

**If credentials were provided upfront**, use them immediately:
```
browser_navigate("/login")              ← navigate to login page if not already there
browser_fill(<email field>, USERNAME)
browser_fill(<password field>, PASSWORD)
browser_click(<submit button>)
browser_snapshot                        ← confirm redirect to target
```
Infer selectors from the snapshot. Common patterns: `input[type=email]`, `#email`, `input[name=username]`, `input[name=email]`, `input[type=password]`, `button[type=submit]`.

If login succeeds (URL changed to target), continue to 2c.  
If still on login page (wrong creds), stop and tell the user the credentials failed.

**If credentials were NOT provided**, stop and ask — but only for the credentials, nothing else:
> "The page at `{TARGET_URL}` requires authentication. Please give me:  
> - Username / email  
> - Password  
> I'll handle the login."

Once the user provides them, do the login yourself (fill form, submit, verify redirect), then continue.

**Never screenshot a login page or marketing homepage and compare it against an authenticated design reference.**

#### 2c — Resize the browser to match the design

```
browser_resize(width = DESIGN_WIDTH, height = DESIGN_HEIGHT)
```

Use the dimensions extracted from the Figma frame / reference image. Default to `1440 x 900` if unknown.

Wait briefly (snapshot) to let the layout reflow after resize.

#### 2d — Capture

```
browser_take_screenshot(filename = "/tmp/pixel_perfect_iter.png")
```

Then jump to **Step 5**.

---

### PATH B — iOS Simulator

The app must already be running and showing the target screen. Use the Bash tool to capture:

```bash
xcrun simctl io booted screenshot /tmp/pixel_perfect_iter.png
```

If the command fails with "No devices are booted":
> "No iOS Simulator is currently running. Please start the simulator and navigate to the target screen, then retry."  
Stop here.

If it fails with "command not found" (Xcode not installed):
> "xcrun is not available. Make sure Xcode is installed and the command-line tools are set up (`xcode-select --install`)."  
Stop here.

After capture, verify the file exists:
```bash
ls -lh /tmp/pixel_perfect_iter.png
```

Then jump to **Step 5**.

---

### PATH C — Android Emulator

The app must already be running and showing the target screen. Use the Bash tool to capture:

```bash
adb exec-out screencap -p > /tmp/pixel_perfect_iter.png
```

If `adb` is not found, try the full path:
```bash
~/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/pixel_perfect_iter.png
```

If still unavailable:
> "adb is not available. Make sure Android SDK platform-tools are installed and the emulator is running."  
Stop here.

After capture, verify the file exists:
```bash
ls -lh /tmp/pixel_perfect_iter.png
```

Then jump to **Step 5**.

---

## Step 5 — Visual QA comparison (agent vision — no scripts)

Read both images with the Read tool:
- The Figma / reference image
- `/tmp/pixel_perfect_iter.png`

> **Note for simulator targets:** the screenshot captures the full device screen including the status bar and home indicator. Focus the comparison on the app content area, ignoring OS chrome unless the design explicitly shows it.

Perform a thorough side-by-side visual analysis. Check **every** category below and note each defect:

### QA Checklist

**Layout & Structure**
- [ ] Overall page structure matches (header / nav / sidebar / content / footer positions)
- [ ] Section order and nesting match
- [ ] Grid or flex alignment — elements line up on the same axis (horizontal / vertical)
- [ ] Responsive breakpoint: at this viewport does any element overflow, wrap unexpectedly, or collapse?

**Spacing**
- [ ] Padding inside containers (top / right / bottom / left)
- [ ] Margins between elements / sections
- [ ] Gap between grid/flex children
- [ ] Consistent rhythm — spacing feels uniform where it should be

**Typography**
- [ ] Font family matches
- [ ] Font size (estimate visually — note if it looks larger or smaller than reference)
- [ ] Font weight (regular / medium / semibold / bold)
- [ ] Line height / leading
- [ ] Letter spacing
- [ ] Text color
- [ ] Text alignment (left / center / right)

**Colors**
- [ ] Background colors (hex, gradient, opacity)
- [ ] Text colors
- [ ] Border colors
- [ ] Icon / SVG fill colors
- [ ] Interactive state colors (hover chips visible in screenshot, focus rings)
- [ ] Shadow / elevation (box-shadow color and spread)

**Borders & Shapes**
- [ ] Border width and style (solid / dashed / none)
- [ ] Border radius (sharp / rounded / pill)
- [ ] Divider lines

**Icons & Images**
- [ ] Icons present, correct size, correct color
- [ ] Images / illustrations present and correctly sized
- [ ] Aspect ratios maintained

**Components & Elements**
- [ ] All buttons present — label, size, color, border-radius
- [ ] Input fields — placeholder, size, border
- [ ] Badges / chips / tags — text, color, shape
- [ ] Cards — shadow, padding, corners
- [ ] Nav items — order, active state
- [ ] Any element in the reference that is **missing** from the live page
- [ ] Any element on the live page that is **not** in the reference (extra / unexpected)

---

## Step 6 — Delete the temporary screenshot

```bash
rm /tmp/pixel_perfect_iter.png
```

Run this after you have finished reading both images. Do not leave screenshots on disk.

---

## Step 7 — Report to user

Print the full QA report directly in the conversation. **Do not write a file.**

Format:

```
## Visual QA Report — {TARGET_URL}
**Reference:** {Figma URL or image path}
**Viewport:** {W}x{H}
**Auth:** {none | logged in as {user} | user logged in manually}

---

### Overall verdict: PASS / NEEDS WORK / FAIL

---

### Defects found

#### CRITICAL (blocks release)
- **[Element / Area]** — {what the reference shows} vs {what the live page shows}
  - Current: ...
  - Expected: ...

#### MAJOR (visible to users, degrades experience)
- ...

#### MINOR (small deviations, cosmetic)
- ...

---

### What matches
- {list of things that look correct — give credit}

---

### Notes
- {any caveats: dynamic content, fonts not loaded, animations, etc.}
```

Severity guide:
- **CRITICAL** — wrong component, missing section, broken layout, completely wrong color palette
- **MAJOR** — wrong spacing (off by more than ~4px visually), wrong font size/weight, wrong colors on key elements
- **MINOR** — sub-pixel alignment, minor color shade difference, text truncation that may be data-dependent

---

## Constraints

- **Browser MCP only** — do not use Python scripts for navigation or capture.
- **No permanent files** — delete `/tmp/pixel_perfect_iter.png` after reading. Never write reports or screenshots into the project directory.
- **Never compare against a login page** — always resolve auth before capturing.
- **Never self-assess from memory** — you must always read both images with the Read tool for every comparison.
- **Report is printed to the user, not saved.** The report lives in the conversation.
- If `browser_take_screenshot` is unavailable, stop and tell the user which MCP tool is missing and that the QA cannot proceed without browser access — do NOT ask the user to take or provide a screenshot.
