import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import type { DashboardData } from "../lib/dashboard";

const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
const num = (v: number) => new Intl.NumberFormat("en-US").format(v);
const dt = (s: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(s));
const shortDate = (s: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(s));

const STATUS_COLOR: Record<string, string> = {
  open: "#f59e0b",
  active: "#00C853",
  completed: "#6ee7b7",
  cancelled: "#ef4444",
};

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/dashboard");
    if (res.status === 401) {
      router.push("/login");
      return;
    }
    if (!res.ok) {
      setError("Failed to load dashboard data.");
      return;
    }
    setData(await res.json());
    setLastRefresh(new Date());
    setError("");
  }, [router]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  }

  if (!data && !error) {
    return (
      <>
        <style>{`body{background:#000;color:#F5F0E8;font-family:"Segoe UI",Arial,sans-serif;display:grid;place-items:center;min-height:100vh}`}</style>
        <p style={{ color: "#888" }}>Loading…</p>
      </>
    );
  }

  const metrics: Array<{ label: string; value: string; sub?: string }> = data
    ? [
        { label: "Total Users", value: num(data.totalUsers), sub: `${num(data.activeUsers7d)} active 7d` },
        { label: "Funded Users", value: num(data.fundedUsers), sub: `${usd(data.liveUserBalances)} live balances` },
        { label: "Arena Players", value: num(data.arenaPlayers) },
        { label: "Total Arenas", value: num(data.totalArenas), sub: `${num(data.activeArenas)} active` },
        { label: "Completed Arenas", value: num(data.completedArenas) },
        { label: "Total Deposits", value: usd(data.totalDeposits) },
        { label: "Prize Pool Distributed", value: usd(data.totalPrizePayouts) },
        { label: "Platform Revenue", value: usd(data.platformRevenue) },
        { label: "Withdrawals In Flight", value: num(data.withdrawalsInFlight), sub: `${usd(data.totalCompletedWithdrawals)} completed` },
      ]
    : [];

  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#000;color:#F5F0E8;font-family:"Segoe UI",Arial,sans-serif;min-height:100vh}
        .shell{max-width:1200px;margin:0 auto;padding:32px 16px 64px}
        header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:32px}
        h1{font-size:1.5rem;font-weight:700;color:#F5F0E8}
        .meta{color:#555;font-size:.85rem}
        .logout{background:transparent;border:1px solid #222;color:#888;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.85rem}
        .logout:hover{border-color:#444;color:#F5F0E8}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:40px}
        .card{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:12px;padding:20px}
        .card-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:#555;margin-bottom:10px}
        .card-value{font-size:2rem;font-weight:700;color:#00C853;line-height:1}
        .card-sub{font-size:.8rem;color:#555;margin-top:8px}
        h2{font-size:1rem;font-weight:600;margin-bottom:16px;color:#888;text-transform:uppercase;letter-spacing:.08em}
        .table-wrap{overflow-x:auto}
        table{width:100%;border-collapse:collapse;min-width:640px}
        th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#555;padding:10px 12px;border-bottom:1px solid #1a1a1a}
        td{padding:12px;border-bottom:1px solid #111;font-size:.9rem;color:#ccc}
        td:first-child{color:#F5F0E8;font-weight:600}
        .chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;border:1px solid currentColor}
        .error{color:#ef4444;padding:24px}
      `}</style>
      <div className="shell">
        <header>
          <div>
            <h1>Bayse Fantasy — Admin</h1>
            {lastRefresh && (
              <p className="meta">
                Updated {dt(lastRefresh.toISOString())} · auto-refreshes every 30s
              </p>
            )}
          </div>
          <button className="logout" onClick={logout}>Log out</button>
        </header>

        {error && <p className="error">{error}</p>}

        {data && (
          <>
            <div className="grid">
              {metrics.map((m) => (
                <div className="card" key={m.label}>
                  <p className="card-label">{m.label}</p>
                  <p className="card-value">{m.value}</p>
                  {m.sub && <p className="card-sub">{m.sub}</p>}
                </div>
              ))}
            </div>

            <h2>Recent Arenas</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Status</th>
                    <th>Entry Fee</th>
                    <th>Prize Pool</th>
                    <th>Window</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentArenas.map((a) => (
                    <tr key={a.code}>
                      <td>{a.code}</td>
                      <td>
                        <span
                          className="chip"
                          style={{ color: STATUS_COLOR[a.status] ?? "#888" }}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td>{usd(a.entryFee)}</td>
                      <td>{usd(a.prizePool)}</td>
                      <td>{shortDate(a.startAt)} – {shortDate(a.endAt)}</td>
                      <td>{dt(a.createdAt)}</td>
                    </tr>
                  ))}
                  {data.recentArenas.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ color: "#555", textAlign: "center", padding: "32px" }}>
                        No arenas yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
