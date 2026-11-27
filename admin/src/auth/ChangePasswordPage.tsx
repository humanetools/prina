/** Forced password change (2026-11-09) — an account created or reset by an admin signs in with a temporary
 *  password and must pick its own before the admin opens. The core answers 403 PASSWORD_CHANGE_REQUIRED meanwhile. */
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { branding } from "../branding";
import { BrandLogo } from "../components/common/BrandLogo";
import { useAuth } from "./AuthProvider";

export function ChangePasswordPage() {
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError("Use 8 or more characters");
    if (next !== confirm) return setError("The new passwords do not match");
    if (next === current) return setError("Choose a password different from the temporary one");
    setBusy(true);
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Change failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-band">
            <BrandLogo size="5.2rem" variant="boxless" />
            <span className="login-band-word">{branding.name}</span>
          </div>
          <form className="login-form" onSubmit={(e) => void submit(e)}>
            <p className="login-note">Your password was set by an administrator. Choose your own password to continue.</p>
            <div className="login-fields">
              <label className="login-field">
                <span>Temporary password</span>
                <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
              </label>
              <label className="login-field">
                <span>New password (8+ characters)</span>
                <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
              </label>
              <label className={error ? "login-field invalid" : "login-field"}>
                <span>Confirm new password</span>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </label>
            </div>
            {error && <div className="login-error">{error}</div>}
            <button className="btn btn-primary btn-block login-submit" disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => void logout()}>Sign out</button>
          </form>
        </div>
      </div>
    </div>
  );
}
