import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  MobileWorkingSetSettings,
  type RealtimeSettings,
} from "../../src/settings";

function inputFor(container: HTMLElement, name: string): HTMLInputElement {
  const row = Array.from(container.querySelectorAll(".setting-item")).find((element) =>
    element.textContent?.includes(name),
  );
  const input = row?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input for ${name}`);
  return input;
}

describe("MobileWorkingSetSettings", () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it("keeps a clamped recent limit displayed after the maximum is raised again", async () => {
    const settings: RealtimeSettings = {
      ...defaultSettings(),
      mobileMaxResidentDocs: 16,
      mobileRecentResidentDocs: 8,
    };
    const plugin = {
      settings,
      saveSettings: vi.fn(async () => {}),
      reloadSync: vi.fn(async () => {}),
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root!.render(<MobileWorkingSetSettings plugin={plugin as never} />);
    });

    const maximum = inputFor(container, "Mobile resident documents");
    const recent = inputFor(container, "Mobile recent documents");
    expect(maximum.value).toBe("16");
    expect(recent.value).toBe("8");

    await act(async () => {
      maximum.value = "4";
      maximum.dispatchEvent(new Event("input", { bubbles: true }));
      maximum.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(settings.mobileMaxResidentDocs).toBe(4);
    expect(settings.mobileRecentResidentDocs).toBe(4);
    expect(maximum.value).toBe("4");
    expect(recent.value).toBe("4");

    await act(async () => {
      maximum.value = "16";
      maximum.dispatchEvent(new Event("input", { bubbles: true }));
      maximum.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(settings.mobileMaxResidentDocs).toBe(16);
    expect(settings.mobileRecentResidentDocs).toBe(4);
    expect(maximum.value).toBe("16");
    expect(recent.value).toBe("4");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
    expect(plugin.reloadSync).toHaveBeenCalledTimes(2);
  });
});
