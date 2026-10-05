import { orderForLayout } from "@drone-city/model";
import type { Session } from "@drone-city/model";
import { useHub } from "./useHub.ts";

function lastTool(s: Session): string {
  for (let i = s.recent.length - 1; i >= 0; i--) {
    const e = s.recent[i];
    if (e?.tool) return e.detail ? `${e.tool}: ${e.detail}` : e.tool;
  }
  return "-";
}

function subagentSummary(s: Session): string {
  const all = Object.values(s.subagents);
  if (all.length === 0) return "-";
  const running = all.filter((a) => a.state === "running").length;
  return `${running} running / ${all.length} total`;
}

const cell = { padding: "4px 12px", borderBottom: "1px solid #ddd", textAlign: "left" } as const;

export function App() {
  const { sessions, connection } = useHub();
  const rows = orderForLayout(Object.values(sessions));
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 18 }}>drone-city debug view</h1>
      <p>
        hub: {connection} &middot; {rows.length} session(s)
      </p>
      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {["label", "machine", "state", "role", "subagents", "last tool"].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td style={cell}>{s.label}</td>
              <td style={cell}>{s.machine}</td>
              <td style={cell}>{s.state}</td>
              <td style={cell}>{s.role}</td>
              <td style={cell}>{subagentSummary(s)}</td>
              <td style={cell}>{lastTool(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
