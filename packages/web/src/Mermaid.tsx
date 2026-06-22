import { useEffect, useId, useState } from "react";

/** Client-side mermaid rendering for ```mermaid fences (lazy-loads the lib). */
export function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // useId is stable per component instance and avoids an unbounded module counter.
  const reactId = useId();
  const idRef = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, "")}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "neutral" });
      const { svg } = await mermaid.render(idRef, source);
      if (!cancelled) setSvg(sanitizeSvg(svg));
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [source, idRef]);

  if (failed) return <pre className="mermaid-error">{source}</pre>;
  if (!svg) return <div className="mermaid-loading">Rendering diagram…</div>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Strip <script> elements and on* event handler attributes from mermaid SVG
 * output before injecting it via dangerouslySetInnerHTML. Mermaid is trusted but
 * the shared-note threat model means attacker-controlled text reaches the
 * renderer; this defense-in-depth prevents script injection via mermaid bugs or
 * crafted input.
 */
function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  doc.querySelectorAll("script").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
    }
  });
  return new XMLSerializer().serializeToString(doc.documentElement);
}
