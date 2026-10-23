/** Login (P2 · design: Prina Login v2.dc.html) — dark brand band over an underline-field form */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { branding } from "../branding";
import { BrandLogo } from "../components/common/BrandLogo";
import { useAuth } from "./AuthProvider";

export function LoginPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bottom version label — reads the actual core version from /health (public) instead of hardcoding
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch("/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.version && setCoreVersion(d.version))
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { username, password } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-wrap">
        <div className="login-card">
          {/* Dark brand band — the boxless mark is only legible here (handoff) */}
          <div className="login-band">
            <BrandLogo size="5.2rem" variant="boxless" />
            <span className="login-band-word">{branding.name}</span>
          </div>

          <form className="login-form" onSubmit={(e) => void submit(e)}>
            <div className="login-fields">
              <label className="login-field">
                <span>ID</span>
                <input
                  value={username} onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username" placeholder="your-id" required
                />
              </label>
              <label className={error ? "login-field invalid" : "login-field"}>
                <span>Password</span>
                <input
                  type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" placeholder="••••••••" required
                />
              </label>
            </div>

            {error && <div className="login-error">{error}</div>}

            <button className="btn btn-primary btn-block login-submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <div className="login-foot">
          <span className="mono">{coreVersion ? `v${coreVersion}` : ""}</span>
        </div>
      </div>
    </div>
  );
}
