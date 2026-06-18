import { useEffect, useRef, useState } from "react";

let nextId = 0;

/** Client-side mermaid rendering for ```mermaid fences (lazy-loads the lib). */
export function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mermaid-${nextId++}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, theme: "neutral" });
      const { svg } = await mermaid.render(idRef.current, source);
      if (!cancelled) setSvg(svg);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (failed) return <pre className="mermaid-error">{source}</pre>;
  if (!svg) return <div className="mermaid-loading">Rendering diagram…</div>;
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
