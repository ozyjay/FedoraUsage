# Top-bar visual testing

Use this matrix after changing panel labels, field sizes, spacing, ordering or
visibility. The automated `tests/test_panel_presentation.js` suite covers the
same formatting and state boundaries without rendering. This checklist covers
the GNOME Shell details that cannot be reproduced by a standalone GJS process,
including emoji font fallback and Shell theme allocation.

## Setup

1. Install the working tree:

   ```bash
   pwsh -NoProfile -File ./scripts/install.ps1
   ```

2. Follow Shell errors while testing:

   ```bash
   journalctl --user -f /usr/bin/gnome-shell
   ```

3. Open the extension preferences and verify each configurable field both
   enabled and disabled. Use the normal desktop theme and any text scaling used
   day to day.

## Matrix

| Area | Scenarios | Check |
| --- | --- | --- |
| Overall item | All fields visible; each field hidden in turn; only one field visible | Stable order, balanced outer padding and no unexpected movement |
| Fan | Stopped or unavailable; 1–999 RPM; four-digit RPM; five-digit RPM if hardware exposes it | Hidden when stopped, no ellipsis and a small visible icon/value gap |
| RAM and storage | `0–9%`, `10–99%`, `100%`; unavailable mount | No clipping, stable field widths, `--%` when unavailable and aligned icon/value pairs |
| Auto-Powersaver | Automatic balanced; automatic Power Saver; paused; manual override; disabled; degraded; fault; unavailable temperature | Correct icon, colour and fallback; icon/value pair remains compact |
| Hottest sensor | CPU, GPU, SSD, Wi-Fi, Ethernet, mainboard, memory, power and generic sensor icons | Each emoji renders fully and remains close to the thermometer icon |
| Temperature values | Unavailable; negative; one digit; two digits; `100–150°C`; warning and critical thresholds | No clipping or width changes; correct thermometer/fire icon and colour |
| Display environment | Default text size; the user's larger text setting; each display scale in regular use | No overlap, truncation or vertical misalignment |
| Popup | Fan, RAM, system storage, secondary storage, hottest reading | Reading order matches the top bar and long mount/sensor names remain readable |

Real hardware may not expose every boundary. When a scenario cannot be
produced safely, record it as untested rather than changing sensor files or
forcing unsafe thermal or power conditions.
