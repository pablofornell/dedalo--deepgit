/** Diff viewer: scrolling of long lines. */
import { type JSX } from "solid-js";
import { Button, Checkbox } from "../../../components/ui";
import { H_SCROLL_DEFAULT, H_SCROLL_MAX, H_SCROLL_MIN, H_SCROLL_STEP } from "../../../state/horizontalScroll";
import { resetSettings, setSetting, settings } from "../../../state/settings";
import { registerSettingsSection } from "../registry";
import { Row, Section, SizeControl } from "../widgets";

function DiffSection(): JSX.Element {
  return (
    <Section title="Scrolling">
      <Row label="Scroll horizontally with the pointer" hint="Move the pointer left or right to scroll long lines. The wheel still scrolls vertically.">
        <Checkbox checked={settings.diffPointerScroll} ariaLabel="Scroll horizontally with the pointer" onChange={(v) => setSetting("diffPointerScroll", v)} />
      </Row>
      <Row
        label="Horizontal scroll sensitivity"
        hint={`How far the horizontal wheel, a trackpad swipe or Shift + wheel moves long lines in File changes. Raise it so that a small wrist movement reaches the end of long lines. ${H_SCROLL_DEFAULT}% is the system default.`}
      >
        <div class="dg-settings-stack">
          <SizeControl
            label="Horizontal scroll sensitivity"
            value={settings.hScrollSensitivity}
            min={H_SCROLL_MIN}
            max={H_SCROLL_MAX}
            step={H_SCROLL_STEP}
            unit="%"
            onChange={(v) => setSetting("hScrollSensitivity", v)}
          />
          <Button
            size="small"
            variant="ghost"
            icon="undo"
            disabled={settings.hScrollSensitivity === H_SCROLL_DEFAULT}
            onClick={() => resetSettings(["hScrollSensitivity"])}
            title={`Back to ${H_SCROLL_DEFAULT}%`}
          >
            Reset
          </Button>
        </div>
      </Row>
    </Section>
  );
}

registerSettingsSection({
  id: "diff",
  title: "Diff viewer",
  order: 25,
  icon: "sideBySide",
  keywords: ["diff", "scroll", "horizontal", "sensitivity", "wheel", "trackpad", "shift", "mouse", "pointer", "long", "lines"],
  component: DiffSection,
  reset: () => resetSettings(["diffPointerScroll", "hScrollSensitivity"]),
});
