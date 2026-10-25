# Controllers in the play page

The play page accepts three local input sources:

- a **physical gamepad** exposed by the browser's Gamepad API;
- the **virtual controller** driven by the keyboard and mouse;
- the **touch controller** drawn over the video for phones and tablets.

They are not mixed: one local source drives one Pico seat at a time. The
physical gamepad path can use up to eight standard gamepads in one browser,
each with its own seat. The virtual and touch controllers each take exactly
one seat.

## Physical gamepad

1. Connect the gamepad and press a button so the browser publishes it.
2. Turn off the virtual and touch controllers.
3. Click the pad in the HUD to take a Pico seat. On iPhone/iPad the first
   connected standard gamepad claims one seat automatically; click it only if
   you want to release it or another pad is not selected.
4. Press the **Gamepad2** button in the HUD (or open **Settings → Controller
   mapping**) to see and change the button mapping.

The default mapping follows the **physical** Nintendo layout, not the labels
printed on an Xbox pad:

| Switch action | Standard Gamepad API button | Xbox label |
| --- | --- | --- |
| B (bottom) | 0 | A |
| A (right) | 1 | B |
| Y (left) | 2 | X |
| X (top) | 3 | Y |
| L / R | 4 / 5 | LB / RB |
| ZL / ZR | 6 / 7 | LT / RT |
| Minus / Plus | 8 / 9 | View / Menu |
| L3 / R3 | 10 / 11 | Left / right stick click |
| D-pad | 12–15 | D-pad |
| Home / Capture | 16 / 17 | Guide / Share, when the browser exposes them |

To get **label** mapping instead (Xbox A becomes Switch A), open the mapping
window and rebind the Switch A row to the Bottom (0) button. The dialog clears
the old B binding automatically, so one physical button never sends two
actions.

The mapping window also supports:

- **Clear** to leave an action unbound;
- **Reset to default** to restore the physical layout;
- swapping the left and right sticks;
- inverting either stick's Y axis;
- a 0.05–0.35 stick deadzone.

The mapping applies to every standard gamepad in that browser and is stored in
`localStorage` under `s2pipe.gamepadMapping.v1`.

### Home and Capture

Windows Game Bar and Steam can consume the Guide button before Chrome/Edge
sees it. Turn off **Xbox Game Bar → Open Xbox Game Bar using this button on a
controller**, and **Steam → Controller → Guide button focuses Steam**. Holding
Minus and Plus together also sends Home and works even when Guide is stolen.

## Touch controller

Use one of these entry points:

- the **phone icon** in the HUD (it is always available);
- **Use touch controller** in the empty HUD when no gamepad is connected;
- **Settings → Touch controller → Enable touch controller**.

Enabling it takes one Pico seat, turns off the virtual controller, and pauses
physical gamepads. If all eight Pico seats are busy, the page shows an error
instead of silently taking a seat.

The default layout has:

- a left and a right analog stick;
- a four-way D-pad;
- A / B / X / Y in the Switch positions;
- L / R / ZL / ZR on the upper corners;
- Minus, Plus, Home, Capture, L3 and R3.

All controls support multi-touch, so two buttons and both sticks can be held
at once. Minus and Plus together still sends Home.

### Customise the layout

1. Open **Settings → Touch controller**, or click the **Move** icon in the
   HUD.
2. Adjust **Control size** (0.7×–1.25×) if the default is too small or too
   large.
3. Click **Edit layout**. The stream HUD hides and every control gets a dashed
   outline.
4. Drag each control where you want it. **Mirror** flips the current layout,
   **Reset** restores this orientation's default, and **Done** commits it.
5. The layout is saved per orientation: landscape and portrait positions are
   independent, so rotating the phone does not squeeze the clusters together.

The layout is stored in `localStorage` under `s2pipe.touch.v1`. The touch
controller's enabled state and size are stored there too; it comes back after
a reload in the same browser. The page clears held inputs while the settings
drawer or the layout editor is open, so adjusting the layout does not press
game buttons.

