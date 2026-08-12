import { App, Modal } from "obsidian";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type RealtimePlugin from "./main";

export type TextConflictChoice = "local" | "remote";

interface TextConflictInfo {
  path: string;
  localContent: string;
  remoteContent: string;
}

export function openTextConflictModal(
  plugin: RealtimePlugin,
  info: TextConflictInfo,
): Promise<TextConflictChoice> {
  return new Promise((resolve) => {
    new TextConflictModal(plugin.app, info, resolve).open();
  });
}

class TextConflictModal extends Modal {
  private info: TextConflictInfo;
  private resolve: (choice: TextConflictChoice) => void;
  private root: Root | null = null;
  private settled = false;

  constructor(app: App, info: TextConflictInfo, resolve: (choice: TextConflictChoice) => void) {
    super(app);
    this.info = info;
    this.resolve = resolve;
  }

  private choose(choice: TextConflictChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(choice);
    this.close();
  }

  onOpen(): void {
    this.modalEl.addClass("realtime-conflict-modal");
    this.root = createRoot(this.contentEl);
    this.root.render(
      <TextConflictView
        info={this.info}
        onLocal={() => this.choose("local")}
        onRemote={() => this.choose("remote")}
      />,
    );
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve("local");
    }
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

function TextConflictView({
  info,
  onLocal,
  onRemote,
}: {
  info: TextConflictInfo;
  onLocal: () => void;
  onRemote: () => void;
}) {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const fileDiff = parseDiffFromFile(
    { name: `${info.path} (local)`, contents: info.localContent, lang: "markdown" },
    { name: `${info.path} (remote)`, contents: info.remoteContent, lang: "markdown" },
  );

  return (
    <div className="realtime-conflict-shell">
      <div className="realtime-conflict-header">
        <h2>Markdown file conflict</h2>
        <p className="setting-item-description">
          "{info.path}" was changed both here and on another device. Pick which version should
          become canonical. Realtime will preserve the other version as an unsynced conflicted
          copy beside the file.
        </p>
      </div>
      <div className="realtime-conflict-diff" aria-label="Local and remote diff">
        <FileDiff
          fileDiff={fileDiff}
          disableWorkerPool
          options={{
            diffStyle: isMobile ? "unified" : "split",
            overflow: "wrap",
            themeType: "system",
            lineDiffType: "word",
            disableVirtualizationBuffers: true,
          }}
        />
      </div>
      <div className="realtime-conflict-actions">
        <button onClick={onLocal}>Accept Local</button>
        <button className="mod-cta" onClick={onRemote}>
          Accept Remote
        </button>
      </div>
    </div>
  );
}
