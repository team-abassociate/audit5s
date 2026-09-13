# Capture Reference — All Target Types

Three capture paths. Choose based on target type. All write to `/tmp/pixel_perfect_iter.png`.

---

## PATH A — Web (URL target)

Uses **browser MCP tools**. No Python, no scripts.

| Tool | Purpose |
|---|---|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Read the current DOM/accessibility tree — diagnose where you are |
| `browser_resize` | Set viewport width × height — must match Figma design dimensions |
| `browser_fill` | Fill an input field (login form) |
| `browser_click` | Click a button or link |
| `browser_take_screenshot` | Capture PNG → write to `/tmp/pixel_perfect_iter.png` |

### Workflow

```
1. browser_navigate(url)
2. browser_snapshot   →  decide: ready / login / 404
3. browser_resize(width, height)   ← match Figma frame size
4. browser_snapshot   →  confirm layout settled after resize
5. browser_take_screenshot(filename="/tmp/pixel_perfect_iter.png")
6. Read /tmp/pixel_perfect_iter.png  (agent vision comparison)
7. rm /tmp/pixel_perfect_iter.png   ← delete immediately after reading
```

### Diagnosing where you landed

Run `browser_snapshot` after every navigation. Look at:

- **URL** — did it redirect? `/login`, `/sign-in`, `/auth` → need login
- **Title** — "404", "Not Found", "Page Not Found" → page does not exist
- **Body** — password input visible → login wall; expected page content → ready

### Login flow

#### If user gave credentials

```
browser_navigate("/login")           ← or wherever the login page is
browser_fill("#email", USERNAME)
browser_fill("#password", PASSWORD)
browser_click("button[type=submit]")
browser_snapshot                     ← confirm redirect to target
```

Selectors vary — infer from snapshot, try: `#email`, `input[type=email]`, `input[name=email]`, `input[name=username]`

#### If credentials unknown

Stop and ask the user **only** for the credentials — the agent does the login:
> "The page requires login. Please give me:  
> - Username / email  
> - Password  
> I'll handle the rest."

Once you have them, fill the form and submit. Never ask the user to log in themselves.

### Resize to match design

Always resize **before** screenshotting. Extract dimensions from the Figma frame or reference image.

```
browser_resize(width=1440, height=900)   ← example; use actual design dimensions
```

If design dimensions are unknown, default to `1440 × 900`.

### If browser MCP is unavailable

Tell the user that the required browser tools (`browser_navigate`, `browser_take_screenshot`) are not available and the QA cannot proceed. Do not ask the user to take or provide screenshots.

---

## PATH B — iOS Simulator

The app must be running and showing the target screen before you capture. Use the Bash tool.

```bash
xcrun simctl io booted screenshot /tmp/pixel_perfect_iter.png
```

Verify the file:
```bash
ls -lh /tmp/pixel_perfect_iter.png
```

### Failure handling

| Error | Cause | Response |
|---|---|---|
| `No devices are booted` | Simulator not running | Ask user to start simulator and navigate to target screen |
| `command not found: xcrun` | Xcode not installed | Ask user to install Xcode (`xcode-select --install`) |
| File is 0 bytes or missing | Screenshot failed silently | Try once more; if still fails, report the error |

### Notes

- Captures the **full device screen** including status bar and home indicator.
- Focus comparison on the app content area — ignore OS chrome unless the design explicitly shows it.
- No resize needed — the simulator has a fixed resolution.
- The user must navigate to the right screen first; you cannot drive the simulator.

---

## PATH C — Android Emulator

The app must be running and showing the target screen before you capture. Use the Bash tool.

```bash
adb exec-out screencap -p > /tmp/pixel_perfect_iter.png
```

If `adb` is not in PATH, try the default SDK location:
```bash
~/Library/Android/sdk/platform-tools/adb exec-out screencap -p > /tmp/pixel_perfect_iter.png
```

Verify the file:
```bash
ls -lh /tmp/pixel_perfect_iter.png
```

### Failure handling

| Error | Cause | Response |
|---|---|---|
| `command not found: adb` | SDK platform-tools not in PATH | Try full path above; if still missing, tell user to install Android SDK |
| `error: no devices/emulators found` | Emulator not running | Ask user to start the emulator |
| File is 0 bytes or corrupt | Pipe error | Try: `adb shell screencap -p /sdcard/tmp_qq.png && adb pull /sdcard/tmp_qq.png /tmp/pixel_perfect_iter.png && adb shell rm /sdcard/tmp_qq.png` |

### Notes

- Captures the **full device screen** including status bar and navigation bar.
- Focus comparison on the app content area.
- No resize needed — fixed emulator resolution.
- The user must navigate to the right screen first.

---

## Cleanup (all paths)

After reading the screenshot for comparison, always delete it:

```bash
rm /tmp/pixel_perfect_iter.png
```

Never leave screenshots on disk. Never write them into the project directory.
