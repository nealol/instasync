import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TechnicalDetails } from "../../src/TechnicalDetails";

describe("TechnicalDetails", () => {
  it("renders plugin, server, and vault identifiers in a collapsed footer", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <TechnicalDetails clientVersion="0.4.3" serverVersion="0.3.5" vaultId="vault-123" />,
      );
    });

    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Technical details");
    expect(details?.textContent).toContain("Plugin version");
    expect(details?.textContent).toContain("0.4.3");
    expect(details?.textContent).toContain("Server version");
    expect(details?.textContent).toContain("0.3.5");
    expect(details?.textContent).toContain("Vault ID");
    expect(details?.textContent).toContain("vault-123");

    root.unmount();
  });
});
