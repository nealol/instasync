export function TechnicalDetails({
  clientVersion,
  serverVersion,
  vaultId,
}: {
  clientVersion: string;
  serverVersion: string;
  vaultId: string;
}) {
  const rows = [
    ["Plugin version", clientVersion],
    ["Server version", serverVersion],
    ["Vault ID", vaultId || "Not connected"],
  ];
  return (
    <details style={{ marginTop: "24px" }}>
      <summary className="setting-item-description">Technical details</summary>
      {rows.map(([name, value]) => (
        <div className="setting-item" key={name}>
          <div className="setting-item-info">
            <div className="setting-item-name">{name}</div>
          </div>
          <div className="setting-item-control">
            <code>{value}</code>
          </div>
        </div>
      ))}
    </details>
  );
}