The touch pad has no gyro, rumble, amiibo or NFC. On iPhone Safari, native
video fullscreen paints above HTML, so the fullscreen button keeps the normal
page layout while touch controls are enabled (it shows a short notice). On
browsers with element fullscreen (Android Chrome, and iPadOS Safari when
available), fullscreen keeps the touch overlay visible.

## iPhone, Backbone and fullscreen

iPhone Safari does not allow a web page to make a `<div>` fullscreen. The
page's fullscreen button therefore falls back to the **native video player**
(`webkitEnterFullscreen`). That player is outside the page: the HUD and touch
overlay disappear, and the page's gamepad polling loop is no longer reliable
because the system player has taken over. Connecting a Backbone after entering
that mode cannot control the page.

Safari exposes the standard Gamepad API from **iOS 16.4** onward, so a wired
Backbone or a standard Bluetooth controller can work in the browser. This is
not a Backbone problem.

Once a gamepad is connected, the page also requires a Pico seat. On iPhone and
iPad the page now claims one seat automatically for the first gamepad, so
plugging in a Backbone and pressing a button is enough. If all eight seats are
taken, or a touch controller is active, the pad cannot take a seat; the page
shows a notice.

Recommended sequence on iPhone:

1. Exit the native video player (tap **Done**) before connecting the
   controller. The page can now close it automatically when a gamepad
   connects, but iOS may not deliver that event while the native player owns
   the screen.
2. Turn off **Touch controller** if the green phone icon is active; physical
   gamepads are paused while touch is on.
3. Connect the Backbone and press a button. On iPhone/iPad a seat is claimed
   automatically; otherwise tap the pad chip in the HUD.
4. Do **not** use the native fullscreen button while playing with a
   controller. For a fullscreen-like experience, use Safari **Share → Add to
   Home Screen** and launch s2pipe from the Home Screen. The standalone page
   keeps the HUD and touch/gamepad overlays active.

On return from native fullscreen or the background, the page re-asserts its
Pico seat. If the old WebSocket is dead, the seat request gets no response and
the five-second play timeout closes and reconnects it. A two-second gamepad
watchdog re-lists controllers and automatically claims a newly appeared pad.
If the HUD chip is stuck without P1, wait a couple of seconds or tap the pad
chip; the next watchdog pass will also recover it.

## Hide UI

The **EyeOff** button in the HUD hides every overlay: HUD, touch pad, stats,
settings, toasts and the connection banner. The stream keeps playing and
physical gamepad/keyboard input continues. Tap the stream or press Esc to show
the UI again. The touch pad is unmounted while hidden, so touch input stops
until the UI returns.

## Troubleshooting

- **No pad appears:** press a button on the pad. Browsers only expose a
  controller after its first input. Check that the controller is in Standard
  Gamepad mode (Chrome/Edge usually handle Xbox pads natively).
- **The controller is listed but input does nothing:** turn off the virtual
  and touch controllers, then click the pad chip to take a seat.
- **The pad chip lights when pressed but does not show P1:** the browser may
  have reconnected the controller with a different gamepad index. The two-second
  watchdog remaps it by controller id and restores the seat; if P1 is still
  missing after a couple of seconds, tap the pad chip or reload the page.
- **The mapping window is open:** controller input is deliberately sent as
  neutral while learning a binding.
- **Home opens a Windows or Steam overlay:** see the Home and Capture notes
  above; use the Minus + Plus fallback.
- **No seat:** the Switch/Pico only has eight pads. Release another browser's
  seat or look at the `n/8 playing` counter.

## Test status

The client logic has unit tests for the default mapping, rebinding, deadzones,
stick inversion/swapping, touch layouts, touch state and per-orientation
storage. A headless Chrome session with an injected standard gamepad verified
the rendered touch pad, two simultaneous touch points, the packet bits, layout
dragging and the rebinding flow. Real Xbox hardware, a physical phone and the
Switch's HID output still need to be checked on the actual devices.
