import { useState, FormEvent } from "react";
import { useRouter } from "next/router";

export default function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      router.push("/");
    } else {
      setError("Invalid admin token.");
      setLoading(false);
    }
  }

  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#000;color:#F5F0E8;font-family:"Segoe UI",Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}
        .card{width:100%;max-width:420px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:16px;padding:32px}
        h1{font-size:1.6rem;margin-bottom:8px;color:#F5F0E8}
        p{color:#888;font-size:.9rem;margin-bottom:24px;line-height:1.5}
        label{display:block;font-size:.8rem;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em}
        input{width:100%;padding:12px 14px;background:#111;border:1px solid #222;border-radius:8px;color:#F5F0E8;font-size:1rem;outline:none}
        input:focus{border-color:#00C853}
        button{margin-top:16px;width:100%;padding:12px;background:#00C853;color:#000;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
        button:disabled{opacity:.5;cursor:not-allowed}
        .error{margin-top:12px;color:#ff4444;font-size:.9rem}
      `}</style>
      <div className="card">
        <h1>Admin Dashboard</h1>
        <p>Enter your admin token to access the dashboard.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="token">Admin Token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </>
  );
}
