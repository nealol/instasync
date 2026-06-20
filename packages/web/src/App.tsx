import { Markdown } from "./Markdown";
import { useSharedNote } from "./useSharedNote";

function shareIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/view\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const shareId = shareIdFromLocation();
  if (!shareId) return <Message title="Not found" body="This link is not valid." />;
  return <SharedNote shareId={shareId} />;
}

function SharedNote({ shareId }: { shareId: string }) {
  const note = useSharedNote(shareId);

  if (note.status === "loading") {
    return <Message title="Loading…" body="" />;
  }
  if (note.status === "not-found") {
    return (
      <Message title="Note not found" body="This note doesn't exist or is no longer shared." />
    );
  }
  if (note.status === "revoked") {
    return <Message title="No longer shared" body="The owner stopped sharing this note." />;
  }

  document.title = note.title;
  return (
    <div className="page">
      <article className="note">
        <h1 className="note-title">{note.title}</h1>
        <Markdown shareId={shareId} content={note.content} />
      </article>
      <footer className="footer">
        Shared with <a href="https://github.com/nealol/realtime">Realtime.md</a> · live updating
      </footer>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="page">
      <div className="message">
        <h1>{title}</h1>
        {body && <p>{body}</p>}
      </div>
    </div>
  );
}
