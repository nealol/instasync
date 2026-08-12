import { App, Modal } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import type RealtimePlugin from "./main";

export type ConflictChoice = "local" | "remote";

interface ConflictInfo {
  /** Vault-relative path of the binary file in conflict. */
  path: string;
  /** True when the remote side deleted the file (vs. edited it). */
  remoteDeleted: boolean;
}

/**
 * Show the keep-local / keep-remote modal for a binary conflict and resolve with
 * the user's choice. Closing the modal without choosing defaults to keeping the
 * local copy (the safe, non-destructive option).
 */
export function openBinaryConflictModal(
  plugin: RealtimePlugin,
  info: ConflictInfo,
): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    new BinaryConflictModal(plugin.app, info, resolve).open();
  });
}

class BinaryConflictModal extends Modal {
  private info: ConflictInfo;
  private resolve: (choice: ConflictChoice) => void;
  private root: Root | null = null;
  private settled = false;

  constructor(app: App, info: ConflictInfo, resolve: (choice: ConflictChoice) => void) {
    super(app);
    this.info = info;
    this.resolve = resolve;
  }

  private choose(choice: ConflictChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(choice);
    this.close();
  }

  onOpen(): void {
    this.root = createRoot(this.contentEl);
    this.root.render(
      <BinaryConflictView
        info={this.info}
        onLocal={() => this.choose("local")}
        onRemote={() => this.choose("remote")}
      />,
    );
  }

  onClose(): void {
    // Dismissed without an explicit choice → keep local (non-destructive).
    if (!this.settled) {
      this.settled = true;
      this.resolve("local");
    }
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

function BinaryConflictView({
  info,
  onLocal,
  onRemote,
}: {
  info: ConflictInfo;
  onLocal: () => void;
  onRemote: () => void;
}) {
  const remoteDesc = info.remoteDeleted
    ? `"${info.path}" was deleted on another device, but you changed it here.`
    : `"${info.path}" was changed both here and on another device. Binary files can't be merged — pick one. Realtime will preserve the other version as an unsynced conflicted copy.`;
  return (
    <>
      <h3>Binary file conflict</h3>
      <div className="realtime-warning-box">
        <p className="setting-item-description">{remoteDesc}</p>
      </div>
      <div className="realtime-actions">
        <button onClick={onLocal}>Keep local</button>
        <button className="mod-cta" onClick={onRemote}>
          {info.remoteDeleted ? "Delete it here too" : "Keep remote"}
        </button>
      </div>
    </>
  );
}
